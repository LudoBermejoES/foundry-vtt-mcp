/**
 * World of Darkness 20th Filter Tests
 *
 * Validates the strict filter schema (unknown keys rejected), splat/powerLevel/
 * capability matching, and the human-readable descriptions.
 */

import { describe, it, expect } from 'vitest';
import { WorldOfDarknessAdapter } from './adapter.js';
import {
  WoDFiltersSchema,
  matchesWoDFilters,
  describeWoDFilters,
  isValidWoDSplat,
} from './filters.js';

const adapter = new WorldOfDarknessAdapter();

const vampireIndex: any = {
  id: 'v1',
  name: 'Nosferatu',
  type: 'PC',
  packName: 'wod.actors',
  packLabel: 'WoD Actors',
  system: 'worldofdarkness',
  systemData: {
    splat: 'vampire',
    powerTrait: 'Blood Pool',
    powerLevel: 5,
    capabilities: ['haswillpower', 'hasvirtue', 'hasdisciplines'],
  },
};

const mageIndex: any = {
  id: 'm1',
  name: 'Hermetic',
  type: 'PC',
  system: 'worldofdarkness',
  systemData: {
    splat: 'mage',
    powerTrait: 'Arete',
    powerLevel: 3,
    capabilities: ['haswillpower', 'hasspheres', 'hasquintessence'],
  },
};

describe('WoDFiltersSchema strictness', () => {
  it('accepts valid keys', () => {
    expect(WoDFiltersSchema.safeParse({ splat: 'vampire' }).success).toBe(true);
    expect(WoDFiltersSchema.safeParse({ powerLevel: { min: 2, max: 5 } }).success).toBe(true);
    expect(WoDFiltersSchema.safeParse({ capability: 'hasdisciplines' }).success).toBe(true);
  });

  it('rejects unknown keys', () => {
    expect(WoDFiltersSchema.safeParse({ challengeRating: 5 }).success).toBe(false);
    expect(WoDFiltersSchema.safeParse({ splat: 'notasplat' }).success).toBe(false);
  });
});

describe('adapter.matchesFilters', () => {
  it('rejects an unknown filter key (returns false)', () => {
    expect(adapter.matchesFilters(vampireIndex, { challengeRating: 5 })).toBe(false);
    expect(adapter.matchesFilters(vampireIndex, { hitPoints: 20 })).toBe(false);
  });

  it('matches a vampire index entry with splat:vampire', () => {
    expect(adapter.matchesFilters(vampireIndex, { splat: 'vampire' })).toBe(true);
    expect(adapter.matchesFilters(mageIndex, { splat: 'vampire' })).toBe(false);
  });

  it('matches on powerLevel range and capability', () => {
    expect(adapter.matchesFilters(vampireIndex, { powerLevel: { min: 4, max: 6 } })).toBe(true);
    expect(adapter.matchesFilters(vampireIndex, { powerLevel: 5 })).toBe(true);
    expect(adapter.matchesFilters(vampireIndex, { powerLevel: 2 })).toBe(false);
    expect(adapter.matchesFilters(vampireIndex, { capability: 'hasdisciplines' })).toBe(true);
    expect(adapter.matchesFilters(vampireIndex, { capability: 'hasspheres' })).toBe(false);
  });
});

describe('matchesWoDFilters / describeWoDFilters', () => {
  it('empty filters match everything', () => {
    expect(matchesWoDFilters(vampireIndex, {})).toBe(true);
  });

  it('describes filters readably', () => {
    expect(describeWoDFilters({ splat: 'mage' })).toContain('mage');
    expect(describeWoDFilters({ powerLevel: { min: 2, max: 5 } })).toContain('2-5');
    expect(describeWoDFilters({})).toBe('no filters');
  });

  it('validates splats', () => {
    expect(isValidWoDSplat('Vampire')).toBe(true);
    expect(isValidWoDSplat('nonsense')).toBe(false);
  });
});
