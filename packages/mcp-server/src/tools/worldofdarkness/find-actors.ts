import { z } from 'zod';
import { FoundryClient } from '../../foundry-client.js';
import { Logger } from '../../logger.js';

export interface WoDFindActorsToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

/** Default flag path — the key `worldofdarkness-import-actor` stamps at creation. */
const DEFAULT_FLAG_PATH = 'wodchar.sourceId';

/**
 * `scope.key` with 2–4 segments. Deliberately narrow: the path is interpolated
 * into a `foundry.utils.getProperty` lookup module-side, so it must not be able to
 * carry array indices, wildcards or prototype-chain hops (`__proto__`,
 * `constructor`). Re-validated in the module — this is not the only line of
 * defence, just the first.
 */
const FLAG_PATH_RE = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+){1,3}$/;

/** Advertised by `handlePing` from module 0.9.3. */
const MODULE_CAPABILITY_FIND = 'findActorsByFlag';

const findActorsSchema = z
  .object({
    flagPath: z.string().min(1).regex(FLAG_PATH_RE).optional(),
    values: z.array(z.string().min(1)).min(1).max(100).optional(),
    exists: z.boolean().optional(),
    type: z.string().min(1).optional(),
  })
  .strict()
  .refine(d => (d.values !== undefined) !== (d.exists === true), {
    message: 'Provide exactly one of `values` (the ids to look up) or `exists: true`.',
  });

export interface FindActorMatch {
  id: string;
  name: string;
  type: string;
  img?: string;
  folder: string | null;
  flagValue: string;
}

/**
 * `worldofdarkness-find-actors` — map external source ids to Foundry actor ids.
 *
 * WHY IT EXISTS. Import idempotency keys entirely off `flags.wodchar.sourceId`,
 * but nothing could READ that flag: answering "does sourceId X already exist?"
 * meant firing the import with `overwrite: false` and inspecting whether the
 * result said `skipped` — using a WRITE path as a read probe, on a production
 * world. Failing that, `list-characters` had to be dumped and matched on NAME,
 * which is neither unique nor stable.
 *
 * `unmatched` is what makes it usable as an existence probe: an importer sends its
 * six source ids and gets back exactly which of them need creating. An id with no
 * match is REPORTED, never silently omitted — omission and "not found" would be
 * the same observation, and the caller would have to re-derive the difference.
 *
 * `duplicates` exists because two actors can carry the same source id, and the
 * import's own lookup uses `find()` — so a duplicate makes one of the two
 * permanently unreachable by import. Collapsing that to a single hit here would
 * hide the failure the caller most needs to see.
 */
export class WoDFindActorsTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor({ foundryClient, logger }: WoDFindActorsToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'WoDFindActorsTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'worldofdarkness-find-actors',
        description:
          '[worldofdarkness only] Find world actors by an EXTERNAL SOURCE ID carried in their ' +
          'document flags (default flag path "wodchar.sourceId", the key ' +
          'worldofdarkness-import-actor stamps at creation). READ-ONLY — writes nothing. ' +
          'USE THIS to map your own ids to Foundry actor ids, or to check which of a set of ' +
          'characters has already been imported, instead of dumping list-characters and matching ' +
          'on name (names are neither unique nor stable) or firing an import to see if it says ' +
          '"skipped". Returns one entry per matching actor with its id, name, type, portrait path ' +
          'and folder; every requested value with no match is listed in "unmatched"; any value ' +
          'held by more than one actor is listed in "duplicates" (a duplicate source id makes one ' +
          'of those actors unreachable by import, so it needs fixing). Pass exists: true instead ' +
          'of values to list every actor carrying the flag at all. ' +
          'Requires Foundry MCP Bridge module 0.9.3+.',
        inputSchema: {
          type: 'object',
          properties: {
            values: {
              type: 'array',
              items: { type: 'string' },
              description:
                'The external source ids to look up (1-100). Exact match, any-of. Exactly one of ' +
                '`values` or `exists` must be given.',
            },
            exists: {
              type: 'boolean',
              description:
                'true → return every actor that carries the flag at all, regardless of value. ' +
                'Use to audit which actors were imported. Cannot be combined with `values`.',
            },
            flagPath: {
              type: 'string',
              description:
                'Dotted flag path under the document\'s flags, "scope.key" with 2-4 segments. ' +
                'Defaults to "wodchar.sourceId".',
            },
            type: {
              type: 'string',
              description:
                'Optional Foundry actor-type filter (e.g. "PC"), mirroring list-characters.',
            },
          },
        },
      },
    ];
  }

  async handleFindActors(args: unknown) {
    const parsed = findActorsSchema.safeParse(args);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      return { success: false, error: `Invalid arguments: ${detail}` };
    }

    const { values, exists, type } = parsed.data;
    const flagPath = parsed.data.flagPath ?? DEFAULT_FLAG_PATH;

    this.logger.info('Finding WoD actors by flag', {
      flagPath,
      values: values?.length,
      exists: exists === true,
      type,
    });

    try {
      // The bridge query itself is NEW in module 0.9.3. An older module has no
      // handler registered, which surfaces as an opaque query error; pre-flighting
      // the advertised capability turns that into an actionable message naming the
      // two deploys. (This one cannot return wrong data — only no data — but the
      // caller still deserves to know WHY.)
      const gate = await this.assertSupported();
      if (gate !== null) return gate;

      const result = await this.foundryClient.query('foundry-mcp-bridge.findActorsByFlag', {
        flagPath,
        ...(values !== undefined ? { values } : {}),
        ...(exists === true ? { exists: true } : {}),
        ...(type !== undefined ? { type } : {}),
      });

      if (!result || result.success === false) {
        return { success: false, error: result?.error ?? 'Failed to find actors by flag' };
      }

      const matches: FindActorMatch[] = Array.isArray(result.matches) ? result.matches : [];

      // `unmatched` / `duplicates` are derived HERE, from the matches, rather than
      // computed module-side as well: one implementation, and the module stays a
      // dumb lookup. Order follows the caller's `values` so the answer lines up
      // with the question that was asked.
      const seen = new Map<string, number>();
      for (const m of matches) {
        seen.set(m.flagValue, (seen.get(m.flagValue) ?? 0) + 1);
      }
      const unmatched = values ? values.filter(v => !seen.has(v)) : [];
      const duplicates = [...seen.entries()].filter(([, n]) => n > 1).map(([v]) => v);

      return {
        success: true,
        flagPath,
        matches,
        total: matches.length,
        duplicates,
        unmatched,
        ...(values ? { requested: values.length } : {}),
      };
    } catch (error) {
      this.logger.error('Failed to find WoD actors by flag', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  private async assertSupported(): Promise<{ success: false; error: string } | null> {
    try {
      const pong = await this.foundryClient.query('foundry-mcp-bridge.ping', undefined, 10000);
      const caps: unknown = pong?.capabilities;
      if (Array.isArray(caps) && caps.includes(MODULE_CAPABILITY_FIND)) return null;
      return {
        success: false,
        error:
          'worldofdarkness-find-actors refused: the connected Foundry MCP Bridge module does not ' +
          `advertise "${MODULE_CAPABILITY_FIND}" (module version ${pong?.moduleVersion ?? 'unknown'}). ` +
          'The server bundle and the Foundry module deploy independently — update the module in ' +
          'the Foundry data directory and reload the world as GM.',
      };
    } catch (error) {
      return {
        success: false,
        error: `worldofdarkness-find-actors refused: could not confirm module capabilities — ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      };
    }
  }
}
