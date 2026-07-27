/**
 * CHARACTERIZATION tests for the actor-mechanics builder cluster of
 * `FoundryDataAccess` — cluster D in `docs/refactor-data-access-stage2.md`, the
 * nine methods scheduled to move into `actor-mechanics.ts` in stage 1:
 *
 *   useItem, addSaveFeatureToActor, addAttackToActor, addAuraToActor,
 *   addPassiveFeatureToActor, addAttackWithSaveToActor, setActorSpellcasting,
 *   addSpellsToActor, addFeaturesFromCompendium
 *
 * (plus `createNpcActor`, cluster C / stage 3c, which shares the exact same risk
 * shape — a 250-line hand-built document — and is nearly free to cover here.)
 *
 * ── What "characterization" means here ───────────────────────────────────────
 *
 * These assert what the code does TODAY, not what it ought to do. Where today's
 * output looks wrong it is pinned as-is and flagged with a BUG comment, so that a
 * later move is provably behaviour-preserving and the bug stays visible.
 *
 * The assertions are deliberately made against the DOCUMENT HANDED TO FOUNDRY —
 * `createEmbeddedDocuments(...)`'s docs, `Actor.create(...)`'s doc, `update(...)`'s
 * patch, `item.use(...)`'s options — field by field, with `toEqual` on the whole
 * object rather than spot checks. That is the point: these builders are long,
 * repetitive, hand-transcribed data objects, and the realistic stage-1 failure is
 * a mis-transcription INSIDE one of them, which `tsc` cannot see (the parameter
 * is `data: any` and the literal is untyped). A whole-object `toEqual` fails and
 * names the exact path that drifted.
 *
 * `foundry.utils.randomID` is deterministic in the fixture so the generated
 * activity id is assertable (`world.randomIds`).
 */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  installFakeFoundry,
  makeActor,
  makeDataAccess,
  type FakeActor,
  type FakeWorld,
} from './__fixtures__/fake-foundry.js';

let world: FakeWorld;

/** A dnd5e world with one actor. Cluster D guards on `game.system.id === 'dnd5e'`. */
function installDnd5e(actor: FakeActor, extra: Record<string, any> = {}): void {
  world = installFakeFoundry({ actors: [actor], systemId: 'dnd5e', ...extra });
}

beforeEach(() => {
  world = installFakeFoundry({ systemId: 'dnd5e' });
});

// =============================================================================
// addSaveFeatureToActor — one `save` activity, area template, optional half-damage
// =============================================================================

describe('addSaveFeatureToActor', () => {
  const base = {
    featureName: 'Withering Gaze',
    description: '<p>A chilling stare.</p>',
    activationType: 'action',
    saveAbility: 'wis',
    saveDC: 15,
    damageParts: [
      { number: 4, denomination: 6, type: 'necrotic' },
      { number: 2, denomination: 8, type: 'cold' },
    ],
    halfOnSave: true,
    areaType: 'emanation',
    areaSize: 30,
    areaUnits: 'ft',
    affectsType: 'creature',
  };

  it('hands Foundry the whole feat document, field for field (emanation, half on save)', async () => {
    const actor = makeActor('Horror', { type: 'npc' });
    installDnd5e(actor);
    const da = await makeDataAccess();

    const res = await da.addSaveFeatureToActor({ actorIdentifier: 'Horror', ...base });

    expect(world.embeddedCreates).toHaveLength(1);
    const [call] = world.embeddedCreates;
    expect(call.actorId).toBe(actor.id);
    expect(call.type).toBe('Item');
    expect(call.docs).toHaveLength(1);

    // The activity id comes from foundry.utils.randomID(16) and is used BOTH as
    // the map key and as the activity's own `_id`.
    const activityId = world.randomIds[0];
    expect(world.randomIds).toEqual([activityId]);

    expect(call.docs[0]).toEqual({
      name: 'Withering Gaze',
      type: 'feat',
      img: 'systems/dnd5e/icons/svg/items/feature.svg',
      system: {
        description: { value: '<p>A chilling stare.</p>', chat: '' },
        identifier: 'withering-gaze',
        // NOTE: `rules` is hard-coded '2024' here — this builder takes no
        // sourceRules/sourceBook/sourcePage at all, unlike every other builder
        // in the cluster. Characterized, not corrected.
        source: { revision: 1, rules: '2024' },
        type: { value: 'monster', subtype: '' },
        uses: { spent: 0, recovery: [], max: '' },
        advancement: [],
        crewed: false,
        enchant: {},
        prerequisites: { items: [], repeatable: false, level: null },
        properties: [],
        requirements: '',
        activities: {
          [activityId]: {
            _id: activityId,
            type: 'save',
            sort: 0,
            name: '',
            activation: { type: 'action', override: false },
            consumption: { scaling: { allowed: false }, spellSlot: true, targets: [] },
            description: {},
            duration: { units: 'inst', concentration: false, override: false },
            effects: [],
            range: { units: 'self', override: false },
            uses: { spent: 0, recovery: [] },
            target: {
              template: {
                contiguous: false,
                units: 'ft',
                count: '',
                // 'emanation' is mapped to Foundry's internal 'radius'.
                type: 'radius',
                size: '30',
              },
              affects: { choice: false, count: '', type: 'creature', special: '' },
              override: false,
              prompt: true,
            },
            damage: {
              onSave: 'half',
              // ALL damage parts land in the activity here — contrast
              // addAttackToActor, where part[0] becomes system.damage.base.
              parts: [
                {
                  custom: { enabled: false, formula: '' },
                  number: 4,
                  denomination: 6,
                  bonus: '',
                  types: ['necrotic'],
                  scaling: { mode: '', number: 1 },
                },
                {
                  custom: { enabled: false, formula: '' },
                  number: 2,
                  denomination: 8,
                  bonus: '',
                  types: ['cold'],
                  scaling: { mode: '', number: 1 },
                },
              ],
            },
            save: { ability: ['wis'], dc: { calculation: '', formula: '15' } },
          },
        },
      },
      effects: [],
    });

    expect(res).toEqual({
      success: true,
      item: { id: actor.items[0].id, name: 'Withering Gaze' },
      actor: { id: actor.id, name: 'Horror' },
    });
    expect(world.audit).toContainEqual(
      expect.objectContaining({
        operation: 'addSaveFeatureToActor',
        data: { actorId: actor.id, featureName: 'Withering Gaze' },
        result: 'success',
      })
    );
  });

  it('branch: halfOnSave false, a non-emanation area, and a missing areaSize', async () => {
    const actor = makeActor('Horror', { type: 'npc' });
    installDnd5e(actor);
    const da = await makeDataAccess();

    await da.addSaveFeatureToActor({
      actorIdentifier: 'Horror',
      ...base,
      halfOnSave: false,
      areaType: 'cone',
      areaSize: undefined,
      areaUnits: 'm',
      affectsType: 'ally',
      activationType: 'bonus',
      saveAbility: 'dex',
      saveDC: 8,
    });

    const activity = world.embeddedCreates[0].docs[0].system.activities[world.randomIds[0]];
    expect(activity.damage.onSave).toBe('none');
    expect(activity.activation).toEqual({ type: 'bonus', override: false });
    expect(activity.save).toEqual({ ability: ['dex'], dc: { calculation: '', formula: '8' } });
    // 'cone' is NOT mapped — only 'emanation' is.
    expect(activity.target.template.type).toBe('cone');
    expect(activity.target.template.units).toBe('m');
    expect(activity.target.affects.type).toBe('ally');
    // The size expression tests the presence of the area SIZE it stringifies, not
    // just the area TYPE, so a missing areaSize yields '' — never the literal
    // string "undefined".
    expect(activity.target.template.size).toBe('');
  });

  it('guards: wrong system and a duplicate name both throw and write nothing', async () => {
    const actor = makeActor('Horror', { type: 'npc', items: [{ id: 'i1', name: 'Taken' }] });
    world = installFakeFoundry({ actors: [actor], systemId: 'pf2e' });
    let da = await makeDataAccess();
    await expect(da.addSaveFeatureToActor({ actorIdentifier: 'Horror', ...base })).rejects.toThrow(
      /requires D&D 5e. Current system: "pf2e"/
    );
    expect(world.embeddedCreates).toEqual([]);
    expect(world.audit).toContainEqual(
      expect.objectContaining({
        operation: 'addSaveFeatureToActor',
        data: { actorIdentifier: 'Horror', featureName: 'Withering Gaze' },
        result: 'failure',
      })
    );

    installDnd5e(actor);
    da = await makeDataAccess();
    await expect(
      da.addSaveFeatureToActor({ actorIdentifier: 'Horror', ...base, featureName: 'Taken' })
    ).rejects.toThrow(/Feature "Taken" already exists on actor "Horror" \(id: i1\)/);
    expect(world.embeddedCreates).toEqual([]);

    // The duplicate check is name-only and type-agnostic: the existing item has
    // no `type` at all and still blocks.
    expect(actor.items[0]).not.toHaveProperty('type');
  });
});

