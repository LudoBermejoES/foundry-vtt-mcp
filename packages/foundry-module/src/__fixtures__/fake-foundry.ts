/**
 * ONE shared fake Foundry world for this package's tests.
 *
 * `import-actors.test.ts` and `actor-read-path.test.ts` each built their own
 * near-identical harness on `globalThis`. This is that harness, factored out, as
 * the prerequisite for characterizing the rest of `data-access.ts` (see
 * `docs/refactor-data-access-stage2.md`, "Cheapest tests worth adding first" #1).
 *
 * The whole approach works because the module only reaches for `game` / `Actor` /
 * `Folder` / `Hooks` / `foundry.utils` AT CALL TIME (plus `Hooks.on` in one
 * constructor), so installing fakes on `globalThis` lets a test drive the REAL
 * implementation.
 *
 * ── Load-bearing properties, deliberately preserved ──────────────────────────
 *
 * 1. `getFlag` on every fake actor THROWS, exactly as Foundry does for a flag
 *    scope that is not core / the system id / the world id / an ACTIVE module id.
 *    `wodchar` is none of those. Any code path that reaches for `getFlag()`
 *    therefore fails a test instead of failing production. (Came from
 *    `actor-read-path.test.ts`; `import-actors.test.ts` installed the same throw
 *    by hand in one test. Unified: it is now always on.)
 *
 * 2. `game.scenes` DOES NOT EXIST unless a test explicitly asks for it via
 *    `activeScene`. That is the structural version of "reading actor art needs no
 *    token placed on a scene" — do not add a default, it would silently retire an
 *    assertion. `ActorResolver.findActorByIdentifier` iterates `game.scenes || []`
 *    and so copes with the absence on purpose.
 *
 * ── Reconciled differences between the two original harnesses ────────────────
 *
 * | thing                | kept                          | why                    |
 * | -------------------- | ----------------------------- | ---------------------- |
 * | `Actor.create`       | really creates (import-actors) | read-path only ever asserted that NOTHING was written, and `writes` still proves that |
 * | `Folder.create`      | really creates (import-actors) | same                   |
 * | `actor.update`       | mutates via Object.assign     | import-actors asserts the post-update `folder`; read-path never updates |
 * | `game.actors`        | ONE live array + `get`/`getName` | import-actors needs `Actor.create` pushes to be visible; read-path needs `get`/`find`; `ActorResolver` needs `getName` |
 * | `getFlag`            | always throws                 | see (1) above          |
 * | recorders            | union of both                 | `writes` (read-path's single log) AND the granular `createCalls`/`updateCalls`/`folderCreateCalls` (import-actors') |
 *
 * Additive on top of both (nothing existing depends on these, they exist for the
 * mechanics-builder characterization tests): `game.packs`, `ChatMessage`,
 * `game.user.updateTokenTargets`, `foundry.utils.randomID` (DETERMINISTIC),
 * `game.world.setFlag`/`getFlag` so `FoundrySecurity.auditLog` is observable,
 * `createEmbeddedDocuments` recording, and a selectable `game.system.id`.
 *
 * ── Additive for the compendium/creature-search characterization tests ────────
 *
 * `game.packs` existed but only far enough for the mechanics builders, which
 * reach a pack index and `getDocument().toObject()` and nothing else. The search
 * cluster reaches further, so four things are added, all additive:
 *
 * 1. `pack.metadata.system` / `.private` — `getAvailablePacks` returns them.
 * 2. `pack.getDocument()` now returns a document whose FIELDS are own properties
 *    (`id`, `name`, `type`, `img`, `system`, `items`, `effects`) as well as a
 *    `toObject()`. `getCompendiumDocumentFull` reads the fields directly; the
 *    mechanics builders only ever called `toObject()`, which is unchanged.
 * 3. `pack.getDocuments()` (plural) — how `PersistentCreatureIndex` loads a pack.
 * 4. `game.settings.get` — `searchCompendium` and `listCreaturesByCriteria` both
 *    consult `enableEnhancedCreatureIndex`. Unset reads as `undefined`, i.e.
 *    disabled, which is the basic-search path.
 *
 * Plus a fake world FILE STORE (`foundry.applications.apps.FilePicker` +
 * `fetch`), because `PersistentCreatureIndex` persists the enhanced creature
 * index as JSON in the world directory. That is what makes "rebuild through the
 * facade, then read through the facade, and observe the rebuild" a real
 * round-trip rather than a stub. `creatureIndex` seeds a valid persisted index
 * (fingerprints computed exactly as `generatePackFingerprint` does, so
 * `isIndexValid` accepts it); `failIndexWrite` makes the upload fail, which is
 * how a rebuild is made to throw and the fallback search path is reached.
 *
 * `world.hooks` records every `Hooks.on`/`once` registration. That is not
 * decoration: `PersistentCreatureIndex`'s constructor is the ONLY thing in this
 * package that registers `createDocument`/`createCompendium`, so counting those
 * registrations counts the live index instances.
 *
 * ── Additive for the actor-CRUD characterization tests ───────────────────────
 *
 * The actor-CRUD cluster writes through five Foundry entry points none of the
 * three earlier test files reached, so five things are added — all additive, and
 * all recording their payload rather than returning a canned value:
 *
 * 1. **A real `Scene`.** `game.scenes.current` now carries `grid.size`, `width`,
 *    `height` and a recording `createEmbeddedDocuments`, because
 *    `addActorsToScene` writes Token documents to it and
 *    `calculateTokenPosition` reads all three geometry fields. `activeScene` is
 *    still opt-in — its ABSENCE is load-bearing for the art tests (see (2) in
 *    the header above) — but when asked for it is now a scene you can write to.
 *    `scene.tokens` gained a Collection `get`, which is what
 *    `ActorResolver.findActorByIdentifier`'s token fallback actually calls.
 * 2. **`Actor.createDocuments` and `Actor.deleteDocuments`.** `createActors`
 *    uses the plural create and `deleteActors` the plural delete; neither
 *    existed. `createDocuments` records into the SAME `createCalls` recorder as
 *    the singular `Actor.create`, so a document assertion reads the same way
 *    whichever entry point built it; `deleteDocuments` records into
 *    `actorDeletes`.
 * 3. **`actor.updateEmbeddedDocuments`** (`updateWfrp4eActor`,
 *    `addWfrp4eItems`), and `update()` on every embedded item
 *    (`updateActorItems`). Both record, and both EXPAND dotted keys
 *    (`system.advances.value`) into nested state the way Foundry does — which
 *    matters because the wfrp4e methods read the item back after writing and
 *    report what they read.
 * 4. **`actor.items` is a Collection**, not a bare array: `removeActorItems`,
 *    `updateActorItems`, `deleteActorItems` and `addWfrp4eItems` all call
 *    `actor.items.get(id)`. `get` is non-enumerable, so the array still
 *    spreads, clones and deep-equals exactly as before.
 * 5. **`game.users`, `actor.ownership` and `actor.testUserPermission`.**
 *    `setActorOwnership` writes an ownership map and `getActorOwnership` reads
 *    one back through `testUserPermission`, which is implemented here the way
 *    Foundry implements it (per-user entry, else `default`, else NONE) rather
 *    than stubbed per test.
 *
 * `game.packs` and each pack's `index` are now Collections rather than plain
 * `Map`s — same `get`/`size`/`values()`, but iterating them yields VALUES, which
 * is what Foundry's `Collection` does and what `addWfrp4eItems` relies on
 * (`Array.from(game.packs)`, `for (const entry of index)`). Every other reader in
 * the package already goes through `.values()` explicitly, so nothing else moves.
 *
 * Plus two system-shaped actor builders, `makeWfrp4eActor` and `makeMgt2eActor`,
 * because `updateWfrp4eActor`/`addWfrp4eItems` are 461 lines that only run
 * against a wfrp4e-shaped `system` + skill/career items, and `createActors`
 * branches on `game.system.id === 'mgt2e'`.
 *
 * ── Additive for the character-reading characterization tests ────────────────
 *
 * The character-reading cluster (`getCharacterInfo`, `searchCharacterItems`,
 * `extractSpellcastingData` and its six helpers) contains TWO four-way
 * `systemId` dispatches — pf2e / dnd5e / dsa5 / wfrp4e — and the fixture had
 * actor builders for exactly one of the four. Three of the four arms were
 * therefore unreachable. Added, all additive, nothing existing changed:
 *
 * 1. **`makePf2eActor` / `makeDnd5eActor` / `makeDsa5Actor`**, alongside the
 *    wfrp4e and mgt2e builders that were already here. Each assembles the
 *    `system` shape and the item list its arm of the dispatch reads, and
 *    nothing more — a pf2e actor is not a dnd5e actor with a different
 *    `game.system.id`, which is the whole reason a per-branch case is required.
 * 2. **Item builders for the four systems' spells** (`pf2eSpell`,
 *    `pf2eSpellcastingEntry`, `dnd5eSpell`, `dnd5eClass`, `dsa5Spell`,
 *    `wfrp4eSpell`, `wfrp4ePrayer`). The read cluster's helpers dig through
 *    `system.level.value` vs `system.rank`, `system.location.value` vs a bare
 *    `system.location`, `system.range.value` vs `system.Reichweite`, and
 *    `_source.system.preparation.prepared` vs `system.prepared` — every one of
 *    those `??`/`||` chains is a branch, so each alternative is settable
 *    INDEPENDENTLY rather than folded into one convenient shape.
 * 3. **`makeEffect` plus an `effects` option on `makeActor`.** `actor.effects`
 *    was always `[]`, so `getCharacterInfo`'s effect mapping — including its
 *    three-way duration merge, `duration.units ?? _source.duration.type ??
 *    'none'` — had nothing to map. The live `duration` and the `_source`
 *    duration are settable separately because the merge is invisible unless
 *    they disagree.
 * 4. **A `spellcasting` option on `makeActor`.** PF2e's entry list is
 *    `actor.spellcasting?.contents || actor.items.filter(type ===
 *    'spellcastingEntry')`; without the first the `||` never resolves left.
 * 5. **`makeWfrp4eActor` gained `spells` / `prayers` / `items`.** It built
 *    skill and career items only, which is all the CRUD cluster needed; the
 *    wfrp4e spellcasting arm groups spells by lore and prayers by god.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// ─── Shapes ───────────────────────────────────────────────────────────────────

/** `actor.items` is a Foundry Collection too: iterable, indexed AND keyed. */
export type FakeItemCollection = any[] & { get: (id: string) => any };

