/**
 * Characterization tests for the actor-CRUD cluster of `FoundryDataAccess` —
 * `createActorFromCompendiumEntry`, `addActorItems`, `removeActorItems`,
 * `addActorsToScene` (and the private `calculateTokenPosition` reached through
 * it), `setActorOwnership`, `updateWfrp4eActor`, `addWfrp4eItems`,
 * `getActorOwnership`, `createActors` (and the private
 * `normalizeMGT2eSkillKeys` reached through it), `updateActors`,
 * `updateActorItems`, `deleteActorItems` and `deleteActors`.
 *
 * Fifteen members, 1,307 body lines, and until this file none of them had a
 * single test. Why it is committed BEFORE the extraction that moves them into
 * `actor-crud.ts`, and not with it:
 *
 *   The extraction is a pure relocation whose entire claim is that nothing
 *   changed. A clean type-check cannot support that claim — the realistic
 *   failure is a swapped key in a hand-built document or a dropped audit call,
 *   both of which type-check perfectly. So the cluster needs tests, and they
 *   have to be written against the PRE-move source: a test first written
 *   against post-move code records whatever slip the move introduced and
 *   attests to nothing. `c1f12d5` did this for the compendium cluster before
 *   `e4c0409` moved it; this is the same precondition for pass 5.3.
 *
 * ── What is asserted, and why it is never the envelope ───────────────────────
 *
 * Every member here except `getActorOwnership` is a WRITE path, so what these
 * tests assert is **the document handed to Foundry** — the `Actor.create` /
 * `Actor.createDocuments` document, the `createEmbeddedDocuments` payload, the
 * `update` patch, the token documents given to `scene.createEmbeddedDocuments`,
 * the id list given to `Actor.deleteDocuments` — plus the audit call. Not the
 * returned success/warnings envelope: `createActors` and `updateActors` return
 * `{created/updated, total}` counters that a mis-transcribed `system` patch does
 * not change, so the envelope proves nothing about the write. `getActorOwnership`
 * is the one read, and there the return value IS the observable output.
 *
 * ── Behaviour pinned deliberately even though it looks wrong ─────────────────
 *
 * 1. **`setActorOwnership` writes ownership and audits NOTHING** — alone among
 *    the write paths in this cluster. That asymmetry is pinned as-is. Adding the
 *    audit call would be a behaviour change smuggled into a relocation, so the
 *    test asserts `world.audit` is empty and will fail if someone "fixes" it.
 * 2. **`addActorsToScene` audits `'success'` TWICE** on a successful call, with
 *    the same payload — once before the try block, once after the write. Pinned
 *    as two entries, not one.
 * 3. **The empty `else {}` branch** at `data-access.ts:2222` does nothing; the
 *    non-remote token texture is simply left alone. Pinned via the passthrough.
 * 4. **`updateActors` builds a nested `system` patch** even for flat dot-keys, so
 *    Foundry deep-merges in one pass. The nesting IS the payload under test.
 *
 * ── Deliberately NOT tested ──────────────────────────────────────────────────
 *
 * - `createActorFromCompendium` (145 lines, `public`) and `createActorFromSource`
 *   (46 lines, `private`, dead by cascade) are **dead surface being deleted**, not
 *   moved. Nothing reaches `createActorFromCompendium`: the live bridge query of
 *   that name is handled by `handleCreateActorFromCompendium`, which calls
 *   `createActorFromCompendiumEntry` instead. Testing them would pin code that is
 *   required to be removed and would obstruct its removal.
 * - `addActorsToScene`'s `transactionManager` block (`:2242–2249`) is guarded on a
 *   `transactionId` argument that **no caller passes** — `queries.ts:558` omits it
 *   and so does `createActorFromCompendiumEntry`, and after the dead method above
 *   is deleted nothing anywhere calls `startTransaction`. It is unreachable
 *   through the facade, so there is no honest test for it: faking a transaction
 *   into existence would pin the fake, not the method. Recorded as an
 *   acknowledged gap instead.
 * - `importActors` (28 cases in `import-actors.test.ts`) and `createNpcActor`
 *   (3 cases in `actor-mechanics.test.ts`) are already covered and are not
 *   duplicated here.
 */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  installFakeFoundry,
  makeActor,
  makeDataAccess,
  makeMgt2eActor,
  makeWfrp4eActor,
  type FakePackSpec,
  type FakeWorld,
  type InstallOptions,
} from './__fixtures__/fake-foundry.js';
import { PermissionManager } from './permissions.js';

let world: FakeWorld;
let da: any;

async function install(options: InstallOptions = {}): Promise<void> {
  world = installFakeFoundry(options);
  da = await makeDataAccess();
}

/** Writes are allowed by a GM setting; `addActorsToScene` is the only gated member. */
const WRITES_ALLOWED = { allowWriteOperations: true };

/** `makeActor` derives ids from the name, so they can be asserted literally. */
function id(name: string): string {
  return name.padEnd(16, '0').slice(0, 16);
}

// ─── Builders ─────────────────────────────────────────────────────────────────

/** A compendium pack holding one full Actor document. */
function creaturePack(
  doc: Record<string, any>,
  overrides: Partial<FakePackSpec> = {}
): FakePackSpec {
  return {
    id: 'dnd5e.monsters',
    label: 'Monsters (SRD)',
    type: 'Actor',
    entries: [
      {
        _id: 'goblin-1',
        name: doc.name as string,
        type: doc.type as string,
        doc,
        documentName: 'Actor',
      },
    ],
    ...overrides,
  };
}

function goblinDoc(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    _id: 'goblin-1',
    name: 'Goblin',
    type: 'npc',
    img: 'icons/goblin.webp',
    system: { attributes: { hp: { value: 7, max: 7 } }, details: { cr: 0.25 } },
    items: [{ _id: 'item-scimitar', name: 'Scimitar', type: 'weapon' }],
    effects: [{ _id: 'eff-1', name: 'Nimble Escape' }],
    prototypeToken: {
      name: 'Goblin',
      texture: { src: 'icons/goblin-token.webp' },
      actorLink: false,
    },
    ...overrides,
  };
}

/** A wfrp4e Item pack. `entries` are index rows; `docs` are their full documents. */
function wfrpPack(
  packId: string,
  label: string,
  items: Array<{ name: string; type: string; system?: Record<string, any>; img?: string }>
): FakePackSpec {
  return {
    id: packId,
    label,
    type: 'Item',
    entries: items.map((it, i) => ({
      _id: `${packId}-${i}`,
      name: it.name,
      type: it.type,
      doc: {
        _id: `${packId}-${i}`,
        name: it.name,
        type: it.type,
        img: it.img ?? `icons/${it.type}.webp`,
        system: it.system ?? {},
        effects: [],
        flags: { wfrp4e: { source: packId } },
      },
    })),
  };
}

/** Just the fields of a recorded audit entry these tests care about. */
function auditOf(entry: {
  operation: string;
  data: any;
  result: string;
  error?: string;
}): Record<string, any> {
  return {
    operation: entry.operation,
    data: entry.data,
    result: entry.result,
    ...(entry.error !== undefined ? { error: entry.error } : {}),
  };
}

function audits(): Array<Record<string, any>> {
  return world.audit.map(auditOf);
}

// =============================================================================
// createActorFromCompendiumEntry
// =============================================================================

