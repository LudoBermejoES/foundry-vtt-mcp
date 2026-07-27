// Extracted from data-access.ts as part of the God-class split (behaviour-preserving).
// See docs/refactor-data-access.md for the module map.
import { MODULE_ID } from './constants.js';
import { FoundrySecurity } from './security.js';
import { ActorResolver } from './actor-resolver.js';

export class ActorDirectory {
  constructor(
    private security: FoundrySecurity,
    private resolver: ActorResolver
  ) {}

  /**
   * List all actors with basic information
   */
  async listActors(): Promise<Array<{ id: string; name: string; type: string; img?: string }>> {
    return game.actors.map(actor => ({
      id: actor.id || '',
      name: actor.name || '',
      type: actor.type,
      ...(actor.img ? { img: actor.img } : {}),
    }));
  }

  /**
   * Get friendly NPCs from current scene
   */
  async getFriendlyNPCs(): Promise<Array<{ id: string; name: string }>> {
    this.security.validateFoundryState();

    try {
      const scene = game.scenes?.find(s => s.active);
      if (!scene) {
        return [];
      }

      const friendlyTokens = scene.tokens.filter(
        (token: any) => token.disposition === 1 // FRIENDLY disposition
      );

      return friendlyTokens
        .map((token: any) => ({
          id: token.actor?.id || token.id || '',
          name: token.name || token.actor?.name || 'Unknown',
        }))
        .filter(t => t.id);
    } catch (error) {
      console.error(`[${MODULE_ID}] Error getting friendly NPCs:`, error);
      return [];
    }
  }

  /**
   * Get party characters (player-owned actors)
   */
  async getPartyCharacters(): Promise<Array<{ id: string; name: string }>> {
    this.security.validateFoundryState();

    try {
      const partyCharacters = Array.from(game.actors || []).filter(
        actor => actor.hasPlayerOwner && actor.type === 'character'
      );

      return partyCharacters
        .map(actor => ({
          id: actor.id || '',
          name: actor.name || 'Unknown',
        }))
        .filter(c => c.id);
    } catch (error) {
      console.error(`[${MODULE_ID}] Error getting party characters:`, error);
      return [];
    }
  }

  /**
   * Get connected players (excluding GM)
   */
  async getConnectedPlayers(): Promise<Array<{ id: string; name: string }>> {
    this.security.validateFoundryState();

    try {
      const connectedPlayers = Array.from(game.users || []).filter(
        user => user.active && !user.isGM
      );

      return connectedPlayers
        .map(user => ({
          id: user.id || '',
          name: user.name || 'Unknown',
        }))
        .filter(u => u.id);
    } catch (error) {
      console.error(`[${MODULE_ID}] Error getting connected players:`, error);
      return [];
    }
  }

  /**
   * Find players by identifier with partial matching
   */
  async findPlayers(data: {
    identifier: string;
    allowPartialMatch?: boolean;
    includeCharacterOwners?: boolean;
  }): Promise<Array<{ id: string; name: string }>> {
    this.security.validateFoundryState();

    try {
      const { identifier, allowPartialMatch = true, includeCharacterOwners = true } = data;
      const searchTerm = identifier.toLowerCase();
      const players = [];

      // Direct user name matching
      for (const user of game.users || []) {
        if (user.isGM) continue;

        const userName = user.name?.toLowerCase() || '';
        if (userName === searchTerm || (allowPartialMatch && userName.includes(searchTerm))) {
          players.push({ id: user.id || '', name: user.name || 'Unknown' });
        }
      }

      // Character name matching (find owner of character)
      if (includeCharacterOwners && players.length === 0) {
        for (const actor of game.actors || []) {
          if (actor.type !== 'character') continue;

          const actorName = actor.name?.toLowerCase() || '';
          if (actorName === searchTerm || (allowPartialMatch && actorName.includes(searchTerm))) {
            // Find the player owner of this character
            const owner = game.users?.find(
              user => actor.testUserPermission(user, 'OWNER') && !user.isGM
            );

            if (owner && !players.some(p => p.id === owner.id)) {
              players.push({ id: owner.id || '', name: owner.name || 'Unknown' });
            }
          }
        }
      }

      return players.filter(p => p.id);
    } catch (error) {
      console.error(`[${MODULE_ID}] Error finding players:`, error);
      return [];
    }
  }

  /**
   * Find every actor carrying a flag at `flagPath`, optionally restricted to a
   * set of exact values and/or an actor type.
   *
   * READ-ONLY. This is the read path that the import's idempotency key used to
   * lack: before it existed, the only way to answer "does an actor with
   * sourceId X already exist?" was to fire the *write* path with
   * `overwrite: false` and see whether it reported `skipped`.
   *
   * CRITICAL — the flag is read by RAW property access, never
   * `actor.getFlag(scope, key)`: `getFlag` throws
   * "Flag scope 'wodchar' is not valid or not currently active" for any scope
   * that is not core / the system id / the world id / an ACTIVE module id, and
   * `wodchar` is none of those. Foundry still stores arbitrary flag scopes as
   * raw document data, so reading it directly is both correct and required.
   * Same rule as the import path (`data-access.ts` `importActors`).
   *
   * Deliberately PLURAL: two actors sharing one flag value is a real failure
   * mode (the import's `find()` makes the second one permanently unreachable),
   * so the caller must be able to see it rather than have it collapsed away.
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
    this.security.validateFoundryState();

    const flagPath = typeof data?.flagPath === 'string' ? data.flagPath.trim() : '';
    if (!/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+){1,3}$/.test(flagPath)) {
      throw new Error(
        `flagPath must be a dotted scope.key path of 2-4 segments (got "${data?.flagPath ?? ''}")`
      );
    }
    const wantValues = Array.isArray(data?.values)
      ? data.values.filter(v => v !== undefined)
      : null;
    if (wantValues === null && data?.exists !== true) {
      throw new Error('either `values` (non-empty) or `exists: true` is required');
    }
    if (wantValues !== null && wantValues.length === 0) {
      throw new Error('either `values` (non-empty) or `exists: true` is required');
    }

    const getProperty = (foundry as any)?.utils?.getProperty;
    const readFlag = (actor: any): unknown =>
      getProperty
        ? getProperty(actor, `flags.${flagPath}`)
        : flagPath.split('.').reduce((acc: any, k: string) => acc?.[k], actor?.flags);

    const wanted = wantValues === null ? null : new Set(wantValues.map(v => String(v)));

    const matches: Array<{
      id: string;
      name: string;
      type: string;
      img?: string;
      folder: string | null;
      flagValue: string;
    }> = [];

    for (const actor of (game.actors as any) || []) {
      if (data.type && actor.type !== data.type) continue;
      const raw = readFlag(actor);
      if (raw === undefined || raw === null || raw === '') continue;
      const flagValue = String(raw);
      if (wanted !== null && !wanted.has(flagValue)) continue;
      matches.push({
        id: actor.id || '',
        name: actor.name || '',
        type: actor.type,
        ...(actor.img ? { img: actor.img } : {}),
        folder: actor.folder?.name ?? null,
        flagValue,
      });
    }

    return { matches, total: matches.length };
  }

  /**
   * Find single actor by identifier
   */
  async findActor(data: { identifier: string }): Promise<{ id: string; name: string } | null> {
    this.security.validateFoundryState();

    try {
      const actor = this.resolver.findActorByIdentifier(data.identifier);
      return actor ? { id: actor.id, name: actor.name } : null;
    } catch (error) {
      console.error(`[${MODULE_ID}] Error finding actor:`, error);
      return null;
    }
  }
}