export interface FakeActor {
  id: string;
  name: string;
  type: string;
  system: Record<string, any>;
  img?: string;
  flags: Record<string, any>;
  folder?: { name: string; id?: string } | string | null;
  items: FakeItemCollection;
  effects: any[];
  /** Foundry's per-user permission map. `setActorOwnership` rewrites it. */
  ownership?: Record<string, number>;
  /**
   * PF2e's own actor-level spellcasting collection. `extractSpellcastingData`
   * prefers `actor.spellcasting.contents` and falls back to filtering
   * `spellcastingEntry` items, so the left side of that `||` needs to exist to
   * be reachable at all.
   */
  spellcasting?: { contents: any[] };
  /**
   * A DataModel in Foundry: its schema fields are NOT own enumerable
   * properties, so a reader has to go through `toObject()`. `tokenOverride`
   * installs one that does NOT — `extractTokenArt` sanitises the live object
   * instead when `toObject` is missing, which is its other branch.
   */
  prototypeToken?: { toObject?: () => any } & Record<string, any>;
  /** Throws, on purpose. See load-bearing property (1). */
  getFlag: (scope: string, key: string) => never;
  update: (patch: Record<string, any>) => Promise<void>;
  createEmbeddedDocuments: (type: string, docs: any[]) => Promise<any[]>;
  updateEmbeddedDocuments: (type: string, updates: any[]) => Promise<any[]>;
  deleteEmbeddedDocuments: (type: string, ids: string[]) => Promise<void>;
  /** Foundry's own rule: the user's own entry, else `default`, else NONE. */
  testUserPermission: (user: { id: string }, level: string) => boolean;
}

export interface FakeUser {
  id: string;
  name: string;
  isGM: boolean;
  active?: boolean;
}

export type FakeUserCollection = FakeUser[] & {
  get: (id: string) => FakeUser | undefined;
  getName: (name: string) => FakeUser | undefined;
};

export interface FakeFolder {
  id: string;
  name: string;
  type: string;
}

/** `game.actors` is a Foundry Collection: iterable, indexed, AND keyed. */
export type FakeActorCollection = FakeActor[] & {
  get: (id: string) => FakeActor | undefined;
  getName: (name: string) => FakeActor | undefined;
};

export interface AuditEntry {
  operation: string;
  data: Record<string, any>;
  result: 'success' | 'failure';
  error?: string;
}

export interface EmbeddedCreateCall {
  actorId: string;
  type: string;
  docs: Record<string, any>[];
}

export interface UpdateCall {
  id: string;
  patch: Record<string, any>;
}

export interface EmbeddedUpdateCall {
  actorId: string;
  type: string;
  updates: Record<string, any>[];
}

export interface SceneTokenCreateCall {
  sceneId: string;
  type: string;
  docs: Record<string, any>[];
}

export interface FakePackEntry {
  _id: string;
  name: string;
  /**
   * Index-entry fields. A real pack index carries whatever `fields` were asked
   * for; `searchCompendium` reads `type`, `img` and `description` off it.
   */
  type?: string;
  img?: string;
  description?: string;
  /** Full document data returned by `pack.getDocument()`. Omit for "index-only". */
  doc?: Record<string, any>;
  /**
   * `document.documentName` — the Foundry document CLASS, not the actor type.
   * `createActorFromCompendiumEntry` rejects anything that is not `'Actor'`.
   * Set as an own property of the document rather than folded into `doc`, so it
   * does not appear in `toObject()`.
   */
  documentName?: string;
}

export interface FakePackSpec {
  id: string;
  label?: string;
  /** Foundry pack document type. Anything but `'Item'` is rejected by the callers. */
  type?: string;
  entries: FakePackEntry[];
  /** Start out already indexed, so `getIndex()` is not called. */
  indexed?: boolean;
  /** `pack.metadata.system` — echoed by `getAvailablePacks`. */
  system?: string;
  /** `pack.metadata.private` — echoed by `getAvailablePacks`. */
  private?: boolean;
}

export interface FakeToken {
  id: string;
  name?: string;
  actorId?: string;
  actor?: { id: string; name: string };
}

