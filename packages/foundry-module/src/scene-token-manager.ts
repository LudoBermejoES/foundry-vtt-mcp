// Extracted from data-access.ts as part of the God-class split (behaviour-preserving).
// See docs/refactor-data-access.md for the module map.
//
// Scene listing/switching and token CRUD/condition toggling. `addActorsToScene`
// and `calculateTokenPosition` stay on the facade for now — they are reached
// from the actor-creation flow (createActorFromCompendium*) and are a better
// fit for a future actor-creation module than for this one.
import { ERROR_MESSAGES, TOKEN_DISPOSITIONS } from './constants.js';
import { PermissionManager } from './permissions.js';
import { FoundrySecurity } from './security.js';

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

export class SceneTokenManager {
  constructor(
    private security: FoundrySecurity,
    private permissions: PermissionManager
  ) {}

  /**
   * Get active scene information
   */
  async getActiveScene(): Promise<SceneInfo> {
    const scene = (game.scenes as any).current;
    if (!scene) {
      throw new Error(ERROR_MESSAGES.SCENE_NOT_FOUND);
    }

    const sceneData: SceneInfo = {
      id: scene.id,
      name: scene.name,
      img: scene.img || undefined,
      background: scene._source?.background?.src || undefined,
      width: scene.width,
      height: scene.height,
      padding: scene.padding,
      active: scene.active,
      navigation: scene.navigation,
      tokens: scene.tokens.map((token: any) => ({
        id: token.id,
        name: token.name,
        x: token.x,
        y: token.y,
        width: token.width,
        height: token.height,
        actorId: token.actorId || undefined,
        img: token.texture?.src || '',
        hidden: token.hidden,
        disposition: this.getTokenDisposition(token.disposition),
      })),
      walls: scene.walls.size,
      lights: scene.lights.size,
      sounds: scene.sounds.size,
      notes: scene.notes.map((note: any) => ({
        id: note.id,
        text: note.text || '',
        x: note.x,
        y: note.y,
      })),
    };

    return sceneData;
  }

  /**
   * Get token disposition as number
   */
  getTokenDisposition(disposition: any): number {
    if (typeof disposition === 'number') {
      return disposition;
    }

    // Default to neutral if unknown
    return TOKEN_DISPOSITIONS.NEUTRAL;
  }

