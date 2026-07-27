import { MODULE_ID, ERROR_MESSAGES } from './constants.js';
import { permissionManager } from './permissions.js';
import { transactionManager } from './transaction-manager.js';
import { PersistentCreatureIndex } from './creature-index.js';
import { FoundrySecurity } from './security.js';
import { ActorResolver } from './actor-resolver.js';
import { JournalManager } from './journal-manager.js';
import { WorldItemsManager } from './world-items-manager.js';
import { ActorDirectory } from './actor-directory.js';
import { RollManager } from './roll-manager.js';
import { SceneTokenManager } from './scene-token-manager.js';
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

interface CompendiumSearchResult {
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
interface DnD5eCreatureIndex {
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
interface PF2eCreatureIndex {
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
interface CosmereRpgCreatureIndex {
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

interface MGT2eCreatureIndex {
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
type EnhancedCreatureIndex =
  | DnD5eCreatureIndex
  | PF2eCreatureIndex
  | CosmereRpgCreatureIndex
  | MGT2eCreatureIndex;

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

// Phase 2: Write Operation Interfaces
interface ActorCreationRequest {
  creatureType: string;
  customNames?: string[] | undefined;
  packPreference?: string | undefined;
  quantity?: number | undefined;
  addToScene?: boolean | undefined;
}

interface ActorCreationResult {
  success: boolean;
  actors: CreatedActorInfo[];
  errors?: string[] | undefined;
  tokensPlaced?: number;
  totalRequested: number;
  totalCreated: number;
}

interface CreatedActorInfo {
  id: string;
  name: string;
  originalName: string;
  type: string;
  sourcePackId: string;
  sourcePackLabel: string;
  img?: string;
}

interface CompendiumEntryFull {
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

interface CompendiumItem {
  id: string;
  name: string;
  type: string;
  img?: string;
  system: Record<string, unknown>;
}

interface CompendiumEffect {
  id: string;
  name: string;
  icon?: string;
  disabled: boolean;
  duration?: Record<string, unknown>;
}

interface SceneTokenPlacement {
  actorIds: string[];
  placement: 'random' | 'grid' | 'center' | 'coordinates';
  hidden: boolean;
  coordinates?: { x: number; y: number }[];
}

interface TokenPlacementResult {
  success: boolean;
  tokensCreated: number;
  tokenIds: string[];
  errors?: string[] | undefined;
}

export class FoundryDataAccess {
  private moduleId: string = MODULE_ID;
  private persistentIndex: PersistentCreatureIndex = new PersistentCreatureIndex();
  private security: FoundrySecurity = new FoundrySecurity();
  private actorResolver: ActorResolver = new ActorResolver();
  private journals: JournalManager = new JournalManager(this.security, this.actorResolver);
  private worldItems: WorldItemsManager = new WorldItemsManager(this.security);
  private actorDirectory: ActorDirectory = new ActorDirectory(this.security, this.actorResolver);
  private rollManager: RollManager = new RollManager(this.security);
  private sceneTokenManager: SceneTokenManager = new SceneTokenManager(this.security);