describe('createActorFromCompendiumEntry', () => {
  beforeEach(async () => {
    await install({ systemId: 'dnd5e', packs: [creaturePack(goblinDoc())] });
  });

  it('hands `Actor.create` the document it built from the compendium source, field for field', async () => {
    await da.createActorFromCompendiumEntry({
      packId: 'dnd5e.monsters',
      itemId: 'goblin-1',
      customNames: ['Snaggle'],
    });

    // The folder is created first and its id is what lands on the document.
    expect(world.folderCreateCalls).toEqual(['Foundry MCP Creatures']);
    expect(world.createCalls).toHaveLength(1);
    expect(world.createCalls[0]).toEqual({
      name: 'Snaggle',
      type: 'npc',
      img: 'icons/goblin.webp',
      system: { attributes: { hp: { value: 7, max: 7 } }, details: { cr: 0.25 } },
      items: [{ _id: 'item-scimitar', name: 'Scimitar', type: 'weapon' }],
      effects: [{ _id: 'eff-1', name: 'Nimble Escape' }],
      // `folder: null` is overwritten by the folder id — the source folder is
      // deliberately NOT inherited.
      folder: world.folders[0].id,
      prototypeToken: {
        name: 'Goblin',
        texture: { src: 'icons/goblin-token.webp' },
        actorLink: false,
      },
    });
  });

  it('reports the created actor with its original name and source pack label', async () => {
    const res = await da.createActorFromCompendiumEntry({
      packId: 'dnd5e.monsters',
      itemId: 'goblin-1',
      customNames: ['Snaggle'],
    });

    expect(res.success).toBe(true);
    expect(res.totalCreated).toBe(1);
    expect(res.totalRequested).toBe(1);
    expect(res.tokensPlaced).toBe(0);
    expect(res.errors).toBeUndefined();
    expect(res.actors).toEqual([
      {
        id: world.actors[0].id,
        name: 'Snaggle',
        originalName: 'Goblin',
        sourcePackLabel: 'Monsters (SRD)',
      },
    ]);
  });

  it('audits success with the whole request object', async () => {
    const request = { packId: 'dnd5e.monsters', itemId: 'goblin-1', customNames: ['Snaggle'] };
    await da.createActorFromCompendiumEntry(request);

    expect(audits()).toEqual([
      { operation: 'createActorFromCompendiumEntry', data: request, result: 'success' },
    ]);
  });

  it('clamps quantity to the number of names supplied, and reuses one folder', async () => {
    await da.createActorFromCompendiumEntry({
      packId: 'dnd5e.monsters',
      itemId: 'goblin-1',
      customNames: ['One', 'Two'],
      quantity: 5,
    });

    expect(world.createCalls.map(d => d.name)).toEqual(['One', 'Two']);
    // Second pass finds the folder rather than creating a second one.
    expect(world.folderCreateCalls).toEqual(['Foundry MCP Creatures']);
    expect(world.createCalls[0].folder).toBe(world.createCalls[1].folder);
  });

  it('branch: no custom names at all falls back to "<source name> Copy"', async () => {
    const res = await da.createActorFromCompendiumEntry({
      packId: 'dnd5e.monsters',
      itemId: 'goblin-1',
      customNames: [],
    });

    expect(world.createCalls.map(d => d.name)).toEqual(['Goblin Copy']);
    expect(res.totalRequested).toBe(1);
  });

  it('branch: a remote prototype-token URL is cleared to null on the created document', async () => {
    await install({
      systemId: 'dnd5e',
      packs: [
        creaturePack(
          goblinDoc({
            prototypeToken: { name: 'Goblin', texture: { src: 'https://cdn.example/goblin.png' } },
          })
        ),
      ],
    });

    await da.createActorFromCompendiumEntry({
      packId: 'dnd5e.monsters',
      itemId: 'goblin-1',
      customNames: ['Snaggle'],
    });

    expect(world.createCalls[0].prototypeToken.texture.src).toBeNull();
  });

  it('`system` WINS over a legacy `data` block when the source carries both', async () => {
    await install({
      systemId: 'dnd5e',
      packs: [creaturePack(goblinDoc({ system: { modern: true }, data: { legacy: true } }))],
    });

    await da.createActorFromCompendiumEntry({
      packId: 'dnd5e.monsters',
      itemId: 'goblin-1',
      customNames: ['Snaggle'],
    });

    expect(world.createCalls[0].system).toEqual({ modern: true });
  });

  it('the source folder is never inherited, even when no destination folder can be made', async () => {
    await install({
      systemId: 'dnd5e',
      packs: [creaturePack(goblinDoc({ folder: 'compendium-folder-id' }))],
    });
    // `getOrCreateFolder` swallows the failure and returns null, so the document's
    // own `folder: null` is what reaches Foundry — NOT the source's folder.
    (globalThis as any).Folder.create = (): Promise<null> => Promise.resolve(null);

    await da.createActorFromCompendiumEntry({
      packId: 'dnd5e.monsters',
      itemId: 'goblin-1',
      customNames: ['Snaggle'],
    });

    expect(world.createCalls[0].folder).toBeNull();
  });

  it('branch: a source with no system falls back to `data`, then to an empty object', async () => {
    await install({
      systemId: 'dnd5e',
      packs: [
        creaturePack(goblinDoc({ system: undefined, data: { legacy: true } })),
        {
          id: 'p2',
          label: 'P2',
          type: 'Actor',
          entries: [
            {
              _id: 'x',
              name: 'Bare',
              type: 'npc',
              documentName: 'Actor',
              doc: { _id: 'x', name: 'Bare', type: 'npc' },
            },
          ],
        },
      ],
    });

    await da.createActorFromCompendiumEntry({
      packId: 'dnd5e.monsters',
      itemId: 'goblin-1',
      customNames: ['Legacy'],
    });
    expect(world.createCalls[0].system).toEqual({ legacy: true });

    await da.createActorFromCompendiumEntry({ packId: 'p2', itemId: 'x', customNames: ['Bare'] });
    expect(world.createCalls[1].system).toEqual({});
    expect(world.createCalls[1].items).toEqual([]);
    expect(world.createCalls[1].effects).toEqual([]);
  });

  it('captures a per-actor failure without abandoning the batch, and still reports success', async () => {
    world.refuse.add('Two');

    const res = await da.createActorFromCompendiumEntry({
      packId: 'dnd5e.monsters',
      itemId: 'goblin-1',
      customNames: ['One', 'Two', 'Three'],
      quantity: 3,
    });

    expect(world.createCalls.map(d => d.name)).toEqual(['One', 'Two', 'Three']);
    expect(res.success).toBe(true);
    expect(res.totalCreated).toBe(2);
    expect(res.totalRequested).toBe(3);
    // Numbered by loop index (1-based), not by name.
    expect(res.errors).toEqual(['Failed to create actor 2: Failed to create actor "Two"']);
    // A partial batch is still a 'success' audit.
    expect(audits().map(a => a.result)).toEqual(['success']);
  });

  it('branch: every actor failing reports success:false — still one success audit', async () => {
    world.refuse.add('One');

    const res = await da.createActorFromCompendiumEntry({
      packId: 'dnd5e.monsters',
      itemId: 'goblin-1',
      customNames: ['One'],
    });

    expect(res.success).toBe(false);
    expect(res.totalCreated).toBe(0);
    expect(res.actors).toEqual([]);
    expect(audits().map(a => a.result)).toEqual(['success']);
  });

  it('addToScene passes the created ids and the placement type through to the token write', async () => {
    await install({
      systemId: 'dnd5e',
      packs: [creaturePack(goblinDoc())],
      settings: WRITES_ALLOWED,
      activeScene: { tokens: [], gridSize: 100, width: 1000, height: 800 },
    });

    const res = await da.createActorFromCompendiumEntry({
      packId: 'dnd5e.monsters',
      itemId: 'goblin-1',
      customNames: ['A', 'B'],
      quantity: 2,
      addToScene: true,
      placement: { type: 'center' },
    });

    expect(world.sceneTokenCreates).toHaveLength(1);
    const [tokens] = world.sceneTokenCreates;
    expect(tokens.type).toBe('Token');
    expect(
      tokens.docs.map(d => ({ x: d.x, y: d.y, actorId: d.actorId, hidden: d.hidden }))
    ).toEqual([
      { x: 500, y: 400, actorId: world.actors[0].id, hidden: false },
      { x: 600, y: 400, actorId: world.actors[1].id, hidden: false },
    ]);
    expect(res.tokensPlaced).toBe(2);
  });

  it('addToScene passes explicit coordinates through, and defaults the mode to grid', async () => {
    await install({
      systemId: 'dnd5e',
      packs: [creaturePack(goblinDoc())],
      settings: WRITES_ALLOWED,
      activeScene: { tokens: [], gridSize: 100, width: 1000, height: 800 },
    });

    await da.createActorFromCompendiumEntry({
      packId: 'dnd5e.monsters',
      itemId: 'goblin-1',
      customNames: ['A'],
      addToScene: true,
      placement: { type: 'coordinates', coordinates: [{ x: 42, y: 99 }] },
    });
    expect(world.sceneTokenCreates[0].docs.map(d => ({ x: d.x, y: d.y }))).toEqual([
      { x: 42, y: 99 },
    ]);

    // No `placement` at all → 'grid', and no `coordinates` key is forwarded.
    await da.createActorFromCompendiumEntry({
      packId: 'dnd5e.monsters',
      itemId: 'goblin-1',
      customNames: ['B'],
      addToScene: true,
    });
    expect(world.sceneTokenCreates[1].docs.map(d => ({ x: d.x, y: d.y }))).toEqual([
      { x: 100, y: 100 },
    ]);
  });

  it('branch: a failing scene write is captured as an error, not thrown — actors survive', async () => {
    await install({
      systemId: 'dnd5e',
      packs: [creaturePack(goblinDoc())],
      // No `allowWriteOperations`, so addActorsToScene's permission check denies.
      activeScene: { tokens: [] },
    });

    const res = await da.createActorFromCompendiumEntry({
      packId: 'dnd5e.monsters',
      itemId: 'goblin-1',
      customNames: ['A'],
      addToScene: true,
    });

    expect(res.success).toBe(true);
    expect(res.totalCreated).toBe(1);
    expect(res.tokensPlaced).toBe(0);
    expect(res.errors).toEqual([
      'Failed to add actors to scene: Access denied - feature is disabled: Modify Scene is disabled in module settings',
    ]);
    expect(world.sceneTokenCreates).toEqual([]);
  });

  it('branch: addToScene is skipped entirely when nothing was created', async () => {
    world.refuse.add('A');

    const res = await da.createActorFromCompendiumEntry({
      packId: 'dnd5e.monsters',
      itemId: 'goblin-1',
      customNames: ['A'],
      addToScene: true,
    });

    expect(res.tokensPlaced).toBe(0);
    // `game.scenes` was never installed, so reaching the scene at all would throw.
    expect(res.errors).toEqual(['Failed to create actor 1: Failed to create actor "A"']);
  });

  it.each([
    ['a missing packId', { packId: '', itemId: 'goblin-1' }, 'Both packId and itemId are required'],
    [
      'a missing itemId',
      { packId: 'dnd5e.monsters', itemId: '' },
      'Both packId and itemId are required',
    ],
    ['an unknown pack', { packId: 'nope', itemId: 'goblin-1' }, 'Compendium pack "nope" not found'],
    [
      'an unknown document',
      { packId: 'dnd5e.monsters', itemId: 'nope' },
      'Document "nope" not found in pack "dnd5e.monsters"',
    ],
  ])('guard: %s throws and audits a failure with the message', async (_label, req, message) => {
    const request = { ...req, customNames: ['X'] } as any;
    await expect(da.createActorFromCompendiumEntry(request)).rejects.toThrow(message);

    expect(world.createCalls).toEqual([]);
    expect(audits()).toEqual([
      {
        operation: 'createActorFromCompendiumEntry',
        data: request,
        result: 'failure',
        error: message,
      },
    ]);
  });

  it('guard: a non-Actor document is rejected on documentName, before actor type', async () => {
    await install({
      systemId: 'dnd5e',
      packs: [
        {
          id: 'p',
          label: 'P',
          type: 'Item',
          entries: [
            {
              _id: 'i1',
              name: 'Sword',
              type: 'weapon',
              documentName: 'Item',
              doc: { _id: 'i1', name: 'Sword', type: 'weapon' },
            },
          ],
        },
      ],
    });

    await expect(
      da.createActorFromCompendiumEntry({ packId: 'p', itemId: 'i1', customNames: ['X'] })
    ).rejects.toThrow('Document "i1" is not an Actor (documentName: Item, type: weapon)');
    expect(world.createCalls).toEqual([]);
  });

  it('guard: an Actor of an unsupported type is rejected, and the four supported ones are not', async () => {
    const entry = (type: string): Record<string, any> => ({
      _id: type,
      name: type,
      type,
      documentName: 'Actor',
      doc: { _id: type, name: type, type, system: {} },
    });
    await install({
      systemId: 'dnd5e',
      packs: [
        {
          id: 'p',
          label: 'P',
          type: 'Actor',
          entries: ['character', 'npc', 'creature', 'adversary', 'vehicle'].map(entry),
        },
      ],
    });

    await expect(
      da.createActorFromCompendiumEntry({ packId: 'p', itemId: 'vehicle', customNames: ['X'] })
    ).rejects.toThrow(
      'Document "vehicle" has unsupported actor type: vehicle. Supported types: character, npc, creature, adversary'
    );

    for (const type of ['character', 'npc', 'creature', 'adversary']) {
      await da.createActorFromCompendiumEntry({ packId: 'p', itemId: type, customNames: [type] });
    }
    expect(world.createCalls.map(d => d.type)).toEqual([
      'character',
      'npc',
      'creature',
      'adversary',
    ]);
  });
});

// =============================================================================
// addActorItems
// =============================================================================

