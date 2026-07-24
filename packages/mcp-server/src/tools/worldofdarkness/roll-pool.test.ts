/**
 * WoD roll-pool tool tests.
 *
 * The dice are rolled browser-side (in the Foundry module via the `rollDice`
 * bridge query); the WoD success/botch counting is a PURE MCP-side function.
 * These cover both: the `countPool` counter over seeded dice arrays (every
 * branch) and that the tool forwards a valid call and shapes the result.
 */

import { describe, it, expect, vi } from 'vitest';
import { WoDRollPoolTools, countPool } from './roll-pool.js';

function makeTools(queryImpl?: (method: string, data: any) => unknown) {
  const query = vi.fn(queryImpl ?? (async () => ({ success: true, total: 0, dice: [] })));
  const logger: any = { info: vi.fn(), error: vi.fn(), child: () => logger };
  const foundryClient: any = { query };
  const tools = new WoDRollPoolTools({ foundryClient, logger });
  return { tools, query };
}

describe('countPool', () => {
  it('counts a plain success (dice >= difficulty)', () => {
    const r = countPool([7, 8, 3], { difficulty: 6 });
    expect(r.successes).toBe(2);
    expect(r.ones).toBe(0);
    expect(r.net).toBe(2);
    expect(r.outcome).toBe('success');
    expect(r.autoSuccess).toBe(false);
  });

  it('doubles 10s with a specialty (10-again)', () => {
    const r = countPool([10, 7, 3], { difficulty: 6, specialty: true });
    // 10 → 2 successes, 7 → 1 success = 3
    expect(r.successes).toBe(3);
    expect(r.net).toBe(3);
    expect(r.outcome).toBe('success');
  });

  it('does NOT double 10s without a specialty', () => {
    const r = countPool([10, 3], { difficulty: 6 });
    expect(r.successes).toBe(1);
    expect(r.net).toBe(1);
    expect(r.outcome).toBe('success');
  });

  it('cancels a success for each 1', () => {
    const r = countPool([7, 1, 8], { difficulty: 6 });
    expect(r.successes).toBe(2);
    expect(r.ones).toBe(1);
    expect(r.net).toBe(1);
    expect(r.outcome).toBe('success');
  });

  it('1s can reduce net to zero → fail (not botch, because there were successes)', () => {
    const r = countPool([7, 1], { difficulty: 6 });
    expect(r.successes).toBe(1);
    expect(r.ones).toBe(1);
    expect(r.net).toBe(0);
    expect(r.outcome).toBe('fail');
  });

  it('botches when there is a 1, no successes, and no willpower', () => {
    const r = countPool([1, 3, 4], { difficulty: 6 });
    expect(r.successes).toBe(0);
    expect(r.ones).toBe(1);
    expect(r.net).toBe(0);
    expect(r.outcome).toBe('botch');
    expect(r.autoSuccess).toBe(false);
  });

  it('willpower floors net at >=1 and prevents a botch', () => {
    const r = countPool([1, 3, 4], { difficulty: 6, willpower: true });
    expect(r.successes).toBe(0);
    expect(r.ones).toBe(1);
    expect(r.net).toBe(1); // max(0, 0-1) + 1 uncancellable auto-success
    expect(r.outcome).toBe('success');
    expect(r.autoSuccess).toBe(true);
  });

  it('willpower adds one auto-success on an otherwise-clean roll', () => {
    const r = countPool([7, 3], { difficulty: 6, willpower: true });
    expect(r.successes).toBe(1);
    expect(r.net).toBe(2);
    expect(r.outcome).toBe('success');
    expect(r.autoSuccess).toBe(true);
  });

  it('fails with no successes and no 1s', () => {
    const r = countPool([2, 3], { difficulty: 6 });
    expect(r.successes).toBe(0);
    expect(r.ones).toBe(0);
    expect(r.net).toBe(0);
    expect(r.outcome).toBe('fail');
  });
});

describe('WoDRollPoolTools.getToolDefinitions', () => {
  it('exposes worldofdarkness-roll-pool requiring pool', () => {
    const [def] = makeTools().tools.getToolDefinitions();
    expect(def.name).toBe('worldofdarkness-roll-pool');
    expect(def.inputSchema.required).toEqual(['pool']);
    expect(def.description).toContain('[worldofdarkness only]');
  });
});

describe('WoDRollPoolTools.handleRollPool', () => {
  it('rolls Nd10, posts it, and returns the counted breakdown', async () => {
    const { tools, query } = makeTools(async () => ({
      success: true,
      total: 15,
      dice: [7, 8, 1],
    }));

    const result = await tools.handleRollPool({ pool: 3, difficulty: 6 });

    expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.rollDice', {
      formula: '3d10',
      flavor: 'World of Darkness pool (diff 6)',
      whisper: false,
    });
    expect(result.success).toBe(true);
    expect(result.dice).toEqual([7, 8, 1]);
    expect(result.successes).toBe(2);
    expect(result.ones).toBe(1);
    expect(result.net).toBe(1);
    expect(result.outcome).toBe('success');
  });

  it('passes a custom flavor and whisper through to the bridge', async () => {
    const { tools, query } = makeTools(async () => ({ success: true, total: 0, dice: [2] }));
    await tools.handleRollPool({ pool: 1, flavor: 'Perception + Alertness', whisper: true });
    expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.rollDice', {
      formula: '1d10',
      flavor: 'Perception + Alertness',
      whisper: true,
    });
  });

  it('rejects a pool below 1 without calling the bridge', async () => {
    const { tools, query } = makeTools();
    const result = await tools.handleRollPool({ pool: 0 });
    expect(result.success).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });

  it('surfaces a failed roll from Foundry', async () => {
    const { tools } = makeTools(async () => ({ success: false, error: 'boom' }));
    const result = await tools.handleRollPool({ pool: 3 });
    expect(result.success).toBe(false);
    expect(result.error).toBe('boom');
  });
});