// =============================================================================
// addAttackToActor — weapon item, one `attack` activity, 2014/2024 split
// =============================================================================

describe('addAttackToActor', () => {
  it('melee + 2014 rules: reach range, weapon classification, no mastery, no ability override', async () => {
    const actor = makeActor('Bandit', { type: 'npc' });
    installDnd5e(actor);
    const da = await makeDataAccess();

    const res = await da.addAttackToActor({
      actorIdentifier: 'Bandit',
      featureName: 'Rusty Scimitar',
      description: 'A notched blade.',
      attackType: 'melee',
      reachFt: 10,
      damageParts: [
        { number: 1, denomination: 6, type: 'slashing' },
        { number: 1, denomination: 4, type: 'poison' },
      ],
      properties: ['fin', 'lgt'],
      attackBonus: 0,
      weaponClass: 'simpleM',
      activationType: 'action',
      sourceBook: 'MM',
      sourcePage: '343',
      // sourceRules omitted → '2014'
      effectiveAbility: 'dex', // must be IGNORED under 2014
    });

    const activityId = world.randomIds[0];
    expect(world.embeddedCreates[0].docs[0]).toEqual({
      name: 'Rusty Scimitar',
      type: 'weapon',
      system: {
        description: { value: 'A notched blade.', chat: '', unidentified: '' },
        source: { custom: '', book: 'MM', page: '343', license: '', rules: '2014' },
        quantity: 1,
        weight: { value: 0, units: 'lb' },
        price: { value: 0, denomination: 'gp' },
        attunement: '',
        equipped: true, // `data.equipped !== false`, so an omitted flag equips
        rarity: '',
        identified: true,
        activation: { type: 'action', value: 1, condition: '', override: false },
        duration: { value: '', units: '' },
        cover: null,
        target: {
          template: {
            count: '',
            contiguous: false,
            type: '',
            size: '',
            width: '',
            height: '',
            units: '',
          },
          affects: { count: '', type: '', choice: false, special: '' },
          prompt: true,
          override: false,
        },
        // melee → reachFt, and `long` is always null
        range: { value: 10, long: null, units: 'ft' },
        uses: { value: null, max: '', recovery: [], prompt: true },
        // damageParts[0] becomes the weapon's BASE damage...
        damage: {
          base: {
            types: ['slashing'],
            number: 1,
            denomination: 6,
            bonus: '',
            scaling: { mode: '', number: 1 },
            custom: { enabled: false },
          },
        },
        type: { value: 'simpleM', baseItem: '' },
        properties: ['fin', 'lgt'],
        proficient: 1,
        magicalBonus: null,
        // NO `mastery` key at all under 2014 rules.
        activities: {
          [activityId]: {
            _id: activityId,
            type: 'attack',
            name: '',
            img: '',
            sort: 0,
            description: {},
            activation: { type: 'action', value: 1, condition: '', override: false },
            duration: { units: '', value: '', override: false },
            target: {
              template: {
                count: '',
                contiguous: false,
                type: '',
                size: '',
                width: '',
                height: '',
                units: '',
              },
              affects: { count: '', type: '', choice: false, special: '' },
              prompt: true,
              override: false,
            },
            // The ACTIVITY range is always 'self'; the real range lives on system.
            range: { units: 'self', override: false },
            uses: { spent: 0, max: '', recovery: [] },
            consumption: { targets: [], scaling: { allowed: false, max: '' }, spellSlot: true },
            attack: {
              // '' — the 2024-only `...abilityField` spread does not apply, so
              // `effectiveAbility: 'dex'` above is dropped on purpose.
              ability: '',
              bonus: '', // attackBonus 0 is NOT > 0, so ''
              critical: { threshold: null },
              flat: false,
              type: { value: 'melee', classification: 'weapon' },
            },
            // ...and damageParts[1..] become the activity's own parts.
            damage: {
              critical: { bonus: '' },
              includeBase: true,
              parts: [
                {
                  types: ['poison'],
                  number: 1,
                  denomination: 4,
                  bonus: '',
                  scaling: { mode: '', number: 1 },
                  custom: { enabled: false },
                },
              ],
            },
            effects: [],
            save: { ability: '', dc: { formula: '', calculation: '' } },
          },
        },
      },
    });

    expect(res).toEqual({
      success: true,
      actor: { id: actor.id, name: 'Bandit' },
      item: { id: actor.items[0].id, name: 'Rusty Scimitar', type: 'weapon' },
      warnings: [],
    });
  });

  it('branch: ranged + 2024 rules adds mastery and overrides the attack ability', async () => {
    const actor = makeActor('Archer', { type: 'npc' });
    installDnd5e(actor);
    const da = await makeDataAccess();

    await da.addAttackToActor({
      actorIdentifier: 'Archer',
      featureName: 'Longbow',
      attackType: 'ranged',
      rangeFt: 150,
      longRangeFt: 600,
      damageParts: [{ number: 1, denomination: 8, type: 'piercing' }],
      properties: ['amm', 'two'],
      attackBonus: 7,
      weaponClass: 'martialR',
      equipped: false,
      sourceRules: '2024',
      effectiveAbility: 'dex',
    });

    const system = world.embeddedCreates[0].docs[0].system;
    expect(system.range).toEqual({ value: 150, long: 600, units: 'ft' });
    expect(system.source.rules).toBe('2024');
    expect(system.equipped).toBe(false);
    // The conditional spreads: `mastery` exists ONLY under 2024...
    expect(system.mastery).toBe('');
    expect('mastery' in system).toBe(true);
    // ...and `description.value` falls back to '' when no description is given.
    expect(system.description.value).toBe('');

    const activity = system.activities[world.randomIds[0]];
    // `...abilityField` is spread AFTER `ability: ''`, so it wins under 2024.
    expect(activity.attack.ability).toBe('dex');
    expect(activity.attack.bonus).toBe('7');
    // classification is '' for anything that is not '2014'.
    expect(activity.attack.type).toEqual({ value: 'ranged', classification: '' });
    // A single damage part leaves the activity parts empty (slice(1)).
    expect(activity.damage.parts).toEqual([]);
  });

  it('branch: a ranged attack with no long range records long: null', async () => {
    const actor = makeActor('Archer', { type: 'npc' });
    installDnd5e(actor);
    const da = await makeDataAccess();

    await da.addAttackToActor({
      actorIdentifier: 'Archer',
      featureName: 'Dart',
      attackType: 'ranged',
      rangeFt: 20,
      damageParts: [{ number: 1, denomination: 4, type: 'piercing' }],
      properties: [],
      attackBonus: 3,
    });

    expect(world.embeddedCreates[0].docs[0].system.range).toEqual({
      value: 20,
      long: null,
      units: 'ft',
    });
    // weaponClass omitted → 'natural'; activationType omitted → 'action'.
    expect(world.embeddedCreates[0].docs[0].system.type).toEqual({
      value: 'natural',
      baseItem: '',
    });
    expect(world.embeddedCreates[0].docs[0].system.activation.type).toBe('action');
  });

  it('branch: soft validation collects one warning per unknown value and still creates', async () => {
    const actor = makeActor('Ooze', { type: 'npc' });
    installDnd5e(actor);
    const da = await makeDataAccess();

    const res = await da.addAttackToActor({
      actorIdentifier: 'Ooze',
      featureName: 'Pseudopod',
      attackType: 'melee',
      damageParts: [
        { number: 2, denomination: 6, type: 'bludgeoning' },
        { number: 1, denomination: 6, type: 'ectoplasm' },
      ],
      properties: ['rch', 'zzz'],
      attackBonus: 4,
    });

    expect(res.warnings).toEqual([
      'Unknown damage type "ectoplasm" — verify it matches dnd5e system values',
      'Unknown weapon property "zzz" — verify it matches dnd5e system values',
    ]);
    // Never blocks: the item is created anyway, with the unknown values verbatim.
    expect(world.embeddedCreates).toHaveLength(1);
    expect(world.embeddedCreates[0].docs[0].system.properties).toEqual(['rch', 'zzz']);
    expect(
      world.embeddedCreates[0].docs[0].system.activities[world.randomIds[0]].damage.parts[0].types
    ).toEqual(['ectoplasm']);
    // melee with no reachFt → the default 5.
    expect(world.embeddedCreates[0].docs[0].system.range).toEqual({
      value: 5,
      long: null,
      units: 'ft',
    });
  });
});

