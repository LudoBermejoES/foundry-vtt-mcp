import { MODULE_ID, ERROR_MESSAGES } from './constants.js';
import { PermissionManager } from './permissions.js';
import { TransactionManager } from './transaction-manager.js';
import { PersistentCreatureIndex } from './creature-index.js';
import { FoundrySecurity } from './security.js';
import { ActorResolver } from './actor-resolver.js';
import { JournalManager } from './journal-manager.js';
import { WorldItemsManager } from './world-items-manager.js';
import { ActorDirectory } from './actor-directory.js';
import { RollManager } from './roll-manager.js';
import { SceneTokenManager } from './scene-token-manager.js';
import { ActorMechanics } from './actor-mechanics.js';
// The three types the retained delegations name. `CreatedActorInfo` is deliberately NOT
// imported: it is referenced only from inside `ActorCreationResult`'s own declaration, so
// importing it would be an unused import under noUnusedLocals — the same asymmetry pass
// 5.1 met with CompendiumItem/CompendiumEffect, seen from the other side.
import {
  ActorCrud,
  ActorCreationResult,
  SceneTokenPlacement,
  TokenPlacementResult,
} from './actor-crud.js';
import {
  CompendiumSearch,
  CompendiumEntryFull,
  CompendiumSearchResult,
} from './compendium-search.js';
// Local type definitions to avoid shared package import issues
interface CharacterInfo {
  id: string;
  name: string;
  type: string;
  img?: string;
  /**
   * Opt-in (`include: ['flags']`). Absent unless requested, so default
   * responses stay the size they have always been.
   *
   * MIRROR WARNING: these types are duplicated, not shared. The same two fields
   * exist in `shared/src/types.ts` (`CharacterInfo`) and are consumed on the
   * server in `systems/worldofdarkness/extract.ts`. Change one, change all.
   */
  flags?: Record<string, unknown>;
  /** Opt-in (`include: ['prototypeToken']`). The token ART, curated — see extractTokenArt. */
  prototypeToken?: Record<string, unknown>;
  /** Echo of the `include` keys the module actually honoured. See getCharacterInfo. */
  included?: string[];
  system: Record<string, unknown>;
  items: CharacterItem[];
  effects: CharacterEffect[];
  actions?: any[]; // PF2e actions (strikes, spells, etc.)
  itemVariants?: any[]; // Item rule element variants (ChoiceSet, etc.)
  itemToggles?: any[]; // Item rule element toggles (RollOption, ToggleProperty, equipped)
  spellcasting?: SpellcastingEntry[]; // PF2e/D&D 5e spellcasting entries
}

interface SpellcastingEntry {
  id: string;
  name: string;
  tradition?: string | undefined; // arcane, divine, primal, occult (PF2e)
  type: string; // prepared, spontaneous, innate, focus (PF2e) or class name (5e)
  ability?: string | undefined; // spellcasting ability (int, wis, cha)
  dc?: number | undefined;
  attack?: number | undefined;
  slots?: Record<string, { value: number; max: number }> | undefined; // spell slots per level/rank
  spells: SpellInfo[];
}

interface SpellInfo {
  id: string;
  name: string;
  level: number; // spell level/rank
  prepared?: boolean | undefined; // for prepared casters
  expended?: boolean | undefined; // has this spell slot been used
  traits?: string[] | undefined;
  actionCost?: string | undefined; // 1, 2, 3, reaction, free
  // Targeting info - helps Claude decide whether to specify targets
  range?: string | undefined; // "touch", "self", "60 feet", etc.
  target?: string | undefined; // "1 creature", "self", "area", etc.
  area?: string | undefined; // "20-foot radius", "30-foot cone", etc. (for template spells)
}

interface CharacterItem {
  id: string;
  name: string;
  type: string;
  img?: string;
  system: Record<string, unknown>;
}

interface CharacterEffect {
  id: string;
  name: string;
  icon?: string;
  disabled: boolean;
  duration?: {
    type: string;
    duration?: number;
    remaining?: number;
  };
}

interface SceneInfo {
  id: string;
  name: string;
  img?: string;
  background?: string;
  width: number;
  height: number;
  padding: number;
  active: boolean;
  navigation: boolean;
  tokens: SceneToken[];
  walls: number;
  lights: number;
  sounds: number;
  notes: SceneNote[];
}

interface SceneToken {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  actorId?: string;
  img: string;
  hidden: boolean;
  disposition: number;
}

interface SceneNote {
  id: string;
  text: string;
  x: number;
  y: number;
}

interface WorldInfo {
  id: string;
  title: string;
  system: string;
  systemVersion: string;
  foundryVersion: string;
  users: WorldUser[];
}

interface WorldUser {
  id: string;
  name: string;
  active: boolean;
  isGM: boolean;
}

export class FoundryDataAccess {
  private moduleId: string = MODULE_ID;
  private persistentIndex: PersistentCreatureIndex = new PersistentCreatureIndex();
  private security: FoundrySecurity = new FoundrySecurity();
  private actorResolver: ActorResolver = new ActorResolver();
  private permissions: PermissionManager = new PermissionManager();
  private journals: JournalManager = new JournalManager(
    this.security,
    this.actorResolver,
    this.permissions
  );
  private worldItems: WorldItemsManager = new WorldItemsManager(this.security);
  private actorDirectory: ActorDirectory = new ActorDirectory(this.security, this.actorResolver);
  private rollManager: RollManager = new RollManager(this.security, this.permissions);
  private sceneTokenManager: SceneTokenManager = new SceneTokenManager(
    this.security,
    this.permissions
  );
  private actorMechanics: ActorMechanics = new ActorMechanics(this.security, this.actorResolver);
  private compendiumSearch: CompendiumSearch = new CompendiumSearch(
    this.security,
    this.persistentIndex
  );
  private transactions: TransactionManager = new TransactionManager();
  private actorCrud: ActorCrud = new ActorCrud(
    this.security,
    this.actorResolver,
    this.permissions,
    this.transactions
  );

  constructor() {}

  /**
   * Force rebuild of enhanced creature index
   */
  async rebuildEnhancedCreatureIndex(): Promise<{
    success: boolean;
    totalCreatures: number;
    message: string;
  }> {
    return this.compendiumSearch.rebuildEnhancedCreatureIndex();
  }

  /**
   * Get character/actor information by name or ID.
   *
   * `options.include` is additive and opt-in. Absent (or empty), the response is
   * byte-identical to what this method returned before the option existed, so an
   * OLD server talking to a NEW module is unaffected. Supported keys:
   *
   *   - `flags`          → `flags`, the actor's raw flag object (provenance, e.g.
   *                        `flags.wodchar.sourceId`). Read WITHOUT `getFlag()` —
   *                        see the note on `readActorFlags`.
   *   - `prototypeToken` → `prototypeToken`, the curated token ART (texture src +
   *                        scale, ring, name, actorLink). This is the only way to
   *                        see an actor's token art WITHOUT a token placed on a
   *                        scene, which `get-token-details` requires.
   *
   * The response also carries `included`: the keys actually honoured. A NEW
   * server can therefore tell "the actor genuinely has no flags" apart from "the
   * module is too old to know what `include` means" — the difference between a
   * fact and a silent lie about provenance.
   */
  async getCharacterInfo(
    identifier: string,
    options?: { include?: string[] }
  ): Promise<CharacterInfo> {
    let actor: Actor | undefined;

    // Try to find by ID first, then by name
    if (identifier.length === 16) {
      // Foundry ID length
      actor = game.actors.get(identifier);
    }

    if (!actor) {
      actor = game.actors.find(a => a.name?.toLowerCase() === identifier.toLowerCase());
    }

    if (!actor) {
      throw new Error(`${ERROR_MESSAGES.CHARACTER_NOT_FOUND}: ${identifier}`);
    }

    // Build character data structure
    const characterData: CharacterInfo = {
      id: actor.id || '',
      name: actor.name || '',
      type: actor.type,
      ...(actor.img ? { img: actor.img } : {}),
      system: this.sanitizeData((actor as any).system),
      items: actor.items.map(item => {
        return {
          id: item.id,
          name: item.name,
          type: item.type,
          ...(item.img ? { img: item.img } : {}),
          system: this.sanitizeData(item.system),
        };
      }),
      effects: actor.effects.map(effect => {
        const eff = effect;
        const dur = eff.duration;
        const durRaw = eff._source?.duration;
        return {
          id: effect.id,
          name: eff.name || eff.label || 'Unknown Effect',
          ...(eff.icon ? { icon: eff.icon } : {}),
          disabled: eff.disabled,
          ...(dur
            ? {
                duration: {
                  type: dur.units ?? durRaw?.type ?? 'none',
                  duration: dur.seconds ?? durRaw?.duration,
                  remaining: dur.remaining,
                },
              }
            : {}),
        };
      }),
    };

    // ── Opt-in extras (art + provenance). Nothing here runs unless the caller
    // asked, so the default response shape is unchanged.
    const requestedInclude = options?.include;
    const include = Array.isArray(requestedInclude) ? requestedInclude : [];
    if (include.length > 0) {
      const honoured: string[] = [];
      if (include.includes('flags')) {
        characterData.flags = this.readActorFlags(actor);
        honoured.push('flags');
      }
      if (include.includes('prototypeToken')) {
        const art = this.extractTokenArt(actor);
        if (art !== null) characterData.prototypeToken = art;
        // Honoured even when the actor has no prototypeToken — the caller learns
        // "asked and answered: there is none", not "the module ignored me".
        honoured.push('prototypeToken');
      }
      characterData.included = honoured;
    }

    // Add PF2e-specific data if available
    const actorAny = actor as any;

    // Include actions (PF2e strikes, spells, etc.)
    if (actorAny.system?.actions) {
      characterData.actions = actorAny.system.actions.map((action: any) => ({
        name: action.label || action.name,
        type: action.type,
        ...(action.item ? { itemId: action.item.id } : {}),
        ...(action.variants
          ? {
              variants: action.variants.map((v: any) => ({
                label: v.label,
                ...(v.traits ? { traits: v.traits } : {}),
              })),
            }
          : {}),
        ...(action.ready !== undefined ? { ready: action.ready } : {}),
      }));
    }

    // Include item variants and toggles
    const itemVariants: any[] = [];
    const itemToggles: any[] = [];

    actor.items.forEach(item => {
      const itemAny = item;

      // Extract rule element variants (e.g., weapon variants, stance toggles)
      if (itemAny.system?.rules) {
        itemAny.system.rules.forEach((rule: any, ruleIndex: number) => {
          // Variants (ChoiceSet, RollOption with choices)
          if (rule.key === 'ChoiceSet' || (rule.key === 'RollOption' && rule.choices)) {
            itemVariants.push({
              itemId: item.id,
              itemName: item.name,
              ruleIndex,
              ruleKey: rule.key,
              label: rule.label || rule.prompt,
              ...(rule.selection ? { selected: rule.selection } : {}),
              ...(rule.choices ? { choices: rule.choices } : {}),
            });
          }

          // Toggles (RollOption toggleable, ToggleProperty)
          if ((rule.key === 'RollOption' && rule.toggleable) || rule.key === 'ToggleProperty') {
            itemToggles.push({
              itemId: item.id,
              itemName: item.name,
              ruleIndex,
              ruleKey: rule.key,
              label: rule.label,
              option: rule.option,
              ...(rule.value !== undefined ? { enabled: rule.value } : {}),
              ...(rule.toggleable !== undefined ? { toggleable: rule.toggleable } : {}),
            });
          }
        });
      }

      // Also check for item-level toggles (e.g., equipped, identified)
      if (itemAny.system?.equipped !== undefined) {
        itemToggles.push({
          itemId: item.id,
          itemName: item.name,
          type: 'equipped',
          enabled: itemAny.system.equipped,
        });
      }
    });

    // Add to character data if any found
    if (itemVariants.length > 0) {
      characterData.itemVariants = itemVariants;
    }
    if (itemToggles.length > 0) {
      characterData.itemToggles = itemToggles;
    }

    // Extract spellcasting data (PF2e and D&D 5e)
    const spellcastingEntries = this.extractSpellcastingData(actor);
    if (spellcastingEntries.length > 0) {
      characterData.spellcasting = spellcastingEntries;
    }

    return characterData;
  }

