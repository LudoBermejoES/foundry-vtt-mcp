import { z } from 'zod';
import { FoundryClient } from '../../foundry-client.js';
import { Logger } from '../../logger.js';
import { config } from '../../config.js';
import {
  chunkDocsByBytes,
  chunkTimeoutMs,
  payloadBytes,
  DEFAULT_CHUNK_BUDGET_BYTES,
  TRANSPORT_MAX_MESSAGE_BYTES,
} from './import-chunking.js';
import { readActorDocFromPath, ImportPathError } from './import-path.js';

export interface WoDImportActorToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
  /** Overridable for tests. Defaults to the process config. */
  importDir?: string | undefined;
  importMaxBytes?: number | undefined;
  defaultTimeoutMs?: number | undefined;
}

/**
 * A full exported Foundry Actor document. We validate the load-bearing fields
 * (`name`, `type`, `system`) and pass everything else — `items`,
 * `prototypeToken`, `img`, `flags`, and an optional out-of-band `sourceId` —
 * through untouched so `Actor.create(doc)` can reconstruct the actor verbatim.
 */
const actorDocSchema = z
  .object({
    name: z.string().min(1),
    type: z.string().min(1),
    system: z.record(z.any()),
    items: z.array(z.record(z.any())).optional(),
    prototypeToken: z.record(z.any()).optional(),
    img: z.string().optional(),
    flags: z.record(z.any()).optional(),
    // Optional idempotency key when the doc's flags don't already carry a
    // wodchar id (e.g. flags.wodchar.sourceId).
    sourceId: z.string().optional(),
  })
  .passthrough();

const importActorSchema = z
  .object({
    actor: actorDocSchema.optional(),
    actors: z.array(actorDocSchema).optional(),
    folder: z.string().min(1).optional(),
    overwrite: z.boolean().optional(),
    // ── additive, all optional ────────────────────────────────────────────────
    actorPath: z.string().min(1).optional(),
    actorPaths: z.array(z.string().min(1)).min(1).max(50).optional(),
    /** Secondary cap on documents per bridge query. The byte budget is primary. */
    batchSize: z.number().int().min(1).max(10).optional(),
    /** Per-query serialized byte budget. Defaults to the WebRTC-safe 50 KiB. */
    chunkBytes: z.number().int().min(4096).max(TRANSPORT_MAX_MESSAGE_BYTES).optional(),
    /** `true` restores the historical abort-on-first-bad-actor behaviour. */
    stopOnError: z.boolean().optional(),
    /** Predict per-actor outcomes without writing anything. */
    dryRun: z.boolean().optional(),
    /** Per-query timeout override (base; scaled up for over-budget chunks). */
    timeoutMs: z.number().int().min(1000).max(600000).optional(),
  })
  .refine(
    d => {
      const inline = d.actor !== undefined || (Array.isArray(d.actors) && d.actors.length > 0);
      const byPath =
        d.actorPath !== undefined || (Array.isArray(d.actorPaths) && d.actorPaths.length > 0);
      return inline || byPath;
    },
    {
      message:
        'Provide either inline docs (`actor` / `actors`) or staged paths (`actorPath` / `actorPaths`).',
    }
  )
  .refine(
    d => {
      const inline = d.actor !== undefined || (Array.isArray(d.actors) && d.actors.length > 0);
      const byPath =
        d.actorPath !== undefined || (Array.isArray(d.actorPaths) && d.actorPaths.length > 0);
      return !(inline && byPath);
    },
    {
      // Silently concatenating the two sources would let a caller half-import
      // from the wrong one and never notice.
      message:
        'Do not mix inline docs (`actor` / `actors`) with staged paths (`actorPath` / `actorPaths`) in one call.',
    }
  );

/** Statuses the module can report per actor, plus the two the server adds. */
export type ImportStatus =
  | 'created'
  | 'updated'
  | 'skipped'
  | 'failed'
  | 'would-create'
  | 'would-update'
  | 'would-skip'
  // Server-side only: the bridge query carrying this actor did not report back
  // (timeout / transport error). A timed-out query is NOT cancelled Foundry-side,
  // so the actor may well have been created. Reporting it as `failed` would be a
  // false claim that nothing was written — which is the exact mistake that made
  // the original timeout unactionable.
  | 'unknown'
  // Server-side only: an earlier chunk failed, so this actor was never sent.
  | 'not-attempted';