  /**
   * List all scenes with filtering options
   */
  async listScenes(
    options: { filter?: string; include_active_only?: boolean } = {}
  ): Promise<any[]> {
    this.security.validateFoundryState();

    try {
      let scenes = game.scenes?.contents || [];

      // Filter by active only if requested
      if (options.include_active_only) {
        scenes = scenes.filter((scene: any) => scene.active);
      }

      // Filter by name if provided
      if (options.filter) {
        const filterLower = options.filter.toLowerCase();
        scenes = scenes.filter((scene: any) => scene.name.toLowerCase().includes(filterLower));
      }

      // Map to consistent format
      return scenes.map((scene: any) => ({
        id: scene.id,
        name: scene.name,
        active: scene.active,
        dimensions: {
          width: scene.dimensions?.width || scene.width || 0,
          height: scene.dimensions?.height || scene.height || 0,
        },
        gridSize: scene.grid?.size || 100,
        background: scene._source?.background?.src || scene.img || '',
        walls: scene.walls?.size || 0,
        tokens: scene.tokens?.size || 0,
        lighting: scene.lights?.size || 0,
        sounds: scene.sounds?.size || 0,
        navigation: scene.navigation || false,
      }));
    } catch (error) {
      throw new Error(
        `Failed to list scenes: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Switch to a different scene
   */
  async switchScene(options: { scene_identifier: string; optimize_view?: boolean }): Promise<any> {
    this.security.validateFoundryState();

    try {
      // Find the target scene by ID or name
      const scenes = game.scenes?.contents || [];
      const targetScene = scenes.find(
        (scene: any) =>
          scene.id === options.scene_identifier ||
          scene.name.toLowerCase() === options.scene_identifier.toLowerCase()
      );

      if (!targetScene) {
        throw new Error(`Scene not found: "${options.scene_identifier}"`);
      }

      // Activate the scene
      await targetScene.activate();

      // Optimize view if requested (default true)
      if (options.optimize_view !== false && typeof canvas !== 'undefined' && canvas?.scene) {
        const dimensions = targetScene.dimensions || {
          width: (targetScene as any).width || 0,
          height: (targetScene as any).height || 0,
        };
        const width = (dimensions as any).width || 0;
        const height = (dimensions as any).height || 0;

        if (width && height) {
          // Center the view on the scene
          await canvas.pan({
            x: width / 2,
            y: height / 2,
            scale: Math.min(
              (canvas as any).screenDimensions?.[0] / width || 1,
              (canvas as any).screenDimensions?.[1] / height || 1,
              1
            ),
          });
        }
      }

      return {
        success: true,
        sceneId: targetScene.id,
        sceneName: targetScene.name,
        dimensions: {
          width: (targetScene.dimensions as any)?.width || (targetScene as any).width || 0,
          height: (targetScene.dimensions as any)?.height || (targetScene as any).height || 0,
        },
      };
    } catch (error) {
      throw new Error(
        `Failed to switch scene: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Get detailed information about a specific entity within a character (item, action, or effect)
   */
  async getCharacterEntity(data: {
    characterIdentifier: string;
    entityIdentifier: string;
  }): Promise<any> {
    this.security.validateFoundryState();

    try {
      // Find the character first
      const actors = game.actors?.contents || [];
      const character = actors.find(
        (actor: any) =>
          actor.id === data.characterIdentifier ||
          actor.name.toLowerCase() === data.characterIdentifier.toLowerCase()
      );

      if (!character) {
        throw new Error(`Character not found: "${data.characterIdentifier}"`);
      }

      // Search in items first (by ID or name)
      const items = character.items?.contents || [];
      let entity = items.find(
        (item: any) =>
          item.id === data.entityIdentifier ||
          item.name.toLowerCase() === data.entityIdentifier.toLowerCase()
      );

      if (entity) {
        return {
          success: true,
          entityType: 'item',
          entity: {
            id: entity.id,
            name: entity.name,
            type: entity.type,
            img: entity.img,
            description: entity.system?.description?.value || entity.system?.description || '',
            system: entity.system,
          },
        };
      }

      // Search in actions (for systems that have actions as separate entities)
      if ((character as any).system?.actions) {
        const actions = Array.isArray((character as any).system.actions)
          ? (character as any).system.actions
          : Object.values((character as any).system.actions || {});

        entity = actions.find(
          (action: any) =>
            action.id === data.entityIdentifier ||
            action.name?.toLowerCase() === data.entityIdentifier.toLowerCase()
        );

        if (entity) {
          return {
            success: true,
            entityType: 'action',
            entity,
          };
        }
      }

      // Search in effects
      const effects = character.effects?.contents || [];
      entity = effects.find(
        (effect: any) =>
          effect.id === data.entityIdentifier ||
          effect.name?.toLowerCase() === data.entityIdentifier.toLowerCase()
      );

      if (entity) {
        return {
          success: true,
          entityType: 'effect',
          entity: {
            id: entity.id,
            name: entity.name || entity.label,
            icon: entity.icon,
            disabled: entity.disabled,
            duration: entity.duration,
            changes: entity.changes,
          },
        };
      }

      throw new Error(
        `Entity not found: "${data.entityIdentifier}" in character "${character.name}"`
      );
    } catch (error) {
      throw new Error(
        `Failed to get character entity: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
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
    this.security.validateFoundryState();

    // Use permission system
    const permissionCheck = this.permissions.checkWritePermission('modifyScene', {
      targetIds: [data.tokenId],
    });

    if (!permissionCheck.allowed) {
      throw new Error(`${ERROR_MESSAGES.ACCESS_DENIED}: ${permissionCheck.reason}`);
    }

    try {
      const scene = (game.scenes as any).current;
      if (!scene) {
        throw new Error('No active scene found');
      }

      const token = scene.tokens.get(data.tokenId);
      if (!token) {
        throw new Error(`Token ${data.tokenId} not found in current scene`);
      }

      // Update token position
      await token.update(
        {
          x: data.x,
          y: data.y,
        },
        { animate: data.animate !== false }
      );

      this.security.auditLog('moveToken', data, 'success');

      return {
        success: true,
        tokenId: token.id,
        tokenName: token.name,
        newPosition: { x: data.x, y: data.y },
        animated: data.animate !== false,
      };
    } catch (error) {
      this.security.auditLog(
        'moveToken',
        data,
        'failure',
        error instanceof Error ? error.message : 'Unknown error'
      );
      throw new Error(
        `Failed to move token: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Update token properties
   */
  async updateToken(data: { tokenId: string; updates: Record<string, any> }): Promise<any> {
    this.security.validateFoundryState();

    // Use permission system
    const permissionCheck = this.permissions.checkWritePermission('modifyScene', {
      targetIds: [data.tokenId],
    });

    if (!permissionCheck.allowed) {
      throw new Error(`${ERROR_MESSAGES.ACCESS_DENIED}: ${permissionCheck.reason}`);
    }

    try {
      const scene = (game.scenes as any).current;
      if (!scene) {
        throw new Error('No active scene found');
      }

      const token = scene.tokens.get(data.tokenId);
      if (!token) {
        throw new Error(`Token ${data.tokenId} not found in current scene`);
      }

      // Filter out undefined values
      const cleanUpdates = Object.fromEntries(
        Object.entries(data.updates).filter(([_, v]) => v !== undefined)
      );

      // Apply updates
      await token.update(cleanUpdates);

      this.security.auditLog(
        'updateToken',
        { tokenId: data.tokenId, updates: cleanUpdates },
        'success'
      );

      return {
        success: true,
        tokenId: token.id,
        tokenName: token.name,
        updatedProperties: Object.keys(cleanUpdates),
      };
    } catch (error) {
      this.security.auditLog(
        'updateToken',
        data,
        'failure',
        error instanceof Error ? error.message : 'Unknown error'
      );
      throw new Error(
        `Failed to update token: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Delete one or more tokens from the scene
   */
  async deleteTokens(data: { tokenIds: string[] }): Promise<any> {
    this.security.validateFoundryState();

    // Use permission system
    const permissionCheck = this.permissions.checkWritePermission('modifyScene', {
      targetIds: data.tokenIds,
    });

    if (!permissionCheck.allowed) {
      throw new Error(`${ERROR_MESSAGES.ACCESS_DENIED}: ${permissionCheck.reason}`);
    }

    try {
      const scene = (game.scenes as any).current;
      if (!scene) {
        throw new Error('No active scene found');
      }

      const deletedTokens: string[] = [];
      const failedTokens: string[] = [];

      for (const tokenId of data.tokenIds) {
        try {
          const token = scene.tokens.get(tokenId);
          if (token) {
            await token.delete();
            deletedTokens.push(tokenId);
          } else {
            failedTokens.push(tokenId);
          }
        } catch (error) {
          failedTokens.push(tokenId);
        }
      }

      this.security.auditLog(
        'deleteTokens',
        { tokenIds: data.tokenIds, deletedCount: deletedTokens.length },
        'success'
      );

      return {
        success: true,
        deletedCount: deletedTokens.length,
        deletedTokens,
        failedTokens: failedTokens.length > 0 ? failedTokens : undefined,
      };
    } catch (error) {
      this.security.auditLog(
        'deleteTokens',
        data,
        'failure',
        error instanceof Error ? error.message : 'Unknown error'
      );
      throw new Error(
        `Failed to delete tokens: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Get detailed information about a token
   */
  async getTokenDetails(data: { tokenId: string }): Promise<any> {
    this.security.validateFoundryState();

    try {
      const scene = (game.scenes as any).current;
      if (!scene) {
        throw new Error('No active scene found');
      }

      const token = scene.tokens.get(data.tokenId);
      if (!token) {
        throw new Error(`Token ${data.tokenId} not found in current scene`);
      }

      // Return flat structure that matches MCP server expectations
      return {
        success: true,
        id: token.id,
        name: token.name,
        x: token.x,
        y: token.y,
        width: token.width,
        height: token.height,
        rotation: token.rotation,
        scale: token.texture?.scaleX || 1,
        alpha: token.alpha,
        hidden: token.hidden,
        disposition: token.disposition,
        elevation: token.elevation,
        lockRotation: token.lockRotation,
        img: token.texture?.src,
        actorId: token.actor?.id,
        actorData: token.actor
          ? {
              name: token.actor.name,
              type: token.actor.type,
              img: token.actor.img,
            }
          : null,
        actorLink: token.actorLink,
      };
    } catch (error) {
      throw new Error(
        `Failed to get token details: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Toggle a status condition on a token
   */
  async toggleTokenCondition(data: {
    tokenId: string;
    conditionId: string;
    active: boolean;
  }): Promise<any> {
    this.security.validateFoundryState();

    // Use permission system
    const permissionCheck = this.permissions.checkWritePermission('modifyScene', {
      targetIds: [data.tokenId],
    });

    if (!permissionCheck.allowed) {
      throw new Error(`${ERROR_MESSAGES.ACCESS_DENIED}: ${permissionCheck.reason}`);
    }

    try {
      const scene = (game.scenes as any).current;
      if (!scene) {
        throw new Error('No active scene found');
      }

      const token = scene.tokens.get(data.tokenId);
      if (!token) {
        throw new Error(`Token ${data.tokenId} not found in current scene`);
      }

      const actor = token.actor;
      if (!actor) {
        throw new Error(`Token ${data.tokenId} has no associated actor`);
      }

      // Get the condition configuration for the game system
      const conditions = (CONFIG as any).statusEffects || [];
      const condition = conditions.find(
        (c: any) =>
          c.id === data.conditionId || c.name?.toLowerCase() === data.conditionId.toLowerCase()
      );

      if (!condition) {
        throw new Error(`Condition not found: ${data.conditionId}`);
      }

      if (data.active) {
        // Add the condition - handle DSA5 and other systems
        const effectData: any = {
          name: condition.name || condition.label || condition.id,
          icon: condition.icon || condition.img,
        };

        // Add statuses for systems that support it (D&D5e, PF2e)
        if (condition.id) {
          effectData.statuses = [condition.id];
        }

        // DSA5-specific: Copy all properties from the condition
        // DSA5 conditions have different structure than D&D5e/PF2e
        if ((game.system as any)?.id === 'dsa5') {
          // For DSA5, use the condition's full data structure
          Object.assign(effectData, {
            flags: condition.flags || {},
            changes: condition.changes || [],
            duration: condition.duration || {},
            origin: condition.origin,
          });
        }

        await actor.createEmbeddedDocuments('ActiveEffect', [effectData]);
      } else {
        // Remove the condition
        const effects = actor.effects?.contents || [];
        const effectsToRemove = effects.filter((effect: any) => {
          // Check by status (D&D5e, PF2e)
          if (effect.statuses?.has(data.conditionId)) {
            return true;
          }
          // Check by name (fallback for all systems including DSA5)
          if (effect.name?.toLowerCase() === data.conditionId.toLowerCase()) {
            return true;
          }
          // Check by label (some systems use label instead of name)
          if (effect.label?.toLowerCase() === data.conditionId.toLowerCase()) {
            return true;
          }
          return false;
        });

        if (effectsToRemove.length > 0) {
          await actor.deleteEmbeddedDocuments(
            'ActiveEffect',
            effectsToRemove.map((e: any) => e.id)
          );
        }
      }

      this.security.auditLog('toggleTokenCondition', data, 'success');

      return {
        success: true,
        tokenId: token.id,
        tokenName: token.name,
        conditionId: data.conditionId,
        conditionName: condition.name || condition.label || condition.id,
        isActive: data.active,
        active: data.active,
        message: data.active
          ? `Applied ${data.conditionId} to ${token.name}`
          : `Removed ${data.conditionId} from ${token.name}`,
      };
    } catch (error) {
      this.security.auditLog(
        'toggleTokenCondition',
        data,
        'failure',
        error instanceof Error ? error.message : 'Unknown error'
      );
      throw new Error(
        `Failed to toggle token condition: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Get all available conditions for the current game system
   */
  async getAvailableConditions(): Promise<any> {
    this.security.validateFoundryState();

    try {
      const conditions = (CONFIG as any).statusEffects || [];

      return {
        success: true,
        gameSystem: game.system?.id,
        conditions: conditions.map((condition: any) => ({
          id: condition.id,
          name: condition.name || condition.label || condition.id,
          icon: condition.icon || condition.img,
          description: condition.description || '',
        })),
      };
    } catch (error) {
      throw new Error(
        `Failed to get available conditions: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }
}
