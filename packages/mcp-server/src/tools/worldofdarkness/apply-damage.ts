import { z } from 'zod';
import { FoundryClient } from '../../foundry-client.js';
import { Logger } from '../../logger.js';

export interface WoDApplyDamageToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

const DAMAGE_TYPES = ['bashing', 'lethal', 'aggravated'] as const;

const applyDamageSchema = z
  .object({
    actor: z.string().min(1),
    type: z.enum(DAMAGE_TYPES),
    amount: z.number().int(),
    soak: z.boolean().optional().default(false),
  })
  .strict();

/**
 * `worldofdarkness-apply-damage` — add (or heal, with a negative amount) health
 * levels of a given damage type on a WoD actor. Patches
 * `system.health.damage.{bashing|lethal|aggravated}`.
 */
export class WoDApplyDamageTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor({ foundryClient, logger }: WoDApplyDamageToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'WoDApplyDamageTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'worldofdarkness-apply-damage',
        description:
          '[worldofdarkness only] Apply or heal health damage on a World of Darkness actor. ' +
          'Adds "amount" levels of the given damage type (bashing, lethal or aggravated) to ' +
          "the actor's health track; a negative amount heals. Patches " +
          'system.health.damage.<type>. Soak is ADVISORY only — this tool does not auto-subtract ' +
          'a soak roll; the GM decides soak and passes the already-soaked amount. USE THIS after ' +
          'resolving an attack or a healing action.',
        inputSchema: {
          type: 'object',
          properties: {
            actor: {
              type: 'string',
              description: 'Actor name or 16-character Foundry id',
            },
            type: {
              type: 'string',
              enum: [...DAMAGE_TYPES],
              description: 'Damage type: bashing, lethal or aggravated.',
            },
            amount: {
              type: 'integer',
              description: 'Health levels to add; a negative value heals.',
            },
            soak: {
              type: 'boolean',
              description:
                'Advisory flag only: whether the amount already accounts for soak. Recorded in ' +
                'the response; no automatic soak is applied.',
            },
          },
          required: ['actor', 'type', 'amount'],
        },
      },
    ];
  }

  async handleApplyDamage(args: unknown) {
    const parsed = applyDamageSchema.safeParse(args);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      return { success: false, error: `Invalid arguments: ${detail}` };
    }

    const { actor, type, amount, soak } = parsed.data;
    this.logger.info('Applying WoD damage', { actor, type, amount });

    try {
      // Resolve the actor id (refuse if not found).
      const found = await this.foundryClient.query('foundry-mcp-bridge.findActor', {
        identifier: actor,
      });
      if (!found || !found.id) {
        return { success: false, error: `Actor not found: ${actor}` };
      }

      // Read the current health so we can compute the new (clamped) value.
      const info = await this.foundryClient.query('foundry-mcp-bridge.getCharacterInfo', {
        characterId: found.id,
      });
      const system: any = info?.system ?? {};
      const current = Number(system?.health?.damage?.[type] ?? 0) || 0;
      const newValue = Math.max(0, current + amount);

      const updateResult = await this.foundryClient.query('foundry-mcp-bridge.updateActors', {
        updates: [
          {
            id: found.id,
            system: { health: { damage: { [type]: newValue } } },
          },
        ],
      });

      if (updateResult?.success === false) {
        return { success: false, error: updateResult.error ?? 'Failed to update actor health' };
      }

      return {
        success: true,
        actor: { id: found.id, name: found.name },
        type,
        previous: current,
        applied: amount,
        current: newValue,
        soak,
        note: soak
          ? 'Soak flag was set — this tool does not auto-apply soak; the amount was applied as given.'
          : undefined,
      };
    } catch (error) {
      this.logger.error('Failed to apply WoD damage', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }
}
