/**
 * World of Darkness 20th — Index Builder
 *
 * Builds the enhanced creature index from Foundry compendiums. Runs in Foundry's
 * browser context (not Node.js). Mirrors dsa5/index-builder.ts.
 *
 * NOTE: our compiled compendium is mostly *Item* packs, so this may index few or
 * no Actor documents — that's expected. It must be correct and never crash.
 */

import type { IndexBuilder, WoDCreatureIndex } from '../types.js';
import { getCapabilityFlags, getEmbeddedItems } from './extract.js';

// Foundry browser globals (unavailable in Node.js TypeScript compilation)
declare const ui: any;

/** Splat → power-trait Advantage id + display name (power-level proxy). */
const SPLAT_POWER_TRAIT: Record<string, { id: string; name: string }> = {
  mage: { id: 'arete', name: 'Arete' },
  vampire: { id: 'bloodpool', name: 'Blood Pool' },
  werewolf: { id: 'rage', name: 'Rage' },
  changingbreed: { id: 'rage', name: 'Rage' },
  changeling: { id: 'glamour', name: 'Glamour' },
  wraith: { id: 'pathos', name: 'Pathos' },
  mummy: { id: 'sekhem', name: 'Sekhem' },
  demon: { id: 'faith', name: 'Faith' },
  hunter: { id: 'conviction', name: 'Conviction' },
  creature: { id: 'essence', name: 'Essence' },
};

interface WoDExtractionResult {
  creature: WoDCreatureIndex;
  errors: number;
}

/**
 * World of Darkness implementation of IndexBuilder.
 */
export class WoDIndexBuilder implements IndexBuilder {
  private moduleId: string;

  constructor(moduleId: string = 'foundry-mcp-bridge') {
    this.moduleId = moduleId;
  }

  getSystemId() {
    return 'worldofdarkness' as const;
  }

  /**
   * Build enhanced creature index from compendium packs.
   */
  async buildIndex(packs: any[], _force = false): Promise<WoDCreatureIndex[]> {
    const startTime = Date.now();
    let totalErrors = 0;

    try {
      const actorPacks = packs.filter(pack => pack?.metadata?.type === 'Actor');
      const creatures: WoDCreatureIndex[] = [];

      console.log(
        `[${this.moduleId}] Building WoD creature index from ${actorPacks.length} pack(s)...`
      );
      if (typeof ui !== 'undefined' && ui.notifications) {
        ui.notifications.info(`Building WoD creature index from ${actorPacks.length} pack(s)...`);
      }

      for (const pack of actorPacks) {
        try {
          if (!pack.indexed) {
            await pack.getIndex({});
          }
          const packResult = await this.extractDataFromPack(pack);
          creatures.push(...packResult.creatures);
          totalErrors += packResult.errors;
        } catch (error) {
          console.warn(
            `[${this.moduleId}] Failed to process pack ${pack?.metadata?.label}:`,
            error
          );
        }
      }

      const buildTimeSeconds = Math.round((Date.now() - startTime) / 1000);
      const errorText = totalErrors > 0 ? ` (${totalErrors} extraction errors)` : '';
      const message = `WoD creature index complete! ${creatures.length} indexed from ${actorPacks.length} pack(s) in ${buildTimeSeconds}s${errorText}`;
      console.log(`[${this.moduleId}] ${message}`);
      if (typeof ui !== 'undefined' && ui.notifications) {
        ui.notifications.info(message);
      }

      return creatures;
    } catch (error) {
      const errorMessage = `Failed to build WoD creature index: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`;
      console.error(`[${this.moduleId}] ${errorMessage}`);
      if (typeof ui !== 'undefined' && ui.notifications) {
        ui.notifications.error(errorMessage);
      }
      throw error;
    }
  }

  /**
   * Extract creature data from a single compendium pack.
   */
  async extractDataFromPack(pack: any): Promise<{ creatures: WoDCreatureIndex[]; errors: number }> {
    const creatures: WoDCreatureIndex[] = [];
    let errors = 0;

    try {
      const documents = await pack.getDocuments();
      for (const doc of documents) {
        try {
          const result = this.extractCreatureData(doc, pack);
          if (result) {
            creatures.push(result.creature);
            errors += result.errors;
          }
        } catch (error) {
          console.warn(
            `[${this.moduleId}] Failed to extract WoD data from ${doc?.name} in ${pack?.metadata?.label}:`,
            error
          );
          errors++;
        }
      }
    } catch (error) {
      console.warn(
        `[${this.moduleId}] Failed to load documents from ${pack?.metadata?.label}:`,
        error
      );
      errors++;
    }

    return { creatures, errors };
  }

  /**
   * Extract WoD creature data from a single Foundry document.
   */
  extractCreatureData(doc: any, pack: any): WoDExtractionResult | null {
    try {
      // Foundry `doc.items` is a Collection; normalise to a plain array.
      const items: any[] = doc?.items?.contents ?? (Array.isArray(doc?.items) ? doc.items : []);
      const actorData = { system: doc?.system ?? {}, items };
      const settings = actorData.system.settings ?? {};

      const splat: string = settings.splat ?? '';
      const capabilities = Object.keys(getCapabilityFlags(actorData));

      // Power trait rating from the matching Advantage item's system.permanent.
      const descriptor = SPLAT_POWER_TRAIT[splat];
      let powerTrait: string | undefined;
      let powerLevel: number | undefined;
      if (descriptor) {
        const advantage = getEmbeddedItems(actorData, 'Advantage').find(
          it => it?.system?.id === descriptor.id
        );
        if (advantage) {
          powerTrait = descriptor.name;
          powerLevel = advantage.system?.permanent ?? 0;
        }
      }

      const systemData: WoDCreatureIndex['systemData'] = {
        splat,
        game: settings.game,
        variant: settings.variant,
        capabilities,
        ...(powerTrait !== undefined ? { powerTrait } : {}),
        ...(powerLevel !== undefined ? { powerLevel } : {}),
      };

      return {
        creature: {
          id: doc._id ?? doc.id,
          name: doc.name,
          type: doc.type,
          packName: pack?.metadata?.id,
          packLabel: pack?.metadata?.label,
          img: doc.img,
          system: 'worldofdarkness',
          systemData,
        },
        errors: 0,
      };
    } catch (error) {
      console.warn(`[${this.moduleId}] Failed to extract WoD data from ${doc?.name}:`, error);
      return {
        creature: {
          id: doc?._id ?? doc?.id,
          name: doc?.name,
          type: doc?.type,
          packName: pack?.metadata?.id,
          packLabel: pack?.metadata?.label,
          img: doc?.img,
          system: 'worldofdarkness',
          systemData: {
            splat: '',
            capabilities: [],
          },
        },
        errors: 1,
      };
    }
  }
}
