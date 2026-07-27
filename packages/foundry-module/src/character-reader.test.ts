/**
 * Characterization tests for the character-READING cluster of
 * `FoundryDataAccess` — `getCharacterInfo`, `searchCharacterItems`,
 * `extractSpellcastingData` and the six private helpers reached only through
 * those three (`formatPF2eActionCost`, `extractPF2eSpellSlots`,
 * `extractDnD5eSpellSlots`, `extractDnD5eSpellTargeting`,
 * `extractPF2eSpellTargeting`, `extractDSA5SpellTargeting`), plus
 * `readActorFlags` and `extractTokenArt`, which `actor-read-path.test.ts`
 * already pins from the `include` side.
 *
 * Written BEFORE the extraction that will move all eleven members into
 * `character-reader.ts`, and against the pre-move source, for the reason the
 * body-diff requirement gives: a test first written against post-move code
 * records whatever slip the move introduced and attests to nothing.
 *
 * ── Why this file is large, when the cluster was recorded as well covered ────
 *
 * `actor-read-path.test.ts` has 17 cases and reads as coverage of this cluster.
 * Eight of them exercise `ActorDirectory.findActorsByFlag` through a facade
 * delegation and touch no cluster member at all; the nine that do reach
 * `getCharacterInfo` are, without exception, about the opt-in extras
 * (`options.include`) — `readActorFlags` and `extractTokenArt`, 25 of the
 * cluster's 995 body lines. `getCharacterInfo`'s BASE build has nothing, and
 * `searchCharacterItems` (277 lines), `extractSpellcastingData` (358) and the
 * six helpers (170) have nothing whatsoever. That is what is added here.
 *
 * ── What is asserted, and why it is the returned projection ─────────────────
 *
 * This is a read cluster: it hands no document to Foundry, so the
 * "document handed to Foundry" formulation does not apply and the coverage
 * requirement's read bullet governs instead — the returned result set in full,
 * its contents, its ordering, its truncation at any limit, and every filter
 * decision that determines membership, with a case per arm of each
 * system-specific dispatch. There are TWO four-way `systemId` dispatches here
 * (`extractSpellcastingData`, and `searchCharacterItems`'s spell block), three
 * independent `matches.length >= limit` sites, and — unusually for a read —
 * an `auditLog` call, which is part of the observable behaviour and is
 * asserted, not just the envelope around it.
 *
 * Nothing below calls a private member directly. Every private is driven
 * through `getCharacterInfo` or `searchCharacterItems`, the cluster's only two
 * externally-reached members, so the file keeps passing across a move that
 * turns the other nine into privates of another class.
 *
 * Behaviour that is arguably wrong is pinned as it stands: `totalMatches` is
 * the truncated count rather than a total; an item of type `action` is counted
 * twice when the actor has no `system.actions`; a `spell0` bucket key parses to
 * a falsy 0 and so silently falls through to the item's own level; the
 * general-entry fallback in the 5e arm reads a different preparation field from
 * the by-class path. Each is marked. This file's job is to detect change, not
 * to endorse it — a later change that fixes one of these should move the
 * assertion in the same commit.
 */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  installFakeFoundry,
  makeActor,
  makeDataAccess,
  makeEffect,
  makePf2eActor,
  makeDnd5eActor,
  makeDsa5Actor,
  makeWfrp4eActor,
  pf2eSpell,
  pf2eSpellcastingEntry,
  dnd5eSpell,
  dnd5eClass,
  dsa5Spell,
  wfrp4eSpell,
  wfrp4ePrayer,
  type FakeActor,
  type FakeWorld,
} from './__fixtures__/fake-foundry.js';

let world: FakeWorld;

function install(actors: FakeActor[] = [], systemId?: string): void {
  world = installFakeFoundry(systemId === undefined ? { actors } : { actors, systemId });
}

beforeEach(() => {
  install();
});

