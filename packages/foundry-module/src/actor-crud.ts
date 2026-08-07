// Extracted from data-access.ts as part of the God-class split (behaviour-preserving).
// See docs/refactor-data-access.md for the module map.
//
// The actor-CRUD cluster: sixteen methods that create, update, delete and re-own
// Actor documents and the Items embedded in them, plus the token placement that puts
// a freshly created actor onto the active scene. All but one are write paths, so
// nearly every method here pairs a Foundry write with an audit call; they are pinned
// by characterization tests asserting the document handed to Foundry rather than the
// returned envelope (see actor-crud.test.ts).
//
// Depends on exactly four things and holds NO reference to FoundryDataAccess:
// `security` for Foundry-state validation and write auditing, `actorResolver` for
// actor and folder resolution, `permissions` for write-permission checks, and
// `transactionManager` for transaction bookkeeping.
//
// TransactionManager is INJECTED, never imported. transaction-manager.ts used to
// export a ready-made instance alongside its class and data-access.ts was its only
// importer; that export is gone, so the injected path is the only path and a
// regression to the direct import is a compile error. Instance identity matters more
// here than the acyclic-DAG requirement's stated rationale suggests: TransactionManager
// is NOT stateless — it owns activeTransactions and transactionHistory — so two
// instances genuinely diverge rather than behaving identically.
//
// importActors is NOT here: it is a recorded permanent deferral (its failure mode is
// silent duplicate actors under a timed-out request), and it is now the ONLY remaining
// caller of the facade's private getOrCreateFolder wrapper, which is therefore
// permanent. getSystemSchema is not here either — it creates, updates and deletes
// nothing, touches no actor and has zero call-graph edges, so it is not actor CRUD.
//
// setActorOwnership writes ownership with NO audit call, alone among the write paths
// in this module. That is the pre-move behaviour, moved verbatim and pinned as
// observed; adding the audit call would be a behaviour change, not a relocation.
//
// addActorsToScene's `transactionId?` parameter is unreachable through the facade: no
// caller passes one, and nothing calls startTransaction now that the dead-surface
// createActorFromCompendium is deleted. The guarded transaction block moves verbatim
// anyway — removing a parameter from a public signature is a boundary change and a
// recorded follow-up, not part of a relocation.

import { MODULE_ID, ERROR_MESSAGES } from './constants.js';
import { FoundrySecurity } from './security.js';
import { ActorResolver } from './actor-resolver.js';
import { PermissionManager } from './permissions.js';
import { TransactionManager } from './transaction-manager.js';

export interface ActorCreationResult {
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

export interface SceneTokenPlacement {
  actorIds: string[];
  placement: 'random' | 'grid' | 'center' | 'coordinates';
  hidden: boolean;
  coordinates?: { x: number; y: number }[];
}

export interface TokenPlacementResult {
  success: boolean;
  tokensCreated: number;
  tokenIds: string[];
  errors?: string[] | undefined;
}

export class ActorCrud {
  private moduleId: string = MODULE_ID;

  constructor(
    private security: FoundrySecurity,
    private actorResolver: ActorResolver,
    private permissions: PermissionManager,
    private transactionManager: TransactionManager
  ) {}

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
    this.security.validateFoundryState();

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
          const folderId = await this.actorResolver.getOrCreateFolder(
            'Foundry MCP Creatures',
            'Actor'
          );
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

