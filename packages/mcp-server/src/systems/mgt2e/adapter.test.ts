/**
 * MGT2e Adapter Tests
 *
 * Validates filter logic, character-stat extraction, and basic-info extraction
 * for the Mongoose Traveller 2e system adapter against representative actor
 * fixtures drawn from the mgt2e template.json data model.
 */

import { describe, it, expect } from 'vitest';
import { MGT2eAdapter } from './adapter.js';
import { matchesMGT2eFilters, describeMGT2eFilters } from './filters.js';
import { calcDM } from './constants.js';
import type { MGT2eCreatureIndex } from '../types.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** Typical traveller (player character) actor. */
const korvath: any = {
  name: 'Korvath Renn',
  type: 'traveller',
  img: 'icons/svg/mystery-man.svg',
  system: {
    characteristics: {
      STR: { value: 7 },
      DEX: { value: 9 },
      END: { value: 6 },
      INT: { value: 11 },
      EDU: { value: 10 },
      SOC: { value: 8 },
    },
    damage: {
      STR: { value: 2 }, // STR wounded: effective = 7 - 2 = 5
      DEX: { value: 0 },
      END: { value: 0, tmp: 0 },
    },
    skills: {
      pilot: {
        value: 0,
        trained: true,
        specialities: {
          spacecraft: { value: 2, trained: true },
          smallCraft: { value: 1, trained: true },
          capitalShips: { value: 0, trained: false },
        },
      },
      mechanic: { value: 1, trained: true },
      stealth: { value: 0, trained: false },
      admin: { value: 0 },
    },
    hits: { value: 22, max: 25 },
    sophont: {
      species: 'Human',
      gender: 'M',
      age: 34,
      homeworld: 'Regina/Spinward Marches',
      profession: 'Armada Imperial — Capitán',
      weight: 82,
      height: 178,
    },
    description: 'Ex-Navy captain turned free trader.',
  },
  items: [],
};

/** NPC actor — minimal finance field, no damage block. */
const gunnerySergeant: any = {
  name: 'Sgt. Vaala Kresh',
  type: 'npc',
  system: {
    characteristics: {
      STR: { value: 10 },
      DEX: { value: 8 },
      END: { value: 9 },
      INT: { value: 7 },
      EDU: { value: 6 },
      SOC: { value: 5 },
    },
    skills: {
      guncombat: {
        value: 2,
        trained: true,
        specialities: {
          slug: { value: 3, trained: true },
          energy: { value: 2, trained: true },
          archaic: { value: 0, trained: false },
        },
      },
      tactics: { value: 1, trained: true },
    },
    hits: { value: 28, max: 28 },
    sophont: { species: 'Human', gender: 'F', age: 29, profession: 'Marine' },
  },
  items: [],
};

/** Spacecraft actor. */
const farTrader: any = {
  name: 'Autumn Gold',
  type: 'spacecraft',
  system: {
    spacecraft: {
      dtons: 200,
      configuration: 'streamlined',
      tl: 12,
      mdrive: 1,
      jdrive: 2,
      rdrive: 0,
      armour: 4,
    },
    hits: { value: 160, max: 160 },
    initiative: { base: 0, value: 0 },
    description: 'Far Trader, 200-ton hull.',
  },
  items: [],
};

/** Creature actor. */
const grizzlyBear: any = {
  name: 'Ursa Major Cave Bear',
  type: 'creature',
  system: {
    behaviour: 'carnivore chaser',
    traits: 'Large (+1), Natural Weapons (Claws 3D6)',
    hits: { value: 30, max: 30 },
    description: 'Massive cave predator.',
  },
  items: [],
};

/** Vehicle actor. */
const grav: any = {
  name: 'Air/Raft Mk-III',
  type: 'vehicle',
  system: {
    vehicle: {
      chassis: 'lightGround',
      subtype: 'gravVehicle',
      tl: 10,
      skill: 'flyer.grav',
    },
    description: 'Standard civilian grav vehicle.',
  },
  items: [],
};

/** World actor. */
const walston: any = {
  name: 'Walston',
  type: 'world',
  system: {
    world: {
      uwp: {
        port: 'C',
        size: 5,
        atmosphere: 4,
        hydrographics: 4,
        population: 3,
        government: 3,
        lawLevel: 8,
        techLevel: 8,
        zone: null,
        bases: 'S',
        codes: 'Ni',
      },
    },
    description: 'Cold tundra world, 70% Vargr population.',
  },
  items: [],
};

