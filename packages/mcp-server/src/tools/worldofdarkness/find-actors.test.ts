/**
 * `worldofdarkness-find-actors` — "actors SHALL be findable by external source id".
 *
 * The bridge is stubbed. The module-side lookup itself is tested for real against
 * a fake Foundry world in `packages/foundry-module/src/actor-read-path.test.ts`;
 * what matters here is the tool contract: which query is sent, and that an id with
 * no match is REPORTED rather than silently omitted.
 */

import { describe, it, expect, vi } from 'vitest';
import { WoDFindActorsTools } from './find-actors.js';

const CAPABLE_PONG = {
  status: 'ok',
  moduleVersion: '0.9.3',
  capabilities: ['getCharacterInfo.include', 'findActorsByFlag'],
};

const OLD_PONG = {
  status: 'ok',
  moduleVersion: '0.9.2',
  capabilities: ['importActors.dryRun'],
};

/** The six Berlin students: five imported, one never was. */
const BERLIN = ['s-lena', 's-tobias', 's-marta', 's-jonas', 's-ines', 's-never-imported'];

function match(name: string, flagValue: string) {
  return {
    id: name.padEnd(16, '0').slice(0, 16),
    name,
    type: 'PC',
    img: `wod20-portraits/${name.toLowerCase()}.webp`,
    folder: 'Berlin Students',
    flagValue,
  };
}

const FIVE = [
  match('Lena', 's-lena'),
  match('Tobias', 's-tobias'),
  match('Marta', 's-marta'),
  match('Jonas', 's-jonas'),
  match('Ines', 's-ines'),
];

interface Call {
  method: string;
  data: any;
}

function makeTools(
  opts: { pong?: any; pongThrows?: boolean; result?: any; resultThrows?: string } = {}
) {
  const calls: Call[] = [];
  const query = vi.fn(async (method: string, data: any) => {
    calls.push({ method, data });
    if (method === 'foundry-mcp-bridge.ping') {
      if (opts.pongThrows) throw new Error('no module connected');
      return opts.pong ?? CAPABLE_PONG;
    }
    if (method === 'foundry-mcp-bridge.findActorsByFlag') {
      if (opts.resultThrows) throw new Error(opts.resultThrows);
      return opts.result ?? { matches: FIVE, total: FIVE.length };
    }
    throw new Error(`unexpected query ${method}`);
  });
  const logger: any = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  logger.child = () => logger;
  const tools = new WoDFindActorsTools({ foundryClient: { query } as any, logger });
  const methods = () => calls.map(c => c.method.replace('foundry-mcp-bridge.', ''));
  const lookup = () => calls.find(c => c.method === 'foundry-mcp-bridge.findActorsByFlag');
  return { tools, calls, methods, lookup };
}

// ─── Scenario: external ids map to Foundry actor ids ─────────────────────────

describe('mapping external ids to Foundry ids', () => {
  it('returns the actor id for each of five matches and reports the sixth as unmatched', async () => {
    const { tools } = makeTools();

    const res: any = await tools.handleFindActors({ values: BERLIN });

    expect(res.success).toBe(true);
    expect(res.total).toBe(5);
    expect(res.matches.map((m: any) => m.id)).toEqual([
      'Lena000000000000',
      'Tobias0000000000',
      'Marta00000000000',
      'Jonas00000000000',
      'Ines000000000000',
    ]);
    // Reported, not omitted: omission would be indistinguishable from a shorter
    // request, so the caller could not tell what it asked about.
    expect(res.unmatched).toEqual(['s-never-imported']);
    expect(res.requested).toBe(6);
  });

  it('defaults the flag path to the key the importer stamps', async () => {
    const { tools, lookup } = makeTools();

    await tools.handleFindActors({ values: ['s-lena'] });

    expect(lookup()!.data).toEqual({ flagPath: 'wodchar.sourceId', values: ['s-lena'] });
  });

  it('keeps unmatched in the order the caller asked, not the order actors happen to sit in', async () => {
    const { tools } = makeTools({ result: { matches: [match('Marta', 's-marta')], total: 1 } });

    const res: any = await tools.handleFindActors({ values: ['s-z', 's-marta', 's-a'] });

    expect(res.unmatched).toEqual(['s-z', 's-a']);
  });

  it('reports nothing as unmatched when every id resolved', async () => {
    const { tools } = makeTools();

    const res: any = await tools.handleFindActors({ values: BERLIN.slice(0, 5) });

    expect(res.unmatched).toEqual([]);
    expect(res.duplicates).toEqual([]);
  });

  it('carries the portrait path and folder per match', async () => {
    const { tools } = makeTools();

    const res: any = await tools.handleFindActors({ values: ['s-lena'] });

    expect(res.matches[0].img).toBe('wod20-portraits/lena.webp');
    expect(res.matches[0].folder).toBe('Berlin Students');
  });
});

// ─── A duplicated source id is a failure the caller must see ─────────────────

