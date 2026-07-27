/**
 * `FoundryDataAccess.importActors` — the module-side half of the WoD actor import.
 *
 * These drive the REAL implementation against a minimal fake Foundry world
 * installed on `globalThis` (`game`, `Actor`, `Hooks`, `foundry.utils`). That is
 * enough because the module only touches those globals at call time. It means the
 * two guarantees that cannot be tested from the server package — per-actor error
 * capture, and sourceId-at-creation reconcilability — are covered here for real
 * rather than against a stub of themselves.
 *
 * Covers:
 *   - "a batch SHALL report per-actor results even when it does not complete"
 *   - "a timed-out import SHALL remain reconcilable"
 *   - "the import tool SHALL offer a dry run" (module half: writes nothing)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { installFakeFoundry, makeDataAccess, type FakeWorld } from './__fixtures__/fake-foundry.js';

// ─── Fake Foundry world ───────────────────────────────────────────────────────
//
// The harness this file used to build inline now lives in
// `__fixtures__/fake-foundry.ts`, shared with `actor-read-path.test.ts` and the
// mechanics-builder characterization tests. Every recorder these tests assert on
// (`createCalls`, `updateCalls`, `folderCreateCalls`, `refuse`, `explode`) is
// unchanged; the fixture only adds more of them.

let world: FakeWorld;

function installWorld(): void {
  world = installFakeFoundry();
}

/** A minimal but valid exported actor document. */
function doc(name: string, sourceId?: string, extra: Record<string, any> = {}) {
  return {
    name,
    type: 'mortal',
    system: { attributes: { strength: { value: 2 } } },
    img: `wod20-portraits/${name}.webp`,
    ...(sourceId ? { flags: { wodchar: { sourceId } } } : {}),
    ...extra,
  };
}

beforeEach(() => {
  installWorld();
});

// ─── Requirement: per-actor results even when the batch does not complete ─────

describe('per-actor error capture', () => {
  it('one document Foundry refuses does not hide the other four', async () => {
    const da = await makeDataAccess();
    world.refuse.add('C');

    const res = await da.importActors({
      actors: ['A', 'B', 'C', 'D', 'E'].map(n => doc(n, `src-${n}`)),
      folder: 'Berlin Students',
    });

    expect(res.total).toBe(5);
    expect(res.counts).toMatchObject({ created: 4, failed: 1, skipped: 0, updated: 0 });
    const byName = Object.fromEntries(res.results.map((r: any) => [r.name, r]));
    for (const n of ['A', 'B', 'D', 'E']) {
      expect(byName[n].status).toBe('created');
      expect(byName[n].id).toBeTruthy();
    }
    expect(byName['C'].status).toBe('failed');
    expect(byName['C'].id).toBeNull();
    expect(byName['C'].error).toMatch(/Foundry failed to create actor: C/);
    // The batch really continued: D and E exist in the world.
    expect(world.actors.map(a => a.name)).toEqual(['A', 'B', 'D', 'E']);
  });

  it('captures a thrown Foundry exception as one failed entry', async () => {
    const da = await makeDataAccess();
    world.explode.add('B');
    const res = await da.importActors({ actors: ['A', 'B', 'C'].map(n => doc(n, `src-${n}`)) });
    expect(res.counts).toMatchObject({ created: 2, failed: 1 });
    expect(res.results[1].error).toMatch(/Foundry exploded on B/);
  });

  it('reports an invalid document as failed instead of aborting the batch', async () => {
    // This is the case that used to throw from the pre-flight loop in queries.ts
    // ("each actor document must have name, type, and system") and collapse the
    // whole call into one error string.
    const da = await makeDataAccess();
    const res = await da.importActors({
      actors: [
        doc('Good1', 'src-1'),
        { name: 'NoSystem', type: 'mortal' },
        doc('Good2', 'src-2'),
        { type: 'mortal', system: {} },
      ],
    });
    expect(res.total).toBe(4);
    expect(res.counts).toMatchObject({ created: 2, failed: 2 });
    expect(res.results[1].status).toBe('failed');
    expect(res.results[1].error).toMatch(/missing required field\(s\): system/);
    expect(res.results[3].name).toBe('(unnamed)');
    expect(res.results[3].error).toMatch(/missing required field\(s\): name/);
    expect(world.actors.map(a => a.name)).toEqual(['Good1', 'Good2']);
  });

  it('stopOnError restores the old abort-on-first-failure behaviour, with results kept', async () => {
    const da = await makeDataAccess();
    world.refuse.add('B');
    const res = await da.importActors({
      actors: ['A', 'B', 'C'].map(n => doc(n, `src-${n}`)),
      stopOnError: true,
    });
    expect(res.aborted).toBe(true);
    // Even aborting, the outcome of A is not discarded.
    expect(res.results.map((r: any) => r.status)).toEqual(['created', 'failed']);
    expect(world.actors.map(a => a.name)).toEqual(['A']);
  });

  it('never collapses into a thrown error, whatever the batch contains', async () => {
    const da = await makeDataAccess();
    world.refuse.add('A');
    world.explode.add('B');
    await expect(
      da.importActors({ actors: [doc('A', 's1'), doc('B', 's2'), null as any, doc('C', 's3')] })
    ).resolves.toBeTruthy();
  });

  it('flags a created actor that has no sourceId as unreconcilable', async () => {
    const da = await makeDataAccess();
    const res = await da.importActors({ actors: [doc('Anon')] });
    expect(res.results[0].status).toBe('created');
    expect(res.results[0].sourceId).toBeNull();
    expect(res.results[0].error).toMatch(/no sourceId — a retry would duplicate/);
  });
});

