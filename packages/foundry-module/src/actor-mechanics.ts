// Extracted from data-access.ts as part of the God-class split (behaviour-preserving).
// See docs/refactor-data-access.md for the module map.
//
// The nine actor-mechanics builders: hand-built dnd5e item / effect / spell
// documents handed straight to Foundry's write API. Long, repetitive and
// near-identical to one another by design, which is why they are pinned by
// characterization tests asserting the document rather than the return envelope
// (see actor-mechanics.test.ts).
//
// Depends only on the two cross-cutting leaves it needs: `security` for state
// validation and write auditing, `actor-resolver` for actor lookup. It holds no
// reference to FoundryDataAccess. `addFeaturesFromCompendium` looks like a
// counter-example and is not one: it reaches packs through the global
// `game.packs`, not through the compendium-search cluster.
//
// `createNpcActor` is NOT one of these — it is actor CRUD, and it sits physically
// between addSaveFeatureToActor and addAttackToActor in data-access.ts, so a
// contiguous block excision would have taken it along. It stayed.
import { MODULE_ID } from './constants.js';
import { FoundrySecurity } from './security.js';
import { ActorResolver } from './actor-resolver.js';

export class ActorMechanics {
  constructor(
    private security: FoundrySecurity,
    private actorResolver: ActorResolver
  ) {}

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
    this.security.validateFoundryState();

    const { actorIdentifier, itemIdentifier, targets, options = {} } = params;

    // Find the actor
    const actor = this.actorResolver.findActorByIdentifier(actorIdentifier);
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

      this.security.auditLog(
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
      this.security.auditLog(
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
    this.security.validateFoundryState();

    try {
      // 1. Lookup actor
      const actor = this.actorResolver.findActorByIdentifier(data.actorIdentifier);
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

      this.security.auditLog(
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
      this.security.auditLog(
        'addSaveFeatureToActor',
        { actorIdentifier: data.actorIdentifier, featureName: data.featureName },
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
    this.security.validateFoundryState();

    if ((game.system as any).id !== 'dnd5e') {
      throw new Error('addAttackToActor requires the dnd5e game system');
    }

    try {
      // 1. Resolve actor
      const actor = await this.actorResolver.findActorByIdentifier(data.actorIdentifier);
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

      this.security.auditLog(
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
      this.security.auditLog(
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
    this.security.validateFoundryState();

    if ((game.system as any).id !== 'dnd5e') {
      throw new Error('addAuraToActor requires the dnd5e game system');
    }

    try {
      // 1. Resolve actor
      const actor = await this.actorResolver.findActorByIdentifier(data.actorIdentifier);
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

      this.security.auditLog(
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
      this.security.auditLog(
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
    this.security.validateFoundryState();

    if ((game.system as any).id !== 'dnd5e') {
      throw new Error('addPassiveFeatureToActor requires the dnd5e game system');
    }

    try {
      // 1. Resolve actor
      const actor = await this.actorResolver.findActorByIdentifier(data.actorIdentifier);
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

      this.security.auditLog(
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
      this.security.auditLog(
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
    this.security.validateFoundryState();

    if ((game.system as any).id !== 'dnd5e') {
      throw new Error('addAttackWithSaveToActor requires the dnd5e game system');
    }

    try {
      // 1. Resolve actor
      const actor = await this.actorResolver.findActorByIdentifier(data.actorIdentifier);
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

      this.security.auditLog(
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
      this.security.auditLog(
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
    this.security.validateFoundryState();

    if ((game.system as any).id !== 'dnd5e') {
      throw new Error('setActorSpellcasting requires the dnd5e game system');
    }

    try {
      // 1. Resolve actor
      const actor = this.actorResolver.findActorByIdentifier(data.actorIdentifier);
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

      this.security.auditLog(
        'setActorSpellcasting',
        { actorId: actor.id, cls, lvl, ability },
        'success'
      );

      return {
        actor: { id: actor.id, name: actor.name },
        spellcasting: { ability, slots },
        warnings,
      };
    } catch (error) {
      console.error(`[${MODULE_ID}] Failed to set actor spellcasting`, error);
      this.security.auditLog(
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
    this.security.validateFoundryState();

    if ((game.system as any).id !== 'dnd5e') {
      throw new Error('addSpellsToActor requires the dnd5e game system');
    }

    try {
      // 1. Resolve actor
      const actor = this.actorResolver.findActorByIdentifier(data.actorIdentifier);
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
      this.security.auditLog(
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
      this.security.auditLog(
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
    this.security.validateFoundryState();

    if ((game.system as any).id !== 'dnd5e') {
      throw new Error('addFeaturesFromCompendium requires the dnd5e game system');
    }

    try {
      // 1. Resolve actor
      const actor = this.actorResolver.findActorByIdentifier(data.actorIdentifier);
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
      this.security.auditLog(
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
      this.security.auditLog(
        'addFeaturesFromCompendium',
        { actorIdentifier: data.actorIdentifier },
        'failure',
        error instanceof Error ? error.message : 'Unknown error'
      );
      throw error;
    }
  }
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