  /**
   * Search within a character's items, spells, actions, and effects
   * More token-efficient than getCharacterInfo when you need specific items
   */
  async searchCharacterItems(params: {
    characterIdentifier: string;
    query?: string | undefined;
    type?: string | undefined;
    category?: string | undefined;
    limit?: number | undefined;
  }): Promise<{
    characterId: string;
    characterName: string;
    query?: string;
    type?: string;
    category?: string;
    matches: Array<{
      id: string;
      name: string;
      type: string;
      description?: string;
      // For spells
      level?: number;
      prepared?: boolean;
      expended?: boolean;
      range?: string;
      target?: string;
      area?: string;
      actionCost?: string;
      traits?: string[];
      // For items
      quantity?: number;
      equipped?: boolean;
      invested?: boolean;
      // For actions
      actionType?: string;
    }>;
    totalMatches: number;
  }> {
    this.validateFoundryState();

    const { characterIdentifier, query, type, category, limit = 20 } = params;

    // Find the actor
    const actor = this.findActorByIdentifier(characterIdentifier);
    if (!actor) {
      throw new Error(`Character not found: ${characterIdentifier}`);
    }

    const actorAny = actor;
    const systemId = (game.system as any).id;
    const matches: Array<any> = [];

    // Normalize search query
    const searchQuery = query?.toLowerCase().trim();
    const searchType = type?.toLowerCase().trim();
    const searchCategory = category?.toLowerCase().trim();

    // Helper to check if text matches query (safely handles non-strings)
    const matchesQuery = (text: unknown): boolean => {
      if (!searchQuery) return true;
      if (typeof text !== 'string') return false;
      return text.toLowerCase().includes(searchQuery);
    };

    // Helper to check if item matches type filter
    const matchesType = (itemType: string): boolean => {
      if (!searchType) return true;
      return itemType.toLowerCase() === searchType;
    };

    // Search items
    for (const item of actor.items) {
      const itemSystem = item.system;

      // Check type filter
      if (!matchesType(item.type)) continue;

      // Check query filter (name or description)
      // Ensure description is a string (could be an object in some systems)
      let description = itemSystem?.description?.value || itemSystem?.description;
      if (typeof description !== 'string') description = '';
      if (!matchesQuery(item.name) && !matchesQuery(description)) continue;

      // Build result based on item type
      const result: any = {
        id: item.id,
        name: item.name,
        type: item.type,
      };

      // Add description (truncated for token efficiency)
      if (description) {
        // Strip HTML and truncate
        const plainText = description.replace(/<[^>]*>/g, '').trim();
        result.description =
          plainText.length > 300 ? `${plainText.substring(0, 300)}...` : plainText;
      }

      // Spell-specific fields
      if (item.type === 'spell') {
        result.level = itemSystem?.level?.value ?? itemSystem?.level ?? itemSystem?.rank ?? 0;
        const itemRaw = item._source?.system;
        result.prepared =
          itemSystem?.prepared ?? itemRaw?.preparation?.prepared ?? itemSystem?.location?.prepared;
        result.expended = itemSystem?.location?.expended;

        // Get targeting info
        if (systemId === 'pf2e') {
          const targeting = this.extractPF2eSpellTargeting(itemSystem);
          if (targeting.range) result.range = targeting.range;
          if (targeting.target) result.target = targeting.target;
          if (targeting.area) result.area = targeting.area;
          result.actionCost = this.formatPF2eActionCost(itemSystem?.time?.value);
          result.traits = itemSystem?.traits?.value || [];
        } else if (systemId === 'dnd5e') {
          const targeting = this.extractDnD5eSpellTargeting(itemSystem);
          if (targeting.range) result.range = targeting.range;
          if (targeting.target) result.target = targeting.target;
          if (targeting.area) result.area = targeting.area;
          result.actionCost = itemSystem?.activation?.type;
        } else if (systemId === 'dsa5') {
          const targeting = this.extractDSA5SpellTargeting(itemSystem);
          if (targeting.range) result.range = targeting.range;
          if (targeting.target) result.target = targeting.target;
          if (targeting.area) result.area = targeting.area;
          result.actionCost = itemSystem?.castingTime?.value;
        } else if (systemId === 'wfrp4e') {
          // WFRP4e spells use a Casting Number (CN) rather than levels/slots.
          if (itemSystem?.range?.value) result.range = itemSystem.range.value;
          if (itemSystem?.target?.value) result.target = itemSystem.target.value;
          const cn = itemSystem?.cn?.value;
          if (cn !== undefined && cn !== null) result.actionCost = `CN ${cn}`;
        }

        // Category filter for spells
        if (searchCategory) {
          const spellLevel = result.level || 0;
          const isPrepared = result.prepared !== false;
          const isCantrip = spellLevel === 0;
          const isFocus =
            itemSystem?.traits?.value?.includes('focus') || itemSystem?.category?.value === 'focus';

          if (searchCategory === 'cantrip' && !isCantrip) continue;
          if (searchCategory === 'prepared' && !isPrepared) continue;
          if (searchCategory === 'focus' && !isFocus) continue;
        }
      }

      // Equipment-specific fields
      if (['weapon', 'armor', 'equipment', 'consumable', 'backpack', 'loot'].includes(item.type)) {
        result.quantity = itemSystem?.quantity ?? 1;
        result.equipped = itemSystem?.equipped ?? false;
        result.invested = itemSystem?.equipped?.invested ?? itemSystem?.invested ?? undefined;

        // Category filter for equipment
        if (searchCategory) {
          if (searchCategory === 'equipped' && !result.equipped) continue;
          if (searchCategory === 'invested' && !result.invested) continue;
        }
      }

      // WFRP4e equipment fields (British 'armour'; 'trapping' is generic gear)
      if (
        systemId === 'wfrp4e' &&
        ['weapon', 'armour', 'trapping', 'ammunition', 'container'].includes(item.type)
      ) {
        result.quantity = itemSystem?.quantity?.value ?? 1;
        result.equipped = itemSystem?.equipped?.value ?? item.isEquipped ?? false;

        if (searchCategory === 'equipped' && !result.equipped) continue;
      }

      // WFRP4e prayer targeting (divine magic; item type 'prayer')
      if (systemId === 'wfrp4e' && item.type === 'prayer') {
        if (itemSystem?.range?.value) result.range = itemSystem.range.value;
        if (itemSystem?.target?.value) result.target = itemSystem.target.value;
      }

      // Feat/feature fields
      if (['feat', 'feature', 'class', 'ancestry', 'heritage', 'background'].includes(item.type)) {
        if (systemId === 'pf2e') {
          result.traits = itemSystem?.traits?.value || [];
          result.level = itemSystem?.level?.value ?? undefined;
          result.actionCost = this.formatPF2eActionCost(itemSystem?.actionType?.value);
        }
      }

      // Action fields
      if (item.type === 'action') {
        if (systemId === 'pf2e') {
          result.traits = itemSystem?.traits?.value || [];
          result.actionCost = this.formatPF2eActionCost(
            itemSystem?.actionType?.value || itemSystem?.actions?.value
          );
        }
      }

      matches.push(result);

      // Stop if we've reached the limit
      if (matches.length >= limit) break;
    }

    // Also search actions if type filter includes 'action' or is empty
    if (!searchType || searchType === 'action') {
      const actions =
        actorAny.system?.actions || actorAny.items?.filter((i: any) => i.type === 'action') || [];
      for (const action of actions) {
        if (matches.length >= limit) break;

        const actionName = action.name || action.label || '';
        if (!matchesQuery(actionName)) continue;

        const result: any = {
          id: action.id || action.slug || actionName,
          name: actionName,
          type: 'action',
          actionType: action.type || action.actionType || 'action',
        };

        if (systemId === 'pf2e') {
          result.traits = action.traits || [];
          result.actionCost = this.formatPF2eActionCost(action.actionCost?.value || action.actions);
        }

        matches.push(result);
      }
    }

    // Search effects if type filter includes 'effect' or is empty
    if (!searchType || searchType === 'effect') {
      const effects = actor.effects || [];
      for (const effect of effects) {
        if (matches.length >= limit) break;

        const effectAny = effect;
        if (!matchesQuery(effectAny.name || effectAny.label)) continue;

        matches.push({
          id: effectAny.id,
          name: effectAny.name || effectAny.label,
          type: 'effect',
          description: effectAny.description || undefined,
        });
      }
    }

    this.auditLog(
      'searchCharacterItems',
      {
        characterId: actor.id,
        query,
        type,
        category,
        matchCount: matches.length,
      },
      'success'
    );

    const result: {
      characterId: string;
      characterName: string;
      query?: string;
      type?: string;
      category?: string;
      matches: any[];
      totalMatches: number;
    } = {
      characterId: actor.id || '',
      characterName: actor.name || '',
      matches,
      totalMatches: matches.length,
    };

    if (query) result.query = query;
    if (type) result.type = type;
    if (category) result.category = category;

    return result;
  }