describe('addActorItems', () => {
  beforeEach(async () => {
    await install({ actors: [makeActor('Lena')] });
  });

  it('hands `createEmbeddedDocuments` the payload it built, omitting absent optionals', async () => {
    await da.addActorItems({
      actorIdentifier: 'Lena',
      items: [
        { name: 'Sword', type: 'weapon', img: 'icons/sword.webp', system: { damage: 3 } },
        { name: 'Rope', type: 'gear' },
      ],
    });

    expect(world.embeddedCreates).toEqual([
      {
        actorId: id('Lena'),
        type: 'Item',
        docs: [
          { name: 'Sword', type: 'weapon', img: 'icons/sword.webp', system: { damage: 3 } },
          // No `img` and no `system` key at all — not `undefined` values.
          { name: 'Rope', type: 'gear' },
        ],
      },
    ]);
  });

  it('branch: a non-object `system` and an empty `img` are both dropped from the payload', async () => {
    await da.addActorItems({
      actorIdentifier: 'Lena',
      items: [{ name: 'Odd', type: 'gear', img: '', system: 'nope' as any }],
    });

    expect(world.embeddedCreates[0].docs).toEqual([{ name: 'Odd', type: 'gear' }]);
  });

  it('audits success with the identifier, the resolved id and the payload size', async () => {
    const res = await da.addActorItems({
      actorIdentifier: 'Lena',
      items: [{ name: 'Sword', type: 'weapon' }],
    });

    expect(audits()).toEqual([
      {
        operation: 'addActorItems',
        data: { actorIdentifier: 'Lena', actorId: id('Lena'), count: 1 },
        result: 'success',
      },
    ]);
    expect(res).toEqual({
      actorId: id('Lena'),
      actorName: 'Lena',
      created: [{ id: 'item-0', name: 'Sword', type: 'weapon' }],
    });
  });

  it('validates every item type against the system’s declared Item types when it declares any', async () => {
    await install({
      actors: [makeActor('Lena')],
      systemId: 'dnd5e',
      itemTypes: ['weapon', 'loot'],
    });

    await expect(
      da.addActorItems({
        actorIdentifier: 'Lena',
        items: [
          { name: 'Sword', type: 'weapon' },
          { name: 'Spell', type: 'spell' },
        ],
      })
    ).rejects.toThrow(
      'items[1] ("Spell"): unknown type "spell" for system "dnd5e". Valid Item types: weapon, loot'
    );

    // Thrown while BUILDING the payload, so nothing was written and nothing audited.
    expect(world.embeddedCreates).toEqual([]);
    expect(world.audit).toEqual([]);
  });

  it('branch: a system declaring no Item types validates no types at all', async () => {
    await da.addActorItems({
      actorIdentifier: 'Lena',
      items: [{ name: 'Whatever', type: 'made-up' }],
    });
    expect(world.embeddedCreates[0].docs).toEqual([{ name: 'Whatever', type: 'made-up' }]);
  });

  it.each([
    [
      'no actorIdentifier',
      { actorIdentifier: '', items: [{ name: 'A', type: 'b' }] },
      'actorIdentifier is required',
    ],
    [
      'an empty items array',
      { actorIdentifier: 'Lena', items: [] },
      'items array is required and must contain at least one entry',
    ],
    [
      'a non-array items',
      { actorIdentifier: 'Lena', items: 'nope' },
      'items array is required and must contain at least one entry',
    ],
    [
      'an unknown actor',
      { actorIdentifier: 'Nobody', items: [{ name: 'A', type: 'b' }] },
      'Actor not found: Nobody',
    ],
    [
      'a blank item name',
      { actorIdentifier: 'Lena', items: [{ name: '   ', type: 'b' }] },
      'items[0]: "name" is required and must be a non-empty string',
    ],
    [
      'a missing item type',
      { actorIdentifier: 'Lena', items: [{ name: 'A' }] },
      'items[0] ("A"): "type" is required',
    ],
  ])('guard: %s throws before any write, and audits nothing', async (_label, params, message) => {
    await expect(da.addActorItems(params as any)).rejects.toThrow(message);
    expect(world.writes).toEqual([]);
    expect(world.audit).toEqual([]);
  });

  it('audits a failure with the same payload shape when Foundry refuses the embed, then rethrows', async () => {
    world.failEmbed.add('Sword');

    await expect(
      da.addActorItems({ actorIdentifier: 'Lena', items: [{ name: 'Sword', type: 'weapon' }] })
    ).rejects.toThrow('Foundry refused to embed "Sword"');

    expect(audits()).toEqual([
      {
        operation: 'addActorItems',
        data: { actorIdentifier: 'Lena', actorId: id('Lena'), count: 1 },
        result: 'failure',
        error: 'Foundry refused to embed "Sword"',
      },
    ]);
  });
});

// =============================================================================
// removeActorItems
// =============================================================================

describe('removeActorItems', () => {
  const items = (): Record<string, any>[] => [
    { id: 'i-1', name: 'Sword', type: 'weapon', system: {} },
    { id: 'i-2', name: 'Rope', type: 'gear', system: {} },
    { id: 'i-3', name: 'rope', type: 'weapon', system: {} },
  ];

  beforeEach(async () => {
    await install({ actors: [makeActor('Lena', { items: items() })] });
  });

  it('hands `deleteEmbeddedDocuments` exactly the ids it resolved, and audits the count', async () => {
    const res = await da.removeActorItems({ actorIdentifier: 'Lena', itemIds: ['i-1', 'i-2'] });

    expect(world.embeddedDeletes).toEqual([
      { actorId: id('Lena'), type: 'Item', ids: ['i-1', 'i-2'] },
    ]);
    expect(res.removed).toEqual([
      { id: 'i-1', name: 'Sword', type: 'weapon' },
      { id: 'i-2', name: 'Rope', type: 'gear' },
    ]);
    expect(res.notFound).toEqual([]);
    expect(audits()).toEqual([
      {
        operation: 'removeActorItems',
        data: { actorIdentifier: 'Lena', actorId: id('Lena'), count: 2 },
        result: 'success',
      },
    ]);
  });

  it('matches names case-insensitively, taking the FIRST match only', async () => {
    const res = await da.removeActorItems({ actorIdentifier: 'Lena', itemNames: ['ROPE'] });

    // 'Rope' (i-2) comes before 'rope' (i-3); only one is removed.
    expect(world.embeddedDeletes[0].ids).toEqual(['i-2']);
    expect(res.removed).toEqual([{ id: 'i-2', name: 'Rope', type: 'gear' }]);
  });

  it('a `type` constrains the name match — the FILTER is lowercased, the item type is not', async () => {
    const res = await da.removeActorItems({
      actorIdentifier: 'Lena',
      itemNames: ['rope'],
      type: 'Weapon',
    });

    // The supplied `type` is lowercased, then compared to `item.type` verbatim:
    // 'Weapon' → 'weapon' matches i-3 and skips i-2 ('gear').
    expect(world.embeddedDeletes[0].ids).toEqual(['i-3']);
    expect(res.removed).toEqual([{ id: 'i-3', name: 'rope', type: 'weapon' }]);

    // The other half of that asymmetry: an item whose own type is capitalised is
    // unreachable through this filter.
    await install({
      actors: [makeActor('Mika', { items: [{ id: 'j-1', name: 'Bow', type: 'Weapon' }] })],
    });
    const miss = await da.removeActorItems({
      actorIdentifier: 'Mika',
      itemNames: ['bow'],
      type: 'Weapon',
    });
    expect(miss.removed).toEqual([]);
    expect(miss.notFound).toEqual(['bow']);
  });

  it('dedupes an id and a name that resolve to the same item', async () => {
    const res = await da.removeActorItems({
      actorIdentifier: 'Lena',
      itemIds: ['i-1'],
      itemNames: ['Sword'],
    });

    expect(world.embeddedDeletes[0].ids).toEqual(['i-1']);
    expect(res.removed).toHaveLength(1);
  });

  it('reports unmatched ids and names rather than ignoring them, in ids-then-names order', async () => {
    const res = await da.removeActorItems({
      actorIdentifier: 'Lena',
      itemIds: ['i-1', 'ghost-id'],
      itemNames: ['Ghost Name'],
    });

    expect(res.notFound).toEqual(['ghost-id', 'Ghost Name']);
    expect(world.embeddedDeletes[0].ids).toEqual(['i-1']);
  });

  it('branch: nothing matched at all — no delete, no audit, and notFound carries everything', async () => {
    const res = await da.removeActorItems({
      actorIdentifier: 'Lena',
      itemIds: ['ghost'],
      itemNames: ['Phantom'],
    });

    expect(res).toEqual({
      actorId: id('Lena'),
      actorName: 'Lena',
      removed: [],
      notFound: ['ghost', 'Phantom'],
    });
    expect(world.writes).toEqual([]);
    // Returned before the try block: this early exit is NOT audited.
    expect(world.audit).toEqual([]);
  });

  it.each([
    [
      'no actorIdentifier',
      { actorIdentifier: '', itemIds: ['i-1'] },
      'actorIdentifier is required',
    ],
    [
      'neither ids nor names',
      { actorIdentifier: 'Lena' },
      'Provide itemIds and/or itemNames identifying the items to remove',
    ],
    [
      'both arrays empty',
      { actorIdentifier: 'Lena', itemIds: [], itemNames: [] },
      'Provide itemIds and/or itemNames identifying the items to remove',
    ],
    [
      'an unknown actor',
      { actorIdentifier: 'Nobody', itemIds: ['i-1'] },
      'Actor not found: Nobody',
    ],
  ])('guard: %s throws before any write, and audits nothing', async (_label, params, message) => {
    await expect(da.removeActorItems(params as any)).rejects.toThrow(message);
    expect(world.writes).toEqual([]);
    expect(world.audit).toEqual([]);
  });
});

// =============================================================================
// addActorsToScene — and `calculateTokenPosition`, which is private and is
// therefore exercised THROUGH it. The coordinates it computes ARE fields of the
// token document written to the scene, so pinning the document pins the method.
// =============================================================================

