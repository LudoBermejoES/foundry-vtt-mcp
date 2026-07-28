import { z } from 'zod';
import { FoundryClient } from '../../foundry-client.js';
import { Logger } from '../../logger.js';
import { config } from '../../config.js';
import {
  chunkDocsByBytes,
  chunkTimeoutMs,
  payloadBytes,
  DEFAULT_CHUNK_BUDGET_BYTES,
  MAX_CHUNK_BUDGET_BYTES,
  TRANSPORT_MAX_MESSAGE_BYTES,
  type DocChunk,
} from './import-chunking.js';
import { readActorDocFromPath, ImportPathError } from './import-path.js';
import { readActorArchive, type ArchiveEntry } from './import-archive.js';
import { COMPRESSION_CAPABILITY, gzippedBytes } from '../../wire-format.js';
import { WOD_ARCHIVE_LIMITS } from '../../config.js';

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
    // One number, one reason: the cap is aggregate wall clock, and an archive
    // inherits it rather than declaring a second one (config.ts WOD_ARCHIVE_LIMITS).
    actorPaths: z.array(z.string().min(1)).min(1).max(WOD_ARCHIVE_LIMITS.MAX_DOCUMENTS).optional(),
    /** One staged `.zip` of actor documents. See import-archive.ts. */
    actorArchive: z.string().min(1).optional(),
    /**
     * Declares that these documents have never been imported, lifting the
     * provenance refusal. Every affected actor is then reported as unreconcilable.
     */
    firstImport: z.boolean().optional(),
    /** Secondary cap on documents per bridge query. The byte budget is primary. */
    batchSize: z.number().int().min(1).max(10).optional(),
    /**
     * Per-query serialized byte budget, in UNCOMPRESSED bytes. A bound on Foundry
     * WORK per query, not a transport ceiling: its max is `MAX_CHUNK_BUDGET_BYTES`
     * (wall-clock, see import-chunking.ts), deliberately NOT the frame size, which
     * is what it used to be validated against.
     */
    chunkBytes: z.number().int().min(4096).max(MAX_CHUNK_BUDGET_BYTES).optional(),
    /** `true` restores the historical abort-on-first-bad-actor behaviour. */
    stopOnError: z.boolean().optional(),
    /** Predict per-actor outcomes without writing anything. */
    dryRun: z.boolean().optional(),
    /** Per-query timeout override (base; scaled up for over-budget chunks). */
    timeoutMs: z.number().int().min(1000).max(600000).optional(),
  })
  .refine(d => intakesUsed(d).length > 0, {
    message:
      'Provide inline docs (`actor` / `actors`), staged paths (`actorPath` / `actorPaths`), or one staged archive (`actorArchive`).',
  })
  .refine(d => intakesUsed(d).length === 1, {
    // Silently concatenating two sources would let a caller half-import from the
    // wrong one and never notice. The archive is a third sibling and is refused
    // in combination for exactly that reason, not for a new one.
    message:
      'Do not mix intakes in one call: use exactly one of inline docs (`actor` / `actors`), staged paths (`actorPath` / `actorPaths`), or a staged archive (`actorArchive`).',
  });

/** Which of the three mutually exclusive intakes a request names. */
function intakesUsed(d: {
  actor?: unknown;
  actors?: unknown;
  actorPath?: unknown;
  actorPaths?: unknown;
  actorArchive?: unknown;
}): Array<'inline' | 'paths' | 'archive'> {
  const used: Array<'inline' | 'paths' | 'archive'> = [];
  if (d.actor !== undefined || (Array.isArray(d.actors) && d.actors.length > 0))
    used.push('inline');
  if (d.actorPath !== undefined || (Array.isArray(d.actorPaths) && d.actorPaths.length > 0)) {
    used.push('paths');
  }
  if (d.actorArchive !== undefined) used.push('archive');
  return used;
}

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
  /**
   * The archive entry this document came from, when the intake was an archive.
   *
   * ATTRIBUTION ONLY. The status vocabulary above and the partial-failure /
   * timeout semantics are untouched: a request naming ONE archive can return
   * twenty per-actor outcomes, and an outcome that identifies only an actor name
   * cannot be traced back to the document that produced it — a problem the
   * per-path intake does not have, because there the caller wrote each path.
   */
  entry?: string;
}

/**
 * The archive inventory, and what the provenance gate found.
 *
 * Declared once and emitted once: this is the object returned as the response's
 * `archive`, and the SAME object reference the dry-run `plan.archive` points at.
 * Two structures describing one archive would drift.
 */