  /**
   * Extract spellcasting data from an actor (supports PF2e, D&D 5e, DSA5, and WFRP4e)
   */
  private extractSpellcastingData(actor: Actor): SpellcastingEntry[] {
    const entries: SpellcastingEntry[] = [];
    const actorAny = actor as any;
    const systemId = (game.system as any).id;

    // Get all spell items from the actor
    const spellItems = actor.items.filter(item => item.type === 'spell');

    if (systemId === 'pf2e') {
      // PF2e: Extract from spellcastingEntries
      const spellcastingEntries =
        actorAny.spellcasting?.contents ||
        actorAny.items?.filter((i: any) => i.type === 'spellcastingEntry') ||
        [];

      for (const entry of spellcastingEntries) {
        const entryData = entry.system || entry;
        const entrySpells: SpellInfo[] = [];

        // Get spells associated with this entry
        // In PF2e, spells have a location property pointing to their spellcasting entry
        const entryId = entry.id;
        const associatedSpells = spellItems.filter((spell: any) => {
          const spellSystem = spell.system;
          return spellSystem?.location?.value === entryId || spellSystem?.location === entryId;
        });

        for (const spell of associatedSpells) {
          const spellSystem = spell.system as any;
          const targeting = this.extractPF2eSpellTargeting(spellSystem);
          entrySpells.push({
            id: spell.id || '',
            name: spell.name || '',
            level: spellSystem?.level?.value ?? spellSystem?.rank ?? 0,
            prepared: spellSystem?.location?.prepared ?? true,
            expended: spellSystem?.location?.expended ?? false,
            traits: spellSystem?.traits?.value || [],
            actionCost: this.formatPF2eActionCost(spellSystem?.time?.value),
            range: targeting.range,
            target: targeting.target,
            area: targeting.area,
          });
        }

        // Also check for spells in the entry's spell collection
        if (entry.spells) {
          for (const [levelKey, levelData] of Object.entries(entry.spells as Record<string, any>)) {
            const spellsAtLevel = levelData?.value || levelData || [];
            if (Array.isArray(spellsAtLevel)) {
              for (const spellRef of spellsAtLevel) {
                // Skip if we already have this spell
                if (entrySpells.some(s => s.id === spellRef.id)) continue;

                const spellItem = actor.items.get(spellRef.id || spellRef);
                if (spellItem) {
                  const spellSystem = spellItem.system as any;
                  const targeting = this.extractPF2eSpellTargeting(spellSystem);
                  entrySpells.push({
                    id: spellItem.id || '',
                    name: spellItem.name || '',
                    level:
                      parseInt(levelKey.replace('spell', '')) || spellSystem?.level?.value || 0,
                    prepared: spellRef.prepared ?? true,
                    expended: spellRef.expended ?? false,
                    traits: spellSystem?.traits?.value || [],
                    actionCost: this.formatPF2eActionCost(spellSystem?.time?.value),
                    range: targeting.range,
                    target: targeting.target,
                    area: targeting.area,
                  });
                }
              }
            }
          }
        }

        entries.push({
          id: entry.id || '',
          name: entry.name || 'Spellcasting',
          tradition: entryData?.tradition?.value || entryData?.tradition || undefined,
          type: entryData?.prepared?.value || entryData?.prepared || 'prepared',
          ability: entryData?.ability?.value || entryData?.ability || undefined,
          dc: entryData?.spelldc?.dc || entryData?.dc?.value || undefined,
          attack: entryData?.spelldc?.value || entryData?.attack?.value || undefined,
          slots: this.extractPF2eSpellSlots(entryData),
          spells: entrySpells.sort((a, b) => a.level - b.level || a.name.localeCompare(b.name)),
        });
      }

      // Also capture focus spells and innate spells that might not be in entries
      const focusSpells = spellItems.filter((spell: any) => {
        const spellSystem = spell.system;
        return (
          spellSystem?.traits?.value?.includes('focus') || spellSystem?.category?.value === 'focus'
        );
      });

      if (focusSpells.length > 0 && !entries.some(e => e.type === 'focus')) {
        entries.push({
          id: 'focus-spells',
          name: 'Focus Spells',
          type: 'focus',
          spells: focusSpells.map((spell: any) => {
            const spellSystem = spell.system;
            const targeting = this.extractPF2eSpellTargeting(spellSystem);
            return {
              id: spell.id || '',
              name: spell.name || '',
              level: spellSystem?.level?.value || 0,
              traits: spellSystem?.traits?.value || [],
              actionCost: this.formatPF2eActionCost(spellSystem?.time?.value),
              range: targeting.range,
              target: targeting.target,
              area: targeting.area,
            };
          }),
        });
      }
    } else if (systemId === 'dnd5e') {
      // D&D 5e: Extract from classes with spellcasting
      const classes = actor.items.filter(item => item.type === 'class');
      const spellSlots = actorAny.system?.spells || {};

      // Group spells by their source class or create a general entry
      const spellsByClass: Record<string, SpellInfo[]> = {};

      for (const spell of spellItems) {
        const spellSystem = spell.system as any;
        const spellRaw = (spell as any)._source?.system || spellSystem;
        const sourceItem = spellSystem?.sourceItem;
        const sourceClass =
          (sourceItem
            ? typeof sourceItem === 'string'
              ? sourceItem
              : sourceItem.identifier || sourceItem.id
            : spellRaw?.sourceClass) || 'general';

        if (!spellsByClass[sourceClass]) {
          spellsByClass[sourceClass] = [];
        }

        const targeting = this.extractDnD5eSpellTargeting(spellSystem);
        spellsByClass[sourceClass].push({
          id: spell.id || '',
          name: spell.name || '',
          level: spellSystem?.level || 0,
          prepared: spellSystem?.prepared ?? spellRaw?.preparation?.prepared ?? true,
          traits: [], // D&D 5e doesn't use traits the same way
          actionCost: spellSystem?.activation?.type || undefined,
          range: targeting.range,
          target: targeting.target,
          area: targeting.area,
        });
      }

      // Create entries for each spellcasting class
      for (const classItem of classes) {
        const classSystem = classItem.system as any;
        if (
          classSystem?.spellcasting?.progression &&
          classSystem.spellcasting.progression !== 'none'
        ) {
          const className = classItem.name || 'Unknown';
          const classSpells =
            spellsByClass[classItem.id || ''] || spellsByClass[className.toLowerCase()] || [];

          entries.push({
            id: classItem.id || '',
            name: `${className} Spellcasting`,
            type: classSystem?.spellcasting?.type || 'prepared',
            ability: classSystem?.spellcasting?.ability || undefined,
            slots: this.extractDnD5eSpellSlots(spellSlots),
            spells: classSpells.sort((a, b) => a.level - b.level || a.name.localeCompare(b.name)),
          });
        }
      }

      // If no class-based entries found but we have spells, create a general entry
      if (entries.length === 0 && spellItems.length > 0) {
        const allSpells: SpellInfo[] = [];
        for (const spell of spellItems) {
          const spellSystem = spell.system as any;
          const targeting = this.extractDnD5eSpellTargeting(spellSystem);
          allSpells.push({
            id: spell.id || '',
            name: spell.name || '',
            level: spellSystem?.level || 0,
            prepared: spellSystem?.preparation?.prepared ?? true,
            actionCost: spellSystem?.activation?.type || undefined,
            range: targeting.range,
            target: targeting.target,
            area: targeting.area,
          });
        }

        entries.push({
          id: 'spellcasting',
          name: 'Spellcasting',
          type: 'prepared',
          slots: this.extractDnD5eSpellSlots(spellSlots),
          spells: allSpells.sort((a, b) => a.level - b.level || a.name.localeCompare(b.name)),
        });
      }
    } else if (systemId === 'dsa5') {
      // DSA5: Extract Zauber (spells), Liturgien (liturgies), Zeremonien (ceremonies), Rituale (rituals)
      const astralSpells = actor.items.filter(item => item.type === 'spell');
      const karmaSpells = actor.items.filter(item => ['liturgy', 'ceremony'].includes(item.type));
      const rituals = actor.items.filter(item => item.type === 'ritual');

      // Get AsP and KaP from actor
      const asp = actorAny.system?.status?.astralenergy || actorAny.system?.astralenergy;
      const kap = actorAny.system?.status?.karmaenergy || actorAny.system?.karmaenergy;

      // Zauber (Arcane spells using AsP)
      if (astralSpells.length > 0) {
        entries.push({
          id: 'zauber',
          name: 'Zauber (Spells)',
          type: 'arcane',
          slots: asp
            ? {
                asp: { value: asp.value ?? 0, max: asp.max ?? 0 },
              }
            : undefined,
          spells: astralSpells
            .map((spell: any) => {
              const spellSystem = spell.system;
              const targeting = this.extractDSA5SpellTargeting(spellSystem);
              return {
                id: spell.id || '',
                name: spell.name || '',
                level: spellSystem?.level?.value ?? spellSystem?.level ?? 0,
                traits: spellSystem?.effect?.attributes || [],
                actionCost: spellSystem?.castingTime?.value || undefined,
                range: targeting.range,
                target: targeting.target,
                area: targeting.area,
              };
            })
            .sort((a, b) => a.level - b.level || a.name.localeCompare(b.name)),
        });
      }

      // Liturgien & Zeremonien (Divine spells using KaP)
      if (karmaSpells.length > 0) {
        entries.push({
          id: 'liturgien',
          name: 'Liturgien & Zeremonien (Liturgies)',
          type: 'divine',
          slots: kap
            ? {
                kap: { value: kap.value ?? 0, max: kap.max ?? 0 },
              }
            : undefined,
          spells: karmaSpells
            .map((spell: any) => {
              const spellSystem = spell.system;
              const targeting = this.extractDSA5SpellTargeting(spellSystem);
              return {
                id: spell.id || '',
                name: spell.name || '',
                level: spellSystem?.level?.value ?? spellSystem?.level ?? 0,
                traits: spellSystem?.effect?.attributes || [],
                actionCost: spellSystem?.castingTime?.value || undefined,
                range: targeting.range,
                target: targeting.target,
                area: targeting.area,
              };
            })
            .sort((a, b) => a.level - b.level || a.name.localeCompare(b.name)),
        });
      }

      // Rituale (Rituals - can use either AsP or KaP depending on tradition)
      if (rituals.length > 0) {
        entries.push({
          id: 'rituale',
          name: 'Rituale (Rituals)',
          type: 'ritual',
          spells: rituals
            .map((spell: any) => {
              const spellSystem = spell.system;
              const targeting = this.extractDSA5SpellTargeting(spellSystem);
              return {
                id: spell.id || '',
                name: spell.name || '',
                level: spellSystem?.level?.value ?? spellSystem?.level ?? 0,
                traits: spellSystem?.effect?.attributes || [],
                actionCost: spellSystem?.castingTime?.value || undefined,
                range: targeting.range,
                target: targeting.target,
                area: targeting.area,
              };
            })
            .sort((a, b) => a.level - b.level || a.name.localeCompare(b.name)),
        });
      }
    } else if (systemId === 'wfrp4e') {
      // WFRP4e: arcane spells grouped by Lore, divine prayers grouped by God.
      // WFRP4e has no spell levels or slots; spells use a Casting Number (CN).
      const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

      // Arcane spells, grouped by lore
      const spellsByLore = new Map<string, SpellInfo[]>();
      for (const spell of actor.items.filter(item => item.type === 'spell')) {
        const spellSystem = spell.system as any;
        const loreRaw = spellSystem?.lore?.value;
        const lore = String((Array.isArray(loreRaw) ? loreRaw[0] : loreRaw) || 'arcane');
        const cn = spellSystem?.cn?.value;
        const info: SpellInfo = {
          id: spell.id || '',
          name: spell.name || '',
          level: 0,
          actionCost: cn !== undefined && cn !== null ? `CN ${cn}` : undefined,
          range: spellSystem?.range?.value || undefined,
          target: spellSystem?.target?.value || undefined,
        };
        if (!spellsByLore.has(lore)) spellsByLore.set(lore, []);
        spellsByLore.get(lore)!.push(info);
      }
      for (const [lore, loreSpells] of spellsByLore) {
        entries.push({
          id: `lore-${lore}`,
          name: `Lore of ${cap(lore)}`,
          type: 'arcane',
          tradition: 'arcane',
          spells: loreSpells.sort((a, b) => a.name.localeCompare(b.name)),
        });
      }

      // Divine prayers, grouped by god
      const prayersByGod = new Map<string, SpellInfo[]>();
      for (const prayer of actor.items.filter(item => item.type === 'prayer')) {
        const praySystem = prayer.system as any;
        const god = String(praySystem?.god?.value || 'divine');
        const info: SpellInfo = {
          id: prayer.id || '',
          name: prayer.name || '',
          level: 0,
          range: praySystem?.range?.value || undefined,
          target: praySystem?.target?.value || undefined,
        };
        if (!prayersByGod.has(god)) prayersByGod.set(god, []);
        prayersByGod.get(god)!.push(info);
      }
      for (const [god, godPrayers] of prayersByGod) {
        entries.push({
          id: `prayers-${god}`,
          name: god === 'divine' ? 'Prayers' : `Prayers (${cap(god)})`,
          type: 'divine',
          tradition: 'divine',
          spells: godPrayers.sort((a, b) => a.name.localeCompare(b.name)),
        });
      }
    }

    return entries;
  }