// Creature-index stubs used by filter tests
const vargrRaider: MGT2eCreatureIndex = {
  id: 'vargr-1',
  name: 'Vargr Raider',
  type: 'creature',
  packName: 'mgt2e.creatures',
  packLabel: 'MGT2e Creatures',
  system: 'mgt2e',
  systemData: {
    hits: 18,
    creatureType: 'alien',
    hasPsionics: false,
    characteristics: { STR: { value: 9, dm: 1 }, DEX: { value: 8, dm: 0 } },
  },
};

const zhodaniPsiLord: MGT2eCreatureIndex = {
  id: 'psi-1',
  name: 'Zhodani Psi-lord',
  type: 'traveller',
  packName: 'mgt2e.npcs',
  packLabel: 'MGT2e NPCs',
  system: 'mgt2e',
  systemData: {
    hits: 30,
    creatureType: 'humanoid',
    hasPsionics: true,
    characteristics: { STR: { value: 7, dm: 0 }, PSI: { value: 12, dm: 2 } },
  },
};

// ─── Adapter metadata ────────────────────────────────────────────────────────

describe('MGT2eAdapter metadata', () => {
  const adapter = new MGT2eAdapter();

  it('identifies as mgt2e and handles the system id', () => {
    expect(adapter.getMetadata().id).toBe('mgt2e');
    expect(adapter.canHandle('mgt2e')).toBe(true);
    expect(adapter.canHandle('MGT2E')).toBe(true);
    expect(adapter.canHandle('dnd5e')).toBe(false);
    expect(adapter.canHandle('pf2e')).toBe(false);
  });

  it('reports character-focused feature support', () => {
    const features = adapter.getMetadata().supportedFeatures;
    expect(features.characterStats).toBe(true);
    expect(features.creatureIndex).toBe(false);
    expect(features.spellcasting).toBe(false);
    expect(features.powerLevel).toBe(false);
  });

  it('getPowerLevel always returns undefined', () => {
    expect(adapter.getPowerLevel(vargrRaider)).toBeUndefined();
    expect(adapter.getPowerLevel(zhodaniPsiLord)).toBeUndefined();
  });
});

// ─── Filter logic ────────────────────────────────────────────────────────────

describe('matchesMGT2eFilters — hits', () => {
  it('minHits passes creatures above threshold', () => {
    expect(matchesMGT2eFilters(vargrRaider, { minHits: 15 })).toBe(true);
    expect(matchesMGT2eFilters(vargrRaider, { minHits: 20 })).toBe(false);
  });

  it('maxHits passes creatures below threshold', () => {
    expect(matchesMGT2eFilters(zhodaniPsiLord, { maxHits: 35 })).toBe(true);
    expect(matchesMGT2eFilters(zhodaniPsiLord, { maxHits: 25 })).toBe(false);
  });

  it('minHits + maxHits combined as AND', () => {
    expect(matchesMGT2eFilters(vargrRaider, { minHits: 10, maxHits: 20 })).toBe(true);
    expect(matchesMGT2eFilters(zhodaniPsiLord, { minHits: 10, maxHits: 20 })).toBe(false);
  });
});

describe('matchesMGT2eFilters — psionics', () => {
  it('hasPsionics:true only matches psionic creatures', () => {
    expect(matchesMGT2eFilters(zhodaniPsiLord, { hasPsionics: true })).toBe(true);
    expect(matchesMGT2eFilters(vargrRaider, { hasPsionics: true })).toBe(false);
  });

  it('hasPsionics:false only matches non-psionic creatures', () => {
    expect(matchesMGT2eFilters(vargrRaider, { hasPsionics: false })).toBe(true);
    expect(matchesMGT2eFilters(zhodaniPsiLord, { hasPsionics: false })).toBe(false);
  });
});

describe('matchesMGT2eFilters — creatureType', () => {
  it('filters by creatureType string', () => {
    expect(matchesMGT2eFilters(vargrRaider, { creatureType: 'alien' })).toBe(true);
    expect(matchesMGT2eFilters(zhodaniPsiLord, { creatureType: 'alien' })).toBe(false);
    expect(matchesMGT2eFilters(zhodaniPsiLord, { creatureType: 'humanoid' })).toBe(true);
  });
});

describe('describeMGT2eFilters', () => {
  it('produces a human-readable description', () => {
    const desc = describeMGT2eFilters({ minHits: 10, hasPsionics: true, creatureType: 'alien' });
    expect(desc).toContain('10');
    expect(desc).toContain('psionic');
    expect(desc).toContain('alien');
  });

  it('returns non-empty string for empty filter set', () => {
    expect(describeMGT2eFilters({})).toBeTruthy();
  });
});

