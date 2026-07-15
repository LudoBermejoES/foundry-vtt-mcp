/**
 * Mongoose Traveller 2e System Adapter
 *
 * Implements SystemAdapter for the mgt2e Foundry system
 * (https://github.com/Mongoose-Publishing/traveller-foundryvtt).
 *
 * Handles characteristic extraction (STR/DEX/END/INT/EDU/SOC with DM),
 * skills with levels 0-4, wounds, career/rank, and creature indexing.
 */

import type { SystemAdapter, SystemMetadata, SystemCreatureIndex } from '../types.js';
import type { MGT2eCreatureIndex } from '../types.js';
import {
  MGT2eFiltersSchema,
  matchesMGT2eFilters,
  describeMGT2eFilters,
  type MGT2eFilters,
} from './filters.js';
import { CHARACTERISTIC_NAMES, ACTOR_TYPES, calcDM } from './constants.js';
import { normalizeMGT2eSkillsInSystem } from './normalize.js';

export class MGT2eAdapter implements SystemAdapter {
  getMetadata(): SystemMetadata {
    return {
      id: 'mgt2e',
      name: 'mgt2e',
      displayName: 'Mongoose Traveller 2e',
      version: '1.0.0',
      description:
        'Support for Mongoose Traveller 2nd Edition with characteristics (STR/DEX/END/INT/EDU/SOC), ' +
        'skills with levels 0–4, wounds, career/rank, spacecraft, and creature indexing.',
      supportedFeatures: {
        creatureIndex: false,
        characterStats: true,
        spellcasting: false, // Psionics handled separately
        powerLevel: false,
      },
    };
  }

  canHandle(systemId: string): boolean {
    return systemId.toLowerCase() === 'mgt2e';
  }

  /**
   * extractCreatureData is delegated to MGT2eIndexBuilder (browser context).
   */
  extractCreatureData(
    _doc: any,
    _pack: any
  ): { creature: SystemCreatureIndex; errors: number } | null {
    throw new Error('extractCreatureData should be called from MGT2eIndexBuilder, not the adapter');
  }

  getFilterSchema() {
    return MGT2eFiltersSchema;
  }

  matchesFilters(creature: SystemCreatureIndex, filters: Record<string, any>): boolean {
    const validated = MGT2eFiltersSchema.safeParse(filters);
    if (!validated.success) return false;
    return matchesMGT2eFilters(creature, validated.data as MGT2eFilters);
  }

  getDataPaths(): Record<string, string | null> {
    return {
      // mgt2e paths
      characteristics: 'system.characteristics',
      str: 'system.characteristics.str.value',
      dex: 'system.characteristics.dex.value',
      end: 'system.characteristics.end.value',
      int: 'system.characteristics.int.value',
      edu: 'system.characteristics.edu.value',
      soc: 'system.characteristics.soc.value',
      psi: 'system.characteristics.psi.value',
      skills: 'system.skills',
      hits: 'system.hits',
      details: 'system.details',

      // D&D5e / PF2e paths — not applicable
      challengeRating: null,
      creatureType: null,
      alignment: null,
      hitPoints: null,
      armorClass: null,
      legendaryActions: null,
      legendaryResistances: null,
      perception: null,
      saves: null,
      rarity: null,
    };
  }

  formatCreatureForList(creature: SystemCreatureIndex): any {
    const mgt2eCreature = creature as MGT2eCreatureIndex;
    const formatted: any = {
      id: creature.id,
      name: creature.name,
      type: creature.type,
      pack: { id: creature.packName, label: creature.packLabel },
    };

    if (mgt2eCreature.systemData) {
      const stats: any = {};
      if (mgt2eCreature.systemData.hits !== undefined) stats.hits = mgt2eCreature.systemData.hits;
      if (mgt2eCreature.systemData.creatureType)
        stats.creatureType = mgt2eCreature.systemData.creatureType;
      if (mgt2eCreature.systemData.hasPsionics) stats.psionic = true;
      if (Object.keys(stats).length > 0) formatted.stats = stats;
    }

    if (creature.img) formatted.hasImage = true;
    return formatted;
  }

  formatCreatureForDetails(creature: SystemCreatureIndex): any {
    const mgt2eCreature = creature as MGT2eCreatureIndex;
    const formatted = this.formatCreatureForList(creature);

    if (mgt2eCreature.systemData) {
      formatted.detailedStats = {
        hits: mgt2eCreature.systemData.hits,
        creatureType: mgt2eCreature.systemData.creatureType,
        hasPsionics: mgt2eCreature.systemData.hasPsionics ?? false,
        characteristics: mgt2eCreature.systemData.characteristics ?? {},
      };
    }

    if (creature.img) formatted.img = creature.img;
    return formatted;
  }