  /**
   * Format PF2e action cost to human-readable string
   */
  private formatPF2eActionCost(actionValue: any): string | undefined {
    if (!actionValue) return undefined;
    if (typeof actionValue === 'number') {
      return actionValue === 1 ? '1 action' : `${actionValue} actions`;
    }
    if (actionValue === 'reaction') return 'reaction';
    if (actionValue === 'free') return 'free action';
    return String(actionValue);
  }

  /**
   * Extract PF2e spell slots from spellcasting entry data
   */
  private extractPF2eSpellSlots(
    entryData: any
  ): Record<string, { value: number; max: number }> | undefined {
    const slots: Record<string, { value: number; max: number }> = {};

    // PF2e stores slots per rank
    for (let rank = 1; rank <= 10; rank++) {
      const slotKey = `slot${rank}`;
      const slotData = entryData?.slots?.[slotKey] || entryData?.[slotKey];
      if (slotData && (slotData.max > 0 || slotData.value > 0)) {
        slots[`rank${rank}`] = {
          value: slotData.value ?? 0,
          max: slotData.max ?? 0,
        };
      }
    }

    return Object.keys(slots).length > 0 ? slots : undefined;
  }

  /**
   * Extract D&D 5e spell slots from actor system data
   */
  private extractDnD5eSpellSlots(
    spellsData: any
  ): Record<string, { value: number; max: number }> | undefined {
    const slots: Record<string, { value: number; max: number }> = {};

    // D&D 5e stores slots as spell1, spell2, etc.
    for (let level = 1; level <= 9; level++) {
      const slotKey = `spell${level}`;
      const slotData = spellsData?.[slotKey];
      if (slotData && (slotData.max > 0 || slotData.value > 0)) {
        slots[`level${level}`] = {
          value: slotData.value ?? 0,
          max: slotData.max ?? 0,
        };
      }
    }

    // Also check for pact slots (warlock)
    const pactSlot = spellsData?.pact;
    if (pactSlot && (pactSlot.max > 0 || pactSlot.value > 0)) {
      slots['pact'] = {
        value: pactSlot.value ?? 0,
        max: pactSlot.max ?? 0,
      };
    }

    return Object.keys(slots).length > 0 ? slots : undefined;
  }

  /**
   * Extract spell targeting info for D&D 5e
   * D&D 5e spells have: target.type ("self", "creature", "point", etc.), range.value, range.units
   */
  private extractDnD5eSpellTargeting(spellSystem: any): {
    range?: string;
    target?: string;
    area?: string;
  } {
    const result: { range?: string; target?: string; area?: string } = {};

    // Range (e.g., "60 feet", "Self", "Touch")
    const rangeValue = spellSystem?.range?.value;
    const rangeUnits = spellSystem?.range?.units;
    if (rangeUnits === 'self') {
      result.range = 'Self';
    } else if (rangeUnits === 'touch') {
      result.range = 'Touch';
    } else if (rangeUnits === 'spec') {
      result.range = spellSystem?.range?.special || 'Special';
    } else if (rangeValue && rangeUnits) {
      result.range = `${rangeValue} ${rangeUnits}`;
    }

    // Target type (e.g., "1 creature", "self", "area")
    const targetType = spellSystem?.target?.type;
    const targetValue = spellSystem?.target?.value;
    if (targetType === 'self') {
      result.target = 'self';
    } else if (targetType === 'creature' || targetType === 'ally' || targetType === 'enemy') {
      result.target = targetValue
        ? `${targetValue} ${targetType}${targetValue > 1 ? 's' : ''}`
        : targetType;
    } else if (targetType === 'object') {
      result.target = targetValue ? `${targetValue} object${targetValue > 1 ? 's' : ''}` : 'object';
    } else if (targetType === 'space' || targetType === 'point') {
      result.target = 'point';
    } else if (targetType) {
      result.target = targetType;
    }

    // Area (for AoE spells - e.g., "20-foot radius", "30-foot cone")
    const areaType = spellSystem?.target?.template?.type;
    const areaSize = spellSystem?.target?.template?.size;
    const areaUnits = spellSystem?.target?.template?.units || 'ft';
    if (areaType && areaSize) {
      result.area = `${areaSize}-${areaUnits} ${areaType}`;
      // If spell has area, target is usually "area"
      if (!result.target || result.target === 'point') {
        result.target = 'area';
      }
    }

    return result;
  }

  /**
   * Extract spell targeting info for PF2e
   * PF2e spells have: target (string), range.value, area.type, area.value
   */
  private extractPF2eSpellTargeting(spellSystem: any): {
    range?: string;
    target?: string;
    area?: string;
  } {
    const result: { range?: string; target?: string; area?: string } = {};

    // Range (e.g., "30 feet", "touch")
    const rangeValue = spellSystem?.range?.value;
    if (rangeValue) {
      result.range = String(rangeValue);
    }

    // Target (PF2e has a descriptive target string)
    const targetValue = spellSystem?.target?.value;
    if (targetValue) {
      result.target = String(targetValue);
    }

    // Area (e.g., "15-foot emanation", "30-foot cone")
    const areaType = spellSystem?.area?.type;
    const areaValue = spellSystem?.area?.value;
    if (areaType) {
      if (areaValue) {
        result.area = `${areaValue}-foot ${areaType}`;
      } else {
        result.area = areaType;
      }
      // If has area but no explicit target, it's an area spell
      if (!result.target) {
        result.target = 'area';
      }
    }

    return result;
  }

  /**
   * Extract spell targeting info for DSA5
   * DSA5 spells have: targetCategory, range, etc.
   */
  private extractDSA5SpellTargeting(spellSystem: any): {
    range?: string;
    target?: string;
    area?: string;
  } {
    const result: { range?: string; target?: string; area?: string } = {};

    // Range
    const rangeValue = spellSystem?.range?.value || spellSystem?.Reichweite;
    if (rangeValue) {
      result.range = String(rangeValue);
    }

    // Target category
    const targetCategory = spellSystem?.targetCategory?.value || spellSystem?.Zielkategorie;
    if (targetCategory) {
      result.target = String(targetCategory);
    }

    // Area (Wirkungsbereich)
    const areaValue = spellSystem?.effectRadius?.value || spellSystem?.Wirkungsbereich;
    if (areaValue) {
      result.area = String(areaValue);
    }

    return result;
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
    return this.compendiumSearch.searchCompendium(query, packType, filters);
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
    return this.compendiumSearch.listCreaturesByCriteria(criteria);
  }

  /**
   * List all actors with basic information
   */
  async listActors(): Promise<Array<{ id: string; name: string; type: string; img?: string }>> {
    return this.actorDirectory.listActors();
  }

  /**
   * Find actors carrying a flag at a dotted path (read-only). See
   * ActorDirectory.findActorsByFlag — including why the flag must NOT be read
   * with `actor.getFlag()`.
   */
  async findActorsByFlag(data: {
    flagPath: string;
    values?: string[];
    exists?: boolean;
    type?: string;
  }): Promise<{
    matches: Array<{
      id: string;
      name: string;
      type: string;
      img?: string;
      folder: string | null;
      flagValue: string;
    }>;
    total: number;
  }> {
    return this.actorDirectory.findActorsByFlag(data);
  }

  /**
   * The actor's flag object, sanitized for transport.
   *
   * Read via `foundry.utils.getProperty(actor, 'flags')` / raw property access —
   * NEVER `actor.getFlag(scope, key)`, which throws for any scope that is not
   * core / the system id / the world id / an active module id. `wodchar` (the
   * scope the importer stamps `sourceId` under) is none of those, so `getFlag`
   * would throw on exactly the actors this exists to inspect. Same rule as
   * `importActors`' `findBySourceId`.
   */
  private readActorFlags(actor: Actor): Record<string, unknown> {
    const getProperty = (foundry as any)?.utils?.getProperty;
    const raw = getProperty ? getProperty(actor, 'flags') : (actor as any)?.flags;
    const sanitized = this.sanitizeData(raw ?? {});
    return sanitized && typeof sanitized === 'object' ? sanitized : {};
  }

