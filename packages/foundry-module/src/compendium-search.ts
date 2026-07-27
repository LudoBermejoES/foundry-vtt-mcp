// Extracted from data-access.ts as part of the God-class split (behaviour-preserving).
// See docs/refactor-data-access.md for the module map.
//
// The compendium/creature-search cluster: sixteen methods that search compendium
// packs and the enhanced creature index and RETURN what they find. Nothing here
// writes, so there is no audit call anywhere in this module. They are pinned by
// characterization tests asserting the returned result set — contents, ordering,
// ranking, truncation at the limit, and the filter decision that determines
// membership, with one case per system branch (see compendium-search.test.ts).
//
// Depends on exactly two things and holds NO reference to FoundryDataAccess:
// `security` for output sanitisation and Foundry-state validation, and the
// facade's PersistentCreatureIndex.
//
// The index is INJECTED, never constructed here. Constructing a second
// PersistentCreatureIndex type-checks cleanly and fails silently: a rebuild
// triggered from main.ts or settings.ts would populate one index while every read
// served the other, and the symptom is a stale or empty creature index rather than
// an error.
//
// `searchCompendium`, `listCreaturesByCriteria` and `fallbackBasicCreatureSearch`
// are one strongly-connected component (searchCompendium -> listCreaturesByCriteria
// -> fallbackBasicCreatureSearch -> searchCompendium). There is no direct
// searchCompendium -> fallbackBasicCreatureSearch edge, despite what several
// documents said. All three had to move together; splitting them would have
// forced a back-reference to the facade.
//
// The creature-index type family below is byte-identical to the copy in
// creature-index.ts. Deliberately NOT deduplicated here: that family is declared
// in three trees with up to four copies each and is structurally divergent between
// them, so consolidating two of four inside a relocation pass is its own change.
import { MODULE_ID } from './constants.js';
import { FoundrySecurity } from './security.js';
import { PersistentCreatureIndex } from './creature-index.js';

export interface CompendiumSearchResult {
  id: string;
  name: string;
  type: string;
  img?: string;
  pack: string;
  packLabel: string;
  system?: Record<string, unknown>;
  summary?: string;
  hasImage?: boolean;
  description?: string;
}

// D&D 5e Enhanced Creature Index
export interface DnD5eCreatureIndex {
  id: string;
  name: string;
  type: string;
  pack: string;
  packLabel: string;
  challengeRating: number;
  creatureType: string;
  size: string;
  hitPoints: number;
  armorClass: number;
  hasSpells: boolean;
  hasLegendaryActions: boolean;
  alignment: string;
  description?: string;
  img?: string;
}

// Pathfinder 2e Enhanced Creature Index
export interface PF2eCreatureIndex {
  id: string;
  name: string;
  type: string;
  pack: string;
  packLabel: string;
  level: number; // PF2e: -1 to 25+
  traits: string[]; // PF2e: ['dragon', 'fire', 'amphibious']
  creatureType: string; // Primary trait extracted from traits array
  rarity: string; // PF2e: 'common', 'uncommon', 'rare', 'unique'
  size: string;
  hitPoints: number;
  armorClass: number;
  hasSpells: boolean;
  alignment: string;
  description?: string;
  img?: string;
}

// Cosmere RPG (Plotweaver) Enhanced Creature Index
//
// Plotweaver categorises adversaries by `tier` (1-4) and `role`
// (minion/rival/boss) rather than CR or level — those are the primary
// encounter-design dials. Defenses are split into phy/cog/spi instead
// of a single AC, and Investiture is the Surge/Stormlight resource.
export interface CosmereRpgCreatureIndex {
  id: string;
  name: string;
  type: string; // 'adversary' for compendium creatures
  pack: string;
  packLabel: string;
  tier: number; // 1-4
  role: string; // minion | rival | boss | (system-extended)
  creatureType: string; // humanoid | animal | spren | …
  subtype: string; // free-form secondary type
  size: string;
  hitPoints: number; // resources.hea.max (override-aware)
  focus: number; // resources.foc.max
  investiture: number; // resources.inv.max — typically 0
  hasInvestiture: boolean;
  defensePhysical: number;
  defenseCognitive: number;
  defenseSpiritual: number;
  deflect: number;
  walkSpeed: number;
  description?: string;
  img?: string;
}

export interface MGT2eCreatureIndex {
  id: string;
  name: string;
  type: string; // traveller | npc | creature | spacecraft | …
  pack: string;
  packLabel: string;
  hits: number;
  creatureType: string;
  hasPsionics: boolean;
  characteristics: Record<string, { value: number; dm: number }>;
  img?: string;
}