describe('addActorsToScene', () => {
  const scene = (
    over: Partial<NonNullable<InstallOptions['activeScene']>> = {}
  ): NonNullable<InstallOptions['activeScene']> => ({
    tokens: [],
    gridSize: 100,
    width: 1000,
    height: 800,
    ...over,
  });

  async function installScene(
    actors = [makeActor('Ork'), makeActor('Goblin')],
    over: Partial<InstallOptions> = {}
  ): Promise<void> {
    await install({ actors, settings: WRITES_ALLOWED, activeScene: scene(), ...over });
  }

  it('hands the scene the prototype token document verbatim, plus x/y/actorId/hidden', async () => {
    await installScene([makeActor('Ork')]);

    await da.addActorsToScene({ actorIds: [id('Ork')], placement: 'grid', hidden: true });

    expect(world.sceneTokenCreates).toEqual([
      {
        sceneId: 'scene-1',
        type: 'Token',
        docs: [
          {
            // Everything below `name`…`ring` is the prototypeToken, untouched.
            name: 'Ork',
            actorLink: true,
            texture: { src: 'wod20-tokens/Ork.webp', scaleX: 1, scaleY: 1 },
            sight: { enabled: false, range: 0 },
            ring: null,
            x: 100,
            y: 100,
            actorId: id('Ork'),
            hidden: true,
          },
        ],
      },
    ]);
  });

  it('returns the created token ids and audits success TWICE with the same payload', async () => {
    await installScene();
    const placement = { actorIds: [id('Ork'), id('Goblin')], placement: 'grid', hidden: false };

    const res = await da.addActorsToScene(placement);

    expect(res).toEqual({ success: true, tokensCreated: 2, tokenIds: ['token-0', 'token-1'] });
    // Two 'success' entries: one before the try block (`:2194`) and one after the
    // write (`:2258`). Pinned as observed — not deduplicated.
    expect(audits()).toEqual([
      { operation: 'addActorsToScene', data: placement, result: 'success' },
      { operation: 'addActorsToScene', data: placement, result: 'success' },
    ]);
  });

  it('placement `grid`: a square-ish lattice at twice the grid size, recomputed per index', async () => {
    await installScene([
      makeActor('A'),
      makeActor('B'),
      makeActor('C'),
      makeActor('D'),
      makeActor('E'),
    ]);

    await da.addActorsToScene({
      actorIds: [id('A'), id('B'), id('C'), id('D'), id('E')],
      placement: 'grid',
      hidden: false,
    });

    // cols = ceil(sqrt(index+1)) is recomputed from the index alone, so the
    // column count GROWS as the loop runs and the result is not a lattice at all:
    // index 4 (cols 3, row 1, col 1) lands on top of index 3 (cols 2, row 1,
    // col 1). Two tokens at the same coordinates is current behaviour.
    expect(world.sceneTokenCreates[0].docs.map(d => ({ x: d.x, y: d.y }))).toEqual([
      { x: 100, y: 100 },
      { x: 300, y: 100 },
      { x: 100, y: 300 },
      { x: 300, y: 300 },
      { x: 300, y: 300 },
    ]);
  });

  it('placement `center`: the canvas centre, stepping right by one grid per token', async () => {
    await installScene();

    await da.addActorsToScene({
      actorIds: [id('Ork'), id('Goblin')],
      placement: 'center',
      hidden: false,
    });

    expect(world.sceneTokenCreates[0].docs.map(d => ({ x: d.x, y: d.y }))).toEqual([
      { x: 500, y: 400 },
      { x: 600, y: 400 },
    ]);
  });

  it('placement `coordinates`: the caller’s pairs, falling back to the grid lattice when short', async () => {
    await installScene();

    await da.addActorsToScene({
      actorIds: [id('Ork'), id('Goblin')],
      placement: 'coordinates',
      hidden: false,
      coordinates: [{ x: 17, y: 23 }],
    });

    expect(world.sceneTokenCreates[0].docs.map(d => ({ x: d.x, y: d.y }))).toEqual([
      { x: 17, y: 23 },
      // index 1 has no coordinate: same arithmetic as `grid`.
      { x: 300, y: 100 },
    ]);
  });

  it('placement `random`: scaled across the canvas minus one grid, and unknown modes are random too', async () => {
    await installScene([makeActor('Ork')]);
    const rand = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      await da.addActorsToScene({
        actorIds: [id('Ork')],
        placement: 'random',
        hidden: false,
      });
      // (1000 - 100) * 0.5, (800 - 100) * 0.5
      expect(world.sceneTokenCreates[0].docs[0]).toMatchObject({ x: 450, y: 350 });

      await da.addActorsToScene({
        actorIds: [id('Ork')],
        placement: 'nonsense' as any,
        hidden: false,
      });
      expect(world.sceneTokenCreates[1].docs[0]).toMatchObject({ x: 450, y: 350 });
    } finally {
      rand.mockRestore();
    }
  });

  it('branch: a scene with no grid falls back to a grid size of 100', async () => {
    await install({
      actors: [makeActor('Ork')],
      settings: WRITES_ALLOWED,
      activeScene: { tokens: [], gridSize: null, width: 640, height: 480 },
    });

    await da.addActorsToScene({ actorIds: [id('Ork')], placement: 'grid', hidden: false });
    expect(world.sceneTokenCreates[0].docs[0]).toMatchObject({ x: 100, y: 100 });
  });

  it('branch: a token texture that is still a remote URL is cleared; a local one is left alone', async () => {
    await installScene([
      makeActor('Remote', { tokenSrc: 'https://cdn.example/ork.png' }),
      makeActor('Local', { tokenSrc: 'wod20-tokens/local.webp' }),
    ]);

    await da.addActorsToScene({
      actorIds: [id('Remote'), id('Local')],
      placement: 'grid',
      hidden: false,
    });

    const docs = world.sceneTokenCreates[0].docs;
    expect(docs[0].texture.src).toBeNull();
    // The `else {}` branch at `:2222` is empty: the local src passes through.
    expect(docs[1].texture.src).toBe('wod20-tokens/local.webp');
  });

  it('branch: an unknown actor id is recorded as an error and does not consume a lattice slot', async () => {
    await installScene();

    const res = await da.addActorsToScene({
      actorIds: ['ghost', id('Ork')],
      placement: 'grid',
      hidden: false,
    });

    expect(res).toEqual({
      success: true,
      tokensCreated: 1,
      tokenIds: ['token-0'],
      errors: ['Actor ghost not found'],
    });
    // The surviving token gets index 0, because the index is `tokenData.length`.
    expect(world.sceneTokenCreates[0].docs.map(d => ({ x: d.x, y: d.y }))).toEqual([
      { x: 100, y: 100 },
    ]);
  });

  it('branch: an actor with no prototype token is caught per-actor, naming the actor', async () => {
    await installScene([makeActor('Ork', { tokenSrc: null })]);

    const res = await da.addActorsToScene({
      actorIds: [id('Ork')],
      placement: 'grid',
      hidden: false,
    });

    expect(res.errors).toEqual([
      `Failed to prepare token for actor ${id('Ork')}: Cannot read properties of undefined (reading 'toObject')`,
    ]);
    // The scene write still happens, with an empty batch.
    expect(world.sceneTokenCreates[0].docs).toEqual([]);
    expect(res.success).toBe(false);
    expect(res.tokensCreated).toBe(0);
  });

  it('audits the permission check itself, with the operation name and the whole placement', async () => {
    await installScene([makeActor('Ork')]);
    // `PermissionManager.auditPermissionCheck` has an empty body, so it leaves no
    // trace in the world — a spy is the only way to observe that this
    // cross-boundary call happens at all, and with what.
    const spy = vi.spyOn(PermissionManager.prototype, 'auditPermissionCheck');
    const checkSpy = vi.spyOn(PermissionManager.prototype, 'checkWritePermission');
    try {
      const placement = { actorIds: [id('Ork')], placement: 'grid', hidden: false };
      await da.addActorsToScene(placement);

      expect(checkSpy).toHaveBeenCalledWith('modifyScene', { targetIds: [id('Ork')] });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(
        'modifyScene',
        expect.objectContaining({ allowed: true }),
        placement
      );
    } finally {
      spy.mockRestore();
      checkSpy.mockRestore();
    }
  });

  it('guard: the permission check throws before the scene is touched and before any audit', async () => {
    // No `allowWriteOperations` setting at all → the modifyScene check denies.
    await install({ actors: [makeActor('Ork')], activeScene: scene() });

    await expect(
      da.addActorsToScene({ actorIds: [id('Ork')], placement: 'grid', hidden: false })
    ).rejects.toThrow(
      'Access denied - feature is disabled: Modify Scene is disabled in module settings'
    );

    expect(world.sceneTokenCreates).toEqual([]);
    expect(world.audit).toEqual([]);
  });

  it('guard: no active scene throws after the permission check, still before any audit', async () => {
    // `game.scenes` exists but has no `current`.
    await install({ actors: [makeActor('Ork')], settings: WRITES_ALLOWED });
    (globalThis as any).game.scenes = [];

    await expect(
      da.addActorsToScene({ actorIds: [id('Ork')], placement: 'grid', hidden: false })
    ).rejects.toThrow('No active scene found');
    expect(world.audit).toEqual([]);
  });

  it('a failing token write audits a failure AFTER the pre-try success, then rethrows', async () => {
    await installScene([makeActor('Ork')]);
    world.failSceneTokens = true;
    const placement = { actorIds: [id('Ork')], placement: 'grid', hidden: false };

    await expect(da.addActorsToScene(placement)).rejects.toThrow(
      'Foundry refused to create tokens'
    );

    expect(audits()).toEqual([
      { operation: 'addActorsToScene', data: placement, result: 'success' },
      {
        operation: 'addActorsToScene',
        data: placement,
        result: 'failure',
        error: 'Foundry refused to create tokens',
      },
    ]);
  });
});

// =============================================================================
// setActorOwnership / getActorOwnership — the ownership pair. `set` is the one
// write path in this cluster that makes NO audit call; `get` is the one read.
// =============================================================================

describe('setActorOwnership', () => {
  const users = [
    { id: 'user-1', name: 'Test GM', isGM: true },
    { id: 'user-2', name: 'Ana', isGM: false },
  ];

  beforeEach(async () => {
    await install({
      actors: [makeActor('Lena', { ownership: { 'user-1': 3, default: 0 } })],
      users,
    });
  });

  it('writes an ownership patch that MERGES the existing map — and audits nothing at all', async () => {
    const res = await da.setActorOwnership({
      actorId: id('Lena'),
      userId: 'user-2',
      permission: 2,
    });

    expect(world.updates).toEqual([
      { id: id('Lena'), patch: { ownership: { 'user-1': 3, default: 0, 'user-2': 2 } } },
    ]);
    // THE asymmetry: every other write path here audits. This one does not.
    // Pinned as observed behaviour — do not "fix" it inside a relocation.
    expect(world.audit).toEqual([]);
    expect(res).toEqual({ success: true, message: 'Set Lena ownership to OBSERVER for Ana' });
  });

  it('branch: an actor with no ownership map at all starts from an empty object', async () => {
    await install({ actors: [makeActor('Bare')], users });

    await da.setActorOwnership({ actorId: id('Bare'), userId: 'user-2', permission: 3 });

    expect(world.updates).toEqual([{ id: id('Bare'), patch: { ownership: { 'user-2': 3 } } }]);
  });

  it.each([
    [0, 'NONE'],
    [1, 'LIMITED'],
    [2, 'OBSERVER'],
    [3, 'OWNER'],
    // Unmapped: the raw number, stringified.
    [7, '7'],
  ])('permission %i is reported as %s', async (permission, name) => {
    const res = await da.setActorOwnership({ actorId: id('Lena'), userId: 'user-2', permission });

    expect(world.updates[0].patch).toEqual({
      ownership: { 'user-1': 3, default: 0, 'user-2': permission },
    });
    expect(res.message).toBe(`Set Lena ownership to ${name} for Ana`);
  });

  it('guard: an unknown actor returns an error envelope, writes nothing, and does not throw', async () => {
    const res = await da.setActorOwnership({ actorId: 'ghost', userId: 'user-2', permission: 2 });

    expect(res).toEqual({ success: false, error: 'Actor not found: ghost', message: '' });
    expect(world.writes).toEqual([]);
  });

  it('guard: an unknown user returns an error envelope, checked AFTER the actor', async () => {
    const res = await da.setActorOwnership({ actorId: id('Lena'), userId: 'ghost', permission: 2 });

    expect(res).toEqual({ success: false, error: 'User not found: ghost', message: '' });
    expect(world.writes).toEqual([]);
  });

  it('guard: an actor id is NOT resolved by name — `game.actors.get` only', async () => {
    const res = await da.setActorOwnership({ actorId: 'Lena', userId: 'user-2', permission: 2 });

    expect(res).toEqual({ success: false, error: 'Actor not found: Lena', message: '' });
  });

  it('a failing update is caught and returned as an error envelope, not thrown', async () => {
    world.failActorUpdate = true;

    const res = await da.setActorOwnership({
      actorId: id('Lena'),
      userId: 'user-2',
      permission: 2,
    });

    expect(res).toEqual({ success: false, error: 'Foundry refused to update Lena', message: '' });
    // Still not audited, even on failure.
    expect(world.audit).toEqual([]);
  });
});

