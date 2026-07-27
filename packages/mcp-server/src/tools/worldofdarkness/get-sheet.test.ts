/**
 * `worldofdarkness-get-sheet` — the MODIFIED *Full-sheet inspection* requirement.
 *
 * The Foundry side is stubbed, so these assert exactly what the server sends over
 * the bridge (which queries, with which payload) and how it shapes what comes
 * back. Two things are load-bearing here:
 *
 *   - every field the tool returned BEFORE this change is still returned, with
 *     the same name and meaning (additive-only);
 *   - a sheet read alone is enough to verify an import end to end — portrait,
 *     token art and provenance — with no scene token and no write.
 */

import { describe, it, expect, vi } from 'vitest';
import { WoDGetSheetTools } from './get-sheet.js';

const CAPABLE_PONG = {
  status: 'ok',
  moduleVersion: '0.9.3',
  capabilities: [
    'importActors.perActorResults',
    'importActors.dryRun',
    'importActors.stopOnError',
    'getCharacterInfo.include',
    'findActorsByFlag',
  ],
};

/** A module from before the read path shipped: no `getCharacterInfo.include`. */
const OLD_PONG = {
  status: 'ok',
  moduleVersion: '0.9.2',
  capabilities: ['importActors.perActorResults', 'importActors.dryRun'],
};

interface Call {
  method: string;
  data: any;
}

/** A WoD PC payload in the shape `getCharacterInfo` returns. */
function actorPayload(extra: Record<string, any> = {}) {
  return {
    id: 'Lena000000000000',
    name: 'Lena',
    type: 'PC',
    img: 'wod20-portraits/lena.webp',
    system: {
      settings: { splat: 'mortal', game: 'mortal', haswillpower: true },
      attributes: {
        strength: { value: 2, type: 'physical' },
        intelligence: { value: 3, type: 'mental' },
      },
      health: { damage: { bashing: 1, lethal: 0, aggravated: 0 } },
      bio: { nature: 'Survivor', demeanor: 'Bravo', concept: 'Student' },
    },
    items: [
      {
        id: 'item000000000001',
        name: 'Brawl',
        type: 'Ability',
        system: { type: 'wod.abilities.talent', value: 3 },
      },
      {
        id: 'item000000000002',
        name: 'Willpower',
        type: 'Advantage',
        system: { id: 'willpower', permanent: 5, temporary: 4 },
      },
    ],
    effects: [],
    ...extra,
  };
}

function makeTools(opts: { pong?: any; pongThrows?: boolean; actor?: any; found?: any } = {}) {
  const calls: Call[] = [];
  const query = vi.fn(async (method: string, data: any) => {
    calls.push({ method, data });
    if (method === 'foundry-mcp-bridge.ping') {
      if (opts.pongThrows) throw new Error('no module connected');
      return opts.pong ?? CAPABLE_PONG;
    }
    if (method === 'foundry-mcp-bridge.findActor') {
      return opts.found !== undefined ? opts.found : { id: 'Lena000000000000', name: 'Lena' };
    }
    if (method === 'foundry-mcp-bridge.getCharacterInfo') {
      return opts.actor ?? actorPayload();
    }
    throw new Error(`unexpected query ${method}`);
  });
  const logger: any = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  logger.child = () => logger;
  const tools = new WoDGetSheetTools({ foundryClient: { query } as any, logger });
  const methods = () => calls.map(c => c.method.replace('foundry-mcp-bridge.', ''));
  const infoCall = () => calls.find(c => c.method === 'foundry-mcp-bridge.getCharacterInfo');
  return { tools, calls, methods, infoCall };
}

// ─── Scenario: Auditing a PC sheet (unchanged behaviour) ──────────────────────

