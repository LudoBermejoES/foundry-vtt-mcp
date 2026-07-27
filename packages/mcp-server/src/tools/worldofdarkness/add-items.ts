import { z } from 'zod';
import { FoundryClient } from '../../foundry-client.js';
import { Logger } from '../../logger.js';

export interface WoDAddItemsToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

const itemSchema = z
  .object({
    name: z.string().min(1),
    type: z.string().optional(),
    pack: z.string().optional(),
  })
  .strict();

const addItemsSchema = z
  .object({
    actor: z.string().min(1),
    items: z.array(itemSchema).min(1),
  })
  .strict();

/**
 * `worldofdarkness-add-items` — embed World of Darkness content
 * (disciplines, gifts, spheres, merits, backgrounds, charms, …) onto an actor.
 * Every requested item is resolved against the wod20-compendium-es Item packs and
 * copied in full. Resolution is ALL-OR-NOTHING: if any name cannot be resolved,
 * nothing is added.
 */
export class WoDAddItemsTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor({ foundryClient, logger }: WoDAddItemsToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'WoDAddItemsTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'worldofdarkness-add-items',
        description:
          '[worldofdarkness only] Add World of Darkness content to an existing actor: ' +
          'disciplines, gifts, spheres, merits, flaws, backgrounds, clans, charms, ' +
          'special-advantages and other items from the wod20-compendium-es Item packs. Each item ' +
          'is matched by name (optionally narrowed by "type" or "pack") and copied in full. ' +
          'Resolution is all-or-nothing: if any item cannot be resolved, nothing is added. USE ' +
          'worldofdarkness-search-content first to find exact names; use worldofdarkness-create-actor ' +
          'to create the actor itself.',
        inputSchema: {
          type: 'object',
          properties: {
            actor: {
              type: 'string',
              description: 'Actor name or 16-character Foundry id',
            },
            items: {
              type: 'array',
              description: 'Items to add to the actor (resolved from wod20-compendium-es).',
              minItems: 1,
              items: {
                type: 'object',
                properties: {
                  name: {
                    type: 'string',
                    description: 'Item name to look up (e.g. "Celerity", "Resources").',
                  },
                  type: {
                    type: 'string',
                    description: 'Optional Foundry Item type to disambiguate the match.',
                  },
                  pack: {
                    type: 'string',
                    description:
                      'Optional compendium pack id (or fragment) to source the item from.',
                  },
                },
                required: ['name'],
                additionalProperties: false,
              },
            },
          },
          required: ['actor', 'items'],
        },
      },
    ];
  }

  async handleAddItems(args: unknown) {
    const parsed = addItemsSchema.safeParse(args);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      return { success: false, error: `Invalid arguments: ${detail}` };
    }

    const { actor, items } = parsed.data;
    this.logger.info('Adding WoD items', { actor, count: items.length });

    try {
      const found = await this.foundryClient.query('foundry-mcp-bridge.findActor', {
        identifier: actor,
      });
      if (!found || !found.id) {
        return { success: false, error: `Actor not found: ${actor}` };
      }

      // Resolve EVERY requested item first (all-or-nothing). Only after all
      // resolve do we embed anything on the actor.
      const resolved: Array<{ name: string; type: string; img?: string; system?: any }> = [];
      for (const req of items) {
        const hits = await this.foundryClient.query('foundry-mcp-bridge.searchCompendium', {
          query: req.name,
          packType: 'Item',
        });
        const candidates: any[] = Array.isArray(hits) ? hits : [];

        const reqName = req.name.toLowerCase();
        const reqType = req.type?.toLowerCase();
        const reqPack = req.pack?.toLowerCase();

        let match =
          candidates.find(
            c =>
              String(c?.name ?? '').toLowerCase() === reqName &&
              (reqType ? String(c?.type ?? '').toLowerCase() === reqType : true) &&
              (reqPack
                ? String(c?.pack ?? '')
                    .toLowerCase()
                    .includes(reqPack)
                : true)
          ) ??
          candidates.find(
            c =>
              (reqType ? String(c?.type ?? '').toLowerCase() === reqType : true) &&
              (reqPack
                ? String(c?.pack ?? '')
                    .toLowerCase()
                    .includes(reqPack)
                : true)
          );

        if (!match || !match.pack || !match.id) {
          return {
            success: false,
            // Forward pointer, not just a refusal: an item no pack contains (an
            // Ability a splat template does not seed, for instance) lands here,
            // and the caller then needs to know that creating it from scratch is
            // possible — it just lives on a different tool.
            error:
              `Could not resolve item "${req.name}"${req.type ? ` (type ${req.type})` : ''} in the WoD compendiums; nothing was added. ` +
              `If no pack contains it, create it directly instead: manage-actors ` +
              `{ action: "create-items", actorIdentifier, items: [{ name, type, system }] } ` +
              `(equivalently manage-world-items { action: "add-to-actor" }).`,
          };
        }

        const full = await this.foundryClient.query(
          'foundry-mcp-bridge.getCompendiumDocumentFull',
          { packId: match.pack, documentId: match.id }
        );
        if (!full || !full.name || !full.type) {
          return {
            success: false,
            error: `Failed to load full document for "${req.name}"; nothing was added.`,
          };
        }

        resolved.push({
          name: full.name,
          type: full.type,
          img: full.img,
          system: full.system,
        });
      }

      const result = await this.foundryClient.query('foundry-mcp-bridge.addActorItems', {
        actorIdentifier: found.id,
        items: resolved,
      });

      if (result?.success === false) {
        return { success: false, error: result.error ?? 'Failed to add items' };
      }

      return {
        success: true,
        actor: { id: found.id, name: found.name },
        created: result?.created ?? [],
      };
    } catch (error) {
      this.logger.error('Failed to add WoD items', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }
}