// ─── Requirement: a timed-out import remains reconcilable ────────────────────

describe('reconcilability: sourceId is stamped AT creation', () => {
  it('the document handed to Actor.create already carries flags.wodchar.sourceId', async () => {
    const da = await makeDataAccess();
    await da.importActors({ actors: [doc('Ada', 'wodchar-ada')] });
    // The guarantee is about ordering: no post-create setFlag, so there is no
    // window in which the actor exists un-stamped.
    expect(world.createCalls).toHaveLength(1);
    expect(world.createCalls[0].flags.wodchar.sourceId).toBe('wodchar-ada');
    expect(world.updateCalls).toEqual([]);
    expect(world.actors[0].flags.wodchar.sourceId).toBe('wodchar-ada');
  });

  it('stamps an out-of-band top-level sourceId too', async () => {
    const da = await makeDataAccess();
    await da.importActors({ actors: [{ ...doc('Bob'), sourceId: 'oob-bob' }] });
    expect(world.createCalls[0].flags.wodchar.sourceId).toBe('oob-bob');
    // `sourceId` is not a real Actor field and must not be passed through.
    expect(world.createCalls[0].sourceId).toBeUndefined();
  });

  it('retrying after a timeout that created 2 of 6 skips those 2 and creates the other 4', async () => {
    const da = await makeDataAccess();
    const batch = Array.from({ length: 6 }, (_, i) => doc(`S${i}`, `src-S${i}`));

    // First attempt: the query times out after two actors. A timed-out query is
    // NOT cancelled Foundry-side, so those two persist — simulate exactly that.
    await da.importActors({ actors: batch.slice(0, 2), folder: 'Berlin' });
    expect(world.actors).toHaveLength(2);

    // The caller retries THE SAME batch.
    const retry = await da.importActors({ actors: batch, folder: 'Berlin' });

    expect(retry.total).toBe(6);
    expect(retry.counts).toMatchObject({ skipped: 2, created: 4, failed: 0 });
    expect(retry.results.slice(0, 2).map((r: any) => r.status)).toEqual(['skipped', 'skipped']);
    // No duplicates: six actors in the world, one per sourceId.
    expect(world.actors).toHaveLength(6);
    const ids = world.actors.map(a => a.flags.wodchar.sourceId);
    expect(new Set(ids).size).toBe(6);
  });

  it('retrying with overwrite updates the existing two in place rather than duplicating', async () => {
    const da = await makeDataAccess();
    const batch = Array.from({ length: 4 }, (_, i) => doc(`S${i}`, `src-S${i}`));
    await da.importActors({ actors: batch.slice(0, 2) });
    const firstIds = world.actors.map(a => a.id);

    const retry = await da.importActors({ actors: batch, overwrite: true });
    expect(retry.counts).toMatchObject({ updated: 2, created: 2 });
    expect(world.actors).toHaveLength(4);
    // Same documents, same ids — updated in place.
    expect(world.actors.slice(0, 2).map(a => a.id)).toEqual(firstIds);
    expect(retry.results.slice(0, 2).map((r: any) => r.id)).toEqual(firstIds);
  });

  it('finds an existing actor via raw flag access, not getFlag', async () => {
    // getFlag throws for the unregistered `wodchar` scope; a regression here would
    // silently break idempotency and start duplicating on every retry.
    const da = await makeDataAccess();
    await da.importActors({ actors: [doc('Ada', 'wodchar-ada')] });
    (world.actors[0] as any).getFlag = () => {
      throw new Error("Flag scope 'wodchar' is not valid or not currently active");
    };
    const again = await da.importActors({ actors: [doc('Ada', 'wodchar-ada')] });
    expect(again.results[0].status).toBe('skipped');
    expect(world.actors).toHaveLength(1);
  });

  it('reports the sourceId it actually keyed off, per actor', async () => {
    const da = await makeDataAccess();
    const res = await da.importActors({
      actors: [doc('A', 'src-a'), { ...doc('B'), sourceId: 'src-b' }, doc('C')],
    });
    expect(res.results.map((r: any) => r.sourceId)).toEqual(['src-a', 'src-b', null]);
  });
});