// =============================================================================
// addAuraToActor — feat item, one `damage` activity (no attack, no save)
// =============================================================================

describe('addAuraToActor', () => {
  it('hands Foundry a damage-only activity with an emanation template', async () => {
    const actor = makeActor('Banshee', { type: 'npc' });
    installDnd5e(actor);
    const da = await makeDataAccess();

    const res = await da.addAuraToActor({
      actorIdentifier: 'Banshee',
      featureName: 'Wail of Sorrow',
      description: '<p>An unearthly cry.</p>',
      damageParts: [{ number: 3, denomination: 6, type: 'psychic' }],
      areaType: 'emanation',
      areaSize: 20,
      sourceBook: 'MM',
      sourcePage: '21',
      // areaUnits / affectsType / activationType / sourceRules all omitted
    });

    const activityId = world.randomIds[0];
    expect(world.embeddedCreates[0].docs[0]).toEqual({
      name: 'Wail of Sorrow',
      type: 'feat',
      img: 'systems/dnd5e/icons/svg/items/feature.svg',
      system: {
        description: { value: '<p>An unearthly cry.</p>', chat: '' },
        identifier: 'wail-of-sorrow',
        // Contrast addSaveFeatureToActor, whose `source` has only 2 keys.
        source: { revision: 1, rules: '2014', custom: '', book: 'MM', page: '21', license: '' },
        type: { value: 'monster', subtype: '' },
        uses: { spent: 0, recovery: [], max: '' },
        advancement: [],
        crewed: false,
        enchant: {},
        prerequisites: { items: [], repeatable: false, level: null },
        properties: [],
        requirements: '',
        activities: {
          [activityId]: {
            _id: activityId,
            type: 'damage',
            name: '',
            sort: 0,
            activation: { type: 'action', value: 1, override: false },
            consumption: { scaling: { allowed: false }, spellSlot: true, targets: [] },
            description: {},
            duration: { units: 'inst', concentration: false, override: false },
            effects: [],
            range: { units: 'self', override: false },
            uses: { spent: 0, recovery: [] },
            target: {
              template: {
                contiguous: false,
                units: 'ft',
                count: '',
                type: 'radius',
                size: '20',
                width: '',
                height: '',
              },
              affects: { count: '', type: 'creature', choice: false, special: '' },
              override: false,
              prompt: true,
            },
            damage: {
              critical: { allow: false },
              parts: [
                {
                  types: ['psychic'],
                  number: 3,
                  denomination: 6,
                  bonus: '',
                  scaling: { mode: '', number: 1 },
                  custom: { enabled: false },
                },
              ],
            },
          },
        },
      },
      effects: [],
    });

    // Absence is load-bearing here (the comments in the builder say so
    // explicitly), and `toEqual` treats a missing key and an undefined one alike,
    // so assert it directly.
    const activity = world.embeddedCreates[0].docs[0].system.activities[activityId];
    expect('save' in activity).toBe(false);
    expect('attack' in activity).toBe(false);
    expect('onSave' in activity.damage).toBe(false);
    expect('bonus' in activity.damage.critical).toBe(false);
    expect('condition' in activity.activation).toBe(false);
    expect('max' in activity.uses).toBe(false);
    expect('formula' in activity.damage.parts[0].custom).toBe(false);

    expect(res).toEqual({
      success: true,
      actor: { id: actor.id, name: 'Banshee' },
      item: { id: actor.items[0].id, name: 'Wail of Sorrow', type: 'feat' },
      warnings: [],
    });
  });

  it('branch: explicit units/affects/activation/rules, and an unknown damage type warns', async () => {
    const actor = makeActor('Banshee', { type: 'npc' });
    installDnd5e(actor);
    const da = await makeDataAccess();

    const res = await da.addAuraToActor({
      actorIdentifier: 'Banshee',
      featureName: 'Dread Nimbus',
      damageParts: [{ number: 1, denomination: 10, type: 'entropy' }],
      areaType: 'cube',
      areaSize: 15,
      areaUnits: 'm',
      affectsType: 'enemy',
      activationType: 'reaction',
      sourceRules: '2024',
    });

    const activity = world.embeddedCreates[0].docs[0].system.activities[world.randomIds[0]];
    expect(activity.target.template).toEqual({
      contiguous: false,
      units: 'm',
      count: '',
      type: 'cube', // not mapped — only 'emanation' is
      size: '15',
      width: '',
      height: '',
    });
    expect(activity.target.affects.type).toBe('enemy');
    expect(activity.activation).toEqual({ type: 'reaction', value: 1, override: false });
    expect(world.embeddedCreates[0].docs[0].system.source.rules).toBe('2024');
    expect(world.embeddedCreates[0].docs[0].system.description.value).toBe('');
    expect(res.warnings).toEqual([
      'Unknown damage type "entropy" — verify it matches dnd5e system values',
    ]);
  });

  it('branch: a missing areaSize yields an empty size, never the text "undefined"', async () => {
    const actor = makeActor('Banshee', { type: 'npc' });
    installDnd5e(actor);
    const da = await makeDataAccess();

    // The server tool's schema makes areaSize mandatory for an aura, so this input
    // only arrives through the bridge query directly. The builder must still not
    // write a stringified `undefined` into the document.
    await da.addAuraToActor({
      actorIdentifier: 'Banshee',
      featureName: 'Silent Nimbus',
      damageParts: [{ number: 1, denomination: 6, type: 'psychic' }],
      areaType: 'cube',
      areaSize: undefined,
    });

    const activity = world.embeddedCreates[0].docs[0].system.activities[world.randomIds[0]];
    expect(activity.target.template.size).toBe('');
  });
});

// =============================================================================
// addPassiveFeatureToActor — a feat with NO activities at all
// =============================================================================

describe('addPassiveFeatureToActor', () => {
  it('builds a feat with an empty activities map and a slugified identifier', async () => {
    const actor = makeActor('Ghost', { type: 'npc' });
    installDnd5e(actor);
    const da = await makeDataAccess();

    const res = await da.addPassiveFeatureToActor({
      actorIdentifier: 'Ghost',
      featureName: 'Incorporeal Movement (Étérée)',
      description: '<p>Moves through creatures.</p>',
      sourceBook: 'MM',
      sourcePage: '147',
    });

    expect(world.embeddedCreates[0].docs[0]).toEqual({
      name: 'Incorporeal Movement (Étérée)',
      type: 'feat',
      img: 'systems/dnd5e/icons/svg/items/feature.svg',
      system: {
        description: { value: '<p>Moves through creatures.</p>', chat: '' },
        // NFD-normalized, accents stripped, spaces to dashes, everything else dropped.
        identifier: 'incorporeal-movement-eteree',
        source: { revision: 1, rules: '2014', custom: '', book: 'MM', page: '147', license: '' },
        type: { value: 'monster', subtype: '' },
        uses: { spent: 0, recovery: [], max: '' },
        advancement: [],
        crewed: false,
        enchant: {},
        prerequisites: { items: [], repeatable: false, level: null },
        properties: [],
        requirements: '',
        activities: {},
      },
      effects: [],
    });
    // No activity id was minted at all for a passive feature.
    expect(world.randomIds).toEqual([]);
    // No `warnings` key on this one — it has no soft validation.
    expect(res).toEqual({
      success: true,
      actor: { id: actor.id, name: 'Ghost' },
      item: { id: actor.items[0].id, name: 'Incorporeal Movement (Étérée)', type: 'feat' },
    });
  });

  it('branch: a name with nothing slug-able falls back to the identifier "feature"', async () => {
    const actor = makeActor('Ghost', { type: 'npc' });
    installDnd5e(actor);
    const da = await makeDataAccess();

    await da.addPassiveFeatureToActor({ actorIdentifier: 'Ghost', featureName: '★★★' });

    expect(world.embeddedCreates[0].docs[0].system.identifier).toBe('feature');
    // The item NAME keeps the original text; only the identifier is slugified.
    expect(world.embeddedCreates[0].docs[0].name).toBe('★★★');
    expect(world.embeddedCreates[0].docs[0].system.description.value).toBe('');
  });
});