describe('getActorOwnership', () => {
  const users = [
    { id: 'user-1', name: 'Test GM', isGM: true },
    { id: 'user-2', name: 'Ana', isGM: false },
    { id: 'user-3', name: 'Bruno', isGM: false },
  ];

  async function installOwners(): Promise<void> {
    await install({
      actors: [
        makeActor('Lena', { type: 'PC', ownership: { 'user-2': 3, 'user-3': 1 } }),
        makeActor('Mika', { type: 'npc', ownership: { default: 2 } }),
      ],
      users,
    });
  }

  beforeEach(installOwners);

  it('returns every actor × every non-GM user, with the level named and numbered', async () => {
    const res = await da.getActorOwnership({});

    expect(res).toEqual([
      {
        id: id('Lena'),
        name: 'Lena',
        type: 'PC',
        ownership: [
          { userId: 'user-2', userName: 'Ana', permission: 'OWNER', numericPermission: 3 },
          { userId: 'user-3', userName: 'Bruno', permission: 'LIMITED', numericPermission: 1 },
        ],
      },
      {
        id: id('Mika'),
        name: 'Mika',
        type: 'npc',
        ownership: [
          // Both users inherit the actor's `default` entry.
          { userId: 'user-2', userName: 'Ana', permission: 'OBSERVER', numericPermission: 2 },
          { userId: 'user-3', userName: 'Bruno', permission: 'OBSERVER', numericPermission: 2 },
        ],
      },
    ]);
  });

  it('the GM is filtered out of the ownership list, and reads nothing and audits nothing', async () => {
    const res = await da.getActorOwnership({});

    expect(res.flatMap((a: any) => a.ownership.map((o: any) => o.userId))).not.toContain('user-1');
    // The one read path in the cluster: no audit call anywhere in it.
    expect(world.audit).toEqual([]);
    expect(world.writes).toEqual([]);
  });

  it('branch: an explicit actorIdentifier resolves through the resolver, name or id', async () => {
    const byName = await da.getActorOwnership({ actorIdentifier: 'Mika' });
    expect(byName.map((a: any) => a.name)).toEqual(['Mika']);

    const byId = await da.getActorOwnership({ actorIdentifier: id('Lena') });
    expect(byId.map((a: any) => a.name)).toEqual(['Lena']);
  });

  it('branch: `all` is a literal, not an actor lookup', async () => {
    const res = await da.getActorOwnership({ actorIdentifier: 'all' });
    expect(res.map((a: any) => a.name)).toEqual(['Lena', 'Mika']);
  });

  it('branch: an unresolvable actorIdentifier yields an empty list rather than throwing', async () => {
    const res = await da.getActorOwnership({ actorIdentifier: 'ghost' });
    expect(res).toEqual([]);
  });

  it('branch: playerIdentifier resolves by NAME first, then by id, and narrows every actor', async () => {
    const byName = await da.getActorOwnership({ playerIdentifier: 'Bruno' });
    expect(byName.map((a: any) => a.ownership)).toEqual([
      [{ userId: 'user-3', userName: 'Bruno', permission: 'LIMITED', numericPermission: 1 }],
      [{ userId: 'user-3', userName: 'Bruno', permission: 'OBSERVER', numericPermission: 2 }],
    ]);

    const byId = await da.getActorOwnership({ playerIdentifier: 'user-2' });
    expect(byId[0].ownership.map((o: any) => o.userName)).toEqual(['Ana']);
  });

  it('branch: naming the GM narrows the list to nobody, per actor', async () => {
    const res = await da.getActorOwnership({ playerIdentifier: 'Test GM' });
    expect(res.map((a: any) => a.ownership)).toEqual([[], []]);
  });

  it('branch: an unresolvable playerIdentifier also narrows to nobody', async () => {
    const res = await da.getActorOwnership({ playerIdentifier: 'ghost' });
    expect(res.map((a: any) => a.ownership)).toEqual([[], []]);
  });

  it('the level is the FIRST of OWNER/OBSERVER/LIMITED that holds, else NONE', async () => {
    await install({
      actors: [makeActor('Zero', { ownership: { 'user-2': 0 } })],
      users,
    });

    const res = await da.getActorOwnership({ playerIdentifier: 'Ana' });
    expect(res[0].ownership).toEqual([
      { userId: 'user-2', userName: 'Ana', permission: 'NONE', numericPermission: 0 },
    ]);
  });
});

// =============================================================================
// updateWfrp4eActor — 175 body lines, and the largest single hand-built update
// patch in the cluster. Both the actor patch and the embedded-item patch are
// asserted as payloads; the response's `applied` map is the method's own record
// of the same write and is asserted alongside.
// =============================================================================

describe('updateWfrp4eActor', () => {
  /** `makeWfrp4eActor` numbers items in one sequence: skills first, then careers. */
  const SKILL = 'skill-0';
  const CAREER_A = 'career-1';
  const CAREER_B = 'career-2';

  async function installWfrp(): Promise<void> {
    await install({
      systemId: 'wfrp4e',
      actors: [
        makeWfrp4eActor('Ulric', {
          skills: { 'Melee (Basic)': 10 },
          careers: { Soldier: true, Scout: false },
        }),
      ],
    });
  }

  beforeEach(installWfrp);

  it('writes one flat characteristic patch per supplied field, and reports from/to per field', async () => {
    const res = await da.updateWfrp4eActor({
      actor: 'Ulric',
      characteristics: { WS: { initial: 35, advances: 4 }, t: { modifier: 2 } },
    });

    expect(world.updates).toEqual([
      {
        id: id('Ulric'),
        patch: {
          // Keys are lowercased; only fields actually supplied appear.
          'system.characteristics.ws.initial': 35,
          'system.characteristics.ws.advances': 4,
          'system.characteristics.t.modifier': 2,
        },
      },
    ]);
    expect(res.applied.characteristics).toEqual({
      WS: { initial: { from: 30, to: 35 }, advances: { from: 0, to: 4 } },
      T: { modifier: { from: 0, to: 2 } },
    });
    // Read back AFTER the write, and only for characteristics that were touched.
    expect(res.newCharacteristicTotals).toEqual({
      WS: { total: 30, bonus: 3 },
      T: { total: 32, bonus: 3 },
    });
    expect(res.success).toBe(true);
    expect(res.actor).toBe('Ulric');
    expect(res.id).toBe(id('Ulric'));
  });

  it('branch: an unknown characteristic warns and is dropped from the patch', async () => {
    const res = await da.updateWfrp4eActor({
      actor: 'Ulric',
      characteristics: { WS: { initial: 31 }, luck: { initial: 99 } },
    });

    expect(world.updates[0].patch).toEqual({ 'system.characteristics.ws.initial': 31 });
    // The warning quotes the RAW key, not the lowercased one.
    expect(res.warnings).toEqual(['Unknown characteristic "luck" — skipped']);
  });

  it('branch: a known characteristic with no recognised field writes nothing for it', async () => {
    const res = await da.updateWfrp4eActor({
      actor: 'Ulric',
      characteristics: { ws: { nonsense: 1 } as any, t: { initial: 33 } },
    });

    expect(world.updates[0].patch).toEqual({ 'system.characteristics.t.initial': 33 });
    // No `WS` key at all — the empty record is not recorded.
    expect(res.applied.characteristics).toEqual({ T: { initial: { from: 32, to: 33 } } });
  });

  it('writes wounds value and max independently, reporting the prior values', async () => {
    const res = await da.updateWfrp4eActor({ actor: 'Ulric', wounds: { value: 4 } });

    expect(world.updates[0].patch).toEqual({ 'system.status.wounds.value': 4 });
    expect(res.applied.wounds).toEqual({ value: { from: 10, to: 4 } });

    await da.updateWfrp4eActor({ actor: 'Ulric', wounds: { value: 1, max: 14 } });
    expect(world.updates[1].patch).toEqual({
      'system.status.wounds.value': 1,
      'system.status.wounds.max': 14,
    });
  });

  it('writes movement and biography under `details`, reporting a CHAR COUNT for the text', async () => {
    const res = await da.updateWfrp4eActor({
      actor: 'Ulric',
      movement: 5,
      biography: 'A soldier of Ostland.',
    });

    expect(world.updates[0].patch).toEqual({
      'system.details.move.value': 5,
      'system.details.biography.value': 'A soldier of Ostland.',
    });
    expect(res.applied.details).toEqual({
      movement: { from: 4, to: 5 },
      // The biography text itself is NOT echoed back, only its length.
      biography: { chars: 21 },
    });
  });

  it('bumps an existing skill through `updateEmbeddedDocuments`, matching the name case-insensitively', async () => {
    const res = await da.updateWfrp4eActor({
      actor: 'Ulric',
      skills: [{ name: 'melee (BASIC)', advances: 15 }],
    });

    expect(world.embeddedUpdates).toEqual([
      {
        actorId: id('Ulric'),
        type: 'Item',
        updates: [{ _id: SKILL, 'system.advances.value': 15 }],
      },
    ]);
    // The actor itself is never patched when only items change.
    expect(world.updates).toEqual([]);
    // Keyed by the item's OWN name, not the requested spelling.
    expect(res.applied.skills).toEqual({ 'Melee (Basic)': { advances: { from: 10, to: 15 } } });
  });

  it('branch: a skill the actor does not have warns and points at the other tool', async () => {
    const res = await da.updateWfrp4eActor({
      actor: 'Ulric',
      skills: [{ name: 'Sail', advances: 5 }],
      wounds: { value: 9 },
    });

    expect(world.embeddedUpdates).toEqual([]);
    expect(res.warnings).toEqual(['Skill "Sail" not on Ulric — use wfrp4e-add-items to add it.']);
  });

  it('switching career flips EVERY career item, target on and the rest off', async () => {
    const res = await da.updateWfrp4eActor({ actor: 'Ulric', career: 'scout' });

    expect(world.embeddedUpdates[0].updates).toEqual([
      { _id: CAREER_A, 'system.current.value': false },
      { _id: CAREER_B, 'system.current.value': true },
    ]);
    expect(res.applied.career).toBe('Scout');
  });

  it('branch: an absent career warns and flips nothing', async () => {
    const res = await da.updateWfrp4eActor({
      actor: 'Ulric',
      career: 'Wizard',
      wounds: { max: 13 },
    });

    expect(world.embeddedUpdates).toEqual([]);
    expect(res.warnings).toEqual([
      'Career "Wizard" not on Ulric — use wfrp4e-add-items to add it.',
    ]);
    expect(res.applied.career).toBeUndefined();
  });

  it('audits success once, with only the actor identifier — never the payload', async () => {
    await da.updateWfrp4eActor({ actor: 'Ulric', wounds: { value: 3 } });

    expect(audits()).toEqual([
      { operation: 'updateWfrp4eActor', data: { actor: 'Ulric' }, result: 'success' },
    ]);
  });

  it('a failing actor update audits a failure and returns an envelope — it does not throw', async () => {
    world.failActorUpdate = true;

    const res = await da.updateWfrp4eActor({ actor: 'Ulric', wounds: { value: 3 } });

    expect(res).toEqual({ success: false, error: 'Foundry refused to update Ulric' });
    expect(audits()).toEqual([
      {
        operation: 'updateWfrp4eActor',
        data: { actor: 'Ulric' },
        result: 'failure',
        error: 'Foundry refused to update Ulric',
      },
    ]);
  });

  it('guard: the wrong game system is refused by id, before the actor is even looked up', async () => {
    await install({ systemId: 'dnd5e', actors: [makeWfrp4eActor('Ulric')] });

    const res = await da.updateWfrp4eActor({ actor: 'Ulric', wounds: { value: 1 } });

    expect(res).toEqual({
      success: false,
      error: 'wfrp4e-update-actor requires the WFRP4e system (current: "dnd5e")',
    });
    expect(world.writes).toEqual([]);
    expect(world.audit).toEqual([]);
  });

  it('guard: an unknown actor returns an envelope', async () => {
    const res = await da.updateWfrp4eActor({ actor: 'Nobody', wounds: { value: 1 } });
    expect(res).toEqual({ success: false, error: 'Actor not found: Nobody' });
  });

  it('guard: nothing valid to write returns an envelope carrying the warnings that explain why', async () => {
    const res = await da.updateWfrp4eActor({
      actor: 'Ulric',
      characteristics: { luck: { initial: 3 } },
      skills: [{ name: 'Sail', advances: 5 }],
    });

    expect(res).toEqual({
      success: false,
      error: 'No valid fields to update.',
      warnings: [
        'Unknown characteristic "luck" — skipped',
        'Skill "Sail" not on Ulric — use wfrp4e-add-items to add it.',
      ],
    });
    expect(world.writes).toEqual([]);
    expect(world.audit).toEqual([]);
  });
});