export interface FakeWorld {
  /** Live collection — `Actor.create` pushes into THIS array. */
  actors: FakeActorCollection;
  folders: FakeFolder[];
  /** Documents handed to `Actor.create`, cloned at call time. */
  createCalls: Record<string, any>[];
  /** Names of folders `Folder.create` was called for. */
  folderCreateCalls: string[];
  /** Ids of actors `update()` was called on (import-actors' recorder). */
  updateCalls: string[];
  /** The same updates with their patch, for field-by-field assertions. */
  updates: UpdateCall[];
  /** Every `createEmbeddedDocuments` call, docs cloned at call time. */
  embeddedCreates: EmbeddedCreateCall[];
  embeddedDeletes: Array<{ actorId: string; type: string; ids: string[] }>;
  /** Every `actor.updateEmbeddedDocuments` call, updates cloned at call time. */
  embeddedUpdates: EmbeddedUpdateCall[];
  /** Every embedded `item.update()` call — `updateActorItems`' write. */
  itemUpdates: UpdateCall[];
  /**
   * Batch sizes handed to `Actor.createDocuments`, in order. The documents
   * themselves land in `createCalls`, one entry each, alongside `Actor.create`'s.
   */
  createDocumentsBatches: number[];
  /** Id arrays handed to `Actor.deleteDocuments`, in order. */
  actorDeletes: string[][];
  /** Token documents handed to `scene.createEmbeddedDocuments`, cloned. */
  sceneTokenCreates: SceneTokenCreateCall[];
  /** Chat messages created via the `ChatMessage` global. */
  chatMessages: Record<string, any>[];
  /** What `FoundrySecurity.auditLog` persisted. */
  audit: AuditEntry[];
  /** Ids handed out by `foundry.utils.randomID`, in order. */
  randomIds: string[];
  /** `pack.getIndex()` calls, by pack id — proves the index is built once. */
  packIndexCalls: string[];
  /** `pack.getDocuments()` calls, by pack id. */
  packDocumentsCalls: string[];
  /** Every `Hooks.on` / `Hooks.once` registration, by hook name, in order. */
  hooks: string[];
  /** The fake world file store: path → parsed JSON. */
  files: Map<string, any>;
  /** Paths handed to `FilePicker.upload`, in order. */
  fileUploads: string[];
  /** Paths `fetch` was called for, in order. */
  fileFetches: string[];
  /** `ui.notifications` messages, as `<level>:<message>`. */
  notifications: string[];
  /** Token-id arrays passed to `game.user.updateTokenTargets`. */
  targetUpdates: string[][];
  /**
   * Read-path's single write log: `create:<name>`, `folder:<name>`,
   * `update:<id>:<patch keys>`, `embedCreate:<id>:<n>`, `embedDelete:<id>:<n>`,
   * plus `embedUpdate:<id>:<n>`, `itemUpdate:<id>`, `deleteActors:<n>` and
   * `sceneTokens:<n>`. A read-only operation must leave this EMPTY.
   */
  writes: string[];
  /** Names `Actor.create` should refuse (return null) for. */
  refuse: Set<string>;
  /** Names `Actor.create` should throw for. */
  explode: Set<string>;
  /** Item names `createEmbeddedDocuments` should throw for. */
  failEmbed: Set<string>;
  /** Make `scene.createEmbeddedDocuments` throw — the token-write failure path. */
  failSceneTokens: boolean;
  /** Make every `actor.update()` throw — the wfrp4e write-failure path. */
  failActorUpdate: boolean;
}

export interface InstallOptions {
  actors?: FakeActor[];
  /** `game.system.id`. Defaults to the WoD system both original harnesses used. */
  systemId?: string;
  isGM?: boolean;
  packs?: FakePackSpec[];
  /**
   * `game.users`. The active GM (`game.user`) is NOT added automatically — pass
   * it if the code under test enumerates users, because `getActorOwnership`
   * filters GMs out and "no non-GM users" is a real branch.
   */
  users?: FakeUser[];
  /**
   * `game.system.documentTypes.Item` — the system's declared Item types.
   * UNSET means the key is absent, which `addActorItems` reads as "this system
   * declares nothing, so validate no types". Both branches are real.
   */
  itemTypes?: string[];
  /** `game.settings.get(<any scope>, key)` values. Unset keys read `undefined`. */
  settings?: Record<string, any>;
  /**
   * Seed a VALID persisted enhanced creature index, exactly as
   * `PersistentCreatureIndex.savePersistedIndex` would have written it — so
   * `getEnhancedIndex()` loads it instead of rebuilding. Pack fingerprints are
   * computed the way `generatePackFingerprint` computes them, so `isIndexValid`
   * accepts the file whatever packs are installed.
   */
  creatureIndex?: {
    creatures: any[];
    /** Defaults to `systemId` — they must match or the index is invalidated. */
    gameSystem?: string;
    /** Defaults to the current `'1.0.0'`. */
    version?: string;
  };
  /**
   * Make the index-file upload fail. `savePersistedIndex` then throws, so a
   * rebuild rejects — which is how the creature-search failure/fallback path is
   * reached without stubbing anything.
   */
  failIndexWrite?: boolean;
  /**
   * Installs `game.scenes` — WITHOUT this, `game.scenes` is undefined, which is a
   * load-bearing property of the art tests. Only pass it when the code under test
   * genuinely needs a scene (e.g. `useItem` targeting, `addActorsToScene`).
   *
   * The geometry fields feed `calculateTokenPosition` and are what the token
   * coordinates it writes are computed from, so they default to values that make
   * the arithmetic legible (grid 100, canvas 1000×800) rather than to Foundry's.
   */
  activeScene?: {
    tokens: FakeToken[];
    /** `scene.grid.size`. Omit for 100; pass `null` for no grid at all. */
    gridSize?: number | null;
    width?: number;
    height?: number;
  };
}

// ─── State ────────────────────────────────────────────────────────────────────

let world: FakeWorld;
let nextId = 0;