// =============================================================================
// addAttackWithSaveToActor — TWO activities on one weapon (attack sort 0, save 1)
// =============================================================================

describe('addAttackWithSaveToActor', () => {
  it('builds two distinct activities: attack (sort 0) then save (sort 1)', async () => {
    const actor = makeActor('Wyrm', { type: 'npc' });
    installDnd5e(actor);
    const da = await makeDataAccess();

    const res = await da.addAttackWithSaveToActor({
      actorIdentifier: 'Wyrm',
      featureName: 'Venomous Bite',
      description: 'Fangs and poison.',
      attackType: 'melee',
      reachFt: 15,
      damageParts: [
        { number: 2, denomination: 10, type: 'piercing' },
        { number: 1, denomination: 6, type: 'slashing' },
      ],
      saveDamageParts: [
        { number: 4, denomination: 6, type: 'poison' },
        { number: 1, denomination: 4, type: 'acid' },
      ],
      properties: ['rch'],
      attackBonus: 11,
      weaponClass: 'natural',
      saveAbility: 'con',
      saveDC: 18,
      saveOnSave: 'half',
      sourceBook: 'MM',
      sourcePage: '90',
    });

    // Two randomIDs, in order, and they must not be the same one reused.
    expect(world.randomIds).toHaveLength(2);
    const [attackId, saveId] = world.randomIds;
    expect(attackId).not.toBe(saveId);

    const system = world.embeddedCreates[0].docs[0].system;
    expect(Object.keys(system.activities)).toEqual([attackId, saveId]);

    // ── activity 1: attack ────────────────────────────────────────────────
    expect(system.activities[attackId]).toEqual({
      _id: attackId,
      type: 'attack',
      name: '',
      img: '',
      sort: 0,
      description: {},
      activation: { type: 'action', value: 1, condition: '', override: false },
      duration: { units: '', value: '', override: false },
      target: {
        template: {
          count: '',
          contiguous: false,
          type: '',
          size: '',
          width: '',
          height: '',
          units: '',
        },
        affects: { count: '', type: '', choice: false, special: '' },
        prompt: true,
        override: false,
      },
      range: { units: 'self', override: false },
      uses: { spent: 0, max: '', recovery: [] },
      consumption: { targets: [], scaling: { allowed: false, max: '' }, spellSlot: true },
      attack: {
        ability: '',
        bonus: '11',
        critical: { threshold: null },
        flat: false,
        type: { value: 'melee', classification: 'weapon' },
      },
      damage: {
        critical: { bonus: '' },
        includeBase: true,
        // damageParts[1..] only — [0] is the weapon base damage.
        parts: [
          {
            types: ['slashing'],
            number: 1,
            denomination: 6,
            bonus: '',
            scaling: { mode: '', number: 1 },
            custom: { enabled: false },
          },
        ],
      },
      effects: [],
      save: { ability: '', dc: { formula: '', calculation: '' } },
    });

    // ── activity 2: save ──────────────────────────────────────────────────
    expect(system.activities[saveId]).toEqual({
      _id: saveId,
      type: 'save',
      name: '',
      sort: 1,
      description: {},
      // NO `condition` on the save activity's activation (unlike the attack's).
      activation: { type: 'action', value: 1, override: false },
      duration: { units: 'inst', concentration: false, override: false },
      effects: [],
      range: { units: 'self', override: false },
      uses: { spent: 0, recovery: [] },
      consumption: { scaling: { allowed: false }, spellSlot: true, targets: [] },
      target: {
        template: {
          count: '',
          contiguous: false,
          type: '',
          size: '',
          width: '',
          height: '',
          units: '',
        },
        // Hard-coded '1' / 'creature' — not taken from any parameter.
        affects: { count: '1', type: 'creature', choice: false, special: '' },
        override: false,
        prompt: true,
      },
      damage: {
        onSave: 'half',
        // ALL saveDamageParts (no slice) and NO includeBase: save damage is
        // independent of the weapon's base damage.
        parts: [
          {
            types: ['poison'],
            number: 4,
            denomination: 6,
            bonus: '',
            scaling: { mode: '', number: 1 },
            custom: { enabled: false },
          },
          {
            types: ['acid'],
            number: 1,
            denomination: 4,
            bonus: '',
            scaling: { mode: '', number: 1 },
            custom: { enabled: false },
          },
        ],
      },
      save: { ability: ['con'], dc: { calculation: '', formula: '18' } },
    });
    expect('includeBase' in system.activities[saveId].damage).toBe(false);
    expect('max' in system.activities[saveId].uses).toBe(false);

    // The weapon's own base damage and range still come from the attack side.
    expect(system.damage.base).toEqual({
      types: ['piercing'],
      number: 2,
      denomination: 10,
      bonus: '',
      scaling: { mode: '', number: 1 },
      custom: { enabled: false },
    });
    expect(system.range).toEqual({ value: 15, long: null, units: 'ft' });
    expect(res.item).toEqual({ id: actor.items[0].id, name: 'Venomous Bite', type: 'weapon' });
    expect(res.warnings).toEqual([]);
  });

  it('branch: 2024 + ranged, saveOnSave default, and warnings deduped across both damage groups', async () => {
    const actor = makeActor('Wyrm', { type: 'npc' });
    installDnd5e(actor);
    const da = await makeDataAccess();

    const res = await da.addAttackWithSaveToActor({
      actorIdentifier: 'Wyrm',
      featureName: 'Spit Ichor',
      attackType: 'ranged',
      rangeFt: 30,
      damageParts: [{ number: 1, denomination: 8, type: 'ichor' }],
      saveDamageParts: [{ number: 2, denomination: 6, type: 'ichor' }],
      properties: [],
      attackBonus: 0,
      saveAbility: 'dex',
      saveDC: 13,
      sourceRules: '2024',
      effectiveAbility: 'con',
    });

    // The same unknown type appears in BOTH groups; the message is pushed once.
    expect(res.warnings).toEqual([
      'Unknown damage type "ichor" — verify it matches dnd5e system values',
    ]);

    const system = world.embeddedCreates[0].docs[0].system;
    const [attackId, saveId] = world.randomIds;
    expect(system.mastery).toBe('');
    expect(system.activities[attackId].attack.ability).toBe('con');
    expect(system.activities[attackId].attack.type.classification).toBe('');
    expect(system.activities[attackId].attack.bonus).toBe('');
    expect(system.activities[attackId].damage.parts).toEqual([]);
    expect(system.range).toEqual({ value: 30, long: null, units: 'ft' });
    // saveOnSave omitted → 'none'
    expect(system.activities[saveId].damage.onSave).toBe('none');
  });
});

// =============================================================================
// setActorSpellcasting — one flat `actor.update()` patch built from slot tables
// =============================================================================