// ─── Requirement: dry run ────────────────────────────────────────────────────

describe('dry run writes nothing', () => {
  it('predicts would-create / would-skip against existing sourceIds', async () => {
    const da = await makeDataAccess();
    const batch = Array.from({ length: 6 }, (_, i) => doc(`S${i}`, `src-S${i}`));
    // Two already exist.
    await da.importActors({ actors: batch.slice(0, 2), folder: 'Berlin' });
    const before = structuredClone(world.actors.map(a => ({ id: a.id, name: a.name })));
    world.createCalls.length = 0;
    world.folderCreateCalls.length = 0;
    world.updateCalls.length = 0;

    const res = await da.importActors({ actors: batch, folder: 'Berlin', dryRun: true });

    expect(res.dryRun).toBe(true);
    expect(res.total).toBe(6);
    expect(res.counts).toMatchObject({ wouldSkip: 2, wouldCreate: 4, created: 0, updated: 0 });
    expect(res.results.slice(0, 2).map((r: any) => r.status)).toEqual(['would-skip', 'would-skip']);
    expect(res.results.slice(2).map((r: any) => r.status)).toEqual([
      'would-create',
      'would-create',
      'would-create',
      'would-create',
    ]);
    // The world is unchanged: no Actor.create, no update, no folder creation.
    expect(world.createCalls).toEqual([]);
    expect(world.updateCalls).toEqual([]);
    expect(world.folderCreateCalls).toEqual([]);
    expect(world.actors.map(a => ({ id: a.id, name: a.name }))).toEqual(before);
  });

  it('reports would-update when overwrite is set', async () => {
    const da = await makeDataAccess();
    await da.importActors({ actors: [doc('A', 'src-a')] });
    const res = await da.importActors({
      actors: [doc('A', 'src-a')],
      overwrite: true,
      dryRun: true,
    });
    expect(res.counts.wouldUpdate).toBe(1);
    expect(res.results[0].id).toBe(world.actors[0].id);
    expect(world.updateCalls).toEqual([]);
  });

  it('does not create a folder that does not exist yet', async () => {
    const da = await makeDataAccess();
    const res = await da.importActors({
      actors: [doc('A', 'src-a')],
      folder: 'Brand New',
      dryRun: true,
    });
    expect(world.folderCreateCalls).toEqual([]);
    expect(world.folders).toEqual([]);
    // The verdict still stands, and names the folder it would have used.
    expect(res.results[0]).toMatchObject({ status: 'would-create', folder: 'Brand New' });
  });

  it('still reports an invalid document as failed in a dry run', async () => {
    const da = await makeDataAccess();
    const res = await da.importActors({ actors: [{ name: 'x', type: 'mortal' }], dryRun: true });
    expect(res.counts.failed).toBe(1);
    expect(world.createCalls).toEqual([]);
  });
});

// ─── The query-handler layer ─────────────────────────────────────────────────

describe('QueryHandlers.handleImportActors', () => {
  it('no longer pre-flight-validates documents in an abort-the-batch loop', async () => {
    const mod = await import('./queries.js');
    const handlers = new mod.QueryHandlers() as any;
    const res = await handlers.handleImportActors({
      actors: [doc('Good', 'src-good'), { name: 'Bad', type: 'mortal' }],
    });
    // Previously this threw and the caller saw only
    // "each actor document must have name, type, and system".
    expect(res.total).toBe(2);
    expect(res.counts).toMatchObject({ created: 1, failed: 1 });
  });

  it('still rejects a whole-request precondition failure', async () => {
    const mod = await import('./queries.js');
    const handlers = new mod.QueryHandlers() as any;
    await expect(handlers.handleImportActors({ actors: [] })).rejects.toThrow(
      /actors array is required/
    );
  });

  it('still refuses a non-GM caller', async () => {
    (globalThis as any).game.user.isGM = false;
    const mod = await import('./queries.js');
    const handlers = new mod.QueryHandlers() as any;
    const res = await handlers.handleImportActors({ actors: [doc('A', 'src-a')] });
    expect(res).toEqual({ error: 'Access denied', success: false });
    expect(world.createCalls).toEqual([]);
  });

  it('advertises the dryRun capability on ping so the server can gate on it', async () => {
    const mod = await import('./queries.js');
    const handlers = new mod.QueryHandlers() as any;
    const pong = await handlers.handlePing();
    expect(pong.capabilities).toContain('importActors.dryRun');
    expect(pong.capabilities).toContain('importActors.perActorResults');
    // Additive: the original ping fields are untouched.
    expect(pong).toMatchObject({ status: 'ok', worldId: 'test-world' });
  });
});