  describeFilters(filters: Record<string, any>): string {
    const validated = MGT2eFiltersSchema.safeParse(filters);
    if (!validated.success) return 'invalid filters';
    return describeMGT2eFilters(validated.data as MGT2eFilters);
  }

  getPowerLevel(_creature: SystemCreatureIndex): number | undefined {
    return undefined;
  }

  // ─── Character stats extraction (MCP server / Node.js context) ──────────────

  /**
   * Extract full character statistics from a mgt2e actor document.
   * Called by the get-character tool after receiving raw actor data from Foundry.
   */
  extractCharacterStats(actorData: any): any {
    const system = actorData.system || {};
    const stats: any = {};

    // ── Characteristics ──────────────────────────────────────────────────────
    // mgt2e stores characteristics with uppercase keys (STR, DEX, END, INT, EDU, SOC)
    // but we also handle lowercase (str, dex…) for robustness.
    if (system.characteristics && Object.keys(system.characteristics).length > 0) {
      stats.characteristics = {};
      // Characteristic damage is stored separately in system.damage.STR.value
      const charDamage: Record<string, number> = {};
      if (system.damage && typeof system.damage === 'object') {
        for (const [k, v] of Object.entries(system.damage)) {
          const dmgVal = typeof v === 'object' ? ((v as any).value ?? 0) : 0;
          charDamage[k.toUpperCase()] = dmgVal;
        }
      }

      for (const [key, charData] of Object.entries(system.characteristics)) {
        const c = charData as any;
        // mgt2e stores value directly; also handle nested {value: N}
        const value: number = typeof c === 'number' ? c : (c.value ?? c.current ?? 0);
        // Lookup by uppercase key (STR) or lowercase (str)
        const lookupKey = key.toLowerCase();
        const names = CHARACTERISTIC_NAMES[lookupKey];
        if (!names) continue;

        const damage: number = charDamage[key.toUpperCase()] ?? c.damage ?? 0;
        const effective: number = Math.max(0, value - damage);

        stats.characteristics[names.short] = {
          value,
          ...(damage > 0 ? { damage, effective } : {}),
          dm: calcDM(effective),
          full: names.full,
        };
      }
    }

    // ── Skills ───────────────────────────────────────────────────────────────
    if (system.skills) {
      stats.skills = {};
      for (const [key, skillData] of Object.entries(system.skills)) {
        const s = skillData as any;
        const level: number = s.value ?? 0;
        // Only include trained skills (level > 0) to keep output compact,
        // but always include level-0 skills so the GM can see what's untrained.
        stats.skills[key] = { level };

        // Include specialities if present (note: mgt2e spells it with 'i')
        if (s.specialities && Object.keys(s.specialities).length > 0) {
          const specs: Record<string, number> = {};
          for (const [specKey, specData] of Object.entries(s.specialities)) {
            const sp = specData as any;
            if (sp.trained || (sp.value ?? 0) > 0) {
              specs[specKey] = sp.value ?? 0;
            }
          }
          if (Object.keys(specs).length > 0) stats.skills[key].specialities = specs;
        }
      }
    }

    // ── Wounds / Hits ────────────────────────────────────────────────────────
    if (system.hits !== undefined) {
      stats.hits = {
        value: system.hits.value ?? system.hits ?? 0,
        max: system.hits.max ?? system.hits ?? 0,
      };
    }
    // Some versions store damage separately
    if (system.damage) {
      stats.damage = {
        physical: system.damage.physical ?? 0,
        stun: system.damage.stun ?? 0,
      };
    }

    return stats;
  }

