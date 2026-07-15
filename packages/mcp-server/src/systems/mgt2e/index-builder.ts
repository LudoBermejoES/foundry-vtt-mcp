/**
 * Mongoose Traveller 2e Index Builder
 *
 * Runs in Foundry's browser context to build the enhanced creature index.
 * Handles creature and NPC actor types for the mgt2e system.
 */

import type { IndexBuilder, SystemCreatureIndex } from '../types.js';
import type { MGT2eCreatureIndex } from '../types.js';
import { ACTOR_TYPES, calcDM, CHARACTERISTIC_NAMES } from './constants.js';

export class MGT2eIndexBuilder implements IndexBuilder {
  getSystemId() {
    return 'mgt2e' as const;
  }

  async buildIndex(packs: any[], _force = false): Promise<SystemCreatureIndex[]> {
    const creatures: SystemCreatureIndex[] = [];

    for (const pack of packs) {
      const { creatures: packCreatures } = await this.extractDataFromPack(pack);
      creatures.push(...packCreatures);
    }

    return creatures;
  }

  async extractDataFromPack(
    pack: any
  ): Promise<{ creatures: SystemCreatureIndex[]; errors: number }> {
    const creatures: MGT2eCreatureIndex[] = [];
    let errors = 0;

    try {
      const documents = await pack.getDocuments();

      for (const doc of documents) {
        // Index creature and NPC actor types
        if (
          doc.type !== ACTOR_TYPES.CREATURE &&
          doc.type !== ACTOR_TYPES.NPC &&
          doc.type !== ACTOR_TYPES.TRAVELLER
        ) {
          continue;
        }

        try {
          const creature = this.extractFromDocument(doc, pack);
          if (creature) creatures.push(creature);
        } catch {
          errors++;
        }
      }
    } catch {
      errors++;
    }

    return { creatures, errors };
  }

  private extractFromDocument(doc: any, pack: any): MGT2eCreatureIndex | null {
    const system = doc.system ?? {};

    // ── Characteristics ──────────────────────────────────────────────────────
    const characteristics: Record<string, { value: number; dm: number }> = {};
    if (system.characteristics) {
      for (const [key, charData] of Object.entries(system.characteristics)) {
        const c = charData as any;
        const value = c.value ?? 0;
        const names = CHARACTERISTIC_NAMES[key];
        if (names) {
          characteristics[names.short] = { value, dm: calcDM(value) };
        }
      }
    }

    // ── Hits ─────────────────────────────────────────────────────────────────
    let hits: number | undefined;
    if (system.hits !== undefined) {
      hits = typeof system.hits === 'object' ? (system.hits.max ?? system.hits.value) : system.hits;
    }

    // ── Psionics detection ────────────────────────────────────────────────────
    const psiValue = system.characteristics?.psi?.value ?? 0;
    const hasPsionics = psiValue > 0;

    // ── Creature type ─────────────────────────────────────────────────────────
    const creatureType = system.details?.type ?? system.details?.creatureType ?? undefined;

    const systemData: MGT2eCreatureIndex['systemData'] = {
      hasPsionics,
      characteristics,
    };
    if (hits !== undefined) systemData.hits = hits;
    if (creatureType !== undefined) systemData.creatureType = creatureType;

    return {
      id: doc.id,
      name: doc.name,
      type: doc.type,
      packName: pack.collection,
      packLabel: pack.metadata?.label ?? pack.collection,
      img: doc.img,
      system: 'mgt2e',
      systemData,
    };
  }
}