export interface ImportActorResult {
  name: string;
  id: string | null;
  /** One of `ImportStatus`; typed loosely so a newer module may add a value. */
  status: string;
  folder: string | null;
  sourceId?: string | null;
  error?: string;
}

const MODULE_CAPABILITY_DRY_RUN = 'importActors.dryRun';

function countByStatus(results: ImportActorResult[]) {
  const n = (s: string) => results.filter(r => r.status === s).length;
  return {
    created: n('created'),
    updated: n('updated'),
    skipped: n('skipped'),
    failed: n('failed'),
    unknown: n('unknown'),
    notAttempted: n('not-attempted'),
    wouldCreate: n('would-create'),
    wouldUpdate: n('would-update'),
    wouldSkip: n('would-skip'),
  };
}

/** Best-effort label for a doc we never got a module response for. */
function labelOf(doc: Record<string, any>): string {
  return typeof doc?.name === 'string' && doc.name ? doc.name : '(unnamed)';
}

function sourceIdOf(doc: Record<string, any>): string | null {
  return doc?.flags?.wodchar?.sourceId ?? doc?.sourceId ?? null;
}

/**
 * `worldofdarkness-import-actor` — create Foundry actors from full exported
 * Actor JSON documents (as emitted by the wodchar character exporter). Unlike
 * `worldofdarkness-create-actor` (which builds a blank actor from a splat), this
 * faithfully reconstructs the actor from the document: `Actor.create(doc)`
 * natively preserves embedded `items`, the `prototypeToken`, `img`, `system`,
 * and `flags` in one shot — nothing is re-mapped.
 *
 * A multi-actor request is split into byte-budgeted chunks and issued as one
 * bridge query per chunk, sequentially. See import-chunking.ts for why the
 * budget is in bytes and not in documents, and why the chunks must not be
 * issued in parallel.
 */
export class WoDImportActorTools {
  private foundryClient: FoundryClient;
  private logger: Logger;
  private importDir: string | undefined;
  private importMaxBytes: number;
  private defaultTimeoutMs: number;