export interface ArchiveReport {
  /** The caller's own path, as supplied. Never a resolved absolute path. */
  path: string;
  archiveBytes: number;
  declaredUncompressedBytes: number;
  measuredUncompressedBytes: number;
  counts: { entries: number; documents: number; ignored: number; refused: number };
  entries: ArchiveEntry[];
  /** Entries whose document carries no resolvable source id. */
  entriesWithoutProvenance: string[];
  /** Whether the caller lifted the provenance refusal for this request. */
  firstImportDeclared: boolean;
}

const MODULE_CAPABILITY_DRY_RUN = 'importActors.dryRun';

/**
 * The one phrasing for "this actor cannot be reconciled".
 *
 * Extracted so the post-write `unknown` message and the pre-write first-import
 * declaration state the same fact the same way — two phrasings for one fact is how
 * a reader ends up believing they are two facts.
 */
const UNRECONCILABLE_NOTE = 'this doc carries NO sourceId, so a re-run WOULD duplicate it';

/** One document's place in the transport plan. All sizes are MEASURED. */
export interface TransportPlanDocument {
  name: string;
  sourceId: string | null;
  /** The archive entry this document came from, for an archive import. */
  entry?: string;
  /** Whether a retry could reconcile this document. */
  provenance: 'resolved' | 'missing';
  /** Serialized JSON bytes of the document itself. */
  bytes: number;
  /** Measured gzip bytes of the document. Never derived from a ratio. */
  compressedBytes: number;
  /** 1-based index of the bridge query this document would land in. */
  query: number;
  /** That query's deadline, scaled for an over-budget chunk. */
  timeoutMs: number;
  sendable: boolean;
  reason?: string;
}

export interface TransportPlanQuery {
  index: number;
  documents: number;
  /** Uncompressed serialized bytes of the documents in this query. */
  bytes: number;
  /** Bytes this query would actually put on the wire, measured. */
  wireBytes: number;
  timeoutMs: number;
  sendable: boolean;
  reason?: string;
}

/**
 * What the transport would do with this request. Computed without sending
 * anything, and reported by `dryRun` so the one question a caller could not get
 * answered — "would this even go?" — now has an answer.
 */
export interface TransportPlan {
  transport: 'websocket' | 'webrtc' | null;
  /** The negotiated wire encoding on the current connection. */
  encoding: 'gzip' | 'plain';
  /**
   * The frame the wire size is checked against, and whether it binds on this
   * transport (WebSocket's real limit is `ws`'s 100 MiB default).
   */
  frameBytes: number;
  frameEnforced: boolean;
  chunkBytes: number;
  queries: TransportPlanQuery[];
  documents: TransportPlanDocument[];
  totals: {
    documents: number;
    bytes: number;
    compressedBytes: number;
    queries: number;
    unsendable: number;
    /**
     * The sum of every query's deadline — the cost a caller most needs before
     * committing, and the one nothing else bounds. `chunkTimeoutMs` caps each
     * query at 600,000 ms and NEVER their total, so a 50-document archive is up to
     * ~580 s of wall clock inside a single tool call.
     */
    summedTimeoutMs: number;
  };
  /**
   * The archive this request came from, when it came from one. Same object as the
   * response's `archive` — the plan extends the report rather than restating it.
   */
  archive?: ArchiveReport;
}

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

/**
 * Resolve a document's source id in the module's OWN order of preference
 * (`packages/foundry-module/src/data-access.ts:1304-1306`): the wodchar flag, then
 * the combat module's flag, then the out-of-band `sourceId` field.
 *
 * THE ORDER AND THE SET MUST MATCH THE MODULE'S. This used to check only
 * `flags.wodchar.sourceId ?? sourceId`, omitting the middle one — harmless while
 * the value was merely echoed in a report, and NOT harmless now that it decides a
 * pre-write refusal: the archive provenance gate would have refused documents the
 * importer would have reconciled perfectly well. If either side gains a fourth
 * source, both change together.
 *
 * Note `flags['wod20-char']` is NOT in this chain and must not be added to it: the
 * wodchar exporter writes that scope (line, variant, exportedAt) and it carries no
 * source id at all.
 */