// =============================================================================
// addWfrp4eItems — 286 body lines, the largest uncovered block in the file. The
// object under test is the array handed to `createEmbeddedDocuments`.
// =============================================================================

describe('addWfrp4eItems', () => {
  const CORE = 'wfrp4e-core.items';
  const EXTRA = 'wfrp4e-upinarms.items';

  async function installPacks(actor = makeWfrp4eActor('Ulric')): Promise<void> {
    await install({
      systemId: 'wfrp4e',
      actors: [actor],
      packs: [
        // Deliberately NOT core-first in installation order — the sort must do it.
        wfrpPack(EXTRA, 'Up in Arms', [
          {
            name: 'Athletics',
            type: 'skill',
            system: { advances: { value: 0 }, characteristic: { value: 'ag' } },
          },
          { name: 'Riposte', type: 'talent' },
        ]),
        wfrpPack(CORE, 'Core Rulebook', [
          {
            name: 'Athletics',
            type: 'skill',
            system: { advances: { value: 0 }, characteristic: { value: 'ag' } },
          },
          {
            name: 'Entertain ()',
            type: 'skill',
            system: { advances: { value: 0 }, characteristic: { value: 'fel' } },
          },
          {
            name: 'Sword',
            type: 'weapon',
            system: { quantity: { value: 1 }, damage: { value: 'SB+4' } },
          },
          { name: 'Riposte', type: 'trapping' },
          { name: 'Soldier', type: 'career', system: { current: { value: false } } },
        ]),
      ],
    });
  }

  beforeEach(() => installPacks());

  it('copies the compendium document into a clean creation payload, dropping its `_id`', async () => {
    await da.addWfrp4eItems({ actor: 'Ulric', items: [{ name: 'Sword' }] });

    expect(world.embeddedCreates).toEqual([
      {
        actorId: id('Ulric'),
        type: 'Item',
        docs: [
          {
            name: 'Sword',
            type: 'weapon',
            img: 'icons/weapon.webp',
            // `system` is copied wholesale; `_id` is deliberately NOT carried, so
            // Foundry mints a fresh one.
            system: { quantity: { value: 1 }, damage: { value: 'SB+4' } },
            effects: [],
            flags: { wfrp4e: { source: CORE } },
          },
        ],
      },
    ]);
  });

  it('resolves a name shared across packs from the Core Rulebook first, whatever the install order', async () => {
    const res = await da.addWfrp4eItems({ actor: 'Ulric', items: [{ name: 'Athletics' }] });

    expect(world.embeddedCreates[0].docs[0].flags).toEqual({ wfrp4e: { source: CORE } });
    expect(res.created[0]!.source).toBe('Core Rulebook');
  });

  it('bakes `advances` into a skill and `quantity` into gear, and ignores each for the other type', async () => {
    await da.addWfrp4eItems({
      actor: 'Ulric',
      items: [
        { name: 'Athletics', advances: 7, quantity: 99 },
        { name: 'Sword', quantity: 3, advances: 99 },
      ],
    });

    const [skill, gear] = world.embeddedCreates[0].docs;
    // `advances` applies (skill); `quantity` does not (not a gear type).
    expect(skill.system).toEqual({ advances: { value: 7 }, characteristic: { value: 'ag' } });
    // `quantity` applies (weapon is gear); `advances` does not.
    expect(gear.system).toEqual({ quantity: { value: 3 }, damage: { value: 'SB+4' } });
  });

  it('branch: a `type` disambiguates a name held by two different item types', async () => {
    await da.addWfrp4eItems({
      actor: 'Ulric',
      items: [{ name: 'Riposte', type: 'talent' }],
    });

    expect(world.embeddedCreates[0].docs[0]).toMatchObject({
      name: 'Riposte',
      type: 'talent',
      flags: { wfrp4e: { source: EXTRA } },
    });
  });

  it('branch: an ambiguous name is SKIPPED, reported, and never written', async () => {
    const res = await da.addWfrp4eItems({ actor: 'Ulric', items: [{ name: 'Riposte' }] });

    expect(world.embeddedCreates).toEqual([]);
    expect(res).toEqual({
      success: false,
      error: 'No items could be added.',
      ambiguous: [
        {
          name: 'Riposte',
          // Core-first order, and the pack ID rather than its label.
          candidates: [
            { pack: CORE, type: 'trapping' },
            { pack: EXTRA, type: 'talent' },
          ],
        },
      ],
      warnings: [
        '"Riposte" matches multiple item types (trapping, talent); pass "type" to choose — skipped.',
      ],
    });
    expect(world.audit).toEqual([]);
  });

  it('branch: `pack` narrows the search by SUBSTRING, not by exact id', async () => {
    await da.addWfrp4eItems({
      actor: 'Ulric',
      items: [{ name: 'Athletics', pack: 'upinarms' }],
    });

    expect(world.embeddedCreates[0].docs[0].flags).toEqual({ wfrp4e: { source: EXTRA } });
  });

  it('branch: a grouped specialisation copies the group TEMPLATE and renames it', async () => {
    const res = await da.addWfrp4eItems({
      actor: 'Ulric',
      items: [{ name: 'Entertain (Taunt)', advances: 5 }],
    });

    expect(world.embeddedCreates[0].docs[0]).toMatchObject({
      // The requested specialisation, trimmed — not the template's "Entertain ()".
      name: 'Entertain (Taunt)',
      type: 'skill',
      system: { advances: { value: 5 }, characteristic: { value: 'fel' } },
    });
    expect(res.created[0]!.source).toBe('Core Rulebook (grouped template)');
  });

  it('branch: an unmatched name becomes a BLANK item of the fallback type, defaulting to trapping', async () => {
    const res = await da.addWfrp4eItems({
      actor: 'Ulric',
      items: [{ name: 'Homebrew Charm' }, { name: 'Homebrew Skill', type: 'skill', advances: 4 }],
    });

    expect(world.embeddedCreates[0].docs).toEqual([
      { name: 'Homebrew Charm', type: 'trapping', system: {} },
      { name: 'Homebrew Skill', type: 'skill', system: { advances: { value: 4 } } },
    ]);
    expect(res.notFound).toEqual(['Homebrew Charm', 'Homebrew Skill']);
    expect(res.warnings).toEqual([
      '"Homebrew Charm" not found in any WFRP4e compendium — added as a blank trapping.',
      '"Homebrew Skill" not found in any WFRP4e compendium — added as a blank skill.',
    ]);
    expect(res.created.map((c: any) => c.source)).toEqual([
      'custom (not in compendium)',
      'custom (not in compendium)',
    ]);
  });

  it('`setCurrent` on a career flips the new career on and every existing one off', async () => {
    await installPacks(makeWfrp4eActor('Ulric', { careers: { Scout: true } }));

    await da.addWfrp4eItems({
      actor: 'Ulric',
      items: [{ name: 'Soldier', setCurrent: true }],
    });

    // The pre-existing career is `career-0` here (no skills were seeded), and the
    // new one is the id `createEmbeddedDocuments` minted.
    const created = world.embeddedCreates[0].docs[0];
    expect(created.type).toBe('career');
    expect(world.embeddedUpdates).toEqual([
      {
        actorId: id('Ulric'),
        type: 'Item',
        updates: [
          { _id: 'career-0', 'system.current.value': false },
          { _id: 'item-0', 'system.current.value': true },
        ],
      },
    ]);
  });

  it('branch: `setCurrent` on a non-career is ignored and no item update is issued', async () => {
    await da.addWfrp4eItems({
      actor: 'Ulric',
      items: [{ name: 'Athletics', setCurrent: true }],
    });

    expect(world.embeddedUpdates).toEqual([]);
  });

  it('summarises the created items by reading them back, and audits the created count', async () => {
    const res = await da.addWfrp4eItems({
      actor: 'Ulric',
      items: [
        { name: 'Athletics', advances: 7 },
        { name: 'Soldier', setCurrent: true },
      ],
    });

    expect(res.success).toBe(true);
    expect(res.actor).toBe('Ulric');
    expect(res.id).toBe(id('Ulric'));
    expect(res.created).toEqual([
      {
        id: 'item-0',
        name: 'Athletics',
        type: 'skill',
        source: 'Core Rulebook',
        // Read back from the embedded document, not from the request.
        advances: 7,
        total: undefined,
        characteristic: 'ag',
      },
      { id: 'item-1', name: 'Soldier', type: 'career', source: 'Core Rulebook', current: true },
    ]);
    // Audits the CREATED count, not the requested count.
    expect(audits()).toEqual([
      {
        operation: 'addWfrp4eItems',
        data: { actor: 'Ulric', count: 2 },
        result: 'success',
      },
    ]);
  });

  it('loads each pack index at most once per call, however many items are requested', async () => {
    await da.addWfrp4eItems({
      actor: 'Ulric',
      items: [{ name: 'Athletics' }, { name: 'Sword' }, { name: 'Entertain (Taunt)' }],
    });

    // Two packs, one `getIndex()` each — and the grouped-skill fallback re-searches
    // through the same cache.
    expect(world.packIndexCalls).toEqual([CORE, EXTRA]);
  });

  it('a failing embed audits a failure with the REQUESTED count, and returns an envelope', async () => {
    world.failEmbed.add('Sword');

    const res = await da.addWfrp4eItems({ actor: 'Ulric', items: [{ name: 'Sword' }] });

    expect(res).toEqual({ success: false, error: 'Foundry refused to embed "Sword"' });
    expect(audits()).toEqual([
      {
        operation: 'addWfrp4eItems',
        // `toCreate.length` on the failure path vs `created.length` on success.
        data: { actor: 'Ulric', count: 1 },
        result: 'failure',
        error: 'Foundry refused to embed "Sword"',
      },
    ]);
  });

  it.each([
    [
      'the wrong game system',
      { systemId: 'dnd5e' },
      { actor: 'Ulric', items: [{ name: 'Sword' }] },
      'wfrp4e-add-items requires the WFRP4e system (current: "dnd5e")',
    ],
    [
      'an empty items array',
      {},
      { actor: 'Ulric', items: [] },
      'items array is required and must contain at least one entry',
    ],
    [
      'a non-array items',
      {},
      { actor: 'Ulric', items: 'nope' },
      'items array is required and must contain at least one entry',
    ],
    [
      'an unknown actor',
      {},
      { actor: 'Nobody', items: [{ name: 'Sword' }] },
      'Actor not found: Nobody',
    ],
  ])(
    'guard: %s returns an envelope, writes nothing, audits nothing',
    async (_l, over, params, error) => {
      await install({
        systemId: 'wfrp4e',
        actors: [makeWfrp4eActor('Ulric')],
        ...(over as InstallOptions),
      });

      expect(await da.addWfrp4eItems(params as any)).toEqual({ success: false, error });
      expect(world.writes).toEqual([]);
      expect(world.audit).toEqual([]);
    }
  );
});