  constructor({
    foundryClient,
    logger,
    importDir,
    importMaxBytes,
    defaultTimeoutMs,
  }: WoDImportActorToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'WoDImportActorTools' });
    this.importDir = importDir !== undefined ? importDir : config.wod?.importDir;
    this.importMaxBytes = importMaxBytes ?? config.wod?.importMaxBytes ?? 2097152;
    this.defaultTimeoutMs = defaultTimeoutMs ?? config.foundry?.queryTimeout ?? 10000;
  }

  getToolDefinitions() {
    return [
      {
        name: 'worldofdarkness-import-actor',
        description:
          '[worldofdarkness only] Create Foundry actor(s) from FULL exported Actor JSON ' +
          '(as produced by the wodchar character exporter). Faithfully reconstructs the actor ' +
          'from the document — embedded items (powers/merits/weapons/gear), prototypeToken, img, ' +
          'system, and flags are all preserved (Actor.create creates them natively; nothing is ' +
          're-mapped). Pass one `actor` or a batch via `actors`. `folder` (name) places the ' +
          'actor(s) in an Actor folder, created on demand. Idempotent: each actor is stamped with ' +
          'flags.wodchar.sourceId AT CREATION (from the doc, or an explicit per-actor `sourceId`); ' +
          're-importing the same sourceId is skipped, or updated in place when `overwrite` is true — ' +
          'so retrying a failed or timed-out batch never duplicates what it already created. ' +
          'A batch is split into ~50 KB byte-budgeted chunks (one bridge query each, sequential); ' +
          'tested envelope is roughly one ~50 KB actor per query. `success: true` means THE BATCH ' +
          'RAN, not that every actor succeeded — always read `counts` and the per-actor `status` ' +
          "('created' | 'updated' | 'skipped' | 'failed' | 'unknown' | 'not-attempted'). " +
          "'unknown' means that chunk's query did not report back and the actor MAY have been " +
          'created (a timed-out query is not cancelled Foundry-side); re-running the same batch is ' +
          'safe and will reconcile it. Use `dryRun: true` first to see the verdicts without writing.',
        inputSchema: {
          type: 'object',
          properties: {
            actor: {
              type: 'object',
              description: 'A single full exported Actor JSON document.',
            },
            actors: {
              type: 'array',
              items: { type: 'object' },
              description: 'A batch of full exported Actor JSON documents.',
            },
            folder: {
              type: 'string',
              description:
                'Name of the Actor folder to place the imported actor(s) in (created on demand). ' +
                'Typically the character faction.',
            },
            overwrite: {
              type: 'boolean',
              description:
                'When an actor with the same sourceId already exists: true → update it in place; ' +
                'false/omitted → skip it. Reported per actor.',
            },
            dryRun: {
              type: 'boolean',
              description:
                'Predict only: resolve each document against the existing actors’ ' +
                'flags.wodchar.sourceId and report would-create / would-update / would-skip per ' +
                'actor, WITHOUT writing anything (no actors, no folders). Refused if the connected ' +
                'Foundry module is too old to honour it, rather than silently importing for real.',
            },
            actorPath: {
              type: 'string',
              description:
                'Path to ONE staged .json actor document, resolved only inside the server’s ' +
                'configured WOD_IMPORT_DIR (unset ⇒ refused). Cannot be combined with `actor`/`actors`. ' +
                'NOTE: this only saves you from retyping the document — the full document still ' +
                'crosses the bridge, so it does NOT let you import more actors per call.',
            },
            actorPaths: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Up to 50 staged .json actor document paths, each resolved inside WOD_IMPORT_DIR. ' +
                'Same caveat as `actorPath`: not a way around the per-call work ceiling.',
            },
            batchSize: {
              type: 'number',
              description:
                'Max actors per bridge query (1-10). The ~50 KB byte budget still applies and ' +
                'usually binds first; set 1 to force strictly one actor per query on a slow world.',
            },
            chunkBytes: {
              type: 'number',
              description:
                'Per-query serialized byte budget (default 51200, the WebRTC-safe threshold). ' +
                'Lower it if queries time out; raising it above 65536 is refused.',
            },
            stopOnError: {
              type: 'boolean',
              description:
                'true → abort the batch on the first actor Foundry refuses (the pre-0.9.1 ' +
                'behaviour). Default false: each bad actor is reported as status "failed" and the ' +
                'batch continues.',
            },
            timeoutMs: {
              type: 'number',
              description:
                'Per-query timeout override in ms (1000-600000). Defaults to FOUNDRY_QUERY_TIMEOUT ' +
                '(10000). Scaled up automatically for a chunk larger than the byte budget.',
            },
          },
        },
      },
    ];
  }

  async handleImportActor(args: unknown) {
    const parsed = importActorSchema.safeParse(args);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      return { success: false, error: `Invalid arguments: ${detail}` };
    }

    const {
      actor,
      actors,
      folder,
      overwrite,
      actorPath,
      actorPaths,
      batchSize,
      chunkBytes,
      stopOnError,
      dryRun,
      timeoutMs,
    } = parsed.data;

    // ── Source resolution: inline OR staged paths (never both; enforced above).
    let docs: Array<Record<string, any>>;
    const paths = actorPaths ?? (actorPath ? [actorPath] : []);
    if (paths.length > 0) {
      const loaded: Array<Record<string, any>> = [];
      for (const p of paths) {
        let raw: unknown;
        try {
          raw = await readActorDocFromPath(p, {
            importDir: this.importDir,
            maxBytes: this.importMaxBytes,
          });
        } catch (error) {
          // Nothing has been written at this point, so refusing the whole call
          // is safe and is the least surprising outcome for a bad path.
          const msg =
            error instanceof ImportPathError
              ? error.message
              : error instanceof Error
                ? error.message
                : 'unreadable';
          return { success: false, error: `Rejected actor path — ${msg}` };
        }
        // Staged documents go through the SAME schema as inline ones: exactly
        // one validation path.
        const docParsed = actorDocSchema.safeParse(raw);
        if (!docParsed.success) {
          const detail = docParsed.error.issues
            .map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)
            .join('; ');
          return { success: false, error: `Rejected actor path — ${p}: schema: ${detail}` };
        }
        loaded.push(docParsed.data as Record<string, any>);
      }
      docs = loaded;
    } else {
      docs = (actors ?? (actor ? [actor] : [])) as Array<Record<string, any>>;
    }

    if (docs.length === 0) {
      return { success: false, error: 'No actor documents to import.' };
    }

    // ── Dry run needs a module that honours it. An old module ignores the flag
    // and performs a REAL import, so this is checked before anything is sent.
    if (dryRun === true) {
      const gate = await this.assertDryRunSupported();
      if (gate !== null) return gate;
    }

    // ── Byte-aware chunking (see import-chunking.ts).
    const budget = chunkBytes ?? DEFAULT_CHUNK_BUDGET_BYTES;
    const chunks = chunkDocsByBytes(docs, budget, batchSize ?? Number.MAX_SAFE_INTEGER);

    // ── Hard ceiling, enforced BEFORE any write. A document is indivisible, so
    // one over-budget doc cannot be split. On WebRTC, SCTP drops any message over
    // MAX_MESSAGE_SIZE and the server→Foundry path does not chunk (and swallows
    // the send error), so the query would simply hang to its timeout: refuse it
    // instead. On WebSocket the real limit is `ws`'s 100 MiB default, so the same
    // document imports fine and must keep doing so — hence the transport check
    // rather than a blanket ceiling.
    const connectionType = this.safeConnectionType();
    if (connectionType === 'webrtc') {
      const tooBig = chunks.filter(c => c.bytes > TRANSPORT_MAX_MESSAGE_BYTES);
      if (tooBig.length > 0) {
        const names = tooBig.flatMap(c => c.docs.map(d => labelOf(d)));
        const biggest = Math.max(...tooBig.map(c => c.bytes));
        return {
          success: false,
          error:
            `Request refused before writing anything: the active WebRTC transport caps one bridge ` +
            `message at ${TRANSPORT_MAX_MESSAGE_BYTES} bytes and ${names.length} document(s) ` +
            `(largest ${biggest} bytes: ${names.join(', ')}) exceed it even alone. ` +
            `A single actor document cannot be split across queries — split the ACTOR instead: ` +
            `import it with fewer embedded items and add the rest via ` +
            `manage-world-items { action: "add-to-actor" }, or shrink oversized fields ` +
            `(biography/notes). Per-call ceiling: ${TRANSPORT_MAX_MESSAGE_BYTES} bytes per document, ` +
            `${budget} bytes per query by default (\`chunkBytes\`).`,
        };
      }
    }

    const baseTimeout = timeoutMs ?? this.defaultTimeoutMs;

    this.logger.info('Importing WoD actor(s)', {
      count: docs.length,
      totalBytes: payloadBytes(docs),
      chunks: chunks.length,
      chunkBudget: budget,
      folder,
      overwrite: overwrite === true,
      dryRun: dryRun === true,
      fromPaths: paths.length > 0 ? paths.length : undefined,
      connectionType,
    });

    const results: ImportActorResult[] = [];
    let completed = 0;
    let chunkError: string | undefined;
    let dryRunHonoured = dryRun === true ? true : undefined;

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (chunk === undefined) continue;

      if (chunkError !== undefined) {
        // A previous chunk failed. Do NOT keep pushing work at a module that may
        // still be busy with an un-cancellable in-flight write; report the rest
        // as untouched so the caller knows exactly where to resume.
        for (const d of chunk.docs) {
          results.push({
            name: labelOf(d),
            id: null,
            status: 'not-attempted',
            folder: folder ?? null,
            sourceId: sourceIdOf(d),
            error: 'not sent: an earlier chunk failed',
          });
        }
        continue;
      }

      const payload: Record<string, unknown> = { actors: chunk.docs };
      if (folder !== undefined) payload.folder = folder;
      if (overwrite !== undefined) payload.overwrite = overwrite;
      if (dryRun !== undefined) payload.dryRun = dryRun;
      if (stopOnError !== undefined) payload.stopOnError = stopOnError;

      const perChunkTimeout = chunkTimeoutMs(chunk, baseTimeout, budget);

      try {
        const result = await this.foundryClient.query(
          'foundry-mcp-bridge.importActors',
          payload,
          perChunkTimeout
        );

        if (result?.success === false) {
          throw new Error(result.error ?? 'Failed to import actor(s)');
        }

        if (dryRun === true && result?.dryRun !== true) {
          // Belt and braces behind the capability gate above.
          dryRunHonoured = false;
        }

        const chunkResults: ImportActorResult[] = Array.isArray(result?.results)
          ? result.results
          : [];
        results.push(...chunkResults);

        // A short response means the module stopped early (stopOnError). Account
        // for the docs it never reached so `total` always equals `docs.length`.
        if (chunkResults.length < chunk.docs.length) {
          for (const d of chunk.docs.slice(chunkResults.length)) {
            results.push({
              name: labelOf(d),
              id: null,
              status: 'not-attempted',
              folder: folder ?? null,
              sourceId: sourceIdOf(d),
              error: 'not reached: the batch stopped earlier in this chunk',
            });
          }
          chunkError = 'batch stopped early (stopOnError)';
        }

        completed++;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        this.logger.error('WoD actor import chunk failed', {
          chunk: i + 1,
          of: chunks.length,
          bytes: chunk.bytes,
          timeoutMs: perChunkTimeout,
          error: message,
        });
        chunkError = message;
        for (const d of chunk.docs) {
          results.push({
            name: labelOf(d),
            id: null,
            status: 'unknown',
            folder: folder ?? null,
            sourceId: sourceIdOf(d),
            error:
              `${message} — the query was not cancelled Foundry-side, so this actor may or may ` +
              `not have been created. Re-run the same request: it is idempotent by ` +
              `flags.wodchar.sourceId${sourceIdOf(d) ? '' : ', but this doc carries NO sourceId, so a re-run WOULD duplicate it'}.`,
          });
        }
      }
    }

    const counts = countByStatus(results);

    // `success: true` means "the batch ran", not "everything succeeded" — the
    // caller must read `counts`. `success: false` is reserved for "nothing was
    // attempted" (schema failure, path rejection, oversize refusal, or the very
    // first chunk failing before anything could be reported).
    const nothingAttempted = completed === 0 && counts.created + counts.updated === 0;
    if (nothingAttempted && chunkError !== undefined) {
      return {
        success: false,
        error: chunkError,
        total: results.length,
        results,
        counts,
        batches: { total: chunks.length, completed },
        ...(dryRun === true ? { dryRun: true } : {}),
      };
    }

    return {
      success: true,
      total: results.length,
      results,
      counts,
      batches: { total: chunks.length, completed },
      ...(dryRun === true ? { dryRun: true } : {}),
      ...(dryRunHonoured === false
        ? {
            warning:
              'The connected module did not confirm dryRun. Treat the world as possibly modified.',
          }
        : {}),
      ...(chunkError !== undefined ? { error: chunkError } : {}),
    };
  }

  /**
   * Refuse a dry run unless the connected module advertises it. Returns `null`
   * when supported, or the error envelope to return to the caller.
   *
   * Without this, a new server against an old module (the two deploys are
   * independent) would send `dryRun: true`, the old module would ignore the
   * unknown key, and the "writes nothing" call would import every actor for real.
   */
  private async assertDryRunSupported(): Promise<{ success: false; error: string } | null> {
    try {
      const pong = await this.foundryClient.query('foundry-mcp-bridge.ping', undefined, 10000);
      const caps: unknown = pong?.capabilities;
      if (Array.isArray(caps) && caps.includes(MODULE_CAPABILITY_DRY_RUN)) return null;
      return {
        success: false,
        error:
          'dryRun refused: the connected Foundry MCP Bridge module does not advertise ' +
          `"${MODULE_CAPABILITY_DRY_RUN}" (module version ${pong?.moduleVersion ?? 'unknown'}). ` +
          'An older module ignores dryRun and performs a REAL import, so nothing was sent. ' +
          'Update the Foundry module and reload the world as GM, or omit dryRun.',
      };
    } catch (error) {
      return {
        success: false,
        error: `dryRun refused: could not confirm module capabilities — ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      };
    }
  }

  private safeConnectionType(): 'websocket' | 'webrtc' | null {
    try {
      return this.foundryClient.getConnectionType?.() ?? null;
    } catch {
      return null;
    }
  }
}
