import { z } from 'zod';
import { FoundryClient } from '../../foundry-client.js';
import { Logger } from '../../logger.js';
// Cross-track import: implemented by the systems/worldofdarkness adapter track.
// Signature: export function extractFullSheet(actorData: any): any
import { extractFullSheet } from '../../systems/worldofdarkness/extract.js';

export interface WoDGetSheetToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

const getSheetSchema = z
  .object({
    actor: z.string().min(1),
  })
  .strict();

/**
 * `worldofdarkness-get-sheet` — read a World of Darkness actor and return the full
 * structured sheet (attributes, abilities, willpower, pools, virtues, powers,
 * merits, backgrounds, health, bio, …). READ-ONLY.
 */
export class WoDGetSheetTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor({ foundryClient, logger }: WoDGetSheetToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'WoDGetSheetTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'worldofdarkness-get-sheet',
        description:
          '[worldofdarkness only] Read a World of Darkness actor and return its full structured ' +
          'sheet: the nine attributes, abilities (talents/skills/knowledges), willpower, pools ' +
          '(rage, gnosis, blood, quintessence, glamour, essence, …), virtues, powers ' +
          '(disciplines/gifts/spheres/charms), merits, flaws, backgrounds, health track and bio. ' +
          'READ-ONLY — makes no changes. USE THIS to inspect a character before rolling or editing.',
        inputSchema: {
          type: 'object',
          properties: {
            actor: {
              type: 'string',
              description: 'Actor name or 16-character Foundry id',
            },
          },
          required: ['actor'],
        },
      },
    ];
  }

  async handleGetSheet(args: unknown) {
    const parsed = getSheetSchema.safeParse(args);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      return { success: false, error: `Invalid arguments: ${detail}` };
    }

    const { actor } = parsed.data;
    this.logger.info('Reading WoD sheet', { actor });

    try {
      const found = await this.foundryClient.query('foundry-mcp-bridge.findActor', {
        identifier: actor,
      });
      if (!found || !found.id) {
        return { success: false, error: `Actor not found: ${actor}` };
      }

      const actorData = await this.foundryClient.query('foundry-mcp-bridge.getCharacterInfo', {
        characterId: found.id,
      });
      if (!actorData || actorData.success === false) {
        return { success: false, error: actorData?.error ?? `Failed to read actor: ${actor}` };
      }

      const sheet = extractFullSheet(actorData);
      return { success: true, sheet };
    } catch (error) {
      this.logger.error('Failed to read WoD sheet', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }
}
