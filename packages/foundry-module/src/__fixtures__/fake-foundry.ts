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
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// ─── Shapes ───────────────────────────────────────────────────────────────────

export interface FakeActor {
  id: string;
  name: string;
  type: string;
  system: Record<string, any>;
  img?: string;
  flags: Record<string, any>;
  folder?: { name: string; id?: string } | string | null;
  items: any[];
  effects: any[];
  prototypeToken?: { toObject: () => Record<string, any> };
  /** Throws, on purpose. See load-bearing property (1). */
  getFlag: (scope: string, key: string) => never;
  update: (patch: Record<string, any>) => Promise<void>;
  createEmbeddedDocuments: (type: string, docs: any[]) => Promise<any[]>;
  deleteEmbeddedDocuments: (type: string, ids: string[]) => Promise<void>;
}

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

export interface FakePackEntry {
  _id: string;
  name: string;
  /** Full document data returned by `pack.getDocument()`. Omit for "index-only". */
  doc?: Record<string, any>;
}

export interface FakePackSpec {
  id: string;
  label?: string;
  /** Foundry pack document type. Anything but `'Item'` is rejected by the callers. */
  type?: string;
  entries: FakePackEntry[];
  /** Start out already indexed, so `getIndex()` is not called. */
  indexed?: boolean;
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
  /** Chat messages created via the `ChatMessage` global. */
  chatMessages: Record<string, any>[];
  /** What `FoundrySecurity.auditLog` persisted. */
  audit: AuditEntry[];
  /** Ids handed out by `foundry.utils.randomID`, in order. */
  randomIds: string[];
  /** `pack.getIndex()` calls, by pack id — proves the index is built once. */
  packIndexCalls: string[];
  /** Token-id arrays passed to `game.user.updateTokenTargets`. */
  targetUpdates: string[][];
  /**
   * Read-path's single write log: `create:<name>`, `folder:<name>`,
   * `update:<id>:<patch keys>`, `embedCreate:<id>:<n>`, `embedDelete:<id>:<n>`.
   * A read-only operation must leave this EMPTY.
   */
  writes: string[];
  /** Names `Actor.create` should refuse (return null) for. */
  refuse: Set<string>;
  /** Names `Actor.create` should throw for. */
  explode: Set<string>;
  /** Item names `createEmbeddedDocuments` should throw for. */
  failEmbed: Set<string>;
}

export interface InstallOptions {
  actors?: FakeActor[];
  /** `game.system.id`. Defaults to the WoD system both original harnesses used. */
  systemId?: string;
  isGM?: boolean;
  packs?: FakePackSpec[];
  /**
   * Installs `game.scenes` — WITHOUT this, `game.scenes` is undefined, which is a
   * load-bearing property of the art tests. Only pass it when the code under test
   * genuinely needs a scene (e.g. `useItem` targeting).
   */
  activeScene?: { tokens: FakeToken[] };
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

// ─── Actors ───────────────────────────────────────────────────────────────────

function throwingGetFlag(scope: string, key: string): never {
  throw new Error(`Flag scope '${scope}' is not valid or not currently active (key ${key})`);
}

function attachWriteMethods(actor: FakeActor): void {
  actor.update = async patch => {
    world.updateCalls.push(actor.id);
    world.updates.push({ id: actor.id, patch: structuredClone(patch) });
    world.writes.push(`update:${actor.id}:${Object.keys(patch).join(',')}`);
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
    actor.items.push(...created);
    return created;
  };
  actor.deleteEmbeddedDocuments = async (type, ids) => {
    world.embeddedDeletes.push({ actorId: actor.id, type, ids: [...ids] });
    world.writes.push(`embedDelete:${actor.id}:${ids.length}`);
    actor.items = actor.items.filter((i: any) => !ids.includes(i.id));
  };
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
    type?: string;
    folder?: string | null;
    items?: any[];
    system?: Record<string, any>;
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
    items: opts.items ?? [],
    effects: [],
    getFlag: throwingGetFlag,
    update: async () => undefined,
    createEmbeddedDocuments: async () => [],
    deleteEmbeddedDocuments: async () => undefined,
  };
  if (opts.tokenSrc !== null) {
    const src = opts.tokenSrc ?? `wod20-tokens/${name}.webp`;
    // A real prototypeToken is a DataModel: its schema fields are NOT own
    // enumerable properties, so anything reading it must go through toObject().
    const source = {
      name,
      actorLink: true,
      texture: { src, scaleX: 1, scaleY: 1 },
      sight: { enabled: false, range: 0 },
      ring: null,
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
    })),
    effects: [],
    getFlag: throwingGetFlag,
    update: async () => undefined,
    createEmbeddedDocuments: async () => [],
    deleteEmbeddedDocuments: async () => undefined,
  };
  if (doc.prototypeToken !== undefined) {
    const source = doc.prototypeToken as Record<string, any>;
    actor.prototypeToken = { toObject: () => structuredClone(source) };
  }
  attachWriteMethods(actor);
  return actor;
}

// ─── Compendium packs ─────────────────────────────────────────────────────────

function makePack(spec: FakePackSpec): Record<string, any> {
  const index = new Map<string, FakePackEntry>();
  for (const entry of spec.entries) {
    index.set(entry._id, entry);
  }
  const pack: Record<string, any> = {
    metadata: { id: spec.id, label: spec.label ?? spec.id, type: spec.type ?? 'Item' },
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
      const data = entry.doc;
      return { toObject: () => structuredClone(data) };
    },
  };
  return pack;
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
    chatMessages: [],
    audit: [],
    randomIds: [],
    packIndexCalls: [],
    targetUpdates: [],
    writes: [],
    refuse: new Set(),
    explode: new Set(),
    failEmbed: new Set(),
  };
  const w = world;

  const g = globalThis as any;

  g.Hooks = { on: () => {}, once: () => {}, callAll: () => {} };

  g.foundry = {
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

  const packs = new Map<string, Record<string, any>>();
  for (const spec of options.packs ?? []) {
    packs.set(spec.id, makePack(spec));
  }

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
    system: { id: options.systemId ?? 'worldofdarkness' },
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
  };

  // NOTE: `game.scenes` is installed ONLY on request. Its absence is a
  // load-bearing property of the actor-art tests. See the header.
  if (options.activeScene) {
    const scene = {
      id: 'scene-1',
      name: 'Test Scene',
      active: true,
      tokens: options.activeScene.tokens,
    };
    g.game.scenes = Object.assign([scene], { active: scene, current: scene });
  }

  g.Actor = {
    create: async (doc: Record<string, any>) => {
      w.createCalls.push(structuredClone(doc));
      w.writes.push(`create:${doc?.name as string}`);
      if (w.explode.has(doc.name as string)) {
        throw new Error(`Foundry exploded on ${doc.name as string}`);
      }
      if (w.refuse.has(doc.name as string)) return null;
      const actor = actorFromCreateDoc(doc);
      w.actors.push(actor);
      return actor;
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