function makeCollection(actors: FakeActor[]): FakeActorCollection {
  const collection = actors as FakeActorCollection;
  // Non-enumerable so spreads / Array.from / structuredClone of the array are
  // unaffected; `find` is already Array.prototype.find with the same signature
  // Foundry's Collection exposes.
  Object.defineProperty(collection, 'get', {
    value: (id: string) => collection.find(a => a.id === id),
    enumerable: false,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(collection, 'getName', {
    value: (name: string) => collection.find(a => a.name === name),
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return collection;
}

function makeUserCollection(users: FakeUser[]): FakeUserCollection {
  return makeCollection(users as any) as unknown as FakeUserCollection;
}

/**
 * Give an array Foundry's `Collection.get`. Non-enumerable, so the array still
 * spreads, `structuredClone`s and deep-equals exactly as a bare array does —
 * which is why adding this to `actor.items` and `scene.tokens` changes no
 * existing assertion.
 */
function attachGet<T extends { id?: string }>(items: T[]): T[] & { get: (id: string) => any } {
  Object.defineProperty(items, 'get', {
    value: (id: string) => items.find(i => (i as any)?.id === id),
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return items as T[] & { get: (id: string) => any };
}

/**
 * A Foundry `Collection`: a `Map` whose ITERATOR yields values, not entries.
 * `game.packs` and `pack.getIndex()` are both Collections in Foundry, and
 * `addWfrp4eItems` relies on it (`Array.from(game.packs)`,
 * `for (const entry of index)`). A plain `Map` there would silently yield
 * `[key, value]` pairs and match nothing.
 */
class FakeFoundryCollection<V> extends Map<string, V> {
  override [Symbol.iterator](): any {
    return this.values();
  }
}

/**
 * Foundry's `mergeObject` dotted-key expansion, as far as the actor-CRUD paths
 * need it: `{'system.advances.value': 3}` becomes nested state. Used by
 * `updateEmbeddedDocuments` and by embedded `item.update()`, both of which the
 * wfrp4e methods write with dotted keys and then READ BACK to build their
 * response — so without expansion the read-back would pin fixture behaviour
 * rather than the method's.
 */
function applyPatch(target: Record<string, any>, patch: Record<string, any>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (!key.includes('.')) {
      target[key] = value;
      continue;
    }
    const parts = key.split('.');
    let cursor: Record<string, any> = target;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (typeof cursor[part] !== 'object' || cursor[part] === null) cursor[part] = {};
      cursor = cursor[part] as Record<string, any>;
    }
    cursor[parts[parts.length - 1]] = value;
  }
}

/**
 * `Document#testUserPermission`, as Foundry implements it: the user's own
 * ownership entry wins, then `default`, then NONE. Reproduced rather than
 * stubbed per test, because `getActorOwnership` calls it three times per user
 * and a stub would let a swapped level pass unnoticed.
 */
const OWNERSHIP_LEVELS: Record<string, number> = {
  NONE: 0,
  LIMITED: 1,
  OBSERVER: 2,
  OWNER: 3,
};

function testUserPermissionOf(
  ownership: Record<string, number> | undefined,
  user: { id: string },
  level: string
): boolean {
  const map = ownership ?? {};
  const held = map[user.id] ?? map.default ?? 0;
  return held >= (OWNERSHIP_LEVELS[level] ?? 0);
}

/** Attach a recording `update()` to an embedded item document. */
function attachItemUpdate(item: Record<string, any>): void {
  if (!item || typeof item !== 'object' || typeof item.update === 'function') return;
  Object.defineProperty(item, 'update', {
    value: async (patch: Record<string, any>) => {
      world.itemUpdates.push({ id: item.id as string, patch: structuredClone(patch) });
      world.writes.push(`itemUpdate:${item.id as string}`);
      applyPatch(item, patch);
    },
    enumerable: false,
    configurable: true,
    writable: true,
  });
}

// ─── Actors ───────────────────────────────────────────────────────────────────

function throwingGetFlag(scope: string, key: string): never {
  throw new Error(`Flag scope '${scope}' is not valid or not currently active (key ${key})`);
}

function attachWriteMethods(actor: FakeActor): void {
  attachGet(actor.items);
  for (const item of actor.items) attachItemUpdate(item);
  actor.update = async patch => {
    world.updateCalls.push(actor.id);
    world.updates.push({ id: actor.id, patch: structuredClone(patch) });
    world.writes.push(`update:${actor.id}:${Object.keys(patch).join(',')}`);
    if (world.failActorUpdate) {
      throw new Error(`Foundry refused to update ${actor.name}`);
    }
    Object.assign(actor, patch);
  };
  actor.createEmbeddedDocuments = async (type, docs) => {
    world.embeddedCreates.push({ actorId: actor.id, type, docs: structuredClone(docs) });
    world.writes.push(`embedCreate:${actor.id}:${docs.length}`);
    const blocked = docs.find(d => typeof d?.name === 'string' && world.failEmbed.has(d.name));
    if (blocked) {
      throw new Error(`Foundry refused to embed "${blocked.name as string}"`);
    }
    const created = docs.map(d => ({
      ...d,
      id: `item-${nextId++}`,
      // Foundry ids are exposed as both `id` and `_id` on a real document.
      _id: `item-${nextId - 1}`,
    }));
    for (const item of created) attachItemUpdate(item);
    actor.items.push(...created);
    return created;
  };
  actor.updateEmbeddedDocuments = async (type, updates) => {
    world.embeddedUpdates.push({ actorId: actor.id, type, updates: structuredClone(updates) });
    world.writes.push(`embedUpdate:${actor.id}:${updates.length}`);
    const touched: any[] = [];
    for (const u of updates) {
      const item = actor.items.get(u._id as string);
      if (!item) continue;
      const patch = Object.fromEntries(
        Object.entries(u as Record<string, any>).filter(([k]) => k !== '_id')
      );
      applyPatch(item as Record<string, any>, patch);
      touched.push(item);
    }
    return touched;
  };
  actor.deleteEmbeddedDocuments = async (type, ids) => {
    world.embeddedDeletes.push({ actorId: actor.id, type, ids: [...ids] });
    world.writes.push(`embedDelete:${actor.id}:${ids.length}`);
    actor.items = attachGet(actor.items.filter((i: any) => !ids.includes(i.id)));
  };
  actor.testUserPermission = (user, level) => testUserPermissionOf(actor.ownership, user, level);
}

/**
 * A world actor. Ids are derived from the name so they can be asserted literally
 * (`makeActor('Lena').id === 'Lena000000000000'`).
 */
export function makeActor(
  name: string,
  opts: {
    img?: string;
    flags?: Record<string, any>;
    /** `null` = no prototypeToken at all; omitted = a default token texture. */
    tokenSrc?: string | null;
    /**
     * `prototypeToken.ring`. Defaults to `null`, which `extractTokenArt` drops;
     * a value is what makes it sanitise and emit one.
     */
    tokenRing?: Record<string, any> | null;
    /**
     * Replaces the constructed `prototypeToken` wholesale — for a token that is
     * a plain object with no `toObject`, or whose `toObject` returns a
     * non-object, or that carries no `texture` at all. Each is a real branch of
     * `extractTokenArt` and none is reachable through the default shape.
     */
    tokenOverride?: Record<string, any>;
    type?: string;
    folder?: string | null;
    items?: any[];
    /** ActiveEffects. Built with `makeEffect`; `[]` unless a test asks. */
    effects?: any[];
    system?: Record<string, any>;
    /** Foundry's ownership map, e.g. `{ 'user-2': 3, default: 0 }`. */
    ownership?: Record<string, number>;
    /** PF2e's `actor.spellcasting.contents`. See the note on `FakeActor`. */
    spellcasting?: { contents: any[] };
  } = {}
): FakeActor {
  const actor: FakeActor = {
    id: name.padEnd(16, '0').slice(0, 16),
    name,
    type: opts.type ?? 'PC',
    system: opts.system ?? { settings: { splat: 'mortal', haswillpower: true }, attributes: {} },
    ...(opts.img !== undefined ? { img: opts.img } : {}),
    flags: opts.flags ?? {},
    folder: opts.folder !== undefined ? (opts.folder ? { name: opts.folder } : null) : null,
    items: (opts.items ?? []) as FakeItemCollection,
    effects: opts.effects ?? [],
    ...(opts.ownership !== undefined ? { ownership: opts.ownership } : {}),
    ...(opts.spellcasting !== undefined ? { spellcasting: opts.spellcasting } : {}),
    getFlag: throwingGetFlag,
    update: async () => undefined,
    createEmbeddedDocuments: async () => [],
    updateEmbeddedDocuments: async () => [],
    deleteEmbeddedDocuments: async () => undefined,
    testUserPermission: () => false,
  };
  if (opts.tokenOverride !== undefined) {
    actor.prototypeToken = opts.tokenOverride;
  } else if (opts.tokenSrc !== null) {
    const src = opts.tokenSrc ?? `wod20-tokens/${name}.webp`;
    // A real prototypeToken is a DataModel: its schema fields are NOT own
    // enumerable properties, so anything reading it must go through toObject().
    const source = {
      name,
      actorLink: true,
      texture: { src, scaleX: 1, scaleY: 1 },
      sight: { enabled: false, range: 0 },
      ring: opts.tokenRing ?? null,
    };
    actor.prototypeToken = {
      toObject: () => JSON.parse(JSON.stringify(source)) as Record<string, any>,
    };
  }
  attachWriteMethods(actor);
  return actor;
}

function actorFromCreateDoc(doc: Record<string, any>): FakeActor {
  const folderRecord = world.folders.find(f => f.id === doc.folder);
  const actor: FakeActor = {
    id: `actor-${nextId++}`,
    name: doc.name as string,
    type: doc.type as string,
    system: doc.system as Record<string, any>,
    ...(doc.img !== undefined ? { img: doc.img as string } : {}),
    flags: (doc.flags as Record<string, any>) ?? {},
    folder: folderRecord ? { name: folderRecord.name } : null,
    items: ((doc.items as any[]) ?? []).map((d: any, i: number) => ({
      ...(typeof d === 'object' && d !== null ? d : {}),
      id: `item-${nextId}-${i}`,
    })) as FakeItemCollection,
    effects: [],
    ...(doc.ownership !== undefined ? { ownership: doc.ownership as Record<string, number> } : {}),
    getFlag: throwingGetFlag,
    update: async () => undefined,
    createEmbeddedDocuments: async () => [],
    updateEmbeddedDocuments: async () => [],
    deleteEmbeddedDocuments: async () => undefined,
    testUserPermission: () => false,
  };
  if (doc.prototypeToken !== undefined) {
    const source = doc.prototypeToken as Record<string, any>;
    actor.prototypeToken = { toObject: () => structuredClone(source) };
  }
  attachWriteMethods(actor);
  return actor;
}

// ─── System-shaped actors ─────────────────────────────────────────────────────

/**
 * A WFRP4e-shaped actor. `updateWfrp4eActor` reads
 * `system.characteristics.<key>.{initial,advances,modifier,value,bonus}`,
 * `system.status.wounds` and `system.details.move.value`, and edits embedded
 * `skill` / `career` items; `addWfrp4eItems` adds to the same item list. The
 * characteristic `value`/`bonus` are the DERIVED fields WFRP4e recomputes on
 * update — seeded here so the methods' read-back-after-write is observable
 * without pretending the fake recomputes anything.
 */
export function makeWfrp4eActor(
  name: string,
  opts: {
    characteristics?: Record<string, Record<string, any>>;
    wounds?: { value?: number; max?: number };
    move?: number;
    /** Skill items: name → advances (`system.advances.value`). */
    skills?: Record<string, number>;
    /** Career items: name → whether it is currently the active career. */
    careers?: Record<string, boolean>;
    /** Arcane spell items, built with `wfrp4eSpell` — grouped by lore on read. */
    spells?: Record<string, any>[];
    /** Prayer items, built with `wfrp4ePrayer` — grouped by god on read. */
    prayers?: Record<string, any>[];
    /** Any further items, verbatim. */
    items?: Record<string, any>[];
    effects?: any[];
  } = {}
): FakeActor {
  const items: any[] = [];
  let seq = 0;
  for (const [skill, advances] of Object.entries(opts.skills ?? {})) {
    items.push({
      id: `skill-${seq++}`,
      name: skill,
      type: 'skill',
      system: {
        advances: { value: advances },
        characteristic: { value: 'ws' },
        total: { value: advances + 30 },
      },
    });
  }
  for (const [career, current] of Object.entries(opts.careers ?? {})) {
    items.push({
      id: `career-${seq++}`,
      name: career,
      type: 'career',
      system: { current: { value: current } },
    });
  }
  items.push(...(opts.spells ?? []), ...(opts.prayers ?? []), ...(opts.items ?? []));
  return makeActor(name, {
    type: 'character',
    items,
    ...(opts.effects !== undefined ? { effects: opts.effects } : {}),
    system: {
      characteristics: opts.characteristics ?? {
        ws: { initial: 30, advances: 0, modifier: 0, value: 30, bonus: 3 },
        t: { initial: 32, advances: 0, modifier: 0, value: 32, bonus: 3 },
      },
      status: { wounds: opts.wounds ?? { value: 10, max: 12 } },
      details: { move: { value: opts.move ?? 4 }, biography: { value: '' } },
    },
  });
}

/**
 * An mgt2e-shaped (Mongoose Traveller 2e) actor. `createActors` builds documents
 * of this shape from shorthand rather than reading one, so this is for the
 * update side — `updateActors`' dotted-key expansion is exercised against
 * `system.crewed.passengers`, the shape whose deletion-operator handling its
 * comment describes.
 */
export function makeMgt2eActor(
  name: string,
  opts: { type?: string; system?: Record<string, any> } = {}
): FakeActor {
  return makeActor(name, {
    type: opts.type ?? 'traveller',
    system: opts.system ?? {
      characteristics: {
        STR: { value: 8, damage: 0, show: true },
        DEX: { value: 7, damage: 0, show: true },
        END: { value: 9, damage: 0, show: true },
      },
      skills: { pilot: { id: 'pilot', value: 1, trained: true } },
      hits: { value: 24, max: 24 },
    },
  });
}

// ─── ActiveEffects ────────────────────────────────────────────────────────────

/**
 * An ActiveEffect. `getCharacterInfo` merges the duration from THREE sources —
 * `duration.units ?? _source.duration.type ?? 'none'` and
 * `duration.seconds ?? _source.duration.duration` — so the LIVE duration and
 * the `_source` duration are set independently: the merge is invisible unless
 * they disagree, and a nullish `units` is what makes the fallback fire.
 *
 * Pass `''` as the name to reach the `label` fallback, and `''` with no label to
 * reach `'Unknown Effect'`.
 */
export function makeEffect(
  name: string,
  opts: {
    id?: string;
    label?: string;
    icon?: string;
    disabled?: boolean;
    /** `searchCharacterItems` echoes this; `getCharacterInfo` ignores it. */
    description?: string;
    /**
     * The live `duration`. OMITTED entirely means no duration key at all, which
     * is a different branch from a duration whose fields are absent.
     */
    duration?: {
      units?: string | null;
      seconds?: number | null;
      remaining?: number | null;
    } | null;
    /** `_source.duration` — the raw stored duration the merge falls back to. */
    sourceDuration?: { type?: string; duration?: number };
  } = {}
): Record<string, any> {
  return {
    id: opts.id ?? `eff-${slug(name || 'anon')}`,
    name,
    ...(opts.label !== undefined ? { label: opts.label } : {}),
    ...(opts.icon !== undefined ? { icon: opts.icon } : {}),
    disabled: opts.disabled ?? false,
    ...(opts.description !== undefined ? { description: opts.description } : {}),
    ...(opts.duration !== undefined ? { duration: opts.duration } : {}),
    ...(opts.sourceDuration !== undefined ? { _source: { duration: opts.sourceDuration } } : {}),
  };
}

// ─── System-shaped spells and spellcasting ────────────────────────────────────

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'x'
  );
}

export interface Pf2eSpellSpec {
  name: string;
  id?: string;
  /** `system.level.value` — PF2e's rank, and the FIRST link of the `??` chain. */
  rank?: number;
  /** `system.rank` — the second link, read only when `level.value` is absent. */
  rankFlat?: number;
  /** `system.location.value` — the spellcasting entry this spell belongs to. */
  location?: string;
  /** `system.location` as a BARE string — the other side of the entry filter's `||`. */
  locationFlat?: string;
  /** `system.location.prepared`. */
  prepared?: boolean;
  /** `system.location.expended`. */
  expended?: boolean;
  /** `system.traits.value`. `['focus']` is what makes a spell a focus spell. */
  traits?: string[];
  /** `system.category.value` — the OTHER way to be a focus spell. */
  category?: string;
  /** `system.time.value` — the raw value `formatPF2eActionCost` formats. */
  time?: string | number;
  /** `system.range.value`. */
  range?: string | number;
  /** `system.target.value` — PF2e's target is one descriptive string. */
  target?: string;
  /** `system.area`. `{ type }` alone renders as the bare type, no size. */
  area?: { type?: string; value?: number };
  /** Merged over the assembled `system`, for shapes no shorthand covers. */
  system?: Record<string, any>;
}

/** A PF2e spell item. */
export function pf2eSpell(spec: Pf2eSpellSpec): Record<string, any> {
  const system: Record<string, any> = {};
  if (spec.rank !== undefined) system.level = { value: spec.rank };
  if (spec.rankFlat !== undefined) system.rank = spec.rankFlat;
  if (spec.traits !== undefined) system.traits = { value: spec.traits };
  if (spec.category !== undefined) system.category = { value: spec.category };
  if (spec.time !== undefined) system.time = { value: spec.time };
  if (spec.range !== undefined) system.range = { value: spec.range };
  if (spec.target !== undefined) system.target = { value: spec.target };
  if (spec.area !== undefined) system.area = spec.area;
  const location: Record<string, any> = {};
  if (spec.location !== undefined) location.value = spec.location;
  if (spec.prepared !== undefined) location.prepared = spec.prepared;
  if (spec.expended !== undefined) location.expended = spec.expended;
  if (Object.keys(location).length > 0) system.location = location;
  if (spec.locationFlat !== undefined) system.location = spec.locationFlat;
  Object.assign(system, spec.system ?? {});
  return { id: spec.id ?? `spell-${slug(spec.name)}`, name: spec.name, type: 'spell', system };
}

/**
 * A PF2e `spellcastingEntry` item. Note that `extractSpellcastingData` reads the
 * entry's data as `entry.system || entry` but its spell collection as
 * `entry.spells` — an own property of the item, NOT part of `system`.
 */
export function pf2eSpellcastingEntry(
  spec: {
    id?: string;
    name?: string;
    /** `entry.spells`, keyed `spell0`…`spell10`; values `{ value: [refs] }` or a bare array. */
    spells?: Record<string, any>;
    /** Written to `entry.system` verbatim — for asserting which key of a `||` wins. */
    system?: Record<string, any>;
    /** `system.tradition.value`. */
    tradition?: string;
    /** `system.prepared.value` — the entry TYPE (prepared/spontaneous/innate/focus). */
    prepared?: string;
    /** `system.ability.value`. */
    ability?: string;
    /** `system.spelldc` — `{ dc, value }`, whose `value` is the spell ATTACK. */
    spelldc?: { dc?: number; value?: number };
    /** `system.slots` — `{ slot1: { value, max } }`, per PF2e rank. */
    slots?: Record<string, { value?: number; max?: number }>;
  } = {}
): Record<string, any> {
  const system: Record<string, any> = {};
  if (spec.tradition !== undefined) system.tradition = { value: spec.tradition };
  if (spec.prepared !== undefined) system.prepared = { value: spec.prepared };
  if (spec.ability !== undefined) system.ability = { value: spec.ability };
  if (spec.spelldc !== undefined) system.spelldc = spec.spelldc;
  if (spec.slots !== undefined) system.slots = spec.slots;
  Object.assign(system, spec.system ?? {});
  return {
    id: spec.id ?? `entry-${slug(spec.name ?? 'spellcasting')}`,
    name: spec.name ?? 'Spellcasting',
    type: 'spellcastingEntry',
    system,
    ...(spec.spells !== undefined ? { spells: spec.spells } : {}),
  };
}

/**
 * A PF2e-shaped actor. `system.actions` is what `getCharacterInfo`'s strike
 * block reads — and note that block is NOT gated on `game.system.id`, so it
 * fires for any actor carrying the field.
 */
export function makePf2eActor(
  name: string,
  opts: {
    /** `system.actions` — PF2e strikes. */
    actions?: Record<string, any>[];
    /** `spellcastingEntry` items, built with `pf2eSpellcastingEntry`. */
    entries?: Record<string, any>[];
    /** Spell items, built with `pf2eSpell`. */
    spells?: Record<string, any>[];
    /** Any further items, verbatim (feats, weapons, rule-element carriers). */
    items?: Record<string, any>[];
    effects?: any[];
    /** Installs `actor.spellcasting.contents` — the entry source PF2e prefers. */
    spellcastingContents?: Record<string, any>[];
    /** Merged over the assembled `system`. */
    system?: Record<string, any>;
  } = {}
): FakeActor {
  const system: Record<string, any> = {
    details: { level: { value: 1 } },
    ...(opts.actions !== undefined ? { actions: opts.actions } : {}),
    ...(opts.system ?? {}),
  };
  return makeActor(name, {
    type: 'character',
    items: [...(opts.entries ?? []), ...(opts.spells ?? []), ...(opts.items ?? [])],
    ...(opts.effects !== undefined ? { effects: opts.effects } : {}),
    ...(opts.spellcastingContents !== undefined
      ? { spellcasting: { contents: opts.spellcastingContents } }
      : {}),
    system,
  });
}

export interface Dnd5eSpellSpec {
  name: string;
  id?: string;
  /** `system.level` — a FLAT number in 5e, unlike PF2e's `level.value`. */
  level?: number;
  /** `system.prepared` — read first by `searchCharacterItems`. */
  prepared?: boolean;
  /** `system.preparation.prepared` — what the general-entry fallback reads. */
  preparation?: boolean;
  /** `_source.system.preparation.prepared` — what the by-class path falls back to. */
  rawPreparation?: boolean;
  /** `_source.system.sourceClass` — the last link of the source-class chain. */
  sourceClass?: string;
  /** `system.sourceItem`: a bare id string, or `{ identifier }` / `{ id }`. */
  sourceItem?: string | { identifier?: string; id?: string };
  /** `system.activation.type` — 5e's action cost, used verbatim. */
  activation?: string;
  /** `system.range` — `units: 'self' | 'touch' | 'spec'` short-circuit the value. */
  range?: { value?: number | string; units?: string; special?: string };
  /** `system.target` — `type`, `value`, and a `template` for area spells. */
  target?: {
    type?: string;
    value?: number;
    template?: { type?: string; size?: number; units?: string };
  };
  system?: Record<string, any>;
}

/** A D&D 5e spell item. */
export function dnd5eSpell(spec: Dnd5eSpellSpec): Record<string, any> {
  const system: Record<string, any> = {};
  if (spec.level !== undefined) system.level = spec.level;
  if (spec.prepared !== undefined) system.prepared = spec.prepared;
  if (spec.preparation !== undefined) system.preparation = { prepared: spec.preparation };
  if (spec.sourceItem !== undefined) system.sourceItem = spec.sourceItem;
  if (spec.activation !== undefined) system.activation = { type: spec.activation };
  if (spec.range !== undefined) system.range = spec.range;
  if (spec.target !== undefined) system.target = spec.target;
  Object.assign(system, spec.system ?? {});
  const raw: Record<string, any> = {};
  if (spec.sourceClass !== undefined) raw.sourceClass = spec.sourceClass;
  if (spec.rawPreparation !== undefined) raw.preparation = { prepared: spec.rawPreparation };
  return {
    id: spec.id ?? `spell-${slug(spec.name)}`,
    name: spec.name,
    type: 'spell',
    system,
    // `_source` is absent unless asked for: the reader falls back to `system`
    // when there is none, which is a different branch.
    ...(Object.keys(raw).length > 0 ? { _source: { system: raw } } : {}),
  };
}

/**
 * A D&D 5e `class` item. `progression: 'none'` and a class with no
 * `spellcasting` block at all are both real non-caster branches.
 */
export function dnd5eClass(
  name: string,
  opts: {
    id?: string;
    /** `system.spellcasting.progression`. Pass `null` for no spellcasting block. */
    progression?: string | null;
    /** `system.spellcasting.type` — the entry type echoed on the result. */
    type?: string;
    /** `system.spellcasting.ability`. */
    ability?: string;
  } = {}
): Record<string, any> {
  const progression = opts.progression === undefined ? 'full' : opts.progression;
  return {
    id: opts.id ?? `class-${slug(name)}`,
    name,
    type: 'class',
    system:
      progression === null
        ? {}
        : {
            spellcasting: {
              progression,
              ...(opts.type !== undefined ? { type: opts.type } : {}),
              ...(opts.ability !== undefined ? { ability: opts.ability } : {}),
            },
          },
  };
}

/** A D&D 5e-shaped actor. `system.spells` is the slot store both slot readers use. */
export function makeDnd5eActor(
  name: string,
  opts: {
    /** `system.spells` — `{ spell1: { value, max }, …, pact: { value, max } }`. */
    spellSlots?: Record<string, { value?: number; max?: number }>;
    classes?: Record<string, any>[];
    spells?: Record<string, any>[];
    items?: Record<string, any>[];
    effects?: any[];
    system?: Record<string, any>;
  } = {}
): FakeActor {
  return makeActor(name, {
    type: 'character',
    items: [...(opts.classes ?? []), ...(opts.spells ?? []), ...(opts.items ?? [])],
    ...(opts.effects !== undefined ? { effects: opts.effects } : {}),
    system: {
      abilities: { int: { value: 16 } },
      ...(opts.spellSlots !== undefined ? { spells: opts.spellSlots } : {}),
      ...(opts.system ?? {}),
    },
  });
}

export interface Dsa5SpellSpec {
  name: string;
  id?: string;
  /** The ITEM type, which is what sorts a DSA5 spell into one of the three groups. */
  type?: 'spell' | 'liturgy' | 'ceremony' | 'ritual';
  /** `system.level.value`. */
  level?: number;
  /** `system.level` as a flat number — the second link of the `??` chain. */
  levelFlat?: number;
  /** `system.effect.attributes` — DSA5's stand-in for traits. */
  attributes?: string[];
  /** `system.castingTime.value`. */
  castingTime?: string;
  /** `system.range.value`. */
  range?: string;
  /** `system.Reichweite` — the German-key fallback for range. */
  reichweite?: string;
  /** `system.targetCategory.value`. */
  targetCategory?: string;
  /** `system.Zielkategorie` — the German-key fallback for target. */
  zielkategorie?: string;
  /** `system.effectRadius.value`. */
  effectRadius?: string;
  /** `system.Wirkungsbereich` — the German-key fallback for area. */
  wirkungsbereich?: string;
  system?: Record<string, any>;
}

/** A DSA5 spell / liturgy / ceremony / ritual item. */
export function dsa5Spell(spec: Dsa5SpellSpec): Record<string, any> {
  const system: Record<string, any> = {};
  if (spec.level !== undefined) system.level = { value: spec.level };
  if (spec.levelFlat !== undefined) system.level = spec.levelFlat;
  if (spec.attributes !== undefined) system.effect = { attributes: spec.attributes };
  if (spec.castingTime !== undefined) system.castingTime = { value: spec.castingTime };
  if (spec.range !== undefined) system.range = { value: spec.range };
  if (spec.reichweite !== undefined) system.Reichweite = spec.reichweite;
  if (spec.targetCategory !== undefined) system.targetCategory = { value: spec.targetCategory };
  if (spec.zielkategorie !== undefined) system.Zielkategorie = spec.zielkategorie;
  if (spec.effectRadius !== undefined) system.effectRadius = { value: spec.effectRadius };
  if (spec.wirkungsbereich !== undefined) system.Wirkungsbereich = spec.wirkungsbereich;
  Object.assign(system, spec.system ?? {});
  return {
    id: spec.id ?? `spell-${slug(spec.name)}`,
    name: spec.name,
    type: spec.type ?? 'spell',
    system,
  };
}

/**
 * A DSA5-shaped actor. AsP and KaP are read as
 * `system.status.astralenergy || system.astralenergy`, so both positions are
 * settable: `asp`/`kap` write the `status` path, `aspFlat`/`kapFlat` the other.
 */
export function makeDsa5Actor(
  name: string,
  opts: {
    asp?: { value?: number; max?: number };
    kap?: { value?: number; max?: number };
    aspFlat?: { value?: number; max?: number };
    kapFlat?: { value?: number; max?: number };
    spells?: Record<string, any>[];
    items?: Record<string, any>[];
    effects?: any[];
    system?: Record<string, any>;
  } = {}
): FakeActor {
  const status: Record<string, any> = {};
  if (opts.asp !== undefined) status.astralenergy = opts.asp;
  if (opts.kap !== undefined) status.karmaenergy = opts.kap;
  return makeActor(name, {
    type: 'character',
    items: [...(opts.spells ?? []), ...(opts.items ?? [])],
    ...(opts.effects !== undefined ? { effects: opts.effects } : {}),
    system: {
      status,
      ...(opts.aspFlat !== undefined ? { astralenergy: opts.aspFlat } : {}),
      ...(opts.kapFlat !== undefined ? { karmaenergy: opts.kapFlat } : {}),
      ...(opts.system ?? {}),
    },
  });
}

/**
 * A WFRP4e spell item. WFRP4e has no levels and no slots: a spell carries a
 * Casting Number and belongs to a Lore, and `lore.value` is sometimes an ARRAY,
 * of which only the first element is read.
 */
export function wfrp4eSpell(
  name: string,
  opts: {
    id?: string;
    /** `system.lore.value`. Absent defaults the group to `'arcane'`. */
    lore?: string | string[];
    /** `system.cn.value` — the Casting Number. `null` is a real, distinct case. */
    cn?: number | null;
    range?: string;
    target?: string;
  } = {}
): Record<string, any> {
  const system: Record<string, any> = {};
  if (opts.lore !== undefined) system.lore = { value: opts.lore };
  if (opts.cn !== undefined) system.cn = { value: opts.cn };
  if (opts.range !== undefined) system.range = { value: opts.range };
  if (opts.target !== undefined) system.target = { value: opts.target };
  return { id: opts.id ?? `spell-${slug(name)}`, name, type: 'spell', system };
}

/** A WFRP4e prayer item — divine magic, grouped by god rather than by lore. */
export function wfrp4ePrayer(
  name: string,
  opts: { id?: string; god?: string; range?: string; target?: string } = {}
): Record<string, any> {
  const system: Record<string, any> = {};
  if (opts.god !== undefined) system.god = { value: opts.god };
  if (opts.range !== undefined) system.range = { value: opts.range };
  if (opts.target !== undefined) system.target = { value: opts.target };
  return { id: opts.id ?? `prayer-${slug(name)}`, name, type: 'prayer', system };
}

// ─── Compendium packs ─────────────────────────────────────────────────────────

/**
 * A pack document. A real Foundry document exposes its fields as own properties
 * AND a `toObject()`; both are used (the mechanics builders take `toObject()`,
 * `getCompendiumDocumentFull` reads the fields).
 */
function makeDocument(entry: FakePackEntry): Record<string, any> {
  const data = entry.doc as Record<string, any>;
  return {
    ...data,
    id: (data._id as string) ?? entry._id,
    // The document CLASS, not the actor type — own property only, so it stays
    // out of `toObject()` exactly as a real DataModel keeps it out.
    ...(entry.documentName !== undefined ? { documentName: entry.documentName } : {}),
    toObject: () => structuredClone(data),
  };
}

function makePack(spec: FakePackSpec): Record<string, any> {
  const index = new FakeFoundryCollection<FakePackEntry>();
  for (const entry of spec.entries) {
    index.set(entry._id, entry);
  }
  const pack: Record<string, any> = {
    metadata: {
      id: spec.id,
      label: spec.label ?? spec.id,
      type: spec.type ?? 'Item',
      system: spec.system,
      private: spec.private ?? false,
    },
    indexed: spec.indexed ?? false,
    index,
    getIndex: async (_options?: unknown) => {
      world.packIndexCalls.push(spec.id);
      pack.indexed = true;
      return index;
    },
    getDocument: async (id: string) => {
      const entry = index.get(id);
      if (!entry?.doc) return null;
      return makeDocument(entry);
    },
    getDocuments: async () => {
      world.packDocumentsCalls.push(spec.id);
      return spec.entries.filter(e => e.doc).map(e => makeDocument(e));
    },
  };
  return pack;
}

/**
 * `PersistentCreatureIndex.generatePackFingerprint`, reproduced. Only
 * `documentCount` and `checksum` are compared by `fingerprintsMatch`, but the
 * whole record is written so the seeded file has the real shape.
 */
function packFingerprintOf(pack: Record<string, any>): Record<string, any> {
  const id = pack.metadata.id as string;
  const label = pack.metadata.label as string;
  const size = (pack.index as Map<string, unknown>)?.size ?? 0;
  return {
    packId: id,
    packLabel: label,
    lastModified: Date.now(),
    documentCount: size,
    checksum: btoa(`${id}-${label}-${size}`).slice(0, 16),
  };
}

// ─── Install ──────────────────────────────────────────────────────────────────

/**
 * Install the fake world on `globalThis` and return its recorders. Call this from
 * `beforeEach` (and again mid-test to start from a clean world).
 */
export function installFakeFoundry(options: InstallOptions = {}): FakeWorld {
  nextId = 0;
  let randomIdCounter = 0;

  world = {
    actors: makeCollection(options.actors ?? []),
    folders: [],
    createCalls: [],
    folderCreateCalls: [],
    updateCalls: [],
    updates: [],
    embeddedCreates: [],
    embeddedDeletes: [],
    embeddedUpdates: [],
    itemUpdates: [],
    createDocumentsBatches: [],
    actorDeletes: [],
    sceneTokenCreates: [],
    chatMessages: [],
    audit: [],
    randomIds: [],
    packIndexCalls: [],
    packDocumentsCalls: [],
    hooks: [],
    files: new Map(),
    fileUploads: [],
    fileFetches: [],
    notifications: [],
    targetUpdates: [],
    writes: [],
    refuse: new Set(),
    explode: new Set(),
    failEmbed: new Set(),
    failSceneTokens: false,
    failActorUpdate: false,
  };
  const w = world;

  const g = globalThis as any;

  g.Hooks = {
    on: (name: string) => {
      w.hooks.push(name);
    },
    once: (name: string) => {
      w.hooks.push(name);
    },
    callAll: () => {},
  };

  // ── The world file store ────────────────────────────────────────────────────
  //
  // `PersistentCreatureIndex` keeps the enhanced creature index as JSON under
  // `worlds/<id>/`, browsing with FilePicker, reading with `fetch`, writing with
  // FilePicker.upload. All three are faked over one Map so a rebuild really does
  // become readable by a later read.
  const filePicker = {
    browse: async (_source: string, dir: string) => ({
      target: dir,
      files: Array.from(w.files.keys()).filter(p => p.startsWith(`${dir}/`)),
      dirs: [],
    }),
    upload: async (_source: string, dir: string, file: any) => {
      const path = `${dir}/${file.name as string}`;
      w.fileUploads.push(path);
      if (options.failIndexWrite) return null;
      w.files.set(path, JSON.parse((await file.text()) as string));
      return { path, status: 'success' };
    },
  };

  g.fetch = async (path: string, init?: { method?: string }) => {
    w.fileFetches.push(path);
    if (init?.method === 'DELETE') {
      w.files.delete(path);
      return { ok: true, status: 200, json: async () => ({}) };
    }
    if (!w.files.has(path)) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => structuredClone(w.files.get(path)) };
  };

  g.ui = {
    notifications: {
      // Returns null on purpose: the real return value is a Notification the
      // caller may `.remove()`, and null keeps that branch out of the way.
      info: (m: string) => {
        w.notifications.push(`info:${m}`);
        return null;
      },
      warn: (m: string) => {
        w.notifications.push(`warn:${m}`);
        return null;
      },
      error: (m: string) => {
        w.notifications.push(`error:${m}`);
        return null;
      },
    },
  };

  g.foundry = {
    applications: { apps: { FilePicker: { implementation: filePicker } } },
    utils: {
      getProperty: (obj: any, p: string) => p.split('.').reduce((a: any, k) => a?.[k], obj),
      // DETERMINISTIC on purpose: a characterization test needs to name the
      // activity id it expects to find as a key of `system.activities`.
      randomID: (length = 16) => {
        randomIdCounter += 1;
        const id = `R${String(randomIdCounter).padStart(Math.max(length - 1, 1), '0')}`.slice(
          0,
          Math.max(length, 1)
        );
        w.randomIds.push(id);
        return id;
      },
    },
  };

  // A Collection, not a Map: `addWfrp4eItems` does `Array.from(game.packs)` and
  // Foundry's Collection iterator yields values.
  const packs = new FakeFoundryCollection<Record<string, any>>();
  for (const spec of options.packs ?? []) {
    packs.set(spec.id, makePack(spec));
  }

  const settingValues: Record<string, any> = { ...(options.settings ?? {}) };

  // `game.world` carries getFlag/setFlag so FoundrySecurity.auditLog actually
  // persists — that is how `world.audit` gets filled. Foundry stores these on the
  // World document; nothing else in the module reads them.
  const worldFlags: Record<string, any> = {};
  const gameWorld = {
    id: 'test-world',
    getFlag: (_scope: string, key: string) => worldFlags[key],
    setFlag: (_scope: string, key: string, value: any) => {
      worldFlags[key] = value;
      w.audit.length = 0;
      for (const entry of (value as AuditEntry[]) ?? []) {
        w.audit.push(entry);
      }
    },
  };

  g.game = {
    ready: true,
    world: gameWorld,
    system: {
      id: options.systemId ?? 'worldofdarkness',
      // ABSENT unless asked for: `addActorItems` reads the absence as "this
      // system declares no Item types, so validate none".
      ...(options.itemTypes
        ? {
            documentTypes: {
              Item: Object.fromEntries(options.itemTypes.map(t => [t, {}])),
            },
          }
        : {}),
    },
    users: makeUserCollection(options.users ?? []),
    user: {
      id: 'user-1',
      name: 'Test GM',
      isGM: options.isGM ?? true,
      updateTokenTargets: async (ids: string[]) => {
        w.targetUpdates.push([...ids]);
      },
    },
    actors: w.actors,
    folders: w.folders,
    packs,
    settings: {
      get: (_scope: string, key: string) => settingValues[key],
      set: async (_scope: string, key: string, value: any) => {
        settingValues[key] = value;
      },
    },
  };

  // Seed a valid persisted enhanced creature index, if asked for. Written after
  // the packs exist because its fingerprints are derived from them.
  if (options.creatureIndex) {
    const seed = options.creatureIndex;
    w.files.set(`worlds/${gameWorld.id}/enhanced-creature-index.json`, {
      metadata: {
        version: seed.version ?? '1.0.0',
        timestamp: Date.now(),
        // Saved form is an entry array; the loader turns it back into a Map.
        packFingerprints: Array.from(packs.values())
          .filter(p => p.metadata.type === 'Actor')
          .map(p => [p.metadata.id as string, packFingerprintOf(p)]),
        totalCreatures: seed.creatures.length,
        gameSystem: seed.gameSystem ?? options.systemId ?? 'worldofdarkness',
      },
      creatures: seed.creatures,
    });
  }

  // NOTE: `game.scenes` is installed ONLY on request. Its absence is a
  // load-bearing property of the actor-art tests. See the header.
  if (options.activeScene) {
    const spec = options.activeScene;
    const scene: Record<string, any> = {
      id: 'scene-1',
      name: 'Test Scene',
      active: true,
      // `scene.tokens` is a Collection in Foundry, and
      // `ActorResolver.findActorByIdentifier`'s token fallback calls `.get()` on
      // it — reached whenever an identifier matches no world actor.
      tokens: attachGet(spec.tokens),
      // Geometry `calculateTokenPosition` reads. `gridSize: null` installs NO
      // grid, which is that method's `|| 100` fallback branch.
      ...(spec.gridSize === null ? {} : { grid: { size: spec.gridSize ?? 100 } }),
      width: spec.width ?? 1000,
      height: spec.height ?? 800,
      createEmbeddedDocuments: async (type: string, docs: Record<string, any>[]) => {
        w.sceneTokenCreates.push({ sceneId: 'scene-1', type, docs: structuredClone(docs) });
        w.writes.push(`sceneTokens:${docs.length}`);
        if (w.failSceneTokens) {
          throw new Error('Foundry refused to create tokens');
        }
        return docs.map((d, i) => ({ ...d, id: `token-${i}`, _id: `token-${i}` }));
      },
    };
    g.game.scenes = Object.assign([scene], { active: scene, current: scene });
  }

  const createOne = async (doc: Record<string, any>) => {
    w.createCalls.push(structuredClone(doc));
    w.writes.push(`create:${doc?.name as string}`);
    if (w.explode.has(doc.name as string)) {
      throw new Error(`Foundry exploded on ${doc.name as string}`);
    }
    if (w.refuse.has(doc.name as string)) return null;
    const actor = actorFromCreateDoc(doc);
    w.actors.push(actor);
    return actor;
  };

  g.Actor = {
    create: createOne,
    // The plural create — `createActors`' entry point. Records into the SAME
    // `createCalls` recorder as the singular one, so a document assertion reads
    // the same way whichever built it, plus the batch size.
    createDocuments: async (docs: Record<string, any>[]) => {
      w.createDocumentsBatches.push(docs.length);
      const created: any[] = [];
      for (const doc of docs) {
        const actor = await createOne(doc);
        if (actor) created.push(actor);
      }
      return created;
    },
    deleteDocuments: async (ids: string[]) => {
      w.actorDeletes.push([...ids]);
      w.writes.push(`deleteActors:${ids.length}`);
      const deleted = w.actors.filter(a => ids.includes(a.id));
      for (const actor of deleted) {
        const at = w.actors.indexOf(actor);
        if (at >= 0) w.actors.splice(at, 1);
      }
      return deleted;
    },
  };

  // `Folder.create` is reached through getOrCreateFolder; record any creation so
  // a dry run can be proven not to write.
  g.Folder = {
    create: async (doc: any) => {
      w.folderCreateCalls.push(doc.name as string);
      w.writes.push(`folder:${doc?.name as string}`);
      const folder: FakeFolder = {
        id: `folder-${nextId++}`,
        name: doc.name as string,
        type: doc.type as string,
      };
      w.folders.push(folder);
      return folder;
    },
  };

  g.ChatMessage = {
    getSpeaker: ({ actor }: { actor: FakeActor }) => ({ actor: actor.id, alias: actor.name }),
    create: (data: Record<string, any>) => {
      w.chatMessages.push(structuredClone(data));
      return Promise.resolve(data);
    },
  };

  g.CONFIG = { queries: {} };

  return world;
}

/** Construct the real `FoundryDataAccess` against whatever world is installed. */
export async function makeDataAccess(): Promise<any> {
  const mod = await import('../data-access.js');
  return new mod.FoundryDataAccess() as any;
}