describe('setActorSpellcasting', () => {
  const zeros = (from: number): Record<string, number> => {
    const out: Record<string, number> = {};
    for (let i = from; i <= 9; i++) {
      out[`system.spells.spell${i}.max`] = 0;
      out[`system.spells.spell${i}.value`] = 0;
    }
    return out;
  };

  it('full caster (wizard 5) writes the whole slot row in a single update call', async () => {
    const actor = makeActor('Mage', { type: 'npc' });
    installDnd5e(actor);
    const da = await makeDataAccess();

    const res = await da.setActorSpellcasting({
      actorIdentifier: 'Mage',
      spellcastingClass: 'wizard',
      spellcastingLevel: 5,
      effectiveAbility: 'int',
    });

    // ONE update, not nine.
    expect(world.updates).toHaveLength(1);
    expect(world.updates[0].id).toBe(actor.id);
    // FULL_CASTER_SLOTS[4] === [4,3,2,0,0,0,0,0,0]
    expect(world.updates[0].patch).toEqual({
      'system.attributes.spellcasting': 'int',
      'system.spells.spell1.max': 4,
      'system.spells.spell1.value': 4,
      'system.spells.spell2.max': 3,
      'system.spells.spell2.value': 3,
      'system.spells.spell3.max': 2,
      'system.spells.spell3.value': 2,
      ...zeros(4),
    });
    expect(res).toEqual({
      actor: { id: actor.id, name: 'Mage' },
      spellcasting: {
        ability: 'int',
        slots: {
          spell1: 4,
          spell2: 3,
          spell3: 2,
          spell4: 0,
          spell5: 0,
          spell6: 0,
          spell7: 0,
          spell8: 0,
          spell9: 0,
        },
      },
      warnings: [],
    });
    expect(world.audit).toContainEqual(
      expect.objectContaining({
        operation: 'setActorSpellcasting',
        data: { actorId: actor.id, cls: 'wizard', lvl: 5, ability: 'int' },
        result: 'success',
      })
    );
  });

  it('branch: warlock zeroes every regular slot and writes pact magic instead', async () => {
    const actor = makeActor('Pactbound', { type: 'npc' });
    installDnd5e(actor);
    const da = await makeDataAccess();

    const res = await da.setActorSpellcasting({
      actorIdentifier: 'Pactbound',
      spellcastingClass: 'warlock',
      spellcastingLevel: 3,
      effectiveAbility: 'cha',
    });

    // WARLOCK_PACT_TABLE[2] === { max: 2, level: 2 }
    expect(world.updates[0].patch).toEqual({
      'system.attributes.spellcasting': 'cha',
      ...zeros(1),
      'system.spells.pact.max': 2,
      'system.spells.pact.value': 2,
      'system.spells.pact.level': 2,
    });
    // The response carries ONLY `pact` — no spellN keys at all.
    expect(res.spellcasting.slots).toEqual({ pact: { max: 2, level: 2 } });
    expect(res.warnings).toEqual([]);
  });

  it('branch: half caster at level 1 has no slots and says so', async () => {
    const actor = makeActor('Squire', { type: 'npc' });
    installDnd5e(actor);
    const da = await makeDataAccess();

    const res = await da.setActorSpellcasting({
      actorIdentifier: 'Squire',
      spellcastingClass: 'paladin',
      spellcastingLevel: 1,
      effectiveAbility: 'cha',
    });

    // HALF_CASTER_SLOTS[0] is all zeros.
    expect(world.updates[0].patch).toEqual({
      'system.attributes.spellcasting': 'cha',
      ...zeros(1),
    });
    expect(res.warnings).toEqual([
      'paladin level 1 has no spell slots — use level 2+ to unlock spellcasting',
    ]);
  });

  it('branch: artificer uses its own table, not the full-caster one', async () => {
    const actor = makeActor('Tinker', { type: 'npc' });
    installDnd5e(actor);
    const da = await makeDataAccess();

    const res = await da.setActorSpellcasting({
      actorIdentifier: 'Tinker',
      spellcastingClass: 'artificer',
      spellcastingLevel: 5,
      effectiveAbility: 'int',
    });

    // ARTIFICER_SLOTS[4] === [4,2,0,...] — a full caster at 5 would be [4,3,2,...].
    expect(world.updates[0].patch).toEqual({
      'system.attributes.spellcasting': 'int',
      'system.spells.spell1.max': 4,
      'system.spells.spell1.value': 4,
      'system.spells.spell2.max': 2,
      'system.spells.spell2.value': 2,
      ...zeros(3),
    });
    expect(res.spellcasting.slots.spell2).toBe(2);
    expect(res.spellcasting.slots.spell3).toBe(0);
    expect(res.warnings).toEqual([]);
  });
});

// =============================================================================
// addSpellsToActor — compendium import, per-spell isolation
// =============================================================================

const FIREBALL = {
  _id: 'fb0000000000001',
  name: 'Fireball',
  type: 'spell',
  img: 'icons/magic/fire/explosion.webp',
  system: { level: 3, school: 'evo' },
};
const MAGIC_MISSILE = {
  _id: 'mm0000000000001',
  name: 'Magic Missile',
  type: 'spell',
  img: 'icons/magic/arcane/bolt.webp',
  system: { level: 1, school: 'evo' },
};

const spellPacks = [
  {
    id: 'dnd5e.spells',
    label: 'Spells (SRD)',
    entries: [
      { _id: FIREBALL._id, name: 'Fireball', doc: FIREBALL },
      { _id: MAGIC_MISSILE._id, name: 'Magic Missile', doc: MAGIC_MISSILE },
    ],
  },
  {
    id: 'homebrew.spells',
    label: 'Homebrew',
    entries: [
      {
        _id: 'hb0000000000001',
        name: 'Fireball',
        doc: { _id: 'hb0000000000001', name: 'Fireball', type: 'spell', system: { level: 9 } },
      },
    ],
  },
];