  /**
   * The actor's prototype-token ART, curated to the fields that answer "did the
   * token image survive the import?" — the full prototypeToken is large and
   * mostly vision/bar configuration nobody reads.
   *
   * `prototypeToken` is a DataModel, so it is converted with `toObject()` first;
   * `Object.keys()` on the live model does not necessarily expose schema fields.
   */
  private extractTokenArt(actor: Actor): Record<string, unknown> | null {
    const proto = (actor as any)?.prototypeToken;
    if (!proto) return null;
    const obj: any =
      typeof proto.toObject === 'function' ? proto.toObject(false) : this.sanitizeData(proto);
    if (!obj || typeof obj !== 'object') return null;
    const texture = obj.texture ?? {};
    const art: Record<string, unknown> = {
      texture: {
        src: texture.src ?? null,
        ...(texture.scaleX !== undefined ? { scaleX: texture.scaleX } : {}),
        ...(texture.scaleY !== undefined ? { scaleY: texture.scaleY } : {}),
      },
    };
    if (obj.name !== undefined) art.name = obj.name;
    if (obj.actorLink !== undefined) art.actorLink = obj.actorLink;
    if (obj.ring !== undefined && obj.ring !== null) art.ring = this.sanitizeData(obj.ring);
    return art;
  }

  /**
   * Get active scene information
   */
  async getActiveScene(): Promise<SceneInfo> {
    return this.sceneTokenManager.getActiveScene();
  }

  /**
   * Get world information
   */
  async getWorldInfo(): Promise<WorldInfo> {
    // World info doesn't require special permissions as it's basic metadata

    return {
      id: game.world.id,
      title: game.world.title,
      system: game.system.id,
      systemVersion: game.system.version,
      foundryVersion: game.version,
      users: game.users.map(user => ({
        id: user.id || '',
        name: user.name || '',
        active: user.active,
        isGM: user.isGM,
      })),
    };
  }

  /**
   * Get available compendium packs
   */
  async getAvailablePacks() {
    return this.compendiumSearch.getAvailablePacks();
  }

  /**
   * Sanitize data to remove sensitive information and make it JSON-safe
   *
   * TEMPORARY BRIDGE, not a boundary member. Untouched by the actor-CRUD extraction — that
   * cluster sanitises nothing, so this wrapper is entirely the character-reading cluster's:
   * `getCharacterInfo` x2, `readActorFlags`, `extractTokenArt` x2. Expires with pass 5.2.
   */
  private sanitizeData(data: any): any {
    return this.security.sanitizeData(data);
  }

  /**
   * Validate that Foundry is ready and world is active
   *
   * PERMANENT. It is a boundary member — queries.ts reaches it directly in many places —
   * so it survives regardless of who calls it inside the class (currently
   * `searchCharacterItems`, cluster B).
   */
  validateFoundryState(): void {
    return this.security.validateFoundryState();
  }

  /**
   * Audit log for write operations
   *
   * TEMPORARY BRIDGE, not a boundary member. Nothing outside the class reaches it. After
   * the actor-CRUD extraction its ONLY remaining caller is `searchCharacterItems` (:633),
   * which belongs to the character-reading cluster — so it expires with pass 5.2 and MUST
   * NOT be deleted before then. Dropping from fifteen callers to one is not evidence of
   * expiry; the remaining caller is.
   */
  private auditLog(
    operation: string,
    data: any,
    result: 'success' | 'failure',
    error?: string
  ): void {
    return this.security.auditLog(operation, data, result, error);
  }

  // ===== PHASE 2 & 3: WRITE OPERATIONS =====

  /**
   * Create journal entry for quests, with optional additional pages
   */
  async createJournalEntry(request: {
    name: string;
    content: string;
    folderName?: string;
    additionalPages?: Array<{ name: string; content: string }>;
  }): Promise<{ id: string; name: string; pageCount: number }> {
    return this.journals.createJournalEntry(request);
  }

  /**
   * List all journal entries with page metadata
   */
  async listJournals(): Promise<
    Array<{
      id: string;
      name: string;
      type: string;
      pageCount: number;
      pages: Array<{ id: string; name: string; type: string }>;
    }>
  > {
    return this.journals.listJournals();
  }

  /**
   * Get journal entry content (first text page + page manifest)
   */
  async getJournalContent(journalId: string): Promise<{
    content: string;
    currentPage?: { id: string; name: string } | undefined;
    allPages: Array<{ id: string; name: string; type: string }>;
    pageCount: number;
    note?: string | undefined;
  } | null> {
    return this.journals.getJournalContent(journalId);
  }

  /**
   * Get a specific journal page's content by ID
   */
  async getJournalPageContent(
    journalId: string,
    pageId: string
  ): Promise<{ id: string; name: string; type: string; content: string } | null> {
    return this.journals.getJournalPageContent(journalId, pageId);
  }

  /**
   * Update journal entry content
   * - No pageId/newPageName: update first text page (backward compat)
   * - With pageId: update that specific page
   * - With newPageName (no pageId): create a new page
   */
  async updateJournalContent(request: {
    journalId: string;
    content: string;
    pageId?: string | undefined;
    newPageName?: string | undefined;
  }): Promise<{ success: boolean; pageId?: string | undefined; pageName?: string | undefined }> {
    return this.journals.updateJournalContent(request);
  }

  /**
   * Create actor from specific compendium entry using pack/item IDs
   *
   * Delegates to actor-crud.ts. This delegation is PERMANENT: queries.ts reaches it.
   */
  async createActorFromCompendiumEntry(request: {
    packId: string;
    itemId: string;
    customNames: string[];
    quantity?: number;
    addToScene?: boolean;
    placement?: {
      type: 'random' | 'grid' | 'center' | 'coordinates';
      coordinates?: { x: number; y: number }[];
    };
  }): Promise<ActorCreationResult> {
    return this.actorCrud.createActorFromCompendiumEntry(request);
  }

  /**
   * Add one or more freshly-authored Item documents to an existing Actor.
   *
   * Unlike `createActorFromCompendium*`, the items here are constructed from
   * caller-supplied data — no compendium lookup. This is the path used to
   * push planner-authored content (talents, actions, powers, custom gear)
   * onto a PC or NPC sheet.
   *
   * Validation is intentionally light: name + type are required, and the
   * type is checked against the active system's declared Item document
   * types when available. Everything else (system schema validation,
   * required sub-fields) is delegated to Foundry's DataModel layer, which
   * will fill defaults or throw a meaningful error.
   *
   * Delegates to actor-crud.ts. This delegation is PERMANENT: queries.ts reaches it.
   */
  async addActorItems(params: {
    actorIdentifier: string;
    items: Array<{
      name: string;
      type: string;
      img?: string;
      system?: Record<string, any>;
    }>;
  }): Promise<{
    actorId: string;
    actorName: string;
    created: Array<{ id: string; name: string; type: string }>;
  }> {
    return this.actorCrud.addActorItems(params);
  }

  /**
   * Remove embedded Items from an existing Actor.
   *
   * Items can be named by id (exact, reliable) and/or by name (case-insensitive,
   * optionally constrained to a `type` to disambiguate). Names that match nothing
   * are reported back rather than silently ignored. This is the counterpart to
   * `addActorItems` — useful for clearing stray items added with the wrong type.
   *
   * Delegates to actor-crud.ts. This delegation is PERMANENT: queries.ts reaches it.
   */
  async removeActorItems(params: {
    actorIdentifier: string;
    itemIds?: string[];
    itemNames?: string[];
    type?: string;
  }): Promise<{
    actorId: string;
    actorName: string;
    removed: Array<{ id: string; name: string; type: string }>;
    notFound: string[];
  }> {
    return this.actorCrud.removeActorItems(params);
  }

  /**
   * List world-level Item documents from the Items sidebar.
   * Optionally filters by type, folder (name or id), or a case-insensitive name substring.
   */
  async listWorldItems(params: { type?: string; folder?: string; nameFilter?: string }): Promise<
    Array<{
      id: string;
      name: string;
      type: string;
      img?: string;
      folderId: string | null;
      folderName: string | null;
    }>
  > {
    return this.worldItems.listWorldItems(params);
  }

  /**
   * Update one or more existing world-level Item documents.
   *
   * Each entry must supply an `id` plus at least one field to change (name,
   * img, system, folder). Uses Item.updateDocuments() for a single batched
   * write. Folder may be supplied as a name or id; if a name is given that
   * does not exist, it is created automatically (same behaviour as
   * createWorldItems).
   */
  async updateWorldItems(params: {
    updates: Array<{
      id: string;
      name?: string;
      img?: string;
      system?: Record<string, any>;
      folder?: string;
    }>;
  }): Promise<{
    updated: Array<{ id: string; name: string; type: string }>;
  }> {
    return this.worldItems.updateWorldItems(params);
  }

  /**
   * Create one or more world-level Item documents (Items sidebar, not embedded on an actor).
   *
   * Uses Item.createDocuments() with no parent so items appear in the Foundry
   * Items sidebar and can be dragged onto any actor sheet. Optionally places
   * items inside a named/id-resolved folder, creating the folder if necessary.
   */
  async createWorldItems(params: {
    items: Array<{
      name: string;
      type: string;
      img?: string;
      system?: Record<string, any>;
    }>;
    folder?: string;
  }): Promise<{
    folderId: string | null;
    folderName: string | null;
    created: Array<{ id: string; name: string; type: string }>;
  }> {
    return this.worldItems.createWorldItems(params);
  }