// Union type across all supported systems
export type EnhancedCreatureIndex =
  | DnD5eCreatureIndex
  | PF2eCreatureIndex
  | CosmereRpgCreatureIndex
  | MGT2eCreatureIndex;

export interface CompendiumEntryFull {
  id: string;
  name: string;
  type: string;
  img?: string;
  pack: string;
  packLabel: string;
  system: Record<string, unknown>;
  items?: CompendiumItem[];
  effects?: CompendiumEffect[];
  fullData: Record<string, unknown>;
}

export interface CompendiumItem {
  id: string;
  name: string;
  type: string;
  img?: string;
  system: Record<string, unknown>;
}

export interface CompendiumEffect {
  id: string;
  name: string;
  icon?: string;
  disabled: boolean;
  duration?: Record<string, unknown>;
}

export class CompendiumSearch {
  private moduleId: string = MODULE_ID;

  constructor(
    private security: FoundrySecurity,
    private persistentIndex: PersistentCreatureIndex
  ) {}

  /**
   * Force rebuild of enhanced creature index
   */
  async rebuildEnhancedCreatureIndex(): Promise<{
    success: boolean;
    totalCreatures: number;
    message: string;
  }> {
    try {
      const creatures = await this.persistentIndex.rebuildIndex();
      return {
        success: true,
        totalCreatures: creatures.length,
        message: `Enhanced creature index rebuilt: ${creatures.length} creatures indexed from all packs`,
      };
    } catch (error) {
      console.error(`[${this.moduleId}] Failed to rebuild enhanced creature index:`, error);
      return {
        success: false,
        totalCreatures: 0,
        message: `Failed to rebuild index: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  /**
   * Search compendium packs for items matching query with optional filters
   */
  async searchCompendium(
    query: string,
    packType?: string,
    filters?: {
      challengeRating?: number | { min?: number; max?: number };
      creatureType?: string;
      size?: string;
      alignment?: string;
      hasLegendaryActions?: boolean;
      spellcaster?: boolean;
    }
  ): Promise<CompendiumSearchResult[]> {
    // Add defensive checks for query parameter
    if (!query || typeof query !== 'string' || query.trim().length < 2) {
      throw new Error('Search query must be a string with at least 2 characters');
    }

    // ENHANCED SEARCH: If we have creature-specific filters and Actor packType, use enhanced index
    if (
      filters &&
      packType === 'Actor' &&
      (filters.challengeRating || filters.creatureType || filters.hasLegendaryActions)
    ) {
      // Check if enhanced creature index is enabled
      const enhancedIndexEnabled = game.settings.get(this.moduleId, 'enableEnhancedCreatureIndex');

      if (enhancedIndexEnabled) {
        try {
          // Convert search criteria and use enhanced search
          const criteria: any = { limit: 100 }; // Default limit for search

          if (filters.challengeRating) criteria.challengeRating = filters.challengeRating;
          if (filters.creatureType) criteria.creatureType = filters.creatureType;
          if (filters.size) criteria.size = filters.size;
          if (filters.hasLegendaryActions)
            criteria.hasLegendaryActions = filters.hasLegendaryActions;

          const enhancedResult = await this.listCreaturesByCriteria(criteria);

          // No name filtering needed - trust the enhanced creature index!
          const filteredResults = enhancedResult.creatures;

          // Convert to CompendiumSearchResult format
          return filteredResults.map(
            creature =>
              ({
                id: creature.id || creature.name,
                name: creature.name,
                type: creature.type || 'npc',
                pack: creature.pack,
                packLabel: creature.packLabel || creature.pack,
                description: creature.description || '',
                hasImage: creature.hasImage || !!creature.img,
                summary: `CR ${creature.challengeRating} ${creature.creatureType} from ${creature.packLabel}`,
                // Enhanced data (not part of interface but will be included)
                challengeRating: creature.challengeRating,
                creatureType: creature.creatureType,
                size: creature.size,
                hasLegendaryActions: creature.hasLegendaryActions,
              }) as CompendiumSearchResult & {
                challengeRating: number;
                creatureType: string;
                size: string;
                hasLegendaryActions: boolean;
              }
          );
        } catch (error) {
          console.warn(
            `[${this.moduleId}] Enhanced search failed, falling back to basic search:`,
            error
          );
          // Continue to basic search below
        }
      }
    }

    const results: CompendiumSearchResult[] = [];
    const cleanQuery = query.toLowerCase().trim();
    const searchTerms = cleanQuery
      .split(' ')
      .filter(term => term && typeof term === 'string' && term.length > 0);

    if (searchTerms.length === 0) {
      throw new Error('Search query must contain valid search terms');
    }

    // Filter packs by type if specified
    const packs = Array.from(game.packs.values()).filter(pack => {
      if (packType && pack.metadata.type !== packType) {
        return false;
      }
      return pack.metadata.type !== 'Scene'; // Exclude scene packs for safety
    });

    for (const pack of packs) {
      try {
        // Ensure pack index is loaded.
        // In Foundry v13 getIndex() returns the index Collection; always call it
        // and use the return value so we don't depend on pack.indexed state.
        let packIndex: any;
        try {
          packIndex = await (pack as any).getIndex({ fields: ['name', 'img', 'type'] });
        } catch {
          // Fallback: older Foundry API without fields option
          packIndex = await (pack as any).getIndex();
        }

        // Use the returned index if available, otherwise fall back to pack.index
        const indexSource =
          packIndex && typeof packIndex.values === 'function' ? packIndex : (pack as any).index;

        const entriesToSearch = Array.from((indexSource as any).values());

        for (const entry of entriesToSearch) {
          try {
            // Type assertion and comprehensive safety checks for entry properties
            const typedEntry = entry as any;
            if (
              !typedEntry?.name ||
              typeof typedEntry.name !== 'string' ||
              typedEntry.name.trim().length === 0
            ) {
              continue;
            }

            // Ensure searchTerms are valid before using them
            if (!searchTerms || !Array.isArray(searchTerms) || searchTerms.length === 0) {
              continue;
            }

            // Use already created typedEntry

            const entryNameLower = typedEntry.name.toLowerCase();
            const nameMatch = searchTerms.every(term => {
              if (!term || typeof term !== 'string') {
                return false;
              }
              return entryNameLower.includes(term);
            });

            if (nameMatch) {
              // For Actor packs with filters, use simple name/description matching
              if (
                filters &&
                this.shouldApplyFilters(entry, filters) &&
                pack.metadata.type === 'Actor'
              ) {
                // Convert filters to search criteria for compatibility
                const searchCriteria: any = {};

                if (filters.challengeRating) {
                  const searchTerms = [];
                  if (typeof filters.challengeRating === 'number') {
                    if (filters.challengeRating >= 15) {
                      searchTerms.push('ancient', 'legendary', 'elder', 'greater');
                    } else if (filters.challengeRating >= 10) {
                      searchTerms.push('adult', 'warlord', 'champion', 'master');
                    } else if (filters.challengeRating >= 5) {
                      searchTerms.push('captain', 'knight', 'priest', 'mage');
                    } else {
                      searchTerms.push('guard', 'soldier', 'warrior', 'scout');
                    }
                  }
                  searchCriteria.searchTerms = searchTerms;
                }

                if (filters.creatureType) {
                  const typeTerms = [filters.creatureType];
                  if (filters.creatureType.toLowerCase() === 'humanoid') {
                    typeTerms.push('human', 'elf', 'dwarf', 'orc', 'goblin');
                  }
                  searchCriteria.searchTerms = [
                    ...(searchCriteria.searchTerms || []),
                    ...typeTerms,
                  ];
                }

                if (!this.matchesSearchCriteria(typedEntry, searchCriteria)) {
                  continue;
                }
              }

              // Standard index entry result
              results.push({
                id: typedEntry._id || '',
                name: typedEntry.name,
                type: typedEntry.type || 'unknown',
                img: typedEntry.img || undefined,
                pack: pack.metadata.id,
                packLabel: pack.metadata.label,
                description: typedEntry.description || '',
                hasImage: !!typedEntry.img,
                summary: `${typedEntry.type} from ${pack.metadata.label}`,
              });
            }
          } catch (entryError) {
            // Log individual entry errors but continue processing
            console.warn(
              `[${this.moduleId}] Error processing entry in pack ${pack.metadata.id}:`,
              entryError
            );
            continue;
          }

          // Limit results per pack to prevent overwhelming responses
          if (results.length >= 100) break;
        }
      } catch (error) {
        console.warn(`[${this.moduleId}] Failed to search pack ${pack.metadata.id}:`, error);
      }

      // Global limit to prevent memory issues
      if (results.length >= 100) break;
    }

    // Sort results by relevance with enhanced ranking for filtered searches
    results.sort((a, b) => {
      // Exact name matches first
      const aExact = a.name.toLowerCase() === query.toLowerCase();
      const bExact = b.name.toLowerCase() === query.toLowerCase();
      if (aExact && !bExact) return -1;
      if (!aExact && bExact) return 1;

      // If filters are used, prioritize by filter match quality
      if (filters) {
        const aScore = this.calculateRelevanceScore(a, filters, query);
        const bScore = this.calculateRelevanceScore(b, filters, query);
        if (aScore !== bScore) return bScore - aScore; // Higher score first
      }

      // Fallback to alphabetical
      return a.name.localeCompare(b.name);
    });

    return results.slice(0, 50); // Final limit
  }

  /**
   * Check if filters should be applied to this entry
   */
  private shouldApplyFilters(entry: any, filters: any): boolean {
    // Only apply filters to Actor entries (which includes NPCs/monsters/creatures)
    if (entry.type !== 'npc' && entry.type !== 'character' && entry.type !== 'creature') {
      return false;
    }

    // Check if any filters are actually specified
    return Object.keys(filters).some(key => filters[key] !== undefined);
  }

  /**
   * Calculate relevance score for search result ranking
   */
  private calculateRelevanceScore(entry: any, filters: any, query: string): number {
    let score = 0;
    const system = entry.system || {};

    // Bonus for creature type match (high importance for encounter building)
    if (filters.creatureType) {
      const entryType = system.details?.type?.value || system.type?.value || '';
      if (entryType.toLowerCase() === filters.creatureType.toLowerCase()) {
        score += 20;
      }
    }

    // Bonus for CR match (exact match gets higher score than range)
    if (filters.challengeRating !== undefined) {
      const entryCR = system.details?.cr || system.cr || 0;
      if (typeof filters.challengeRating === 'number') {
        if (entryCR === filters.challengeRating) score += 15;
      } else if (typeof filters.challengeRating === 'object') {
        const { min, max } = filters.challengeRating;
        if (min !== undefined && max !== undefined) {
          // Bonus for being in range, extra for being in middle of range
          if (entryCR >= min && entryCR <= max) {
            score += 10;
            const rangeMid = (min + max) / 2;
            const distFromMid = Math.abs(entryCR - rangeMid);
            score += Math.max(0, 5 - distFromMid); // Up to 5 bonus for being near middle
          }
        }
      }
    }

    // Bonus for common creature names (better for encounters)
    const commonNames = [
      'knight',
      'warrior',
      'guard',
      'soldier',
      'mage',
      'priest',
      'bandit',
      'orc',
      'goblin',
      'dragon',
    ];
    const lowerName = entry.name.toLowerCase();
    if (commonNames.some(name => lowerName.includes(name))) {
      score += 5;
    }

    // Bonus for query term matches in name
    const queryTerms = query.toLowerCase().split(' ');
    for (const term of queryTerms) {
      if (term.length > 2 && lowerName.includes(term)) {
        score += 3;
      }
    }

    return score;
  }

  /**
   * List creatures by criteria using enhanced persistent index - optimized for instant filtering
   */
  async listCreaturesByCriteria(criteria: {
    challengeRating?: number | { min?: number; max?: number };
    creatureType?: string;
    size?: string;
    hasSpells?: boolean;
    hasLegendaryActions?: boolean;
    limit?: number;
  }): Promise<{ creatures: any[]; searchSummary: any }> {
    const limit = criteria.limit || 500;

    // Check if enhanced creature index is enabled
    const enhancedIndexEnabled = game.settings.get(this.moduleId, 'enableEnhancedCreatureIndex');

    if (!enhancedIndexEnabled) {
      return this.fallbackBasicCreatureSearch(criteria, limit);
    }

    try {
      // Get enhanced creature index (builds if needed)
      const enhancedCreatures = await this.persistentIndex.getEnhancedIndex();

      // Apply filters to enhanced data
      let filteredCreatures = enhancedCreatures.filter(creature =>
        this.passesEnhancedCriteria(creature, criteria)
      );

      // Sort by power level then name for consistent ordering (system-aware).
      // Power-level dial: tier (cosmere), level (pf2e), challengeRating (dnd5e).
      const powerLevel = (c: EnhancedCreatureIndex): number => {
        if ('hits' in c && 'hasPsionics' in c) return (c as MGT2eCreatureIndex).hits;
        if ('tier' in c) return (c as CosmereRpgCreatureIndex).tier;
        if ('level' in c) return (c as PF2eCreatureIndex).level;
        return (c as DnD5eCreatureIndex).challengeRating;
      };
      filteredCreatures.sort((a, b) => {
        const powerA = powerLevel(a);
        const powerB = powerLevel(b);
        if (powerA !== powerB) return powerA - powerB;
        return a.name.localeCompare(b.name);
      });

      // Apply limit
      if (filteredCreatures.length > limit) {
        filteredCreatures = filteredCreatures.slice(0, limit);
      }

      // Convert enhanced creatures to result format (system-aware)
      const results = filteredCreatures.map(creature => {
        const isMGT2e = 'hits' in creature && 'hasPsionics' in creature;
        const isCosmere = !isMGT2e && 'tier' in creature;
        const isPF2e = !isMGT2e && !isCosmere && 'level' in creature;

        const base = {
          id: creature.id,
          name: creature.name,
          type: creature.type,
          pack: creature.pack,
          packLabel: creature.packLabel,
          description: (creature as any).description || '',
          hasImage: !!creature.img,
          creatureType: (creature as any).creatureType,
          size: (creature as any).size,
          hitPoints: (creature as any).hitPoints,
        };

        if (isMGT2e) {
          const m = creature as MGT2eCreatureIndex;
          const strDm = m.characteristics?.STR?.dm ?? 0;
          const dexDm = m.characteristics?.DEX?.dm ?? 0;
          return {
            ...base,
            hits: m.hits,
            creatureType: m.creatureType,
            hasPsionics: m.hasPsionics,
            characteristics: m.characteristics,
            summary: `${m.type} — ${m.hits} hits${m.creatureType ? ', ' + m.creatureType : ''} (STR DM${strDm >= 0 ? '+' : ''}${strDm}, DEX DM${dexDm >= 0 ? '+' : ''}${dexDm}) from ${m.packLabel}`,
          };
        }

        if (isCosmere) {
          const c = creature;
          return {
            ...base,
            summary: `Tier ${c.tier} ${c.role} ${c.creatureType} from ${c.packLabel}`,
            tier: c.tier,
            role: c.role,
            subtype: c.subtype,
            focus: c.focus,
            investiture: c.investiture,
            hasInvestiture: c.hasInvestiture,
            defenses: {
              physical: c.defensePhysical,
              cognitive: c.defenseCognitive,
              spiritual: c.defenseSpiritual,
            },
            deflect: c.deflect,
            walkSpeed: c.walkSpeed,
          };
        }

        if (isPF2e) {
          const p = creature;
          return {
            ...base,
            armorClass: p.armorClass,
            hasSpells: p.hasSpells,
            alignment: p.alignment,
            summary: `Level ${p.level} ${p.creatureType} (${p.rarity}) from ${p.packLabel}`,
            level: p.level,
            traits: p.traits,
            rarity: p.rarity,
          };
        }

        const d = creature as DnD5eCreatureIndex;
        return {
          ...base,
          armorClass: d.armorClass,
          hasSpells: d.hasSpells,
          alignment: d.alignment,
          summary: `CR ${d.challengeRating} ${d.creatureType} from ${d.packLabel}`,
          challengeRating: d.challengeRating,
          hasLegendaryActions: d.hasLegendaryActions,
        };
      });

      // Calculate pack distribution for summary
      const packResults = new Map();
      results.forEach(creature => {
        const count = packResults.get(creature.packLabel) || 0;
        packResults.set(creature.packLabel, count + 1);
      });

      // Get unique pack information
      const uniquePacks = Array.from(new Set(enhancedCreatures.map(c => c.pack)));
      const topPacks = uniquePacks.slice(0, 5).map(packId => {
        const sampleCreature = enhancedCreatures.find(c => c.pack === packId);
        return {
          id: packId,
          label: sampleCreature?.packLabel || 'Unknown Pack',
          priority: 100, // All packs are prioritized equally in enhanced index
        };
      });

      if (packResults.size > 0) {
      }

      return {
        creatures: results,
        searchSummary: {
          packsSearched: uniquePacks.length,
          topPacks,
          totalCreaturesFound: results.length,
          resultsByPack: Object.fromEntries(packResults),
          criteria,
          indexMetadata: {
            totalIndexedCreatures: enhancedCreatures.length,
            searchMethod: 'enhanced_persistent_index',
          },
        },
      };
    } catch (error) {
      console.error(`[${this.moduleId}] Enhanced creature search failed:`, error);
      // Fallback to basic search if enhanced index fails
      return this.fallbackBasicCreatureSearch(criteria, limit);
    }
  }

  /**
   * Check if enhanced creature passes all specified criteria (system-aware routing).
   *
   * Discriminator order matters: cosmere-rpg has a `tier` field, pf2e has
   * `level`, dnd5e has `challengeRating`. Check cosmere first (tier is the
   * narrowest signal), then pf2e, then fall through to dnd5e.
   */
  private passesEnhancedCriteria(creature: EnhancedCreatureIndex, criteria: any): boolean {
    if ('hits' in creature && 'hasPsionics' in creature) {
      return this.passesMGT2eCriteria(creature as MGT2eCreatureIndex, criteria);
    }
    if ('tier' in creature) {
      return this.passesCosmereRpgCriteria(creature, criteria);
    }
    if ('level' in creature) {
      return this.passesPF2eCriteria(creature, criteria);
    }
    return this.passesDnD5eCriteria(creature, criteria);
  }

  /**
   * MGT2e criteria filter — minHits/maxHits, hasPsionics, creatureType, actorType.
   */
  private passesMGT2eCriteria(creature: MGT2eCreatureIndex, criteria: any): boolean {
    if (criteria.minHits !== undefined && creature.hits < criteria.minHits) return false;
    if (criteria.maxHits !== undefined && creature.hits > criteria.maxHits) return false;
    if (criteria.hasPsionics !== undefined && creature.hasPsionics !== criteria.hasPsionics)
      return false;
    if (criteria.creatureType && creature.creatureType !== criteria.creatureType) return false;
    if (criteria.actorType && creature.type !== criteria.actorType) return false;
    return true;
  }

  /**
   * Cosmere RPG criteria filter — tier, role, creatureType, size,
   * hasInvestiture, hitPoints range, defenses minimums, deflect minimum.
   */
  private passesCosmereRpgCriteria(
    creature: CosmereRpgCreatureIndex,
    criteria: {
      tier?: number | { min?: number; max?: number };
      role?: string;
      creatureType?: string;
      size?: string;
      hasInvestiture?: boolean;
      hitPoints?: number | { min?: number; max?: number };
      health?: number | { min?: number; max?: number };
      defensesMin?: { phy?: number; cog?: number; spi?: number };
      deflectMin?: number;
    }
  ): boolean {
    if (criteria.tier !== undefined) {
      if (typeof criteria.tier === 'number') {
        if (creature.tier !== criteria.tier) return false;
      } else {
        const { min, max } = criteria.tier;
        if (min !== undefined && creature.tier < min) return false;
        if (max !== undefined && creature.tier > max) return false;
      }
    }

    if (criteria.role && creature.role.toLowerCase() !== criteria.role.toLowerCase()) {
      return false;
    }

    if (
      criteria.creatureType &&
      creature.creatureType.toLowerCase() !== criteria.creatureType.toLowerCase()
    ) {
      return false;
    }

    if (criteria.size && creature.size.toLowerCase() !== criteria.size.toLowerCase()) {
      return false;
    }

    if (
      criteria.hasInvestiture !== undefined &&
      creature.hasInvestiture !== criteria.hasInvestiture
    ) {
      return false;
    }

    // Accept either `hitPoints` or `health` from callers — they're synonyms
    // here (hitPoints is the cross-system convention; health is the cosmere-
    // native term).
    const hpRange = criteria.hitPoints ?? criteria.health;
    if (hpRange !== undefined) {
      if (typeof hpRange === 'number') {
        if (creature.hitPoints !== hpRange) return false;
      } else {
        const { min, max } = hpRange;
        if (min !== undefined && creature.hitPoints < min) return false;
        if (max !== undefined && creature.hitPoints > max) return false;
      }
    }

    if (criteria.defensesMin) {
      const { phy, cog, spi } = criteria.defensesMin;
      if (phy !== undefined && creature.defensePhysical < phy) return false;
      if (cog !== undefined && creature.defenseCognitive < cog) return false;
      if (spi !== undefined && creature.defenseSpiritual < spi) return false;
    }

    if (criteria.deflectMin !== undefined && creature.deflect < criteria.deflectMin) {
      return false;
    }

    return true;
  }

  /**
   * Check if D&D 5e creature passes all specified criteria
   */
  private passesDnD5eCriteria(
    creature: DnD5eCreatureIndex,
    criteria: {
      challengeRating?: number | { min?: number; max?: number };
      creatureType?: string;
      size?: string;
      hasSpells?: boolean;
      hasLegendaryActions?: boolean;
    }
  ): boolean {
    // Challenge Rating filter
    if (criteria.challengeRating !== undefined) {
      if (typeof criteria.challengeRating === 'number') {
        if (creature.challengeRating !== criteria.challengeRating) {
          return false;
        }
      } else if (typeof criteria.challengeRating === 'object') {
        const { min, max } = criteria.challengeRating;
        if (min !== undefined && creature.challengeRating < min) {
          return false;
        }
        if (max !== undefined && creature.challengeRating > max) {
          return false;
        }
      }
    }

    // Creature Type filter
    if (criteria.creatureType) {
      if (creature.creatureType.toLowerCase() !== criteria.creatureType.toLowerCase()) {
        return false;
      }
    }

    // Size filter
    if (criteria.size) {
      if (creature.size.toLowerCase() !== criteria.size.toLowerCase()) {
        return false;
      }
    }

    // Spellcaster filter
    if (criteria.hasSpells !== undefined) {
      if (creature.hasSpells !== criteria.hasSpells) {
        return false;
      }
    }

    // Legendary Actions filter
    if (criteria.hasLegendaryActions !== undefined) {
      if (creature.hasLegendaryActions !== criteria.hasLegendaryActions) {
        return false;
      }
    }

    return true;
  }

  /**
   * Check if PF2e creature passes all specified criteria
   */
  private passesPF2eCriteria(
    creature: PF2eCreatureIndex,
    criteria: {
      level?: number | { min?: number; max?: number };
      traits?: string[];
      rarity?: string;
      creatureType?: string;
      size?: string;
      hasSpells?: boolean;
    }
  ): boolean {
    // Level filter
    if (criteria.level !== undefined) {
      if (typeof criteria.level === 'number') {
        if (creature.level !== criteria.level) {
          return false;
        }
      } else if (typeof criteria.level === 'object') {
        const { min = -1, max = 25 } = criteria.level;
        if (creature.level < min || creature.level > max) {
          return false;
        }
      }
    }

    // Traits filter (creature must have ALL specified traits)
    if (criteria.traits && criteria.traits.length > 0) {
      const hasAllTraits = criteria.traits.every(requiredTrait =>
        creature.traits.some(t => t.toLowerCase() === requiredTrait.toLowerCase())
      );
      if (!hasAllTraits) {
        return false;
      }
    }

    // Rarity filter
    if (criteria.rarity && creature.rarity !== criteria.rarity) {
      return false;
    }

    // Creature type filter
    if (
      criteria.creatureType &&
      creature.creatureType.toLowerCase() !== criteria.creatureType.toLowerCase()
    ) {
      return false;
    }

    // Size filter
    if (criteria.size && creature.size.toLowerCase() !== criteria.size.toLowerCase()) {
      return false;
    }

    // Spellcasting filter
    if (criteria.hasSpells !== undefined && creature.hasSpells !== criteria.hasSpells) {
      return false;
    }

    return true;
  }

  /**
   * Fallback to basic creature search if enhanced index fails
   */
  private async fallbackBasicCreatureSearch(
    criteria: any,
    limit: number
  ): Promise<{ creatures: any[]; searchSummary: any }> {
    console.warn(`[${this.moduleId}] Falling back to basic search due to enhanced index failure`);

    // Use a simple text-based search as fallback
    const searchTerms: string[] = [];

    if (criteria.creatureType) {
      searchTerms.push(criteria.creatureType);
    }

    if (criteria.challengeRating) {
      if (typeof criteria.challengeRating === 'number') {
        // Add CR-based name patterns as fallback
        if (criteria.challengeRating >= 15) searchTerms.push('ancient', 'legendary');
        else if (criteria.challengeRating >= 10) searchTerms.push('adult', 'champion');
        else if (criteria.challengeRating >= 5) searchTerms.push('captain', 'knight');
      }
    }

    const searchQuery = searchTerms.join(' ') || 'monster';
    const basicResults = await this.searchCompendium(searchQuery, 'Actor');

    return {
      creatures: basicResults.slice(0, limit),
      searchSummary: {
        packsSearched: 0,
        topPacks: [],
        totalCreaturesFound: basicResults.length,
        resultsByPack: {},
        criteria,
        fallback: true,
        searchMethod: 'basic_fallback',
      },
    };
  }

  /**
   * Simple name/description-based matching for creatures using index data only
   */
  private matchesSearchCriteria(
    entry: any,
    criteria: {
      searchTerms?: string[];
      excludeTerms?: string[];
      size?: string;
      hasSpells?: boolean;
      hasLegendaryActions?: boolean;
    }
  ): boolean {
    const name = (entry.name || '').toLowerCase();
    const description = (entry.description || '').toLowerCase();
    const searchText = `${name} ${description}`;

    // Include terms - at least one must match
    if (criteria.searchTerms && criteria.searchTerms.length > 0) {
      const hasMatch = criteria.searchTerms.some(term => searchText.includes(term.toLowerCase()));
      if (!hasMatch) {
        return false;
      }
    }

    // Exclude terms - none should match
    if (criteria.excludeTerms && criteria.excludeTerms.length > 0) {
      const hasExcluded = criteria.excludeTerms.some(term =>
        searchText.includes(term.toLowerCase())
      );
      if (hasExcluded) {
        return false;
      }
    }

    return true;
  }

  /**
   * Get available compendium packs
   */
  async getAvailablePacks() {
    return Array.from(game.packs.values()).map(pack => ({
      id: pack.metadata.id,
      label: pack.metadata.label,
      type: pack.metadata.type,
      system: pack.metadata.system,
      private: pack.metadata.private,
    }));
  }

  /**
   * Get full compendium document with all embedded data
   */
  async getCompendiumDocumentFull(
    packId: string,
    documentId: string
  ): Promise<CompendiumEntryFull> {
    const pack = game.packs.get(packId);
    if (!pack) {
      throw new Error(`Compendium pack ${packId} not found`);
    }

    const document = await pack.getDocument(documentId);
    if (!document) {
      throw new Error(`Document ${documentId} not found in pack ${packId}`);
    }

    // Build comprehensive data structure
    const fullEntry: CompendiumEntryFull = {
      id: document.id || '',
      name: document.name || '',
      type: (document as any).type || 'unknown',
      img: (document as any).img || undefined,
      pack: packId,
      packLabel: pack.metadata.label,
      system: this.security.sanitizeData((document as any).system || {}),
      fullData: this.security.sanitizeData(document.toObject()),
    };

    // Add items if the actor has them
    if ((document as any).items) {
      fullEntry.items = (document as any).items.map((item: any) => ({
        id: item.id,
        name: item.name,
        type: item.type,
        img: item.img || undefined,
        system: this.security.sanitizeData(item.system || {}),
      }));
    }

    // Add effects if the actor has them
    if ((document as any).effects) {
      fullEntry.effects = (document as any).effects.map((effect: any) => ({
        id: effect.id,
        name: effect.name || effect.label || 'Unknown Effect',
        icon: effect.icon || undefined,
        disabled: effect.disabled || false,
        duration: this.security.sanitizeData(effect.duration || {}),
      }));
    }

    return fullEntry;
  }

  /**
   * Find best matching compendium entry for creature type
   *
   * DEAD SURFACE, and `public` only by accident. It was
   * `private async findBestCompendiumMatch` on FoundryDataAccess (data-access.ts:3227 at
   * `c5c6bfa`); pass 5.1 (`e4c0409`) widened it so the facade wrapper it left behind could
   * reach it across the new class boundary, and pass 5.3 (`f4b0fd2`) deleted that wrapper's
   * caller — the dead `createActorFromCompendium` — without restoring the modifier. Nothing
   * in the repository has called it since: `grep -rn findBestCompendiumMatch packages shared
   * scripts` matches this declaration and nothing else, and the surface extractor reports it
   * as the one dead member of CompendiumSearch (6 reached + 1 dead = 7 non-private).
   *
   * Do NOT "fix" this by restoring `private`. Pass 5.2 tried, and it does not compile:
   * with no caller left anywhere, `private` makes it TS6133 ("declared but its value is
   * never read") under the root tsconfig's `noUnusedLocals`. The two honest states are
   * `private` WITH a caller, or deleted. So the remedy for this member is DELETION, and it
   * belongs to the boundary change that also removes the eight dead facade members
   * (getRollState, saveRollButtonMessageId, getRollButtonMessageId,
   * getRollStateFromMessage, requestRollStateSave, broadcastRollState, cleanOldRollStates,
   * getCharacterEntity) — not to a relocation pass, and not to this module's own commit.
   *
   * Worth recording precisely, because the bridge-visibility requirement pass 5.2 added
   * calls this "dead surface … type-checking cleanly, failing no test, and indistinguishable
   * in a diff from a member that is public because something calls it". The first clause is
   * only true WHILE the modifier stays wide: honest visibility makes tsc report it at once.
   * `noUnusedLocals` is therefore the mechanical detector the requirement says does not
   * exist — but only for a pass that attempts the restoration rather than assuming it.
   */
  async findBestCompendiumMatch(
    creatureType: string,
    packPreference?: string
  ): Promise<CompendiumSearchResult | null> {
    // First try exact search
    const exactResults = await this.searchCompendium(creatureType, 'Actor');

    // Look for exact name match first
    const exactMatch = exactResults.find(
      result => result.name.toLowerCase() === creatureType.toLowerCase()
    );
    if (exactMatch) return exactMatch;

    // Look for partial matches, preferring specified pack
    if (packPreference) {
      const packMatch = exactResults.find(result => result.pack === packPreference);
      if (packMatch) return packMatch;
    }

    // Return best fuzzy match
    return exactResults.length > 0 ? exactResults[0] : null;
  }

  /**
   * Get enhanced creature index for campaign analysis
   */
  async getEnhancedCreatureIndex(): Promise<any[]> {
    this.security.validateFoundryState();

    // Get the enhanced creature index (builds if needed)
    const enhancedCreatures = await this.persistentIndex.getEnhancedIndex();

    return enhancedCreatures || [];
  }
}