      this.security.auditLog('createActorFromCompendiumEntry', request, 'success');
      return result;
    } catch (error) {
      console.error(`[${MODULE_ID}] Failed to create actor from compendium entry`, error);
      this.security.auditLog(
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
   *
   * `flags` is forwarded VERBATIM onto the created document. It is not
   * decoration: several systems resolve an item's rendered content from its
   * provenance flags rather than from stored text — `worldofdarkness` items
   * exported by wod20-char deliberately ship an EMPTY `system.description`
   * and carry `flags['wod20-char']` so the sheet can resolve the description
   * live from the compendium. Without a way to send `flags`, an item created
   * through this bridge renders with no description at all, which is why the
   * field exists here. Absent `flags` is absent on the document — no empty
   * object is invented — so callers that never pass it are unaffected.
   *
   * `_id` is deliberately NOT accepted: honouring it would require passing
   * `keepId: true` to `createEmbeddedDocuments`, a per-CALL option that
   * applies to the whole batch, and a supplied id colliding with an item the
   * actor already owns is an overwrite hazard whose handling differs across
   * Foundry versions. Nothing needs it; letting Foundry mint the id is safe.
   */
  async addActorItems(params: {
    actorIdentifier: string;
    items: Array<{
      name: string;
      type: string;
      img?: string;
      system?: Record<string, any>;
      flags?: Record<string, any>;
    }>;
  }): Promise<{
    actorId: string;
    actorName: string;
    created: Array<{ id: string; name: string; type: string }>;
  }> {
    this.security.validateFoundryState();

    const { actorIdentifier, items } = params;

    if (!actorIdentifier) {
      throw new Error('actorIdentifier is required');
    }
    if (!Array.isArray(items) || items.length === 0) {
      throw new Error('items array is required and must contain at least one entry');
    }

    const actor = this.actorResolver.findActorByIdentifier(actorIdentifier);
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
      // Unlike `system` (silently dropped when malformed, pinned behaviour), a
      // malformed `flags` is REJECTED. Flags carry provenance the sheet depends
      // on; dropping a bad one would create an item that looks fine and renders
      // empty, which is precisely the failure this field was added to prevent.
      if (it.flags !== undefined) {
        if (it.flags === null || typeof it.flags !== 'object' || Array.isArray(it.flags)) {
          throw new Error(
            `items[${idx}] ("${it.name}"): "flags" must be a plain object when provided`
          );
        }
        doc.flags = it.flags;
      }
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

      this.security.auditLog(
        'addActorItems',
        { actorIdentifier, actorId: actor.id, count: payload.length },
        'success'
      );
      return result;
    } catch (error) {
      this.security.auditLog(
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
    this.security.validateFoundryState();

    const { actorIdentifier, itemIds, itemNames, type } = params;

    if (!actorIdentifier) {
      throw new Error('actorIdentifier is required');
    }
    const hasIds = Array.isArray(itemIds) && itemIds.length > 0;
    const hasNames = Array.isArray(itemNames) && itemNames.length > 0;
    if (!hasIds && !hasNames) {
      throw new Error('Provide itemIds and/or itemNames identifying the items to remove');
    }

    const actor = this.actorResolver.findActorByIdentifier(actorIdentifier);
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
      this.security.auditLog(
        'removeActorItems',
        { actorIdentifier, actorId: actor.id, count: removed.length },
        'success'
      );
      return { actorId: actor.id, actorName: actor.name, removed, notFound };
    } catch (error) {
      this.security.auditLog(
        'removeActorItems',
        { actorIdentifier, actorId: actor.id, count: removed.length },
        'failure',
        error instanceof Error ? error.message : 'Unknown error'
      );
      throw error;
    }
  }

  /**
   * Add actors to the current scene as tokens
   */
  async addActorsToScene(
    placement: SceneTokenPlacement,
    transactionId?: string
  ): Promise<TokenPlacementResult> {
    this.security.validateFoundryState();

    // Use new permission system
    const permissionCheck = this.permissions.checkWritePermission('modifyScene', {
      targetIds: placement.actorIds,
    });

    if (!permissionCheck.allowed) {
      throw new Error(`${ERROR_MESSAGES.ACCESS_DENIED}: ${permissionCheck.reason}`);
    }

    // Audit the permission check
    this.permissions.auditPermissionCheck('modifyScene', permissionCheck, placement);

    const scene = (game.scenes as any).current;
    if (!scene) {
      throw new Error('No active scene found');
    }

    this.security.auditLog('addActorsToScene', placement, 'success');

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
          this.transactionManager.addAction(
            transactionId,
            this.transactionManager.createTokenCreationAction(token.id)
          );
        }
      }

      const result: TokenPlacementResult = {
        success: createdTokens.length > 0,
        tokensCreated: createdTokens.length,
        tokenIds: createdTokens.map((token: any) => token.id),
        ...(errors.length > 0 ? { errors } : {}),
      };

      this.security.auditLog('addActorsToScene', placement, 'success');
      return result;
    } catch (error) {
      this.security.auditLog(
        'addActorsToScene',
        placement,
        'failure',
        error instanceof Error ? error.message : 'Unknown error'
      );
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
   * Set actor ownership permission for a user
   */
  async setActorOwnership(data: {
    actorId: string;
    userId: string;
    permission: number;
  }): Promise<{ success: boolean; message: string; error?: string }> {
    this.security.validateFoundryState();

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
    this.security.validateFoundryState();

    const systemId = (game.system as any).id;
    if (systemId !== 'wfrp4e') {
      return {
        success: false,
        error: `wfrp4e-update-actor requires the WFRP4e system (current: "${systemId}")`,
      };
    }

    // Resolve a world actor by id/name, or a scene token by id (an unlinked
    // token resolves to its own synthetic actor — see findActorByIdentifier).
    const actor = this.actorResolver.findActorByIdentifier(data.actor);
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
      this.security.auditLog(
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

    this.security.auditLog('updateWfrp4eActor', { actor: data.actor }, 'success');

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
    this.security.validateFoundryState();

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

    const actor = this.actorResolver.findActorByIdentifier(data.actor);
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
      this.security.auditLog(
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

    this.security.auditLog(
      'addWfrp4eItems',
      { actor: data.actor, count: created.length },
      'success'
    );

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
    this.security.validateFoundryState();

    try {
      const actors = data.actorIdentifier
        ? data.actorIdentifier === 'all'
          ? Array.from(game.actors || [])
          : [this.actorResolver.findActorByIdentifier(data.actorIdentifier)].filter(Boolean)
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
    this.security.validateFoundryState();

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
      const folderId = await this.actorResolver.getOrCreateFolder('Foundry MCP Creatures', 'Actor');

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

      this.security.auditLog('createNpcActor', { name: data.name, cr: normalizedCR }, 'success');

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
      this.security.auditLog(
        'createNpcActor',
        { name: data.name },
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
    const folderId = await this.actorResolver.getOrCreateFolder(folderName, 'Actor');

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