  /**
   * Get system-specific enum/schema information for the current game system.
   * Returns valid values for enumerated fields so the LLM can use correct keys
   * when creating or updating items/actors (e.g. weapon.traits in mgt2e).
   *
   * RESIDUAL, not yet extracted, and deliberately NOT part of the actor-CRUD cluster: it
   * creates nothing, updates nothing, deletes nothing, touches no actor, and has zero
   * call-graph edges in either direction. "It has no edges, so it can go anywhere" is not
   * a reason to give a module a concern it does not own. Recorded with its reason in
   * docs/refactor-data-access.md; its home is pass 5.2's decision to argue on the merits.
   */
  getSystemSchema(): Record<string, any> {
    const systemId = (game as any).system?.id ?? 'unknown';

    if (systemId !== 'mgt2e') {
      return {
        system: systemId,
        message: 'No enum schema available for this system',
      };
    }

    const mgt2Config = (CONFIG as any).MGT2;
    if (!mgt2Config) {
      return { system: 'mgt2e', message: 'CONFIG.MGT2 not found — system may not be fully loaded' };
    }

    // ── Weapon traits from live CONFIG.MGT2.WEAPONS.traits ───────────────────
    const weaponTraitsRaw = mgt2Config.WEAPONS?.traits ?? {};
    const traitsPersonal: string[] = [];
    const traitsSpacecraft: string[] = [];
    const traitsAny: string[] = [];
    const traitsWithValue: string[] = [];

    for (const [key, val] of Object.entries(weaponTraitsRaw)) {
      const v = val as any;
      const scale: string = v.scale ?? 'any';
      if (scale === 'traveller' || scale === 'vehicle') traitsPersonal.push(key);
      else if (scale === 'spacecraft') traitsSpacecraft.push(key);
      else traitsAny.push(key); // no scale restriction
      if (v.value !== undefined) traitsWithValue.push(key);
    }

    return {
      system: 'mgt2e',
      description:
        'Enum reference for mgt2e item and actor fields. Use these exact keys — wrong values are silently ignored by the system.',
      items: {
        weapon: {
          'weapon.traits': {
            description:
              'Comma-separated string of trait keys. Traits with numeric values use "key N" (e.g. "ap 5, auto 3, stun"). Conflicts: bulky/veryBulky, dangerous/veryDangerous, ap/loPen.',
            traits_personal_scale: traitsPersonal.sort(),
            traits_spacecraft_scale: traitsSpacecraft.sort(),
            traits_any_scale: traitsAny.sort(),
            traits_requiring_numeric_value: traitsWithValue.sort(),
            example: 'ap 5, auto 3, scope, stun',
          },
          'weapon.scale': ['traveller', 'vehicle', 'spacecraft'],
          'weapon.characteristic': ['STR', 'DEX', 'END', 'INT', 'EDU', 'SOC'],
          'weapon.damageType': [
            'standard',
            'fire',
            'cutting',
            'energy',
            'laser',
            'plasma',
            'meson',
            'nuclear',
          ],
          'weapon.skill':
            'Format: "skillKey.specialityKey" (e.g. "guncombat.slug", "melee.blade", "heavyweapons.portable")',
        },
        armour: {
          'armour.form': ['standard', 'layered', 'stackable', 'natural'],
          note: 'stackable: stacks with other stackable armour. layered: can layer under others. natural: creature skin, always worn.',
        },
        hardware: {
          'hardware.system': [
            'general',
            'power',
            'armour',
            'fuel',
            'drive',
            'bridge',
            'sensor',
            'computer',
            'weapon',
            'defence',
            'stateroom',
            'common',
            'cargo',
          ],
          spacecraft_sheet_sections: {
            'Componentes (coreItems)': ['power', 'armour', 'fuel', 'drive'],
            'Puente (bridgeItems)': ['bridge', 'sensor', 'computer'],
            'Armas (weaponItems)': ['weapon', 'defence'],
            'Habitabilidad (livingItems)': ['stateroom', 'common'],
            'Carga (cargoItems)': ['cargo'],
            'General (generalItems)': ['general'],
          },
        },
        software: {
          'software.class': ['personal', 'ship'],
          'software.type': ['generic', 'interface', 'bonus'],
          note: 'class determines which SOFTWARE_EFFECTS apply. type=bonus enables skill/char bonuses.',
        },
        associate: {
          'associate.relationship': ['contact', 'ally', 'rival', 'enemy'],
        },
        base: {
          status: ['equipped', 'carried'],
          note: 'status is set from MgT2Item.EQUIPPED / MgT2Item.CARRIED constants.',
        },
        actor: {
          'weapon.scale_hint':
            'When adding a weapon to a spacecraft actor, set weapon.scale="spacecraft" to show in the ship weapons section.',
        },
      },
    };
  }

  /**
   * Get full compendium document with all embedded data
   *
   * Delegates to compendium-search.ts. This delegation is PERMANENT: queries.ts
   * reaches it, so the compatibility boundary requires it regardless of who else
   * calls it internally.
   */
  async getCompendiumDocumentFull(
    packId: string,
    documentId: string
  ): Promise<CompendiumEntryFull> {
    return this.compendiumSearch.getCompendiumDocumentFull(packId, documentId);
  }

  /**
   * Add actors to the current scene as tokens
   *
   * Delegates to actor-crud.ts. This delegation is PERMANENT: queries.ts reaches it.
   */
  async addActorsToScene(
    placement: SceneTokenPlacement,
    transactionId?: string
  ): Promise<TokenPlacementResult> {
    return this.actorCrud.addActorsToScene(placement, transactionId);
  }

  /**
   * Validate write operation permissions
   */
  async validateWritePermissions(operation: 'createActor' | 'modifyScene'): Promise<{
    allowed: boolean;
    reason?: string;
    requiresConfirmation?: boolean;
    warnings?: string[];
  }> {
    return this.rollManager.validateWritePermissions(operation);
  }

  /**
   * Request player rolls - creates interactive roll buttons in chat
   */
  async requestPlayerRolls(data: {
    rollType: string;
    rollTarget: string;
    targetPlayer: string;
    isPublic: boolean;
    rollModifier: string;
    flavor: string;
  }): Promise<{ success: boolean; message: string; error?: string }> {
    return this.rollManager.requestPlayerRolls(data);
  }

  /**
   * Attach click handlers to roll buttons and handle visibility
   * Called by global renderChatMessageHTML hook in main.ts
   */
  public attachRollButtonHandlers(html: JQuery): void {
    return this.rollManager.attachRollButtonHandlers(html);
  }

  /**
   * Get enhanced creature index for campaign analysis
   */
  async getEnhancedCreatureIndex(): Promise<any[]> {
    return this.compendiumSearch.getEnhancedCreatureIndex();
  }

  /**
   * Save roll button state to persistent storage
   */
  async saveRollState(buttonId: string, userId: string): Promise<void> {
    return this.rollManager.saveRollState(buttonId, userId);
  }

  /**
   * Get roll button state from persistent storage
   */
  getRollState(
    buttonId: string
  ): { rolled: boolean; rolledBy?: string; rolledByName?: string; timestamp?: number } | null {
    return this.rollManager.getRollState(buttonId);
  }

  /**
   * Save button ID to message ID mapping for ChatMessage updates
   */
  saveRollButtonMessageId(buttonId: string, messageId: string): void {
    return this.rollManager.saveRollButtonMessageId(buttonId, messageId);
  }

  /**
   * Get message ID for a roll button
   */
  getRollButtonMessageId(buttonId: string): string | null {
    return this.rollManager.getRollButtonMessageId(buttonId);
  }

  /**
   * Get roll button state from ChatMessage flags
   */
  getRollStateFromMessage(chatMessage: any, buttonId: string): any {
    return this.rollManager.getRollStateFromMessage(chatMessage, buttonId);
  }

  /**
   * Update the ChatMessage to replace button with rolled state
   */
  async updateRollButtonMessage(
    buttonId: string,
    userId: string,
    rollLabel: string
  ): Promise<void> {
    return this.rollManager.updateRollButtonMessage(buttonId, userId, rollLabel);
  }

  /**
   * Request GM to save roll state (for non-GM users who can't write to world settings)
   */
  requestRollStateSave(buttonId: string, userId: string): void {
    return this.rollManager.requestRollStateSave(buttonId, userId);
  }

  /**
   * Broadcast roll state change to all connected users for real-time sync
   */
  broadcastRollState(_buttonId: string, _rollState: any): void {
    return this.rollManager.broadcastRollState(_buttonId, _rollState);
  }

  /**
   * Clean up old roll states (optional maintenance)
   * Removes roll states older than 30 days to prevent storage bloat
   */
  async cleanOldRollStates(): Promise<number> {
    return this.rollManager.cleanOldRollStates();
  }

  /**
   * Set actor ownership permission for a user
   *
   * Delegates to actor-crud.ts. This delegation is PERMANENT: queries.ts reaches it.
   */
  async setActorOwnership(data: {
    actorId: string;
    userId: string;
    permission: number;
  }): Promise<{ success: boolean; message: string; error?: string }> {
    return this.actorCrud.setActorOwnership(data);
  }

  /**
   * Update a WFRP4e actor's stat block (characteristics and/or wounds).
   * Writes initial/advances/modifier and wounds value/max; WFRP4e recomputes
   * the derived characteristic value/bonus on update.
   *
   * Delegates to actor-crud.ts. This delegation is PERMANENT: queries.ts reaches it.
   */
  async updateWfrp4eActor(data: {
    actor: string;
    characteristics?: Record<string, { initial?: number; advances?: number; modifier?: number }>;
    wounds?: { value?: number; max?: number };
    skills?: Array<{ name: string; advances: number }>;
    career?: string;
    movement?: number;
    biography?: string;
  }): Promise<any> {
    return this.actorCrud.updateWfrp4eActor(data);
  }

  /**
   * Add items (skills, talents, traits, trappings, careers, weapons, spells, …)
   * to an existing WFRP4e actor. Each requested item is matched by name against
   * the installed WFRP4e compendiums and copied in full, so a skill keeps its
   * linked characteristic, a talent its tests/max, a career its progression.
   * Names with no compendium match are added as a blank item of the requested
   * (or default) type so homebrew still works.
   *
   * Per-item extras: `advances` sets a skill's advances; `quantity` sets a
   * gear count; `setCurrent` makes a career the active one (flipping the others
   * off). Resolution prefers the Core Rulebook pack, then the rest; pass `type`
   * and/or `pack` to disambiguate a name that exists in several places.
   *
   * Delegates to actor-crud.ts. This delegation is PERMANENT: queries.ts reaches it.
   */
  async addWfrp4eItems(data: {
    actor: string;
    items: Array<{
      name: string;
      type?: string;
      pack?: string;
      advances?: number;
      quantity?: number;
      setCurrent?: boolean;
    }>;
  }): Promise<any> {
    return this.actorCrud.addWfrp4eItems(data);
  }

  /**
   * Get actor ownership information
   *
   * Delegates to actor-crud.ts. This delegation is PERMANENT: queries.ts reaches it.
   */
  async getActorOwnership(data: {
    actorIdentifier?: string;
    playerIdentifier?: string;
  }): Promise<any> {
    return this.actorCrud.getActorOwnership(data);
  }

  /**
   * Find actor by name or ID
   *
   * TEMPORARY BRIDGE, not a boundary member. Its only remaining caller after the
   * actor-CRUD extraction is `searchCharacterItems` (:429), character-reading cluster, so
   * it expires with pass 5.2 and not with this one.
   */
  private findActorByIdentifier(identifier: string): any {
    return this.actorResolver.findActorByIdentifier(identifier);
  }

  /**
   * Get friendly NPCs from current scene
   */
  async getFriendlyNPCs(): Promise<Array<{ id: string; name: string }>> {
    return this.actorDirectory.getFriendlyNPCs();
  }

  /**
   * Get party characters (player-owned actors)
   */
  async getPartyCharacters(): Promise<Array<{ id: string; name: string }>> {
    return this.actorDirectory.getPartyCharacters();
  }

  /**
   * Get connected players (excluding GM)
   */
  async getConnectedPlayers(): Promise<Array<{ id: string; name: string }>> {
    return this.actorDirectory.getConnectedPlayers();
  }

  /**
   * Find players by identifier with partial matching
   */
  async findPlayers(data: {
    identifier: string;
    allowPartialMatch?: boolean;
    includeCharacterOwners?: boolean;
  }): Promise<Array<{ id: string; name: string }>> {
    return this.actorDirectory.findPlayers(data);
  }

  /**
   * Find single actor by identifier
   */
  async findActor(data: { identifier: string }): Promise<{ id: string; name: string } | null> {
    return this.actorDirectory.findActor(data);
  }