// ─── Requirement: folder placement is preserved on update, and dryRun predicts it ──
//
// Regression: the folder was resolved BEFORE the create/update branch as
// `params.folder ?? doc.folderName ?? 'Foundry MCP Actors'`, so an overwrite that
// named no folder clobbered the actor's existing placement. Six production PCs
// filed under "Estudiantes" were silently moved into "Foundry MCP Actors". Worse,
// the dry run reported the EXISTING folder while the real run applied the default,
// so it could not warn about the move it was about to cause.

describe('folder placement on update', () => {
  it('keeps the actor where it is when the caller names no folder', async () => {
    const da = await makeDataAccess();
    await da.importActors({ actors: [doc('Lena', 'src-lena')], folder: 'Estudiantes' });
    world.folderCreateCalls.length = 0;

    const res = await da.importActors({ actors: [doc('Lena', 'src-lena')], overwrite: true });

    expect(res.results[0].status).toBe('updated');
    expect(res.results[0].folder).toBe('Estudiantes');
    expect(world.actors.find(a => a.name === 'Lena')!.folder).toEqual({ name: 'Estudiantes' });
    // Nothing may be created for a folder we never intended to set: getOrCreateFolder writes.
    expect(world.folderCreateCalls).toEqual([]);
  });

  it('moves the actor when the caller does name a folder', async () => {
    const da = await makeDataAccess();
    await da.importActors({ actors: [doc('Lena', 'src-lena')], folder: 'Estudiantes' });

    const res = await da.importActors({
      actors: [doc('Lena', 'src-lena')],
      folder: 'Camarilla',
      overwrite: true,
    });

    expect(res.results[0].folder).toBe('Camarilla');
    // The fake's update() assigns the patch verbatim, so `folder` is the raw id here
    // (real Foundry resolves it to a Folder document). Resolve it back to a name.
    const moved = world.actors.find(a => a.name === 'Lena')! as any;
    const movedId = typeof moved.folder === 'string' ? moved.folder : moved.folder?.id;
    expect(world.folders.find(f => f.id === movedId)?.name).toBe('Camarilla');
  });

  it('still applies the default folder when creating with none named', async () => {
    const da = await makeDataAccess();
    const res = await da.importActors({ actors: [doc('Nueva', 'src-nueva')] });
    expect(res.results[0].status).toBe('created');
    expect(res.results[0].folder).toBe('Foundry MCP Actors');
    expect(world.folderCreateCalls).toEqual(['Foundry MCP Actors']);
  });

  it('does not create a folder for an actor it only skips', async () => {
    const da = await makeDataAccess();
    await da.importActors({ actors: [doc('Lena', 'src-lena')], folder: 'Estudiantes' });
    world.folderCreateCalls.length = 0;

    // No overwrite: the actor exists, so this is a no-op and must write nothing.
    const res = await da.importActors({ actors: [doc('Lena', 'src-lena')], folder: 'Otra' });

    expect(res.results[0].status).toBe('skipped');
    expect(world.folderCreateCalls).toEqual([]);
  });

  // The one that stops this regressing: run the dry run and the real write over the
  // SAME input and require the folder they report to be identical. The two code
  // paths are separate and can drift apart again; this makes drift a test failure.
  it.each([
    ['update, no folder named', { overwrite: true } as Record<string, unknown>],
    ['update, folder named', { folder: 'Camarilla', overwrite: true }],
    ['create, no folder named', { sourceId: 'src-fresh' }],
    ['create, folder named', { folder: 'Camarilla', sourceId: 'src-fresh' }],
  ])('dryRun predicts the folder the real run applies (%s)', async (_label, opts) => {
    const { sourceId = 'src-lena', ...params } = opts as any;
    const seed = async () => {
      const da = await makeDataAccess();
      // Only pre-file the actor for the update cases.
      if (sourceId === 'src-lena') {
        await da.importActors({ actors: [doc('Lena', 'src-lena')], folder: 'Estudiantes' });
      }
      return da;
    };

    installWorld();
    const daDry = await seed();
    const dry = await daDry.importActors({
      actors: [doc('Lena', sourceId)],
      ...params,
      dryRun: true,
    });

    installWorld();
    const daReal = await seed();
    const real = await daReal.importActors({ actors: [doc('Lena', sourceId)], ...params });

    expect(dry.results[0].folder).toBe(real.results[0].folder);
  });
});
