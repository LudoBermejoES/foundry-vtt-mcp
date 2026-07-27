/**
 * Characterization tests for the compendium / creature-search cluster of
 * `FoundryDataAccess` — `searchCompendium`, `listCreaturesByCriteria`,
 * `fallbackBasicCreatureSearch`, `getCompendiumDocumentFull`,
 * `getAvailablePacks`, `getEnhancedCreatureIndex` and
 * `rebuildEnhancedCreatureIndex`, plus the three private helpers
 * (`shouldApplyFilters`, `matchesSearchCriteria`, `calculateRelevanceScore`)
 * reached THROUGH `searchCompendium` and never called directly.
 *
 * Why this file exists, and why it is committed BEFORE the extraction that will
 * move those methods into `compendium-search.ts`:
 *
 *   The extraction is a pure relocation whose entire claim is that nothing
 *   changed. A clean type-check cannot support that claim — the realistic
 *   failure is a flipped comparison or a swapped key inside one of five
 *   near-identical `passes*Criteria` branches, which type-checks perfectly. So
 *   the cluster needs tests, and they have to be written against the PRE-move
 *   source: a test first written against post-move code records whatever slip
 *   the move introduced and attests to nothing.
 *
 * Every assertion below therefore describes `data-access.ts` as it stands at
 * HEAD, including behaviour that is arguably wrong (`CR undefined undefined
 * from …` summaries, a challenge-rating score that can never fire). Those are
 * pinned deliberately: this file's job is to detect change, not to endorse it.
 * If a later pass wants to fix one of them, it should change the assertion in
 * the same commit that changes the code, so the change is visible.
 *
 * ── The load-bearing one ─────────────────────────────────────────────────────
 *
 * The recursion in this cluster is a THREE-cycle, not a pair:
 *
 *   searchCompendium → listCreaturesByCriteria → fallbackBasicCreatureSearch
 *                    → searchCompendium
 *
 * There is no direct `searchCompendium` → `fallbackBasicCreatureSearch` edge.
 * "the whole three-cycle, in one call" below drives all three edges in a single
 * call with nothing stubbed. If a later refactor splits that cycle across two
 * modules, the symptom is behavioural, not a compile error, and that test is
 * the only thing here that would catch it.
 */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  installFakeFoundry,
  makeDataAccess,
  type FakePackEntry,
  type FakePackSpec,
  type FakeWorld,
  type InstallOptions,
} from './__fixtures__/fake-foundry.js';

let world: FakeWorld;

function install(options: InstallOptions = {}): void {
  world = installFakeFoundry(options);
}

// ─── Builders ─────────────────────────────────────────────────────────────────

/** An index entry of an Actor-ish type, so `shouldApplyFilters` says yes. */
function npc(name: string, extra: Partial<FakePackEntry> = {}): FakePackEntry {
  return { _id: `id-${name.replace(/\W+/g, '-').toLowerCase()}`, name, type: 'npc', ...extra };
}

function monsterPack(
  entries: FakePackEntry[],
  overrides: Partial<FakePackSpec> = {}
): FakePackSpec {
  return {
    id: 'dnd5e.monsters',
    label: 'Monsters (SRD)',
    type: 'Actor',
    entries,
    ...overrides,
  };
}

/** A D&D 5e enhanced-index record: no `hits`, no `tier`, no `level`. */
function dnd5eCreature(name: string, o: Record<string, any> = {}): Record<string, any> {
  return {
    id: `c-${name.replace(/\W+/g, '-').toLowerCase()}`,
    name,
    type: 'npc',
    pack: 'dnd5e.monsters',
    packLabel: 'Monsters (SRD)',
    challengeRating: 1,
    creatureType: 'humanoid',
    size: 'medium',
    hitPoints: 10,
    armorClass: 12,
    hasSpells: false,
    hasLegendaryActions: false,
    alignment: 'neutral',
    ...o,
  };
}

/** A PF2e record: discriminated by `level`. */
function pf2eCreature(name: string, o: Record<string, any> = {}): Record<string, any> {
  return {
    id: `c-${name.replace(/\W+/g, '-').toLowerCase()}`,
    name,
    type: 'npc',
    pack: 'pf2e.pathfinder-bestiary',
    packLabel: 'Bestiary',
    level: 1,
    traits: ['humanoid'],
    creatureType: 'humanoid',
    rarity: 'common',
    size: 'medium',
    hitPoints: 20,
    armorClass: 15,
    hasSpells: false,
    alignment: 'neutral',
    ...o,
  };
}

/** A Cosmere RPG record: discriminated by `tier`. */
function cosmereCreature(name: string, o: Record<string, any> = {}): Record<string, any> {
  return {
    id: `c-${name.replace(/\W+/g, '-').toLowerCase()}`,
    name,
    type: 'adversary',
    pack: 'cosmere-rpg.adversaries',
    packLabel: 'Adversaries',
    tier: 1,
    role: 'minion',
    creatureType: 'humanoid',
    subtype: '',
    size: 'medium',
    hitPoints: 12,
    focus: 2,
    investiture: 0,
    hasInvestiture: false,
    defensePhysical: 10,
    defenseCognitive: 9,
    defenseSpiritual: 8,
    deflect: 1,
    walkSpeed: 25,
    ...o,
  };
}

/** An MGT2e record: discriminated by `hits` AND `hasPsionics` together. */
function mgt2eCreature(name: string, o: Record<string, any> = {}): Record<string, any> {
  return {
    id: `c-${name.replace(/\W+/g, '-').toLowerCase()}`,
    name,
    type: 'npc',
    pack: 'mgt2e.creatures',
    packLabel: 'Traveller Bestiary',
    hits: 10,
    creatureType: 'reptile',
    hasPsionics: false,
    characteristics: { STR: { value: 8, dm: 0 }, DEX: { value: 8, dm: 0 } },
    ...o,
  };
}

/** Enhanced search on, plus a pre-persisted index the loader will accept. */
function withIndex(
  systemId: string,
  creatures: Record<string, any>[],
  extra: InstallOptions = {}
): InstallOptions {
  return {
    systemId,
    settings: { enableEnhancedCreatureIndex: true },
    creatureIndex: { creatures },
    ...extra,
  };
}

beforeEach(() => {
  install();
});

// ═════════════════════════════════════════════════════════════════════════════
// searchCompendium — the query itself
// ═════════════════════════════════════════════════════════════════════════════

describe('searchCompendium — query validation', () => {
  it('rejects a query of fewer than two non-blank characters', async () => {
    install({ packs: [monsterPack([npc('Goblin')])] });
    const da = await makeDataAccess();

    for (const bad of ['', 'a', ' a ', '  ']) {
      await expect(da.searchCompendium(bad)).rejects.toThrow(/at least 2 characters/);
    }
  });

  it('rejects a non-string query', async () => {
    install({ packs: [monsterPack([npc('Goblin')])] });
    const da = await makeDataAccess();

    await expect(da.searchCompendium(5)).rejects.toThrow(/at least 2 characters/);
    await expect(da.searchCompendium(undefined)).rejects.toThrow(/at least 2 characters/);
  });
});