describe('the pre-existing sheet is unchanged', () => {
  it('still returns attributes, abilities, willpower, health, bio, capabilities and allItems', async () => {
    const { tools } = makeTools();

    const res: any = await tools.handleGetSheet({ actor: 'Lena' });

    expect(res.success).toBe(true);
    expect(res.sheet.name).toBe('Lena');
    expect(res.sheet.attributes.physical.strength).toBe(2);
    expect(res.sheet.attributes.mental.intelligence).toBe(3);
    expect(res.sheet.abilities.talents.Brawl).toBe(3);
    expect(res.sheet.willpower).toEqual({ permanent: 5, temporary: 4 });
    expect(res.sheet.health.damage.bashing).toBe(1);
    expect(res.sheet.bio.concept).toBe('Student');
    expect(res.sheet.capabilities).toEqual({ haswillpower: true });
    expect(res.sheet.allItems.Ability[0].name).toBe('Brawl');
  });

  it('sends no `include` on the wire and does not ping when nothing extra is asked for', async () => {
    const { tools, methods, infoCall } = makeTools();

    await tools.handleGetSheet({ actor: 'Lena' });

    expect(methods()).toEqual(['findActor', 'getCharacterInfo']);
    expect(infoCall()!.data).toEqual({ characterId: 'Lena000000000000' });
  });

  it('omits flags and prototypeToken unless the module actually sent them', async () => {
    const { tools } = makeTools();

    const res: any = await tools.handleGetSheet({ actor: 'Lena' });

    // Never defaulted to {} — an empty object would be indistinguishable from
    // "this actor has no provenance", which is a different and false claim.
    expect('flags' in res.sheet).toBe(false);
    expect('prototypeToken' in res.sheet).toBe(false);
  });

  it('does not modify the actor: every query it issues is a read', async () => {
    const { tools, methods } = makeTools();

    await tools.handleGetSheet({ actor: 'Lena', include: ['flags', 'prototypeToken', 'itemIds'] });

    expect(methods()).toEqual(['ping', 'findActor', 'getCharacterInfo']);
  });
});

// ─── Requirement: actor art paths SHALL be readable ───────────────────────────

describe('art paths', () => {
  it('returns the real portrait path and the actor id', async () => {
    const { tools } = makeTools();

    const res: any = await tools.handleGetSheet({ actor: 'Lena' });

    expect(res.sheet.img).toBe('wod20-portraits/lena.webp');
    expect(res.sheet.isDefaultImg).toBe(false);
    expect(res.sheet.id).toBe('Lena000000000000');
  });

  it('distinguishes a real portrait from the mystery-man placeholder', async () => {
    const placeholder = makeTools({ actor: actorPayload({ img: 'icons/svg/mystery-man.svg' }) });
    const real = makeTools();

    const a: any = await placeholder.tools.handleGetSheet({ actor: 'Lena' });
    const b: any = await real.tools.handleGetSheet({ actor: 'Lena' });

    // Both have a truthy `img`, so the legacy `hasImage` boolean was true for
    // BOTH — this is the distinction it could never make.
    expect(a.sheet.img).toBe('icons/svg/mystery-man.svg');
    expect(a.sheet.isDefaultImg).toBe(true);
    expect(b.sheet.isDefaultImg).toBe(false);
  });

  it('reports isDefaultImg for an actor with no img at all', async () => {
    const payload = actorPayload();
    delete (payload as any).img;
    const { tools } = makeTools({ actor: payload });

    const res: any = await tools.handleGetSheet({ actor: 'Lena' });

    expect('img' in res.sheet).toBe(false);
    expect(res.sheet.isDefaultImg).toBe(true);
  });

  it('returns the prototype-token texture on request, with no scene-token lookup', async () => {
    const { tools, methods, infoCall } = makeTools({
      actor: actorPayload({
        prototypeToken: { name: 'Lena', texture: { src: 'wod20-tokens/lena.webp', scaleX: 1 } },
        included: ['prototypeToken'],
      }),
    });

    const res: any = await tools.handleGetSheet({ actor: 'Lena', include: ['prototypeToken'] });

    expect(res.sheet.prototypeToken.texture.src).toBe('wod20-tokens/lena.webp');
    expect(infoCall()!.data.include).toEqual(['prototypeToken']);
    // getTokenDetails — the old route to a token path — is never involved, so
    // this works for an actor with no token placed on any scene.
    expect(methods()).not.toContain('getTokenDetails');
  });
});

// ─── Requirement: provenance flags SHALL be readable on request ───────────────

describe('flags on request', () => {
  it('surfaces the external source id without any write', async () => {
    const { tools, methods } = makeTools({
      actor: actorPayload({
        flags: { wodchar: { sourceId: 'berlin-lena' } },
        included: ['flags'],
      }),
    });

    const res: any = await tools.handleGetSheet({ actor: 'Lena', include: ['flags'] });

    expect(res.sheet.flags.wodchar.sourceId).toBe('berlin-lena');
    expect(res.include).toEqual(['flags']);
    expect(methods()).toEqual(['ping', 'findActor', 'getCharacterInfo']);
  });
});

// ─── Scenario: verifying an import from the sheet alone ───────────────────────