  /**
   * Roll a dice formula now and post the result to the chat log. Generic and
   * system-agnostic — returns the total and the raw first-term die faces so the
   * caller can apply system-specific success counting (e.g. World of Darkness).
   */
  async rollDice({
    formula,
    flavor,
    whisper,
  }: {
    formula: string;
    flavor?: string;
    whisper?: boolean;
  }): Promise<{ success: boolean; total: number; dice: number[] }> {
    return this.rollManager.rollDice({ formula, flavor, whisper });
  }

  /**
   * Get or create a folder for organizing MCP-generated content
   *
   * PERMANENT, despite being `private` and despite having exactly ONE caller. That caller
   * is `importActors`, which is a recorded PERMANENT DEFERRAL and therefore never moves, so
   * this wrapper never becomes dead. Do NOT read its single caller as evidence that it is
   * about to expire, and do NOT delete it on the reasoning that the actor-CRUD cluster
   * which used to call it four times has moved: that reasoning type-checks cleanly and
   * breaks the one method in this file whose failure mode is silent duplicate actors.
   */
  private async getOrCreateFolder(
    folderName: string,
    type: 'Actor' | 'JournalEntry'
  ): Promise<string | null> {
    return this.actorResolver.getOrCreateFolder(folderName, type);
  }

  /**
   * List all scenes with filtering options
   */
  async listScenes(
    options: { filter?: string; include_active_only?: boolean } = {}
  ): Promise<any[]> {
    return this.sceneTokenManager.listScenes(options);
  }

  /**
   * Switch to a different scene
   */
  async switchScene(options: { scene_identifier: string; optimize_view?: boolean }): Promise<any> {
    return this.sceneTokenManager.switchScene(options);
  }

  // ===== PHASE 7: CHARACTER ENTITY AND TOKEN MANIPULATION METHODS =====

  /**
   * Get detailed information about a specific entity within a character (item, action, or effect)
   */
  async getCharacterEntity(data: {
    characterIdentifier: string;
    entityIdentifier: string;
  }): Promise<any> {
    return this.sceneTokenManager.getCharacterEntity(data);
  }

  /**
   * Move a token to a new position on the scene
   */
  async moveToken(data: {
    tokenId: string;
    x: number;
    y: number;
    animate?: boolean;
  }): Promise<any> {
    return this.sceneTokenManager.moveToken(data);
  }

  /**
   * Update token properties
   */
  async updateToken(data: { tokenId: string; updates: Record<string, any> }): Promise<any> {
    return this.sceneTokenManager.updateToken(data);
  }

  /**
   * Delete one or more tokens from the scene
   */
  async deleteTokens(data: { tokenIds: string[] }): Promise<any> {
    return this.sceneTokenManager.deleteTokens(data);
  }

  /**
   * Get detailed information about a token
   */
  async getTokenDetails(data: { tokenId: string }): Promise<any> {
    return this.sceneTokenManager.getTokenDetails(data);
  }

  /**
   * Toggle a status condition on a token
   */
  async toggleTokenCondition(data: {
    tokenId: string;
    conditionId: string;
    active: boolean;
  }): Promise<any> {
    return this.sceneTokenManager.toggleTokenCondition(data);
  }

  /**
   * Get all available conditions for the current game system
   */
  async getAvailableConditions(): Promise<any> {
    return this.sceneTokenManager.getAvailableConditions();
  }

  /**
   * Move a token to a new position
   */

  /**
   * Use an item on a character (cast spell, use ability, consume item, etc.)
   * This triggers the item's default use behavior in Foundry VTT
   */
  async useItem(params: {
    actorIdentifier: string;
    itemIdentifier: string;
    targets?: string[] | undefined; // Target character/token names or IDs. "self" targets the caster.
    options?:
      | {
          consume?: boolean | undefined; // Whether to consume charges/uses
          configureDialog?: boolean | undefined; // Whether to show configuration dialog
          skipDialog?: boolean | undefined; // Skip confirmation dialogs (default: true for MCP)
          spellLevel?: number | undefined; // For spells: cast at higher level
          versatile?: boolean | undefined; // For versatile weapons: use versatile damage
        }
      | undefined;
  }): Promise<{
    success: boolean;
    status?: string;
    message: string;
    itemName?: string;
    actorName?: string;
    targets?: string[];
    requiresGMInteraction?: boolean;
  }> {
    return this.actorMechanics.useItem(params);
  }

  // ===== D&D 5E FEATURE CREATION =====

  /**
   * Add a save-attack feature (feat) to an existing D&D 5e actor.
   * Creates a single save Activity with damage and an optional area template.
   */
  async addSaveFeatureToActor(data: {
    actorIdentifier: string;
    featureName: string;
    description: string;
    activationType: string;
    saveAbility: string;
    saveDC: number;
    damageParts: Array<{ number: number; denomination: number; type: string }>;
    halfOnSave: boolean;
    areaType: string;
    areaSize?: number;
    areaUnits: string;
    affectsType: string;
  }): Promise<any> {
    return this.actorMechanics.addSaveFeatureToActor(data);
  }

  /**
   * Delegates to actor-crud.ts. This delegation is PERMANENT: queries.ts reaches it.
   */
  async createNpcActor(data: {
    name: string;
    creatureType: string;
    creatureSubtype: string;
    size: string;
    alignment: string;
    cr: string | number;
    hpAverage: number;
    hpFormula: string;
    acMode: string;
    acValue?: number;
    abilities: { str: number; dex: number; con: number; int: number; wis: number; cha: number };
    savingThrows: string[];
    walkSpeed: number;
    flySpeed: number;
    swimSpeed: number;
    climbSpeed: number;
    burrowSpeed: number;
    hover: boolean;
    darkvision: number;
    blindsight: number;
    tremorsense: number;
    truesight: number;
    specialSenses: string;
    skills: Array<{ skill: string; proficiency: string }>;
    damageImmunities: string[];
    damageResistances: string[];
    damageVulnerabilities: string[];
    conditionImmunities: string[];
    languages: string[];
    languagesCustom: string;
    biography: string;
    sourceBook: string;
    sourcePage: string;
    sourceRules: string;
  }): Promise<any> {
    return this.actorCrud.createNpcActor(data);
  }

  // ---------------------------------------------------------------------------
  // Add weapon attack to an existing actor (dnd5e-add-attack-feature)
  // ---------------------------------------------------------------------------

  async addAttackToActor(data: any): Promise<any> {
    return this.actorMechanics.addAttackToActor(data);
  }

  // ---------------------------------------------------------------------------
  // Add automatic-damage aura/emanation feature to an existing actor
  // (dnd5e-add-aura-feature)
  // ---------------------------------------------------------------------------

  async addAuraToActor(data: any): Promise<any> {
    return this.actorMechanics.addAuraToActor(data);
  }

  // ---------------------------------------------------------------------------
  // Add passive/descriptive feature to an existing actor (dnd5e-add-passive-feature)
  // No activities, no mechanics — pure description displayed on the sheet.
  // ---------------------------------------------------------------------------

  async addPassiveFeatureToActor(data: any): Promise<any> {
    return this.actorMechanics.addPassiveFeatureToActor(data);
  }

  // ---------------------------------------------------------------------------
  // Add weapon attack + save effect to an existing actor
  // (dnd5e-add-attack-with-save) — Tipo B
  // Two activities: attack (sort:0) + save (sort:1)
  // ---------------------------------------------------------------------------

  async addAttackWithSaveToActor(data: any): Promise<any> {
    return this.actorMechanics.addAttackWithSaveToActor(data);
  }

  // ---------------------------------------------------------------------------
  // Set actor spellcasting (ability + slot counts)
  // ---------------------------------------------------------------------------

  async setActorSpellcasting(data: any): Promise<any> {
    return this.actorMechanics.setActorSpellcasting(data);
  }

  // ---------------------------------------------------------------------------
  // Add spells from compendium packs to an actor
  // ---------------------------------------------------------------------------

  async addSpellsToActor(data: any): Promise<any> {
    return this.actorMechanics.addSpellsToActor(data);
  }

  // ---------------------------------------------------------------------------
  // Add features from compendium packs to an actor
  // ---------------------------------------------------------------------------

  async addFeaturesFromCompendium(data: any): Promise<any> {
    return this.actorMechanics.addFeaturesFromCompendium(data);
  }

  /**
   * Create one or more actors of any type with arbitrary system data.
   * Works for any Foundry game system — types and system fields are not validated here.
   *
   * Delegates to actor-crud.ts. This delegation is PERMANENT: queries.ts reaches it.
   */
  async createActors(params: {
    actors: Array<{
      name: string;
      type: string;
      img?: string;
      system?: Record<string, any>;
    }>;
    folder?: string;
  }): Promise<{ created: Array<{ id: string; name: string; type: string }>; total: number }> {
    return this.actorCrud.createActors(params);
  }