describe('addSpellsToActor', () => {
  it('embeds the compendium document verbatim minus its _id, first pack wins', async () => {
    const actor = makeActor('Mage', {
      type: 'npc',
      items: [{ id: 'i-shield', name: 'Shield', type: 'spell' }],
    });
    installDnd5e(actor, { packs: spellPacks });
    const da = await makeDataAccess();

    const res = await da.addSpellsToActor({
      actorIdentifier: 'Mage',
      spellNames: ['Fireball', 'fireball', 'Shield', 'Bogus Bolt'],
      compendiumPacks: ['dnd5e.spells', 'homebrew.spells'],
    });

    // The document handed to Foundry is the pack document with `_id` REMOVED so
    // Foundry mints a fresh embedded id (a clash would silently drop the item).
    expect(world.embeddedCreates).toHaveLength(1);
    expect(world.embeddedCreates[0].docs[0]).toEqual({
      name: 'Fireball',
      type: 'spell',
      img: 'icons/magic/fire/explosion.webp',
      system: { level: 3, school: 'evo' },
    });
    expect('_id' in world.embeddedCreates[0].docs[0]).toBe(false);
    // First-pack-wins: the SRD level-3 Fireball, not homebrew's level 9.
    expect(world.embeddedCreates[0].docs[0].system.level).toBe(3);

    expect(res).toEqual({
      actor: { id: actor.id, name: 'Mage' },
      added: [
        {
          name: 'Fireball',
          packId: 'dnd5e.spells',
          packLabel: 'Spells (SRD)',
          itemId: actor.items[1].id,
        },
      ],
      skipped: [
        { name: 'fireball', reason: 'duplicate in input' },
        { name: 'Shield', reason: 'already on actor' },
      ],
      notFound: ['Bogus Bolt'],
      failed: [],
      warnings: [],
    });
    // The index is built ONCE per pack, not once per spell.
    expect(world.packIndexCalls).toEqual(['dnd5e.spells', 'homebrew.spells']);
    expect(world.audit).toContainEqual(
      expect.objectContaining({
        operation: 'addSpellsToActor',
        data: { actorId: actor.id, added: 1, skipped: 2, notFound: 1, failed: 0 },
        result: 'success',
      })
    );
  });

  it('branch: the on-actor duplicate check only looks at items of type "spell"', async () => {
    // A FEAT named Fireball must not block importing the spell Fireball.
    const actor = makeActor('Mage', {
      type: 'npc',
      items: [{ id: 'i-feat', name: 'Fireball', type: 'feat' }],
    });
    installDnd5e(actor, { packs: spellPacks });
    const da = await makeDataAccess();

    const res = await da.addSpellsToActor({
      actorIdentifier: 'Mage',
      spellNames: ['Fireball'],
      compendiumPacks: ['dnd5e.spells'],
    });

    expect(res.skipped).toEqual([]);
    expect(res.added).toHaveLength(1);
  });

  it('branch: default pack list is ["dnd5e.spells"] when none is given', async () => {
    const actor = makeActor('Mage', { type: 'npc' });
    installDnd5e(actor, { packs: spellPacks });
    const da = await makeDataAccess();

    const res = await da.addSpellsToActor({
      actorIdentifier: 'Mage',
      spellNames: ['Magic Missile'],
    });

    expect(res.added[0].packId).toBe('dnd5e.spells');
    expect(world.packIndexCalls).toEqual(['dnd5e.spells']);
  });

  it('branch: a missing pack and a non-Item pack each warn, and no usable pack throws', async () => {
    const actor = makeActor('Mage', { type: 'npc' });
    installDnd5e(actor, {
      packs: [
        { id: 'dnd5e.spells', label: 'Spells (SRD)', entries: [{ _id: 'x', name: 'Y', doc: {} }] },
        { id: 'world.macros', label: 'Macros', type: 'Macro', entries: [] },
      ],
    });
    const da = await makeDataAccess();

    const res = await da.addSpellsToActor({
      actorIdentifier: 'Mage',
      spellNames: ['Whatever'],
      compendiumPacks: ['nope.missing', 'world.macros', 'dnd5e.spells'],
    });
    expect(res.warnings).toEqual([
      'Compendium pack "nope.missing" not found — skipped',
      'Pack "world.macros" has type "Macro", expected "Item" — skipped',
    ]);
    expect(res.notFound).toEqual(['Whatever']);

    // With NOTHING usable it throws rather than reporting an empty result.
    installDnd5e(actor, { packs: [] });
    const da2 = await makeDataAccess();
    await expect(
      da2.addSpellsToActor({
        actorIdentifier: 'Mage',
        spellNames: ['Fireball'],
        compendiumPacks: ['nope.missing'],
      })
    ).rejects.toThrow(/No valid compendium packs available/);
    expect(world.audit).toContainEqual(
      expect.objectContaining({
        operation: 'addSpellsToActor',
        data: { actorIdentifier: 'Mage' },
        result: 'failure',
      })
    );
  });

  it('branch: one spell Foundry refuses to embed is isolated, the rest still import', async () => {
    const actor = makeActor('Mage', { type: 'npc' });
    installDnd5e(actor, { packs: spellPacks });
    world.failEmbed.add('Fireball');
    const da = await makeDataAccess();

    const res = await da.addSpellsToActor({
      actorIdentifier: 'Mage',
      spellNames: ['Fireball', 'Magic Missile'],
      compendiumPacks: ['dnd5e.spells'],
    });

    expect(res.failed).toEqual([
      { name: 'Fireball', error: 'Foundry refused to embed "Fireball"' },
    ]);
    expect(res.added.map((a: any) => a.name)).toEqual(['Magic Missile']);
  });

  it('branch: an index entry whose document is missing counts as notFound, with a warning', async () => {
    const actor = makeActor('Mage', { type: 'npc' });
    installDnd5e(actor, {
      packs: [
        {
          id: 'dnd5e.spells',
          label: 'Spells (SRD)',
          // No `doc` → getDocument() resolves null.
          entries: [{ _id: 'ghost01', name: 'Ghost Spell' }],
        },
      ],
    });
    const da = await makeDataAccess();

    const res = await da.addSpellsToActor({
      actorIdentifier: 'Mage',
      spellNames: ['Ghost Spell'],
      compendiumPacks: ['dnd5e.spells'],
    });

    expect(res.notFound).toEqual(['Ghost Spell']);
    expect(res.warnings).toEqual([
      '"Ghost Spell" found in index but document missing in pack "dnd5e.spells" — skipped',
    ]);
    expect(world.embeddedCreates).toEqual([]);
  });
});

// =============================================================================
// addFeaturesFromCompendium — same shape as addSpellsToActor, two differences
// =============================================================================

describe('addFeaturesFromCompendium', () => {
  const MULTIATTACK = {
    _id: 'ma0000000000001',
    name: 'Multiattack',
    type: 'feat',
    system: { description: { value: 'Two attacks.' } },
  };
  const PACK_TACTICS = {
    _id: 'pt0000000000001',
    name: 'Pack Tactics',
    type: 'feat',
    system: { description: { value: 'Advantage.' } },
  };

  const featurePacks = [
    {
      id: 'dnd5e.monsterfeatures',
      label: 'Monster Features',
      entries: [{ _id: MULTIATTACK._id, name: 'Multiattack', doc: MULTIATTACK }],
    },
    {
      id: 'dnd5e.classfeatures',
      label: 'Class Features',
      entries: [{ _id: PACK_TACTICS._id, name: 'Pack Tactics', doc: PACK_TACTICS }],
    },
  ];

  it('defaults to both dnd5e feature packs and embeds the document minus its _id', async () => {
    const actor = makeActor('Wolf', { type: 'npc' });
    installDnd5e(actor, { packs: featurePacks });
    const da = await makeDataAccess();

    const res = await da.addFeaturesFromCompendium({
      actorIdentifier: 'Wolf',
      featureNames: ['Multiattack', 'Pack Tactics'],
    });

    // The default pack list, in order — this is what "first-pack-wins" resolves against.
    expect(world.packIndexCalls).toEqual(['dnd5e.monsterfeatures', 'dnd5e.classfeatures']);
    expect(world.embeddedCreates).toHaveLength(2);
    expect(world.embeddedCreates[0].docs[0]).toEqual({
      name: 'Multiattack',
      type: 'feat',
      system: { description: { value: 'Two attacks.' } },
    });
    expect('_id' in world.embeddedCreates[0].docs[0]).toBe(false);
    expect(res.added).toEqual([
      {
        name: 'Multiattack',
        packId: 'dnd5e.monsterfeatures',
        packLabel: 'Monster Features',
        itemId: actor.items[0].id,
      },
      {
        name: 'Pack Tactics',
        packId: 'dnd5e.classfeatures',
        packLabel: 'Class Features',
        itemId: actor.items[1].id,
      },
    ]);
    expect(res.skipped).toEqual([]);
    expect(res.notFound).toEqual([]);
    expect(res.failed).toEqual([]);
    expect(res.warnings).toEqual([]);
  });

  it('branch: the on-actor duplicate check is name-only, ANY item type (unlike spells)', async () => {
    // A WEAPON named Multiattack blocks the feature — deliberately different from
    // addSpellsToActor, which only compares against items of type 'spell'.
    const actor = makeActor('Wolf', {
      type: 'npc',
      items: [{ id: 'i-w', name: 'multiattack', type: 'weapon' }],
    });
    installDnd5e(actor, { packs: featurePacks });
    const da = await makeDataAccess();

    const res = await da.addFeaturesFromCompendium({
      actorIdentifier: 'Wolf',
      featureNames: ['Multiattack', 'Multiattack'],
    });

    expect(res.skipped).toEqual([
      { name: 'Multiattack', reason: 'duplicate in input' },
      { name: 'Multiattack', reason: 'already on actor' },
    ]);
    expect(world.embeddedCreates).toEqual([]);
  });

  it('branch: no usable pack throws with the feature-specific guidance', async () => {
    const actor = makeActor('Wolf', { type: 'npc' });
    installDnd5e(actor, { packs: [] });
    const da = await makeDataAccess();

    await expect(
      da.addFeaturesFromCompendium({ actorIdentifier: 'Wolf', featureNames: ['Multiattack'] })
    ).rejects.toThrow(/2024 class features are embedded in class items/);
  });
});

// =============================================================================
// useItem — dispatches to whatever use/roll/chat API the system's item exposes
// =============================================================================

/** An item whose `use`/`toChat`/`toMessage`/`roll` calls are recorded. */
function makeUsableItem(
  name: string,
  methods: string[],
  calls: Array<{ method: string; args: any[] }>,
  extra: Record<string, any> = {}
): Record<string, any> {
  const item: Record<string, any> = { id: `item-${name}`, name, type: 'weapon', ...extra };
  for (const m of methods) {
    item[m] = (...args: any[]): Promise<void> => {
      calls.push({ method: m, args });
      return Promise.resolve();
    };
  }
  return item;
}

