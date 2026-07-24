import { z } from 'zod';
import { FoundryClient } from '../../foundry-client.js';
import { Logger } from '../../logger.js';

export interface WoDAdjustTraitToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

const adjustTraitSchema = z
  .object({
    actor: z.string().min(1),
    trait: z.string().min(1),
    delta: z.number().int(),
    which: z.enum(['temporary', 'permanent']).default('temporary'),
  })
  .strict();

/**
 * `worldofdarkness-adjust-trait` — spend or gain points on a WoD pool / advantage
 * (willpower, blood pool, rage, gnosis, quintessence, glamour, essence, …). These
 * are embedded `Advantage` items keyed by `system.id`; this patches the item's
 * `system.temporary` (default) or `system.permanent`.
 */
export class WoDAdjustTraitTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor({ foundryClient, logger }: WoDAdjustTraitToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'WoDAdjustTraitTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'worldofdarkness-adjust-trait',
        description:
          '[worldofdarkness only] Spend or gain points on a World of Darkness pool or advantage: ' +
          'willpower, bloodpool, rage, gnosis, quintessence, glamour, essence, path/humanity, ' +
          'and similar. Pass a negative delta to spend and a positive delta to gain. These pools ' +
          'are embedded Advantage items identified by their system.id; the tool refuses a trait ' +
          'the actor does not have. By default it changes the temporary (current) rating; pass ' +
          'which="permanent" to change the permanent (max) rating instead.',
        inputSchema: {
          type: 'object',
          properties: {
            actor: {
              type: 'string',
              description: 'Actor name or 16-character Foundry id',
            },
            trait: {
              type: 'string',
              description:
                "The pool/advantage system.id, e.g. 'willpower', 'bloodpool', 'rage', 'gnosis', " +
                "'quintessence', 'glamour', 'essence', 'path'.",
            },
            delta: {
              type: 'integer',
              description: 'Points to change by: negative to spend, positive to gain.',
            },
            which: {
              type: 'string',
              enum: ['temporary', 'permanent'],
              description:
                'Which rating to change: "temporary" (current, default) or "permanent" (max).',
            },
          },
          required: ['actor', 'trait', 'delta'],
        },
      },
    ];
  }

  async handleAdjustTrait(args: unknown) {
    const parsed = adjustTraitSchema.safeParse(args);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      return { success: false, error: `Invalid arguments: ${detail}` };
    }

    const { actor, trait, delta, which } = parsed.data;
    this.logger.info('Adjusting WoD trait', { actor, trait, delta, which });

    try {
      const found = await this.foundryClient.query('foundry-mcp-bridge.findActor', {
        identifier: actor,
      });
      if (!found || !found.id) {
        return { success: false, error: `Actor not found: ${actor}` };
      }

      const info = await this.foundryClient.query('foundry-mcp-bridge.getCharacterInfo', {
        characterId: found.id,
      });
      const items: any[] = Array.isArray(info?.items) ? info.items : [];

      const traitKey = trait.toLowerCase();
      const item = items.find(
        it => it?.type === 'Advantage' && String(it?.system?.id ?? '').toLowerCase() === traitKey
      );
      if (!item) {
        return {
          success: false,
          error: `Actor "${found.name}" has no adjustable trait "${trait}" (no matching Advantage item).`,
        };
      }

      const max = Number(item.system?.max ?? 10) || 10;
      const current = Number(item.system?.[which] ?? 0) || 0;
      const newValue = Math.min(max, Math.max(0, current + delta));

      const updateResult = await this.foundryClient.query('foundry-mcp-bridge.updateActorItems', {
        actorIdentifier: found.id,
        itemUpdates: [
          {
            id: item.id,
            system: { [which]: newValue },
          },
        ],
      });

      if (updateResult?.success === false) {
        return { success: false, error: updateResult.error ?? 'Failed to update trait' };
      }

      return {
        success: true,
        actor: { id: found.id, name: found.name },
        trait: traitKey,
        which,
        previous: current,
        applied: delta,
        current: newValue,
        max,
      };
    } catch (error) {
      this.logger.error('Failed to adjust WoD trait', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }
}
