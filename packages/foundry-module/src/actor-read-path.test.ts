/**
 * The MODULE half of the WoD actor READ path:
 *   - `FoundryDataAccess.getCharacterInfo(identifier, { include })` — art +
 *     provenance on request
 *   - `FoundryDataAccess.findActorsByFlag(...)`  — reverse lookup by source id
 *
 * Same approach as `import-actors.test.ts`: the REAL implementation is driven
 * against a minimal fake Foundry world installed on `globalThis`. That matters
 * here for two guarantees that cannot be tested from the server package at all:
 *
 *   1. the flag is read WITHOUT `actor.getFlag()` — the fake `getFlag` below
 *      throws, exactly as Foundry does for a scope that is not currently active,
 *      so any code path that reaches for it fails the test rather than
 *      production;
 *   2. reading art needs NO token on any scene — the fake world has no scenes at
 *      all, which is the structural version of the assertion.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  installFakeFoundry,
  makeActor,
  makeDataAccess,
  type FakeActor,
  type FakeWorld,
} from './__fixtures__/fake-foundry.js';

// ─── Fake Foundry world ───────────────────────────────────────────────────────
//
// The harness this file used to build inline now lives in
// `__fixtures__/fake-foundry.ts`, shared with `import-actors.test.ts` and the
// mechanics-builder characterization tests. Both load-bearing properties this
// file depends on are preserved there and documented as such: the fake `getFlag`
// THROWS, and there is no `game.scenes` unless a test explicitly asks for one.
// `world.writes` still records every write attempt, so "a read tool writes
// nothing" is asserted exactly as before.

let world: FakeWorld;

function installWorld(actors: FakeActor[] = []): void {
  world = installFakeFoundry({ actors });
}

beforeEach(() => {
  installWorld();
});

// ─── Requirement: actor art paths SHALL be readable ───────────────────────────

describe('getCharacterInfo — art', () => {
  it('always sends the real img path, with no token and no scenes in the world', async () => {
    installWorld([makeActor('Lena', { img: 'wod20-portraits/lena.webp', tokenSrc: null })]);
    const da = await makeDataAccess();

    const info = await da.getCharacterInfo('Lena');

    expect(info.img).toBe('wod20-portraits/lena.webp');
    expect((globalThis as any).game.scenes).toBeUndefined();
    expect(world.writes).toEqual([]);
  });

  it('returns the prototype-token texture source on include, via toObject()', async () => {
    installWorld([makeActor('Lena', { img: 'wod20-portraits/lena.webp' })]);
    const da = await makeDataAccess();

    const info = await da.getCharacterInfo('Lena', { include: ['prototypeToken'] });

    expect(info.prototypeToken.texture.src).toBe('wod20-tokens/Lena.webp');
    expect(info.prototypeToken.texture.scaleX).toBe(1);
    expect(info.prototypeToken.name).toBe('Lena');
    expect(info.included).toEqual(['prototypeToken']);
    expect(world.writes).toEqual([]);
  });

  it('curates the token payload: vision config is not dragged along', async () => {
    installWorld([makeActor('Lena')]);
    const da = await makeDataAccess();

    const info = await da.getCharacterInfo('Lena', { include: ['prototypeToken'] });

    expect(info.prototypeToken.sight).toBeUndefined();
  });

  it('honours the request even for an actor with no prototypeToken at all', async () => {
    installWorld([makeActor('Lena', { tokenSrc: null })]);
    const da = await makeDataAccess();

    const info = await da.getCharacterInfo('Lena', { include: ['prototypeToken'] });

    // "asked and answered: there is none" — not "the module ignored me".
    expect(info.prototypeToken).toBeUndefined();
    expect(info.included).toEqual(['prototypeToken']);
  });
});

// ─── Requirement: actor provenance flags SHALL be readable on request ─────────

describe('getCharacterInfo — flags', () => {
  it('returns the wodchar source id without calling getFlag and without writing', async () => {
    installWorld([
      makeActor('Lena', {
        flags: { wodchar: { sourceId: 'berlin-lena' }, core: { sheetClass: '' } },
      }),
    ]);
    const da = await makeDataAccess();

    const info = await da.getCharacterInfo('Lena', { include: ['flags'] });

    // getFlag() throws in the fake world, so getting here at all proves raw access.
    expect(info.flags.wodchar.sourceId).toBe('berlin-lena');
    expect(info.included).toEqual(['flags']);
    expect(world.writes).toEqual([]);
  });

  it('omits flags entirely when not requested (default response unchanged)', async () => {
    installWorld([makeActor('Lena', { flags: { wodchar: { sourceId: 'berlin-lena' } } })]);
    const da = await makeDataAccess();

    const info = await da.getCharacterInfo('Lena');

    expect('flags' in info).toBe(false);
    expect('prototypeToken' in info).toBe(false);
    expect('included' in info).toBe(false);
  });

  it('an empty include array is treated as no include at all', async () => {
    installWorld([makeActor('Lena', { flags: { wodchar: { sourceId: 'x' } } })]);
    const da = await makeDataAccess();

    const info = await da.getCharacterInfo('Lena', { include: [] });

    expect('flags' in info).toBe(false);
    expect('included' in info).toBe(false);
  });

  it('returns an empty flag object for an actor that genuinely carries none', async () => {
    installWorld([makeActor('Lena', { flags: {} })]);
    const da = await makeDataAccess();

    const info = await da.getCharacterInfo('Lena', { include: ['flags'] });

    expect(info.flags).toEqual({});
    expect(info.included).toEqual(['flags']);
  });

  it('both extras can be requested together', async () => {
    installWorld([makeActor('Lena', { flags: { wodchar: { sourceId: 'berlin-lena' } } })]);
    const da = await makeDataAccess();

    const info = await da.getCharacterInfo('Lena', { include: ['flags', 'prototypeToken'] });

    expect(info.flags.wodchar.sourceId).toBe('berlin-lena');
    expect(info.prototypeToken.texture.src).toBe('wod20-tokens/Lena.webp');
    expect(info.included).toEqual(['flags', 'prototypeToken']);
  });
});

// ─── Requirement: actors SHALL be findable by external source id ──────────────

describe('findActorsByFlag', () => {
  const berlin = () => [
    makeActor('Lena', { flags: { wodchar: { sourceId: 's-1' } }, folder: 'Berlin Students' }),
    makeActor('Tobias', { flags: { wodchar: { sourceId: 's-2' } }, folder: 'Berlin Students' }),
    makeActor('Marta', { flags: { wodchar: { sourceId: 's-3' } }, folder: 'Berlin Students' }),
    makeActor('Jonas', { flags: { wodchar: { sourceId: 's-4' } }, folder: 'Berlin Students' }),
    makeActor('Ines', { flags: { wodchar: { sourceId: 's-5' } }, folder: 'Berlin Students' }),
    makeActor('Nameless', { flags: {} }),
  ];

  it('maps five imported ids to actor ids and does not invent a sixth', async () => {
    installWorld(berlin());
    const da = await makeDataAccess();

    const res = await da.findActorsByFlag({
      flagPath: 'wodchar.sourceId',
      values: ['s-1', 's-2', 's-3', 's-4', 's-5', 's-nope'],
    });

    expect(res.total).toBe(5);
    expect(res.matches.map((m: any) => m.flagValue).sort()).toEqual([
      's-1',
      's-2',
      's-3',
      's-4',
      's-5',
    ]);
    expect(res.matches[0].id).toBe('Lena000000000000');
    expect(res.matches[0].folder).toBe('Berlin Students');
    expect(world.writes).toEqual([]);
  });

  it('reads the flag without getFlag (the fake getFlag throws)', async () => {
    installWorld(berlin());
    const da = await makeDataAccess();

    await expect(
      da.findActorsByFlag({ flagPath: 'wodchar.sourceId', values: ['s-1'] })
    ).resolves.toMatchObject({ total: 1 });
  });

  it('reports both actors when one source id is duplicated', async () => {
    installWorld([
      makeActor('Lena', { flags: { wodchar: { sourceId: 'dup' } } }),
      makeActor('Lena Copy', { flags: { wodchar: { sourceId: 'dup' } } }),
    ]);
    const da = await makeDataAccess();

    const res = await da.findActorsByFlag({ flagPath: 'wodchar.sourceId', values: ['dup'] });

    // Never collapsed to find()'s first hit: a duplicate makes one of the two
    // permanently unreachable by import, which the caller has to be able to see.
    expect(res.total).toBe(2);
    expect(res.matches.map((m: any) => m.name)).toEqual(['Lena', 'Lena Copy']);
  });

  it('exists: true lists every actor carrying the flag regardless of value', async () => {
    installWorld(berlin());
    const da = await makeDataAccess();

    const res = await da.findActorsByFlag({ flagPath: 'wodchar.sourceId', exists: true });

    expect(res.total).toBe(5);
  });

  it('filters by actor type', async () => {
    installWorld([
      makeActor('Lena', { flags: { wodchar: { sourceId: 's-1' } }, type: 'PC' }),
      makeActor('Ghoul', { flags: { wodchar: { sourceId: 's-2' } }, type: 'Creature' }),
    ]);
    const da = await makeDataAccess();

    const res = await da.findActorsByFlag({
      flagPath: 'wodchar.sourceId',
      exists: true,
      type: 'Creature',
    });

    expect(res.matches.map((m: any) => m.name)).toEqual(['Ghoul']);
  });

  it('carries the portrait path so a match is verifiable without a second read', async () => {
    installWorld([
      makeActor('Lena', {
        flags: { wodchar: { sourceId: 's-1' } },
        img: 'wod20-portraits/lena.webp',
      }),
    ]);
    const da = await makeDataAccess();

    const res = await da.findActorsByFlag({ flagPath: 'wodchar.sourceId', values: ['s-1'] });

    expect(res.matches[0].img).toBe('wod20-portraits/lena.webp');
  });

  it('rejects a flagPath that is not a 2-4 segment scope.key path', async () => {
    installWorld(berlin());
    const da = await makeDataAccess();

    for (const bad of [
      'wodchar',
      'a.b.c.d.e',
      '__proto__',
      'wodchar.source id',
      'items[0].x',
      '',
    ]) {
      await expect(da.findActorsByFlag({ flagPath: bad, exists: true })).rejects.toThrow(
        /flagPath/
      );
    }
  });

  it('requires exactly one of values / exists', async () => {
    installWorld(berlin());
    const da = await makeDataAccess();

    await expect(da.findActorsByFlag({ flagPath: 'wodchar.sourceId' })).rejects.toThrow(
      /values|exists/
    );
    await expect(da.findActorsByFlag({ flagPath: 'wodchar.sourceId', values: [] })).rejects.toThrow(
      /values|exists/
    );
  });
});