// =============================================================================
// createActors — and `normalizeMGT2eSkillKeys`, which is private and is
// exercised THROUGH it. The whole point of these tests is the `system` object,
// because the return value is a `{created, total}` counter that a
// mis-transcribed field does not change.
// =============================================================================

describe('createActors', () => {
  it('hands `Actor.createDocuments` one document per actor, in one batch, under a default folder', async () => {
    await install({ systemId: 'dnd5e' });

    const res = await da.createActors({
      actors: [
        { name: 'Guard', type: 'npc', img: 'icons/guard.webp', system: { hp: 11 } },
        { name: 'Rat', type: 'npc' },
      ],
    });

    expect(world.folderCreateCalls).toEqual(['Foundry MCP Actors']);
    expect(world.createDocumentsBatches).toEqual([2]);
    const folder = world.folders[0].id;
    expect(world.createCalls).toEqual([
      { name: 'Guard', type: 'npc', img: 'icons/guard.webp', system: { hp: 11 }, folder },
      // An absent `system` becomes `{}`.
      { name: 'Rat', type: 'npc', system: {}, folder },
    ]);
    // `toEqual` treats an `img: undefined` key as absent, so the KEY SET is
    // asserted separately: `img` must not be present at all.
    expect(Object.keys(world.createCalls[1])).toEqual(['name', 'type', 'system', 'folder']);
    expect(res).toEqual({
      created: [
        { id: world.actors[0].id, name: 'Guard', type: 'npc' },
        { id: world.actors[1].id, name: 'Rat', type: 'npc' },
      ],
      total: 2,
    });
    // No state validation and no audit call anywhere in this member.
    expect(world.audit).toEqual([]);
  });

  it('an explicit folder name is used, and a folder that cannot be made leaves the key off', async () => {
    await install({ systemId: 'dnd5e' });
    await da.createActors({ actors: [{ name: 'Guard', type: 'npc' }], folder: 'Ambush' });
    expect(world.folderCreateCalls).toEqual(['Ambush']);
    expect(world.createCalls[0].folder).toBe(world.folders[0].id);

    // `getOrCreateFolder` swallows the failure and returns null.
    await install({ systemId: 'dnd5e' });
    (globalThis as any).Folder.create = (): Promise<null> => Promise.resolve(null);
    await da.createActors({ actors: [{ name: 'Guard', type: 'npc' }] });
    expect(world.createCalls[0]).toEqual({ name: 'Guard', type: 'npc', system: {} });
  });

  it('guard: Foundry returning nothing throws rather than reporting zero created', async () => {
    await install({ systemId: 'dnd5e' });
    world.refuse.add('Guard');

    await expect(da.createActors({ actors: [{ name: 'Guard', type: 'npc' }] })).rejects.toThrow(
      'Foundry failed to create actor documents'
    );
  });

  it('branch: a non-mgt2e system passes `system` through completely untouched', async () => {
    await install({ systemId: 'dnd5e' });

    await da.createActors({
      actors: [{ name: 'Trav', type: 'traveller', system: { skills: { gunCombat: 2 } } }],
    });

    // No lowercasing, no skills default, no characteristics normalisation.
    expect(world.createCalls[0].system).toEqual({ skills: { gunCombat: 2 } });
  });

  describe('mgt2e', () => {
    beforeEach(() => install({ systemId: 'mgt2e' }));

    it('lowercases nested skill keys and injects an empty `skills` when there is none', async () => {
      await da.createActors({
        actors: [
          { name: 'Ship', type: 'ship', system: { skills: { gunCombat: 2, Pilot: 1 } } },
          { name: 'Bare', type: 'ship' },
        ],
      });

      expect(world.createCalls[0].system).toEqual({ skills: { guncombat: 2, pilot: 1 } });
      // The default exists purely so mgt2e's `_prepareCreatureData` can iterate it.
      expect(world.createCalls[1].system).toEqual({ skills: {} });
    });

    it('lowercases the FLAT skill-key forms too, including the `-=` deletion operator', async () => {
      await da.createActors({
        actors: [
          {
            name: 'Ship',
            type: 'ship',
            system: {
              'skills.-=gunCombat': null,
              'skills.Pilot.value': 3,
              'skills.Melee': { value: 1 },
              other: 'kept',
            },
          },
        ],
      });

      expect(world.createCalls[0].system).toEqual({
        // The injected default, plus each flat key with only its FIRST segment
        // lowercased — the tail of a dotted path keeps its case.
        skills: {},
        'skills.-=guncombat': null,
        'skills.pilot.value': 3,
        'skills.melee': { value: 1 },
        other: 'kept',
      });
    });

    it('a skill object that omits `trained` is trained by default; the shorthand form too', async () => {
      await da.createActors({
        actors: [
          {
            name: 'Trav',
            type: 'traveller',
            system: {
              skills: {
                // Object form with NO `trained` key — the default is what is
                // under test, and the object spread must not overwrite it.
                admin: { value: 3 },
                // Explicit `false` must survive the default.
                broker: { value: 1, trained: false },
              },
            },
          },
        ],
      });

      expect(world.createCalls[0].system.skills).toEqual({
        admin: { id: 'admin', value: 3, trained: true },
        broker: { id: 'broker', value: 1, trained: false },
      });
    });

    it('a traveller’s number-shorthand skill becomes a trained skill with an id and specialities', async () => {
      await da.createActors({
        actors: [{ name: 'Trav', type: 'traveller', system: { skills: { Pilot: 2, admin: 1 } } }],
      });

      expect(world.createCalls[0].system.skills).toEqual({
        pilot: {
          id: 'pilot',
          value: 2,
          trained: true,
          // Auto-populated from the built-in speciality table.
          specialities: {
            smallCraft: { value: 0, trained: false },
            spacecraft: { value: 0, trained: false },
            capitalShips: { value: 0, trained: false },
          },
        },
        // A skill with no speciality table gets no `specialities` key at all.
        admin: { id: 'admin', value: 1, trained: true },
      });
    });

    it('a skill’s parent value becomes the MINIMUM of the caller’s active speciality values', async () => {
      await da.createActors({
        actors: [
          {
            name: 'Trav',
            type: 'traveller',
            system: {
              skills: {
                pilot: {
                  value: 9,
                  trained: true,
                  specialities: {
                    spacecraft: { value: 3, trained: true },
                    smallCraft: { value: 2, trained: true },
                    // Zero is not "active" and does not drag the minimum down.
                    capitalShips: { value: 0, trained: false },
                  },
                },
              },
            },
          },
        ],
      });

      const pilot = world.createCalls[0].system.skills.pilot;
      // The caller's own 9 is overwritten by min(3, 2).
      expect(pilot.value).toBe(2);
      // Existing specialities are preserved, missing ones added.
      expect(pilot.specialities).toEqual({
        spacecraft: { value: 3, trained: true },
        smallCraft: { value: 2, trained: true },
        capitalShips: { value: 0, trained: false },
      });
    });

    it('characteristics are UPPERCASED, shown, damage-zeroed, and hits are derived from STR+DEX+END', async () => {
      await da.createActors({
        actors: [
          {
            name: 'Trav',
            type: 'traveller',
            system: {
              characteristics: {
                str: 8,
                dex: { value: 7, trained: true },
                end: 'nonsense' as any,
                int: 6,
              },
            },
          },
        ],
      });

      expect(world.createCalls[0].system.characteristics).toEqual({
        STR: { value: 8, damage: 0, show: true },
        // An object is spread, `show` forced on, `damage` defaulted.
        DEX: { show: true, value: 7, trained: true, damage: 0 },
        // A non-number, non-object value falls back to 7.
        END: { value: 7, damage: 0, show: true },
        INT: { value: 6, damage: 0, show: true },
      });
      // 8 + 7 + 7 — END fell back to 7, and the default for an absent key is 7.
      expect(world.createCalls[0].system.hits).toEqual({ value: 22, max: 22 });
    });

    it('branch: caller-supplied hits are kept, and no characteristics means no hits at all', async () => {
      await da.createActors({
        actors: [
          {
            name: 'A',
            type: 'traveller',
            system: { characteristics: { str: 12 }, hits: { value: 1, max: 40 } },
          },
          { name: 'B', type: 'traveller', system: { skills: { pilot: 1 } } },
        ],
      });

      expect(world.createCalls[0].system.hits).toEqual({ value: 1, max: 40 });
      expect(world.createCalls[1].system.hits).toBeUndefined();
    });

    it('`details` is remapped to `sophont`, career becomes profession, description is hoisted', async () => {
      await da.createActors({
        actors: [
          {
            name: 'Trav',
            type: 'npc',
            system: {
              details: { career: 'Scout', species: 'Human', description: 'A wanderer.' },
            },
          },
        ],
      });

      expect(world.createCalls[0].system).toEqual({
        skills: {},
        // `details` is gone entirely — the key does not exist in mgt2e.
        sophont: { profession: 'Scout', species: 'Human' },
        // Hoisted to the top level, NOT left under sophont.
        description: 'A wanderer.',
      });
    });

    it('branch: an existing `sophont` blocks the remap and `details` survives verbatim', async () => {
      await da.createActors({
        actors: [
          {
            name: 'Trav',
            type: 'npc',
            system: { sophont: { profession: 'Marine' }, details: { career: 'Scout' } },
          },
        ],
      });

      expect(world.createCalls[0].system).toEqual({
        skills: {},
        sophont: { profession: 'Marine' },
        details: { career: 'Scout' },
      });
    });

    it('branch: a `details` block that maps to nothing still removes the key', async () => {
      await da.createActors({
        actors: [{ name: 'Trav', type: 'npc', system: { details: { description: 'Only text.' } } }],
      });

      expect(world.createCalls[0].system).toEqual({ skills: {}, description: 'Only text.' });
    });

    it('a `software` actor gets spacecraft defaults so the sheet does not read undefined', async () => {
      await da.createActors({
        actors: [
          { name: 'Nav', type: 'software' },
          { name: 'Custom', type: 'software', system: { software: { bandwidth: 3 } } },
        ],
      });

      expect(world.createCalls[0].system).toEqual({
        skills: {},
        software: { class: 'spacecraft', type: 'generic', interface: 'none', bandwidth: 0 },
      });
      // A caller-supplied `software` is left exactly as given.
      expect(world.createCalls[1].system.software).toEqual({ bandwidth: 3 });
    });

    it('branch: `software` defaults are mgt2e-only', async () => {
      await install({ systemId: 'dnd5e' });
      await da.createActors({ actors: [{ name: 'Nav', type: 'software' }] });
      expect(world.createCalls[0].system).toEqual({});
    });
  });
});

// =============================================================================
// updateActors / updateActorItems / deleteActorItems / deleteActors — the four
// zero-collaborator members. None validates Foundry state, none audits, and each
// hands Foundry exactly one payload.
// =============================================================================