function sourceIdOf(doc: Record<string, any>): string | null {
  return (
    doc?.flags?.wodchar?.sourceId ?? doc?.flags?.['wod20-combat']?.sourceId ?? doc?.sourceId ?? null
  );
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
          'that budget bounds FOUNDRY WORK per query, not message size — the bridge compresses ' +
          'query traffic (real WoD actors compress ~7-12x), so a single ~97 KB actor document ' +
          'travels in one query and is NOT refused for its size. `success: true` means THE BATCH ' +
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
                'actor, WITHOUT writing anything (no actors, no folders). Also returns `plan`: per ' +
                'document its uncompressed bytes, its MEASURED compressed bytes, which bridge query ' +
                'it lands in, that query’s deadline, and whether it is sendable. Refused for exactly ' +
                'one reason — the connected module is too old to honour dryRun and would import for ' +
                'real; a size condition never pre-empts a dry run.',
            },
            actorPath: {
              type: 'string',
              description:
                'Path to ONE staged .json actor document, resolved only inside the server’s ' +
                'configured WOD_IMPORT_DIR (unset ⇒ refused). Cannot be combined with `actor`/`actors`. ' +
                'NOTE: this only saves you from retyping the document — the full document still ' +
                'crosses the bridge (compressed, but in full), so it does NOT let you import more ' +
                'actors per call: it is not a way around the per-call work ceiling.',
            },
            actorPaths: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Up to 50 staged .json actor document paths, each resolved inside WOD_IMPORT_DIR. ' +
                'Same caveat as `actorPath`: not a way around the per-call work ceiling.',
            },
            actorArchive: {
              type: 'string',
              description:
                'Path to ONE staged .zip of actor .json documents, resolved only inside the ' +
                'server’s configured WOD_IMPORT_DIR (unset ⇒ refused). Produce it with `zip -r`, ' +
                'macOS Finder "Compress", or Windows "Send to → Compressed folder"; directory ' +
                'entries, __MACOSX/ sidecars, `._*` files and non-.json entries are ignored and ' +
                'listed in the response, never fatal. Cannot be combined with `actor`/`actors`/' +
                '`actorPath`/`actorPaths`. SAME CAVEAT AS `actorPath`, AND MORE SO: this saves you ' +
                `from enumerating up to ${WOD_ARCHIVE_LIMITS.MAX_DOCUMENTS} paths and NOTHING else. ` +
                'It does NOT let you import more actors per call — the cap is the same ' +
                `${WOD_ARCHIVE_LIMITS.MAX_DOCUMENTS}, because the constraint is aggregate wall ` +
                'clock, not size — and every document still crosses the bridge in full, one ' +
                'sequential query at a time. A 50-document archive is ~50 queries and can be ~580 s ' +
                'inside this one call; `dryRun: true` reports the query count and the summed ' +
                'deadline before you commit. Every document must carry a resolvable sourceId ' +
                '(flags.wodchar.sourceId, flags["wod20-combat"].sourceId, or an out-of-band ' +
                'sourceId) or the whole archive is refused before anything is written — raw ' +
                '`wod character export` output carries none. Use `firstImport: true` only for ' +
                'actors that have genuinely never been imported.',
            },
            firstImport: {
              type: 'boolean',
              description:
                'Declares that the documents in `actorArchive` have NEVER been imported, lifting ' +
                'the refusal for documents with no resolvable sourceId. Every affected actor comes ' +
                'back flagged unreconcilable: re-running the request WOULD duplicate it. Do not use ' +
                'this to refresh existing actors — inject flags.wodchar.sourceId instead. Note that ' +
                'raw exporter output also carries img/prototypeToken of ' +
                '"icons/svg/mystery-man.svg", which `overwrite: true` writes straight over a live ' +
                'portrait; delete those two fields before re-importing.',
            },
            batchSize: {
              type: 'number',
              description:
                'Max actors per bridge query (1-10). The ~50 KB work budget still applies and ' +
                'usually binds first; set 1 to force strictly one actor per query on a slow world.',
            },
            chunkBytes: {
              type: 'number',
              description:
                'Per-query budget in UNCOMPRESSED serialized bytes (default 51200), bounding ' +
                'FOUNDRY WORK per query — roughly one actor’s worth — not message size. Lower it if ' +
                'queries time out; raise it (max 1048576) to trade round-trips for longer, ' +
                'size-scaled deadlines. It is NOT a per-document ceiling: a document larger than the ' +
                'budget is sent alone with a scaled deadline, never refused for its size.',
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
      actorArchive,
      firstImport,
      batchSize,
      chunkBytes,
      stopOnError,
      dryRun,
      timeoutMs,
    } = parsed.data;

    // ── Source resolution: inline OR staged paths OR one archive (never more than
    // one; enforced above).
    let docs: Array<Record<string, any>>;
    /**
     * Which archive entry each document came from, keyed by object identity.
     *
     * A Map rather than a wrapper type, deliberately: `chunkDocsByBytes` groups
     * WHOLE DOCUMENTS and preserves their references, so attribution rides
     * alongside chunking without touching its signature or its grouping.
     * Attribution is metadata about a document, not a change to how documents are
     * batched.
     */
    const entryOf = new Map<Record<string, any>, string>();
    let archiveReport: ArchiveReport | undefined;

    const paths = actorPaths ?? (actorPath ? [actorPath] : []);
    if (actorArchive !== undefined) {
      const loaded = await this.loadArchive(actorArchive, firstImport === true, dryRun === true);
      if ('error' in loaded) return loaded.error;
      docs = loaded.docs;
      archiveReport = loaded.report;
      for (const [doc, entry] of loaded.entries) entryOf.set(doc, entry);
    } else if (paths.length > 0) {
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
          // "Not configured" is the one rejection whose true cause is usually
          // NOT the path — it is that THIS backend process did not inherit the
          // configured environment. Say so, because the bare reason sends the
          // reader off to check a config file that is very often already right.
          // The hint is a fixed string: it names an env var and an operational
          // rule, never a resolved path and never anything read from disk, so
          // import-path.ts's error hygiene is preserved.
          if (error instanceof ImportPathError && error.reason.startsWith('path intake disabled')) {
            this.logger.error(
              'Staged path intake is unavailable: wod.importDir is unset in THIS backend process. ' +
                'The backend is a singleton on port 31414 and serves every session with the ' +
                'environment it was started with, so a hand-started backend ' +
                '(e.g. `nohup node backend.bundle.cjs`) has none of the MCP client config. ' +
                'Check the "Starting Foundry MCP Backend" line in this log for the value it did resolve.',
              { requestedCount: paths.length }
            );
            return {
              success: false,
              error:
                `Rejected actor path — ${msg}. ` +
                'This is a server-configuration fault, not a bad path: WOD_IMPORT_DIR is unset ' +
                'in the running backend process. Note the backend is a singleton on port 31414 ' +
                'and is NOT replaced when one is already listening — if it was hand-started it ' +
                'inherited a shell environment instead of the MCP client config, and restarting ' +
                'the MCP client will not fix it. See docs/foundry-import.md ' +
                '("Staged path intake needs a backend that inherited the config").',
            };
          }
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

    /** Attribution, added only where there is an archive entry to attribute to. */
    const withEntry = (d: Record<string, any>): { entry?: string } => {
      const entry = entryOf.get(d);
      return entry !== undefined ? { entry } : {};
    };

    // ── Dry run needs a module that honours it. An old module ignores the flag
    // and performs a REAL import, so this is checked before anything is sent.
    if (dryRun === true) {
      const gate = await this.assertDryRunSupported();
      if (gate !== null) return gate;
    }

    // ── Byte-aware chunking (see import-chunking.ts).
    const budget = chunkBytes ?? DEFAULT_CHUNK_BUDGET_BYTES;
    const chunks = chunkDocsByBytes(docs, budget, batchSize ?? Number.MAX_SAFE_INTEGER);

    const baseTimeout = timeoutMs ?? this.defaultTimeoutMs;
    const connectionType = this.safeConnectionType();

    // ── The transport plan. A document's UNCOMPRESSED size is no longer grounds
    // for refusal: compressed JSON is the bridge wire format, real WoD actor
    // documents compress 6.9x-12x, and a ~97 KB actor now travels in one frame with
    // 4x headroom. What is still refused — before anything is transmitted or
    // written — is a query whose MEASURED size on the wire still exceeds one frame.
    //
    // MEASURED, NEVER PREDICTED. That is the load-bearing rule: the ratio is a
    // property of the content, not of the format. An actor carrying its 118 KB WebP
    // portrait as an embedded `data:` URI on both `img` and
    // `prototypeToken.texture.src` is 369,259 bytes of JSON and 245,480 compressed
    // — 1.5x, five times over the frame — against 6.9x-12x for ordinary documents.
    // No ratio applied to an uncompressed size could tell those apart.
    const plan = this.buildTransportPlan(chunks, {
      folder,
      overwrite,
      dryRun,
      stopOnError,
      baseTimeout,
      budget,
      connectionType,
      entryOf,
      ...(archiveReport !== undefined ? { archive: archiveReport } : {}),
    });

    // A real import refuses up front if any query is undeliverable: nothing is
    // written, so there is nothing to reconcile. A DRY RUN does not refuse — it
    // reports the unsendable query inside the plan and still returns verdicts for
    // every other document (see the loop below), because a dry run that declines to
    // describe the request it was asked about leaves the caller with no other way
    // to find out.
    if (dryRun !== true) {
      const blocked = plan.queries.filter(q => !q.sendable);
      if (blocked.length > 0) {
        return {
          success: false,
          error:
            `Request refused before writing anything: ${blocked.length} of ${plan.queries.length} ` +
            `bridge quer${plan.queries.length === 1 ? 'y' : 'ies'} would not fit one transport frame. ` +
            `${blocked.map(q => q.reason).join(' ')}`,
          plan,
          ...(archiveReport !== undefined ? { archive: archiveReport } : {}),
        };
      }
    }

    this.logger.info('Importing WoD actor(s)', {
      count: docs.length,
      totalBytes: payloadBytes(docs),
      chunks: chunks.length,
      chunkBudget: budget,
      folder,
      overwrite: overwrite === true,
      dryRun: dryRun === true,
      fromPaths: paths.length > 0 ? paths.length : undefined,
      fromArchive: actorArchive !== undefined ? archiveReport?.counts : undefined,
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
            ...withEntry(d),
            error: 'not sent: an earlier chunk failed',
          });
        }
        continue;
      }

      const planned = plan.queries[i];
      if (planned !== undefined && !planned.sendable) {
        // Dry run only (a real import already returned above). Report the bound
        // per actor and keep going: the other queries still have verdicts to give.
        for (const d of chunk.docs) {
          results.push({
            name: labelOf(d),
            id: null,
            status: 'not-attempted',
            folder: folder ?? null,
            sourceId: sourceIdOf(d),
            ...withEntry(d),
            error: `not sendable: ${planned.reason ?? 'exceeds one transport frame'}`,
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
        // The module answers per document IN ORDER — the same assumption the
        // short-response accounting below already relies on — so attribution is
        // added positionally rather than by matching on actor name, which is not
        // unique and which the module may have altered.
        chunkResults.forEach((r, j) => {
          const source = chunk.docs[j];
          const entry = source !== undefined ? entryOf.get(source) : undefined;
          if (entry !== undefined) r.entry = entry;
        });
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
              ...withEntry(d),
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
            ...withEntry(d),
            error:
              `${message} — the query was not cancelled Foundry-side, so this actor may or may ` +
              `not have been created. Re-run the same request: it is idempotent by ` +
              `flags.wodchar.sourceId${sourceIdOf(d) ? '' : `, but ${UNRECONCILABLE_NOTE}`}.`,
          });
        }
      }
    }

    // ── A declared first import proceeded past the provenance gate, so say in the
    // response what that costs, per actor, rather than leaving it to be discovered
    // on the retry. Same wording as the `unknown` case above: one fact, one phrasing.
    if (archiveReport?.firstImportDeclared === true) {
      const unreconcilable = new Set(archiveReport.entriesWithoutProvenance);
      for (const r of results) {
        if (r.entry === undefined || !unreconcilable.has(r.entry)) continue;
        r.error =
          r.error !== undefined
            ? `${r.error} Also: ${UNRECONCILABLE_NOTE}.`
            : `Imported under \`firstImport\` — ${UNRECONCILABLE_NOTE}.`;
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
        ...(archiveReport !== undefined ? { archive: archiveReport } : {}),
        ...(dryRun === true ? { dryRun: true, plan } : {}),
      };
    }

    return {
      success: true,
      total: results.length,
      results,
      counts,
      batches: { total: chunks.length, completed },
      // Every entry accounted for, on a real import as well as a dry run: the
      // counts sum to the archive's entry count, so an operator whose documents
      // were all misnamed learns it from the report and not from an empty import.
      ...(archiveReport !== undefined ? { archive: archiveReport } : {}),
      ...(dryRun === true ? { dryRun: true, plan } : {}),
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
   * Resolve, expand and vet one staged archive — the ENTIRE pre-query era.
   *
   * Nothing has been written when any of this fails, so every failure refuses the
   * whole call and there is nothing to reconcile. This is the only failure era the
   * archive adds, and it is the safe one; after the first query is issued, behaviour
   * is identical to a batch of inline documents because it IS that path.
   *
   * A dry run performs all of it for real (that is what makes the plan worth
   * having) with exactly one divergence: it does not refuse for MISSING PROVENANCE,
   * it reports it. It still refuses an archive it must not expand, because there the
   * defence IS not doing the work, and doing it in dry-run mode to produce a nicer
   * report would defeat it.
   */
  private async loadArchive(
    requested: string,
    firstImport: boolean,
    dryRun: boolean
  ): Promise<
    | {
        docs: Array<Record<string, any>>;
        report: ArchiveReport;
        entries: Array<[Record<string, any>, string]>;
      }
    | { error: { success: false; error: string; archive?: ArchiveReport } }
  > {
    let contents;
    try {
      contents = await readActorArchive(requested, {
        importDir: this.importDir,
        maxBytes: this.importMaxBytes,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'unreadable';
      if (error instanceof ImportPathError && error.reason.startsWith('path intake disabled')) {
        // Same fault, same remedy, same wording as the staged-path branch: the
        // cause is almost never the path but a backend that did not inherit the
        // configured environment.
        this.logger.error(
          'Archive intake is unavailable: wod.importDir is unset in THIS backend process. ' +
            'The backend is a singleton on port 31414 and serves every session with the ' +
            'environment it was started with. Check the "Starting Foundry MCP Backend" line ' +
            'in this log for the value it did resolve.'
        );
        return {
          error: {
            success: false,
            error:
              `Rejected actor archive — ${msg}. ` +
              'This is a server-configuration fault, not a bad path: WOD_IMPORT_DIR is unset ' +
              'in the running backend process. See docs/foundry-import.md ' +
              '("Staged path intake needs a backend that inherited the config").',
          },
        };
      }
      return { error: { success: false, error: `Rejected actor archive — ${msg}` } };
    }

    // The document cap, enforced after classification and before chunking. NOT
    // raised for an archive: the constraint is aggregate wall clock, and the
    // transport's compression does nothing for it.
    if (contents.documents.length > WOD_ARCHIVE_LIMITS.MAX_DOCUMENTS) {
      return {
        error: {
          success: false,
          error:
            `Rejected actor archive — ${requested}: ${contents.documents.length} actor documents, ` +
            `and the maximum per call is ${WOD_ARCHIVE_LIMITS.MAX_DOCUMENTS}. That cap is about ` +
            `aggregate WALL CLOCK, not size: each document is its own sequential bridge query with ` +
            `its own deadline and nothing bounds their sum. Split the archive.`,
        },
      };
    }

    // Archive documents go through the SAME schema as inline and staged ones:
    // exactly one validation path regardless of intake.
    const docs: Array<Record<string, any>> = [];
    const entries: Array<[Record<string, any>, string]> = [];
    for (const document of contents.documents) {
      const docParsed = actorDocSchema.safeParse(document.value);
      if (!docParsed.success) {
        const detail = docParsed.error.issues
          .map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ');
        return {
          error: {
            success: false,
            error: `Rejected actor archive — ${requested}, entry ${document.entry}: schema: ${detail}`,
          },
        };
      }
      const doc = docParsed.data as Record<string, any>;
      docs.push(doc);
      entries.push([doc, document.entry]);
    }

    const entriesWithoutProvenance = entries
      .filter(([doc]) => sourceIdOf(doc) === null)
      .map(([, entry]) => entry);

    const report: ArchiveReport = {
      path: requested,
      archiveBytes: contents.archiveBytes,
      declaredUncompressedBytes: contents.declaredUncompressedBytes,
      measuredUncompressedBytes: contents.measuredUncompressedBytes,
      counts: contents.counts,
      entries: contents.entries,
      entriesWithoutProvenance,
      firstImportDeclared: firstImport,
    };

    // ── The provenance gate. Retry safety is per-document and rests entirely on
    // the source id: an actor is stamped with it AT CREATION, so re-running a
    // failed batch reconciles instead of duplicating. The existing report already
    // warns that a document without one would duplicate on re-run — but it says so
    // AFTER the write, and an archive is precisely the shape in which that mistake
    // is made twenty times at once. So the check moves ahead of the write.
    //
    // DO NOT SYNTHESISE A SOURCE ID FROM THE ENTRY NAME. It is tempting, because
    // `lena-vogt.json` → `archive:lena-vogt` makes retry of the SAME archive
    // idempotent for free. It stamps fabricated provenance under a scope that means
    // "this came from wodchar character X", so the same character later imported
    // under its real id becomes a second actor — trading a visible duplicate for an
    // invisible one.
    if (entriesWithoutProvenance.length > 0 && !firstImport && !dryRun) {
      return {
        error: {
          success: false,
          error:
            `Rejected actor archive — ${requested}: ${entriesWithoutProvenance.length} of ` +
            `${docs.length} documents carry no resolvable sourceId, so nothing was written. ` +
            `A retry would create a duplicate for every one of them, and with \`overwrite\` the ` +
            `exporter's placeholder \`img\` would be written over the live portrait. Entries: ` +
            `${entriesWithoutProvenance.join(', ')}. Remedy: inject flags.wodchar.sourceId (or ` +
            `flags["wod20-combat"].sourceId, or a top-level sourceId) into each document — or, ` +
            `if these actors have genuinely never been imported, pass \`firstImport: true\` and ` +
            `accept that a retry will duplicate them.`,
          archive: report,
        },
      };
    }

    return { docs, report, entries };
  }

  /**
   * Refuse a dry run unless the connected module advertises it. Returns `null`
   * when supported, or the error envelope to return to the caller.
   *
   * Without this, a new server against an old module (the two deploys are
   * independent) would send `dryRun: true`, the old module would ignore the
   * unknown key, and the "writes nothing" call would import every actor for real.
   *
   * THE ONLY REFUSAL A DRY RUN CAN RETURN. A size condition never pre-empts a dry
   * run any more — an unsendable request is reported inside the plan, with the
   * verdicts still returned. The two used to be indistinguishable in effect while
   * needing opposite remedies, so this wording is deliberately and only about the
   * MODULE VERSION.
   */
  private async assertDryRunSupported(): Promise<{ success: false; error: string } | null> {
    try {
      const pong = await this.foundryClient.query('foundry-mcp-bridge.ping', undefined, 10000);
      const caps: unknown = pong?.capabilities;
      if (Array.isArray(caps) && caps.includes(MODULE_CAPABILITY_DRY_RUN)) return null;
      return {
        success: false,
        error:
          'dryRun refused — MODULE VERSION, not request size. The connected Foundry MCP Bridge ' +
          `module (version ${pong?.moduleVersion ?? 'unknown'}) does not advertise ` +
          `"${MODULE_CAPABILITY_DRY_RUN}", and a module that old IGNORES the flag and performs a ` +
          'REAL import, so nothing was sent. Remedy: update the Foundry MCP Bridge module and ' +
          'reload the world as GM (a Foundry restart is not enough), or omit dryRun and import for ' +
          'real. Nothing about the size of this request caused this refusal.',
      };
    } catch (error) {
      return {
        success: false,
        error:
          'dryRun refused — could not confirm the connected module’s capabilities (module version ' +
          `unknown): ${error instanceof Error ? error.message : 'unknown error'}. Nothing was sent, ` +
          'and nothing about the size of this request caused this refusal.',
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

  /** Whether the transport has negotiated compression on the current connection. */
  private compressionNegotiated(): boolean {
    try {
      return this.foundryClient.isCompressionNegotiated?.() === true;
    } catch {
      return false;
    }
  }

  /**
   * Bytes this query would ACTUALLY put on the wire.
   *
   * Delegates to the transport, which is the only thing that knows its own
   * encoding: it compresses when the peer advertised compression on this
   * connection, and sends plain JSON otherwise. When the transport cannot be asked
   * (an older client object, or a test double that does not implement it), fall back
   * to measuring the plain envelope — still a measurement of a real serialization,
   * never a ratio applied to a size.
   */
  private measureQueryWireBytes(method: string, data: unknown): number {
    try {
      const measured = this.foundryClient.measureQueryWireBytes?.(method, data);
      if (typeof measured === 'number' && measured >= 0) return measured;
    } catch {
      /* fall through to the plain measurement */
    }
    return payloadBytes({ type: 'mcp-query', id: 'query-0', data: { method, data } });
  }

  /**
   * Describe what the transport would do with this request, sending nothing.
   *
   * Every size here is measured: `payloadBytes` for uncompressed JSON,
   * `gzippedBytes` for a document's compressed size, and the transport's own
   * encoder for a query's wire size. No compression ratio is ever assumed.
   */
  private buildTransportPlan(
    chunks: DocChunk<Record<string, any>>[],
    ctx: {
      folder: string | undefined;
      overwrite: boolean | undefined;
      dryRun: boolean | undefined;
      stopOnError: boolean | undefined;
      baseTimeout: number;
      budget: number;
      connectionType: 'websocket' | 'webrtc' | null;
      /** Archive entry per document, by object identity. Empty for other intakes. */
      entryOf: Map<Record<string, any>, string>;
      archive?: ArchiveReport;
    }
  ): TransportPlan {
    const compressed = this.compressionNegotiated();
    // The frame binds on WebRTC only: SCTP caps a data-channel message at
    // MAX_MESSAGE_SIZE, while `foundry-connector` sets no `maxPayload` on its
    // WebSocket server, so `ws`'s 100 MiB default applies there and a large
    // document imports today. Refusing on WebSocket would be a regression.
    const frameEnforced = ctx.connectionType === 'webrtc';

    const queries: TransportPlanQuery[] = [];
    const documents: TransportPlanDocument[] = [];

    chunks.forEach((chunk, i) => {
      const payload: Record<string, unknown> = { actors: chunk.docs };
      if (ctx.folder !== undefined) payload.folder = ctx.folder;
      if (ctx.overwrite !== undefined) payload.overwrite = ctx.overwrite;
      if (ctx.dryRun !== undefined) payload.dryRun = ctx.dryRun;
      if (ctx.stopOnError !== undefined) payload.stopOnError = ctx.stopOnError;

      const timeout = chunkTimeoutMs(chunk, ctx.baseTimeout, ctx.budget);
      const wireBytes = this.measureQueryWireBytes('foundry-mcp-bridge.importActors', payload);
      const overFrame = wireBytes > TRANSPORT_MAX_MESSAGE_BYTES;
      const sendable = !(frameEnforced && overFrame);

      const names = chunk.docs.map(d => labelOf(d)).join(', ');
      const reason = sendable
        ? undefined
        : compressed
          ? `Query ${i + 1} (${names}) measures ${chunk.bytes} bytes of JSON and ${wireBytes} bytes ` +
            `COMPRESSED on the wire, over the ${TRANSPORT_MAX_MESSAGE_BYTES}-byte transport frame. ` +
            `Compression cannot help: already-compressed content does not compress, and the usual ` +
            `culprit is art embedded as a base64 \`data:\` URI. Remedy: sync the image to the Foundry ` +
            `server and repoint \`img\` / \`prototypeToken.texture.src\` at the uploaded path — which ` +
            `the importer's avatar-preservation requirement mandates anyway — then re-import.`
          : `Query ${i + 1} (${names}) measures ${chunk.bytes} bytes of JSON and ${wireBytes} bytes ` +
            `on the wire, over the ${TRANSPORT_MAX_MESSAGE_BYTES}-byte transport frame, because the ` +
            `connected Foundry module does not advertise "${COMPRESSION_CAPABILITY}" so this message ` +
            `would be sent UNCOMPRESSED. Remedy: update the Foundry MCP Bridge module and reload the ` +
            `world as GM; compressed, a document this size normally measures 6.9x-12x smaller.`;

      queries.push({
        index: i + 1,
        documents: chunk.docs.length,
        bytes: chunk.bytes,
        wireBytes,
        timeoutMs: timeout,
        sendable,
        ...(reason !== undefined ? { reason } : {}),
      });

      for (const doc of chunk.docs) {
        const entry = ctx.entryOf.get(doc);
        documents.push({
          name: labelOf(doc),
          sourceId: sourceIdOf(doc),
          ...(entry !== undefined ? { entry } : {}),
          provenance: sourceIdOf(doc) !== null ? 'resolved' : 'missing',
          bytes: payloadBytes(doc),
          compressedBytes: gzippedBytes(doc),
          query: i + 1,
          timeoutMs: timeout,
          sendable,
          ...(reason !== undefined ? { reason } : {}),
        });
      }
    });

    return {
      transport: ctx.connectionType,
      encoding: compressed ? 'gzip' : 'plain',
      frameBytes: TRANSPORT_MAX_MESSAGE_BYTES,
      frameEnforced,
      chunkBytes: ctx.budget,
      queries,
      documents,
      totals: {
        documents: documents.length,
        bytes: documents.reduce((n, d) => n + d.bytes, 0),
        compressedBytes: documents.reduce((n, d) => n + d.compressedBytes, 0),
        queries: queries.length,
        unsendable: queries.filter(q => !q.sendable).length,
        // The one cost nothing else bounds. `chunkTimeoutMs` caps each query at
        // 600,000 ms and never their sum, so a 50-document archive can be ~580 s
        // of wall clock inside a single tool call.
        summedTimeoutMs: queries.reduce((n, q) => n + q.timeoutMs, 0),
      },
      // The SAME object the response returns as `archive`, so the plan is complete
      // on its own without a second structure to keep in step.
      ...(ctx.archive !== undefined ? { archive: ctx.archive } : {}),
    };
  }
}