  /**
   * Extract basic info for the get-character response top-level basicInfo block.
   *
   * mgt2e field paths by actor type:
   * - traveller/npc/package: system.sophont.{species,gender,age,homeworld,profession}
   *   Career data comes from embedded 'term' items (no direct career/rank field on actor).
   * - creature: system.behaviour (space-separated keys), system.traits (comma-separated string)
   * - spacecraft: system.spacecraft.{dtons,configuration,tl,mdrive,jdrive,rdrive}
   * - vehicle: system.vehicle.{chassis,subtype,tl,skill}
   * - world: system.world.uwp.*
   */
  extractBasicInfo(actorData: any): any {
    const system = actorData.system || {};
    const basicInfo: any = {};
    const actorType = actorData.type ?? 'traveller';

    if (['traveller', 'npc', 'package'].includes(actorType)) {
      // Personal details live in system.sophont (NOT system.details — that field doesn't exist)
      const sophont = system.sophont ?? {};
      if (sophont.species) basicInfo.species = sophont.species;
      if (sophont.gender) basicInfo.gender = sophont.gender;
      if (typeof sophont.age === 'number' && sophont.age > 0) basicInfo.age = sophont.age;
      if (sophont.homeworld) basicInfo.homeworld = sophont.homeworld;
      if (sophont.profession) basicInfo.profession = sophont.profession;
      if (sophont.weight) basicInfo.weight = sophont.weight;
      if (sophont.height) basicInfo.height = sophont.height;
      // career/rank come from term items — not a direct system field
      if (system.description) basicInfo.description = system.description;
    } else if (actorType === 'creature') {
      if (system.behaviour) basicInfo.behaviour = system.behaviour;
      if (system.traits) basicInfo.traits = system.traits;
      if (system.description) basicInfo.description = system.description;
    } else if (actorType === 'spacecraft') {
      const sc = system.spacecraft ?? {};
      if (sc.dtons) basicInfo.dtons = sc.dtons;
      if (sc.configuration) basicInfo.configuration = sc.configuration;
      if (sc.tl) basicInfo.techLevel = sc.tl;
      if (sc.mdrive !== undefined) basicInfo.mDrive = sc.mdrive;
      if (sc.jdrive !== undefined) basicInfo.jDrive = sc.jdrive;
      if (sc.rdrive !== undefined) basicInfo.rDrive = sc.rdrive;
      if (sc.armour !== undefined) basicInfo.armour = sc.armour;
      if (system.description) basicInfo.description = system.description;
    } else if (actorType === 'vehicle') {
      const v = system.vehicle ?? {};
      if (v.chassis) basicInfo.chassis = v.chassis;
      if (v.subtype) basicInfo.subtype = v.subtype;
      if (v.tl) basicInfo.techLevel = v.tl;
      if (v.skill) basicInfo.skill = v.skill;
      if (system.description) basicInfo.description = system.description;
    } else if (actorType === 'world') {
      const w = system.world ?? {};
      if (w.uwp) basicInfo.uwp = w.uwp;
      if (system.description) basicInfo.description = system.description;
    }

    // Actor type hint
    basicInfo.actorType = actorType;

    return basicInfo;
  }

  describeActorSchema(): string {
    return [
      '=== mgt2e Actor Schema Reference ===',
      '',
      'ACTOR TYPES: traveller, npc, creature, spacecraft, vehicle, world, package, swarm',
      '',
      'CHARACTERISTICS (traveller/npc) — system.characteristics:',
      '  Full:      { STR:{value:8,show:true}, DEX:{value:9,show:true}, ... }',
      '  Shorthand: { str:8, dex:9, end:7, int:8, edu:10, soc:7 }  (uppercase + show:true auto-applied)',
      '  Hits (STR+DEX+END) calculated automatically when omitted.',
      '',
      'SKILLS (traveller/npc) — system.skills:',
      '  Shorthand: { pilot:2, medic:1 }  (trained flag set automatically)',
      '  Full:      { pilot:{value:0,trained:true,specialities:{spacecraft:{value:2,trained:true}}} }',
      '  Spec-skills: animals, art, athletics, drive, electronics, engineer, flyer, gunner,',
      '    guncombat, heavyweapons, language, melee, pilot, profession, science, seafarer, tactics',
      '',
      'SOPHONT DETAILS (traveller/npc) — system.sophont:',
      '  { species:"Human", gender:"M", age:34, profession:"Navy", homeworld:"Regina" }',
      '  Note: path is sophont, NOT details (system.details does not exist in mgt2e)',
      '',
      'CREATURE FIELDS:',
      '  system.behaviour: "carnivore pouncer"  (space-separated; see MGT2.CREATURES.behaviours)',
      '  system.traits:    "camouflaged, tough, flyer 3"  (comma-separated string)',
      '',
      'ITEM RESTRICTIONS (what can go on each actor type):',
      '  traveller:  weapon, armour, augment, term, associate, item, software',
      '  npc:        weapon, armour, augment, item, software  (NO term/associate)',
      '  creature:   weapon, armour, augment, item, software  (NO term/associate)',
      '  spacecraft: weapon, armour, augment, cargo, hardware, role, software, item',
      '  world:      cargo, item, software, worlddata',
      '',
      'HARDWARE ITEMS (spacecraft) — hardware.system discriminators:',
      '  "drive", "power", "bridge", "sensor", "armour", "weapon",',
      '  "cargo", "stateroom", "fuel", "computer", "general"',
      '  Include hardware.tonnage.tonCalc and hardware.tonnage.costCalc for correct display.',
      '  Ship weapons need weapon.scale:"spacecraft" and a weapon.power field.',
      '',
      'SOFTWARE ITEMS — required sub-object (sheet crashes without it):',
      '  { software: { class:"spacecraft", type:"generic", interface:"none", bandwidth:N } }',
      '  Bandwidth: Maneuver/0→0, Library/0→0, Jump Control/N→N×5,',
      '    Fire Control/N→N×5, Auto-Repair/N→N×5, Evade/N→N×5',
    ].join('\n');
  }

  normalizePayload(system: Record<string, any>): Record<string, any> {
    return normalizeMGT2eSkillsInSystem(system);
  }
}
