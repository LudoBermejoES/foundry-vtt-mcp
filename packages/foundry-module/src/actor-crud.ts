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

import { FoundrySecurity } from './security.js';
import { ActorResolver } from './actor-resolver.js';
import { PermissionManager } from './permissions.js';
import { TransactionManager } from './transaction-manager.js';

export class ActorCrud {
  // Staging note, gone by the last commit of this pass: a `private` field TypeScript
  // never reads is a TS6138 error under noUnusedLocals, and this extraction lands in
  // five commits. Each dependency is therefore `protected` until the stage that first
  // reads it, which is where it becomes `private`. The constructor's arity, parameter
  // order, parameter names and types never change, so no construction site is edited
  // more than once.

  constructor(
    protected security: FoundrySecurity,
    protected actorResolver: ActorResolver,
    protected permissions: PermissionManager,
    protected transactionManager: TransactionManager
  ) {}

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