describe('useItem', () => {
  it('dnd5e: hands item.use() the full consume/dialog option set', async () => {
    const calls: Array<{ method: string; args: any[] }> = [];
    const item = makeUsableItem('Longsword', ['use'], calls);
    const actor = makeActor('Knight', { type: 'npc', items: [item] });
    installDnd5e(actor);
    const da = await makeDataAccess();

    const res = await da.useItem({ actorIdentifier: 'Knight', itemIdentifier: 'Longsword' });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('use');
    expect(calls[0].args[0]).toEqual({
      createMessage: true,
      consumeResource: true,
      consumeSpellSlot: true,
      consumeUsage: true,
      // Always true: "show the dialog so the GM can make choices".
      configureDialog: true,
    });
    expect(res).toEqual({
      success: true,
      status: 'initiated',
      message:
        'Item use initiated for Knight using Longsword. If a dialog appeared in Foundry VTT, ' +
        'the GM should select options and confirm. The result will appear in chat.',
      itemName: 'Longsword',
      actorName: 'Knight',
      requiresGMInteraction: true,
    });
    // No targets requested → the key is absent, not an empty array.
    expect('targets' in res).toBe(false);
    expect(world.audit).toContainEqual(
      expect.objectContaining({
        operation: 'useItem',
        data: { actorId: actor.id, itemId: 'item-Longsword', itemName: 'Longsword', targets: [] },
        result: 'success',
      })
    );
  });

  it('dnd5e branch: consume:false flips all three consume flags; spellLevel adds both keys', async () => {
    const calls: Array<{ method: string; args: any[] }> = [];
    const item = makeUsableItem('Fireball', ['use'], calls, { type: 'spell' });
    installDnd5e(makeActor('Mage', { type: 'npc', items: [item] }));
    const da = await makeDataAccess();

    await da.useItem({
      actorIdentifier: 'Mage',
      itemIdentifier: 'Fireball',
      options: { consume: false, spellLevel: 5 },
    });

    expect(calls[0].args[0]).toEqual({
      createMessage: true,
      consumeResource: false,
      consumeSpellSlot: false,
      consumeUsage: false,
      configureDialog: true,
      // Both spellings are set: `slotLevel` for dnd5e, `level` generically.
      slotLevel: 5,
      level: 5,
    });
  });

  it('non-dnd5e branch: item.use() gets createMessage only, no consume keys', async () => {
    const calls: Array<{ method: string; args: any[] }> = [];
    const item = makeUsableItem('Shield Block', ['use'], calls);
    world = installFakeFoundry({
      actors: [makeActor('Fighter', { type: 'npc', items: [item] })],
      systemId: 'pf2e',
    });
    const da = await makeDataAccess();

    await da.useItem({ actorIdentifier: 'Fighter', itemIdentifier: 'Shield Block' });

    expect(calls[0].args[0]).toEqual({ createMessage: true });
  });

  it('branch: toChat + toMessage prefers toMessage(undefined, { create: true })', async () => {
    const calls: Array<{ method: string; args: any[] }> = [];
    const item = makeUsableItem('Feat', ['toChat', 'toMessage'], calls);
    world = installFakeFoundry({
      actors: [makeActor('Rogue', { type: 'npc', items: [item] })],
      systemId: 'pf2e',
    });
    const da = await makeDataAccess();

    await da.useItem({ actorIdentifier: 'Rogue', itemIdentifier: 'Feat' });

    expect(calls).toEqual([{ method: 'toMessage', args: [undefined, { create: true }] }]);
  });

  it('branch: toChat alone is used when there is no toMessage', async () => {
    const calls: Array<{ method: string; args: any[] }> = [];
    const item = makeUsableItem('Feat', ['toChat'], calls);
    world = installFakeFoundry({
      actors: [makeActor('Rogue', { type: 'npc', items: [item] })],
      systemId: 'pf2e',
    });
    const da = await makeDataAccess();

    await da.useItem({ actorIdentifier: 'Rogue', itemIdentifier: 'Feat' });

    expect(calls).toEqual([{ method: 'toChat', args: [] }]);
  });

  it('branch: roll() is the third choice', async () => {
    const calls: Array<{ method: string; args: any[] }> = [];
    const item = makeUsableItem('Trinket', ['roll'], calls);
    world = installFakeFoundry({
      actors: [makeActor('Rogue', { type: 'npc', items: [item] })],
      systemId: 'mgt2e',
    });
    const da = await makeDataAccess();

    await da.useItem({ actorIdentifier: 'Rogue', itemIdentifier: 'Trinket' });

    expect(calls).toEqual([{ method: 'roll', args: [] }]);
  });

  it('branch: an item with no API at all falls back to a chat message', async () => {
    const actor = makeActor('Squire', {
      type: 'npc',
      items: [{ id: 'i-rope', name: 'Rope', type: 'loot' }],
    });
    world = installFakeFoundry({ actors: [actor], systemId: 'mgt2e' });
    const da = await makeDataAccess();

    await da.useItem({ actorIdentifier: 'Squire', itemIdentifier: 'Rope' });

    expect(world.chatMessages).toEqual([
      {
        user: 'user-1',
        speaker: { actor: actor.id, alias: 'Squire' },
        content: '<h3>Rope</h3><p>Squire uses Rope.</p>',
      },
    ]);
  });

  it('branch: dsa5 spells post via postItem; a dsa5 spell with neither API falls back to chat', async () => {
    const calls: Array<{ method: string; args: any[] }> = [];
    const spell = makeUsableItem('Ignifaxius', ['postItem'], calls, { type: 'spell' });
    world = installFakeFoundry({
      actors: [makeActor('Mage', { type: 'npc', items: [spell] })],
      systemId: 'dsa5',
    });
    let da = await makeDataAccess();
    await da.useItem({ actorIdentifier: 'Mage', itemIdentifier: 'Ignifaxius' });
    expect(calls).toEqual([{ method: 'postItem', args: [] }]);
    expect(world.chatMessages).toEqual([]);

    // A dsa5 ritual with no postItem/setupEffect gets the chat fallback...
    const actor = makeActor('Mage', {
      type: 'npc',
      items: [{ id: 'i-r', name: 'Old Ritual', type: 'ritual' }],
    });
    world = installFakeFoundry({ actors: [actor], systemId: 'dsa5' });
    da = await makeDataAccess();
    await da.useItem({ actorIdentifier: 'Mage', itemIdentifier: 'Old Ritual' });
    expect(world.chatMessages).toHaveLength(1);
    expect(world.chatMessages[0].content).toBe('<h3>Old Ritual</h3><p>Mage uses Old Ritual.</p>');

    // ...but a NON-spell dsa5 item with no postItem gets NOTHING — no chat message.
    const actor2 = makeActor('Mage', {
      type: 'npc',
      items: [{ id: 'i-g', name: 'Gear', type: 'equipment' }],
    });
    world = installFakeFoundry({ actors: [actor2], systemId: 'dsa5' });
    da = await makeDataAccess();
    const res = await da.useItem({ actorIdentifier: 'Mage', itemIdentifier: 'Gear' });
    expect(world.chatMessages).toEqual([]);
    // Still reported as initiated even though nothing happened.
    expect(res.success).toBe(true);
  });

  it('resolves "self" and named targets against the active scene, dropping misses', async () => {
    const calls: Array<{ method: string; args: any[] }> = [];
    const item = makeUsableItem('Longsword', ['use'], calls);
    const actor = makeActor('Knight', { type: 'npc', items: [item] });
    installDnd5e(actor, {
      activeScene: {
        tokens: [
          { id: 'tok-knight', name: 'Knight token', actorId: actor.id },
          { id: 'tok-guard', name: 'Guard', actor: { id: 'a-guard', name: 'Guard Actor' } },
        ],
      },
    });
    const da = await makeDataAccess();

    const res = await da.useItem({
      actorIdentifier: 'Knight',
      itemIdentifier: 'Longsword',
      targets: ['self', 'Guard', 'Nobody'],
    });

    // Foundry's own targeting API, called once with the resolved token ids.
    expect(world.targetUpdates).toEqual([['tok-knight', 'tok-guard']]);
    // "self" reports the ACTOR's name; a named token reports the TOKEN's name.
    expect(res.targets).toEqual(['Knight', 'Guard']);
    expect(res.message).toContain('targeting Knight, Guard');
    expect(world.audit).toContainEqual(
      expect.objectContaining({
        operation: 'useItem',
        data: {
          actorId: actor.id,
          itemId: 'item-Longsword',
          itemName: 'Longsword',
          targets: ['Knight', 'Guard'],
        },
        result: 'success',
      })
    );
  });

  it('branch: asking for targets with no active scene throws before anything is used', async () => {
    const calls: Array<{ method: string; args: any[] }> = [];
    const item = makeUsableItem('Longsword', ['use'], calls);
    // No `activeScene` → `game.scenes` does not exist at all.
    installDnd5e(makeActor('Knight', { type: 'npc', items: [item] }));
    const da = await makeDataAccess();

    await expect(
      da.useItem({
        actorIdentifier: 'Knight',
        itemIdentifier: 'Longsword',
        targets: ['Guard'],
      })
    ).rejects.toThrow('No active scene to find targets on');
    expect(calls).toEqual([]);
    // Thrown before the try block, so nothing is audited either.
    expect(world.audit).toEqual([]);
  });

  it('guards: unknown actor and unknown item both throw, and the item lookup is case-insensitive', async () => {
    const calls: Array<{ method: string; args: any[] }> = [];
    const item = makeUsableItem('Longsword', ['use'], calls);
    installDnd5e(makeActor('Knight', { type: 'npc', items: [item] }));
    const da = await makeDataAccess();

    await expect(
      da.useItem({ actorIdentifier: 'Nobody', itemIdentifier: 'Longsword' })
    ).rejects.toThrow('Actor not found: Nobody');
    await expect(
      da.useItem({ actorIdentifier: 'Knight', itemIdentifier: 'Halberd' })
    ).rejects.toThrow('Item "Halberd" not found on actor "Knight"');

    // Case-insensitive by name, and by id.
    await da.useItem({ actorIdentifier: 'Knight', itemIdentifier: 'longSWORD' });
    await da.useItem({ actorIdentifier: 'Knight', itemIdentifier: 'item-Longsword' });
    expect(calls).toHaveLength(2);
  });
});