describe('duplicates', () => {
  it('lists a source id held by more than one actor', async () => {
    const { tools } = makeTools({
      result: {
        matches: [match('Lena', 's-lena'), match('Lena Copy', 's-lena'), match('Ines', 's-ines')],
        total: 3,
      },
    });

    const res: any = await tools.handleFindActors({ values: ['s-lena', 's-ines'] });

    expect(res.duplicates).toEqual(['s-lena']);
    expect(res.total).toBe(3);
    expect(res.unmatched).toEqual([]);
  });
});

// ─── exists mode ─────────────────────────────────────────────────────────────

describe('exists mode', () => {
  it('lists every actor carrying the flag and reports no unmatched', async () => {
    const { tools, lookup } = makeTools();

    const res: any = await tools.handleFindActors({ exists: true });

    expect(lookup()!.data).toEqual({ flagPath: 'wodchar.sourceId', exists: true });
    expect(res.total).toBe(5);
    expect(res.unmatched).toEqual([]);
  });

  it('passes an actor-type filter through', async () => {
    const { tools, lookup } = makeTools();

    await tools.handleFindActors({ exists: true, type: 'PC' });

    expect(lookup()!.data).toMatchObject({ type: 'PC' });
  });
});

// ─── Schema ──────────────────────────────────────────────────────────────────

describe('schema', () => {
  it('requires exactly one of values / exists', async () => {
    const { tools } = makeTools();

    const neither: any = await tools.handleFindActors({});
    const both: any = await tools.handleFindActors({ values: ['s-lena'], exists: true });

    expect(neither.success).toBe(false);
    expect(neither.error).toMatch(/exactly one of/i);
    expect(both.success).toBe(false);
    expect(both.error).toMatch(/exactly one of/i);
  });

  it('rejects a flag path that is not a 2-4 segment scope.key path', async () => {
    const { tools, methods } = makeTools();

    for (const bad of ['wodchar', 'a.b.c.d.e', '__proto__', 'items[0].id', 'wodchar.source id']) {
      const res: any = await tools.handleFindActors({ flagPath: bad, exists: true });
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/Invalid arguments/);
    }
    // Nothing was ever sent to Foundry.
    expect(methods()).toEqual([]);
  });

  it('accepts a non-default flag path so the tool is not hardcoded to one scope', async () => {
    const { tools, lookup } = makeTools();

    await tools.handleFindActors({ flagPath: 'wod20-combat.sourceId', exists: true });

    expect(lookup()!.data.flagPath).toBe('wod20-combat.sourceId');
  });

  it('rejects unknown keys and an oversized value list', async () => {
    const { tools } = makeTools();

    const unknown: any = await tools.handleFindActors({ exists: true, sourceIds: ['x'] });
    const tooMany: any = await tools.handleFindActors({
      values: Array.from({ length: 101 }, (_, i) => `s-${i}`),
    });

    expect(unknown.success).toBe(false);
    expect(tooMany.success).toBe(false);
  });
});

// ─── Server/module skew ──────────────────────────────────────────────────────

describe('skew against an older module', () => {
  it('refuses with an actionable message naming the two deploys', async () => {
    const { tools, methods } = makeTools({ pong: OLD_PONG });

    const res: any = await tools.handleFindActors({ values: ['s-lena'] });

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/findActorsByFlag/);
    expect(res.error).toMatch(/0\.9\.2/);
    expect(res.error).toMatch(/reload the world as GM/);
    expect(methods()).toEqual(['ping']);
  });

  it('refuses when capabilities cannot be confirmed at all', async () => {
    const { tools } = makeTools({ pongThrows: true });

    const res: any = await tools.handleFindActors({ values: ['s-lena'] });

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/could not confirm module capabilities/);
  });

  it('surfaces a bridge error rather than reporting every id as unmatched', async () => {
    const { tools } = makeTools({ resultThrows: 'Query timeout: findActorsByFlag' });

    const res: any = await tools.handleFindActors({ values: BERLIN });

    // "not found" and "could not look up" are different claims.
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Query timeout/);
    expect(res.unmatched).toBeUndefined();
  });

  it('surfaces an Access denied envelope from a non-GM session', async () => {
    const { tools } = makeTools({ result: { success: false, error: 'Access denied' } });

    const res: any = await tools.handleFindActors({ values: ['s-lena'] });

    expect(res).toEqual({ success: false, error: 'Access denied' });
  });
});

// ─── Tool surface ────────────────────────────────────────────────────────────

describe('tool definition', () => {
  it('names itself, documents unmatched, and is read-only', () => {
    const { tools } = makeTools();

    const def: any = tools.getToolDefinitions()[0];

    expect(def.name).toBe('worldofdarkness-find-actors');
    expect(def.description).toMatch(/READ-ONLY/);
    expect(def.description).toMatch(/unmatched/);
    expect(Object.keys(def.inputSchema.properties).sort()).toEqual([
      'exists',
      'flagPath',
      'type',
      'values',
    ]);
  });
});
