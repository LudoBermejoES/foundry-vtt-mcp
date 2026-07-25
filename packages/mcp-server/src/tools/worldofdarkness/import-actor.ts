import { z } from 'zod';
import { FoundryClient } from '../../foundry-client.js';
import { Logger } from '../../logger.js';

export interface WoDImportActorToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
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
  })
  .refine(d => d.actor !== undefined || (Array.isArray(d.actors) && d.actors.length > 0), {
    message: 'Provide either `actor` (one doc) or a non-empty `actors` array.',
  });

/**
 * `worldofdarkness-import-actor` — create Foundry actors from full exported
 * Actor JSON documents (as emitted by the wodchar character exporter). Unlike
 * `worldofdarkness-create-actor` (which builds a blank actor from a splat), this
 * faithfully reconstructs the actor from the document: `Actor.create(doc)`
 * natively preserves embedded `items`, the `prototypeToken`, `img`, `system`,
 * and `flags` in one shot — nothing is re-mapped.
 */
export class WoDImportActorTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor({ foundryClient, logger }: WoDImportActorToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'WoDImportActorTools' });
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
          'flags.wodchar.sourceId (from the doc, or an explicit per-actor `sourceId`); re-importing ' +
          'the same sourceId is skipped, or updated in place when `overwrite` is true.',
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

    const { actor, actors, folder, overwrite } = parsed.data;
    const docs = actors ?? (actor ? [actor] : []);

    this.logger.info('Importing WoD actor(s)', {
      count: docs.length,
      folder,
      overwrite: overwrite === true,
    });

    try {
      const payload: Record<string, unknown> = { actors: docs };
      if (folder !== undefined) payload.folder = folder;
      if (overwrite !== undefined) payload.overwrite = overwrite;

      const result = await this.foundryClient.query('foundry-mcp-bridge.importActors', payload);

      if (result?.success === false) {
        return { success: false, error: result.error ?? 'Failed to import actor(s)' };
      }

      const results = Array.isArray(result?.results) ? result.results : [];
      return {
        success: true,
        total: results.length,
        results,
      };
    } catch (error) {
      this.logger.error('Failed to import WoD actor(s)', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }
}