  /**
   * Import full exported Actor documents. Unlike createActors (which builds a
   * blank actor from a splat), this reconstructs each actor verbatim from its
   * source document. Foundry's `Actor.create` natively creates the embedded
   * `items`, the `prototypeToken`, `img`, `system`, and `flags` from the source
   * data in one shot — nothing is re-mapped here.
   *
   * Each actor is placed in a name-resolved Actor folder (created on demand) and
   * stamped with `flags.wodchar.sourceId` for idempotency. Re-importing a doc
   * whose sourceId already exists is skipped, or (with `overwrite`) updated in
   * place: system/name/img/prototypeToken/flags are replaced and the embedded
   * items are re-created.
   */
  async importActors(params: {
    actors: Array<Record<string, any>>;
    folder?: string;
    overwrite?: boolean;
    /**
     * Resolve every doc against the existing actors' sourceIds and report the
     * verdict WITHOUT writing anything — no Actor.create, no update, and no
     * folder creation either (getOrCreateFolder writes, so dry runs only *look
     * up* folders). Verdicts are reported as would-create / would-update /
     * would-skip.
     */
    dryRun?: boolean;
    /**
     * `true` restores the historical abort-on-first-failure behaviour. Default
     * `false`: one bad document must not discard the outcomes already known for
     * the others (see the per-actor try/catch below).
     */
    stopOnError?: boolean;
  }): Promise<{
    results: Array<{
      name: string;
      id: string | null;
      status: string;
      folder: string | null;
      sourceId?: string | null;
      error?: string;
    }>;
    total: number;
    counts: {
      created: number;
      updated: number;
      skipped: number;
      failed: number;
      wouldCreate: number;
      wouldUpdate: number;
      wouldSkip: number;
    };
    dryRun?: boolean;
    aborted?: boolean;
  }> {
    const overwrite = params.overwrite === true;
    const dryRun = params.dryRun === true;
    const stopOnError = params.stopOnError === true;

    // Resolve/create each folder only once per import. Under dryRun we never
    // create — an absent folder resolves to null and the verdict still stands.
    const folderCache = new Map<string, string | null>();
    const resolveFolder = async (name: string): Promise<string | null> => {
      if (folderCache.has(name)) return folderCache.get(name)!;
      const id = dryRun
        ? ((game.folders as any)?.find((f: any) => f.name === name && f.type === 'Actor')?.id ??
          null)
        : await this.getOrCreateFolder(name, 'Actor');
      folderCache.set(name, id);
      return id;
    };

    // Locate an existing actor previously imported with the same sourceId.
    // Read the flag via RAW property access, never actor.getFlag('wodchar', …):
    // getFlag throws "Flag scope 'wodchar' is not valid or not currently active"
    // for any scope that isn't core / the system id / the world id / an active
    // module id. Foundry still stores arbitrary flag scopes as raw document data,
    // so we read it directly.
    const getProperty = (foundry as any)?.utils?.getProperty;
    const findBySourceId = (sourceId: string): any =>
      (game.actors as any)?.find((a: any) => {
        const flagVal = getProperty
          ? getProperty(a, 'flags.wodchar.sourceId')
          : a.flags?.wodchar?.sourceId;
        return flagVal && flagVal === sourceId;
      }) ?? null;

    const results: Array<{
      name: string;
      id: string | null;
      status: string;
      folder: string | null;
      sourceId?: string | null;
      error?: string;
    }> = [];

    let aborted = false;

    for (const src of params.actors) {
      // ─── Per-actor error capture ──────────────────────────────────────────
      // Everything from here to the end of the iteration is wrapped: a document
      // Foundry refuses, or one that fails validation, is recorded as
      // `status: 'failed'` with a reason and the batch CONTINUES. Previously a
      // throw from inside this loop propagated out of handleImportActors and
      // collapsed the whole call into a single error string, discarding the
      // outcomes of every actor already imported — including, on a timeout, the
      // actors that were really created (a timed-out query is not cancelled, so
      // they persist). `stopOnError: true` opts back into the old behaviour.
      const label = typeof src?.name === 'string' && src.name ? src.name : '(unnamed)';
      try {
        // Per-document validation lives HERE, not in a separate pre-flight loop
        // that aborts the batch, so an invalid doc costs exactly one entry.
        if (!src || typeof src !== 'object' || Array.isArray(src)) {
          throw new Error('actor document must be an object');
        }
        const missing = ['name', 'type', 'system'].filter(f => !(src as any)[f]);
        if (missing.length > 0) {
          throw new Error(`actor document is missing required field(s): ${missing.join(', ')}`);
        }

        // Shallow-clone so we can safely mutate folder/flags without touching the input.
        const doc: Record<string, any> = { ...src };

        // Idempotency key: an id already carried in the doc's flags, else an
        // out-of-band top-level `sourceId`.
        const flagSourceId =
          doc.flags?.wodchar?.sourceId ?? doc.flags?.['wod20-combat']?.sourceId ?? undefined;
        const sourceId: string | undefined = flagSourceId ?? doc.sourceId ?? undefined;
        delete doc.sourceId; // not a real Actor document field

        // Stamp the sourceId flag under a stable scope so re-imports can find it.
        //
        // RECONCILABILITY — this ordering is load-bearing. The flag is written
        // into `doc` BEFORE `Actor.create(doc)`, so the created actor carries its
        // sourceId atomically as part of its creation; there is no window in
        // which an actor exists un-stamped. That is what makes a retry of a
        // failed or timed-out batch safe: whatever the previous attempt created
        // is findable by findBySourceId and comes back skipped (or updated with
        // `overwrite`), never duplicated. Do NOT refactor this into a
        // post-create setFlag/update — a timeout between the two would leave an
        // invisible actor and the next retry would duplicate it.
        if (sourceId) {
          doc.flags = { ...(doc.flags ?? {}) };
          doc.flags.wodchar = { ...(doc.flags.wodchar ?? {}), sourceId };
        }

        // What the caller actually asked for — no default applied yet, because the
        // default is only correct when CREATING. Applying it unconditionally used to
        // clobber an existing actor's folder on every update that omitted `folder`,
        // silently relocating already-filed actors into "Foundry MCP Actors".
        const requestedFolderName: string | null = params.folder ?? doc.folderName ?? null;
        delete doc.folderName;

        // Look the actor up BEFORE deciding the folder: the decision depends on
        // whether this is a create or an update.
        const existing = sourceId ? findBySourceId(sourceId) : null;
        const existingFolderName: string | null = existing?.folder?.name ?? null;

        // A skip writes nothing, so settle it BEFORE resolving any folder —
        // `resolveFolder` calls getOrCreateFolder, which creates. The actor does not
        // move, so the folder it reports is the one it is already in.
        if (existing && !overwrite) {
          results.push({
            name: existing.name,
            id: existing.id,
            status: dryRun ? 'would-skip' : 'skipped',
            folder: existingFolderName,
            sourceId: sourceId ?? null,
          });
          continue;
        }

        // From here this operation intends to write (or, under dryRun, to predict
        // that write). The folder is computed ONCE so the dryRun verdict and the
        // write it predicts cannot disagree: an update with no explicit folder keeps
        // the actor where it is, a create falls back to the default.
        const effectiveFolderName: string | null = existing
          ? (requestedFolderName ?? existingFolderName)
          : (requestedFolderName ?? 'Foundry MCP Actors');

        // Only touch placement when the caller named a folder (or we are creating),
        // so an update that keeps its folder never reaches getOrCreateFolder.
        const willSetFolder = existing ? requestedFolderName !== null : true;
        const folderId =
          willSetFolder && effectiveFolderName ? await resolveFolder(effectiveFolderName) : null;
        if (!existing) {
          if (folderId) doc.folder = folderId;
          else delete doc.folder;
        }

        if (existing) {
          if (dryRun) {
            results.push({
              name: existing.name,
              id: existing.id,
              status: 'would-update',
              folder: effectiveFolderName,
              sourceId: sourceId ?? null,
            });
            continue;
          }

          // Update in place: replace the top-level document fields.
          const patch: Record<string, any> = { name: doc.name, system: doc.system };
          if (doc.img !== undefined) patch.img = doc.img;
          if (doc.prototypeToken !== undefined) patch.prototypeToken = doc.prototypeToken;
          if (doc.flags !== undefined) patch.flags = doc.flags;
          if (willSetFolder && folderId) patch.folder = folderId;
          await existing.update(patch);

          // Replace embedded items wholesale (delete then re-create from the doc).
          if (Array.isArray(doc.items)) {
            const existingItemIds = (existing.items as any)?.map((i: any) => i.id) ?? [];
            if (existingItemIds.length > 0) {
              await existing.deleteEmbeddedDocuments('Item', existingItemIds);
            }
            if (doc.items.length > 0) {
              await existing.createEmbeddedDocuments('Item', doc.items);
            }
          }

          results.push({
            name: existing.name,
            id: existing.id,
            status: 'updated',
            folder: effectiveFolderName,
            sourceId: sourceId ?? null,
          });
          continue;
        }

        if (dryRun) {
          results.push({
            name: doc.name,
            id: null,
            status: 'would-create',
            folder: effectiveFolderName,
            sourceId: sourceId ?? null,
            // An actor with no resolvable sourceId cannot be reconciled after a
            // failed run: a retry has no key to find it by and WILL duplicate it.
            // Surfaced rather than silently accepted.
            ...(sourceId ? {} : { error: 'no sourceId — a retry would duplicate this actor' }),
          });
          continue;
        }

        // Create verbatim — Actor.create builds embedded items + prototypeToken +
        // img + system + flags from the source data.
        const created = (await Actor.create(doc as any)) as any;
        if (!created) {
          throw new Error(`Foundry failed to create actor: ${doc.name}`);
        }
        results.push({
          name: created.name,
          id: created.id,
          status: 'created',
          folder: effectiveFolderName,
          sourceId: sourceId ?? null,
          ...(sourceId ? {} : { error: 'no sourceId — a retry would duplicate this actor' }),
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        results.push({
          name: label,
          id: null,
          status: 'failed',
          folder: null,
          sourceId: (src as any)?.flags?.wodchar?.sourceId ?? (src as any)?.sourceId ?? null,
          error: reason,
        });
        console.warn(`[${this.moduleId}] importActors: actor "${label}" failed: ${reason}`);
        if (stopOnError) {
          aborted = true;
          break;
        }
      }
    }

    const counts = {
      created: results.filter(r => r.status === 'created').length,
      updated: results.filter(r => r.status === 'updated').length,
      skipped: results.filter(r => r.status === 'skipped').length,
      failed: results.filter(r => r.status === 'failed').length,
      wouldCreate: results.filter(r => r.status === 'would-create').length,
      wouldUpdate: results.filter(r => r.status === 'would-update').length,
      wouldSkip: results.filter(r => r.status === 'would-skip').length,
    };

    return {
      results,
      total: results.length,
      counts,
      ...(dryRun ? { dryRun: true } : {}),
      ...(aborted ? { aborted: true } : {}),
    };
  }

  /**
   * Update one or more existing actors by ID.
   * Merges supplied fields into the actor (top-level keys overwrite).
   *
   * Delegates to actor-crud.ts. This delegation is PERMANENT: queries.ts reaches it.
   */
  async updateActors(
    updates: Array<{ id: string; name?: string; img?: string; system?: Record<string, any> }>
  ): Promise<{ updated: Array<{ id: string; name: string }>; total: number }> {
    return this.actorCrud.updateActors(updates);
  }

  /**
   * Update one or more items embedded in an actor.
   *
   * Delegates to actor-crud.ts. This delegation is PERMANENT: queries.ts reaches it.
   */
  async updateActorItems(
    actorIdentifier: string,
    itemUpdates: Array<{ id: string; name?: string; img?: string; system?: Record<string, any> }>
  ): Promise<{ updated: Array<{ id: string; name: string }>; total: number }> {
    return this.actorCrud.updateActorItems(actorIdentifier, itemUpdates);
  }

  /**
   * Delete one or more items embedded in an actor.
   *
   * Delegates to actor-crud.ts. This delegation is PERMANENT: queries.ts reaches it.
   */
  async deleteActorItems(
    actorIdentifier: string,
    itemIds: string[]
  ): Promise<{ deleted: string[]; total: number }> {
    return this.actorCrud.deleteActorItems(actorIdentifier, itemIds);
  }

  /**
   * Delete one or more actors by ID.
   *
   * Delegates to actor-crud.ts. This delegation is PERMANENT: queries.ts reaches it.
   */
  async deleteActors(ids: string[]): Promise<{ deleted: string[]; total: number }> {
    return this.actorCrud.deleteActors(ids);
  }
}