describe('updateActors', () => {
  beforeEach(async () => {
    await install({ actors: [makeMgt2eActor('Beowulf'), makeActor('Lena')], systemId: 'mgt2e' });
  });

  it('patches only the fields supplied, and nests `system` in ONE object for a single deep merge', async () => {
    const res = await da.updateActors([
      { id: id('Beowulf'), name: 'Beowulf II', system: { 'crewed.passengers.-=abc': null } },
      { id: id('Lena'), img: 'icons/lena.webp' },
    ]);

    expect(world.updates).toEqual([
      {
        id: id('Beowulf'),
        patch: {
          name: 'Beowulf II',
          // The flat dot-key is EXPANDED, so Foundry's mergeObject sees the `-=`
          // deletion operator at depth rather than a literal key.
          system: { crewed: { passengers: { '-=abc': null } } },
        },
      },
      { id: id('Lena'), patch: { img: 'icons/lena.webp' } },
    ]);
    // The response is a counter — this is why the patch above is what is asserted.
    expect(res).toEqual({
      updated: [
        { id: id('Beowulf'), name: 'Beowulf II' },
        // No `name` in the request, so the actor's current name is reported.
        { id: id('Lena'), name: 'Lena' },
      ],
      total: 2,
    });
    expect(world.audit).toEqual([]);
  });

  it('merges flat and nested keys under the same branch into one tree', async () => {
    await da.updateActors([
      {
        id: id('Beowulf'),
        system: {
          'hits.value': 3,
          'hits.max': 30,
          'characteristics.STR.value': 9,
          skills: { pilot: { value: 2 } },
        },
      },
    ]);

    expect(world.updates[0].patch).toEqual({
      system: {
        hits: { value: 3, max: 30 },
        characteristics: { STR: { value: 9 } },
        skills: { pilot: { value: 2 } },
      },
    });
  });

  it('branch: an empty update list writes nothing and reports zero', async () => {
    expect(await da.updateActors([])).toEqual({ updated: [], total: 0 });
    expect(world.writes).toEqual([]);
  });

  it('branch: a patch with no recognised keys still issues an EMPTY update', async () => {
    await da.updateActors([{ id: id('Lena') }]);
    expect(world.updates).toEqual([{ id: id('Lena'), patch: {} }]);
  });

  it('guard: an unknown id throws mid-batch, after the earlier actors were already written', async () => {
    await expect(
      da.updateActors([
        { id: id('Lena'), name: 'First' },
        { id: 'ghost', name: 'Second' },
      ])
    ).rejects.toThrow('Actor not found: ghost');

    // Not transactional: the first write already landed.
    expect(world.updates).toEqual([{ id: id('Lena'), patch: { name: 'First' } }]);
  });

  it('guard: an actor is resolved by id only — never by name', async () => {
    await expect(da.updateActors([{ id: 'Lena', name: 'X' }])).rejects.toThrow(
      'Actor not found: Lena'
    );
  });
});

describe('updateActorItems', () => {
  const items = (): Record<string, any>[] => [
    { id: 'i-1', name: 'Sword', type: 'weapon', system: { damage: 1 } },
    { id: 'i-2', name: 'Rope', type: 'gear', system: {} },
  ];

  beforeEach(async () => {
    await install({ actors: [makeActor('Lena', { items: items() })] });
  });

  it('patches each item with only the fields supplied, and reports the resulting names', async () => {
    const res = await da.updateActorItems(id('Lena'), [
      { id: 'i-1', name: 'Longsword', system: { damage: 4 } },
      { id: 'i-2', img: 'icons/rope.webp' },
    ]);

    expect(world.itemUpdates).toEqual([
      { id: 'i-1', patch: { name: 'Longsword', system: { damage: 4 } } },
      { id: 'i-2', patch: { img: 'icons/rope.webp' } },
    ]);
    expect(res).toEqual({
      updated: [
        { id: 'i-1', name: 'Longsword' },
        // No new name, so the item's own name is reported.
        { id: 'i-2', name: 'Rope' },
      ],
      total: 2,
    });
    expect(world.audit).toEqual([]);
  });

  it('resolves the actor by id first, then by name case-insensitively', async () => {
    await da.updateActorItems('lena', [{ id: 'i-1', name: 'A' }]);
    expect(world.itemUpdates).toEqual([{ id: 'i-1', patch: { name: 'A' } }]);
  });

  it('branch: an item `system` is replaced wholesale, not merged, and is NOT dot-expanded', async () => {
    await da.updateActorItems(id('Lena'), [{ id: 'i-1', system: { 'a.b': 1 } }]);
    expect(world.itemUpdates[0].patch).toEqual({ system: { 'a.b': 1 } });
  });

  it('guard: an unknown actor throws before any write', async () => {
    await expect(da.updateActorItems('ghost', [{ id: 'i-1', name: 'A' }])).rejects.toThrow(
      'Actor not found: ghost'
    );
    expect(world.writes).toEqual([]);
  });

  it('guard: an unknown item names the actor, and earlier items are already written', async () => {
    await expect(
      da.updateActorItems(id('Lena'), [
        { id: 'i-1', name: 'A' },
        { id: 'ghost', name: 'B' },
      ])
    ).rejects.toThrow('Item ghost not found on actor "Lena"');
    expect(world.itemUpdates).toEqual([{ id: 'i-1', patch: { name: 'A' } }]);
  });
});

describe('deleteActorItems', () => {
  beforeEach(async () => {
    await install({
      actors: [
        makeActor('Lena', {
          items: [
            { id: 'i-1', name: 'Sword', type: 'weapon' },
            { id: 'i-2', name: 'Rope', type: 'gear' },
          ],
        }),
      ],
    });
  });

  it('hands Foundry only the ids that exist, silently dropping the rest', async () => {
    const res = await da.deleteActorItems(id('Lena'), ['i-2', 'ghost', 'i-1']);

    expect(world.embeddedDeletes).toEqual([
      // Request order preserved, unknown id filtered out — and NOT reported.
      { actorId: id('Lena'), type: 'Item', ids: ['i-2', 'i-1'] },
    ]);
    expect(res).toEqual({ deleted: ['i-2', 'i-1'], total: 2 });
    expect(world.audit).toEqual([]);
  });

  it('resolves the actor by name case-insensitively as well as by id', async () => {
    await da.deleteActorItems('LENA', ['i-1']);
    expect(world.embeddedDeletes[0].ids).toEqual(['i-1']);
  });

  it('guard: no id matching anything throws rather than deleting nothing quietly', async () => {
    await expect(da.deleteActorItems(id('Lena'), ['ghost'])).rejects.toThrow(
      'None of the provided item IDs were found on this actor'
    );
    expect(world.writes).toEqual([]);
  });

  it('guard: an unknown actor throws before the item lookup', async () => {
    await expect(da.deleteActorItems('ghost', ['i-1'])).rejects.toThrow('Actor not found: ghost');
  });
});

describe('deleteActors', () => {
  beforeEach(async () => {
    await install({ actors: [makeActor('Lena'), makeActor('Mika')] });
  });

  it('hands `Actor.deleteDocuments` one filtered id list, in request order', async () => {
    const res = await da.deleteActors([id('Mika'), 'ghost', id('Lena')]);

    expect(world.actorDeletes).toEqual([[id('Mika'), id('Lena')]]);
    expect(res).toEqual({ deleted: [id('Mika'), id('Lena')], total: 2 });
    expect(world.audit).toEqual([]);
    // A real delete — the world collection shrinks.
    expect(world.actors).toEqual([]);
  });

  it('guard: an actor is matched by id only, never by name', async () => {
    await expect(da.deleteActors(['Lena'])).rejects.toThrow(
      'None of the provided actor IDs were found'
    );
    expect(world.writes).toEqual([]);
  });

  it('guard: an empty list throws', async () => {
    await expect(da.deleteActors([])).rejects.toThrow('None of the provided actor IDs were found');
  });
});

// =============================================================================
// Which members validate Foundry state, and which do not.
//
// `validateFoundryState` is one of the four cross-boundary calls the extraction
// has to re-point, and it is invisible in every test above because the fake world
// is always ready. So it gets its own block: a member that drops the call, or
// gains one it never had, moves between these two lists.
// =============================================================================

describe('Foundry-state validation', () => {
  const notReady = async (): Promise<void> => {
    await install({
      systemId: 'wfrp4e',
      actors: [makeActor('Lena', { items: [{ id: 'i-1', name: 'Sword', type: 'weapon' }] })],
      users: [{ id: 'user-2', name: 'Ana', isGM: false }],
      settings: WRITES_ALLOWED,
      packs: [creaturePack(goblinDoc())],
      activeScene: { tokens: [] },
    });
    (globalThis as any).game.ready = false;
  };

  it.each([
    [
      'createActorFromCompendiumEntry',
      (d: any): Promise<any> =>
        d.createActorFromCompendiumEntry({
          packId: 'dnd5e.monsters',
          itemId: 'goblin-1',
          customNames: ['X'],
        }),
    ],
    [
      'addActorItems',
      (d: any): Promise<any> =>
        d.addActorItems({ actorIdentifier: 'Lena', items: [{ name: 'A', type: 'b' }] }),
    ],
    [
      'removeActorItems',
      (d: any): Promise<any> => d.removeActorItems({ actorIdentifier: 'Lena', itemIds: ['i-1'] }),
    ],
    [
      'addActorsToScene',
      (d: any): Promise<any> =>
        d.addActorsToScene({ actorIds: [id('Lena')], placement: 'grid', hidden: false }),
    ],
    [
      'setActorOwnership',
      (d: any): Promise<any> =>
        d.setActorOwnership({ actorId: id('Lena'), userId: 'user-2', permission: 2 }),
    ],
    [
      'updateWfrp4eActor',
      (d: any): Promise<any> => d.updateWfrp4eActor({ actor: 'Lena', wounds: { value: 1 } }),
    ],
    [
      'addWfrp4eItems',
      (d: any): Promise<any> => d.addWfrp4eItems({ actor: 'Lena', items: [{ name: 'A' }] }),
    ],
    ['getActorOwnership', (d: any): Promise<any> => d.getActorOwnership({})],
  ])('%s validates first and throws when Foundry is not ready', async (_name, call) => {
    await notReady();
    await expect(call(da)).rejects.toThrow('Foundry VTT is not ready');
    expect(world.writes).toEqual([]);
    expect(world.audit).toEqual([]);
  });

  it.each([
    [
      'createActors',
      (d: any): Promise<any> => d.createActors({ actors: [{ name: 'A', type: 'npc' }] }),
    ],
    ['updateActors', (d: any): Promise<any> => d.updateActors([{ id: id('Lena'), name: 'B' }])],
    [
      'updateActorItems',
      (d: any): Promise<any> => d.updateActorItems(id('Lena'), [{ id: 'i-1', name: 'C' }]),
    ],
    ['deleteActorItems', (d: any): Promise<any> => d.deleteActorItems(id('Lena'), ['i-1'])],
    ['deleteActors', (d: any): Promise<any> => d.deleteActors([id('Lena')])],
  ])('%s does NOT validate — it writes even with Foundry not ready', async (_name, call) => {
    await notReady();
    await expect(call(da)).resolves.toBeTruthy();
    expect(world.writes.length).toBeGreaterThan(0);
  });
});