// ─── extractCharacterStats ───────────────────────────────────────────────────

describe('extractCharacterStats — characteristics', () => {
  const adapter = new MGT2eAdapter();

  it('extracts all six core characteristics with values and DMs', () => {
    const stats = adapter.extractCharacterStats(korvath);
    expect(stats.characteristics).toBeDefined();
    expect(stats.characteristics.STR.value).toBe(7);
    expect(stats.characteristics.DEX.value).toBe(9);
    expect(stats.characteristics.END.value).toBe(6);
    expect(stats.characteristics.INT.value).toBe(11);
    expect(stats.characteristics.EDU.value).toBe(10);
    expect(stats.characteristics.SOC.value).toBe(8);
  });

  it('calculates DMs correctly against the effective (post-damage) value', () => {
    const stats = adapter.extractCharacterStats(korvath);
    // DEX 9 (undamaged) → DM+1, INT 11 → DM+1, EDU 10 → DM+1
    expect(stats.characteristics.DEX.dm).toBe(1);
    expect(stats.characteristics.INT.dm).toBe(1);
    expect(stats.characteristics.EDU.dm).toBe(1);
    // STR value=7 but damage=2 → effective=5 → DM-1 (DM is on effective, not raw value)
    expect(stats.characteristics.STR.dm).toBe(-1);
    // END 6 (undamaged) → DM+0 (6-8 bracket = 0 in Traveller)
    expect(stats.characteristics.END.dm).toBe(0);
  });

  it('surfaces damage and effective value when characteristic is wounded', () => {
    const stats = adapter.extractCharacterStats(korvath);
    // STR 7, damage 2 → effective 5
    expect(stats.characteristics.STR.damage).toBe(2);
    expect(stats.characteristics.STR.effective).toBe(5);
  });

  it('omits damage/effective when undamaged', () => {
    const stats = adapter.extractCharacterStats(korvath);
    expect(stats.characteristics.DEX.damage).toBeUndefined();
    expect(stats.characteristics.DEX.effective).toBeUndefined();
  });
});

describe('extractCharacterStats — skills', () => {
  const adapter = new MGT2eAdapter();

  it('extracts skill levels', () => {
    const stats = adapter.extractCharacterStats(korvath);
    expect(stats.skills).toBeDefined();
    expect(stats.skills.mechanic.level).toBe(1);
    expect(stats.skills.stealth.level).toBe(0);
    expect(stats.skills.admin.level).toBe(0);
  });

  it('includes specialities with value > 0 or trained: true', () => {
    const stats = adapter.extractCharacterStats(korvath);
    const pilotSpecs = stats.skills.pilot?.specialities ?? {};
    expect(pilotSpecs.spacecraft).toBe(2);
    expect(pilotSpecs.smallCraft).toBe(1);
  });

  it('excludes specialities with value 0 and trained: false', () => {
    const stats = adapter.extractCharacterStats(korvath);
    const pilotSpecs = stats.skills.pilot?.specialities ?? {};
    expect(pilotSpecs.capitalShips).toBeUndefined();
  });

  it('includes trained specialities even at level 0 (cross-trained)', () => {
    const stats = adapter.extractCharacterStats(gunnerySergeant);
    const gcSpecs = stats.skills.guncombat?.specialities ?? {};
    expect(gcSpecs.slug).toBe(3);
    expect(gcSpecs.energy).toBe(2);
    // archaic is trained:false at 0 — excluded
    expect(gcSpecs.archaic).toBeUndefined();
  });
});

describe('extractCharacterStats — wounds / hits', () => {
  const adapter = new MGT2eAdapter();

  it('extracts hits value and max', () => {
    const stats = adapter.extractCharacterStats(korvath);
    expect(stats.hits.value).toBe(22);
    expect(stats.hits.max).toBe(25);
  });

  it('works with NPC full-health hits', () => {
    const stats = adapter.extractCharacterStats(gunnerySergeant);
    expect(stats.hits.value).toBe(28);
    expect(stats.hits.max).toBe(28);
  });
});

// ─── extractBasicInfo ────────────────────────────────────────────────────────

