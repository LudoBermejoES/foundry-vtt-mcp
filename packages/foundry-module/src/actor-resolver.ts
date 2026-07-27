// Extracted from data-access.ts as part of the God-class split (behaviour-preserving).
// See docs/refactor-data-access.md for the module map.
//
// Actor/folder lookup helpers shared across nearly every actor-mutating
// concern in the original class (item CRUD, feature/attack builders, WFRP4e
// updates, journal/actor creation). No dependency on FoundryDataAccess state
// beyond the module id.
import { MODULE_ID } from './constants.js';

export class ActorResolver {
  private moduleId: string = MODULE_ID;

  /**
   * Find actor by name or ID
   */
  findActorByIdentifier(identifier: string): any {
    const worldActor =
      game.actors?.get(identifier) ||
      game.actors?.getName(identifier) ||
      Array.from(game.actors || []).find(a =>
        a.name?.toLowerCase().includes(identifier.toLowerCase())
      );
    if (worldActor) return worldActor;

    // Fallback: a scene Token id. For an unlinked token this returns the token's
    // own synthetic (delta-backed) actor, so edits persist to that token alone —
    // the way to tweak one copy on a map without touching the prototype or its
    // siblings. (For a linked token this is the world actor, same as above.)
    for (const scene of (game.scenes as any) || []) {
      const token = scene.tokens?.get(identifier);
      if (token?.actor) return token.actor;
    }
    return undefined;
  }

  /**
   * Get or create a folder for organizing MCP-generated content
   */
  async getOrCreateFolder(
    folderName: string,
    type: 'Actor' | 'JournalEntry'
  ): Promise<string | null> {
    try {
      // Look for existing folder
      const existingFolder = game.folders?.find(
        (f: any) => f.name === folderName && f.type === type
      );

      if (existingFolder) {
        return existingFolder.id;
      }

      // Create appropriate descriptions
      let description = '';
      if (type === 'Actor') {
        if (folderName === 'Foundry MCP Creatures') {
          description = 'Creatures and monsters created via Foundry MCP Bridge';
        } else {
          description = `NPCs and creatures related to: ${folderName}`;
        }
      } else {
        description = `Quest and content for: ${folderName}`;
      }

      // Create new folder
      const folderData = {
        name: folderName,
        type,
        description,
        color: type === 'Actor' ? '#4a90e2' : '#f39c12', // Blue for actors, orange for journals
        sort: 0,
        parent: null,
        flags: {
          'foundry-mcp-bridge': {
            mcpGenerated: true,
            createdAt: new Date().toISOString(),
            questContext: type === 'JournalEntry' ? folderName : undefined,
          },
        },
      };

      const folder = await Folder.create(folderData);
      return folder?.id || null;
    } catch (error) {
      console.warn(`[${this.moduleId}] Failed to create folder "${folderName}":`, error);
      // Return null so items are created without folders rather than failing
      return null;
    }
  }
}
