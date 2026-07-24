/**
 * World of Darkness 20th Adapter Tests
 *
 * Validates the canonical character extractor and adapter behaviour against the
 * 5 real Foundry PC fixtures (mage / vampire / werewolf / mortal / creature).
 * Confirms the items-first model + capability-flag gating: no fabricated power
 * traits, splat-appropriate sections only.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { WorldOfDarknessAdapter } from './adapter.js';
import { extractCharacterStats, extractFullSheet, getCapabilityFlags } from './extract.js';

function loadFixture(name: string): any {
  return JSON.parse(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8'));
}

const mage = loadFixture('mage-pc-export.real.json');
const vampire = loadFixture('vampire-pc-export.real.json');
const werewolf = loadFixture('werewolf-pc-export.real.json');
const mortal = loadFixture('mortal-mage.foundry.real.json');
const creature = loadFixture('familiar-creature-pc-export.real.json');

const adapter = new WorldOfDarknessAdapter();

describe('WorldOfDarknessAdapter metadata', () => {
  it('identifies as worldofdarkness and handles the system id', () => {
    const meta = adapter.getMetadata();
    expect(meta.id).toBe('worldofdarkness');
    expect(meta.version).toBe('1.0.0');
    expect(meta.supportedFeatures.spellcasting).toBe(true);
    expect(adapter.canHandle('worldofdarkness')).toBe(true);
    expect(adapter.canHandle('WorldOfDarkness')).toBe(true);
    expect(adapter.canHandle('dnd5e')).toBe(false);
  });

  it('exposes attributes as the only system.* trait path (items-first)', () => {
    const paths = adapter.getDataPaths();
    expect(paths.attributes).toBe('system.attributes');
    expect(paths.challengeRating).toBeNull();
    expect(paths.hitPoints).toBeNull();
    expect(paths.level).toBeNull();
    expect(paths.rarity).toBeNull();
  });
});

describe('extractCharacterStats — attributes & abilities (all splats)', () => {
  it('groups the 9 visible attributes and drops hidden composure/resolve', () => {
    const stats = extractCharacterStats(mage);
    expect(Object.keys(stats.attributes.physical)).toEqual(['strength', 'dexterity', 'stamina']);
    expect(Object.keys(stats.attributes.social)).toEqual([
      'charisma',
      'manipulation',
      'appearance',
    ]);
    expect(Object.keys(stats.attributes.mental)).toEqual(['perception', 'intelligence', 'wits']);
    // composure / resolve are hidden (isvisible:false) and must not appear.
    expect(stats.attributes.social).not.toHaveProperty('composure');
    expect(stats.attributes.mental).not.toHaveProperty('resolve');
  });

  it('groups abilities into talents/skills/knowledges', () => {
    const stats = extractCharacterStats(mage);
    expect(Object.keys(stats.abilities.talents).length).toBe(11);
    expect(Object.keys(stats.abilities.skills).length).toBe(11);
    expect(Object.keys(stats.abilities.knowledges).length).toBe(11);
    expect(stats.abilities.talents).toHaveProperty('Alertness');
  });
});

describe('extractCharacterStats — Vampire', () => {
  const stats = extractCharacterStats(vampire);

  it('reports Blood Pool power trait + Willpower + virtues', () => {
    expect(stats.powerTrait).toBeDefined();
    expect(stats.powerTrait.name).toBe('Blood Pool');
    expect(stats.willpower).toBeDefined();
    expect(stats.virtues).toBeDefined();
    expect(stats.virtues).toHaveProperty('Virtue - Conscience');
    expect(stats.virtues).toHaveProperty('Virtue - Self-control');
    expect(stats.virtues).toHaveProperty('Virtue - Courage');
  });

  it('does NOT report Spheres or an Arete power trait', () => {
    expect(stats.spheres).toBeUndefined();
    expect(stats.powerTrait.name).not.toBe('Arete');
  });
});

describe('extractCharacterStats — Werewolf', () => {
  const stats = extractCharacterStats(werewolf);

  it('reports Rage + Gnosis + renown', () => {
    expect(stats.powerTrait.name).toBe('Rage');
    expect(stats.pools).toBeDefined();
    expect(stats.pools).toHaveProperty('gnosis');
    expect(stats.virtues).toBeDefined();
    // Renown group entries.
    expect(stats.virtues).toHaveProperty('Renown - Glory');
    expect(stats.virtues).toHaveProperty('Renown - Honor');
    expect(stats.virtues).toHaveProperty('Renown - Wisdom');
  });

  it('does not report Blood Pool or Spheres', () => {
    expect(stats.spheres).toBeUndefined();
    expect(stats.pools).not.toHaveProperty('bloodpool');
  });
});

describe('extractCharacterStats — Mage', () => {
  const stats = extractCharacterStats(mage);

  it('reports Arete + Quintessence + 9 spheres + Willpower', () => {
    expect(stats.powerTrait.name).toBe('Arete');
    expect(stats.pools).toHaveProperty('quintessence');
    expect(stats.spheres).toBeDefined();
    expect(Object.keys(stats.spheres).length).toBe(9);
    expect(stats.spheres).toHaveProperty('Correspondence');
    expect(stats.spheres).toHaveProperty('Time');
    expect(stats.willpower).toBeDefined();
  });
});

describe('extractCharacterStats — Mortal', () => {
  const stats = extractCharacterStats(mortal);

  it('reports Willpower + attributes + abilities', () => {
    expect(stats.willpower).toBeDefined();
    expect(Object.keys(stats.attributes.physical).length).toBe(3);
    expect(Object.keys(stats.abilities.talents).length).toBeGreaterThan(0);
  });

  it('does NOT fabricate a power trait, spheres, or disciplines', () => {
    expect(stats.powerTrait).toBeUndefined();
    expect(stats.spheres).toBeUndefined();
    expect(stats.essence).toBeUndefined();
    expect(stats.charms).toBeUndefined();
  });
});

describe('extractCharacterStats — Creature (familiar)', () => {
  const stats = extractCharacterStats(creature);

  it('reports Essence + Charms from the hasessence/hascharms flags', () => {
    const flags = getCapabilityFlags(creature);
    expect(flags.hasessence).toBe(true);
    expect(flags.hascharms).toBe(true);

    expect(stats.essence).toBeDefined();
    expect(stats.essence.permanent).toBe(15);

    expect(stats.powerTrait).toBeDefined();
    expect(stats.powerTrait.name).toBe('Essence');

    expect(stats.charms).toBeDefined();
    expect(stats.charms.length).toBeGreaterThan(0);
    expect(stats.charms[0].name).toBe('Conectarse');
    expect(stats.charms[0].type).toBe('wod.types.charm');
  });

  it('reports Feature-backed special advantages and flaws', () => {
    expect(stats.specialAdvantages.length).toBe(3);
    expect(stats.flaws.length).toBe(1);
  });
});

describe('extractFullSheet', () => {
  it('is a superset with a grouped dump of all embedded items', () => {
    const full = extractFullSheet(mage);
    expect(full.powerTrait.name).toBe('Arete'); // inherits extractCharacterStats
    expect(full.allItems).toBeDefined();
    expect(full.allItems.Ability.length).toBe(33);
    expect(full.allItems.Sphere.length).toBe(9);
    expect(full.capabilities.hasspheres).toBe(true);
  });
});

describe('adapter delegation', () => {
  it('adapter.extractCharacterStats delegates to extract.ts', () => {
    const viaAdapter = adapter.extractCharacterStats(vampire);
    const direct = extractCharacterStats(vampire);
    expect(viaAdapter).toEqual(direct);
  });

  it('getPowerLevel reads systemData.powerLevel', () => {
    const idx: any = { systemData: { powerLevel: 4 } };
    expect(adapter.getPowerLevel(idx)).toBe(4);
    expect(adapter.getPowerLevel({ systemData: {} } as any)).toBeUndefined();
  });
});