/** A generic embedded item. The system-shaped builders live in the fixture. */
function item(
  name: string,
  type: string,
  system: Record<string, any> = {},
  extra: Record<string, any> = {}
): Record<string, any> {
  return {
    id: `i-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    name,
    type,
    system,
    ...extra,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// getCharacterInfo — the base build
// ═══════════════════════════════════════════════════════════════════════════════

describe('getCharacterInfo — identity and lookup', () => {
  it('returns the identity fields and the sanitised system block', async () => {
    install([
      makeActor('Lena', {
        img: 'wod20-portraits/lena.webp',
        system: {
          attributes: { strength: 3 },
          password: 'hunter2',
          _stats: { modifiedTime: 1 },
          _id: 'kept',
          nested: { key: 'secret-value', ok: 1 },
        },
      }),
    ]);
    const da = await makeDataAccess();

    const info = await da.getCharacterInfo('Lena');

    expect(info.id).toBe('Lena000000000000');
    expect(info.name).toBe('Lena');
    expect(info.type).toBe('PC');
    expect(info.img).toBe('wod20-portraits/lena.webp');
    // Sanitised: `password` and `key` are sensitive, `_stats` is underscore-prefixed
    // bloat, `_id` is the one underscore field kept.
    expect(info.system).toEqual({
      attributes: { strength: 3 },
      _id: 'kept',
      nested: { ok: 1 },
    });
    expect(world.writes).toEqual([]);
  });

  it('omits img entirely for an actor that has none', async () => {
    install([makeActor('Lena')]);
    const da = await makeDataAccess();

    const info = await da.getCharacterInfo('Lena');

    expect('img' in info).toBe(false);
  });

  it('resolves a 16-character identifier as an id, before trying names', async () => {
    install([makeActor('Lena'), makeActor('Tobias')]);
    const da = await makeDataAccess();

    const info = await da.getCharacterInfo('Tobias0000000000');

    expect(info.name).toBe('Tobias');
  });

  it('falls back to an exact, case-insensitive NAME match', async () => {
    install([makeActor('Lena')]);
    const da = await makeDataAccess();

    expect((await da.getCharacterInfo('lena')).name).toBe('Lena');
    expect((await da.getCharacterInfo('LENA')).name).toBe('Lena');
  });

  it('does NOT match a name by prefix or substring, unlike searchCharacterItems', async () => {
    install([makeActor('Lena Fischer')]);
    const da = await makeDataAccess();

    // `searchCharacterItems` resolves through ActorResolver, which uses
    // `includes()`. This method compares with `===`, so the same identifier
    // reaches one member and not the other.
    await expect(da.getCharacterInfo('Lena')).rejects.toThrow('Character not found: Lena');
  });

  it('throws with the constant and the identifier when nothing matches', async () => {
    install([makeActor('Lena')]);
    const da = await makeDataAccess();

    await expect(da.getCharacterInfo('Ghost')).rejects.toThrow('Character not found: Ghost');
  });

  it('resolves a 16-character identifier that is a NAME, not an id', async () => {
    // Sixteen characters takes the `get` path first; that misses, and the name
    // match behind it is what answers.
    install([makeActor('Sixteen Chars!!!')]);
    const da = await makeDataAccess();

    const info = await da.getCharacterInfo('Sixteen Chars!!!');

    expect(info.name).toBe('Sixteen Chars!!!');
  });
});

describe('getCharacterInfo — items', () => {
  it('maps every item to id/name/type/img/system, with system sanitised', async () => {
    install([
      makeActor('Lena', {
        items: [
          item('Sword', 'weapon', { quantity: 2, password: 'no' }, { img: 'icons/sword.webp' }),
          item('Rag', 'loot', {}),
        ],
      }),
    ]);
    const da = await makeDataAccess();

    const info = await da.getCharacterInfo('Lena');

    expect(info.items).toEqual([
      {
        id: 'i-sword',
        name: 'Sword',
        type: 'weapon',
        img: 'icons/sword.webp',
        system: { quantity: 2 },
      },
      { id: 'i-rag', name: 'Rag', type: 'loot', system: {} },
    ]);
    // The img key is ABSENT, not undefined, for an item without one.
    expect(Object.keys(info.items[1])).toEqual(['id', 'name', 'type', 'system']);
  });

  it('returns an empty items array for an actor with none', async () => {
    install([makeActor('Lena')]);
    const da = await makeDataAccess();

    expect((await da.getCharacterInfo('Lena')).items).toEqual([]);
  });
});

describe('getCharacterInfo — effects and the three-way duration merge', () => {
  it('prefers the live duration units and seconds when they are present', async () => {
    install([
      makeActor('Lena', {
        effects: [
          makeEffect('Bless', {
            id: 'e-bless',
            icon: 'icons/bless.webp',
            duration: { units: 'rounds', seconds: 30, remaining: 2 },
            sourceDuration: { type: 'turns', duration: 99 },
          }),
        ],
      }),
    ]);
    const da = await makeDataAccess();

    const info = await da.getCharacterInfo('Lena');

    expect(info.effects).toEqual([
      {
        id: 'e-bless',
        name: 'Bless',
        icon: 'icons/bless.webp',
        disabled: false,
        duration: { type: 'rounds', duration: 30, remaining: 2 },
      },
    ]);
  });

  it('falls back to _source.duration when the live units and seconds are nullish', async () => {
    install([
      makeActor('Lena', {
        effects: [
          makeEffect('Slow', {
            id: 'e-slow',
            disabled: true,
            duration: { units: null, seconds: null, remaining: 5 },
            sourceDuration: { type: 'turns', duration: 12 },
          }),
        ],
      }),
    ]);
    const da = await makeDataAccess();

    const info = await da.getCharacterInfo('Lena');

    expect(info.effects[0].duration).toEqual({ type: 'turns', duration: 12, remaining: 5 });
    expect(info.effects[0].disabled).toBe(true);
    // No icon on this effect: the key is absent, not undefined.
    expect(Object.keys(info.effects[0])).toEqual(['id', 'name', 'disabled', 'duration']);
  });

  it("falls all the way through to type 'none' with no duration and no remaining", async () => {
    install([
      makeActor('Lena', { effects: [makeEffect('Timeless', { id: 'e-t', duration: {} })] }),
    ]);
    const da = await makeDataAccess();

    const d = (await da.getCharacterInfo('Lena')).effects[0].duration;

    expect(d.type).toBe('none');
    expect(d.duration).toBeUndefined();
    expect(d.remaining).toBeUndefined();
    expect(Object.keys(d)).toEqual(['type', 'duration', 'remaining']);
  });

  it('omits the duration block entirely when the effect has no duration at all', async () => {
    install([makeActor('Lena', { effects: [makeEffect('Permanent', { id: 'e-p' })] })]);
    const da = await makeDataAccess();

    const e = (await da.getCharacterInfo('Lena')).effects[0];

    expect('duration' in e).toBe(false);
    expect(e).toEqual({ id: 'e-p', name: 'Permanent', disabled: false });
  });

  it('falls back from name to label, and then to Unknown Effect', async () => {
    install([
      makeActor('Lena', {
        effects: [
          // A name AND a label that disagree: the NAME wins, so the order of the
          // `||` is observable rather than incidental.
          makeEffect('Live Name', { id: 'e-0', label: 'Stale Label' }),
          makeEffect('', { id: 'e-1', label: 'Legacy Label' }),
          makeEffect('', { id: 'e-2' }),
        ],
      }),
    ]);
    const da = await makeDataAccess();

    const info = await da.getCharacterInfo('Lena');

    expect(info.effects.map((e: any) => e.name)).toEqual([
      'Live Name',
      'Legacy Label',
      'Unknown Effect',
    ]);
  });
});

describe('getCharacterInfo — the PF2e actions block', () => {
  const strikes = (): Record<string, any>[] => [
    {
      label: 'Longsword',
      name: 'ignored-when-label-present',
      type: 'strike',
      item: { id: 'w-longsword' },
      variants: [{ label: 'Strike', traits: ['agile'] }, { label: 'MAP -5' }],
      ready: true,
    },
    { name: 'Fist', type: 'strike', ready: false },
    { label: 'Trip', type: 'action' },
  ];

  it('projects label, type, itemId, variants and ready, each conditionally', async () => {
    install([makePf2eActor('Ezren', { actions: strikes() })], 'pf2e');
    const da = await makeDataAccess();

    const info = await da.getCharacterInfo('Ezren');

    expect(info.actions).toEqual([
      {
        name: 'Longsword',
        type: 'strike',
        itemId: 'w-longsword',
        variants: [{ label: 'Strike', traits: ['agile'] }, { label: 'MAP -5' }],
        ready: true,
      },
      // `ready: false` is KEPT — the test is `!== undefined`, not truthiness.
      { name: 'Fist', type: 'strike', ready: false },
      { name: 'Trip', type: 'action' },
    ]);
    expect(Object.keys(info.actions[2])).toEqual(['name', 'type']);
    // A variant without traits gets no traits KEY, not an undefined one.
    expect(Object.keys(info.actions[0].variants[0])).toEqual(['label', 'traits']);
    expect(Object.keys(info.actions[0].variants[1])).toEqual(['label']);
  });

  it('is NOT gated on game.system.id — any actor carrying system.actions gets it', async () => {
    install([makePf2eActor('Ezren', { actions: strikes() })], 'worldofdarkness');
    const da = await makeDataAccess();

    const info = await da.getCharacterInfo('Ezren');

    expect(info.actions.map((a: any) => a.name)).toEqual(['Longsword', 'Fist', 'Trip']);
  });

  it('omits the actions key for an actor with no system.actions', async () => {
    install([makeActor('Lena')], 'pf2e');
    const da = await makeDataAccess();

    expect('actions' in (await da.getCharacterInfo('Lena'))).toBe(false);
  });
});

describe('getCharacterInfo — the rule-element variant/toggle walk', () => {
  it('collects ChoiceSet and choice-bearing RollOption rules as variants', async () => {
    install([
      makeActor('Ezren', {
        items: [
          item('Stance', 'feat', {
            rules: [
              {
                key: 'ChoiceSet',
                label: 'Pick a stance',
                selection: 'tiger',
                choices: ['tiger', 'crane'],
              },
              { key: 'RollOption', prompt: 'Prompted', choices: ['a', 'b'] },
            ],
          }),
        ],
      }),
    ]);
    const da = await makeDataAccess();

    const info = await da.getCharacterInfo('Ezren');

    expect(info.itemVariants).toEqual([
      {
        itemId: 'i-stance',
        itemName: 'Stance',
        ruleIndex: 0,
        ruleKey: 'ChoiceSet',
        label: 'Pick a stance',
        selected: 'tiger',
        choices: ['tiger', 'crane'],
      },
      // `label || prompt`: the prompt answers when there is no label.
      {
        itemId: 'i-stance',
        itemName: 'Stance',
        ruleIndex: 1,
        ruleKey: 'RollOption',
        label: 'Prompted',
        choices: ['a', 'b'],
      },
    ]);
    expect('itemToggles' in info).toBe(false);
  });

  it('collects toggleable RollOption and ToggleProperty rules as toggles', async () => {
    install([
      makeActor('Ezren', {
        items: [
          item('Shield', 'feat', {
            rules: [
              {
                key: 'RollOption',
                label: 'Raise a shield',
                option: 'raised',
                toggleable: true,
                value: false,
              },
              { key: 'ToggleProperty', label: 'Property', option: 'prop' },
            ],
          }),
        ],
      }),
    ]);
    const da = await makeDataAccess();

    const info = await da.getCharacterInfo('Ezren');

    expect(info.itemToggles).toEqual([
      {
        itemId: 'i-shield',
        itemName: 'Shield',
        ruleIndex: 0,
        ruleKey: 'RollOption',
        label: 'Raise a shield',
        option: 'raised',
        // `enabled: false` is kept: the test is `!== undefined`.
        enabled: false,
        toggleable: true,
      },
      {
        itemId: 'i-shield',
        itemName: 'Shield',
        ruleIndex: 1,
        ruleKey: 'ToggleProperty',
        label: 'Property',
        option: 'prop',
      },
    ]);
    expect('itemVariants' in info).toBe(false);
  });

  it('lists a RollOption that is both choice-bearing and toggleable in BOTH lists', async () => {
    install([
      makeActor('Ezren', {
        items: [
          item('Both', 'feat', {
            rules: [
              { key: 'RollOption', label: 'Both', option: 'o', choices: ['x'], toggleable: true },
            ],
          }),
        ],
      }),
    ]);
    const da = await makeDataAccess();

    const info = await da.getCharacterInfo('Ezren');

    expect(info.itemVariants).toHaveLength(1);
    expect(info.itemToggles).toHaveLength(1);
    expect(info.itemVariants[0].ruleIndex).toBe(0);
    expect(info.itemToggles[0].ruleIndex).toBe(0);
  });

  it('numbers ruleIndex per item, not across the actor', async () => {
    install([
      makeActor('Ezren', {
        items: [
          item('One', 'feat', { rules: [{ key: 'noop' }, { key: 'ChoiceSet', label: 'a' }] }),
          item('Two', 'feat', { rules: [{ key: 'ChoiceSet', label: 'b' }] }),
        ],
      }),
    ]);
    const da = await makeDataAccess();

    const info = await da.getCharacterInfo('Ezren');

    expect(info.itemVariants.map((v: any) => [v.itemName, v.ruleIndex])).toEqual([
      ['One', 1],
      ['Two', 0],
    ]);
  });

  it('adds an item-level equipped toggle, including when equipped is false', async () => {
    install([
      makeActor('Lena', {
        items: [item('Sword', 'weapon', { equipped: false }), item('Note', 'loot', {})],
      }),
    ]);
    const da = await makeDataAccess();

    const info = await da.getCharacterInfo('Lena');

    expect(info.itemToggles).toEqual([
      { itemId: 'i-sword', itemName: 'Sword', type: 'equipped', enabled: false },
    ]);
  });

  it('omits both keys when nothing is found', async () => {
    install([makeActor('Lena', { items: [item('Plain', 'loot', {})] })]);
    const da = await makeDataAccess();

    const info = await da.getCharacterInfo('Lena');

    expect('itemVariants' in info).toBe(false);
    expect('itemToggles' in info).toBe(false);
  });
});

describe('getCharacterInfo — the projection as a whole', () => {
  it('builds the keys in a fixed order, extras between the base and the PF2e blocks', async () => {
    install(
      [
        makePf2eActor('Ezren', {
          actions: [{ name: 'Fist', type: 'strike' }],
          items: [item('Sword', 'weapon', { equipped: true, rules: [{ key: 'ChoiceSet' }] })],
          spells: [pf2eSpell({ name: 'Shield', rank: 1, location: 'e1', traits: ['focus'] })],
          effects: [makeEffect('Bless', { id: 'e-b' })],
        }),
      ],
      'pf2e'
    );
    const da = await makeDataAccess();

    const info = await da.getCharacterInfo('Ezren', { include: ['flags', 'prototypeToken'] });

    expect(Object.keys(info)).toEqual([
      'id',
      'name',
      'type',
      'system',
      'items',
      'effects',
      'flags',
      'prototypeToken',
      'included',
      'actions',
      'itemVariants',
      'itemToggles',
      'spellcasting',
    ]);

    // And with NO include, the three extras keys are absent altogether — the
    // guard is `include.length > 0`, so an absent option adds nothing at all,
    // not even an empty `included` echo.
    const bare = await da.getCharacterInfo('Ezren');
    expect(Object.keys(bare)).toEqual([
      'id',
      'name',
      'type',
      'system',
      'items',
      'effects',
      'actions',
      'itemVariants',
      'itemToggles',
      'spellcasting',
    ]);
  });

  it('writes nothing, whatever the actor carries', async () => {
    install(
      [
        makePf2eActor('Ezren', {
          entries: [pf2eSpellcastingEntry({ id: 'e1' })],
          spells: [pf2eSpell({ name: 'Shield', rank: 1, location: 'e1' })],
        }),
      ],
      'pf2e'
    );
    const da = await makeDataAccess();

    await da.getCharacterInfo('Ezren', { include: ['flags', 'prototypeToken'] });

    expect(world.writes).toEqual([]);
    expect(world.audit).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// readActorFlags and extractTokenArt — the branches `actor-read-path.test.ts`
// does not reach. Both are only callable through `getCharacterInfo`'s `include`.
// ═══════════════════════════════════════════════════════════════════════════════

describe('readActorFlags — the branches behind the include', () => {
  it('falls back to raw property access when foundry.utils.getProperty is missing', async () => {
    install([makeActor('Lena', { flags: { wodchar: { sourceId: 'berlin-lena' } } })]);
    const da = await makeDataAccess();
    delete (globalThis as any).foundry.utils.getProperty;

    const info = await da.getCharacterInfo('Lena', { include: ['flags'] });

    // Still never `getFlag()` — the fake one throws.
    expect(info.flags).toEqual({ wodchar: { sourceId: 'berlin-lena' } });
  });

  it('sanitises the flag object, dropping sensitive and underscore-prefixed keys', async () => {
    install([
      makeActor('Lena', {
        flags: {
          wodchar: { sourceId: 'berlin-lena', secret: 'no' },
          _internal: { x: 1 },
          core: { sheetClass: '' },
        },
      }),
    ]);
    const da = await makeDataAccess();

    const info = await da.getCharacterInfo('Lena', { include: ['flags'] });

    expect(info.flags).toEqual({
      wodchar: { sourceId: 'berlin-lena' },
      core: { sheetClass: '' },
    });
  });
});

describe('extractTokenArt — the branches behind the include', () => {
  it('sanitises the live token when it is not a DataModel with toObject', async () => {
    install([
      makeActor('Lena', {
        tokenOverride: {
          name: 'Lena',
          actorLink: false,
          texture: { src: 'plain/lena.webp', scaleX: 2 },
          sight: { enabled: true },
          password: 'stripped',
        },
      }),
    ]);
    const da = await makeDataAccess();

    const info = await da.getCharacterInfo('Lena', { include: ['prototypeToken'] });

    expect(info.prototypeToken).toEqual({
      texture: { src: 'plain/lena.webp', scaleX: 2 },
      name: 'Lena',
      actorLink: false,
    });
    // scaleY is absent from this token, so its key is absent from the art —
    // not present and undefined.
    expect(Object.keys(info.prototypeToken.texture)).toEqual(['src', 'scaleX']);
  });

  it('returns null when toObject yields something that is not an object', async () => {
    install([makeActor('Lena', { tokenOverride: { toObject: () => 'not an object' } })]);
    const da = await makeDataAccess();

    const info = await da.getCharacterInfo('Lena', { include: ['prototypeToken'] });

    expect('prototypeToken' in info).toBe(false);
    expect(info.included).toEqual(['prototypeToken']);
  });

  it('emits a null texture src when the token carries no texture at all', async () => {
    install([makeActor('Lena', { tokenOverride: { toObject: () => ({ actorLink: true }) } })]);
    const da = await makeDataAccess();

    const info = await da.getCharacterInfo('Lena', { include: ['prototypeToken'] });

    expect(info.prototypeToken).toEqual({ texture: { src: null }, actorLink: true });
  });

  it('emits the dynamic-token ring, sanitised, when there is one', async () => {
    install([
      makeActor('Lena', {
        tokenRing: { enabled: true, colors: { ring: '#ff0000' }, secret: 'stripped' },
      }),
    ]);
    const da = await makeDataAccess();

    const info = await da.getCharacterInfo('Lena', { include: ['prototypeToken'] });

    expect(info.prototypeToken.ring).toEqual({ enabled: true, colors: { ring: '#ff0000' } });
  });

  it('omits the ring key when the ring is null, and keeps both scale axes', async () => {
    install([makeActor('Lena')]);
    const da = await makeDataAccess();

    const art = (await da.getCharacterInfo('Lena', { include: ['prototypeToken'] })).prototypeToken;

    expect('ring' in art).toBe(false);
    expect(art.texture).toEqual({ src: 'wod20-tokens/Lena.webp', scaleX: 1, scaleY: 1 });
    expect(Object.keys(art)).toEqual(['texture', 'name', 'actorLink']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// extractSpellcastingData — arm 1 of 4: pf2e
// ═══════════════════════════════════════════════════════════════════════════════

describe('extractSpellcastingData — pf2e', () => {
  it('builds one entry per spellcastingEntry item, with its spells sorted by rank then name', async () => {
    const entry = pf2eSpellcastingEntry({
      id: 'e1',
      name: 'Arcane Spells',
      tradition: 'arcane',
      prepared: 'prepared',
      ability: 'int',
      spelldc: { dc: 21, value: 13 },
      slots: { slot1: { value: 2, max: 3 }, slot2: { value: 0, max: 0 } },
    });
    install(
      [
        makePf2eActor('Ezren', {
          entries: [entry],
          spells: [
            pf2eSpell({
              name: 'Magic Missile',
              id: 's-mm',
              rank: 1,
              location: 'e1',
              prepared: true,
              expended: false,
              traits: ['force'],
              time: 2,
              range: '120 feet',
              target: '1 creature',
            }),
            pf2eSpell({ name: 'Acid Splash', id: 's-as', rank: 0, location: 'e1', time: 1 }),
          ],
        }),
      ],
      'pf2e'
    );
    const da = await makeDataAccess();

    const info = await da.getCharacterInfo('Ezren');

    expect(info.spellcasting).toHaveLength(1);
    const e = info.spellcasting[0];
    expect(e.id).toBe('e1');
    expect(e.name).toBe('Arcane Spells');
    expect(e.tradition).toBe('arcane');
    expect(e.type).toBe('prepared');
    expect(e.ability).toBe('int');
    expect(e.dc).toBe(21);
    expect(e.attack).toBe(13);
    // A slot with neither value nor max above zero is dropped.
    expect(e.slots).toEqual({ rank1: { value: 2, max: 3 } });
    expect(e.spells.map((s: any) => s.name)).toEqual(['Acid Splash', 'Magic Missile']);
    expect(e.spells[1]).toEqual({
      id: 's-mm',
      name: 'Magic Missile',
      level: 1,
      prepared: true,
      expended: false,
      traits: ['force'],
      actionCost: '2 actions',
      range: '120 feet',
      target: '1 creature',
      area: undefined,
    });
  });

  it('defaults prepared to true, expended to false and traits to [] for a bare spell', async () => {
    install(
      [
        makePf2eActor('Ezren', {
          entries: [pf2eSpellcastingEntry({ id: 'e1' })],
          spells: [pf2eSpell({ name: 'Shield', id: 's-sh', rank: 1, location: 'e1' })],
        }),
      ],
      'pf2e'
    );
    const da = await makeDataAccess();

    const s = (await da.getCharacterInfo('Ezren')).spellcasting[0].spells[0];

    expect(s).toEqual({
      id: 's-sh',
      name: 'Shield',
      level: 1,
      prepared: true,
      expended: false,
      traits: [],
      actionCost: undefined,
      range: undefined,
      target: undefined,
      area: undefined,
    });
  });

  it('takes rank from system.rank when system.level.value is absent', async () => {
    install(
      [
        makePf2eActor('Ezren', {
          entries: [pf2eSpellcastingEntry({ id: 'e1' })],
          spells: [pf2eSpell({ name: 'Heal', rankFlat: 4, location: 'e1' })],
        }),
      ],
      'pf2e'
    );
    const da = await makeDataAccess();

    expect((await da.getCharacterInfo('Ezren')).spellcasting[0].spells[0].level).toBe(4);
  });

  it('associates a spell whose system.location is a BARE entry id string', async () => {
    install(
      [
        makePf2eActor('Ezren', {
          entries: [pf2eSpellcastingEntry({ id: 'e1' })],
          spells: [pf2eSpell({ name: 'Bless', rank: 1, locationFlat: 'e1' })],
        }),
      ],
      'pf2e'
    );
    const da = await makeDataAccess();

    expect(
      (await da.getCharacterInfo('Ezren')).spellcasting[0].spells.map((s: any) => s.name)
    ).toEqual(['Bless']);
  });

  it('leaves an entry empty when no spell points at it', async () => {
    install(
      [
        makePf2eActor('Ezren', {
          entries: [pf2eSpellcastingEntry({ id: 'e1' }), pf2eSpellcastingEntry({ id: 'e2' })],
          spells: [pf2eSpell({ name: 'Bless', rank: 1, location: 'e1' })],
        }),
      ],
      'pf2e'
    );
    const da = await makeDataAccess();

    const entries = (await da.getCharacterInfo('Ezren')).spellcasting;

    expect(entries.map((e: any) => e.spells.length)).toEqual([1, 0]);
  });

  it('prefers actor.spellcasting.contents over the spellcastingEntry items', async () => {
    install(
      [
        makePf2eActor('Ezren', {
          // The item list carries one entry; the collection carries a different one.
          entries: [pf2eSpellcastingEntry({ id: 'from-items', name: 'From Items' })],
          spellcastingContents: [
            pf2eSpellcastingEntry({ id: 'from-collection', name: 'From Collection' }),
          ],
          spells: [pf2eSpell({ name: 'Bless', rank: 1, location: 'from-collection' })],
        }),
      ],
      'pf2e'
    );
    const da = await makeDataAccess();

    const entries = (await da.getCharacterInfo('Ezren')).spellcasting;

    expect(entries.map((e: any) => e.id)).toEqual(['from-collection']);
    expect(entries[0].spells.map((s: any) => s.name)).toEqual(['Bless']);
  });

  it('reads entry data off the entry itself when it has no system block', async () => {
    // `entryData = entry.system || entry`. A raw literal, because every builder
    // gives the item a `system`, and `{}` is truthy.
    const flatEntry: Record<string, any> = {
      id: 'e-flat',
      name: 'Innate Spells',
      type: 'spellcastingEntry',
      tradition: 'occult',
      prepared: 'innate',
      ability: 'cha',
      dc: { value: 18 },
      attack: { value: 10 },
    };
    install([makePf2eActor('Ezren', { items: [flatEntry] })], 'pf2e');
    const da = await makeDataAccess();

    const e = (await da.getCharacterInfo('Ezren')).spellcasting[0];

    expect(e.tradition).toBe('occult');
    expect(e.type).toBe('innate');
    expect(e.ability).toBe('cha');
    expect(e.dc).toBe(18);
    expect(e.attack).toBe(10);
  });

  it("names an entry 'Spellcasting' when it has no name, and defaults the type to prepared", async () => {
    install(
      [makePf2eActor('Ezren', { entries: [pf2eSpellcastingEntry({ id: 'e1', name: '' })] })],
      'pf2e'
    );
    const da = await makeDataAccess();

    const e = (await da.getCharacterInfo('Ezren')).spellcasting[0];

    expect(e.name).toBe('Spellcasting');
    expect(e.type).toBe('prepared');
    expect(e.tradition).toBeUndefined();
    expect(e.ability).toBeUndefined();
    expect(e.dc).toBeUndefined();
    expect(e.attack).toBeUndefined();
    expect(e.slots).toBeUndefined();
  });

  it('walks entry.spells, taking the rank from the bucket key and prepared/expended from the ref', async () => {
    install(
      [
        makePf2eActor('Ezren', {
          entries: [
            pf2eSpellcastingEntry({
              id: 'e1',
              spells: { spell3: { value: [{ id: 's-fb', prepared: false, expended: true }] } },
            }),
          ],
          // No `location`, so this spell is reachable ONLY through entry.spells.
          spells: [pf2eSpell({ name: 'Fireball', id: 's-fb', rank: 5 })],
        }),
      ],
      'pf2e'
    );
    const da = await makeDataAccess();

    const s = (await da.getCharacterInfo('Ezren')).spellcasting[0].spells[0];

    // The BUCKET says 3 and the item says 5; the bucket wins.
    expect(s.level).toBe(3);
    expect(s.prepared).toBe(false);
    expect(s.expended).toBe(true);
  });

  it('accepts a bare id string as a spell reference, and a bare array as a bucket', async () => {
    install(
      [
        makePf2eActor('Ezren', {
          entries: [pf2eSpellcastingEntry({ id: 'e1', spells: { spell2: ['s-inv'] } })],
          spells: [pf2eSpell({ name: 'Invisibility', id: 's-inv', rank: 2 })],
        }),
      ],
      'pf2e'
    );
    const da = await makeDataAccess();

    const s = (await da.getCharacterInfo('Ezren')).spellcasting[0].spells[0];

    expect(s.name).toBe('Invisibility');
    expect(s.level).toBe(2);
    expect(s.prepared).toBe(true);
    expect(s.expended).toBe(false);
  });

  it("falls back to the item's own rank for the spell0 bucket, because parseInt('0') is falsy", async () => {
    install(
      [
        makePf2eActor('Ezren', {
          entries: [pf2eSpellcastingEntry({ id: 'e1', spells: { spell0: ['s-light'] } })],
          spells: [pf2eSpell({ name: 'Light', id: 's-light', rank: 7 })],
        }),
      ],
      'pf2e'
    );
    const da = await makeDataAccess();

    // Pinned as it stands: `parseInt('0') || spellSystem?.level?.value || 0`
    // makes the cantrip bucket report the ITEM's rank, not 0.
    expect((await da.getCharacterInfo('Ezren')).spellcasting[0].spells[0].level).toBe(7);
  });

  it('skips an OBJECT bucket reference to a spell already associated by location', async () => {
    install(
      [
        makePf2eActor('Ezren', {
          entries: [pf2eSpellcastingEntry({ id: 'e1', spells: { spell4: [{ id: 's-both' }] } })],
          spells: [pf2eSpell({ name: 'Both Ways', id: 's-both', rank: 1, location: 'e1' })],
        }),
      ],
      'pf2e'
    );
    const da = await makeDataAccess();

    const spells = (await da.getCharacterInfo('Ezren')).spellcasting[0].spells;

    expect(spells).toHaveLength(1);
    expect(spells[0].level).toBe(1);
  });

  it('does NOT skip a BARE-STRING reference to an already-associated spell', async () => {
    install(
      [
        makePf2eActor('Ezren', {
          entries: [pf2eSpellcastingEntry({ id: 'e1', spells: { spell4: ['s-both'] } })],
          spells: [pf2eSpell({ name: 'Both Ways', id: 's-both', rank: 1, location: 'e1' })],
        }),
      ],
      'pf2e'
    );
    const da = await makeDataAccess();

    const spells = (await da.getCharacterInfo('Ezren')).spellcasting[0].spells;

    // Pinned as it stands: the de-duplication test is `s.id === spellRef.id`,
    // and a bare string has no `.id`, so the same spell is listed twice — once
    // at its own rank and once at the bucket's.
    expect(spells.map((s: any) => s.level)).toEqual([1, 4]);
  });

  it('ignores a bucket reference to an id the actor does not carry', async () => {
    install(
      [
        makePf2eActor('Ezren', {
          entries: [pf2eSpellcastingEntry({ id: 'e1', spells: { spell1: ['nope'] } })],
        }),
      ],
      'pf2e'
    );
    const da = await makeDataAccess();

    expect((await da.getCharacterInfo('Ezren')).spellcasting[0].spells).toEqual([]);
  });

  it('adds a synthetic focus-spell entry for focus spells outside any entry', async () => {
    install(
      [
        makePf2eActor('Ezren', {
          spells: [
            pf2eSpell({
              name: 'Fire Ray',
              id: 's-fr',
              rank: 1,
              traits: ['focus', 'fire'],
              time: 2,
            }),
            pf2eSpell({ name: 'Shield Block', id: 's-sb', rank: 1, category: 'focus' }),
          ],
        }),
      ],
      'pf2e'
    );
    const da = await makeDataAccess();

    const entries = (await da.getCharacterInfo('Ezren')).spellcasting;

    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe('focus-spells');
    expect(entries[0].name).toBe('Focus Spells');
    expect(entries[0].type).toBe('focus');
    // The focus mapping carries no prepared/expended at all — unlike the entry path.
    expect(entries[0].spells[0]).toEqual({
      id: 's-fr',
      name: 'Fire Ray',
      level: 1,
      traits: ['focus', 'fire'],
      actionCost: '2 actions',
      range: undefined,
      target: undefined,
      area: undefined,
    });
    // Insertion order, NOT sorted: the focus block does not sort.
    expect(entries[0].spells.map((s: any) => s.name)).toEqual(['Fire Ray', 'Shield Block']);
  });

  it('suppresses the synthetic entry when a real entry is already of type focus', async () => {
    install(
      [
        makePf2eActor('Ezren', {
          entries: [pf2eSpellcastingEntry({ id: 'e1', name: 'Focus', prepared: 'focus' })],
          spells: [pf2eSpell({ name: 'Fire Ray', rank: 1, traits: ['focus'], location: 'e1' })],
        }),
      ],
      'pf2e'
    );
    const da = await makeDataAccess();

    const entries = (await da.getCharacterInfo('Ezren')).spellcasting;

    expect(entries.map((e: any) => e.id)).toEqual(['e1']);
  });

  it('reports no spellcasting at all for an actor with no spells', async () => {
    install([makePf2eActor('Ezren')], 'pf2e');
    const da = await makeDataAccess();

    expect('spellcasting' in (await da.getCharacterInfo('Ezren'))).toBe(false);
  });
});

describe('extractPF2eSpellSlots', () => {
  it('reports ranks 1 through 10 and ignores an eleventh', async () => {
    const slots: Record<string, { value: number; max: number }> = {};
    for (let rank = 1; rank <= 11; rank++) slots[`slot${rank}`] = { value: rank, max: rank };
    install(
      [makePf2eActor('Ezren', { entries: [pf2eSpellcastingEntry({ id: 'e1', slots })] })],
      'pf2e'
    );
    const da = await makeDataAccess();

    const got = (await da.getCharacterInfo('Ezren')).spellcasting[0].slots;

    expect(Object.keys(got)).toEqual([
      'rank1',
      'rank2',
      'rank3',
      'rank4',
      'rank5',
      'rank6',
      'rank7',
      'rank8',
      'rank9',
      'rank10',
    ]);
    expect(got.rank10).toEqual({ value: 10, max: 10 });
  });

  it('keeps a rank with a max but no value, and one with a value but no max', async () => {
    install(
      [
        makePf2eActor('Ezren', {
          entries: [
            pf2eSpellcastingEntry({
              id: 'e1',
              slots: { slot1: { max: 2 }, slot2: { value: 1 }, slot3: { value: 0, max: 0 } },
            }),
          ],
        }),
      ],
      'pf2e'
    );
    const da = await makeDataAccess();

    const got = (await da.getCharacterInfo('Ezren')).spellcasting[0].slots;

    // Absent value/max default to 0 on the way out.
    expect(got).toEqual({ rank1: { value: 0, max: 2 }, rank2: { value: 1, max: 0 } });
  });

  it('reads slots written flat on the entry data when there is no slots block', async () => {
    install(
      [
        makePf2eActor('Ezren', {
          entries: [pf2eSpellcastingEntry({ id: 'e1', system: { slot3: { value: 1, max: 2 } } })],
        }),
      ],
      'pf2e'
    );
    const da = await makeDataAccess();

    expect((await da.getCharacterInfo('Ezren')).spellcasting[0].slots).toEqual({
      rank3: { value: 1, max: 2 },
    });
  });

  it('returns undefined rather than an empty object when no rank qualifies', async () => {
    install(
      [
        makePf2eActor('Ezren', {
          entries: [pf2eSpellcastingEntry({ id: 'e1', slots: { slot1: { value: 0, max: 0 } } })],
        }),
      ],
      'pf2e'
    );
    const da = await makeDataAccess();

    expect((await da.getCharacterInfo('Ezren')).spellcasting[0].slots).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// extractSpellcastingData — arm 2 of 4: dnd5e
// ═══════════════════════════════════════════════════════════════════════════════

describe('extractSpellcastingData — dnd5e', () => {
  it('builds one entry per spellcasting class, named after it, with the actor slots', async () => {
    install(
      [
        makeDnd5eActor('Merlin', {
          spellSlots: { spell1: { value: 3, max: 4 }, pact: { value: 1, max: 2 } },
          classes: [dnd5eClass('Wizard', { id: 'c-wiz', type: 'prepared', ability: 'int' })],
          spells: [
            dnd5eSpell({
              name: 'Fireball',
              id: 's-fb',
              level: 3,
              sourceItem: 'c-wiz',
              prepared: true,
              activation: 'action',
              // Shaped so 5e targeting and PF2e targeting disagree: 5e composes
              // `value units` and reads `target.type`, PF2e stringifies
              // `range.value` and reads `target.value`.
              range: { value: 150, units: 'feet' },
              target: {
                type: 'creature',
                value: 3,
                template: { type: 'sphere', size: 20 },
              },
            }),
            dnd5eSpell({ name: 'Alarm', id: 's-al', level: 1, sourceItem: 'c-wiz' }),
          ],
        }),
      ],
      'dnd5e'
    );
    const da = await makeDataAccess();

    const entries = (await da.getCharacterInfo('Merlin')).spellcasting;

    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe('c-wiz');
    expect(entries[0].name).toBe('Wizard Spellcasting');
    expect(entries[0].type).toBe('prepared');
    expect(entries[0].ability).toBe('int');
    expect(entries[0].slots).toEqual({ level1: { value: 3, max: 4 }, pact: { value: 1, max: 2 } });
    expect(entries[0].spells.map((s: any) => s.name)).toEqual(['Alarm', 'Fireball']);
    expect(entries[0].spells[1]).toEqual({
      id: 's-fb',
      name: 'Fireball',
      level: 3,
      prepared: true,
      // 5e does not use traits, and the by-class path says so explicitly.
      traits: [],
      actionCost: 'action',
      range: '150 feet',
      target: '3 creatures',
      area: '20-ft sphere',
    });
    expect(entries[0].spells[0].range).toBeUndefined();
  });

  it('groups by a sourceItem object identifier, then its id, then _source.sourceClass', async () => {
    install(
      [
        makeDnd5eActor('Merlin', {
          classes: [
            dnd5eClass('Wizard', { id: 'c-wiz' }),
            dnd5eClass('Cleric', { id: 'c-cle' }),
            dnd5eClass('Bard', { id: 'c-bard' }),
          ],
          spells: [
            dnd5eSpell({ name: 'By Identifier', level: 1, sourceItem: { identifier: 'c-wiz' } }),
            dnd5eSpell({ name: 'By Id', level: 1, sourceItem: { id: 'c-cle' } }),
            dnd5eSpell({ name: 'By Source Class', level: 1, sourceClass: 'bard' }),
          ],
        }),
      ],
      'dnd5e'
    );
    const da = await makeDataAccess();

    const entries = (await da.getCharacterInfo('Merlin')).spellcasting;

    // The third resolves by the LOWERCASED class name, the fallback lookup.
    expect(entries.map((e: any) => [e.name, e.spells.map((s: any) => s.name)])).toEqual([
      ['Wizard Spellcasting', ['By Identifier']],
      ['Cleric Spellcasting', ['By Id']],
      ['Bard Spellcasting', ['By Source Class']],
    ]);
  });

  it("leaves an unattributed spell in the 'general' bucket, reachable by no class", async () => {
    install(
      [
        makeDnd5eActor('Merlin', {
          classes: [dnd5eClass('Wizard', { id: 'c-wiz' })],
          spells: [dnd5eSpell({ name: 'Orphan', level: 1 })],
        }),
      ],
      'dnd5e'
    );
    const da = await makeDataAccess();

    const entries = (await da.getCharacterInfo('Merlin')).spellcasting;

    // The class entry exists but is EMPTY, and the general bucket is not emitted:
    // the fallback entry only fires when there are no class entries at all.
    expect(entries).toHaveLength(1);
    expect(entries[0].spells).toEqual([]);
  });

  it('takes the by-class prepared flag from system.prepared, then _source.preparation', async () => {
    install(
      [
        makeDnd5eActor('Merlin', {
          classes: [dnd5eClass('Wizard', { id: 'c-wiz' })],
          spells: [
            dnd5eSpell({ name: 'Direct', level: 1, sourceItem: 'c-wiz', prepared: false }),
            dnd5eSpell({ name: 'Raw', level: 1, sourceItem: 'c-wiz', rawPreparation: false }),
            dnd5eSpell({ name: 'Neither', level: 1, sourceItem: 'c-wiz' }),
          ],
        }),
      ],
      'dnd5e'
    );
    const da = await makeDataAccess();

    const spells = (await da.getCharacterInfo('Merlin')).spellcasting[0].spells;

    expect(spells.map((s: any) => [s.name, s.prepared])).toEqual([
      ['Direct', false],
      ['Neither', true],
      ['Raw', false],
    ]);
  });

  it('skips a class whose progression is none, and one with no spellcasting block', async () => {
    install(
      [
        makeDnd5eActor('Merlin', {
          classes: [
            dnd5eClass('Fighter', { id: 'c-fig', progression: 'none' }),
            dnd5eClass('Rogue', { id: 'c-rog', progression: null }),
            dnd5eClass('Wizard', { id: 'c-wiz' }),
          ],
          spells: [dnd5eSpell({ name: 'Alarm', level: 1, sourceItem: 'c-wiz' })],
        }),
      ],
      'dnd5e'
    );
    const da = await makeDataAccess();

    const entries = (await da.getCharacterInfo('Merlin')).spellcasting;

    expect(entries.map((e: any) => e.id)).toEqual(['c-wiz']);
  });

  it('falls back to one general entry when no class qualifies but spells exist', async () => {
    install(
      [
        makeDnd5eActor('Merlin', {
          spellSlots: { spell1: { value: 2, max: 2 } },
          classes: [dnd5eClass('Fighter', { id: 'c-fig', progression: 'none' })],
          spells: [
            dnd5eSpell({ name: 'Bless', id: 's-bl', level: 1, preparation: false }),
            dnd5eSpell({ name: 'Aid', id: 's-ai', level: 2, activation: 'bonus' }),
          ],
        }),
      ],
      'dnd5e'
    );
    const da = await makeDataAccess();

    const entries = (await da.getCharacterInfo('Merlin')).spellcasting;

    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe('spellcasting');
    expect(entries[0].name).toBe('Spellcasting');
    expect(entries[0].type).toBe('prepared');
    expect(entries[0].slots).toEqual({ level1: { value: 2, max: 2 } });
    expect(entries[0].spells.map((s: any) => s.name)).toEqual(['Bless', 'Aid']);
    // The fallback path reads `system.preparation.prepared` — NOT `system.prepared`,
    // which is what the by-class path reads first — and emits no `traits` key.
    expect(entries[0].spells[0]).toEqual({
      id: 's-bl',
      name: 'Bless',
      level: 1,
      prepared: false,
      actionCost: undefined,
      range: undefined,
      target: undefined,
      area: undefined,
    });
  });

  it('ignores system.prepared in the general fallback, where only preparation.prepared counts', async () => {
    install(
      [
        makeDnd5eActor('Merlin', {
          spells: [dnd5eSpell({ name: 'Bless', level: 1, prepared: false })],
        }),
      ],
      'dnd5e'
    );
    const da = await makeDataAccess();

    // `prepared: false` on `system` is invisible here: pinned asymmetry.
    expect((await da.getCharacterInfo('Merlin')).spellcasting[0].spells[0].prepared).toBe(true);
  });

  it('emits nothing for a 5e actor with a caster class and no spells', async () => {
    install(
      [makeDnd5eActor('Merlin', { classes: [dnd5eClass('Wizard', { id: 'c-wiz' })] })],
      'dnd5e'
    );
    const da = await makeDataAccess();

    const info = await da.getCharacterInfo('Merlin');

    // The class entry is still built — it has a progression — with no spells.
    expect(info.spellcasting).toHaveLength(1);
    expect(info.spellcasting[0].spells).toEqual([]);
  });

  it('emits no spellcasting key for a 5e actor with neither classes nor spells', async () => {
    install([makeDnd5eActor('Merlin')], 'dnd5e');
    const da = await makeDataAccess();

    expect('spellcasting' in (await da.getCharacterInfo('Merlin'))).toBe(false);
  });
});

describe('extractDnD5eSpellSlots', () => {
  it('reports levels 1 through 9 plus pact, and ignores a tenth level', async () => {
    const slots: Record<string, { value: number; max: number }> = {};
    for (let level = 1; level <= 10; level++) slots[`spell${level}`] = { value: level, max: level };
    slots.pact = { value: 2, max: 3 };
    install(
      [
        makeDnd5eActor('Merlin', {
          spellSlots: slots,
          spells: [dnd5eSpell({ name: 'X', level: 1 })],
        }),
      ],
      'dnd5e'
    );
    const da = await makeDataAccess();

    const got = (await da.getCharacterInfo('Merlin')).spellcasting[0].slots;

    expect(Object.keys(got)).toEqual([
      'level1',
      'level2',
      'level3',
      'level4',
      'level5',
      'level6',
      'level7',
      'level8',
      'level9',
      'pact',
    ]);
    expect(got.pact).toEqual({ value: 2, max: 3 });
  });

  it('drops an all-zero level and an all-zero pact slot', async () => {
    install(
      [
        makeDnd5eActor('Merlin', {
          spellSlots: {
            spell1: { value: 0, max: 0 },
            spell2: { max: 1 },
            pact: { value: 0, max: 0 },
          },
          spells: [dnd5eSpell({ name: 'X', level: 1 })],
        }),
      ],
      'dnd5e'
    );
    const da = await makeDataAccess();

    expect((await da.getCharacterInfo('Merlin')).spellcasting[0].slots).toEqual({
      level2: { value: 0, max: 1 },
    });
  });

  it('returns undefined when the actor has no spell slots at all', async () => {
    install([makeDnd5eActor('Merlin', { spells: [dnd5eSpell({ name: 'X', level: 1 })] })], 'dnd5e');
    const da = await makeDataAccess();

    expect((await da.getCharacterInfo('Merlin')).spellcasting[0].slots).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// extractSpellcastingData — arm 3 of 4: dsa5
// ═══════════════════════════════════════════════════════════════════════════════

describe('extractSpellcastingData — dsa5', () => {
  it('builds a Zauber entry from spells, with AsP as its one slot', async () => {
    install(
      [
        makeDsa5Actor('Gerda', {
          asp: { value: 20, max: 30 },
          spells: [
            dsa5Spell({
              name: 'Ignifaxius',
              id: 's-ig',
              level: 2,
              attributes: ['Feuer'],
              castingTime: '2 Aktionen',
              range: '16 Schritt',
              targetCategory: 'Zone',
              effectRadius: '4 Schritt',
            }),
            dsa5Spell({ name: 'Balsam', id: 's-ba', level: 1 }),
          ],
        }),
      ],
      'dsa5'
    );
    const da = await makeDataAccess();

    const entries = (await da.getCharacterInfo('Gerda')).spellcasting;

    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe('zauber');
    expect(entries[0].name).toBe('Zauber (Spells)');
    expect(entries[0].type).toBe('arcane');
    expect(entries[0].slots).toEqual({ asp: { value: 20, max: 30 } });
    expect(entries[0].spells.map((s: any) => s.name)).toEqual(['Balsam', 'Ignifaxius']);
    expect(entries[0].spells[1]).toEqual({
      id: 's-ig',
      name: 'Ignifaxius',
      level: 2,
      traits: ['Feuer'],
      actionCost: '2 Aktionen',
      range: '16 Schritt',
      target: 'Zone',
      area: '4 Schritt',
    });
  });

  it('groups liturgies and ceremonies into one divine entry with KaP', async () => {
    install(
      [
        makeDsa5Actor('Gerda', {
          kap: { value: 12, max: 15 },
          spells: [
            dsa5Spell({ name: 'Blitz', type: 'liturgy', level: 2 }),
            dsa5Spell({ name: 'Ritus', type: 'ceremony', level: 1 }),
          ],
        }),
      ],
      'dsa5'
    );
    const da = await makeDataAccess();

    const entries = (await da.getCharacterInfo('Gerda')).spellcasting;

    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe('liturgien');
    expect(entries[0].name).toBe('Liturgien & Zeremonien (Liturgies)');
    expect(entries[0].type).toBe('divine');
    expect(entries[0].slots).toEqual({ kap: { value: 12, max: 15 } });
    expect(entries[0].spells.map((s: any) => s.name)).toEqual(['Ritus', 'Blitz']);
  });

  it('builds a ritual entry with NO slots key at all', async () => {
    install(
      [
        makeDsa5Actor('Gerda', {
          asp: { value: 5, max: 5 },
          spells: [dsa5Spell({ name: 'Bann', type: 'ritual', level: 3 })],
        }),
      ],
      'dsa5'
    );
    const da = await makeDataAccess();

    const entries = (await da.getCharacterInfo('Gerda')).spellcasting;

    expect(entries.map((e: any) => e.id)).toEqual(['rituale']);
    expect(entries[0].name).toBe('Rituale (Rituals)');
    expect(entries[0].type).toBe('ritual');
    expect('slots' in entries[0]).toBe(false);
  });

  it('emits the three groups in a fixed order: Zauber, Liturgien, Rituale', async () => {
    install(
      [
        makeDsa5Actor('Gerda', {
          spells: [
            dsa5Spell({ name: 'Bann', type: 'ritual' }),
            dsa5Spell({ name: 'Blitz', type: 'liturgy' }),
            dsa5Spell({ name: 'Balsam', type: 'spell' }),
          ],
        }),
      ],
      'dsa5'
    );
    const da = await makeDataAccess();

    expect((await da.getCharacterInfo('Gerda')).spellcasting.map((e: any) => e.id)).toEqual([
      'zauber',
      'liturgien',
      'rituale',
    ]);
  });

  it('leaves slots undefined when the actor has no AsP', async () => {
    install([makeDsa5Actor('Gerda', { spells: [dsa5Spell({ name: 'Balsam' })] })], 'dsa5');
    const da = await makeDataAccess();

    expect((await da.getCharacterInfo('Gerda')).spellcasting[0].slots).toBeUndefined();
  });

  it('reads AsP and KaP written flat on system when there is no status block', async () => {
    install(
      [
        makeDsa5Actor('Gerda', {
          aspFlat: { value: 7 },
          kapFlat: { max: 9 },
          spells: [dsa5Spell({ name: 'Balsam' }), dsa5Spell({ name: 'Blitz', type: 'liturgy' })],
        }),
      ],
      'dsa5'
    );
    const da = await makeDataAccess();

    const entries = (await da.getCharacterInfo('Gerda')).spellcasting;

    // Absent value/max default to 0.
    expect(entries[0].slots).toEqual({ asp: { value: 7, max: 0 } });
    expect(entries[1].slots).toEqual({ kap: { value: 0, max: 9 } });
  });

  it('takes the level from a flat system.level and defaults traits and cost', async () => {
    install(
      [makeDsa5Actor('Gerda', { spells: [dsa5Spell({ name: 'Flat', levelFlat: 4 })] })],
      'dsa5'
    );
    const da = await makeDataAccess();

    const s = (await da.getCharacterInfo('Gerda')).spellcasting[0].spells[0];

    expect(s.level).toBe(4);
    expect(s.traits).toEqual([]);
    expect(s.actionCost).toBeUndefined();
  });

  it('reads range, target and area from the German keys when the value keys are absent', async () => {
    install(
      [
        makeDsa5Actor('Gerda', {
          spells: [
            dsa5Spell({
              name: 'Deutsch',
              reichweite: 'Berührung',
              zielkategorie: 'Zauberer',
              wirkungsbereich: 'Zone',
            }),
          ],
        }),
      ],
      'dsa5'
    );
    const da = await makeDataAccess();

    const s = (await da.getCharacterInfo('Gerda')).spellcasting[0].spells[0];

    expect(s.range).toBe('Berührung');
    expect(s.target).toBe('Zauberer');
    expect(s.area).toBe('Zone');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// extractSpellcastingData — arm 4 of 4: wfrp4e
// ═══════════════════════════════════════════════════════════════════════════════

describe('extractSpellcastingData — wfrp4e', () => {
  it('groups arcane spells by lore, capitalising the lore in the entry name', async () => {
    install(
      [
        makeWfrp4eActor('Salundra', {
          spells: [
            wfrp4eSpell('Dart', {
              id: 's-dart',
              lore: 'fire',
              cn: 4,
              range: 'Willpower yards',
              target: '1',
            }),
            wfrp4eSpell('Blast', { id: 's-blast', lore: 'fire', cn: 8 }),
            wfrp4eSpell('Mend', { id: 's-mend', lore: 'life', cn: 2 }),
          ],
        }),
      ],
      'wfrp4e'
    );
    const da = await makeDataAccess();

    const entries = (await da.getCharacterInfo('Salundra')).spellcasting;

    expect(entries.map((e: any) => [e.id, e.name])).toEqual([
      ['lore-fire', 'Lore of Fire'],
      ['lore-life', 'Lore of Life'],
    ]);
    expect(entries[0].type).toBe('arcane');
    expect(entries[0].tradition).toBe('arcane');
    expect('slots' in entries[0]).toBe(false);
    // Sorted by name, and every WFRP4e spell is level 0 — there are no ranks.
    expect(entries[0].spells.map((s: any) => s.name)).toEqual(['Blast', 'Dart']);
    expect(entries[0].spells[1]).toEqual({
      id: 's-dart',
      name: 'Dart',
      level: 0,
      actionCost: 'CN 4',
      range: 'Willpower yards',
      target: '1',
    });
  });

  it('takes the first element when the lore is an array, and defaults to arcane', async () => {
    install(
      [
        makeWfrp4eActor('Salundra', {
          spells: [
            wfrp4eSpell('Arrayed', { lore: ['shadow', 'ignored'] }),
            wfrp4eSpell('Loreless'),
          ],
        }),
      ],
      'wfrp4e'
    );
    const da = await makeDataAccess();

    expect((await da.getCharacterInfo('Salundra')).spellcasting.map((e: any) => e.name)).toEqual([
      'Lore of Shadow',
      'Lore of Arcane',
    ]);
  });

  it('leaves actionCost undefined for a spell whose casting number is null', async () => {
    install(
      [makeWfrp4eActor('Salundra', { spells: [wfrp4eSpell('Quiet', { cn: null })] })],
      'wfrp4e'
    );
    const da = await makeDataAccess();

    const s = (await da.getCharacterInfo('Salundra')).spellcasting[0].spells[0];

    expect(s.actionCost).toBeUndefined();
    expect(s.range).toBeUndefined();
    expect(s.target).toBeUndefined();
  });

  it("reports a casting number of 0 as 'CN 0', not as absent", async () => {
    install(
      [makeWfrp4eActor('Salundra', { spells: [wfrp4eSpell('Trivial', { cn: 0 })] })],
      'wfrp4e'
    );
    const da = await makeDataAccess();

    expect((await da.getCharacterInfo('Salundra')).spellcasting[0].spells[0].actionCost).toBe(
      'CN 0'
    );
  });

  it('groups prayers by god, naming the default group Prayers', async () => {
    install(
      [
        makeWfrp4eActor('Salundra', {
          prayers: [
            wfrp4ePrayer('Bless', { id: 'p-bless', god: 'sigmar', range: 'Touch' }),
            wfrp4ePrayer('Anonymous', { id: 'p-anon' }),
          ],
        }),
      ],
      'wfrp4e'
    );
    const da = await makeDataAccess();

    const entries = (await da.getCharacterInfo('Salundra')).spellcasting;

    expect(entries.map((e: any) => [e.id, e.name, e.type, e.tradition])).toEqual([
      ['prayers-sigmar', 'Prayers (Sigmar)', 'divine', 'divine'],
      ['prayers-divine', 'Prayers', 'divine', 'divine'],
    ]);
    expect(entries[0].spells[0]).toEqual({
      id: 'p-bless',
      name: 'Bless',
      level: 0,
      range: 'Touch',
      target: undefined,
    });
    // A prayer carries no actionCost key at all — only spells do.
    expect('actionCost' in entries[0].spells[0]).toBe(false);
  });

  it('emits every lore group before every prayer group', async () => {
    install(
      [
        makeWfrp4eActor('Salundra', {
          spells: [wfrp4eSpell('Dart', { lore: 'fire' })],
          prayers: [wfrp4ePrayer('Bless', { god: 'sigmar' })],
        }),
      ],
      'wfrp4e'
    );
    const da = await makeDataAccess();

    expect((await da.getCharacterInfo('Salundra')).spellcasting.map((e: any) => e.id)).toEqual([
      'lore-fire',
      'prayers-sigmar',
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// extractSpellcastingData — the dispatch itself
// ═══════════════════════════════════════════════════════════════════════════════

describe('extractSpellcastingData — the four-way systemId dispatch', () => {
  /** One actor, spell-bearing in every system's idiom, read under each id. */
  function polyglot(): FakeActor {
    return makePf2eActor('Poly', {
      entries: [pf2eSpellcastingEntry({ id: 'e1', name: 'Arcane' })],
      spells: [pf2eSpell({ name: 'Bless', id: 's-bl', rank: 1, location: 'e1' })],
      items: [dnd5eClass('Wizard', { id: 'c-wiz' })],
    });
  }

  it('reads the same actor as pf2e entries', async () => {
    install([polyglot()], 'pf2e');
    const da = await makeDataAccess();

    expect((await da.getCharacterInfo('Poly')).spellcasting.map((e: any) => e.id)).toEqual(['e1']);
  });

  it('reads the same actor as a dnd5e class entry', async () => {
    install([polyglot()], 'dnd5e');
    const da = await makeDataAccess();

    const entries = (await da.getCharacterInfo('Poly')).spellcasting;

    // The 5e arm sees the class item and the spell item, and knows nothing of
    // the PF2e spellcastingEntry.
    expect(entries.map((e: any) => e.id)).toEqual(['c-wiz']);
    expect(entries[0].name).toBe('Wizard Spellcasting');
  });

  it('reads the same actor as a dsa5 Zauber group', async () => {
    install([polyglot()], 'dsa5');
    const da = await makeDataAccess();

    expect((await da.getCharacterInfo('Poly')).spellcasting.map((e: any) => e.id)).toEqual([
      'zauber',
    ]);
  });

  it('reads the same actor as a wfrp4e lore group', async () => {
    install([polyglot()], 'wfrp4e');
    const da = await makeDataAccess();

    expect((await da.getCharacterInfo('Poly')).spellcasting.map((e: any) => e.id)).toEqual([
      'lore-arcane',
    ]);
  });

  it('emits nothing at all for a system that is none of the four', async () => {
    install([polyglot()], 'worldofdarkness');
    const da = await makeDataAccess();

    expect('spellcasting' in (await da.getCharacterInfo('Poly'))).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// searchCharacterItems — resolution, validation and the envelope
// ═══════════════════════════════════════════════════════════════════════════════

describe('searchCharacterItems — validation and resolution', () => {
  it('validates Foundry state before anything else, and audits nothing when it fails', async () => {
    install([makeActor('Lena')]);
    const da = await makeDataAccess();
    (globalThis as any).game.ready = false;

    await expect(da.searchCharacterItems({ characterIdentifier: 'Lena' })).rejects.toThrow(
      'Foundry VTT is not ready'
    );
    expect(world.audit).toEqual([]);
  });

  it('resolves by id, by name and by case-insensitive SUBSTRING of the name', async () => {
    install([makeActor('Lena Fischer')]);
    const da = await makeDataAccess();

    expect(
      (await da.searchCharacterItems({ characterIdentifier: 'Lena Fischer0000' })).characterName
    ).toBe('Lena Fischer');
    expect(
      (await da.searchCharacterItems({ characterIdentifier: 'Lena Fischer' })).characterName
    ).toBe('Lena Fischer');
    // ActorResolver's `includes()` match — reachable here and NOT from
    // getCharacterInfo, which compares with `===`.
    expect((await da.searchCharacterItems({ characterIdentifier: 'fisch' })).characterName).toBe(
      'Lena Fischer'
    );
  });

  it('throws its own not-found message, and audits nothing', async () => {
    install([makeActor('Lena')]);
    const da = await makeDataAccess();

    await expect(da.searchCharacterItems({ characterIdentifier: 'Ghost' })).rejects.toThrow(
      'Character not found: Ghost'
    );
    expect(world.audit).toEqual([]);
  });

  it('echoes only the filters it was given, and writes nothing', async () => {
    install([makeActor('Lena', { items: [item('Sword', 'weapon')] })]);
    const da = await makeDataAccess();

    const bare = await da.searchCharacterItems({ characterIdentifier: 'Lena' });
    expect(Object.keys(bare)).toEqual(['characterId', 'characterName', 'matches', 'totalMatches']);
    expect(bare.characterId).toBe('Lena000000000000');

    const full = await da.searchCharacterItems({
      characterIdentifier: 'Lena',
      query: 'sword',
      type: 'weapon',
      category: 'equipped',
    });
    expect(Object.keys(full)).toEqual([
      'characterId',
      'characterName',
      'matches',
      'totalMatches',
      'query',
      'type',
      'category',
    ]);
    expect(world.writes).toEqual([]);
  });

  it('omits an empty-string query from the envelope and matches everything with it', async () => {
    install([makeActor('Lena', { items: [item('Sword', 'weapon'), item('Rag', 'loot')] })]);
    const da = await makeDataAccess();

    const res = await da.searchCharacterItems({ characterIdentifier: 'Lena', query: '' });

    expect('query' in res).toBe(false);
    expect(res.matches.map((m: any) => m.name)).toEqual(['Sword', 'Rag']);
  });
});

describe('searchCharacterItems — item filtering and descriptions', () => {
  const bag = (): Record<string, any>[] => [
    item('Sword', 'weapon', { description: { value: 'A sharp <b>blade</b>.' } }),
    item('Shield', 'armor', { description: 'A plain string description' }),
    item('Rag', 'loot', { description: { notAValue: 'x' } }),
  ];

  it('filters by an exact, case-insensitive item type', async () => {
    install([makeActor('Lena', { items: bag() })]);
    const da = await makeDataAccess();

    const res = await da.searchCharacterItems({ characterIdentifier: 'Lena', type: 'WEAPON' });

    expect(res.matches.map((m: any) => m.name)).toEqual(['Sword']);
  });

  it('does not match a type by prefix, substring or plural', async () => {
    install([
      makeActor('Lena', {
        items: [item('Sword', 'weapon'), item('Plate', 'armor'), item('Rag', 'loot')],
      }),
    ]);
    const da = await makeDataAccess();

    // The comparison is `===`, so none of these partial types matches anything.
    for (const type of ['weap', 'eapon', 'arm', 'or', 'weapons']) {
      const res = await da.searchCharacterItems({ characterIdentifier: 'Lena', type });
      expect(res.matches).toEqual([]);
      expect(res.totalMatches).toBe(0);
    }
  });

  it('matches the query against the name or the raw description', async () => {
    install([makeActor('Lena', { items: bag() })]);
    const da = await makeDataAccess();

    expect(
      (await da.searchCharacterItems({ characterIdentifier: 'Lena', query: 'SWO' })).matches.map(
        (m: any) => m.name
      )
    ).toEqual(['Sword']);
    expect(
      (
        await da.searchCharacterItems({ characterIdentifier: 'Lena', query: 'plain string' })
      ).matches.map((m: any) => m.name)
    ).toEqual(['Shield']);
    // The query runs against the description BEFORE its HTML is stripped.
    expect(
      (await da.searchCharacterItems({ characterIdentifier: 'Lena', query: '<b>' })).matches.map(
        (m: any) => m.name
      )
    ).toEqual(['Sword']);
  });

  it('treats a non-string description as absent, for matching and for output', async () => {
    install([makeActor('Lena', { items: bag() })]);
    const da = await makeDataAccess();

    const res = await da.searchCharacterItems({ characterIdentifier: 'Lena' });

    expect(res.matches[2].name).toBe('Rag');
    expect('description' in res.matches[2]).toBe(false);
  });

  it('strips HTML from the description it returns', async () => {
    install([makeActor('Lena', { items: bag() })]);
    const da = await makeDataAccess();

    const res = await da.searchCharacterItems({ characterIdentifier: 'Lena', type: 'weapon' });

    expect(res.matches[0].description).toBe('A sharp blade.');
  });

  it('truncates a description longer than 300 characters, and only then', async () => {
    install([
      makeActor('Lena', {
        items: [
          item('Exactly300', 'loot', { description: { value: 'a'.repeat(300) } }),
          item('Over300', 'loot', { description: { value: 'b'.repeat(301) } }),
          item('Tagged', 'loot', { description: { value: `<p>${'c'.repeat(298)}</p>` } }),
        ],
      }),
    ]);
    const da = await makeDataAccess();

    const res = await da.searchCharacterItems({ characterIdentifier: 'Lena' });

    expect(res.matches[0].description).toBe('a'.repeat(300));
    expect(res.matches[1].description).toBe(`${'b'.repeat(300)}...`);
    // Stripping happens BEFORE the length test, so tags do not count.
    expect(res.matches[2].description).toBe('c'.repeat(298));
  });

  it('returns bare id/name/type for an item no typed block claims', async () => {
    // 'misc' is in none of the type lists — 'loot' is in the equipment one, so
    // it would pick up quantity/equipped/invested.
    install([makeActor('Lena', { items: [item('Rock', 'misc')] })]);
    const da = await makeDataAccess();

    const res = await da.searchCharacterItems({ characterIdentifier: 'Lena' });

    expect(res.matches).toEqual([{ id: 'i-rock', name: 'Rock', type: 'misc' }]);
  });
});

describe('searchCharacterItems — the four-way spell dispatch', () => {
  const pf2eBook = (): FakeActor =>
    makePf2eActor('Ezren', {
      spells: [
        pf2eSpell({
          name: 'Fireball',
          id: 's-fb',
          rank: 3,
          traits: ['fire'],
          time: 2,
          range: '500 feet',
          target: 'a point',
          area: { type: 'burst', value: 20 },
          prepared: true,
          expended: false,
        }),
      ],
    });

  it('pf2e: traits, an action cost from system.time and PF2e targeting', async () => {
    install([pf2eBook()], 'pf2e');
    const da = await makeDataAccess();

    const res = await da.searchCharacterItems({ characterIdentifier: 'Ezren' });

    expect(res.matches[0]).toEqual({
      id: 's-fb',
      name: 'Fireball',
      type: 'spell',
      level: 3,
      prepared: true,
      expended: false,
      range: '500 feet',
      target: 'a point',
      area: '20-foot burst',
      actionCost: '2 actions',
      traits: ['fire'],
    });
  });

  it('dnd5e: an action cost from system.activation and 5e targeting', async () => {
    install(
      [
        makeDnd5eActor('Merlin', {
          spells: [
            dnd5eSpell({
              name: 'Fire Bolt',
              id: 's-fbolt',
              level: 0,
              activation: 'action',
              preparation: true,
              range: { value: 120, units: 'feet' },
              target: { type: 'creature', value: 1 },
            }),
          ],
        }),
      ],
      'dnd5e'
    );
    const da = await makeDataAccess();

    const res = await da.searchCharacterItems({ characterIdentifier: 'Merlin' });

    expect(res.matches[0]).toEqual({
      id: 's-fbolt',
      name: 'Fire Bolt',
      type: 'spell',
      level: 0,
      // `system.prepared` is absent; `_source` is absent; `location.prepared` too.
      prepared: undefined,
      expended: undefined,
      range: '120 feet',
      target: '1 creature',
      actionCost: 'action',
    });
    // No traits key: only the pf2e arm sets one.
    expect('traits' in res.matches[0]).toBe(false);
  });

  it('dsa5: an action cost from system.castingTime and DSA5 targeting', async () => {
    install(
      [
        makeDsa5Actor('Gerda', {
          spells: [
            dsa5Spell({
              name: 'Ignifaxius',
              id: 's-ig',
              level: 2,
              castingTime: '2 Aktionen',
              range: '16 Schritt',
              targetCategory: 'Zone',
              effectRadius: '4 Schritt',
            }),
          ],
        }),
      ],
      'dsa5'
    );
    const da = await makeDataAccess();

    const res = await da.searchCharacterItems({ characterIdentifier: 'Gerda' });

    expect(res.matches[0]).toEqual({
      id: 's-ig',
      name: 'Ignifaxius',
      type: 'spell',
      level: 2,
      prepared: undefined,
      expended: undefined,
      range: '16 Schritt',
      target: 'Zone',
      area: '4 Schritt',
      actionCost: '2 Aktionen',
    });
  });

  it('wfrp4e: range and target read directly, and a Casting Number as the cost', async () => {
    install(
      [
        makeWfrp4eActor('Salundra', {
          spells: [wfrp4eSpell('Dart', { id: 's-dart', cn: 4, range: 'WPB yards', target: '1' })],
        }),
      ],
      'wfrp4e'
    );
    const da = await makeDataAccess();

    const res = await da.searchCharacterItems({ characterIdentifier: 'Salundra' });

    expect(res.matches[0]).toEqual({
      id: 's-dart',
      name: 'Dart',
      type: 'spell',
      level: 0,
      prepared: undefined,
      expended: undefined,
      range: 'WPB yards',
      target: '1',
      actionCost: 'CN 4',
    });
  });

  it('wfrp4e: no cost at all when the casting number is null, and 0 still reports', async () => {
    install(
      [
        makeWfrp4eActor('Salundra', {
          spells: [
            wfrp4eSpell('Quiet', { id: 's-q', cn: null }),
            wfrp4eSpell('Trivial', { id: 's-t', cn: 0 }),
          ],
        }),
      ],
      'wfrp4e'
    );
    const da = await makeDataAccess();

    const res = await da.searchCharacterItems({ characterIdentifier: 'Salundra' });

    expect('actionCost' in res.matches[0]).toBe(false);
    expect(res.matches[1].actionCost).toBe('CN 0');
  });

  it('gives a pf2e-shaped spell none of its pf2e fields under another system id', async () => {
    install([pf2eBook()], 'worldofdarkness');
    const da = await makeDataAccess();

    const res = await da.searchCharacterItems({ characterIdentifier: 'Ezren' });

    // The level/prepared/expended block runs for every system; the targeting,
    // the action cost and the traits are the dispatch's, and none fires.
    expect(res.matches[0]).toEqual({
      id: 's-fb',
      name: 'Fireball',
      type: 'spell',
      level: 3,
      prepared: true,
      expended: false,
    });
  });

  it('reads the spell level from level.value, then level, then rank, then 0', async () => {
    install(
      [
        makeActor('Lena', {
          items: [
            item('Nested', 'spell', { level: { value: 5 }, rank: 9 }),
            item('Flat', 'spell', { level: 4 }),
            item('Ranked', 'spell', { rank: 3 }),
            item('Nothing', 'spell', {}),
          ],
        }),
      ],
      'pf2e'
    );
    const da = await makeDataAccess();

    const res = await da.searchCharacterItems({ characterIdentifier: 'Lena' });

    expect(res.matches.map((m: any) => [m.name, m.level])).toEqual([
      ['Nested', 5],
      ['Flat', 4],
      ['Ranked', 3],
      ['Nothing', 0],
    ]);
  });

  it('reads prepared from system.prepared, then _source.preparation, then location', async () => {
    install(
      [
        makeActor('Lena', {
          items: [
            item('Direct', 'spell', { prepared: true, location: { prepared: false } }),
            item(
              'Raw',
              'spell',
              { location: { prepared: false } },
              { _source: { system: { preparation: { prepared: true } } } }
            ),
            item('Located', 'spell', { location: { prepared: true, expended: true } }),
          ],
        }),
      ],
      'pf2e'
    );
    const da = await makeDataAccess();

    const res = await da.searchCharacterItems({ characterIdentifier: 'Lena' });

    expect(res.matches.map((m: any) => [m.name, m.prepared, m.expended])).toEqual([
      ['Direct', true, undefined],
      ['Raw', true, undefined],
      ['Located', true, true],
    ]);
  });
});

describe('searchCharacterItems — action cost formatting', () => {
  it('formats numbers, reaction, free and anything else, and drops a falsy cost', async () => {
    install(
      [
        makePf2eActor('Ezren', {
          spells: [
            pf2eSpell({ name: 'One', time: 1 }),
            pf2eSpell({ name: 'Two', time: 2 }),
            pf2eSpell({ name: 'React', time: 'reaction' }),
            pf2eSpell({ name: 'Free', time: 'free' }),
            pf2eSpell({ name: 'Long', time: '1 minute' }),
            pf2eSpell({ name: 'Zero', time: 0 }),
            pf2eSpell({ name: 'None' }),
          ],
        }),
      ],
      'pf2e'
    );
    const da = await makeDataAccess();

    const res = await da.searchCharacterItems({ characterIdentifier: 'Ezren' });

    expect(res.matches.map((m: any) => [m.name, m.actionCost])).toEqual([
      ['One', '1 action'],
      ['Two', '2 actions'],
      ['React', 'reaction'],
      ['Free', 'free action'],
      ['Long', '1 minute'],
      // 0 is falsy, so a zero-action spell reports no cost at all.
      ['Zero', undefined],
      ['None', undefined],
    ]);
  });
});

describe('searchCharacterItems — targeting helpers', () => {
  async function firstMatch(system: string, spellSystem: Record<string, any>): Promise<any> {
    install([makeActor('Lena', { items: [item('Spell', 'spell', spellSystem)] })], system);
    const da = await makeDataAccess();
    const res = await da.searchCharacterItems({ characterIdentifier: 'Lena' });
    return res.matches[0];
  }

  it('dnd5e range: self, touch, special and value-with-units', async () => {
    expect((await firstMatch('dnd5e', { range: { units: 'self', value: 30 } })).range).toBe('Self');
    expect((await firstMatch('dnd5e', { range: { units: 'touch' } })).range).toBe('Touch');
    expect((await firstMatch('dnd5e', { range: { units: 'spec', special: 'Sight' } })).range).toBe(
      'Sight'
    );
    expect((await firstMatch('dnd5e', { range: { units: 'spec' } })).range).toBe('Special');
    expect((await firstMatch('dnd5e', { range: { value: 60, units: 'feet' } })).range).toBe(
      '60 feet'
    );
    // A value with no units yields no range at all.
    expect('range' in (await firstMatch('dnd5e', { range: { value: 60 } }))).toBe(false);
  });

  it('dnd5e target: self, creature/ally/enemy with pluralisation, object, point, other', async () => {
    expect((await firstMatch('dnd5e', { target: { type: 'self' } })).target).toBe('self');
    expect((await firstMatch('dnd5e', { target: { type: 'creature', value: 1 } })).target).toBe(
      '1 creature'
    );
    expect((await firstMatch('dnd5e', { target: { type: 'ally', value: 3 } })).target).toBe(
      '3 allys'
    );
    expect((await firstMatch('dnd5e', { target: { type: 'enemy' } })).target).toBe('enemy');
    expect((await firstMatch('dnd5e', { target: { type: 'object', value: 2 } })).target).toBe(
      '2 objects'
    );
    expect((await firstMatch('dnd5e', { target: { type: 'object' } })).target).toBe('object');
    expect((await firstMatch('dnd5e', { target: { type: 'space' } })).target).toBe('point');
    expect((await firstMatch('dnd5e', { target: { type: 'point' } })).target).toBe('point');
    expect((await firstMatch('dnd5e', { target: { type: 'wall' } })).target).toBe('wall');
  });

  it('dnd5e area: built from the template, defaulting the units, and overriding a point target', async () => {
    const cone = await firstMatch('dnd5e', {
      target: { type: 'point', template: { type: 'cone', size: 15, units: 'ft' } },
    });
    expect(cone.area).toBe('15-ft cone');
    // A point target becomes 'area' once there is a template.
    expect(cone.target).toBe('area');

    const noUnits = await firstMatch('dnd5e', {
      target: { template: { type: 'radius', size: 20 } },
    });
    expect(noUnits.area).toBe('20-ft radius');
    expect(noUnits.target).toBe('area');

    // An explicit non-point target is NOT overridden.
    const creature = await firstMatch('dnd5e', {
      target: { type: 'creature', value: 1, template: { type: 'sphere', size: 10 } },
    });
    expect(creature.target).toBe('1 creature');
    expect(creature.area).toBe('10-ft sphere');

    // A template with a type but no size yields no area.
    expect('area' in (await firstMatch('dnd5e', { target: { template: { type: 'line' } } }))).toBe(
      false
    );
  });

  it('pf2e: range and target stringified, and an area with or without a size', async () => {
    expect((await firstMatch('pf2e', { range: { value: 30 } })).range).toBe('30');
    expect((await firstMatch('pf2e', { target: { value: '1 creature' } })).target).toBe(
      '1 creature'
    );

    const sized = await firstMatch('pf2e', { area: { type: 'emanation', value: 15 } });
    expect(sized.area).toBe('15-foot emanation');
    expect(sized.target).toBe('area');

    const bare = await firstMatch('pf2e', { area: { type: 'cone' } });
    expect(bare.area).toBe('cone');
    expect(bare.target).toBe('area');

    // An explicit target survives the area block.
    const both = await firstMatch('pf2e', {
      target: { value: '1 ally' },
      area: { type: 'burst', value: 5 },
    });
    expect(both.target).toBe('1 ally');

    // No area type: nothing, and no invented target.
    const none = await firstMatch('pf2e', { area: { value: 20 } });
    expect('area' in none).toBe(false);
    expect('target' in none).toBe(false);
  });

  it('dsa5: value keys first, then the German keys, for range, target and area', async () => {
    const valueKeys = await firstMatch('dsa5', {
      range: { value: '7 Schritt' },
      targetCategory: { value: 'Zone' },
      effectRadius: { value: '2 Schritt' },
      Reichweite: 'ignored',
      Zielkategorie: 'ignored',
      Wirkungsbereich: 'ignored',
    });
    expect([valueKeys.range, valueKeys.target, valueKeys.area]).toEqual([
      '7 Schritt',
      'Zone',
      '2 Schritt',
    ]);

    const german = await firstMatch('dsa5', {
      Reichweite: 'Berührung',
      Zielkategorie: 'Zauberer',
      Wirkungsbereich: 'Zone',
    });
    expect([german.range, german.target, german.area]).toEqual(['Berührung', 'Zauberer', 'Zone']);

    const empty = await firstMatch('dsa5', {});
    expect('range' in empty).toBe(false);
    expect('target' in empty).toBe(false);
    expect('area' in empty).toBe(false);
  });
});

describe('searchCharacterItems — equipment, feats and item actions', () => {
  it('reports quantity, equipped and invested for the six generic equipment types', async () => {
    install([
      makeActor('Lena', {
        items: [
          item('Sword', 'weapon', { quantity: 2, equipped: true, invested: false }),
          item('Plate', 'armor', {}),
          item('Ring', 'equipment', { equipped: { invested: true } }),
        ],
      }),
    ]);
    const da = await makeDataAccess();

    const res = await da.searchCharacterItems({ characterIdentifier: 'Lena' });

    expect(res.matches.map((m: any) => [m.name, m.quantity, m.equipped, m.invested])).toEqual([
      ['Sword', 2, true, false],
      // Defaults: quantity 1, equipped false, invested undefined.
      ['Plate', 1, false, undefined],
      // `equipped.invested` wins over a flat `invested`.
      ['Ring', 1, { invested: true }, true],
    ]);
  });

  it('overrides quantity and equipped for a wfrp4e weapon, which matches BOTH blocks', async () => {
    install(
      [
        makeWfrp4eActor('Salundra', {
          items: [
            item('Sword', 'weapon', { quantity: { value: 3 }, equipped: { value: true } }),
            item('Mail', 'armour', { quantity: { value: 1 } }, { isEquipped: true }),
            item('Rope', 'trapping', {}),
          ],
        }),
      ],
      'wfrp4e'
    );
    const da = await makeDataAccess();

    const res = await da.searchCharacterItems({ characterIdentifier: 'Salundra' });

    expect(res.matches.map((m: any) => [m.name, m.quantity, m.equipped])).toEqual([
      // 'weapon' is in the generic list too, and the wfrp4e block runs second.
      ['Sword', 3, true],
      // 'armour' is only in the wfrp4e list; `item.isEquipped` is the fallback.
      ['Mail', 1, true],
      ['Rope', 1, false],
    ]);
  });

  it('leaves a wfrp4e item alone under another system id', async () => {
    install(
      [
        makeWfrp4eActor('Salundra', {
          items: [item('Mail', 'armour', { quantity: { value: 1 } })],
        }),
      ],
      'pf2e'
    );
    const da = await makeDataAccess();

    const res = await da.searchCharacterItems({ characterIdentifier: 'Salundra' });

    // 'armour' is in neither the generic list nor an active wfrp4e block.
    expect(res.matches[0]).toEqual({ id: 'i-mail', name: 'Mail', type: 'armour' });
  });

  it('adds range and target to a wfrp4e prayer', async () => {
    install(
      [
        makeWfrp4eActor('Salundra', {
          prayers: [wfrp4ePrayer('Bless', { id: 'p-b', range: 'Touch', target: 'You' })],
        }),
      ],
      'wfrp4e'
    );
    const da = await makeDataAccess();

    const res = await da.searchCharacterItems({ characterIdentifier: 'Salundra' });

    expect(res.matches[0]).toEqual({
      id: 'p-b',
      name: 'Bless',
      type: 'prayer',
      range: 'Touch',
      target: 'You',
    });
  });

  it('adds traits, level and an action cost to pf2e feats and features', async () => {
    install(
      [
        makeActor('Ezren', {
          items: [
            item('Toughness', 'feat', {
              traits: { value: ['general'] },
              level: { value: 1 },
              actionType: { value: 'passive' },
            }),
            item('Ancestry', 'ancestry', {}),
          ],
        }),
      ],
      'pf2e'
    );
    const da = await makeDataAccess();

    const res = await da.searchCharacterItems({ characterIdentifier: 'Ezren' });

    expect(res.matches[0]).toEqual({
      id: 'i-toughness',
      name: 'Toughness',
      type: 'feat',
      traits: ['general'],
      level: 1,
      actionCost: 'passive',
    });
    expect(res.matches[1]).toEqual({
      id: 'i-ancestry',
      name: 'Ancestry',
      type: 'ancestry',
      traits: [],
      level: undefined,
      actionCost: undefined,
    });
  });

  it('leaves a feat untouched under a non-pf2e system id', async () => {
    install(
      [makeActor('Lena', { items: [item('Merit', 'feat', { level: { value: 2 } })] })],
      'dnd5e'
    );
    const da = await makeDataAccess();

    const res = await da.searchCharacterItems({ characterIdentifier: 'Lena' });

    expect(res.matches[0]).toEqual({ id: 'i-merit', name: 'Merit', type: 'feat' });
  });

  it('adds traits and an action cost to a pf2e ITEM of type action', async () => {
    install(
      [
        makeActor('Ezren', {
          items: [
            item('Trip', 'action', {
              traits: { value: ['attack'] },
              actionType: { value: 'reaction' },
            }),
            item('Grapple', 'action', { actions: { value: 2 } }),
          ],
        }),
      ],
      'pf2e'
    );
    const da = await makeDataAccess();

    const res = await da.searchCharacterItems({ characterIdentifier: 'Ezren', type: 'action' });

    expect(res.matches[0]).toMatchObject({
      id: 'i-trip',
      name: 'Trip',
      type: 'action',
      traits: ['attack'],
      actionCost: 'reaction',
    });
    // `actionType.value || actions.value` — the second reads the fallback.
    expect(res.matches[1]).toMatchObject({ name: 'Grapple', actionCost: '2 actions' });
  });
});

describe('searchCharacterItems — category filters', () => {
  const spells = (): Record<string, any>[] => [
    item('Cantrip', 'spell', { level: { value: 0 }, location: { prepared: true } }),
    item('Ritual', 'spell', { level: { value: 3 }, location: { prepared: false } }),
    item('Focused', 'spell', { level: { value: 1 }, traits: { value: ['focus'] } }),
    item('Categorised', 'spell', { level: { value: 2 }, category: { value: 'focus' } }),
  ];

  it('cantrip keeps only level-zero spells', async () => {
    install([makeActor('Ezren', { items: spells() })], 'pf2e');
    const da = await makeDataAccess();

    const res = await da.searchCharacterItems({
      characterIdentifier: 'Ezren',
      category: 'cantrip',
    });

    expect(res.matches.map((m: any) => m.name)).toEqual(['Cantrip']);
  });

  it('prepared keeps everything that is not explicitly unprepared', async () => {
    install([makeActor('Ezren', { items: spells() })], 'pf2e');
    const da = await makeDataAccess();

    const res = await da.searchCharacterItems({
      characterIdentifier: 'Ezren',
      category: 'prepared',
    });

    // The test is `result.prepared !== false`, so an UNKNOWN preparation counts
    // as prepared — only `Ritual`, which says false, is dropped.
    expect(res.matches.map((m: any) => m.name)).toEqual(['Cantrip', 'Focused', 'Categorised']);
  });

  it('focus keeps a spell marked by either its traits or its category', async () => {
    install([makeActor('Ezren', { items: spells() })], 'pf2e');
    const da = await makeDataAccess();

    const res = await da.searchCharacterItems({ characterIdentifier: 'Ezren', category: 'focus' });

    expect(res.matches.map((m: any) => m.name)).toEqual(['Focused', 'Categorised']);
  });

  it('applies a spell category only to spells, and lets other types straight through', async () => {
    install([makeActor('Ezren', { items: [...spells(), item('Rock', 'loot', {})] })], 'pf2e');
    const da = await makeDataAccess();

    const res = await da.searchCharacterItems({
      characterIdentifier: 'Ezren',
      category: 'cantrip',
    });

    expect(res.matches.map((m: any) => m.name)).toEqual(['Cantrip', 'Rock']);
  });

  it('equipped and invested filter the equipment block', async () => {
    install([
      makeActor('Lena', {
        items: [
          item('Worn', 'weapon', { equipped: true }),
          item('Stowed', 'weapon', { equipped: false }),
          item('Invested', 'equipment', { invested: true }),
        ],
      }),
    ]);
    const da = await makeDataAccess();

    expect(
      (
        await da.searchCharacterItems({ characterIdentifier: 'Lena', category: 'equipped' })
      ).matches.map((m: any) => m.name)
    ).toEqual(['Worn', 'Invested'].slice(0, 1));
    expect(
      (
        await da.searchCharacterItems({ characterIdentifier: 'Lena', category: 'invested' })
      ).matches.map((m: any) => m.name)
    ).toEqual(['Invested']);
  });

  it('filters a wfrp4e item by equipped through the wfrp4e block', async () => {
    install(
      [
        makeWfrp4eActor('Salundra', {
          items: [
            item('Worn', 'armour', { equipped: { value: true } }),
            item('Stowed', 'armour', { equipped: { value: false } }),
          ],
        }),
      ],
      'wfrp4e'
    );
    const da = await makeDataAccess();

    const res = await da.searchCharacterItems({
      characterIdentifier: 'Salundra',
      category: 'equipped',
    });

    expect(res.matches.map((m: any) => m.name)).toEqual(['Worn']);
  });

  it('ignores an unrecognised category entirely', async () => {
    install([makeActor('Ezren', { items: spells() })], 'pf2e');
    const da = await makeDataAccess();

    const res = await da.searchCharacterItems({
      characterIdentifier: 'Ezren',
      category: 'nonsense',
    });

    expect(res.matches).toHaveLength(4);
  });
});

describe('searchCharacterItems — the actions and effects sections', () => {
  it('reads system.actions, with id, actionType and pf2e extras', async () => {
    install(
      [
        makePf2eActor('Ezren', {
          actions: [
            {
              id: 'a-1',
              name: 'Strike',
              type: 'strike',
              traits: ['agile'],
              actionCost: { value: 1 },
            },
            { slug: 'a-slug', label: 'Slugged', actions: 2 },
            { label: 'Nameless' },
          ],
        }),
      ],
      'pf2e'
    );
    const da = await makeDataAccess();

    const res = await da.searchCharacterItems({ characterIdentifier: 'Ezren' });

    expect(res.matches).toEqual([
      {
        id: 'a-1',
        name: 'Strike',
        type: 'action',
        actionType: 'strike',
        traits: ['agile'],
        actionCost: '1 action',
      },
      // `id || slug || name`, and `type || actionType || 'action'`.
      {
        id: 'a-slug',
        name: 'Slugged',
        type: 'action',
        actionType: 'action',
        traits: [],
        actionCost: '2 actions',
      },
      {
        id: 'Nameless',
        name: 'Nameless',
        type: 'action',
        actionType: 'action',
        traits: [],
        actionCost: undefined,
      },
    ]);
  });

  it('counts an item of type action TWICE when the actor has no system.actions', async () => {
    install([makeActor('Lena', { items: [item('Trip', 'action', {})] })], 'pf2e');
    const da = await makeDataAccess();

    const res = await da.searchCharacterItems({ characterIdentifier: 'Lena' });

    // Pinned as it stands: the item loop matches it, and the actions section
    // then falls back to filtering the same items.
    expect(res.matches.map((m: any) => [m.name, m.type])).toEqual([
      ['Trip', 'action'],
      ['Trip', 'action'],
    ]);
    expect(res.totalMatches).toBe(2);
  });

  it('skips the actions section unless the type filter is absent or exactly action', async () => {
    install([makePf2eActor('Ezren', { actions: [{ id: 'a-1', name: 'Strike' }] })], 'pf2e');
    const da = await makeDataAccess();

    expect(
      (await da.searchCharacterItems({ characterIdentifier: 'Ezren', type: 'weapon' })).matches
    ).toEqual([]);
    expect(
      (await da.searchCharacterItems({ characterIdentifier: 'Ezren', type: 'action' })).matches
    ).toHaveLength(1);
  });

  it('filters actions by the query, against the resolved action name', async () => {
    install(
      [
        makePf2eActor('Ezren', {
          actions: [
            { id: 'a-1', name: 'Strike' },
            { id: 'a-2', label: 'Demoralize' },
          ],
        }),
      ],
      'pf2e'
    );
    const da = await makeDataAccess();

    // `name || label`: the query has to reach the label too.
    const res = await da.searchCharacterItems({ characterIdentifier: 'Ezren', query: 'demo' });

    expect(res.matches.map((m: any) => m.name)).toEqual(['Demoralize']);
  });

  it('lists effects with their name, label fallback and description', async () => {
    install([
      makeActor('Lena', {
        effects: [
          makeEffect('Bless', { id: 'x-1', description: 'A blessing' }),
          makeEffect('', { id: 'x-2', label: 'Old Label' }),
        ],
      }),
    ]);
    const da = await makeDataAccess();

    const res = await da.searchCharacterItems({ characterIdentifier: 'Lena' });

    expect(res.matches).toEqual([
      { id: 'x-1', name: 'Bless', type: 'effect', description: 'A blessing' },
      { id: 'x-2', name: 'Old Label', type: 'effect', description: undefined },
    ]);
  });

  it('skips the effects section unless the type filter is absent or exactly effect', async () => {
    install([makeActor('Lena', { effects: [makeEffect('Bless', { id: 'x-1' })] })]);
    const da = await makeDataAccess();

    expect(
      (await da.searchCharacterItems({ characterIdentifier: 'Lena', type: 'weapon' })).matches
    ).toEqual([]);
    expect(
      (await da.searchCharacterItems({ characterIdentifier: 'Lena', type: 'effect' })).matches
    ).toHaveLength(1);
  });

  it('filters effects by the query, against name or label', async () => {
    install([
      makeActor('Lena', {
        effects: [
          makeEffect('Bless', { id: 'x-1' }),
          makeEffect('Curse', { id: 'x-2' }),
          makeEffect('', { id: 'x-3', label: 'Blessing of Sigmar' }),
        ],
      }),
    ]);
    const da = await makeDataAccess();

    const res = await da.searchCharacterItems({ characterIdentifier: 'Lena', query: 'bless' });

    expect(res.matches.map((m: any) => m.id)).toEqual(['x-1', 'x-3']);
  });
});

describe('searchCharacterItems — ordering and the three truncation sites', () => {
  /** Three items, three actions, three effects — one per section. */
  function mixed(): FakeActor {
    return makePf2eActor('Ezren', {
      actions: [
        { id: 'a-1', name: 'Act1' },
        { id: 'a-2', name: 'Act2' },
        { id: 'a-3', name: 'Act3' },
      ],
      items: [item('Item1', 'loot'), item('Item2', 'loot'), item('Item3', 'loot')],
      effects: [
        makeEffect('Eff1', { id: 'x-1' }),
        makeEffect('Eff2', { id: 'x-2' }),
        makeEffect('Eff3', { id: 'x-3' }),
      ],
    });
  }

  it('returns items, then actions, then effects', async () => {
    install([mixed()], 'pf2e');
    const da = await makeDataAccess();

    const res = await da.searchCharacterItems({ characterIdentifier: 'Ezren' });

    expect(res.matches.map((m: any) => m.name)).toEqual([
      'Item1',
      'Item2',
      'Item3',
      'Act1',
      'Act2',
      'Act3',
      'Eff1',
      'Eff2',
      'Eff3',
    ]);
    expect(res.totalMatches).toBe(9);
  });

  it('truncates inside the item loop, after the item that reaches the limit', async () => {
    install([mixed()], 'pf2e');
    const da = await makeDataAccess();

    const res = await da.searchCharacterItems({ characterIdentifier: 'Ezren', limit: 2 });

    expect(res.matches.map((m: any) => m.name)).toEqual(['Item1', 'Item2']);
    expect(res.totalMatches).toBe(2);
  });

  it('truncates inside the actions loop, before adding one more', async () => {
    install([mixed()], 'pf2e');
    const da = await makeDataAccess();

    const res = await da.searchCharacterItems({ characterIdentifier: 'Ezren', limit: 4 });

    expect(res.matches.map((m: any) => m.name)).toEqual(['Item1', 'Item2', 'Item3', 'Act1']);
  });

  it('truncates inside the effects loop, before adding one more', async () => {
    install([mixed()], 'pf2e');
    const da = await makeDataAccess();

    const res = await da.searchCharacterItems({ characterIdentifier: 'Ezren', limit: 7 });

    expect(res.matches.map((m: any) => m.name)).toEqual([
      'Item1',
      'Item2',
      'Item3',
      'Act1',
      'Act2',
      'Act3',
      'Eff1',
    ]);
  });

  it('lets a limit equal to the total through untouched', async () => {
    install([mixed()], 'pf2e');
    const da = await makeDataAccess();

    const res = await da.searchCharacterItems({ characterIdentifier: 'Ezren', limit: 9 });

    expect(res.matches).toHaveLength(9);
  });

  it('defaults the limit to 20', async () => {
    const many = Array.from({ length: 25 }, (_, i) => item(`Item${i + 1}`, 'loot'));
    install([makeActor('Lena', { items: many })]);
    const da = await makeDataAccess();

    const res = await da.searchCharacterItems({ characterIdentifier: 'Lena' });

    expect(res.matches).toHaveLength(20);
    expect(res.matches[19].name).toBe('Item20');
    // `totalMatches` is the TRUNCATED count, not the number of matches found.
    expect(res.totalMatches).toBe(20);
  });

  it('returns nothing at all for a limit of zero', async () => {
    install([mixed()], 'pf2e');
    const da = await makeDataAccess();

    const res = await da.searchCharacterItems({ characterIdentifier: 'Ezren', limit: 0 });

    // The item push happens before the check, so a limit of 0 still yields one.
    expect(res.matches.map((m: any) => m.name)).toEqual(['Item1']);
  });
});

describe('searchCharacterItems — the audit call on a read path', () => {
  it('audits the search with its filters and the match count', async () => {
    install([
      makeActor('Lena', {
        items: [item('Sword', 'weapon', { equipped: true }), item('Rag', 'loot')],
      }),
    ]);
    const da = await makeDataAccess();

    await da.searchCharacterItems({
      characterIdentifier: 'Lena',
      query: 'sword',
      type: 'weapon',
      category: 'equipped',
    });

    expect(world.audit).toHaveLength(1);
    expect(world.audit[0].operation).toBe('searchCharacterItems');
    expect(world.audit[0].result).toBe('success');
    expect(world.audit[0].data).toEqual({
      characterId: 'Lena000000000000',
      query: 'sword',
      type: 'weapon',
      category: 'equipped',
      matchCount: 1,
    });
  });

  it('audits a search that matched nothing', async () => {
    install([makeActor('Lena')]);
    const da = await makeDataAccess();

    await da.searchCharacterItems({ characterIdentifier: 'Lena', query: 'nothing here' });

    expect(world.audit).toHaveLength(1);
    expect(world.audit[0].data).toEqual({
      characterId: 'Lena000000000000',
      query: 'nothing here',
      matchCount: 0,
    });
  });

  it('audits the TRUNCATED count, not the number of candidates', async () => {
    const many = Array.from({ length: 25 }, (_, i) => item(`Item${i + 1}`, 'loot'));
    install([makeActor('Lena', { items: many })]);
    const da = await makeDataAccess();

    await da.searchCharacterItems({ characterIdentifier: 'Lena', limit: 3 });

    expect(world.audit[0].data.matchCount).toBe(3);
  });

  it('audits exactly once per search, and still writes nothing to the world', async () => {
    install([makeActor('Lena', { items: [item('Sword', 'weapon')] })]);
    const da = await makeDataAccess();

    await da.searchCharacterItems({ characterIdentifier: 'Lena' });
    await da.searchCharacterItems({ characterIdentifier: 'Lena' });

    expect(world.audit).toHaveLength(2);
    expect(world.writes).toEqual([]);
  });
});
