/**
 * World of Darkness 20th System Adapter
 *
 * Implements SystemAdapter for the `worldofdarkness` system (M20/V20/W20/…).
 * Character-focused: live actors are all Foundry `type:"PC"`, differentiated by
 * `system.settings.splat`. Creature indexing/filtering/formatting delegate to
 * filters.ts and index-builder.ts; character extraction delegates to extract.ts.
 * Mirrors dsa5/adapter.ts.
 */

import type {
  SystemAdapter,
  SystemMetadata,
  SystemCreatureIndex,
  WoDCreatureIndex,
} from '../types.js';
import {
  WoDFiltersSchema,
  matchesWoDFilters,
  describeWoDFilters,
  type WoDFilters,
} from './filters.js';
import { extractCharacterStats } from './extract.js';

export class WorldOfDarknessAdapter implements SystemAdapter {
  getMetadata(): SystemMetadata {
    return {
      id: 'worldofdarkness',
      name: 'worldofdarkness',
      displayName: 'World of Darkness 20th (M20/V20/W20/…)',
      version: '1.0.0',
      description:
        'Support for World of Darkness 20th-Anniversary (Mage/Vampire/Werewolf/Changeling/Hunter/… ' +
        'and Gods & Monsters creatures). Items-first PC actors: 9 attributes under system.*, ' +
        'everything else (abilities, willpower, pools, virtues, powers, spheres, charms) as embedded items.',
      supportedFeatures: {
        creatureIndex: true,
        characterStats: true,
        spellcasting: true, // Spheres / rotes / disciplines count as spellcasting-equivalent
        powerLevel: true, // splat power trait (Arete / Blood Pool / Rage / Essence …)
      },
    };
  }

  canHandle(systemId: string): boolean {
    return systemId.toLowerCase() === 'worldofdarkness';
  }

  extractCreatureData(
    _doc: any,
    _pack: any
  ): { creature: SystemCreatureIndex; errors: number } | null {
    // Runs in Foundry's browser context — delegated to WoDIndexBuilder.
    throw new Error('extractCreatureData should be called from WoDIndexBuilder, not the adapter');
  }

  getFilterSchema() {
    return WoDFiltersSchema;
  }

  matchesFilters(creature: SystemCreatureIndex, filters: Record<string, any>): boolean {
    // Strict schema → unknown filter keys fail parsing → reject (not our filters).
    const validated = WoDFiltersSchema.safeParse(filters);
    if (!validated.success) {
      return false;
    }
    return matchesWoDFilters(creature, validated.data as WoDFilters);
  }

  getDataPaths(): Record<string, string | null> {
    return {
      // The ONLY system.* trait block — the 9 attributes. Everything else is
      // items-first (embedded Ability/Advantage/Sphere/Power/Feature items).
      attributes: 'system.attributes',
      settings: 'system.settings', // capability flags + splat/game/variant
      splat: 'system.settings.splat',
      health: 'system.health.damage',
      soak: 'system.soak',
      bio: 'system.bio',
      splatfields: 'system.bio.splatfields',
      // NOTE: abilities, willpower, pools, virtues, spheres, disciplines, gifts,
      // charms, merits, flaws, backgrounds are embedded items[], NOT system paths.

      // D&D5e / PF2e-only concepts that do not exist in WoD.
      challengeRating: null,
      hitPoints: null,
      armorClass: null,
      level: null,
      rarity: null,
      creatureType: null,
      alignment: null,
      size: null,
      legendaryActions: null,
      perception: null,
      saves: null,
    };
  }

  formatCreatureForList(creature: SystemCreatureIndex): any {
    const wod = creature as WoDCreatureIndex;
    const formatted: any = {
      id: creature.id,
      name: creature.name,
      type: creature.type,
      pack: {
        id: creature.packName,
        label: creature.packLabel,
      },
    };

    if (wod.systemData) {
      const stats: any = {};
      if (wod.systemData.splat) stats.splat = wod.systemData.splat;
      if (wod.systemData.powerTrait) stats.powerTrait = wod.systemData.powerTrait;
      if (wod.systemData.powerLevel !== undefined) stats.powerLevel = wod.systemData.powerLevel;
      if (wod.systemData.capabilities?.length) stats.capabilities = wod.systemData.capabilities;
      if (Object.keys(stats).length > 0) formatted.stats = stats;
    }

    if (creature.img) formatted.hasImage = true;

    return formatted;
  }

  formatCreatureForDetails(creature: SystemCreatureIndex): any {
    const wod = creature as WoDCreatureIndex;
    const formatted = this.formatCreatureForList(creature);

    if (wod.systemData) {
      formatted.detailedStats = {
        splat: wod.systemData.splat,
        game: wod.systemData.game,
        variant: wod.systemData.variant,
        powerTrait: wod.systemData.powerTrait,
        powerLevel: wod.systemData.powerLevel,
        capabilities: wod.systemData.capabilities ?? [],
      };
    }

    if (creature.img) formatted.img = creature.img;

    return formatted;
  }

  describeFilters(filters: Record<string, any>): string {
    const validated = WoDFiltersSchema.safeParse(filters);
    if (!validated.success) {
      return 'invalid filters';
    }
    return describeWoDFilters(validated.data as WoDFilters);
  }

  getPowerLevel(creature: SystemCreatureIndex): number | undefined {
    const wod = creature as WoDCreatureIndex;
    return wod.systemData?.powerLevel;
  }

  extractCharacterStats(actorData: any): any {
    return extractCharacterStats(actorData);
  }
}