describe('extractBasicInfo — traveller / npc', () => {
  const adapter = new MGT2eAdapter();

  it('extracts sophont fields from a traveller actor', () => {
    const info = adapter.extractBasicInfo(korvath);
    expect(info.actorType).toBe('traveller');
    expect(info.species).toBe('Human');
    expect(info.gender).toBe('M');
    expect(info.age).toBe(34);
    expect(info.homeworld).toBe('Regina/Spinward Marches');
    expect(info.profession).toBe('Armada Imperial — Capitán');
  });

  it('extracts sophont fields from an npc actor', () => {
    const info = adapter.extractBasicInfo(gunnerySergeant);
    expect(info.actorType).toBe('npc');
    expect(info.species).toBe('Human');
    expect(info.profession).toBe('Marine');
  });
});

describe('extractBasicInfo — spacecraft', () => {
  const adapter = new MGT2eAdapter();

  it('extracts spacecraft data', () => {
    const info = adapter.extractBasicInfo(farTrader);
    expect(info.actorType).toBe('spacecraft');
    expect(info.dtons).toBe(200);
    expect(info.configuration).toBe('streamlined');
    expect(info.techLevel).toBe(12);
    expect(info.mDrive).toBe(1);
    expect(info.jDrive).toBe(2);
    expect(info.armour).toBe(4);
  });
});

describe('extractBasicInfo — creature', () => {
  const adapter = new MGT2eAdapter();

  it('extracts behaviour and traits', () => {
    const info = adapter.extractBasicInfo(grizzlyBear);
    expect(info.actorType).toBe('creature');
    expect(info.behaviour).toBe('carnivore chaser');
    expect(info.traits).toContain('Large');
  });
});

describe('extractBasicInfo — vehicle', () => {
  const adapter = new MGT2eAdapter();

  it('extracts vehicle chassis and skill', () => {
    const info = adapter.extractBasicInfo(grav);
    expect(info.actorType).toBe('vehicle');
    expect(info.chassis).toBe('lightGround');
    expect(info.subtype).toBe('gravVehicle');
    expect(info.techLevel).toBe(10);
    expect(info.skill).toBe('flyer.grav');
  });
});

describe('extractBasicInfo — world', () => {
  const adapter = new MGT2eAdapter();

  it('extracts UWP data', () => {
    const info = adapter.extractBasicInfo(walston);
    expect(info.actorType).toBe('world');
    expect(info.uwp).toBeDefined();
    expect(info.uwp.port).toBe('C');
    expect(info.uwp.population).toBe(3);
    expect(info.uwp.techLevel).toBe(8);
    expect(info.uwp.bases).toBe('S');
  });
});

describe('extractBasicInfo — actorType always present', () => {
  const adapter = new MGT2eAdapter();

  it('always includes actorType regardless of actor type', () => {
    const types = [korvath, gunnerySergeant, farTrader, grizzlyBear, grav, walston];
    for (const actor of types) {
      const info = adapter.extractBasicInfo(actor);
      expect(info.actorType).toBeTruthy();
      expect(typeof info.actorType).toBe('string');
    }
  });
});

// ─── calcDM boundary regression ─────────────────────────────────────────────
//
// These tests document the canonical DM table and guard the value=2 boundary
// that was returning -1 instead of -2 in the browser-side calcMGT2eDM before
// the fix (value === 1 → value <= 2).
//
// Table: 0=-3, 1-2=-2, 3-5=-1, 6-8=0, 9-11=+1, 12-14=+2, 15+=+3

describe('calcDM — characteristic DM table', () => {
  it('value=0 → DM -3 (min)', () => {
    expect(calcDM(0)).toBe(-3);
  });

  it('boundary value=1 and value=2 both return DM -2', () => {
    expect(calcDM(1)).toBe(-2);
    expect(calcDM(2)).toBe(-2); // regression: was returning -1 before fix
  });

  it('value=3 starts the -1 bracket; value=5 ends it', () => {
    expect(calcDM(3)).toBe(-1);
    expect(calcDM(5)).toBe(-1);
  });

  it('value=6 starts the 0 bracket; value=8 ends it (not -1)', () => {
    expect(calcDM(6)).toBe(0);
    expect(calcDM(8)).toBe(0);
  });

  it('value=9..11 → DM +1', () => {
    expect(calcDM(9)).toBe(1);
    expect(calcDM(11)).toBe(1);
  });

  it('value=12..14 → DM +2', () => {
    expect(calcDM(12)).toBe(2);
    expect(calcDM(14)).toBe(2);
  });

  it('value=15+ → DM +3 (capped)', () => {
    expect(calcDM(15)).toBe(3);
    expect(calcDM(20)).toBe(3);
  });
});