describe('one sheet read verifies an import end to end', () => {
  it('yields img, prototype-token texture and source id together', async () => {
    const { tools } = makeTools({
      actor: actorPayload({
        prototypeToken: { texture: { src: 'wod20-tokens/lena.webp' } },
        flags: { wodchar: { sourceId: 'berlin-lena' } },
        included: ['flags', 'prototypeToken'],
      }),
    });

    const res: any = await tools.handleGetSheet({
      actor: 'Lena',
      include: ['flags', 'prototypeToken'],
    });

    expect(res.sheet.img).toBe('wod20-portraits/lena.webp');
    expect(res.sheet.prototypeToken.texture.src).toBe('wod20-tokens/lena.webp');
    expect(res.sheet.flags.wodchar.sourceId).toBe('berlin-lena');
    expect(res.warning).toBeUndefined();
  });
});

// ─── itemIds — server-side only, so no module dependency ─────────────────────

describe('include: itemIds', () => {
  it('adds each embedded item id and needs no capability check', async () => {
    const { tools, methods } = makeTools();

    const res: any = await tools.handleGetSheet({ actor: 'Lena', include: ['itemIds'] });

    expect(res.sheet.allItems.Ability[0].id).toBe('item000000000001');
    expect(methods()).toEqual(['findActor', 'getCharacterInfo']);
  });

  it('omits item ids by default', async () => {
    const { tools } = makeTools();

    const res: any = await tools.handleGetSheet({ actor: 'Lena' });

    expect('id' in res.sheet.allItems.Ability[0]).toBe(false);
  });
});

// ─── Server/module skew ──────────────────────────────────────────────────────

describe('skew against an older module', () => {
  it('refuses module-answered include instead of returning a sheet with fields silently missing', async () => {
    const { tools, methods } = makeTools({ pong: OLD_PONG });

    const res: any = await tools.handleGetSheet({ actor: 'Lena', include: ['flags'] });

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/getCharacterInfo\.include/);
    expect(res.error).toMatch(/0\.9\.2/);
    expect(res.error).toMatch(/reload the world as GM/);
    // Nothing was read at all, so no half-answer can be mistaken for a fact.
    expect(methods()).toEqual(['ping']);
  });

  it('refuses when the module capabilities cannot be confirmed', async () => {
    const { tools } = makeTools({ pongThrows: true });

    const res: any = await tools.handleGetSheet({ actor: 'Lena', include: ['prototypeToken'] });

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/could not confirm module capabilities/);
  });

  it('warns when a capable module does not echo the include it honoured', async () => {
    const { tools } = makeTools({ actor: actorPayload() }); // no `included`

    const res: any = await tools.handleGetSheet({ actor: 'Lena', include: ['flags'] });

    expect(res.success).toBe(true);
    expect(res.warning).toMatch(/did not confirm include: flags/);
    expect(res.warning).toMatch(/do not read their absence as fact/);
  });

  it('a plain read still works against an older module (no ping, no refusal)', async () => {
    const { tools, methods } = makeTools({ pong: OLD_PONG });

    const res: any = await tools.handleGetSheet({ actor: 'Lena' });

    expect(res.success).toBe(true);
    expect(res.sheet.img).toBe('wod20-portraits/lena.webp');
    expect(methods()).toEqual(['findActor', 'getCharacterInfo']);
  });
});

// ─── Schema ──────────────────────────────────────────────────────────────────

describe('schema', () => {
  it('rejects an unknown include key', async () => {
    const { tools } = makeTools();

    const res: any = await tools.handleGetSheet({ actor: 'Lena', include: ['system'] });

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Invalid arguments/);
  });

  it('is still strict about unknown top-level keys', async () => {
    const { tools } = makeTools();

    const res: any = await tools.handleGetSheet({ actor: 'Lena', includeFlags: true });

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Invalid arguments/);
  });

  it('advertises include in the tool definition', () => {
    const { tools } = makeTools();

    const def: any = tools.getToolDefinitions()[0];

    expect(def.inputSchema.properties.include.items.enum).toEqual([
      'flags',
      'prototypeToken',
      'itemIds',
    ]);
    expect(def.description).toMatch(/isDefaultImg/);
  });

  it('reports a missing actor unchanged', async () => {
    const { tools } = makeTools({ found: null });

    const res: any = await tools.handleGetSheet({ actor: 'Nobody' });

    expect(res).toEqual({ success: false, error: 'Actor not found: Nobody' });
  });
});
