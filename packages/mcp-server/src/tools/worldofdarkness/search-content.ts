import { z } from 'zod';
import { FoundryClient } from '../../foundry-client.js';
import { Logger } from '../../logger.js';

export interface WoDSearchContentToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

const searchContentSchema = z
  .object({
    query: z.string().min(2),
    line: z.string().optional(),
    type: z.string().optional(),
  })
  .strict();

const LINE_KEYS = [
  'mage',
  'vampire',
  'werewolf',
  'changeling',
  'wraith',
  'hunter',
  'mortal',
  'creature',
  'demon',
];

/**
 * Best-effort game-line detection for a compendium hit. Provenance flags
 * (`flags['wod20-char']` / `flags['wod20-compendium-es']` → `{ line }`) are the
 * authoritative source when present; otherwise the pack id/label is scanned for a
 * known line keyword.
 */
function detectLine(hit: any): string | undefined {
  const flags = hit?.system?.flags ?? hit?.flags;
  const flagLine = flags?.['wod20-char']?.line ?? flags?.['wod20-compendium-es']?.line ?? undefined;
  if (flagLine) return String(flagLine).toLowerCase();

  const haystack = `${hit?.pack ?? ''} ${hit?.packLabel ?? ''}`.toLowerCase();
  return LINE_KEYS.find(k => haystack.includes(k));
}

/**
 * `worldofdarkness-search-content` — search the installed `wod20-compendium-es`
 * Item packs (disciplines, gifts, spheres, merits, backgrounds, clans, charms,
 * special-advantages, …). Read-only lookup; pack discovery is dynamic.
 */
export class WoDSearchContentTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor({ foundryClient, logger }: WoDSearchContentToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'WoDSearchContentTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'worldofdarkness-search-content',
        description:
          '[worldofdarkness only] Search the installed wod20-compendium-es Item packs — ' +
          'disciplines, gifts, spheres, merits, flaws, backgrounds, clans, charms, ' +
          'special-advantages and other World of Darkness content. Returns matching items with ' +
          'their pack, id, name, item type and detected game line. Optionally filter by "line" ' +
          '(mage, vampire, werewolf, …) or by item "type". Pack discovery is dynamic — no pack ' +
          'list is hardcoded. USE THIS to find content to add with worldofdarkness-add-items.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Text to search for in item names (at least 2 characters).',
            },
            line: {
              type: 'string',
              description:
                'Optional game line to filter to: mage, vampire, werewolf, changeling, wraith, ' +
                'hunter, mortal, creature, …',
            },
            type: {
              type: 'string',
              description:
                'Optional Foundry Item type to filter to (e.g. Power, Feature, Ability).',
            },
          },
          required: ['query'],
        },
      },
    ];
  }

  async handleSearchContent(args: unknown) {
    const parsed = searchContentSchema.safeParse(args);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      return { success: false, error: `Invalid arguments: ${detail}` };
    }

    const { query, line, type } = parsed.data;
    this.logger.info('Searching WoD content', { query, line, type });

    try {
      const raw = await this.foundryClient.query('foundry-mcp-bridge.searchCompendium', {
        query,
        packType: 'Item',
      });

      const hits: any[] = Array.isArray(raw) ? raw : [];
      const lineFilter = line?.toLowerCase();
      const typeFilter = type?.toLowerCase();

      const results = hits
        .map(h => ({
          pack: h?.pack,
          id: h?.id,
          name: h?.name,
          type: h?.type,
          line: detectLine(h),
        }))
        .filter(r => (typeFilter ? String(r.type ?? '').toLowerCase() === typeFilter : true))
        .filter(r => (lineFilter ? r.line === lineFilter : true));

      return { success: true, count: results.length, results };
    } catch (error) {
      this.logger.error('Failed to search WoD content', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }
}