describe('searchCompendium — name matching', () => {
  const packs = (): FakePackSpec[] => [
    monsterPack([
      npc('Ancient Red Dragon'),
      npc('Bone Dragon', { img: 'bone.webp', description: 'undead' }),
      npc('Goblin'),
    ]),
    {
      id: 'dnd5e.items',
      label: 'Items (SRD)',
      type: 'Item',
      entries: [{ _id: 'w1', name: 'Dragon Slayer', type: 'weapon' }],
    },
    {
      id: 'world.maps',
      label: 'Maps',
      type: 'Scene',
      entries: [{ _id: 's1', name: 'Dragon Lair', type: 'scene' }],
    },
  ];

  it('matches on the index entry name, across every non-Scene pack', async () => {
    install({ packs: packs() });
    const da = await makeDataAccess();

    const results = await da.searchCompendium('dragon');

    // Alphabetical, since no result is an exact match and no filters were given.
    expect(results.map((r: any) => r.name)).toEqual([
      'Ancient Red Dragon',
      'Bone Dragon',
      'Dragon Slayer',
    ]);
  });

  it('never returns anything from a Scene pack, even unfiltered', async () => {
    install({ packs: packs() });
    const da = await makeDataAccess();

    const results = await da.searchCompendium('dragon');

    expect(results.map((r: any) => r.pack)).not.toContain('world.maps');
    expect(world.packIndexCalls).not.toContain('world.maps');
  });

  it('requires EVERY whitespace-separated term to appear in the name', async () => {
    install({ packs: packs() });
    const da = await makeDataAccess();

    expect((await da.searchCompendium('bone dragon')).map((r: any) => r.name)).toEqual([
      'Bone Dragon',
    ]);
    expect(await da.searchCompendium('bone goblin')).toEqual([]);
  });

  it('carries the index entry through to the result envelope verbatim', async () => {
    install({ packs: packs() });
    const da = await makeDataAccess();

    const [result] = await da.searchCompendium('bone dragon');

    expect(result).toEqual({
      id: 'id-bone-dragon',
      name: 'Bone Dragon',
      type: 'npc',
      img: 'bone.webp',
      pack: 'dnd5e.monsters',
      packLabel: 'Monsters (SRD)',
      description: 'undead',
      hasImage: true,
      summary: 'npc from Monsters (SRD)',
    });
  });

  it('reports no image and no description when the index entry has neither', async () => {
    install({ packs: packs() });
    const da = await makeDataAccess();

    const [result] = await da.searchCompendium('goblin');

    expect(result.img).toBeUndefined();
    expect(result.hasImage).toBe(false);
    expect(result.description).toBe('');
  });

  it('filters packs by packType', async () => {
    install({ packs: packs() });
    const da = await makeDataAccess();

    expect((await da.searchCompendium('dragon', 'Item')).map((r: any) => r.name)).toEqual([
      'Dragon Slayer',
    ]);
    expect((await da.searchCompendium('dragon', 'Actor')).map((r: any) => r.name)).toEqual([
      'Ancient Red Dragon',
      'Bone Dragon',
    ]);
    expect(await da.searchCompendium('dragon', 'JournalEntry')).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// shouldApplyFilters and matchesSearchCriteria, reached only via searchCompendium
// ═════════════════════════════════════════════════════════════════════════════

describe('searchCompendium — the filter decision that determines membership', () => {
  // packType is deliberately left undefined in this block so the enhanced-index
  // branch (which needs packType === 'Actor') is never entered and the filter
  // path is what is under test.
  const watchPack = (): FakePackSpec =>
    monsterPack([
      npc('Watch Captain', { description: 'a human soldier' }),
      npc('Watch Hound', { description: 'a beast' }),
      { _id: 'a3', name: 'Watch Post', type: 'loot' },
    ]);

  it('applies the derived criteria, which can be satisfied by the DESCRIPTION', async () => {
    install({ packs: [watchPack()] });
    const da = await makeDataAccess();

    const results = await da.searchCompendium('watch', undefined, { creatureType: 'humanoid' });

    // 'humanoid' expands to humanoid/human/elf/dwarf/orc/goblin, matched against
    // "<name> <description>". "Watch Captain" qualifies only on its description;
    // "Watch Hound" matches none of the terms and is dropped.
    expect(results.map((r: any) => r.name)).toContain('Watch Captain');
    expect(results.map((r: any) => r.name)).not.toContain('Watch Hound');
  });

  it('does NOT apply the criteria to an entry whose type is not npc/character/creature', async () => {
    install({ packs: [watchPack()] });
    const da = await makeDataAccess();

    const results = await da.searchCompendium('watch', undefined, { creatureType: 'humanoid' });

    // 'Watch Post' is type 'loot', so shouldApplyFilters says no and the entry
    // survives a criteria set it would have failed.
    expect(results.map((r: any) => r.name)).toEqual(['Watch Captain', 'Watch Post']);
  });

  it('does NOT apply the criteria when the filter object has no defined key', async () => {
    install({ packs: [watchPack()] });
    const da = await makeDataAccess();

    const results = await da.searchCompendium('watch', undefined, {});

    expect(results.map((r: any) => r.name)).toEqual(['Watch Captain', 'Watch Hound', 'Watch Post']);
  });

  it('does NOT apply the criteria to entries in a pack that is not an Actor pack', async () => {
    install({
      packs: [
        {
          id: 'world.oddities',
          label: 'Oddities',
          type: 'Item',
          entries: [npc('Watch Hound', { description: 'a beast' })],
        },
      ],
    });
    const da = await makeDataAccess();

    const results = await da.searchCompendium('watch', undefined, { creatureType: 'humanoid' });

    // Same entry that the Actor-pack case above dropped.
    expect(results.map((r: any) => r.name)).toEqual(['Watch Hound']);
  });

  it('a challenge-rating filter derives name terms from CR bands', async () => {
    install({
      packs: [
        monsterPack([
          npc('Ancient Watcher'),
          npc('Adult Watcher'),
          npc('Watcher Knight'),
          npc('Watcher Guard'),
        ]),
      ],
    });
    const da = await makeDataAccess();

    const names = async (challengeRating: number): Promise<string[]> =>
      (await da.searchCompendium('watcher', undefined, { challengeRating })).map(
        (r: any) => r.name
      );

    // Boundaries, not midpoints, so a `>=` turning into `>` is caught.
    expect(await names(15)).toEqual(['Ancient Watcher']); // >= 15 → ancient/legendary/elder/greater
    expect(await names(14)).toEqual(['Adult Watcher']); // >= 10 → adult/warlord/champion/master
    expect(await names(10)).toEqual(['Adult Watcher']);
    expect(await names(9)).toEqual(['Watcher Knight']); // >= 5 → captain/knight/priest/mage
    expect(await names(5)).toEqual(['Watcher Knight']);
    expect(await names(4)).toEqual(['Watcher Guard']); // else → guard/soldier/warrior/scout
  });

  it('a CR RANGE derives no name terms at all, so nothing is excluded', async () => {
    install({ packs: [monsterPack([npc('Ancient Watcher'), npc('Watcher Guard')])] });
    const da = await makeDataAccess();

    // The band table is only consulted for a scalar CR; `{min,max}` leaves
    // searchCriteria.searchTerms an empty array, which matches everything.
    // (Order is by relevance score: 'guard' is one of the common creature names.)
    const results = await da.searchCompendium('watcher', undefined, {
      challengeRating: { min: 1, max: 20 },
    });

    expect(results.map((r: any) => r.name)).toEqual(['Watcher Guard', 'Ancient Watcher']);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// calculateRelevanceScore, reached only via searchCompendium's sort
// ═════════════════════════════════════════════════════════════════════════════

describe('searchCompendium — ordering', () => {
  it('puts an exact name match first, then falls back to alphabetical', async () => {
    install({
      packs: [monsterPack([npc('Ancient Dragon'), npc('Dragon'), npc('Bone Dragon')])],
    });
    const da = await makeDataAccess();

    const results = await da.searchCompendium('dragon');

    expect(results.map((r: any) => r.name)).toEqual(['Dragon', 'Ancient Dragon', 'Bone Dragon']);
  });

  it('the exact-match test is case-insensitive', async () => {
    install({ packs: [monsterPack([npc('Ancient Dragon'), npc('DRAGON')])] });
    const da = await makeDataAccess();

    expect((await da.searchCompendium('dragon')).map((r: any) => r.name)).toEqual([
      'DRAGON',
      'Ancient Dragon',
    ]);
  });

  it('with filters, the relevance score outranks alphabetical order', async () => {
    install({ packs: [monsterPack([npc('Alpha Watch'), npc('Zeta Watch Dragon')])] });
    const da = await makeDataAccess();

    // 'Zeta Watch Dragon' scores 8 (+5 for the common creature name 'dragon',
    // +3 for the query term); 'Alpha Watch' scores 3. Higher score wins, which
    // inverts the alphabetical order the unfiltered search produces.
    const results = await da.searchCompendium('watch', undefined, { size: 'large' });

    expect(results.map((r: any) => r.name)).toEqual(['Zeta Watch Dragon', 'Alpha Watch']);
  });

  it('without filters the same two results are alphabetical', async () => {
    install({ packs: [monsterPack([npc('Alpha Watch'), npc('Zeta Watch Dragon')])] });
    const da = await makeDataAccess();

    const results = await da.searchCompendium('watch');

    expect(results.map((r: any) => r.name)).toEqual(['Alpha Watch', 'Zeta Watch Dragon']);
  });

  it('a query term of three characters or fewer earns no score bonus', async () => {
    install({ packs: [monsterPack([npc('Zeta Ox Dragon'), npc('Alpha Ox')])] });
    const da = await makeDataAccess();

    // 'ox' is 2 characters, so only the 'dragon' common-name bonus applies.
    const results = await da.searchCompendium('ox', undefined, { size: 'large' });

    expect(results.map((r: any) => r.name)).toEqual(['Zeta Ox Dragon', 'Alpha Ox']);
  });

  it('a challenge-rating filter cannot reorder results — the ranked objects carry no system data', async () => {
    install({ packs: [monsterPack([npc('Beta Watch'), npc('Alpha Watch')])] });
    const da = await makeDataAccess();

    // calculateRelevanceScore reads `entry.system.details.cr`, but what it is
    // handed is the already-built result envelope, which has no `system` at all.
    // Every result therefore scores the same CR bonus and ordering is unchanged.
    const withCr = await da.searchCompendium('watch', undefined, {
      challengeRating: { min: 0, max: 0 },
    });
    const withoutCr = await da.searchCompendium('watch');

    expect(withCr.map((r: any) => r.name)).toEqual(['Alpha Watch', 'Beta Watch']);
    expect(withCr.map((r: any) => r.name)).toEqual(withoutCr.map((r: any) => r.name));
  });

  it('a creatureType filter cannot contribute its score bonus either', async () => {
    install({ packs: [monsterPack([npc('Beta Watch'), npc('Alpha Watch')])] });
    const da = await makeDataAccess();

    // Same reason: the +20 creature-type bonus needs `system.details.type.value`.
    // The name-term bonus is all that survives, and it ties.
    const results = await da.searchCompendium('watch', undefined, { creatureType: 'watch' });

    expect(results.map((r: any) => r.name)).toEqual(['Alpha Watch', 'Beta Watch']);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// The two result limits
// ═════════════════════════════════════════════════════════════════════════════

describe('searchCompendium — result limits', () => {
  it('collects at most 100 entries and returns at most 50', async () => {
    // Inserted in DESCENDING name order, so the 100-entry collection cap and the
    // 50-result slice cut at different ends and both are observable.
    const entries = Array.from({ length: 120 }, (_, i) => {
      const n = 119 - i;
      return npc(`mob-${String(n).padStart(3, '0')}`);
    });
    install({ packs: [monsterPack(entries)] });
    const da = await makeDataAccess();

    const results = await da.searchCompendium('mob');

    expect(results).toHaveLength(50);
    // mob-119..mob-020 were collected (100), then sorted, then sliced to 50.
    expect(results[0].name).toBe('mob-020');
    expect(results[49].name).toBe('mob-069');
  });

  it('stops iterating packs once 100 entries are collected', async () => {
    const entries = Array.from({ length: 100 }, (_, i) => npc(`zz-${String(i).padStart(3, '0')}`));
    install({
      packs: [
        monsterPack(entries, { id: 'pack.first', label: 'First' }),
        monsterPack([npc('zz-aardvark')], { id: 'pack.second', label: 'Second' }),
      ],
    });
    const da = await makeDataAccess();

    const results = await da.searchCompendium('zz');

    // 'zz-aardvark' sorts first of all, so its absence is not a slicing artefact:
    // the second pack was never indexed.
    expect(world.packIndexCalls).toEqual(['pack.first']);
    expect(results.map((r: any) => r.name)).not.toContain('zz-aardvark');
    expect(results[0].name).toBe('zz-000');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// The enhanced-index branch of searchCompendium
// ═════════════════════════════════════════════════════════════════════════════

describe('searchCompendium — the enhanced-index branch', () => {
  const decoyPack = (): FakePackSpec => monsterPack([npc('Pack Decoy')]);

  it('delegates to listCreaturesByCriteria and does not search packs at all', async () => {
    install(
      withIndex(
        'dnd5e',
        [
          dnd5eCreature('Ancient Red Dragon', {
            challengeRating: 17,
            creatureType: 'dragon',
            size: 'huge',
            hasLegendaryActions: true,
            img: 'dragon.webp',
          }),
          dnd5eCreature('Guard', { creatureType: 'humanoid' }),
        ],
        { packs: [decoyPack()] }
      )
    );
    const da = await makeDataAccess();

    // The query matches NO pack entry. Everything returned came from the index.
    const results = await da.searchCompendium('zzzz', 'Actor', { creatureType: 'dragon' });

    expect(results).toEqual([
      {
        id: 'c-ancient-red-dragon',
        name: 'Ancient Red Dragon',
        type: 'npc',
        pack: 'dnd5e.monsters',
        packLabel: 'Monsters (SRD)',
        description: '',
        hasImage: true,
        summary: 'CR 17 dragon from Monsters (SRD)',
        challengeRating: 17,
        creatureType: 'dragon',
        size: 'huge',
        hasLegendaryActions: true,
      },
    ]);
    expect(world.packIndexCalls).toEqual([]);
  });

  it('takes the branch for a challengeRating filter and for hasLegendaryActions: true', async () => {
    install(
      withIndex(
        'dnd5e',
        [dnd5eCreature('Ancient Red Dragon', { challengeRating: 17, hasLegendaryActions: true })],
        { packs: [decoyPack()] }
      )
    );
    const da = await makeDataAccess();

    for (const filters of [{ challengeRating: 17 }, { hasLegendaryActions: true }]) {
      const results = await da.searchCompendium('zzzz', 'Actor', filters);
      expect(results.map((r: any) => r.name)).toEqual(['Ancient Red Dragon']);
    }
    expect(world.packIndexCalls).toEqual([]);
  });

  it('does NOT take the branch for hasLegendaryActions: FALSE — the guard is truthiness', async () => {
    install(
      withIndex('dnd5e', [dnd5eCreature('Index Only')], {
        packs: [monsterPack([npc('Decoy', { description: 'dragon' })])],
      })
    );
    const da = await makeDataAccess();

    // `filters.hasLegendaryActions` is checked for truthiness, not for
    // definedness, so asking for creatures WITHOUT legendary actions runs the
    // basic pack search instead.
    const results = await da.searchCompendium('decoy', 'Actor', { hasLegendaryActions: false });

    expect(results.map((r: any) => r.name)).toEqual(['Decoy']);
    expect(world.packIndexCalls).toEqual(['dnd5e.monsters']);
  });

  it('does NOT take the branch when the only filter is size or alignment', async () => {
    install(
      withIndex('dnd5e', [dnd5eCreature('Index Only')], { packs: [monsterPack([npc('Decoy')])] })
    );
    const da = await makeDataAccess();

    const results = await da.searchCompendium('decoy', 'Actor', { size: 'huge' });

    expect(results.map((r: any) => r.name)).toEqual(['Decoy']);
    expect(world.packIndexCalls).toEqual(['dnd5e.monsters']);
  });

  it('does NOT take the branch when packType is not Actor', async () => {
    install(
      withIndex('dnd5e', [dnd5eCreature('Index Only')], {
        // The description carries 'dragon' so the entry survives the criteria the
        // basic search derives from the same filter.
        packs: [monsterPack([npc('Decoy', { description: 'dragon' })])],
      })
    );
    const da = await makeDataAccess();

    const results = await da.searchCompendium('decoy', undefined, { creatureType: 'dragon' });

    expect(results.map((r: any) => r.name)).toEqual(['Decoy']);
  });

  it('does NOT take the branch when the enhanced index setting is off', async () => {
    install({
      systemId: 'dnd5e',
      settings: { enableEnhancedCreatureIndex: false },
      creatureIndex: { creatures: [dnd5eCreature('Index Only')] },
      packs: [monsterPack([npc('Decoy', { description: 'dragon' })])],
    });
    const da = await makeDataAccess();

    const results = await da.searchCompendium('decoy', 'Actor', { creatureType: 'dragon' });

    expect(results.map((r: any) => r.name)).toEqual(['Decoy']);
    expect(world.packIndexCalls).toEqual(['dnd5e.monsters']);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// listCreaturesByCriteria — one case per passes*Criteria branch
// ═════════════════════════════════════════════════════════════════════════════

describe('listCreaturesByCriteria — D&D 5e branch (also the fall-through default)', () => {
  it('filters on a scalar challenge rating and returns the full 5e envelope', async () => {
    install(
      withIndex('dnd5e', [
        dnd5eCreature('Goblin', { challengeRating: 0.25 }),
        dnd5eCreature('Ogre', { challengeRating: 5, hitPoints: 59, armorClass: 11 }),
        dnd5eCreature('Bugbear', { challengeRating: 5 }),
      ])
    );
    const da = await makeDataAccess();

    const { creatures } = await da.listCreaturesByCriteria({ challengeRating: 5 });

    expect(creatures.map((c: any) => c.name)).toEqual(['Bugbear', 'Ogre']);
    expect(creatures[1]).toEqual({
      id: 'c-ogre',
      name: 'Ogre',
      type: 'npc',
      pack: 'dnd5e.monsters',
      packLabel: 'Monsters (SRD)',
      description: '',
      hasImage: false,
      creatureType: 'humanoid',
      size: 'medium',
      hitPoints: 59,
      armorClass: 11,
      hasSpells: false,
      alignment: 'neutral',
      summary: 'CR 5 humanoid from Monsters (SRD)',
      challengeRating: 5,
      hasLegendaryActions: false,
    });
  });

  it('filters on the {min,max} challenge-rating form, and sorts by CR before name', async () => {
    install(
      withIndex('dnd5e', [
        dnd5eCreature('Aardvark', { challengeRating: 1 }),
        dnd5eCreature('Zeta Ogre', { challengeRating: 5 }),
        dnd5eCreature('Alpha Troll', { challengeRating: 8 }),
        dnd5eCreature('Aboleth', { challengeRating: 15 }),
      ])
    );
    const da = await makeDataAccess();

    const { creatures } = await da.listCreaturesByCriteria({
      challengeRating: { min: 2, max: 10 },
    });

    // Ascending challenge rating beats the alphabetical tiebreak.
    expect(creatures.map((c: any) => c.name)).toEqual(['Zeta Ogre', 'Alpha Troll']);
  });

  it('honours an open-ended range', async () => {
    install(
      withIndex('dnd5e', [
        dnd5eCreature('Low', { challengeRating: 1 }),
        dnd5eCreature('High', { challengeRating: 20 }),
      ])
    );
    const da = await makeDataAccess();

    expect(
      (await da.listCreaturesByCriteria({ challengeRating: { min: 10 } })).creatures.map(
        (c: any) => c.name
      )
    ).toEqual(['High']);
    expect(
      (await da.listCreaturesByCriteria({ challengeRating: { max: 10 } })).creatures.map(
        (c: any) => c.name
      )
    ).toEqual(['Low']);
  });

  it('matches creatureType and size case-insensitively, and hasSpells/hasLegendaryActions exactly', async () => {
    install(
      withIndex('dnd5e', [
        dnd5eCreature('Wyrm', {
          creatureType: 'Dragon',
          size: 'Huge',
          hasSpells: true,
          hasLegendaryActions: true,
        }),
        dnd5eCreature('Guard'),
      ])
    );
    const da = await makeDataAccess();

    const names = async (criteria: Record<string, unknown>): Promise<string[]> =>
      (await da.listCreaturesByCriteria(criteria)).creatures.map((c: any) => c.name);

    expect(await names({ creatureType: 'dragon' })).toEqual(['Wyrm']);
    expect(await names({ size: 'huge' })).toEqual(['Wyrm']);
    expect(await names({ hasSpells: true })).toEqual(['Wyrm']);
    expect(await names({ hasLegendaryActions: false })).toEqual(['Guard']);
  });

  it('a record with none of the three discriminators falls through to the 5e branch', async () => {
    install(
      withIndex('dnd5e', [
        { id: 'bare', name: 'Bare Record', type: 'npc', pack: 'p', packLabel: 'P' },
      ])
    );
    const da = await makeDataAccess();

    const { creatures } = await da.listCreaturesByCriteria({});

    // Read as a 5e record it has no CR and no creature type, and the summary
    // says so out loud. Pinned as-is.
    expect(creatures).toEqual([
      {
        id: 'bare',
        name: 'Bare Record',
        type: 'npc',
        pack: 'p',
        packLabel: 'P',
        description: '',
        hasImage: false,
        creatureType: undefined,
        size: undefined,
        hitPoints: undefined,
        armorClass: undefined,
        hasSpells: undefined,
        alignment: undefined,
        summary: 'CR undefined undefined from P',
        challengeRating: undefined,
        hasLegendaryActions: undefined,
      },
    ]);
  });
});

describe('listCreaturesByCriteria — PF2e branch', () => {
  it('filters on level and returns the full PF2e envelope', async () => {
    install(
      withIndex('pf2e', [
        pf2eCreature('Goblin Warrior', { level: 1 }),
        pf2eCreature('Young Red Dragon', {
          level: 4,
          traits: ['dragon', 'fire'],
          creatureType: 'dragon',
          rarity: 'uncommon',
          size: 'large',
          hitPoints: 60,
          armorClass: 21,
          hasSpells: true,
          img: 'wyrm.webp',
        }),
      ])
    );
    const da = await makeDataAccess();

    const { creatures } = await da.listCreaturesByCriteria({ level: { min: 3, max: 6 } });

    expect(creatures).toEqual([
      {
        id: 'c-young-red-dragon',
        name: 'Young Red Dragon',
        type: 'npc',
        pack: 'pf2e.pathfinder-bestiary',
        packLabel: 'Bestiary',
        description: '',
        hasImage: true,
        creatureType: 'dragon',
        size: 'large',
        hitPoints: 60,
        armorClass: 21,
        hasSpells: true,
        alignment: 'neutral',
        summary: 'Level 4 dragon (uncommon) from Bestiary',
        level: 4,
        traits: ['dragon', 'fire'],
        rarity: 'uncommon',
      },
    ]);
  });

  it('a scalar level is an exact match', async () => {
    install(
      withIndex('pf2e', [pf2eCreature('Four', { level: 4 }), pf2eCreature('Five', { level: 5 })])
    );
    const da = await makeDataAccess();

    expect(
      (await da.listCreaturesByCriteria({ level: 4 })).creatures.map((c: any) => c.name)
    ).toEqual(['Four']);
  });

  it('an empty level range defaults to -1..25 rather than to unbounded', async () => {
    install(
      withIndex('pf2e', [
        pf2eCreature('Minus One', { level: -1 }),
        pf2eCreature('Twenty Five', { level: 25 }),
        pf2eCreature('Twenty Six', { level: 26 }),
      ])
    );
    const da = await makeDataAccess();

    const { creatures } = await da.listCreaturesByCriteria({ level: {} });

    expect(creatures.map((c: any) => c.name)).toEqual(['Minus One', 'Twenty Five']);
  });

  it('requires ALL requested traits, case-insensitively', async () => {
    install(
      withIndex('pf2e', [
        pf2eCreature('Fire Drake', { traits: ['Dragon', 'Fire'] }),
        pf2eCreature('Ice Drake', { traits: ['dragon', 'cold'] }),
      ])
    );
    const da = await makeDataAccess();

    const names = async (criteria: Record<string, unknown>): Promise<string[]> =>
      (await da.listCreaturesByCriteria(criteria)).creatures.map((c: any) => c.name);

    expect(await names({ traits: ['dragon'] })).toEqual(['Fire Drake', 'Ice Drake']);
    expect(await names({ traits: ['dragon', 'fire'] })).toEqual(['Fire Drake']);
    expect(await names({ traits: [] })).toEqual(['Fire Drake', 'Ice Drake']);
  });

  it('reads size and creatureType from their OWN fields', async () => {
    // Chosen so that comparing `size` against `creatureType` (or the reverse)
    // changes which creature comes back.
    install(
      withIndex('pf2e', [
        pf2eCreature('Big Goblin', { creatureType: 'humanoid', size: 'large', hasSpells: true }),
        pf2eCreature('Small Drake', { creatureType: 'dragon', size: 'small' }),
      ])
    );
    const da = await makeDataAccess();

    const names = async (criteria: Record<string, unknown>): Promise<string[]> =>
      (await da.listCreaturesByCriteria(criteria)).creatures.map((c: any) => c.name);

    expect(await names({ size: 'large' })).toEqual(['Big Goblin']);
    expect(await names({ creatureType: 'dragon' })).toEqual(['Small Drake']);
    expect(await names({ size: 'dragon' })).toEqual([]);
    expect(await names({ creatureType: 'large' })).toEqual([]);
    expect(await names({ hasSpells: true })).toEqual(['Big Goblin']);
    expect(await names({ hasSpells: false })).toEqual(['Small Drake']);
  });

  it('matches rarity EXACTLY (not case-insensitively, unlike its neighbours)', async () => {
    install(
      withIndex('pf2e', [
        pf2eCreature('Rare One', { rarity: 'rare' }),
        pf2eCreature('Common One', { rarity: 'common' }),
      ])
    );
    const da = await makeDataAccess();

    const names = async (criteria: Record<string, unknown>): Promise<string[]> =>
      (await da.listCreaturesByCriteria(criteria)).creatures.map((c: any) => c.name);

    expect(await names({ rarity: 'rare' })).toEqual(['Rare One']);
    expect(await names({ rarity: 'Rare' })).toEqual([]);
  });

  it('sorts by level before name', async () => {
    install(
      withIndex('pf2e', [pf2eCreature('Zeta', { level: 1 }), pf2eCreature('Alpha', { level: 9 })])
    );
    const da = await makeDataAccess();

    expect((await da.listCreaturesByCriteria({})).creatures.map((c: any) => c.name)).toEqual([
      'Zeta',
      'Alpha',
    ]);
  });
});

describe('listCreaturesByCriteria — Cosmere RPG branch', () => {
  it('filters on a tier range and returns the full Cosmere envelope', async () => {
    install(
      withIndex('cosmere-rpg', [
        cosmereCreature('Thug', { tier: 1 }),
        cosmereCreature('Skybreaker', {
          tier: 2,
          role: 'rival',
          creatureType: 'humanoid',
          subtype: 'radiant',
          size: 'medium',
          hitPoints: 40,
          focus: 4,
          investiture: 6,
          hasInvestiture: true,
          defensePhysical: 13,
          defenseCognitive: 12,
          defenseSpiritual: 11,
          deflect: 4,
          walkSpeed: 30,
          img: 'sky.webp',
        }),
        cosmereCreature('Highprince', { tier: 4 }),
      ])
    );
    const da = await makeDataAccess();

    const { creatures } = await da.listCreaturesByCriteria({ tier: { min: 2, max: 3 } });

    expect(creatures).toEqual([
      {
        id: 'c-skybreaker',
        name: 'Skybreaker',
        type: 'adversary',
        pack: 'cosmere-rpg.adversaries',
        packLabel: 'Adversaries',
        description: '',
        hasImage: true,
        creatureType: 'humanoid',
        size: 'medium',
        hitPoints: 40,
        summary: 'Tier 2 rival humanoid from Adversaries',
        tier: 2,
        role: 'rival',
        subtype: 'radiant',
        focus: 4,
        investiture: 6,
        hasInvestiture: true,
        defenses: { physical: 13, cognitive: 12, spiritual: 11 },
        deflect: 4,
        walkSpeed: 30,
      },
    ]);
  });

  it('a scalar tier is an exact match, and role/creatureType/size are case-insensitive', async () => {
    install(
      withIndex('cosmere-rpg', [
        cosmereCreature('Boss', { tier: 3, role: 'Boss', creatureType: 'Spren', size: 'Large' }),
        cosmereCreature('Minion', { tier: 1 }),
      ])
    );
    const da = await makeDataAccess();

    const names = async (criteria: Record<string, unknown>): Promise<string[]> =>
      (await da.listCreaturesByCriteria(criteria)).creatures.map((c: any) => c.name);

    expect(await names({ tier: 3 })).toEqual(['Boss']);
    expect(await names({ role: 'boss' })).toEqual(['Boss']);
    expect(await names({ creatureType: 'spren' })).toEqual(['Boss']);
    expect(await names({ size: 'large' })).toEqual(['Boss']);
  });

  it('accepts `health` as a synonym for `hitPoints`', async () => {
    install(
      withIndex('cosmere-rpg', [
        cosmereCreature('Tough', { hitPoints: 40 }),
        cosmereCreature('Frail', { hitPoints: 8 }),
      ])
    );
    const da = await makeDataAccess();

    const names = async (criteria: Record<string, unknown>): Promise<string[]> =>
      (await da.listCreaturesByCriteria(criteria)).creatures.map((c: any) => c.name);

    expect(await names({ health: { min: 20 } })).toEqual(['Tough']);
    expect(await names({ hitPoints: { min: 20 } })).toEqual(['Tough']);
    expect(await names({ health: 8 })).toEqual(['Frail']);
    // `hitPoints` wins when both are given.
    expect(await names({ hitPoints: 8, health: 40 })).toEqual(['Frail']);
  });

  it('filters on hasInvestiture and a deflect minimum', async () => {
    install(
      withIndex('cosmere-rpg', [
        cosmereCreature('Radiant', { hasInvestiture: true, deflect: 5 }),
        cosmereCreature('Mundane'),
      ])
    );
    const da = await makeDataAccess();

    const names = async (criteria: Record<string, unknown>): Promise<string[]> =>
      (await da.listCreaturesByCriteria(criteria)).creatures.map((c: any) => c.name);

    expect(await names({ hasInvestiture: true })).toEqual(['Radiant']);
    expect(await names({ hasInvestiture: false })).toEqual(['Mundane']);
    expect(await names({ deflectMin: 5 })).toEqual(['Radiant']);
    expect(await names({ deflectMin: 6 })).toEqual([]);
  });

  it('reads each per-defence minimum from its OWN defence field', async () => {
    // The three defences are deliberately far apart per creature, so reading the
    // wrong one — the realistic transcription slip in a three-line block of
    // near-identical comparisons — changes which creature comes back.
    install(
      withIndex('cosmere-rpg', [
        cosmereCreature('Bulwark', {
          defensePhysical: 16,
          defenseCognitive: 8,
          defenseSpiritual: 9,
        }),
        cosmereCreature('Seer', {
          defensePhysical: 8,
          defenseCognitive: 16,
          defenseSpiritual: 9,
        }),
      ])
    );
    const da = await makeDataAccess();

    const names = async (criteria: Record<string, unknown>): Promise<string[]> =>
      (await da.listCreaturesByCriteria(criteria)).creatures.map((c: any) => c.name);

    expect(await names({ defensesMin: { phy: 12 } })).toEqual(['Bulwark']);
    expect(await names({ defensesMin: { cog: 12 } })).toEqual(['Seer']);
    expect(await names({ defensesMin: { spi: 12 } })).toEqual([]);
    expect(await names({ defensesMin: { spi: 9 } })).toEqual(['Bulwark', 'Seer']);
    // Every named minimum has to hold, so no creature satisfies both.
    expect(await names({ defensesMin: { phy: 12, cog: 12 } })).toEqual([]);
  });

  it('sorts by tier before name', async () => {
    install(
      withIndex('cosmere-rpg', [
        cosmereCreature('Zeta', { tier: 1 }),
        cosmereCreature('Alpha', { tier: 4 }),
      ])
    );
    const da = await makeDataAccess();

    expect((await da.listCreaturesByCriteria({})).creatures.map((c: any) => c.name)).toEqual([
      'Zeta',
      'Alpha',
    ]);
  });
});

describe('listCreaturesByCriteria — MGT2e branch', () => {
  it('filters on a hits range and returns the full MGT2e envelope', async () => {
    install(
      withIndex('mgt2e', [
        mgt2eCreature('Rat', { hits: 4 }),
        mgt2eCreature('Sand Lizard', {
          hits: 14,
          creatureType: 'reptile',
          hasPsionics: true,
          characteristics: { STR: { value: 10, dm: 1 }, DEX: { value: 5, dm: -1 } },
          img: 'lizard.webp',
        }),
      ])
    );
    const da = await makeDataAccess();

    const { creatures } = await da.listCreaturesByCriteria({ minHits: 10 });

    expect(creatures).toEqual([
      {
        id: 'c-sand-lizard',
        name: 'Sand Lizard',
        type: 'npc',
        pack: 'mgt2e.creatures',
        packLabel: 'Traveller Bestiary',
        description: '',
        hasImage: true,
        creatureType: 'reptile',
        size: undefined,
        hitPoints: undefined,
        hits: 14,
        hasPsionics: true,
        characteristics: { STR: { value: 10, dm: 1 }, DEX: { value: 5, dm: -1 } },
        summary: 'npc — 14 hits, reptile (STR DM+1, DEX DM-1) from Traveller Bestiary',
      },
    ]);
  });

  it('filters on maxHits, hasPsionics, creatureType and actorType', async () => {
    install(
      withIndex('mgt2e', [
        mgt2eCreature('Psi Hound', { hits: 6, hasPsionics: true, creatureType: 'canine' }),
        mgt2eCreature('Freighter', { hits: 30, type: 'spacecraft' }),
      ])
    );
    const da = await makeDataAccess();

    const names = async (criteria: Record<string, unknown>): Promise<string[]> =>
      (await da.listCreaturesByCriteria(criteria)).creatures.map((c: any) => c.name);

    expect(await names({ maxHits: 10 })).toEqual(['Psi Hound']);
    expect(await names({ hasPsionics: true })).toEqual(['Psi Hound']);
    // creatureType is compared EXACTLY here, unlike the other three branches.
    expect(await names({ creatureType: 'canine' })).toEqual(['Psi Hound']);
    expect(await names({ creatureType: 'Canine' })).toEqual([]);
    expect(await names({ actorType: 'spacecraft' })).toEqual(['Freighter']);
  });

  it('omits the creature type from the summary when there is none', async () => {
    install(withIndex('mgt2e', [mgt2eCreature('Anon', { hits: 3, creatureType: '' })]));
    const da = await makeDataAccess();

    const { creatures } = await da.listCreaturesByCriteria({});

    expect(creatures[0].summary).toBe('npc — 3 hits (STR DM+0, DEX DM+0) from Traveller Bestiary');
  });

  it('sorts by hits before name', async () => {
    install(
      withIndex('mgt2e', [mgt2eCreature('Zeta', { hits: 2 }), mgt2eCreature('Alpha', { hits: 9 })])
    );
    const da = await makeDataAccess();

    expect((await da.listCreaturesByCriteria({})).creatures.map((c: any) => c.name)).toEqual([
      'Zeta',
      'Alpha',
    ]);
  });
});

describe('listCreaturesByCriteria — branch routing', () => {
  it('MGT2e needs BOTH hits and hasPsionics; hits alone is not enough', async () => {
    install(
      withIndex('mgt2e', [
        { id: 'h', name: 'Hits Only', type: 'npc', pack: 'p', packLabel: 'P', hits: 5 },
      ])
    );
    const da = await makeDataAccess();

    // Routed to the 5e branch, so an MGT2e criterion is simply ignored.
    const { creatures } = await da.listCreaturesByCriteria({ minHits: 99 });

    expect(creatures.map((c: any) => c.name)).toEqual(['Hits Only']);
    expect(creatures[0].summary).toBe('CR undefined undefined from P');
  });

  it('MGT2e is checked before tier, so hits+hasPsionics wins over a tier field', async () => {
    install(
      withIndex('mgt2e', [
        mgt2eCreature('Hybrid', { hits: 7, hasPsionics: true, tier: 1, role: 'minion' }),
      ])
    );
    const da = await makeDataAccess();

    // A tier criterion the Cosmere branch would have enforced is ignored.
    const { creatures } = await da.listCreaturesByCriteria({ tier: 99 });

    expect(creatures.map((c: any) => c.name)).toEqual(['Hybrid']);
    expect(creatures[0].hits).toBe(7);
  });

  it('tier is checked before level, so a record with both routes to Cosmere', async () => {
    install(withIndex('cosmere-rpg', [cosmereCreature('Both', { tier: 2, level: 4 })]));
    const da = await makeDataAccess();

    const names = async (criteria: Record<string, unknown>): Promise<string[]> =>
      (await da.listCreaturesByCriteria(criteria)).creatures.map((c: any) => c.name);

    // The Cosmere branch enforces tier and ignores level.
    expect(await names({ tier: 99 })).toEqual([]);
    expect(await names({ level: 99 })).toEqual(['Both']);
  });
});

describe('listCreaturesByCriteria — limit and search summary', () => {
  const four = (): Record<string, any>[] => [
    dnd5eCreature('A', { challengeRating: 1 }),
    dnd5eCreature('B', { challengeRating: 2 }),
    dnd5eCreature('C', { challengeRating: 3, pack: 'other.pack', packLabel: 'Other' }),
    dnd5eCreature('D', { challengeRating: 4 }),
  ];

  it('truncates to the requested limit, keeping the lowest power levels', async () => {
    install(withIndex('dnd5e', four()));
    const da = await makeDataAccess();

    const { creatures, searchSummary } = await da.listCreaturesByCriteria({ limit: 2 });

    expect(creatures.map((c: any) => c.name)).toEqual(['A', 'B']);
    // totalCreaturesFound counts what SURVIVED the limit, not what matched.
    expect(searchSummary.totalCreaturesFound).toBe(2);
  });

  it('defaults the limit to 500', async () => {
    install(withIndex('dnd5e', four()));
    const da = await makeDataAccess();

    const { creatures } = await da.listCreaturesByCriteria({});

    expect(creatures).toHaveLength(4);
  });

  it('reports the pack distribution and index metadata', async () => {
    install(withIndex('dnd5e', four()));
    const da = await makeDataAccess();

    const { searchSummary } = await da.listCreaturesByCriteria({ challengeRating: { min: 2 } });

    expect(searchSummary).toEqual({
      // Counted across the WHOLE index, not across the filtered results.
      packsSearched: 2,
      topPacks: [
        { id: 'dnd5e.monsters', label: 'Monsters (SRD)', priority: 100 },
        { id: 'other.pack', label: 'Other', priority: 100 },
      ],
      totalCreaturesFound: 3,
      resultsByPack: { 'Monsters (SRD)': 2, Other: 1 },
      criteria: { challengeRating: { min: 2 } },
      indexMetadata: {
        totalIndexedCreatures: 4,
        searchMethod: 'enhanced_persistent_index',
      },
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// fallbackBasicCreatureSearch — the recursion, un-stubbed
// ═════════════════════════════════════════════════════════════════════════════

describe('fallbackBasicCreatureSearch', () => {
  it('runs when the enhanced index is disabled, and really calls searchCompendium', async () => {
    install({
      settings: { enableEnhancedCreatureIndex: false },
      packs: [
        monsterPack([
          npc('Adult Dragon Champion'),
          npc('Ancient Dragon'),
          npc('Adult Wolf Champion'),
        ]),
      ],
    });
    const da = await makeDataAccess();

    const { creatures, searchSummary } = await da.listCreaturesByCriteria({
      creatureType: 'dragon',
      challengeRating: 12,
    });

    // The fallback builds the query 'dragon adult champion' from the criteria and
    // hands it to the real searchCompendium, whose name match requires EVERY
    // term. Only one entry contains all three words — which is only true if the
    // query string was built exactly this way and actually executed.
    expect(creatures.map((c: any) => c.name)).toEqual(['Adult Dragon Champion']);
    expect(world.packIndexCalls).toEqual(['dnd5e.monsters']);

    // The results are searchCompendium envelopes, not index records.
    expect(creatures[0]).toEqual({
      id: 'id-adult-dragon-champion',
      name: 'Adult Dragon Champion',
      type: 'npc',
      img: undefined,
      pack: 'dnd5e.monsters',
      packLabel: 'Monsters (SRD)',
      description: '',
      hasImage: false,
      summary: 'npc from Monsters (SRD)',
    });

    expect(searchSummary).toEqual({
      packsSearched: 0,
      topPacks: [],
      totalCreaturesFound: 1,
      resultsByPack: {},
      criteria: { creatureType: 'dragon', challengeRating: 12 },
      fallback: true,
      searchMethod: 'basic_fallback',
    });
  });

  it("falls back to the literal query 'monster' when the criteria yield no terms", async () => {
    install({
      settings: { enableEnhancedCreatureIndex: false },
      packs: [monsterPack([npc('Monster'), npc('Dragon')])],
    });
    const da = await makeDataAccess();

    // A challenge rating below 5 contributes no term at all — there is no `else`
    // arm under the CR bands here.
    for (const criteria of [{}, { challengeRating: 2 }]) {
      const { creatures } = await da.listCreaturesByCriteria(criteria);
      expect(creatures.map((c: any) => c.name)).toEqual(['Monster']);
    }
  });

  it('derives the query from the CR bands, pinned at each boundary', async () => {
    install({
      settings: { enableEnhancedCreatureIndex: false },
      packs: [
        monsterPack([
          npc('Ancient Legendary Wyrm'),
          npc('Adult Champion Wyrm'),
          npc('Captain Knight Wyrm'),
          npc('Monster'),
        ]),
      ],
    });
    const da = await makeDataAccess();

    const names = async (challengeRating: number): Promise<string[]> =>
      (await da.listCreaturesByCriteria({ challengeRating })).creatures.map((c: any) => c.name);

    expect(await names(15)).toEqual(['Ancient Legendary Wyrm']);
    expect(await names(14)).toEqual(['Adult Champion Wyrm']);
    expect(await names(10)).toEqual(['Adult Champion Wyrm']);
    expect(await names(9)).toEqual(['Captain Knight Wyrm']);
    expect(await names(5)).toEqual(['Captain Knight Wyrm']);
    // Below 5 there is no band at all, so the query degrades to 'monster'.
    expect(await names(4)).toEqual(['Monster']);
  });

  it('slices the results to the limit while still reporting the full count', async () => {
    install({
      settings: { enableEnhancedCreatureIndex: false },
      packs: [monsterPack([npc('Monster A'), npc('Monster B')])],
    });
    const da = await makeDataAccess();

    const { creatures, searchSummary } = await da.listCreaturesByCriteria({ limit: 1 });

    expect(creatures.map((c: any) => c.name)).toEqual(['Monster A']);
    expect(searchSummary.totalCreaturesFound).toBe(2);
  });

  it('also runs when the enhanced index is enabled but building it throws', async () => {
    install({
      systemId: 'dnd5e',
      settings: { enableEnhancedCreatureIndex: true },
      failIndexWrite: true,
      packs: [monsterPack([npc('Monster', { doc: { _id: 'd1', name: 'Monster', type: 'npc' } })])],
    });
    const da = await makeDataAccess();

    const { creatures, searchSummary } = await da.listCreaturesByCriteria({});

    // The index build reached its write and failed there, so the failure is real
    // and not a short-circuit before any work happened.
    expect(world.fileUploads).toHaveLength(1);
    expect(world.files.size).toBe(0);
    expect(searchSummary.fallback).toBe(true);
    expect(searchSummary.searchMethod).toBe('basic_fallback');
    expect(creatures.map((c: any) => c.name)).toEqual(['Monster']);
  });

  it('drives the whole three-cycle in one call: searchCompendium → listCreaturesByCriteria → fallbackBasicCreatureSearch → searchCompendium', async () => {
    install({
      systemId: 'dnd5e',
      settings: { enableEnhancedCreatureIndex: true },
      failIndexWrite: true,
      packs: [
        monsterPack([
          npc('Dragon Whelp', { doc: { _id: 'd1', name: 'Dragon Whelp', type: 'npc' } }),
        ]),
      ],
    });
    const da = await makeDataAccess();

    // 'zzzz' matches no pack entry. The result below can only exist if:
    //   1. searchCompendium took the enhanced branch and called
    //      listCreaturesByCriteria;
    //   2. listCreaturesByCriteria's index build failed and it called
    //      fallbackBasicCreatureSearch;
    //   3. the fallback derived the query 'dragon' from the filters and called
    //      searchCompendium AGAIN, which is what actually found 'Dragon Whelp';
    //   4. the outer searchCompendium mapped that envelope into its enhanced
    //      result shape — which is why the summary reads 'CR undefined
    //      undefined': a searchCompendium envelope has no CR and no creature
    //      type to put there.
    // Break any edge of that cycle and this assertion cannot hold.
    const results = await da.searchCompendium('zzzz', 'Actor', { creatureType: 'dragon' });

    expect(results).toEqual([
      {
        id: 'id-dragon-whelp',
        name: 'Dragon Whelp',
        type: 'npc',
        pack: 'dnd5e.monsters',
        packLabel: 'Monsters (SRD)',
        description: '',
        hasImage: false,
        summary: 'CR undefined undefined from Monsters (SRD)',
        challengeRating: undefined,
        creatureType: undefined,
        size: undefined,
        hasLegendaryActions: undefined,
      },
    ]);
    expect(world.fileUploads).toHaveLength(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// getCompendiumDocumentFull — the four sanitisation sites
// ═════════════════════════════════════════════════════════════════════════════

describe('getCompendiumDocumentFull', () => {
  const dragonDoc = (): Record<string, any> => ({
    _id: 'doc1',
    name: 'Ancient Red Dragon',
    type: 'npc',
    img: 'dragon.webp',
    system: {
      cr: 17,
      secret: 'system-secret',
      _stats: { modifiedTime: 1 },
      nested: { password: 'p', keep: 1 },
    },
    items: [
      {
        id: 'i1',
        name: 'Bite',
        type: 'weapon',
        img: 'bite.webp',
        system: { damage: '2d10', token: 'item-token', advancement: ['bloat'] },
      },
    ],
    effects: [
      {
        id: 'e1',
        name: 'Frightful Presence',
        icon: 'fear.svg',
        disabled: false,
        duration: { seconds: 60, session: 'effect-session', _cache: { x: 1 } },
      },
    ],
  });

  const dragonPack = (): FakePackSpec =>
    monsterPack([{ _id: 'doc1', name: 'Ancient Red Dragon', type: 'npc', doc: dragonDoc() }]);

  it('throws when the pack does not exist', async () => {
    install({ packs: [dragonPack()] });
    const da = await makeDataAccess();

    await expect(da.getCompendiumDocumentFull('nope.pack', 'doc1')).rejects.toThrow(
      'Compendium pack nope.pack not found'
    );
  });

  it('throws when the document does not exist in the pack', async () => {
    install({ packs: [dragonPack()] });
    const da = await makeDataAccess();

    await expect(da.getCompendiumDocumentFull('dnd5e.monsters', 'nope')).rejects.toThrow(
      'Document nope not found in pack dnd5e.monsters'
    );
  });

  it('returns the document envelope', async () => {
    install({ packs: [dragonPack()] });
    const da = await makeDataAccess();

    const entry = await da.getCompendiumDocumentFull('dnd5e.monsters', 'doc1');

    expect(entry.id).toBe('doc1');
    expect(entry.name).toBe('Ancient Red Dragon');
    expect(entry.type).toBe('npc');
    expect(entry.img).toBe('dragon.webp');
    expect(entry.pack).toBe('dnd5e.monsters');
    expect(entry.packLabel).toBe('Monsters (SRD)');
  });

  it('sanitisation site 1 of 4: `system`', async () => {
    install({ packs: [dragonPack()] });
    const da = await makeDataAccess();

    const entry = await da.getCompendiumDocumentFull('dnd5e.monsters', 'doc1');

    expect(entry.system).toEqual({ cr: 17, nested: { keep: 1 } });
  });

  it('sanitisation site 2 of 4: `fullData`', async () => {
    install({ packs: [dragonPack()] });
    const da = await makeDataAccess();

    const entry = await da.getCompendiumDocumentFull('dnd5e.monsters', 'doc1');

    // _id survives (it is the one underscore key kept); _stats and the sensitive
    // keys do not.
    expect(entry.fullData._id).toBe('doc1');
    expect(entry.fullData.system).toEqual({ cr: 17, nested: { keep: 1 } });
    expect(entry.fullData.items[0].system).toEqual({ damage: '2d10' });
    expect(entry.fullData.effects[0].duration).toEqual({ seconds: 60 });
  });

  it('sanitisation site 3 of 4: each item `system`', async () => {
    install({ packs: [dragonPack()] });
    const da = await makeDataAccess();

    const entry = await da.getCompendiumDocumentFull('dnd5e.monsters', 'doc1');

    expect(entry.items).toEqual([
      { id: 'i1', name: 'Bite', type: 'weapon', img: 'bite.webp', system: { damage: '2d10' } },
    ]);
  });

  it('sanitisation site 4 of 4: each effect `duration`', async () => {
    install({ packs: [dragonPack()] });
    const da = await makeDataAccess();

    const entry = await da.getCompendiumDocumentFull('dnd5e.monsters', 'doc1');

    expect(entry.effects).toEqual([
      {
        id: 'e1',
        name: 'Frightful Presence',
        icon: 'fear.svg',
        disabled: false,
        duration: { seconds: 60 },
      },
    ]);
  });

  it('the sanitiser really walks the document: a cycle comes back marked, not dropped', async () => {
    const doc: Record<string, any> = { _id: 'doc1', name: 'Loop', type: 'npc', system: {} };
    doc.self = doc;
    install({ packs: [monsterPack([{ _id: 'doc1', name: 'Loop', type: 'npc', doc }])] });
    const da = await makeDataAccess();

    const entry = await da.getCompendiumDocumentFull('dnd5e.monsters', 'doc1');

    // A raw JSON.stringify would have thrown and yielded `{}`; the marker proves
    // removeSensitiveFields walked it first.
    expect(entry.fullData.self).toBe('[Circular Reference]');
    expect(entry.fullData.name).toBe('Loop');
  });

  it('omits items and effects entirely when the document has neither', async () => {
    install({
      packs: [
        monsterPack([
          { _id: 'doc2', name: 'Plain', type: 'npc', doc: { _id: 'doc2', name: 'Plain' } },
        ]),
      ],
    });
    const da = await makeDataAccess();

    const entry = await da.getCompendiumDocumentFull('dnd5e.monsters', 'doc2');

    expect(entry.items).toBeUndefined();
    expect(entry.effects).toBeUndefined();
    expect(entry.type).toBe('unknown');
    expect(entry.img).toBeUndefined();
    expect(entry.system).toEqual({});
  });

  it('falls back through effect.name → effect.label → "Unknown Effect"', async () => {
    install({
      packs: [
        monsterPack([
          {
            _id: 'doc3',
            name: 'Effects',
            type: 'npc',
            doc: {
              _id: 'doc3',
              name: 'Effects',
              effects: [{ id: 'e1', label: 'Legacy Label' }, { id: 'e2' }],
            },
          },
        ]),
      ],
    });
    const da = await makeDataAccess();

    const entry = await da.getCompendiumDocumentFull('dnd5e.monsters', 'doc3');

    expect(entry.effects).toEqual([
      { id: 'e1', name: 'Legacy Label', icon: undefined, disabled: false, duration: {} },
      { id: 'e2', name: 'Unknown Effect', icon: undefined, disabled: false, duration: {} },
    ]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// getAvailablePacks
// ═════════════════════════════════════════════════════════════════════════════

describe('getAvailablePacks', () => {
  it('projects every pack, including Scene packs, onto its metadata', async () => {
    install({
      packs: [
        monsterPack([npc('Goblin')], { system: 'dnd5e' }),
        { id: 'world.maps', label: 'Maps', type: 'Scene', entries: [], private: true },
      ],
    });
    const da = await makeDataAccess();

    // Unlike searchCompendium, this one applies no type filter of any kind.
    expect(await da.getAvailablePacks()).toEqual([
      {
        id: 'dnd5e.monsters',
        label: 'Monsters (SRD)',
        type: 'Actor',
        system: 'dnd5e',
        private: false,
      },
      { id: 'world.maps', label: 'Maps', type: 'Scene', system: undefined, private: true },
    ]);
  });

  it('returns an empty list for a world with no packs', async () => {
    install();
    const da = await makeDataAccess();

    expect(await da.getAvailablePacks()).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// getEnhancedCreatureIndex + rebuildEnhancedCreatureIndex — the shared instance
// ═════════════════════════════════════════════════════════════════════════════

describe('the enhanced creature index is one instance, shared by writer and reader', () => {
  it('constructing FoundryDataAccess creates EXACTLY ONE PersistentCreatureIndex', async () => {
    install();
    await makeDataAccess();

    // PersistentCreatureIndex's constructor is the only thing in this package
    // that registers these five hooks, and it registers each exactly once. So
    // this list IS the instance count. A second index constructed anywhere in
    // the object graph — for instance by a collaborator that builds its own
    // instead of receiving the facade's — doubles it.
    expect(world.hooks).toEqual([
      'createDocument',
      'updateDocument',
      'deleteDocument',
      'createCompendium',
      'deleteCompendium',
    ]);
  });

  it('a rebuild through the facade is observed by a read through the facade', async () => {
    install({
      systemId: 'dnd5e',
      settings: { enableEnhancedCreatureIndex: true },
      // A pre-existing, VALID index, so a read without a rebuild is served from it.
      creatureIndex: { creatures: [dnd5eCreature('Stale Decoy')] },
      packs: [
        monsterPack([
          {
            _id: 'd1',
            name: 'Ogre',
            type: 'npc',
            doc: {
              _id: 'd1',
              name: 'Ogre',
              type: 'npc',
              img: 'ogre.webp',
              system: {
                details: { cr: 2, type: { value: 'giant' }, alignment: 'chaotic evil' },
                traits: { size: 'lg' },
                attributes: { hp: { max: 59 }, ac: { value: 11 } },
              },
            },
          },
        ]),
      ],
    });
    const da = await makeDataAccess();

    // Before: the reader sees the decoy, so the decoy is genuinely live.
    expect((await da.getEnhancedCreatureIndex()).map((c: any) => c.name)).toEqual(['Stale Decoy']);

    const rebuild = await da.rebuildEnhancedCreatureIndex();
    expect(rebuild).toEqual({
      success: true,
      totalCreatures: 1,
      message: 'Enhanced creature index rebuilt: 1 creatures indexed from all packs',
    });

    // After: the reader sees what the rebuild produced, and no longer the decoy.
    const read = await da.getEnhancedCreatureIndex();
    expect(read.map((c: any) => c.name)).toEqual(['Ogre']);
    expect(read[0]).toMatchObject({
      id: 'd1',
      pack: 'dnd5e.monsters',
      packLabel: 'Monsters (SRD)',
      challengeRating: 2,
      creatureType: 'giant',
      size: 'lg',
      hitPoints: 59,
      armorClass: 11,
      alignment: 'chaotic evil',
    });
    // The rebuild wrote, and the read went back through what it wrote.
    expect(world.fileUploads).toEqual(['worlds/test-world/enhanced-creature-index.json']);
    expect(world.fileFetches).toContain('worlds/test-world/enhanced-creature-index.json');
  });

  it('reports a rebuild failure as a result rather than throwing', async () => {
    install({
      systemId: 'dnd5e',
      failIndexWrite: true,
      packs: [monsterPack([npc('Ogre', { doc: { _id: 'd1', name: 'Ogre', type: 'npc' } })])],
    });
    const da = await makeDataAccess();

    expect(await da.rebuildEnhancedCreatureIndex()).toEqual({
      success: false,
      totalCreatures: 0,
      message: 'Failed to rebuild index: File upload failed',
    });
  });

  it('the read validates Foundry state first', async () => {
    install({ creatureIndex: { creatures: [dnd5eCreature('Anything')] } });
    const da = await makeDataAccess();
    (globalThis as any).game.ready = false;

    await expect(da.getEnhancedCreatureIndex()).rejects.toThrow('Foundry VTT is not ready');
  });

  it('the read returns the persisted records verbatim', async () => {
    const creatures = [dnd5eCreature('Ogre', { challengeRating: 2 })];
    install({ systemId: 'dnd5e', creatureIndex: { creatures } });
    const da = await makeDataAccess();

    expect(await da.getEnhancedCreatureIndex()).toEqual(creatures);
  });

  it('the read returns an empty list for a system with no index builder', async () => {
    // 'worldofdarkness' has no enhanced-index builder, so there is nothing to
    // load and nothing to build.
    install({ packs: [monsterPack([npc('Ogre')])] });
    const da = await makeDataAccess();

    expect(await da.getEnhancedCreatureIndex()).toEqual([]);
  });
});