  constructor() {}

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
   * Check if entry passes all specified filters
   * @unused - Replaced with simple index-only approach
   */
  // @ts-ignore - Unused method kept for compatibility
  private passesFilters(
    entry: any,
    filters: {
      challengeRating?: number | { min?: number; max?: number };
      creatureType?: string;
      size?: string;
      alignment?: string;
      hasLegendaryActions?: boolean;
      spellcaster?: boolean;
    }
  ): boolean {
    const system = entry.system || {};

    // Challenge Rating filter
    if (filters.challengeRating !== undefined) {
      // Try multiple possible CR locations in D&D 5e data structure
      let entryCR =
        system.details?.cr?.value || system.details?.cr || system.cr?.value || system.cr || 0;

      // Handle fractional CRs (common in D&D 5e)
      if (typeof entryCR === 'string') {
        if (entryCR === '1/8') entryCR = 0.125;
        else if (entryCR === '1/4') entryCR = 0.25;
        else if (entryCR === '1/2') entryCR = 0.5;
        else entryCR = parseFloat(entryCR) || 0;
      }

      if (typeof filters.challengeRating === 'number') {
        // Exact CR match
        if (entryCR !== filters.challengeRating) {
          return false;
        }
      } else if (typeof filters.challengeRating === 'object') {
        // CR range
        const { min, max } = filters.challengeRating;
        if (min !== undefined && entryCR < min) {
          return false;
        }
        if (max !== undefined && entryCR > max) {
          return false;
        }
      }
    }

    // Creature Type filter
    if (filters.creatureType) {
      const entryType = system.details?.type?.value || system.type?.value || '';
      if (entryType.toLowerCase() !== filters.creatureType.toLowerCase()) {
        return false;
      }
    }

    // Size filter
    if (filters.size) {
      const entrySize = system.traits?.size || system.size || '';
      if (entrySize.toLowerCase() !== filters.size.toLowerCase()) {
        return false;
      }
    }

    // Alignment filter
    if (filters.alignment) {
      const entryAlignment = system.details?.alignment || system.alignment || '';
      if (!entryAlignment.toLowerCase().includes(filters.alignment.toLowerCase())) {
        return false;
      }
    }

    // Legendary Actions filter
    if (filters.hasLegendaryActions !== undefined) {
      const hasLegendary = !!(
        system.resources?.legact ||
        system.legendary ||
        (system.resources?.legres && system.resources.legres.value > 0)
      );
      if (hasLegendary !== filters.hasLegendaryActions) {
        return false;
      }
    }

    // Spellcaster filter
    if (filters.spellcaster !== undefined) {
      const isSpellcaster = !!(
        system.spells ||
        system.attributes?.spellcasting ||
        (system.details?.spellLevel && system.details.spellLevel > 0)
      );
      if (isSpellcaster !== filters.spellcaster) {
        return false;
      }
    }

    return true;
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
   * Prioritize compendium packs by likelihood of containing relevant creatures
   * @unused - Replaced by enhanced persistent index system
   */
  // @ts-ignore - Unused method kept for compatibility
  private prioritizePacksForCreatures(packs: any[]): any[] {
    const priorityOrder = [
      // Tier 1: Core D&D 5e content (highest priority)
      { pattern: /^dnd5e\.monsters/, priority: 100 }, // Core D&D 5e monsters
      { pattern: /^dnd5e\.actors/, priority: 95 }, // Core D&D 5e actors
      { pattern: /ddb.*monsters/i, priority: 90 }, // D&D Beyond monsters

      // Tier 2: Official modules and supplements
      { pattern: /^world\..*ddb.*monsters/i, priority: 85 }, // World-specific DDB monsters
      { pattern: /monsters/i, priority: 80 }, // Any pack with "monsters"

      // Tier 3: Campaign and adventure content
      { pattern: /^world\.(?!.*summon|.*hero)/i, priority: 70 }, // World packs (not summons/heroes)

      // Tier 4: Specialized content
      { pattern: /summon|familiar/i, priority: 40 }, // Summons and familiars

      // Tier 5: Unlikely to contain monsters (lowest priority)
      { pattern: /hero|player|pc/i, priority: 10 }, // Player characters
    ];

    return packs.sort((a, b) => {
      const aScore = this.getPackPriority(a.metadata.id, a.metadata.label, priorityOrder);
      const bScore = this.getPackPriority(b.metadata.id, b.metadata.label, priorityOrder);

      if (aScore !== bScore) {
        return bScore - aScore; // Higher score first
      }

      // Secondary sort by pack label alphabetically
      return a.metadata.label.localeCompare(b.metadata.label);
    });
  }

  /**
   * Get priority score for a pack based on ID and label
   */
  private getPackPriority(
    packId: string,
    packLabel: string,
    priorityOrder: { pattern: RegExp; priority: number }[]
  ): number {
    for (const rule of priorityOrder) {
      if (rule.pattern.test(packId) || rule.pattern.test(packLabel)) {
        return rule.priority;
      }
    }
    // Default priority for unmatched packs
    return 50;
  }

  /**
   * Check if creature entry passes the given criteria
   * @unused - Legacy method replaced by passesEnhancedCriteria
   */
  // @ts-ignore - Legacy method kept for compatibility
  private passesCriteria(
    entry: any,
    criteria: {
      challengeRating?: number | { min?: number; max?: number };
      creatureType?: string;
      size?: string;
      hasSpells?: boolean;
      hasLegendaryActions?: boolean;
    }
  ): boolean {
    const system = entry.system || {};

    // Challenge Rating filter - enhanced extraction
    if (criteria.challengeRating !== undefined) {
      // Try multiple possible CR locations in D&D 5e data structure
      let entryCR =
        system.details?.cr?.value || system.details?.cr || system.cr?.value || system.cr || 0;

      // Handle fractional CRs (common in D&D 5e)
      if (typeof entryCR === 'string') {
        if (entryCR === '1/8') entryCR = 0.125;
        else if (entryCR === '1/4') entryCR = 0.25;
        else if (entryCR === '1/2') entryCR = 0.5;
        else entryCR = parseFloat(entryCR) || 0;
      }

      if (typeof criteria.challengeRating === 'number') {
        if (entryCR !== criteria.challengeRating) {
          return false;
        }
      } else if (typeof criteria.challengeRating === 'object') {
        const { min = 0, max = 30 } = criteria.challengeRating;
        if (entryCR < min || entryCR > max) {
          return false;
        }
      }
    }

    // Creature Type filter - enhanced extraction
    if (criteria.creatureType) {
      // Try multiple possible type locations in D&D 5e data structure
      const entryType =
        system.details?.type?.value ||
        system.details?.type ||
        system.type?.value ||
        system.type ||
        '';
      if (entryType.toLowerCase() !== criteria.creatureType.toLowerCase()) {
        return false;
      }
    }

    // Size filter
    if (criteria.size) {
      const entrySize = system.traits?.size || system.size || '';
      if (entrySize.toLowerCase() !== criteria.size.toLowerCase()) return false;
    }

    // Spellcaster filter
    if (criteria.hasSpells !== undefined) {
      const isSpellcaster = !!(
        system.spells ||
        system.attributes?.spellcasting ||
        (system.details?.spellLevel && system.details.spellLevel > 0)
      );
      if (isSpellcaster !== criteria.hasSpells) return false;
    }

    // Legendary Actions filter
    if (criteria.hasLegendaryActions !== undefined) {
      const hasLegendary = !!(
        system.resources?.legact ||
        system.legendary ||
        (system.resources?.legres && system.resources.legres.value > 0)
      );
      if (hasLegendary !== criteria.hasLegendaryActions) return false;
    }

    return true;
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
    return Array.from(game.packs.values()).map(pack => ({
      id: pack.metadata.id,
      label: pack.metadata.label,
      type: pack.metadata.type,
      system: pack.metadata.system,
      private: pack.metadata.private,
    }));
  }

  /**
   * Sanitize data to remove sensitive information and make it JSON-safe
   */
  private sanitizeData(data: any): any {
    return this.security.sanitizeData(data);
  }

  /**
   * Validate that Foundry is ready and world is active
   */
  validateFoundryState(): void {
    return this.security.validateFoundryState();
  }

  /**
   * Audit log for write operations
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
   * Create actors from compendium entries with custom names
   */
  async createActorFromCompendium(request: ActorCreationRequest): Promise<ActorCreationResult> {
    this.validateFoundryState();

    // Use new permission system
    const permissionCheck = permissionManager.checkWritePermission('createActor', {
      quantity: request.quantity || 1,
    });

    if (!permissionCheck.allowed) {
      throw new Error(`${ERROR_MESSAGES.ACCESS_DENIED}: ${permissionCheck.reason}`);
    }

    // Audit the permission check
    permissionManager.auditPermissionCheck('createActor', permissionCheck, request);

    const maxActors = game.settings.get(this.moduleId, 'maxActorsPerRequest') as number;
    const quantity = Math.min(request.quantity || 1, maxActors);

    // Start transaction for rollback capability
    const transactionId = transactionManager.startTransaction(
      `Create ${quantity} actor(s) from compendium: ${request.creatureType}`
    );

    try {
      // Find matching compendium entry
      const compendiumEntry = await this.findBestCompendiumMatch(
        request.creatureType,
        request.packPreference
      );
      if (!compendiumEntry) {
        throw new Error(`No compendium entry found for "${request.creatureType}"`);
      }

      // Get full compendium document
      const sourceDoc = await this.getCompendiumDocumentFull(
        compendiumEntry.pack,
        compendiumEntry.id
      );

      const createdActors: CreatedActorInfo[] = [];
      const errors: string[] = [];

      // Create actors with custom names
      for (let i = 0; i < quantity; i++) {
        try {
          const customName =
            request.customNames?.[i] ||
            (quantity > 1 ? `${sourceDoc.name} ${i + 1}` : sourceDoc.name);

          const newActor = await this.createActorFromSource(sourceDoc, customName);

          // Track actor creation for rollback
          transactionManager.addAction(
            transactionId,
            transactionManager.createActorCreationAction(newActor.id)
          );

          createdActors.push({
            id: newActor.id,
            name: newActor.name,
            originalName: sourceDoc.name,
            type: newActor.type,
            sourcePackId: compendiumEntry.pack,
            sourcePackLabel: compendiumEntry.packLabel,
            img: newActor.img,
          });
        } catch (error) {
          errors.push(
            `Failed to create actor ${i + 1}: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
      }

      let tokensPlaced = 0;

      // Add to scene if requested and permission allows
      if (request.addToScene && createdActors.length > 0) {
        try {
          const scenePermissionCheck = permissionManager.checkWritePermission('modifyScene', {
            targetIds: createdActors.map(a => a.id),
          });

          if (!scenePermissionCheck.allowed) {
            errors.push(`Cannot add to scene: ${scenePermissionCheck.reason}`);
          } else {
            const tokenResult = await this.addActorsToScene(
              {
                actorIds: createdActors.map(a => a.id),
                placement: 'random',
                hidden: false,
              },
              transactionId
            );
            tokensPlaced = tokenResult.tokensCreated;
          }
        } catch (error) {
          errors.push(
            `Failed to add actors to scene: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
      }

      // If we had partial failure, decide whether to rollback
      if (errors.length > 0 && createdActors.length < quantity) {
        // Rollback if we failed to create more than half the requested actors
        if (createdActors.length < quantity / 2) {
          console.warn(
            `[${this.moduleId}] Rolling back due to significant failures (${createdActors.length}/${quantity} created)`
          );
          await transactionManager.rollbackTransaction(transactionId);
          throw new Error(`Actor creation failed: ${errors.join(', ')}`);
        }
      }

      // Commit transaction
      transactionManager.commitTransaction(transactionId);

      const result: ActorCreationResult = {
        success: createdActors.length > 0,
        actors: createdActors,
        ...(errors.length > 0 ? { errors } : {}),
        tokensPlaced,
        totalRequested: quantity,
        totalCreated: createdActors.length,
      };

      this.auditLog('createActorFromCompendium', request, 'success');
      return result;
    } catch (error) {
      // Rollback on complete failure
      try {
        await transactionManager.rollbackTransaction(transactionId);
      } catch (rollbackError) {
        console.error(`[${this.moduleId}] Failed to rollback transaction:`, rollbackError);
      }

      this.auditLog(
        'createActorFromCompendium',
        request,
        'failure',
        error instanceof Error ? error.message : 'Unknown error'
      );
      throw error;
    }
  }

  /**
   * Create actor from specific compendium entry using pack/item IDs
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
    this.validateFoundryState();

    try {
      const { packId, itemId, customNames, quantity = 1, addToScene = false, placement } = request;

      // Validate inputs
      if (!packId || !itemId) {
        throw new Error('Both packId and itemId are required');
      }

      // Get the pack
      const pack = game.packs.get(packId);
      if (!pack) {
        throw new Error(`Compendium pack "${packId}" not found`);
      }

      // Get the specific document
      const sourceDocument = await pack.getDocument(itemId);
      if (!sourceDocument) {
        throw new Error(`Document "${itemId}" not found in pack "${packId}"`);
      }

      // Validate that the document is an Actor (supports character, npc, creature, etc.)
      if (sourceDocument.documentName !== 'Actor') {
        throw new Error(
          `Document "${itemId}" is not an Actor (documentName: ${sourceDocument.documentName}, type: ${sourceDocument.type})`
        );
      }

      // Validate actor type - support all common actor types including DSA5 creatures
      // and Cosmere RPG adversaries.
      const validActorTypes = ['character', 'npc', 'creature', 'adversary'];
      if (!validActorTypes.includes(sourceDocument.type)) {
        throw new Error(
          `Document "${itemId}" has unsupported actor type: ${sourceDocument.type}. Supported types: ${validActorTypes.join(', ')}`
        );
      }

      const sourceActor = sourceDocument as Actor;

      // Prepare custom names
      const names = customNames.length > 0 ? customNames : [`${sourceActor.name} Copy`];
      const finalQuantity = Math.min(quantity, names.length);

      const createdActors: any[] = [];
      const errors: string[] = [];

      // Create actors
      for (let i = 0; i < finalQuantity; i++) {
        try {
          const customName = names[i] || `${sourceActor.name} ${i + 1}`;

          // Create actor data with full system, items, and effects
          const sourceData = sourceActor.toObject() as any;
          const actorData = {
            name: customName,
            type: sourceData.type,
            img: sourceData.img,
            system: sourceData.system || sourceData.data || {},
            items: sourceData.items || [],
            effects: sourceData.effects || [],
            folder: null, // Don't inherit folder
            prototypeToken: sourceData.prototypeToken, // Include prototype token
          };

          // Fix remote image URLs - normalize to local paths
          if (actorData.prototypeToken?.texture?.src?.startsWith('http')) {
            actorData.prototypeToken.texture.src = null; // Clear remote URL
          }

          // Organize created actors in a folder - use "Foundry MCP Creatures" for generic monsters
          const folderId = await this.getOrCreateFolder('Foundry MCP Creatures', 'Actor');
          if (folderId) {
            (actorData as any).folder = folderId;
          }

          // Create the actor
          const newActor = await Actor.create(actorData);
          if (!newActor) {
            throw new Error(`Failed to create actor "${customName}"`);
          }

          createdActors.push({
            id: newActor.id,
            name: newActor.name,
            originalName: sourceActor.name,
            sourcePackLabel: pack.metadata.label,
          });
        } catch (error) {
          const errorMsg = `Failed to create actor ${i + 1}: ${error instanceof Error ? error.message : 'Unknown error'}`;
          errors.push(errorMsg);
          console.error(`[${MODULE_ID}] ${errorMsg}`, error);
        }
      }

      // Add to scene if requested
      let tokensPlaced = 0;
      if (addToScene && createdActors.length > 0) {
        try {
          const sceneResult = await this.addActorsToScene({
            actorIds: createdActors.map(a => a.id),
            placement: placement?.type || 'grid',
            hidden: false,
            ...(placement?.coordinates && { coordinates: placement.coordinates }),
          });
          tokensPlaced = sceneResult.success ? sceneResult.tokensCreated : 0;
        } catch (error) {
          errors.push(
            `Failed to add actors to scene: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
      }

      const result: ActorCreationResult = {
        success: createdActors.length > 0,
        totalCreated: createdActors.length,
        totalRequested: finalQuantity,
        actors: createdActors,
        tokensPlaced,
        errors: errors.length > 0 ? errors : undefined,
      };

      this.auditLog('createActorFromCompendiumEntry', request, 'success');
      return result;
    } catch (error) {
      console.error(`[${MODULE_ID}] Failed to create actor from compendium entry`, error);
      this.auditLog(
        'createActorFromCompendiumEntry',
        request,
        'failure',
        error instanceof Error ? error.message : 'Unknown error'
      );
      throw error;
    }
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
    this.validateFoundryState();

    const { actorIdentifier, items } = params;

    if (!actorIdentifier) {
      throw new Error('actorIdentifier is required');
    }
    if (!Array.isArray(items) || items.length === 0) {
      throw new Error('items array is required and must contain at least one entry');
    }

    const actor = this.findActorByIdentifier(actorIdentifier);
    if (!actor) {
      throw new Error(`Actor not found: ${actorIdentifier}`);
    }

    // Discover the active system's declared Item types so we can give a
    // useful error before sending the doc to Foundry's DataModel layer.
    const itemDocTypes = (game as any).system?.documentTypes?.Item;
    const validTypes: string[] | null =
      itemDocTypes && typeof itemDocTypes === 'object' ? Object.keys(itemDocTypes) : null;

    const payload = items.map((it, idx) => {
      if (!it || typeof it.name !== 'string' || it.name.trim().length === 0) {
        throw new Error(`items[${idx}]: "name" is required and must be a non-empty string`);
      }
      if (typeof it.type !== 'string' || it.type.trim().length === 0) {
        throw new Error(`items[${idx}] ("${it.name}"): "type" is required`);
      }
      if (validTypes && !validTypes.includes(it.type)) {
        throw new Error(
          `items[${idx}] ("${it.name}"): unknown type "${it.type}" for system "${(game.system as any)?.id}". ` +
            `Valid Item types: ${validTypes.join(', ')}`
        );
      }

      const doc: Record<string, any> = { name: it.name, type: it.type };
      if (it.img) doc.img = it.img;
      if (it.system && typeof it.system === 'object') doc.system = it.system;
      return doc;
    });

    try {
      const created = await actor.createEmbeddedDocuments('Item', payload);

      const result = {
        actorId: actor.id,
        actorName: actor.name,
        created: (created || []).map((doc: any) => ({
          id: doc.id,
          name: doc.name,
          type: doc.type,
        })),
      };

      this.auditLog(
        'addActorItems',
        { actorIdentifier, actorId: actor.id, count: payload.length },
        'success'
      );
      return result;
    } catch (error) {
      this.auditLog(
        'addActorItems',
        { actorIdentifier, actorId: actor.id, count: payload.length },
        'failure',
        error instanceof Error ? error.message : 'Unknown error'
      );
      throw error;
    }
  }

  /**
   * Remove embedded Items from an existing Actor.
   *
   * Items can be named by id (exact, reliable) and/or by name (case-insensitive,
   * optionally constrained to a `type` to disambiguate). Names that match nothing
   * are reported back rather than silently ignored. This is the counterpart to
   * `addActorItems` — useful for clearing stray items added with the wrong type.
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
    this.validateFoundryState();

    const { actorIdentifier, itemIds, itemNames, type } = params;

    if (!actorIdentifier) {
      throw new Error('actorIdentifier is required');
    }
    const hasIds = Array.isArray(itemIds) && itemIds.length > 0;
    const hasNames = Array.isArray(itemNames) && itemNames.length > 0;
    if (!hasIds && !hasNames) {
      throw new Error('Provide itemIds and/or itemNames identifying the items to remove');
    }

    const actor = this.findActorByIdentifier(actorIdentifier);
    if (!actor) {
      throw new Error(`Actor not found: ${actorIdentifier}`);
    }

    const typeLower = type?.toLowerCase();
    const toDelete = new Map<string, any>(); // id -> item (dedupes overlap)
    const notFound: string[] = [];

    if (hasIds) {
      for (const id of itemIds) {
        const item = actor.items.get(id);
        if (item) toDelete.set(item.id, item);
        else notFound.push(id);
      }
    }
    if (hasNames) {
      for (const name of itemNames) {
        const nameLower = name.toLowerCase();
        const item = actor.items.find(
          (i: any) => i.name?.toLowerCase() === nameLower && (!typeLower || i.type === typeLower)
        );
        if (item) toDelete.set(item.id, item);
        else notFound.push(name);
      }
    }

    if (toDelete.size === 0) {
      return { actorId: actor.id, actorName: actor.name, removed: [], notFound };
    }

    const removed = Array.from(toDelete.values()).map((i: any) => ({
      id: i.id,
      name: i.name,
      type: i.type,
    }));

    try {
      await actor.deleteEmbeddedDocuments(
        'Item',
        removed.map(r => r.id)
      );
      this.auditLog(
        'removeActorItems',
        { actorIdentifier, actorId: actor.id, count: removed.length },
        'success'
      );
      return { actorId: actor.id, actorName: actor.name, removed, notFound };
    } catch (error) {
      this.auditLog(
        'removeActorItems',
        { actorIdentifier, actorId: actor.id, count: removed.length },
        'failure',
        error instanceof Error ? error.message : 'Unknown error'
      );
      throw error;
    }
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
      system: this.sanitizeData((document as any).system || {}),
      fullData: this.sanitizeData(document.toObject()),
    };

    // Add items if the actor has them
    if ((document as any).items) {
      fullEntry.items = (document as any).items.map((item: any) => ({
        id: item.id,
        name: item.name,
        type: item.type,
        img: item.img || undefined,
        system: this.sanitizeData(item.system || {}),
      }));
    }

    // Add effects if the actor has them
    if ((document as any).effects) {
      fullEntry.effects = (document as any).effects.map((effect: any) => ({
        id: effect.id,
        name: effect.name || effect.label || 'Unknown Effect',
        icon: effect.icon || undefined,
        disabled: effect.disabled || false,
        duration: this.sanitizeData(effect.duration || {}),
      }));
    }

    return fullEntry;
  }

  /**
   * Add actors to the current scene as tokens
   */
  async addActorsToScene(
    placement: SceneTokenPlacement,
    transactionId?: string
  ): Promise<TokenPlacementResult> {
    this.validateFoundryState();

    // Use new permission system
    const permissionCheck = permissionManager.checkWritePermission('modifyScene', {
      targetIds: placement.actorIds,
    });

    if (!permissionCheck.allowed) {
      throw new Error(`${ERROR_MESSAGES.ACCESS_DENIED}: ${permissionCheck.reason}`);
    }

    // Audit the permission check
    permissionManager.auditPermissionCheck('modifyScene', permissionCheck, placement);

    const scene = (game.scenes as any).current;
    if (!scene) {
      throw new Error('No active scene found');
    }

    this.auditLog('addActorsToScene', placement, 'success');

    try {
      const tokenData: any[] = [];
      const errors: string[] = [];

      for (const actorId of placement.actorIds) {
        try {
          const actor = game.actors.get(actorId);
          if (!actor) {
            errors.push(`Actor ${actorId} not found`);
            continue;
          }

          const tokenDoc = (actor as any).prototypeToken.toObject();
          const position = this.calculateTokenPosition(
            placement.placement,
            scene,
            tokenData.length,
            placement.coordinates
          );

          // Fix token texture if it's still a remote URL (Foundry may have overridden our actor creation fix)
          if (tokenDoc.texture?.src?.startsWith('http')) {
            console.error(
              `[${this.moduleId}] Token texture still has remote URL, clearing: ${tokenDoc.texture.src}`
            );
            tokenDoc.texture.src = null; // Use Foundry's fallback
          } else {
          }

          tokenData.push({
            ...tokenDoc,
            x: position.x,
            y: position.y,
            actorId,
            hidden: placement.hidden,
          });
        } catch (error) {
          errors.push(
            `Failed to prepare token for actor ${actorId}: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
      }

      const createdTokens = await scene.createEmbeddedDocuments('Token', tokenData);

      // Track token creation for rollback if transaction is active
      if (transactionId && createdTokens.length > 0) {
        for (const token of createdTokens) {
          transactionManager.addAction(
            transactionId,
            transactionManager.createTokenCreationAction(token.id)
          );
        }
      }

      const result: TokenPlacementResult = {
        success: createdTokens.length > 0,
        tokensCreated: createdTokens.length,
        tokenIds: createdTokens.map((token: any) => token.id),
        ...(errors.length > 0 ? { errors } : {}),
      };

      this.auditLog('addActorsToScene', placement, 'success');
      return result;
    } catch (error) {
      this.auditLog(
        'addActorsToScene',
        placement,
        'failure',
        error instanceof Error ? error.message : 'Unknown error'
      );
      throw error;
    }
  }

  /**
   * Find best matching compendium entry for creature type
   */
  private async findBestCompendiumMatch(
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
   * Create actor from source document with custom name
   */
  private async createActorFromSource(
    sourceDoc: CompendiumEntryFull,
    customName: string
  ): Promise<any> {
    try {
      // Clone the source data
      const actorData = foundry.utils.deepClone(sourceDoc.fullData) as any;

      // Apply customizations
      actorData.name = customName;

      // Fix only token texture - leave portrait (actor.img) alone
      if (actorData.prototypeToken?.texture?.src?.startsWith('http')) {
        console.error(
          `[${this.moduleId}] Removing remote token texture URL: ${actorData.prototypeToken.texture.src}`
        );
        actorData.prototypeToken.texture.src = null; // Let Foundry use fallback
      }

      // Remove source-specific identifiers
      delete actorData._id;
      delete actorData.folder;
      delete actorData.sort;

      // Ensure required fields are present
      if (!actorData.name) actorData.name = customName;
      if (!actorData.type) actorData.type = sourceDoc.type || 'npc';

      // Organize created actors in a folder - use "Foundry MCP Creatures" for generic monsters
      const folderId = await this.getOrCreateFolder('Foundry MCP Creatures', 'Actor');
      if (folderId) {
        actorData.folder = folderId;
      }

      // Create the new actor
      const createdDocs = await Actor.createDocuments([actorData]);
      if (!createdDocs || createdDocs.length === 0) {
        throw new Error('Failed to create actor document');
      }

      return createdDocs[0];
    } catch (error) {
      console.error(`[${this.moduleId}] Actor creation failed:`, error);
      throw error;
    }
  }

  /**
   * Calculate token position based on placement strategy
   */
  private calculateTokenPosition(
    placement: 'random' | 'grid' | 'center' | 'coordinates',
    scene: any,
    index: number,
    coordinates?: { x: number; y: number }[]
  ): { x: number; y: number } {
    const gridSize = scene.grid?.size || 100;

    switch (placement) {
      case 'coordinates':
        if (coordinates?.[index]) {
          return coordinates[index];
        }
        // Fallback to grid if coordinates not provided or insufficient
        const fallbackCols = Math.ceil(Math.sqrt(index + 1));
        const fallbackRow = Math.floor(index / fallbackCols);
        const fallbackCol = index % fallbackCols;
        return {
          x: gridSize + fallbackCol * gridSize * 2,
          y: gridSize + fallbackRow * gridSize * 2,
        };

      case 'center':
        return {
          x: scene.width / 2 + index * gridSize,
          y: scene.height / 2,
        };

      case 'grid':
        const cols = Math.ceil(Math.sqrt(index + 1));
        const row = Math.floor(index / cols);
        const col = index % cols;
        return {
          x: gridSize + col * gridSize * 2,
          y: gridSize + row * gridSize * 2,
        };

      case 'random':
      default:
        return {
          x: Math.random() * (scene.width - gridSize),
          y: Math.random() * (scene.height - gridSize),
        };
    }
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
    this.validateFoundryState();

    // Get the enhanced creature index (builds if needed)
    const enhancedCreatures = await this.persistentIndex.getEnhancedIndex();

    return enhancedCreatures || [];
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
   */
  async setActorOwnership(data: {
    actorId: string;
    userId: string;
    permission: number;
  }): Promise<{ success: boolean; message: string; error?: string }> {
    this.validateFoundryState();

    try {
      const actor = game.actors?.get(data.actorId);
      if (!actor) {
        return { success: false, error: `Actor not found: ${data.actorId}`, message: '' };
      }

      const user = game.users?.get(data.userId);
      if (!user) {
        return { success: false, error: `User not found: ${data.userId}`, message: '' };
      }

      // Get current ownership
      const currentOwnership = (actor as any).ownership || {};
      const newOwnership = { ...currentOwnership };

      // Set the new permission level
      newOwnership[data.userId] = data.permission;

      // Update the actor
      await actor.update({ ownership: newOwnership });

      const permissionNames = { 0: 'NONE', 1: 'LIMITED', 2: 'OBSERVER', 3: 'OWNER' };
      const permissionName =
        permissionNames[data.permission as keyof typeof permissionNames] ||
        data.permission.toString();

      return {
        success: true,
        message: `Set ${actor.name} ownership to ${permissionName} for ${user.name}`,
      };
    } catch (error) {
      console.error(`[${MODULE_ID}] Error setting actor ownership:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        message: '',
      };
    }
  }

  /**
   * Update a WFRP4e actor's stat block (characteristics and/or wounds).
   * Writes initial/advances/modifier and wounds value/max; WFRP4e recomputes
   * the derived characteristic value/bonus on update.
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
    this.validateFoundryState();

    const systemId = (game.system as any).id;
    if (systemId !== 'wfrp4e') {
      return {
        success: false,
        error: `wfrp4e-update-actor requires the WFRP4e system (current: "${systemId}")`,
      };
    }

    // Resolve a world actor by id/name, or a scene token by id (an unlinked
    // token resolves to its own synthetic actor — see findActorByIdentifier).
    const actor = this.findActorByIdentifier(data.actor);
    if (!actor) {
      return { success: false, error: `Actor not found: ${data.actor}` };
    }

    const CHAR_KEYS = ['ws', 'bs', 's', 't', 'i', 'ag', 'dex', 'int', 'wp', 'fel'];
    const FIELDS = ['initial', 'advances', 'modifier'] as const;
    const sys = actor.system || {};
    const update: Record<string, any> = {};
    const itemUpdates: Array<Record<string, any>> = [];
    const applied: {
      characteristics: Record<string, any>;
      wounds: Record<string, any>;
      skills: Record<string, any>;
      career?: string;
      details?: Record<string, any>;
    } = {
      characteristics: {},
      wounds: {},
      skills: {},
    };
    const warnings: string[] = [];

    if (data.characteristics) {
      for (const [rawKey, fields] of Object.entries(data.characteristics)) {
        const key = rawKey.toLowerCase();
        if (!CHAR_KEYS.includes(key)) {
          warnings.push(`Unknown characteristic "${rawKey}" — skipped`);
          continue;
        }
        const current = sys.characteristics?.[key] || {};
        const record: Record<string, any> = {};
        for (const field of FIELDS) {
          const val = (fields as any)[field];
          if (val !== undefined) {
            update[`system.characteristics.${key}.${field}`] = val;
            record[field] = { from: current[field], to: val };
          }
        }
        if (Object.keys(record).length > 0) {
          applied.characteristics[key.toUpperCase()] = record;
        }
      }
    }

    if (data.wounds) {
      const current = sys.status?.wounds || {};
      if (data.wounds.value !== undefined) {
        update['system.status.wounds.value'] = data.wounds.value;
        applied.wounds.value = { from: current.value, to: data.wounds.value };
      }
      if (data.wounds.max !== undefined) {
        update['system.status.wounds.max'] = data.wounds.max;
        applied.wounds.max = { from: current.max, to: data.wounds.max };
      }
    }

    // Detail fields: base movement and the biography/notes text.
    if (data.movement !== undefined) {
      update['system.details.move.value'] = data.movement;
      applied.details = applied.details || {};
      applied.details.movement = { from: sys.details?.move?.value, to: data.movement };
    }
    if (data.biography !== undefined) {
      update['system.details.biography.value'] = data.biography;
      applied.details = applied.details || {};
      applied.details.biography = { chars: data.biography.length };
    }

    // Existing embedded-item edits: bump advances on skills the actor already
    // has, and/or switch which career item is current. (Adding new skills or
    // careers is wfrp4e-add-items' job.)
    if (Array.isArray(data.skills)) {
      for (const s of data.skills) {
        const item = actor.items.find(
          (i: any) => i.type === 'skill' && i.name?.toLowerCase() === s.name.toLowerCase()
        );
        if (!item) {
          warnings.push(`Skill "${s.name}" not on ${actor.name} — use wfrp4e-add-items to add it.`);
          continue;
        }
        itemUpdates.push({ _id: item.id, 'system.advances.value': s.advances });
        applied.skills[item.name] = {
          advances: { from: item.system?.advances?.value, to: s.advances },
        };
      }
    }

    if (data.career) {
      const target = actor.items.find(
        (i: any) => i.type === 'career' && i.name?.toLowerCase() === data.career?.toLowerCase()
      );
      if (!target) {
        warnings.push(
          `Career "${data.career}" not on ${actor.name} — use wfrp4e-add-items to add it.`
        );
      } else {
        // Exactly one career is current; flip the target on and the rest off.
        for (const it of actor.items) {
          if (it.type === 'career') {
            itemUpdates.push({ _id: it.id, 'system.current.value': it.id === target.id });
          }
        }
        applied.career = target.name;
      }
    }

    if (Object.keys(update).length === 0 && itemUpdates.length === 0) {
      return {
        success: false,
        error: 'No valid fields to update.',
        ...(warnings.length ? { warnings } : {}),
      };
    }

    try {
      if (Object.keys(update).length > 0) {
        await actor.update(update);
      }
      if (itemUpdates.length > 0) {
        await actor.updateEmbeddedDocuments('Item', itemUpdates);
      }
    } catch (error) {
      console.error(`[${MODULE_ID}] Error updating WFRP4e actor:`, error);
      this.auditLog(
        'updateWfrp4eActor',
        { actor: data.actor },
        'failure',
        error instanceof Error ? error.message : 'Unknown error'
      );
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }

    // Read back recomputed characteristic totals as confirmation.
    const after = actor.system || {};
    const newTotals: Record<string, any> = {};
    for (const key of CHAR_KEYS) {
      if (applied.characteristics[key.toUpperCase()]) {
        const c = after.characteristics?.[key];
        if (c) newTotals[key.toUpperCase()] = { total: c.value, bonus: c.bonus };
      }
    }

    this.auditLog('updateWfrp4eActor', { actor: data.actor }, 'success');

    return {
      success: true,
      actor: actor.name,
      id: actor.id,
      applied,
      newCharacteristicTotals: newTotals,
      ...(warnings.length ? { warnings } : {}),
    };
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
    this.validateFoundryState();

    const systemId = (game.system as any).id;
    if (systemId !== 'wfrp4e') {
      return {
        success: false,
        error: `wfrp4e-add-items requires the WFRP4e system (current: "${systemId}")`,
      };
    }

    if (!Array.isArray(data.items) || data.items.length === 0) {
      return {
        success: false,
        error: 'items array is required and must contain at least one entry',
      };
    }

    const actor = this.findActorByIdentifier(data.actor);
    if (!actor) {
      return { success: false, error: `Actor not found: ${data.actor}` };
    }

    // Candidate Item packs, Core Rulebook first so a name shared across books
    // resolves to the canonical entry.
    const itemPacks: any[] = Array.from((game.packs as any) || []).filter(
      (p: any) => (p.metadata?.type ?? p.documentName) === 'Item'
    );
    itemPacks.sort((a: any, b: any) => {
      const rank = (p: any) => (String(p.metadata?.id || '').startsWith('wfrp4e-core') ? 0 : 1);
      return rank(a) - rank(b);
    });

    // Per-call index cache — each pack's index is loaded at most once.
    const indexCache = new Map<string, any>();
    const getIndex = async (pack: any) => {
      const id = pack.metadata.id;
      if (!indexCache.has(id)) indexCache.set(id, await pack.getIndex());
      return indexCache.get(id);
    };

    const warnings: string[] = [];
    const notFound: string[] = [];
    const ambiguous: Array<{ name: string; candidates: Array<{ pack: string; type: string }> }> =
      [];

    // Skill advances and gear quantity are baked into each item's creation data
    // (below) rather than patched afterwards, because createEmbeddedDocuments
    // does not guarantee it returns documents in the order we send them — so
    // positional alignment between the created docs and our requests is unsafe.
    const GEAR_TYPES = new Set([
      'weapon',
      'armour',
      'trapping',
      'ammunition',
      'container',
      'money',
      'cargo',
    ]);
    const applyExtras = (obj: Record<string, any>, type: string, req: any): void => {
      obj.system = obj.system || {};
      if (req.advances !== undefined && type === 'skill') {
        obj.system.advances = { ...(obj.system.advances || {}), value: req.advances };
      }
      if (req.quantity !== undefined && GEAR_TYPES.has(type)) {
        obj.system.quantity = { ...(obj.system.quantity || {}), value: req.quantity };
      }
    };

    const toCreate: Array<Record<string, any>> = [];
    // Keyed by `${type}::${name}` (the created doc's own name/type) so we can
    // match created documents back to their request without relying on order.
    const plan: Array<{
      nameLower: string;
      type: string;
      setCurrent: boolean | undefined;
      source: string;
    }> = [];

    // Find every compendium entry whose name (and optional type) matches, across
    // the candidate packs (their core-first order is preserved in the result).
    const findMatches = async (
      packs: any[],
      searchName: string,
      typeConstraint: string | undefined
    ): Promise<Array<{ packId: string; packLabel: string; entryId: string; type: string }>> => {
      const found: Array<{ packId: string; packLabel: string; entryId: string; type: string }> = [];
      for (const pack of packs) {
        const index = await getIndex(pack);
        for (const entry of index) {
          if (
            entry.name?.toLowerCase() === searchName &&
            (!typeConstraint || entry.type === typeConstraint)
          ) {
            found.push({
              packId: pack.metadata.id,
              packLabel: pack.metadata.label,
              entryId: entry._id,
              type: entry.type,
            });
          }
        }
      }
      return found;
    };

    for (const req of data.items) {
      const nameLower = req.name.toLowerCase();
      const typeWanted = req.type?.toLowerCase();
      const searchPacks = req.pack
        ? itemPacks.filter(
            (p: any) => p.metadata.id === req.pack || p.metadata.id.includes(req.pack as string)
          )
        : itemPacks;

      let matches = await findMatches(searchPacks, nameLower, typeWanted);

      // Grouped-skill fallback: a specialisation like "Entertain (Taunt)" often
      // has no dedicated entry, but the group's generic template "Entertain ()"
      // does — copy that (it carries the correct characteristic and grouping)
      // and rename the copy to the requested specialisation.
      let nameOverride: string | undefined;
      let templated = false;
      if (matches.length === 0 && (typeWanted === undefined || typeWanted === 'skill')) {
        const grouped = /^\s*(.+?)\s*\([^)]+\)\s*$/.exec(req.name);
        if (grouped) {
          const templateName = `${grouped[1]} ()`.toLowerCase();
          const templateMatches = await findMatches(searchPacks, templateName, 'skill');
          if (templateMatches.length > 0) {
            matches = templateMatches;
            nameOverride = req.name.trim();
            templated = true;
          }
        }
      }

      if (matches.length === 0) {
        const fallbackType = typeWanted || 'trapping';
        const obj: Record<string, any> = { name: req.name, type: fallbackType, system: {} };
        applyExtras(obj, fallbackType, req);
        toCreate.push(obj);
        plan.push({
          nameLower,
          type: fallbackType,
          setCurrent: req.setCurrent,
          source: 'custom (not in compendium)',
        });
        notFound.push(req.name);
        warnings.push(
          `"${req.name}" not found in any WFRP4e compendium — added as a blank ${fallbackType}.`
        );
        continue;
      }

      // Several distinct item types share this name and the caller didn't pick
      // one — don't guess.
      const distinctTypes = [...new Set(matches.map(m => m.type))];
      if (!typeWanted && distinctTypes.length > 1) {
        ambiguous.push({
          name: req.name,
          candidates: matches.map(m => ({ pack: m.packId, type: m.type })),
        });
        warnings.push(
          `"${req.name}" matches multiple item types (${distinctTypes.join(', ')}); pass "type" to choose — skipped.`
        );
        continue;
      }

      // matches preserves the core-first pack order, so [0] is the best source.
      const chosen = matches[0];
      const pack = (game.packs as any).get(chosen.packId);
      const sourceDoc = await pack.getDocument(chosen.entryId);
      const obj = sourceDoc.toObject();
      const finalName = nameOverride ?? obj.name;
      const clean: Record<string, any> = {
        name: finalName,
        type: obj.type,
        img: obj.img,
        system: obj.system || {},
        effects: obj.effects || [],
        flags: obj.flags || {},
      };
      applyExtras(clean, obj.type, req);
      toCreate.push(clean);
      plan.push({
        nameLower: String(finalName).toLowerCase(),
        type: obj.type,
        setCurrent: req.setCurrent,
        source: templated ? `${chosen.packLabel} (grouped template)` : chosen.packLabel,
      });
    }

    if (toCreate.length === 0) {
      return {
        success: false,
        error: 'No items could be added.',
        ...(notFound.length ? { notFound } : {}),
        ...(ambiguous.length ? { ambiguous } : {}),
        ...(warnings.length ? { warnings } : {}),
      };
    }

    let created: any[] = [];
    try {
      created = (await actor.createEmbeddedDocuments('Item', toCreate)) || [];

      // Make a career current if requested. Match the created career by NAME,
      // not by position (see the ordering note above). Exactly one career is
      // current, so flip the target on and every other career off.
      const setCurrentNames = new Set(
        plan.filter(p => p.setCurrent && p.type === 'career').map(p => p.nameLower)
      );
      if (setCurrentNames.size > 0) {
        let targetId: string | undefined;
        for (const doc of created) {
          if (doc.type === 'career' && setCurrentNames.has(String(doc.name).toLowerCase())) {
            targetId = doc.id;
          }
        }
        if (targetId) {
          const careerUpdates: Array<Record<string, any>> = [];
          for (const it of actor.items) {
            if (it.type === 'career') {
              careerUpdates.push({ _id: it.id, 'system.current.value': it.id === targetId });
            }
          }
          if (careerUpdates.length > 0) {
            await actor.updateEmbeddedDocuments('Item', careerUpdates);
          }
        }
      }
    } catch (error) {
      console.error(`[${MODULE_ID}] Error adding WFRP4e items:`, error);
      this.auditLog(
        'addWfrp4eItems',
        { actor: data.actor, count: toCreate.length },
        'failure',
        error instanceof Error ? error.message : 'Unknown error'
      );
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }

    // Summarise, reading back derived skill totals / career state as confirmation.
    // Source is looked up by name+type (order-independent).
    const sourceByKey = new Map<string, string>();
    for (const p of plan) sourceByKey.set(`${p.type}::${p.nameLower}`, p.source);

    const createdSummary = created.map((doc: any) => {
      const after = actor.items.get(doc.id);
      const entry: Record<string, any> = {
        id: doc.id,
        name: doc.name,
        type: doc.type,
        source: sourceByKey.get(`${doc.type}::${String(doc.name).toLowerCase()}`) ?? 'unknown',
      };
      if (after?.type === 'skill') {
        entry.advances = after.system?.advances?.value;
        entry.total = after.system?.total?.value;
        entry.characteristic = after.system?.characteristic?.value;
      }
      if (after?.type === 'career') entry.current = after.system?.current?.value ?? false;
      return entry;
    });

    this.auditLog('addWfrp4eItems', { actor: data.actor, count: created.length }, 'success');

    return {
      success: true,
      actor: actor.name,
      id: actor.id,
      created: createdSummary,
      ...(notFound.length ? { notFound } : {}),
      ...(ambiguous.length ? { ambiguous } : {}),
      ...(warnings.length ? { warnings } : {}),
    };
  }

  /**
   * Get actor ownership information
   */
  async getActorOwnership(data: {
    actorIdentifier?: string;
    playerIdentifier?: string;
  }): Promise<any> {
    this.validateFoundryState();

    try {
      const actors = data.actorIdentifier
        ? data.actorIdentifier === 'all'
          ? Array.from(game.actors || [])
          : [this.findActorByIdentifier(data.actorIdentifier)].filter(Boolean)
        : Array.from(game.actors || []);

      const users = data.playerIdentifier
        ? [
            game.users?.getName(data.playerIdentifier) || game.users?.get(data.playerIdentifier),
          ].filter(Boolean)
        : Array.from(game.users || []);

      const ownershipInfo = [];
      const permissionNames = { 0: 'NONE', 1: 'LIMITED', 2: 'OBSERVER', 3: 'OWNER' };

      for (const actor of actors) {
        const actorInfo: any = {
          id: actor.id,
          name: actor.name,
          type: actor.type,
          ownership: [],
        };

        for (const user of users.filter(u => u && !u.isGM)) {
          const permission = actor.testUserPermission(user, 'OWNER')
            ? 3
            : actor.testUserPermission(user, 'OBSERVER')
              ? 2
              : actor.testUserPermission(user, 'LIMITED')
                ? 1
                : 0;

          actorInfo.ownership.push({
            userId: user!.id,
            userName: user!.name,
            permission: permissionNames[permission as keyof typeof permissionNames],
            numericPermission: permission,
          });
        }

        ownershipInfo.push(actorInfo);
      }

      return ownershipInfo;
    } catch (error) {
      console.error(`[${MODULE_ID}] Error getting actor ownership:`, error);
      throw error;
    }
  }

  /**
   * Find actor by name or ID
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
    this.validateFoundryState();

    const { actorIdentifier, itemIdentifier, targets, options = {} } = params;

    // Find the actor
    const actor = this.findActorByIdentifier(actorIdentifier);
    if (!actor) {
      throw new Error(`Actor not found: ${actorIdentifier}`);
    }

    // Find the item on the actor
    const item = actor.items.find(
      (i: any) => i.id === itemIdentifier || i.name.toLowerCase() === itemIdentifier.toLowerCase()
    );

    if (!item) {
      throw new Error(`Item "${itemIdentifier}" not found on actor "${actor.name}"`);
    }

    const itemAny = item;
    const systemId = (game.system as any).id;

    // Handle targeting if targets are specified
    const resolvedTargetNames: string[] = [];
    if (targets && targets.length > 0) {
      // Get all tokens on the current scene
      const scene = (game.scenes as any)?.active;
      if (!scene) {
        throw new Error('No active scene to find targets on');
      }

      const sceneTokens = scene.tokens;
      const tokenIds: string[] = [];

      for (const targetIdentifier of targets) {
        // Handle "self" - target the caster's token
        if (targetIdentifier.toLowerCase() === 'self') {
          // Find token for the caster actor
          const selfToken = sceneTokens.find(
            (t: any) => t.actor?.id === actor.id || t.actorId === actor.id
          );
          if (selfToken) {
            tokenIds.push(selfToken.id);
            resolvedTargetNames.push(actor.name);
          } else {
            console.warn(
              `[foundry-mcp-bridge] No token found on scene for actor "${actor.name}" (self)`
            );
          }
          continue;
        }

        // Find token by name or ID
        const targetToken = sceneTokens.find(
          (t: any) =>
            t.id === targetIdentifier ||
            t.name?.toLowerCase() === targetIdentifier.toLowerCase() ||
            t.actor?.name?.toLowerCase() === targetIdentifier.toLowerCase()
        );

        if (targetToken) {
          tokenIds.push(targetToken.id);
          resolvedTargetNames.push(targetToken.name || targetToken.actor?.name || targetIdentifier);
        } else {
          console.warn(`[foundry-mcp-bridge] Target not found: "${targetIdentifier}"`);
        }
      }

      // Set targets using Foundry's targeting system
      if (tokenIds.length > 0 && game.user) {
        await (game.user as any).updateTokenTargets(tokenIds);
        console.log(`[foundry-mcp-bridge] Set targets: ${resolvedTargetNames.join(', ')}`);
      }
    }

    try {
      // For items that may show dialogs (spells with choices, etc.),
      // we fire-and-forget to avoid timeout issues. The GM will interact
      // with the dialog in Foundry, and the result appears in chat.

      // Check if item has a use() method (common in D&D 5e, PF2e)
      if (typeof itemAny.use === 'function') {
        // D&D 5e and similar systems
        // Only pass options that D&D 5e's item.use() expects
        const useOptions: Record<string, any> = {
          createMessage: true,
        };

        // D&D 5e specific options
        if (systemId === 'dnd5e') {
          useOptions.consumeResource = options.consume ?? true;
          useOptions.consumeSpellSlot = options.consume ?? true;
          useOptions.consumeUsage = options.consume ?? true;
          // Always show dialog so GM can make choices
          useOptions.configureDialog = true;
        }

        // Spell level for upcasting
        if (options.spellLevel !== undefined) {
          useOptions.slotLevel = options.spellLevel; // D&D 5e
          useOptions.level = options.spellLevel; // generic
        }

        // Fire and forget - don't await, as dialogs block the promise
        itemAny.use(useOptions).catch((err: Error) => {
          console.error(`[foundry-mcp-bridge] Error using item ${item.name}:`, err);
        });
      } else if (typeof itemAny.toChat === 'function') {
        // PF2e and some other systems use toChat
        if (typeof itemAny.toMessage === 'function') {
          itemAny.toMessage(undefined, { create: true }).catch((err: Error) => {
            console.error(`[foundry-mcp-bridge] Error using item ${item.name}:`, err);
          });
        } else {
          itemAny.toChat().catch((err: Error) => {
            console.error(`[foundry-mcp-bridge] Error using item ${item.name}:`, err);
          });
        }
      } else if (typeof itemAny.roll === 'function') {
        // Some items have a roll method
        itemAny.roll().catch((err: Error) => {
          console.error(`[foundry-mcp-bridge] Error using item ${item.name}:`, err);
        });
      } else if (systemId === 'dsa5') {
        // DSA5 specific handling
        if (
          item.type === 'spell' ||
          item.type === 'liturgy' ||
          item.type === 'ceremony' ||
          item.type === 'ritual'
        ) {
          if (typeof itemAny.postItem === 'function') {
            itemAny.postItem().catch((err: Error) => {
              console.error(`[foundry-mcp-bridge] Error using item ${item.name}:`, err);
            });
          } else if (typeof itemAny.setupEffect === 'function') {
            itemAny.setupEffect().catch((err: Error) => {
              console.error(`[foundry-mcp-bridge] Error using item ${item.name}:`, err);
            });
          } else {
            // Fallback: create a chat message describing the item
            const chatData = {
              user: game.user?.id,
              speaker: ChatMessage.getSpeaker({ actor }),
              content: `<h3>${item.name}</h3><p>${actor.name} uses ${item.name}.</p>`,
            };
            ChatMessage.create(chatData);
          }
        } else {
          if (typeof itemAny.postItem === 'function') {
            itemAny.postItem().catch((err: Error) => {
              console.error(`[foundry-mcp-bridge] Error using item ${item.name}:`, err);
            });
          }
        }
      } else {
        // Generic fallback: create a chat message
        const chatData = {
          user: game.user?.id,
          speaker: ChatMessage.getSpeaker({ actor }),
          content: `<h3>${item.name}</h3><p>${actor.name} uses ${item.name}.</p>`,
        };
        ChatMessage.create(chatData);
      }

      this.auditLog(
        'useItem',
        {
          actorId: actor.id,
          itemId: item.id,
          itemName: item.name,
          targets: resolvedTargetNames,
        },
        'success'
      );

      const targetInfo =
        resolvedTargetNames.length > 0 ? ` targeting ${resolvedTargetNames.join(', ')}` : '';

      const result: {
        success: boolean;
        status?: string;
        message: string;
        itemName?: string;
        actorName?: string;
        targets?: string[];
        requiresGMInteraction?: boolean;
      } = {
        success: true,
        status: 'initiated',
        message: `Item use initiated for ${actor.name} using ${item.name}${targetInfo}. If a dialog appeared in Foundry VTT, the GM should select options and confirm. The result will appear in chat.`,
        itemName: item.name,
        actorName: actor.name,
        requiresGMInteraction: true,
      };

      if (resolvedTargetNames.length > 0) {
        result.targets = resolvedTargetNames;
      }

      return result;
    } catch (error) {
      this.auditLog(
        'useItem',
        {
          actorId: actor.id,
          itemId: item.id,
        },
        'failure',
        error instanceof Error ? error.message : 'Unknown error'
      );

      throw new Error(
        `Failed to use item "${item.name}": ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
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
    this.validateFoundryState();

    try {
      // 1. Lookup actor
      const actor = this.findActorByIdentifier(data.actorIdentifier);
      if (!actor) {
        throw new Error(`Actor not found: "${data.actorIdentifier}"`);
      }

      // 2. System guard
      if ((game.system as any).id !== 'dnd5e') {
        throw new Error(
          `addSaveFeatureToActor requires D&D 5e. ` +
            `Current system: "${(game.system as any).id}".`
        );
      }

      // 3. Duplicate check (by name only, regardless of item type)
      const existing = actor.items.find((i: any) => i.name === data.featureName);
      if (existing) {
        throw new Error(
          `Feature "${data.featureName}" already exists on actor "${actor.name}" ` +
            `(id: ${existing.id}). Use a different name or remove the existing feature first.`
        );
      }

      // 4. Generate activity ID
      const activityId: string = (foundry.utils as any).randomID(16);

      // 5. Slug identifier
      const identifier = slugify(data.featureName);

      // 5a. Map emanation → radius (Foundry uses "radius" for radial emanations)
      const mappedAreaType: string = data.areaType === 'emanation' ? 'radius' : data.areaType;

      // 6. Build item data — schema verified against dnd5e 5.1.8 real output
      const itemData = {
        name: data.featureName,
        type: 'feat',
        img: 'systems/dnd5e/icons/svg/items/feature.svg',
        system: {
          description: { value: data.description, chat: '' },
          identifier,
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
              activation: {
                type: data.activationType,
                override: false,
              },
              consumption: {
                scaling: { allowed: false },
                spellSlot: true,
                targets: [],
              },
              description: {},
              duration: { units: 'inst', concentration: false, override: false },
              effects: [],
              range: { units: 'self', override: false },
              uses: { spent: 0, recovery: [] },
              target: {
                template: {
                  contiguous: false,
                  units: data.areaUnits,
                  count: '',
                  type: mappedAreaType,
                  size: mappedAreaType ? String(data.areaSize ?? '') : '',
                },
                affects: {
                  choice: false,
                  count: '',
                  type: data.affectsType,
                  special: '',
                },
                override: false,
                prompt: true,
              },
              damage: {
                onSave: data.halfOnSave ? 'half' : 'none',
                parts: data.damageParts.map(p => ({
                  custom: { enabled: false, formula: '' },
                  number: p.number,
                  denomination: p.denomination,
                  bonus: '',
                  types: [p.type],
                  scaling: { mode: '', number: 1 },
                })),
              },
              save: {
                ability: [data.saveAbility],
                dc: {
                  calculation: '',
                  formula: String(data.saveDC),
                },
              },
            },
          },
        },
        effects: [],
      };

      // 7. Create embedded item
      const [created] = (await actor.createEmbeddedDocuments('Item', [itemData])) as any[];

      this.auditLog(
        'addSaveFeatureToActor',
        { actorId: actor.id, featureName: data.featureName },
        'success'
      );

      // 8. Return structured result
      return {
        success: true,
        item: { id: created.id, name: created.name },
        actor: { id: actor.id, name: actor.name },
      };
    } catch (error) {
      console.error(`[${MODULE_ID}] Failed to add save feature to actor`, error);
      this.auditLog(
        'addSaveFeatureToActor',
        { actorIdentifier: data.actorIdentifier, featureName: data.featureName },
        'failure',
        error instanceof Error ? error.message : 'Unknown error'
      );
      throw error;
    }
  }

  // ===== CREATE NPC ACTOR (D&D 5e) =====

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
    this.validateFoundryState();

    try {
      // 1. System guard
      if ((game.system as any).id !== 'dnd5e') {
        throw new Error(
          `createNpcActor requires D&D 5e. ` + `Current system: "${(game.system as any).id}".`
        );
      }

      // 2. Duplicate check by name — only against other NPCs, so a player
      //    character sharing the name does not block NPC creation.
      const existingActor = game.actors?.find((a: any) => a.name === data.name && a.type === 'npc');
      if (existingActor) {
        throw new Error(
          `NPC "${data.name}" already exists (id: ${existingActor.id}). ` +
            `Use a different name or remove the existing NPC first.`
        );
      }

      // 3. Soft validation — collect warnings, do NOT block creation
      const warnings: string[] = [];
      const allDamageValues: Array<{ field: string; value: string }> = [
        ...data.damageImmunities.map(v => ({ field: 'damageImmunities', value: v })),
        ...data.damageResistances.map(v => ({ field: 'damageResistances', value: v })),
        ...data.damageVulnerabilities.map(v => ({ field: 'damageVulnerabilities', value: v })),
      ];
      for (const { field, value } of allDamageValues) {
        if (!NPC_DAMAGE_CANONICAL.has(value)) {
          const msg = `Unknown damage type "${value}" in ${field} — verify it matches dnd5e system values`;
          warnings.push(msg);
          console.warn(`[${MODULE_ID}] ${msg}`);
        }
      }
      for (const value of data.conditionImmunities) {
        if (!NPC_CONDITION_CANONICAL.has(value)) {
          const msg = `Unknown condition "${value}" in conditionImmunities — verify it matches dnd5e system values`;
          warnings.push(msg);
          console.warn(`[${MODULE_ID}] ${msg}`);
        }
      }

      // 4. Normalize CR to float
      const normalizedCR = npcNormalizeCR(data.cr);

      // 5. Folder
      const folderId = await this.getOrCreateFolder('Foundry MCP Creatures', 'Actor');

      // 6. Ability scores with saving throw proficiency flags
      const savingThrowSet = new Set(data.savingThrows);
      const abilities = {
        str: { value: data.abilities.str, proficient: savingThrowSet.has('str') ? 1 : 0 },
        dex: { value: data.abilities.dex, proficient: savingThrowSet.has('dex') ? 1 : 0 },
        con: { value: data.abilities.con, proficient: savingThrowSet.has('con') ? 1 : 0 },
        int: { value: data.abilities.int, proficient: savingThrowSet.has('int') ? 1 : 0 },
        wis: { value: data.abilities.wis, proficient: savingThrowSet.has('wis') ? 1 : 0 },
        cha: { value: data.abilities.cha, proficient: savingThrowSet.has('cha') ? 1 : 0 },
      };

      // 7. AC block — omit flat when mode is "default"
      const acBlock =
        data.acMode === 'flat' ? { calc: 'flat', flat: data.acValue } : { calc: 'default' };

      // 8. Build full actor data
      const actorData: any = {
        name: data.name,
        type: 'npc',
        system: {
          abilities,
          attributes: {
            ac: acBlock,
            hp: {
              value: data.hpAverage,
              max: data.hpAverage,
              temp: 0,
              tempmax: 0,
              formula: data.hpFormula,
            },
            movement: {
              walk: data.walkSpeed,
              fly: data.flySpeed,
              swim: data.swimSpeed,
              climb: data.climbSpeed,
              burrow: data.burrowSpeed,
              units: 'ft',
              hover: data.hover,
              special: '',
            },
            senses: {
              darkvision: data.darkvision,
              blindsight: data.blindsight,
              tremorsense: data.tremorsense,
              truesight: data.truesight,
              units: 'ft',
              special: data.specialSenses,
            },
          },
          details: {
            cr: normalizedCR,
            type: {
              value: data.creatureType,
              subtype: data.creatureSubtype,
            },
            alignment: data.alignment,
            biography: {
              value: data.biography,
              public: '',
            },
            source: {
              revision: 1,
              rules: data.sourceRules,
              book: data.sourceBook,
              page: data.sourcePage,
              custom: '',
              license: '',
            },
          },
          traits: {
            size: NPC_SIZE_MAP[data.size] ?? 'med',
            di: { value: data.damageImmunities, custom: '', bypasses: [] },
            dr: { value: data.damageResistances, custom: '', bypasses: [] },
            dv: { value: data.damageVulnerabilities, custom: '', bypasses: [] },
            ci: { value: data.conditionImmunities, custom: '' },
            languages: {
              value: data.languages,
              custom: data.languagesCustom,
              communication: {},
            },
          },
          skills: npcBuildSkillsBlock(data.skills),
        },
      };

      // 9. Assign folder if available
      if (folderId) {
        actorData.folder = folderId;
      }

      // 10. Create actor
      const actor = await Actor.create(actorData);
      if (!actor) {
        throw new Error(`Failed to create NPC actor "${data.name}"`);
      }

      this.auditLog('createNpcActor', { name: data.name, cr: normalizedCR }, 'success');

      // 11. Return structured result
      return {
        success: true,
        actor: {
          id: actor.id,
          name: actor.name,
          cr: npcFormatCR(normalizedCR),
          folder: folderId ?? null,
        },
        warnings,
      };
    } catch (error) {
      console.error(`[${MODULE_ID}] Failed to create NPC actor`, error);
      this.auditLog(
        'createNpcActor',
        { name: data.name },
        'failure',
        error instanceof Error ? error.message : 'Unknown error'
      );
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Add weapon attack to an existing actor (dnd5e-add-attack-feature)
  // ---------------------------------------------------------------------------

  async addAttackToActor(data: any): Promise<any> {
    this.validateFoundryState();

    if ((game.system as any).id !== 'dnd5e') {
      throw new Error('addAttackToActor requires the dnd5e game system');
    }

    try {
      // 1. Resolve actor
      const actor = await this.findActorByIdentifier(data.actorIdentifier);
      if (!actor) {
        throw new Error(`Actor not found: "${data.actorIdentifier}"`);
      }

      // 2. Duplicate check
      const existing = actor.items.find(
        (i: any) => i.name.toLowerCase() === data.featureName.toLowerCase()
      );
      if (existing) {
        throw new Error(
          `An item named "${data.featureName}" already exists on actor "${actor.name}". ` +
            `Remove or rename it first.`
        );
      }

      // 3. Soft validation — collect warnings, never block
      const warnings: string[] = [];

      for (const part of data.damageParts as Array<{
        number: number;
        denomination: number;
        type: string;
      }>) {
        if (!ATTACK_DAMAGE_CANONICAL.has(part.type)) {
          const msg = `Unknown damage type "${part.type}" — verify it matches dnd5e system values`;
          warnings.push(msg);
          console.warn(`[${MODULE_ID}] ${msg}`);
        }
      }
      for (const prop of data.properties as string[]) {
        if (!ATTACK_PROPERTY_CANONICAL.has(prop)) {
          const msg = `Unknown weapon property "${prop}" — verify it matches dnd5e system values`;
          warnings.push(msg);
          console.warn(`[${MODULE_ID}] ${msg}`);
        }
      }

      // 4. Generate activity ID
      const activityId: string = (foundry.utils as any).randomID(16);

      // 5. Damage parts for the activity (all except the first — which is system.damage.base)
      const activityDamageParts = (
        data.damageParts as Array<{ number: number; denomination: number; type: string }>
      )
        .slice(1)
        .map(p => ({
          types: [p.type],
          number: p.number,
          denomination: p.denomination,
          bonus: '',
          scaling: { mode: '', number: 1 },
          custom: { enabled: false },
        }));

      // 6. Range object (system-level — holds the real range/reach)
      const rangeObj =
        data.attackType === 'melee'
          ? { value: data.reachFt ?? 5, long: null, units: 'ft' }
          : { value: data.rangeFt, long: data.longRangeFt ?? null, units: 'ft' };

      // 7. Conditional 2024-only fields
      const sourceRules: string = data.sourceRules ?? '2014';
      const masteryField = sourceRules === '2024' ? { mastery: '' } : {};
      const abilityField = sourceRules === '2024' ? { ability: data.effectiveAbility } : {};
      const classification = sourceRules === '2014' ? 'weapon' : '';

      // 8. Build item data
      const itemData: Record<string, any> = {
        name: data.featureName,
        type: 'weapon',
        system: {
          description: {
            value: data.description ?? '',
            chat: '',
            unidentified: '',
          },
          source: {
            custom: '',
            book: data.sourceBook ?? '',
            page: data.sourcePage ?? '',
            license: '',
            rules: sourceRules,
          },
          quantity: 1,
          weight: { value: 0, units: 'lb' },
          price: { value: 0, denomination: 'gp' },
          attunement: '',
          equipped: data.equipped !== false,
          rarity: '',
          identified: true,
          activation: {
            type: data.activationType ?? 'action',
            value: 1,
            condition: '',
            override: false,
          },
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
          range: rangeObj,
          uses: { value: null, max: '', recovery: [], prompt: true },
          damage: {
            base: {
              types: [(data.damageParts as any[])[0].type],
              number: (data.damageParts as any[])[0].number,
              denomination: (data.damageParts as any[])[0].denomination,
              bonus: '',
              scaling: { mode: '', number: 1 },
              custom: { enabled: false },
            },
          },
          type: { value: data.weaponClass ?? 'natural', baseItem: '' },
          properties: data.properties as string[],
          proficient: 1,
          magicalBonus: null,
          ...masteryField,
          activities: {
            [activityId]: {
              _id: activityId,
              type: 'attack',
              name: '',
              img: '',
              sort: 0,
              description: {},
              activation: {
                type: data.activationType ?? 'action',
                value: 1,
                condition: '',
                override: false,
              },
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
              consumption: {
                targets: [],
                scaling: { allowed: false, max: '' },
                spellSlot: true,
              },
              attack: {
                ability: '',
                bonus: data.attackBonus > 0 ? String(data.attackBonus) : '',
                critical: { threshold: null },
                flat: false,
                type: {
                  value: data.attackType ?? 'melee',
                  classification: classification,
                },
                ...abilityField,
              },
              damage: {
                critical: { bonus: '' },
                includeBase: true,
                parts: activityDamageParts,
              },
              effects: [],
              save: { ability: '', dc: { formula: '', calculation: '' } },
            },
          },
        },
      };

      // 9. Create the item on the actor
      const created = (await actor.createEmbeddedDocuments('Item', [itemData]))[0];
      if (!created) {
        throw new Error(
          `Failed to create attack item "${data.featureName}" on actor "${actor.name}"`
        );
      }

      this.auditLog(
        'addAttackToActor',
        { actorId: actor.id, featureName: data.featureName },
        'success'
      );

      return {
        success: true,
        actor: { id: actor.id, name: actor.name },
        item: { id: created.id, name: created.name, type: 'weapon' },
        warnings,
      };
    } catch (error) {
      console.error(`[${MODULE_ID}] Failed to add attack to actor`, error);
      this.auditLog(
        'addAttackToActor',
        { actorIdentifier: data.actorIdentifier, featureName: data.featureName },
        'failure',
        error instanceof Error ? error.message : 'Unknown error'
      );
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Add automatic-damage aura/emanation feature to an existing actor
  // (dnd5e-add-aura-feature)
  // ---------------------------------------------------------------------------

  async addAuraToActor(data: any): Promise<any> {
    this.validateFoundryState();

    if ((game.system as any).id !== 'dnd5e') {
      throw new Error('addAuraToActor requires the dnd5e game system');
    }

    try {
      // 1. Resolve actor
      const actor = await this.findActorByIdentifier(data.actorIdentifier);
      if (!actor) {
        throw new Error(`Actor not found: "${data.actorIdentifier}"`);
      }

      // 2. Duplicate check (case-insensitive name match)
      const existing = actor.items.find(
        (i: any) => i.name.toLowerCase() === data.featureName.toLowerCase()
      );
      if (existing) {
        throw new Error(
          `An item named "${data.featureName}" already exists on actor "${actor.name}". ` +
            `Remove or rename it first.`
        );
      }

      // 3. Soft validation — collect warnings, never block
      const warnings: string[] = [];

      for (const part of data.damageParts as Array<{
        number: number;
        denomination: number;
        type: string;
      }>) {
        if (!AURA_DAMAGE_CANONICAL.has(part.type)) {
          const msg = `Unknown damage type "${part.type}" — verify it matches dnd5e system values`;
          warnings.push(msg);
          console.warn(`[${MODULE_ID}] ${msg}`);
        }
      }

      // 4. Map areaType: Foundry uses "radius" internally for what 5e 2024 calls "emanation"
      //    <option value="radius">Emanation</option> — no "emanation" value exists in the dropdown
      const mappedAreaType: string = data.areaType === 'emanation' ? 'radius' : data.areaType;

      // 5. Generate activity ID
      const activityId: string = (foundry.utils as any).randomID(16);

      // 6. Slug identifier
      const identifier = slugify(data.featureName as string);

      // 7. Build item data — schema verified against dnd5e 5.1.8 Banshee Wail
      const itemData = {
        name: data.featureName,
        type: 'feat',
        img: 'systems/dnd5e/icons/svg/items/feature.svg',
        system: {
          description: { value: data.description ?? '', chat: '' },
          identifier,
          source: {
            revision: 1,
            rules: data.sourceRules ?? '2014',
            custom: '',
            book: data.sourceBook ?? '',
            page: data.sourcePage ?? '',
            license: '',
          },
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
              type: 'damage', // activity type: damage — no attack roll, no save
              name: '',
              sort: 0,
              activation: {
                type: data.activationType ?? 'action',
                value: 1,
                override: false,
                // NO condition — not present in real dnd5e 5.1.8 schema
              },
              consumption: {
                scaling: { allowed: false },
                spellSlot: true, // confirmed: true in real Banshee Wail schema
                targets: [], // no uses management in V1
              },
              description: {}, // empty object — confirmed from real schema
              duration: {
                units: 'inst',
                concentration: false,
                override: false,
              },
              effects: [],
              range: { units: 'self', override: false }, // NO value, NO special
              uses: { spent: 0, recovery: [] }, // NO max field
              target: {
                template: {
                  contiguous: false,
                  units: data.areaUnits ?? 'ft',
                  count: '',
                  type: mappedAreaType,
                  size: String(data.areaSize ?? ''),
                  width: '',
                  height: '',
                },
                affects: {
                  count: '',
                  type: data.affectsType ?? 'creature',
                  choice: false,
                  special: '',
                },
                override: false,
                prompt: true,
              },
              damage: {
                critical: { allow: false }, // only this key — no bonus, no dice
                parts: (
                  data.damageParts as Array<{ number: number; denomination: number; type: string }>
                ).map(p => ({
                  types: [p.type],
                  number: p.number,
                  denomination: p.denomination,
                  bonus: '',
                  scaling: { mode: '', number: 1 }, // mode: '' required — from real schema
                  custom: { enabled: false }, // NO formula field
                })),
                // NO onSave — damage activity has no save concept
              },
              // NO save block
              // NO attack block
            },
          },
        },
        effects: [],
      };

      // 7. Create embedded item
      const [created] = (await actor.createEmbeddedDocuments('Item', [itemData])) as any[];
      if (!created) {
        throw new Error(
          `Failed to create aura item "${data.featureName}" on actor "${actor.name}"`
        );
      }

      this.auditLog(
        'addAuraToActor',
        { actorId: actor.id, featureName: data.featureName },
        'success'
      );

      return {
        success: true,
        actor: { id: actor.id, name: actor.name },
        item: { id: created.id, name: created.name, type: 'feat' },
        warnings,
      };
    } catch (error) {
      console.error(`[${MODULE_ID}] Failed to add aura to actor`, error);
      this.auditLog(
        'addAuraToActor',
        { actorIdentifier: data.actorIdentifier, featureName: data.featureName },
        'failure',
        error instanceof Error ? error.message : 'Unknown error'
      );
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Add passive/descriptive feature to an existing actor (dnd5e-add-passive-feature)
  // No activities, no mechanics — pure description displayed on the sheet.
  // ---------------------------------------------------------------------------

  async addPassiveFeatureToActor(data: any): Promise<any> {
    this.validateFoundryState();

    if ((game.system as any).id !== 'dnd5e') {
      throw new Error('addPassiveFeatureToActor requires the dnd5e game system');
    }

    try {
      // 1. Resolve actor
      const actor = await this.findActorByIdentifier(data.actorIdentifier);
      if (!actor) {
        throw new Error(`Actor not found: "${data.actorIdentifier}"`);
      }

      // 2. Duplicate check (case-insensitive)
      const existing = actor.items.find(
        (i: any) => i.name.toLowerCase() === data.featureName.toLowerCase()
      );
      if (existing) {
        throw new Error(
          `An item named "${data.featureName}" already exists on actor "${actor.name}". ` +
            `Remove or rename it first.`
        );
      }

      // 3. Slug identifier
      const identifier = slugify(data.featureName as string);

      // 4. Build item data — no activities, no activityId needed
      const itemData = {
        name: data.featureName,
        type: 'feat',
        img: 'systems/dnd5e/icons/svg/items/feature.svg',
        system: {
          description: { value: data.description ?? '', chat: '' },
          identifier,
          source: {
            revision: 1,
            rules: data.sourceRules ?? '2014',
            custom: '',
            book: data.sourceBook ?? '',
            page: data.sourcePage ?? '',
            license: '',
          },
          type: { value: 'monster', subtype: '' },
          uses: { spent: 0, recovery: [], max: '' },
          advancement: [],
          crewed: false,
          enchant: {},
          prerequisites: { items: [], repeatable: false, level: null },
          properties: [],
          requirements: '',
          activities: {}, // empty — passive feature has no mechanical activity
        },
        effects: [],
      };

      // 5. Create embedded item
      const [created] = (await actor.createEmbeddedDocuments('Item', [itemData])) as any[];
      if (!created) {
        throw new Error(
          `Failed to create passive feature "${data.featureName}" on actor "${actor.name}"`
        );
      }

      this.auditLog(
        'addPassiveFeatureToActor',
        { actorId: actor.id, featureName: data.featureName },
        'success'
      );

      return {
        success: true,
        actor: { id: actor.id, name: actor.name },
        item: { id: created.id, name: created.name, type: 'feat' },
      };
    } catch (error) {
      console.error(`[${MODULE_ID}] Failed to add passive feature to actor`, error);
      this.auditLog(
        'addPassiveFeatureToActor',
        { actorIdentifier: data.actorIdentifier, featureName: data.featureName },
        'failure',
        error instanceof Error ? error.message : 'Unknown error'
      );
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Add weapon attack + save effect to an existing actor
  // (dnd5e-add-attack-with-save) — Tipo B
  // Two activities: attack (sort:0) + save (sort:1)
  // ---------------------------------------------------------------------------

  async addAttackWithSaveToActor(data: any): Promise<any> {
    this.validateFoundryState();

    if ((game.system as any).id !== 'dnd5e') {
      throw new Error('addAttackWithSaveToActor requires the dnd5e game system');
    }

    try {
      // 1. Resolve actor
      const actor = await this.findActorByIdentifier(data.actorIdentifier);
      if (!actor) {
        throw new Error(`Actor not found: "${data.actorIdentifier}"`);
      }

      // 2. Duplicate check
      const existing = actor.items.find(
        (i: any) => i.name.toLowerCase() === data.featureName.toLowerCase()
      );
      if (existing) {
        throw new Error(
          `An item named "${data.featureName}" already exists on actor "${actor.name}". ` +
            `Remove or rename it first.`
        );
      }

      // 3. Soft validation — both damage groups unified
      const warnings: string[] = [];
      const allParts = [
        ...(data.damageParts as Array<{ type: string }>),
        ...(data.saveDamageParts as Array<{ type: string }>),
      ];
      for (const part of allParts) {
        if (!ATTACK_WITH_SAVE_DAMAGE_CANONICAL.has(part.type)) {
          const msg = `Unknown damage type "${part.type}" — verify it matches dnd5e system values`;
          if (!warnings.includes(msg)) warnings.push(msg);
          console.warn(`[${MODULE_ID}] ${msg}`);
        }
      }

      // 4. Generate two distinct activity IDs
      const attackActivityId: string = (foundry.utils as any).randomID(16);
      const saveActivityId: string = (foundry.utils as any).randomID(16);

      // 5. Attack activity damage parts: damageParts[1+] (base is in system.damage.base)
      const activityDamageParts = (
        data.damageParts as Array<{ number: number; denomination: number; type: string }>
      )
        .slice(1)
        .map(p => ({
          types: [p.type],
          number: p.number,
          denomination: p.denomination,
          bonus: '',
          scaling: { mode: '', number: 1 },
          custom: { enabled: false },
        }));

      // 6. Save activity damage parts: ALL saveDamageParts (no base — independent)
      const saveActivityDamageParts = (
        data.saveDamageParts as Array<{ number: number; denomination: number; type: string }>
      ).map(p => ({
        types: [p.type],
        number: p.number,
        denomination: p.denomination,
        bonus: '',
        scaling: { mode: '', number: 1 },
        custom: { enabled: false },
      }));

      // 7. System-level range (real reach/range — activity range is always 'self')
      const rangeObj =
        data.attackType === 'melee'
          ? { value: data.reachFt ?? 5, long: null, units: 'ft' }
          : { value: data.rangeFt, long: data.longRangeFt ?? null, units: 'ft' };

      // 8. Conditional 2024-only fields (same rules as Tipo A)
      const sourceRules: string = data.sourceRules ?? '2014';
      const masteryField = sourceRules === '2024' ? { mastery: '' } : {};
      const abilityField = sourceRules === '2024' ? { ability: data.effectiveAbility } : {};
      const classification = sourceRules === '2014' ? 'weapon' : '';

      // 9. Build item data
      const itemData: Record<string, any> = {
        name: data.featureName,
        type: 'weapon',
        system: {
          description: {
            value: data.description ?? '',
            chat: '',
            unidentified: '',
          },
          source: {
            custom: '',
            book: data.sourceBook ?? '',
            page: data.sourcePage ?? '',
            license: '',
            rules: sourceRules,
          },
          quantity: 1,
          weight: { value: 0, units: 'lb' },
          price: { value: 0, denomination: 'gp' },
          attunement: '',
          equipped: data.equipped !== false,
          rarity: '',
          identified: true,
          activation: {
            type: data.activationType ?? 'action',
            value: 1,
            condition: '',
            override: false,
          },
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
          range: rangeObj,
          uses: { value: null, max: '', recovery: [], prompt: true },
          damage: {
            base: {
              types: [(data.damageParts as any[])[0].type],
              number: (data.damageParts as any[])[0].number,
              denomination: (data.damageParts as any[])[0].denomination,
              bonus: '',
              scaling: { mode: '', number: 1 },
              custom: { enabled: false },
            },
          },
          type: { value: data.weaponClass ?? 'natural', baseItem: '' },
          properties: data.properties as string[],
          proficient: 1,
          magicalBonus: null,
          ...masteryField,
          activities: {
            // ── Activity 1: attack (sort 0) ───────────────────────────────
            [attackActivityId]: {
              _id: attackActivityId,
              type: 'attack',
              name: '',
              img: '',
              sort: 0,
              description: {},
              activation: {
                type: data.activationType ?? 'action',
                value: 1,
                condition: '',
                override: false,
              },
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
                bonus: data.attackBonus > 0 ? String(data.attackBonus) : '',
                critical: { threshold: null },
                flat: false,
                type: { value: data.attackType ?? 'melee', classification },
                ...abilityField,
              },
              damage: {
                critical: { bonus: '' },
                includeBase: true,
                parts: activityDamageParts,
              },
              effects: [],
              save: { ability: '', dc: { formula: '', calculation: '' } },
            },

            // ── Activity 2: save (sort 1) ─────────────────────────────────
            [saveActivityId]: {
              _id: saveActivityId,
              type: 'save',
              name: '',
              sort: 1,
              description: {}, // {} — not { chatFlavor: '' } (real schema confirmed)
              activation: {
                type: data.activationType ?? 'action',
                value: 1,
                override: false,
                // NO condition — per real schema
              },
              duration: { units: 'inst', concentration: false, override: false },
              effects: [],
              range: { units: 'self', override: false },
              uses: { spent: 0, recovery: [] }, // NO max
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
                affects: { count: '1', type: 'creature', choice: false, special: '' },
                override: false,
                prompt: true,
              },
              damage: {
                onSave: data.saveOnSave ?? 'none',
                parts: saveActivityDamageParts,
                // NO includeBase — save damage is independent from weapon base damage
              },
              save: {
                ability: [data.saveAbility],
                dc: { calculation: '', formula: String(data.saveDC) },
              },
            },
          },
        },
      };

      // 10. Create the item on the actor
      const created = (await actor.createEmbeddedDocuments('Item', [itemData]))[0];
      if (!created) {
        throw new Error(
          `Failed to create attack+save item "${data.featureName}" on actor "${actor.name}"`
        );
      }

      this.auditLog(
        'addAttackWithSaveToActor',
        { actorId: actor.id, featureName: data.featureName },
        'success'
      );

      return {
        success: true,
        actor: { id: actor.id, name: actor.name },
        item: { id: created.id, name: created.name, type: 'weapon' },
        warnings,
      };
    } catch (error) {
      console.error(`[${MODULE_ID}] Failed to add attack+save to actor`, error);
      this.auditLog(
        'addAttackWithSaveToActor',
        { actorIdentifier: data.actorIdentifier, featureName: data.featureName },
        'failure',
        error instanceof Error ? error.message : 'Unknown error'
      );
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Set actor spellcasting (ability + slot counts)
  // ---------------------------------------------------------------------------

  async setActorSpellcasting(data: any): Promise<any> {
    this.validateFoundryState();

    if ((game.system as any).id !== 'dnd5e') {
      throw new Error('setActorSpellcasting requires the dnd5e game system');
    }

    try {
      // 1. Resolve actor
      const actor = this.findActorByIdentifier(data.actorIdentifier);
      if (!actor) {
        throw new Error(`Actor not found: "${data.actorIdentifier}"`);
      }

      const cls = data.spellcastingClass as string;
      const lvl = data.spellcastingLevel as number;
      const ability = data.effectiveAbility as string;
      const idx = lvl - 1; // 0-based index into slot tables
      const warnings: string[] = [];

      // 2. Build flat updates object for a single actor.update() call
      const updates: Record<string, unknown> = {};

      // Spellcasting ability
      updates['system.attributes.spellcasting'] = ability;

      if (cls === 'warlock') {
        // ── Pact Magic ────────────────────────────────────────────────────────
        // All regular slots set to 0; pact slots from table
        for (let i = 1; i <= 9; i++) {
          updates[`system.spells.spell${i}.max`] = 0;
          updates[`system.spells.spell${i}.value`] = 0;
        }
        const pact = WARLOCK_PACT_TABLE[idx];
        updates['system.spells.pact.max'] = pact.max;
        updates['system.spells.pact.value'] = pact.max;
        updates['system.spells.pact.level'] = pact.level;
      } else {
        // ── Regular spell slots ───────────────────────────────────────────────
        let slotRow: number[];

        if (cls === 'artificer') {
          slotRow = ARTIFICER_SLOTS[idx];
        } else if (cls === 'paladin' || cls === 'ranger') {
          slotRow = HALF_CASTER_SLOTS[idx];
          if (lvl === 1) {
            warnings.push(
              `${cls} level 1 has no spell slots — use level 2+ to unlock spellcasting`
            );
          }
        } else {
          // Full casters: wizard, cleric, druid, sorcerer, bard
          slotRow = FULL_CASTER_SLOTS[idx];
        }

        for (let i = 1; i <= 9; i++) {
          const n = slotRow[i - 1];
          updates[`system.spells.spell${i}.max`] = n;
          updates[`system.spells.spell${i}.value`] = n;
        }
      }

      // 3. Single update call
      await actor.update(updates);

      // 4. Build response
      const slots: Record<string, unknown> = {};
      if (cls === 'warlock') {
        const pact = WARLOCK_PACT_TABLE[idx];
        slots['pact'] = { max: pact.max, level: pact.level };
      } else {
        const slotRow =
          cls === 'artificer'
            ? ARTIFICER_SLOTS[idx]
            : cls === 'paladin' || cls === 'ranger'
              ? HALF_CASTER_SLOTS[idx]
              : FULL_CASTER_SLOTS[idx];

        for (let i = 1; i <= 9; i++) {
          (slots as Record<string, number>)[`spell${i}`] = slotRow[i - 1];
        }
      }

      this.auditLog('setActorSpellcasting', { actorId: actor.id, cls, lvl, ability }, 'success');

      return {
        actor: { id: actor.id, name: actor.name },
        spellcasting: { ability, slots },
        warnings,
      };
    } catch (error) {
      console.error(`[${MODULE_ID}] Failed to set actor spellcasting`, error);
      this.auditLog(
        'setActorSpellcasting',
        { actorIdentifier: data.actorIdentifier, spellcastingClass: data.spellcastingClass },
        'failure',
        error instanceof Error ? error.message : 'Unknown error'
      );
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Add spells from compendium packs to an actor
  // ---------------------------------------------------------------------------

  async addSpellsToActor(data: any): Promise<any> {
    this.validateFoundryState();

    if ((game.system as any).id !== 'dnd5e') {
      throw new Error('addSpellsToActor requires the dnd5e game system');
    }

    try {
      // 1. Resolve actor
      const actor = this.findActorByIdentifier(data.actorIdentifier);
      if (!actor) {
        throw new Error(`Actor not found: "${data.actorIdentifier}"`);
      }

      const spellNames: string[] = data.spellNames;
      const compendiumPacks: string[] = data.compendiumPacks ?? ['dnd5e.spells'];
      const warnings: string[] = [];

      // ── Phase A: deduplicate input (case-insensitive) ─────────────────────
      const seen = new Set<string>();
      const unique: string[] = [];
      const skipped: Array<{ name: string; reason: string }> = [];

      for (const name of spellNames) {
        const key = name.toLowerCase();
        if (seen.has(key)) {
          skipped.push({ name, reason: 'duplicate in input' });
        } else {
          seen.add(key);
          unique.push(name);
        }
      }

      // ── Phase B: build pack index maps (once per pack) ────────────────────
      interface PackMap {
        packId: string;
        packLabel: string;
        nameMap: Map<string, string>; // lowercase name → _id
      }
      const packMaps: PackMap[] = [];

      for (const packId of compendiumPacks) {
        const pack = game.packs.get(packId);
        if (!pack) {
          warnings.push(`Compendium pack "${packId}" not found — skipped`);
          continue;
        }

        // Q6: type guard — Item packs only
        if (pack.metadata.type !== 'Item') {
          warnings.push(
            `Pack "${packId}" has type "${pack.metadata.type}", expected "Item" — skipped`
          );
          continue;
        }

        if (!pack.indexed) {
          await pack.getIndex({});
        }

        const nameMap = new Map<string, string>();
        for (const entry of pack.index.values() as IterableIterator<any>) {
          if (entry.name) {
            nameMap.set((entry.name as string).toLowerCase(), entry._id as string);
          }
        }

        packMaps.push({ packId, packLabel: pack.metadata.label as string, nameMap });
      }

      if (packMaps.length === 0) {
        throw new Error(
          'No valid compendium packs available — check the compendiumPacks parameter. ' +
            'Valid pack IDs for D&D 5e: "dnd5e.spells" (2014) or "dnd5e.spells24" (2024).'
        );
      }

      // ── Phase C: per-spell search + import ───────────────────────────────
      const added: Array<{ name: string; packId: string; packLabel: string; itemId: string }> = [];
      const notFound: string[] = [];
      const failed: Array<{ name: string; error: string }> = [];

      for (const name of unique) {
        const normalizedName = name.toLowerCase();

        // 1. Duplicate check on actor (only items of type 'spell')
        const existing = (actor.items as any[]).find(
          (i: any) => i.type === 'spell' && i.name?.toLowerCase() === normalizedName
        );
        if (existing) {
          skipped.push({ name, reason: 'already on actor' });
          continue;
        }

        // 2. Lookup across packs — first-pack-wins
        let found: { packId: string; packLabel: string; entryId: string } | null = null;
        for (const pm of packMaps) {
          const entryId = pm.nameMap.get(normalizedName);
          if (entryId) {
            found = { packId: pm.packId, packLabel: pm.packLabel, entryId };
            break;
          }
        }

        if (!found) {
          notFound.push(name);
          continue;
        }

        // 3. Fetch full document from compendium
        const pack = game.packs.get(found.packId);
        const document = await (pack as any).getDocument(found.entryId);

        if (!document) {
          // Entry was in index but document is missing (shouldn't happen, defensive)
          notFound.push(name);
          warnings.push(
            `"${name}" found in index but document missing in pack "${found.packId}" — skipped`
          );
          continue;
        }

        // 4. Prepare data for embedding
        const spellData = (document as any).toObject() as Record<string, unknown>;
        delete spellData._id; // Let Foundry assign a new local id; prevents id clash

        // 5. Embed individually — per-spell error isolation
        try {
          const [created] = (await actor.createEmbeddedDocuments('Item', [spellData])) as any[];
          added.push({
            name,
            packId: found.packId,
            packLabel: found.packLabel,
            itemId: created.id,
          });
        } catch (embedErr) {
          failed.push({
            name,
            error: embedErr instanceof Error ? embedErr.message : 'Unknown error',
          });
        }
      }

      // ── Phase D: audit + return ───────────────────────────────────────────
      this.auditLog(
        'addSpellsToActor',
        {
          actorId: actor.id,
          added: added.length,
          skipped: skipped.length,
          notFound: notFound.length,
          failed: failed.length,
        },
        'success'
      );

      return {
        actor: { id: actor.id, name: actor.name },
        added,
        skipped,
        notFound,
        failed,
        warnings,
      };
    } catch (error) {
      console.error(`[${MODULE_ID}] Failed to add spells to actor`, error);
      this.auditLog(
        'addSpellsToActor',
        { actorIdentifier: data.actorIdentifier },
        'failure',
        error instanceof Error ? error.message : 'Unknown error'
      );
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Add features from compendium packs to an actor
  // ---------------------------------------------------------------------------

  async addFeaturesFromCompendium(data: any): Promise<any> {
    this.validateFoundryState();

    if ((game.system as any).id !== 'dnd5e') {
      throw new Error('addFeaturesFromCompendium requires the dnd5e game system');
    }

    try {
      // 1. Resolve actor
      const actor = this.findActorByIdentifier(data.actorIdentifier);
      if (!actor) {
        throw new Error(`Actor not found: "${data.actorIdentifier}"`);
      }

      const featureNames: string[] = data.featureNames;
      const compendiumPacks: string[] = data.compendiumPacks ?? [
        'dnd5e.monsterfeatures',
        'dnd5e.classfeatures',
      ];
      const warnings: string[] = [];

      // ── Phase A: deduplicate input (case-insensitive) ─────────────────────
      const seen = new Set<string>();
      const unique: string[] = [];
      const skipped: Array<{ name: string; reason: string }> = [];

      for (const name of featureNames) {
        const key = name.toLowerCase();
        if (seen.has(key)) {
          skipped.push({ name, reason: 'duplicate in input' });
        } else {
          seen.add(key);
          unique.push(name);
        }
      }

      // ── Phase B: build pack index maps (once per pack) ────────────────────
      interface PackMap {
        packId: string;
        packLabel: string;
        nameMap: Map<string, string>; // lowercase name → _id
      }
      const packMaps: PackMap[] = [];

      for (const packId of compendiumPacks) {
        const pack = game.packs.get(packId);
        if (!pack) {
          warnings.push(`Compendium pack "${packId}" not found — skipped`);
          continue;
        }

        // Type guard — Item packs only
        if (pack.metadata.type !== 'Item') {
          warnings.push(
            `Pack "${packId}" has type "${pack.metadata.type}", expected "Item" — skipped`
          );
          continue;
        }

        if (!pack.indexed) {
          await pack.getIndex({});
        }

        const nameMap = new Map<string, string>();
        for (const entry of pack.index.values() as IterableIterator<any>) {
          if (entry.name) {
            nameMap.set((entry.name as string).toLowerCase(), entry._id as string);
          }
        }

        packMaps.push({ packId, packLabel: pack.metadata.label as string, nameMap });
      }

      if (packMaps.length === 0) {
        throw new Error(
          'No valid compendium packs available — check the compendiumPacks parameter. ' +
            'Valid pack IDs for D&D 5e: "dnd5e.monsterfeatures" or "dnd5e.classfeatures" (2014), ' +
            '"dnd5e.monsterfeatures24" (2024 monster features). ' +
            'Note: 2024 class features are embedded in class items and cannot be imported with this tool.'
        );
      }

      // ── Phase C: per-feature search + import ─────────────────────────────
      const added: Array<{ name: string; packId: string; packLabel: string; itemId: string }> = [];
      const notFound: string[] = [];
      const failed: Array<{ name: string; error: string }> = [];

      for (const name of unique) {
        const normalizedName = name.toLowerCase();

        // 1. Duplicate check on actor — name-only, any item type
        //    (feature names are semantically unique on an actor regardless of stored type)
        const existing = (actor.items as any[]).find(
          (i: any) => i.name?.toLowerCase() === normalizedName
        );
        if (existing) {
          skipped.push({ name, reason: 'already on actor' });
          continue;
        }

        // 2. Lookup across packs — first-pack-wins
        let found: { packId: string; packLabel: string; entryId: string } | null = null;
        for (const pm of packMaps) {
          const entryId = pm.nameMap.get(normalizedName);
          if (entryId) {
            found = { packId: pm.packId, packLabel: pm.packLabel, entryId };
            break;
          }
        }

        if (!found) {
          notFound.push(name);
          continue;
        }

        // 3. Fetch full document from compendium
        const pack = game.packs.get(found.packId);
        const document = await (pack as any).getDocument(found.entryId);

        if (!document) {
          // Entry was in index but document is missing (shouldn't happen, defensive)
          notFound.push(name);
          warnings.push(
            `"${name}" found in index but document missing in pack "${found.packId}" — skipped`
          );
          continue;
        }

        // 4. Prepare data for embedding
        const featureData = (document as any).toObject() as Record<string, unknown>;
        delete featureData._id; // Let Foundry assign a new local id; prevents id clash

        // 5. Embed individually — per-feature error isolation
        try {
          const [created] = (await actor.createEmbeddedDocuments('Item', [featureData])) as any[];
          added.push({
            name,
            packId: found.packId,
            packLabel: found.packLabel,
            itemId: created.id,
          });
        } catch (embedErr) {
          failed.push({
            name,
            error: embedErr instanceof Error ? embedErr.message : 'Unknown error',
          });
        }
      }

      // ── Phase D: audit + return ───────────────────────────────────────────
      this.auditLog(
        'addFeaturesFromCompendium',
        {
          actorId: actor.id,
          added: added.length,
          skipped: skipped.length,
          notFound: notFound.length,
          failed: failed.length,
        },
        'success'
      );

      return {
        actor: { id: actor.id, name: actor.name },
        added,
        skipped,
        notFound,
        failed,
        warnings,
      };
    } catch (error) {
      console.error(`[${MODULE_ID}] Failed to add features from compendium`, error);
      this.auditLog(
        'addFeaturesFromCompendium',
        { actorIdentifier: data.actorIdentifier },
        'failure',
        error instanceof Error ? error.message : 'Unknown error'
      );
      throw error;
    }
  }

  // ─── Generic actor CRUD ─────────────────────────────────────────────────────

  /**
   * Create one or more actors of any type with arbitrary system data.
   * Works for any Foundry game system — types and system fields are not validated here.
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
    const folderName = params.folder ?? 'Foundry MCP Actors';
    const folderId = await this.getOrCreateFolder(folderName, 'Actor');

    const gameSystemId = (game as any).system?.id ?? '';

    const docs = params.actors.map(a => {
      const doc: Record<string, any> = { name: a.name, type: a.type };
      if (a.img) doc.img = a.img;

      // Merge system data, adding safe defaults for systems that require certain
      // fields to exist during data preparation (avoids non-fatal init errors).
      let systemData: Record<string, any> = a.system ?? {};

      if (gameSystemId === 'mgt2e') {
        // mgt2e's _prepareCreatureData iterates skills.specialities —
        // ensure skills is at least an empty object to prevent a TypeError.
        if (!systemData.skills) {
          systemData = { skills: {}, ...systemData };
        }
        // Normalize skill keys to canonical lowercase (e.g. gunCombat → guncombat)
        // to prevent duplicate entries that the localization system cannot resolve.
        systemData = this.normalizeMGT2eSkillKeys(systemData);

        // ── mgt2e traveller/npc convenience handling ────────────────────────
        // When creating a traveller or npc, accept the same shorthand inputs
        // as the (now-removed) create-mgt2e-traveller tool:
        //   • Skills shorthand: { pilot: 2 } → { pilot: { value:2, trained:true } }
        //   • Skill full object: { pilot: { value:0, trained:true, specialities:{...} } }
        //   • Characteristics: lowercase keys (str/dex/…) normalised to uppercase +
        //     show:true so they appear on the sheet; hits auto-calculated if omitted
        //   • Details → sophont: { details: { career, species, … } } remapped to
        //     system.sophont (system.details does not exist in mgt2e)
        if (a.type === 'traveller' || a.type === 'npc') {
          // 1. Skills: add id, auto-populate specialities, set parent value.
          //    normalizeMGT2eSkillKeys already normalised keys and expanded number shorthands
          //    to {value, trained}; this step adds the createActors-only extras.
          const MGT2E_SKILL_SPECS: Record<string, string[]> = {
            animals: ['handling', 'veterinary', 'training'],
            art: ['performer', 'holography', 'instrument', 'visualMedia', 'write'],
            athletics: ['dexterity', 'endurance', 'strength'],
            drive: ['hovercraft', 'mole', 'track', 'walker', 'wheel'],
            electronics: ['comms', 'computers', 'remoteOps', 'sensors'],
            engineer: ['mDrive', 'jDrive', 'lifeSupport', 'power'],
            flyer: ['airship', 'grav', 'ornithopter', 'rotor', 'wing'],
            gunner: ['turret', 'ortillery', 'screen', 'capital'],
            guncombat: ['archaic', 'energy', 'slug'],
            heavyweapons: ['artillery', 'portable', 'vehicle'],
            melee: ['unarmed', 'blade', 'bludgeon', 'natural'],
            pilot: ['smallCraft', 'spacecraft', 'capitalShips'],
            seafarer: ['oceanShips', 'personal', 'sail', 'submarine'],
            tactics: ['military', 'naval'],
          };
          if (systemData.skills && typeof systemData.skills === 'object') {
            const normSkills: Record<string, any> = {};
            for (const [sk, sv] of Object.entries(systemData.skills as Record<string, any>)) {
              const s =
                sv && typeof sv === 'object' ? (sv as any) : { value: sv ?? 0, trained: true };
              normSkills[sk] = { id: sk, value: s.value ?? 0, trained: s.trained ?? true, ...s };
              // Parent value = min of caller-provided active spec values (before auto-populate).
              if (s.specialities && typeof s.specialities === 'object') {
                const activeValues: number[] = [];
                for (const sd of Object.values(s.specialities as Record<string, any>)) {
                  const v = Number((sd as any)?.value ?? 0);
                  if (v > 0) activeValues.push(v);
                }
                if (activeValues.length > 0) normSkills[sk].value = Math.min(...activeValues);
              }
              // Auto-populate missing specialities (additive only).
              const defaultSpecs = MGT2E_SKILL_SPECS[sk];
              if (defaultSpecs) {
                const existing: Record<string, any> = normSkills[sk].specialities ?? {};
                const merged: Record<string, any> = { ...existing };
                for (const specKey of defaultSpecs) {
                  if (!(specKey in merged)) merged[specKey] = { value: 0, trained: false };
                }
                normSkills[sk].specialities = merged;
              }
            }
            systemData = { ...systemData, skills: normSkills };
          }

          // 2. Characteristics: accept lowercase or uppercase keys,
          //    ensure show:true, calculate hits from STR+DEX+END if missing.
          if (systemData.characteristics && typeof systemData.characteristics === 'object') {
            const normChars: Record<string, any> = {};
            let str = 7,
              dex = 7,
              end = 7;
            for (const [k, v] of Object.entries(
              systemData.characteristics as Record<string, any>
            )) {
              const uk = k.toUpperCase();
              let charVal: number;
              if (typeof v === 'number') {
                charVal = v;
                normChars[uk] = { value: charVal, damage: 0, show: true };
              } else if (v && typeof v === 'object') {
                charVal = (v as any).value ?? 7;
                normChars[uk] = { show: true, ...(v as any) };
                if (normChars[uk].damage === undefined) normChars[uk].damage = 0;
              } else {
                charVal = 7;
                normChars[uk] = { value: charVal, damage: 0, show: true };
              }
              if (uk === 'STR') str = charVal;
              if (uk === 'DEX') dex = charVal;
              if (uk === 'END') end = charVal;
            }
            systemData = { ...systemData, characteristics: normChars };
            if (!systemData.hits) {
              const hitsMax = str + dex + end;
              systemData = { ...systemData, hits: { value: hitsMax, max: hitsMax } };
            }
          }

          // 3. Remap system.details → system.sophont (system.details does not exist in mgt2e)
          if (systemData.details && !systemData.sophont) {
            const d = systemData.details as any;
            const sophont: Record<string, any> = {};
            for (const [k, v] of Object.entries(d)) {
              if (k === 'career') {
                sophont.profession = v;
              } else if (k === 'description') {
                systemData = { ...systemData, description: v };
              } else {
                sophont[k] = v;
              }
            }
            if (Object.keys(sophont).length > 0) systemData = { ...systemData, sophont };
            const { details: _removed, ...rest } = systemData;
            systemData = rest;
          }
        }
      }

      // mgt2e software items: the spacecraft sheet reads i.system.software.bandwidth
      // unconditionally — if the software sub-object is missing the sheet crashes.
      // Inject safe defaults when the caller didn't supply them.
      if (a.type === 'software' && gameSystemId === 'mgt2e' && !systemData.software) {
        systemData = {
          software: { class: 'spacecraft', type: 'generic', interface: 'none', bandwidth: 0 },
          ...systemData,
        };
      }

      doc.system = systemData;
      if (folderId) doc.folder = folderId;
      return doc;
    });

    const created = await Actor.createDocuments(docs as any[]);
    if (!created || created.length === 0) {
      throw new Error('Foundry failed to create actor documents');
    }

    return {
      created: (created as any[]).map(a => ({ id: a.id, name: a.name, type: a.type })),
      total: created.length,
    };
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

  /** Lowercases mgt2e skill keys before createActors processes them. */
  private normalizeMGT2eSkillKeys(system: Record<string, any>): Record<string, any> {
    const result: Record<string, any> = {};
    for (const [key, val] of Object.entries(system)) {
      if (key === 'skills' && val && typeof val === 'object' && !Array.isArray(val)) {
        const normalized: Record<string, any> = {};
        for (const [sk, sv] of Object.entries(val as Record<string, any>)) {
          normalized[sk.toLowerCase()] = sv;
        }
        result['skills'] = normalized;
      } else if (key.startsWith('skills.-=')) {
        result[`skills.-=${key.slice('skills.-='.length).toLowerCase()}`] = val;
      } else if (key.startsWith('skills.')) {
        const rest = key.slice('skills.'.length);
        const dotIdx = rest.indexOf('.');
        const lk =
          dotIdx === -1
            ? rest.toLowerCase()
            : rest.substring(0, dotIdx).toLowerCase() + rest.substring(dotIdx);
        result[`skills.${lk}`] = val;
      } else {
        result[key] = val;
      }
    }
    return result;
  }

  /**
   * Update one or more existing actors by ID.
   * Merges supplied fields into the actor (top-level keys overwrite).
   */
  async updateActors(
    updates: Array<{ id: string; name?: string; img?: string; system?: Record<string, any> }>
  ): Promise<{ updated: Array<{ id: string; name: string }>; total: number }> {
    const updatedActors: Array<{ id: string; name: string }> = [];

    for (const u of updates) {
      const actor = game.actors.get(u.id) as any;
      if (!actor) throw new Error(`Actor not found: ${u.id}`);

      const patch: Record<string, any> = {};
      if (u.name !== undefined) patch.name = u.name;
      if (u.img !== undefined) patch.img = u.img;
      if (u.system !== undefined) {
        // Build a single patch.system nested object so Foundry deep-merges everything
        // in one pass without flat-key vs nested-key conflicts.
        // Dot-notation keys (e.g. "crewed.passengers.-=actorId") are expanded to their
        // nested equivalent — Foundry's mergeObject honours the "-=" deletion operator
        // at any depth in a nested object, just as it does with top-level flat keys.
        const systemPatch: Record<string, any> = {};
        for (const [key, val] of Object.entries(u.system)) {
          if (key.includes('.')) {
            const parts = key.split('.');
            let cur = systemPatch;
            for (let i = 0; i < parts.length - 1; i++) {
              if (!(parts[i] in cur)) cur[parts[i]] = {};
              cur = cur[parts[i]];
            }
            cur[parts[parts.length - 1]] = val;
          } else {
            systemPatch[key] = val;
          }
        }
        patch.system = systemPatch;
      }

      await actor.update(patch);
      updatedActors.push({ id: actor.id, name: u.name ?? actor.name });
    }

    return { updated: updatedActors, total: updatedActors.length };
  }

  /**
   * Update one or more items embedded in an actor.
   */
  async updateActorItems(
    actorIdentifier: string,
    itemUpdates: Array<{ id: string; name?: string; img?: string; system?: Record<string, any> }>
  ): Promise<{ updated: Array<{ id: string; name: string }>; total: number }> {
    const actor =
      (game.actors.get(actorIdentifier) as any) ??
      (game.actors.find(
        (a: any) => a.name?.toLowerCase() === actorIdentifier.toLowerCase()
      ) as any);
    if (!actor) throw new Error(`Actor not found: ${actorIdentifier}`);

    const updated: Array<{ id: string; name: string }> = [];

    for (const u of itemUpdates) {
      const item = actor.items.get(u.id) as any;
      if (!item) throw new Error(`Item ${u.id} not found on actor "${actor.name}"`);

      const patch: Record<string, any> = {};
      if (u.name !== undefined) patch.name = u.name;
      if (u.img !== undefined) patch.img = u.img;
      if (u.system !== undefined) patch.system = u.system;

      await item.update(patch);
      updated.push({ id: item.id, name: u.name ?? item.name });
    }

    return { updated, total: updated.length };
  }

  /**
   * Delete one or more items embedded in an actor.
   */
  async deleteActorItems(
    actorIdentifier: string,
    itemIds: string[]
  ): Promise<{ deleted: string[]; total: number }> {
    const actor =
      (game.actors.get(actorIdentifier) as any) ??
      (game.actors.find(
        (a: any) => a.name?.toLowerCase() === actorIdentifier.toLowerCase()
      ) as any);
    if (!actor) throw new Error(`Actor not found: ${actorIdentifier}`);

    const existing = itemIds.filter(id => actor.items.get(id));
    if (existing.length === 0)
      throw new Error('None of the provided item IDs were found on this actor');

    await actor.deleteEmbeddedDocuments('Item', existing);
    return { deleted: existing, total: existing.length };
  }

  /**
   * Delete one or more actors by ID.
   */
  async deleteActors(ids: string[]): Promise<{ deleted: string[]; total: number }> {
    const existing = ids.filter(id => game.actors.get(id));
    if (existing.length === 0) throw new Error('None of the provided actor IDs were found');

    await Actor.deleteDocuments(existing);
    return { deleted: existing, total: existing.length };
  }

  // ─── mgt2e ──────────────────────────────────────────────────────────────────
}

// =============================================================================
// Shared dnd5e helpers
// =============================================================================

function slugify(name: string, fallback = 'feature'): string {
  return (
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '') || fallback
  );
}

// =============================================================================
// NPC creation helpers — module-level, used exclusively by createNpcActor
// =============================================================================

const NPC_DAMAGE_CANONICAL = new Set([
  'acid',
  'bludgeoning',
  'cold',
  'fire',
  'force',
  'lightning',
  'necrotic',
  'piercing',
  'poison',
  'psychic',
  'radiant',
  'slashing',
  'thunder',
]);

const NPC_CONDITION_CANONICAL = new Set([
  'blinded',
  'charmed',
  'deafened',
  'exhaustion',
  'frightened',
  'grappled',
  'incapacitated',
  'invisible',
  'paralyzed',
  'petrified',
  'poisoned',
  'prone',
  'restrained',
  'stunned',
  'unconscious',
]);

const NPC_SIZE_MAP: Record<string, string> = {
  tiny: 'tiny',
  small: 'sm',
  medium: 'med',
  large: 'lg',
  huge: 'huge',
  gargantuan: 'grg',
};

const NPC_SKILL_MAP: Record<string, string> = {
  Acrobatics: 'acr',
  'Animal Handling': 'ani',
  Arcana: 'arc',
  Athletics: 'ath',
  Deception: 'dec',
  History: 'his',
  Insight: 'ins',
  Intimidation: 'itm',
  Investigation: 'inv',
  Medicine: 'med',
  Nature: 'nat',
  Perception: 'prc',
  Performance: 'prf',
  Persuasion: 'per',
  Religion: 'rel',
  'Sleight of Hand': 'slt',
  Stealth: 'ste',
  Survival: 'sur',
};

function npcNormalizeCR(input: string | number): number {
  if (typeof input === 'number') return input;
  if (input.includes('/')) {
    const [num, den] = input.split('/').map(Number);
    return num / den;
  }
  return parseInt(input, 10);
}

function npcFormatCR(value: number): string {
  if (value === 0) return '0';
  if (value === 0.125) return '1/8';
  if (value === 0.25) return '1/4';
  if (value === 0.5) return '1/2';
  return String(Math.round(value));
}

function npcBuildSkillsBlock(
  skills: Array<{ skill: string; proficiency: string }>
): Record<string, { value: number }> {
  const result: Record<string, { value: number }> = {};
  for (const { skill, proficiency } of skills) {
    const key = NPC_SKILL_MAP[skill];
    if (key) {
      result[key] = { value: proficiency === 'expert' ? 2 : 1 };
    }
  }
  return result;
}

// =============================================================================
// Attack feature helpers — module-level, used exclusively by addAttackToActor
// =============================================================================

const ATTACK_DAMAGE_CANONICAL = new Set([
  'acid',
  'bludgeoning',
  'cold',
  'fire',
  'force',
  'lightning',
  'necrotic',
  'piercing',
  'poison',
  'psychic',
  'radiant',
  'slashing',
  'thunder',
]);

const ATTACK_PROPERTY_CANONICAL = new Set([
  'ada',
  'amm',
  'fin',
  'fir',
  'foc',
  'hvy',
  'lgt',
  'lod',
  'mgc',
  'rch',
  'ret',
  'spc',
  'thr',
  'two',
  'ver',
]);

// =============================================================================
// Aura feature helpers — module-level, used exclusively by addAuraToActor
// =============================================================================

const AURA_DAMAGE_CANONICAL = new Set([
  'acid',
  'bludgeoning',
  'cold',
  'fire',
  'force',
  'lightning',
  'necrotic',
  'piercing',
  'poison',
  'psychic',
  'radiant',
  'slashing',
  'thunder',
]);

// =============================================================================
// Attack+save helpers — module-level, used exclusively by addAttackWithSaveToActor
// =============================================================================

const ATTACK_WITH_SAVE_DAMAGE_CANONICAL = new Set([
  'acid',
  'bludgeoning',
  'cold',
  'fire',
  'force',
  'lightning',
  'necrotic',
  'piercing',
  'poison',
  'psychic',
  'radiant',
  'slashing',
  'thunder',
]);

// =============================================================================
// Spellcasting slot tables — module-level, used by setActorSpellcasting
//
// Each array has 20 entries (index 0 = level 1 … index 19 = level 20).
// Each entry is a 9-element tuple: [L1, L2, L3, L4, L5, L6, L7, L8, L9].
// Source: SRD 5.1 spell slot tables.
// =============================================================================

// prettier-ignore
const FULL_CASTER_SLOTS: number[][] = [
  //  L1  L2  L3  L4  L5  L6  L7  L8  L9
  [   2,   0,   0,   0,   0,   0,   0,   0,   0 ], // level  1
  [   3,   0,   0,   0,   0,   0,   0,   0,   0 ], // level  2
  [   4,   2,   0,   0,   0,   0,   0,   0,   0 ], // level  3
  [   4,   3,   0,   0,   0,   0,   0,   0,   0 ], // level  4
  [   4,   3,   2,   0,   0,   0,   0,   0,   0 ], // level  5
  [   4,   3,   3,   0,   0,   0,   0,   0,   0 ], // level  6
  [   4,   3,   3,   1,   0,   0,   0,   0,   0 ], // level  7
  [   4,   3,   3,   2,   0,   0,   0,   0,   0 ], // level  8
  [   4,   3,   3,   3,   1,   0,   0,   0,   0 ], // level  9
  [   4,   3,   3,   3,   2,   0,   0,   0,   0 ], // level 10
  [   4,   3,   3,   3,   2,   1,   0,   0,   0 ], // level 11
  [   4,   3,   3,   3,   2,   1,   0,   0,   0 ], // level 12
  [   4,   3,   3,   3,   2,   1,   1,   0,   0 ], // level 13
  [   4,   3,   3,   3,   2,   1,   1,   0,   0 ], // level 14
  [   4,   3,   3,   3,   2,   1,   1,   1,   0 ], // level 15
  [   4,   3,   3,   3,   2,   1,   1,   1,   0 ], // level 16
  [   4,   3,   3,   3,   2,   1,   1,   1,   1 ], // level 17
  [   4,   3,   3,   3,   3,   1,   1,   1,   1 ], // level 18
  [   4,   3,   3,   3,   3,   2,   1,   1,   1 ], // level 19
  [   4,   3,   3,   3,   3,   2,   2,   1,   1 ], // level 20
];

// prettier-ignore
/** Paladin / Ranger — half-caster (rounds down). Level 1 = no slots. */
const HALF_CASTER_SLOTS: number[][] = [
  //  L1  L2  L3  L4  L5  L6  L7  L8  L9
  [   0,   0,   0,   0,   0,   0,   0,   0,   0 ], // level  1 — no slots
  [   2,   0,   0,   0,   0,   0,   0,   0,   0 ], // level  2
  [   3,   0,   0,   0,   0,   0,   0,   0,   0 ], // level  3
  [   3,   0,   0,   0,   0,   0,   0,   0,   0 ], // level  4
  [   4,   2,   0,   0,   0,   0,   0,   0,   0 ], // level  5
  [   4,   2,   0,   0,   0,   0,   0,   0,   0 ], // level  6
  [   4,   3,   0,   0,   0,   0,   0,   0,   0 ], // level  7
  [   4,   3,   0,   0,   0,   0,   0,   0,   0 ], // level  8
  [   4,   3,   2,   0,   0,   0,   0,   0,   0 ], // level  9
  [   4,   3,   2,   0,   0,   0,   0,   0,   0 ], // level 10
  [   4,   3,   3,   0,   0,   0,   0,   0,   0 ], // level 11
  [   4,   3,   3,   0,   0,   0,   0,   0,   0 ], // level 12
  [   4,   3,   3,   1,   0,   0,   0,   0,   0 ], // level 13
  [   4,   3,   3,   1,   0,   0,   0,   0,   0 ], // level 14
  [   4,   3,   3,   2,   0,   0,   0,   0,   0 ], // level 15
  [   4,   3,   3,   2,   0,   0,   0,   0,   0 ], // level 16
  [   4,   3,   3,   3,   1,   0,   0,   0,   0 ], // level 17
  [   4,   3,   3,   3,   1,   0,   0,   0,   0 ], // level 18
  [   4,   3,   3,   3,   2,   0,   0,   0,   0 ], // level 19
  [   4,   3,   3,   3,   2,   0,   0,   0,   0 ], // level 20
];

// prettier-ignore
/** Artificer — half-caster (rounds UP). Starts at level 1. Max 5th-level slots. */
const ARTIFICER_SLOTS: number[][] = [
  //  L1  L2  L3  L4  L5  L6  L7  L8  L9
  [   2,   0,   0,   0,   0,   0,   0,   0,   0 ], // level  1
  [   2,   0,   0,   0,   0,   0,   0,   0,   0 ], // level  2
  [   3,   0,   0,   0,   0,   0,   0,   0,   0 ], // level  3
  [   3,   0,   0,   0,   0,   0,   0,   0,   0 ], // level  4
  [   4,   2,   0,   0,   0,   0,   0,   0,   0 ], // level  5
  [   4,   2,   0,   0,   0,   0,   0,   0,   0 ], // level  6
  [   4,   3,   0,   0,   0,   0,   0,   0,   0 ], // level  7
  [   4,   3,   0,   0,   0,   0,   0,   0,   0 ], // level  8
  [   4,   3,   2,   0,   0,   0,   0,   0,   0 ], // level  9
  [   4,   3,   2,   0,   0,   0,   0,   0,   0 ], // level 10
  [   4,   3,   3,   0,   0,   0,   0,   0,   0 ], // level 11
  [   4,   3,   3,   0,   0,   0,   0,   0,   0 ], // level 12
  [   4,   3,   3,   1,   0,   0,   0,   0,   0 ], // level 13
  [   4,   3,   3,   1,   0,   0,   0,   0,   0 ], // level 14
  [   4,   3,   3,   2,   0,   0,   0,   0,   0 ], // level 15
  [   4,   3,   3,   2,   0,   0,   0,   0,   0 ], // level 16
  [   4,   3,   3,   3,   1,   0,   0,   0,   0 ], // level 17
  [   4,   3,   3,   3,   1,   0,   0,   0,   0 ], // level 18
  [   4,   3,   3,   3,   2,   0,   0,   0,   0 ], // level 19
  [   4,   3,   3,   3,   2,   0,   0,   0,   0 ], // level 20
];

// prettier-ignore
/** Warlock Pact Magic — slot count and slot level per warlock level. */
const WARLOCK_PACT_TABLE: Array<{ max: number; level: number }> = [
  { max: 1, level: 1 }, // level  1
  { max: 2, level: 1 }, // level  2
  { max: 2, level: 2 }, // level  3
  { max: 2, level: 2 }, // level  4
  { max: 2, level: 3 }, // level  5
  { max: 2, level: 3 }, // level  6
  { max: 2, level: 4 }, // level  7
  { max: 2, level: 4 }, // level  8
  { max: 2, level: 5 }, // level  9
  { max: 2, level: 5 }, // level 10
  { max: 3, level: 5 }, // level 11
  { max: 3, level: 5 }, // level 12
  { max: 3, level: 5 }, // level 13
  { max: 3, level: 5 }, // level 14
  { max: 3, level: 5 }, // level 15
  { max: 3, level: 5 }, // level 16
  { max: 4, level: 5 }, // level 17
  { max: 4, level: 5 }, // level 18
  { max: 4, level: 5 }, // level 19
  { max: 4, level: 5 }, // level 20
];
