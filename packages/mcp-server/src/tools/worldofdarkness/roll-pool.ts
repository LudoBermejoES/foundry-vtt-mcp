import { z } from 'zod';
import { FoundryClient } from '../../foundry-client.js';
import { Logger } from '../../logger.js';

export interface WoDRollPoolToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

const rollPoolSchema = z
  .object({
    pool: z.number().int().min(1),
    difficulty: z.number().int().min(2).max(10).default(6),
    specialty: z.boolean().optional(),
    willpower: z.boolean().optional(),
    flavor: z.string().optional(),
    whisper: z.boolean().optional(),
  })
  .strict();

export interface PoolCount {
  successes: number;
  ones: number;
  net: number;
  outcome: 'botch' | 'fail' | 'success';
  autoSuccess: boolean;
}

/**
 * PURE World of Darkness (Storyteller / M20) dice-pool success counter.
 *
 * Rules:
 *  - a die >= difficulty scores 1 success;
 *  - with a specialty, each die showing 10 scores an EXTRA success (10-again → 2 total);
 *  - each die showing 1 cancels one rolled success;
 *  - the 1s cancellation floors the rolled net at 0 (it cannot go negative);
 *  - a willpower spend adds 1 UNCANCELLABLE auto-success AFTER the 1s cancellation,
 *    so a willpower roll always nets >= 1 and can never botch;
 *  - botch = at least one 1, no successes, and no willpower auto-success;
 *  - otherwise a net of 0 is a plain failure.
 */
export function countPool(
  dice: number[],
  opts: { difficulty: number; specialty?: boolean; willpower?: boolean }
): PoolCount {
  const { difficulty, specialty, willpower } = opts;

  let successes = 0;
  let ones = 0;
  for (const d of dice) {
    if (d === 1) ones += 1;
    if (d >= difficulty) successes += 1;
    if (specialty && d === 10) successes += 1; // 10-again: the extra on top of the base success
  }

  // 1s cancel rolled successes; cannot push the rolled net below 0.
  let net = Math.max(0, successes - ones);

  const autoSuccess = !!willpower;
  if (autoSuccess) net += 1; // uncancellable, added AFTER the 1s cancellation

  let outcome: 'botch' | 'fail' | 'success';
  if (net > 0) {
    outcome = 'success';
  } else if (ones >= 1 && successes === 0 && !willpower) {
    outcome = 'botch';
  } else {
    outcome = 'fail';
  }

  return { successes, ones, net, outcome, autoSuccess };
}

/**
 * `worldofdarkness-roll-pool` — roll a d10 dice pool, post it to the Foundry chat
 * log, and return the WoD success/botch breakdown.
 */
export class WoDRollPoolTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor({ foundryClient, logger }: WoDRollPoolToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'WoDRollPoolTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'worldofdarkness-roll-pool',
        description:
          '[worldofdarkness only] Roll a World of Darkness / M20 Storyteller d10 dice pool and ' +
          'post it to the Foundry chat log, returning the success breakdown. Each die that meets ' +
          'or beats the difficulty (default 6) is a success; a specialty makes every 10 count ' +
          'twice (10-again); each 1 cancels a success; spending willpower adds one uncancellable ' +
          'auto-success and prevents a botch. A botch is at least one 1 with no successes. USE ' +
          'THIS for any WoD trait/ability/pool roll (attribute + ability, soak, damage successes, ' +
          'discipline/sphere/gift activation, etc.).',
        inputSchema: {
          type: 'object',
          properties: {
            pool: {
              type: 'integer',
              minimum: 1,
              description: 'Number of d10s to roll (the dice pool size).',
            },
            difficulty: {
              type: 'integer',
              minimum: 2,
              maximum: 10,
              description: 'Target number a die must meet or beat to be a success (default 6).',
            },
            specialty: {
              type: 'boolean',
              description: 'If true, every die showing 10 counts as two successes (10-again).',
            },
            willpower: {
              type: 'boolean',
              description:
                'If true, add one uncancellable automatic success (also prevents a botch).',
            },
            flavor: {
              type: 'string',
              description: 'Optional chat flavor / label for the roll.',
            },
            whisper: {
              type: 'boolean',
              description: 'If true, whisper the roll to the GM instead of posting it publicly.',
            },
          },
          required: ['pool'],
        },
      },
    ];
  }

  async handleRollPool(args: unknown) {
    const parsed = rollPoolSchema.safeParse(args);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      return { success: false, error: `Invalid arguments: ${detail}` };
    }

    const { pool, difficulty, specialty, willpower, flavor, whisper } = parsed.data;
    const formula = `${pool}d10`;

    this.logger.info('Rolling WoD pool', { pool, difficulty, specialty, willpower });
    try {
      const rollResult = await this.foundryClient.query('foundry-mcp-bridge.rollDice', {
        formula,
        flavor: flavor ?? `World of Darkness pool (diff ${difficulty})`,
        whisper: whisper ?? false,
      });

      if (!rollResult || rollResult.success === false) {
        return {
          success: false,
          error: rollResult?.error ?? 'Roll failed in Foundry',
        };
      }

      const dice: number[] = Array.isArray(rollResult.dice) ? rollResult.dice : [];
      const counted = countPool(dice, {
        difficulty,
        specialty: specialty ?? false,
        willpower: willpower ?? false,
      });

      return {
        success: true,
        pool,
        difficulty,
        dice,
        successes: counted.successes,
        ones: counted.ones,
        net: counted.net,
        outcome: counted.outcome,
        autoSuccess: counted.autoSuccess,
      };
    } catch (error) {
      this.logger.error('Failed to roll WoD pool', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }
}