// =============================================================================
// createNpcActor — cluster C / stage 3c, not cluster D. Included because it is
// the single largest hand-built document in the file and shares the exact
// mis-transcription risk this file exists to guard.
// =============================================================================

describe('createNpcActor (stage 3c, adjacent)', () => {
  const base = {
    name: 'Bog Lurker',
    creatureType: 'monstrosity',
    creatureSubtype: 'swamp',
    size: 'large',
    alignment: 'unaligned',
    cr: '1/4',
    hpAverage: 22,
    hpFormula: '4d10',
    acMode: 'flat',
    acValue: 14,
    abilities: { str: 16, dex: 8, con: 14, int: 5, wis: 11, cha: 6 },
    savingThrows: ['str', 'con'],
    walkSpeed: 20,
    flySpeed: 0,
    swimSpeed: 40,
    climbSpeed: 0,
    burrowSpeed: 10,
    hover: false,
    darkvision: 60,
    blindsight: 0,
    tremorsense: 30,
    truesight: 0,
    specialSenses: 'senses mud',
    skills: [
      { skill: 'Athletics', proficiency: 'proficient' },
      { skill: 'Stealth', proficiency: 'expert' },
      { skill: 'Bogus Skill', proficiency: 'proficient' },
    ],
    damageImmunities: ['poison'],
    damageResistances: ['bludgeoning'],
    damageVulnerabilities: [],
    conditionImmunities: ['prone'],
    languages: ['common'],
    languagesCustom: 'Swamp cant',
    biography: '<p>Lurks.</p>',
    sourceBook: 'Homebrew',
    sourcePage: '7',
    sourceRules: '2014',
  };

  it('hands Actor.create the whole npc document, field for field', async () => {
    world = installFakeFoundry({ systemId: 'dnd5e' });
    const da = await makeDataAccess();

    const res = await da.createNpcActor(base);

    expect(world.folderCreateCalls).toEqual(['Foundry MCP Creatures']);
    const folderId = world.folders[0].id;
    expect(world.createCalls).toHaveLength(1);
    expect(world.createCalls[0]).toEqual({
      name: 'Bog Lurker',
      type: 'npc',
      folder: folderId,
      system: {
        abilities: {
          // `proficient: 1` only for the abilities named in savingThrows.
          str: { value: 16, proficient: 1 },
          dex: { value: 8, proficient: 0 },
          con: { value: 14, proficient: 1 },
          int: { value: 5, proficient: 0 },
          wis: { value: 11, proficient: 0 },
          cha: { value: 6, proficient: 0 },
        },
        attributes: {
          ac: { calc: 'flat', flat: 14 },
          hp: { value: 22, max: 22, temp: 0, tempmax: 0, formula: '4d10' },
          movement: {
            walk: 20,
            fly: 0,
            swim: 40,
            climb: 0,
            burrow: 10,
            units: 'ft',
            hover: false,
            special: '',
          },
          senses: {
            darkvision: 60,
            blindsight: 0,
            tremorsense: 30,
            truesight: 0,
            units: 'ft',
            special: 'senses mud',
          },
        },
        details: {
          cr: 0.25, // '1/4' normalized to a float
          type: { value: 'monstrosity', subtype: 'swamp' },
          alignment: 'unaligned',
          biography: { value: '<p>Lurks.</p>', public: '' },
          source: {
            revision: 1,
            rules: '2014',
            book: 'Homebrew',
            page: '7',
            custom: '',
            license: '',
          },
        },
        traits: {
          size: 'lg', // 'large' → 'lg'
          di: { value: ['poison'], custom: '', bypasses: [] },
          dr: { value: ['bludgeoning'], custom: '', bypasses: [] },
          dv: { value: [], custom: '', bypasses: [] },
          ci: { value: ['prone'], custom: '' }, // NO bypasses on ci
          languages: { value: ['common'], custom: 'Swamp cant', communication: {} },
        },
        // 'expert' → 2, anything else → 1, unknown skill names dropped entirely.
        skills: { ath: { value: 1 }, ste: { value: 2 } },
      },
    });

    expect(res).toEqual({
      success: true,
      actor: { id: world.actors[0].id, name: 'Bog Lurker', cr: '1/4', folder: folderId },
      warnings: [],
    });
  });

  it('branch: acMode default omits `flat`, and unknown damage/condition values warn without blocking', async () => {
    world = installFakeFoundry({ systemId: 'dnd5e' });
    const da = await makeDataAccess();

    const res = await da.createNpcActor({
      ...base,
      name: 'Weird Thing',
      acMode: 'default',
      acValue: 99,
      cr: 5,
      size: 'colossal', // not in NPC_SIZE_MAP
      damageImmunities: ['sonic'],
      conditionImmunities: ['bewildered'],
      skills: [],
    });

    const system = world.createCalls[0].system;
    expect(system.attributes.ac).toEqual({ calc: 'default' });
    expect('flat' in system.attributes.ac).toBe(false);
    expect(system.traits.size).toBe('med'); // unmapped size falls back to 'med'
    expect(system.details.cr).toBe(5);
    expect(system.skills).toEqual({});
    expect(res.actor.cr).toBe('5');
    expect(res.warnings).toEqual([
      'Unknown damage type "sonic" in damageImmunities — verify it matches dnd5e system values',
      'Unknown condition "bewildered" in conditionImmunities — verify it matches dnd5e system values',
    ]);
  });

  it('guards: the duplicate check only looks at other NPCs', async () => {
    // A PLAYER character named Bog Lurker must not block NPC creation.
    world = installFakeFoundry({
      actors: [makeActor('Bog Lurker', { type: 'character' })],
      systemId: 'dnd5e',
    });
    let da = await makeDataAccess();
    await expect(da.createNpcActor(base)).resolves.toMatchObject({ success: true });

    // A second NPC of the same name does block.
    da = await makeDataAccess();
    await expect(da.createNpcActor(base)).rejects.toThrow(/NPC "Bog Lurker" already exists/);
  });
});
