/**
 * `worldofdarkness-import-actor` tool tests.
 *
 * The Foundry side is stubbed: `foundryClient.query` is a spy, so these assert
 * exactly what the server sends over the bridge (how many queries, how big, with
 * what timeout) and how it shapes what comes back — which is where every
 * requirement in this spec delta lands on the server side.
 *
 * Notably, `simulateSizeCeiling()` reproduces the ORIGINAL failure: a bridge that
 * rejects with `Query timeout: …` once a single query's payload exceeds ~60 KB.
 * Against that stub the pre-change code path (one query for all six actors) is
 * guaranteed to fail, so the six-actor test really does discriminate.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'fs';
import { randomBytes } from 'crypto';
import * as os from 'os';
import * as path from 'path';
import { WoDImportActorTools } from './import-actor.js';
import { payloadBytes, TRANSPORT_MAX_MESSAGE_BYTES } from './import-chunking.js';
import { COMPRESSION_CAPABILITY, wireBytesOf } from '../../wire-format.js';
import { WOD_ARCHIVE_LIMITS } from '../../config.js';
import { buildZip, appleDoubleSidecar, type ZipMemberSpec } from './__fixtures__/zip-writer.js';

const CAPABLE_PONG = {
  status: 'ok',
  moduleVersion: '0.9.5',
  capabilities: [
    'importActors.perActorResults',
    'importActors.dryRun',
    'importActors.stopOnError',
    COMPRESSION_CAPABILITY,
  ],
};

type QueryImpl = (method: string, data: any, timeoutMs?: number) => Promise<any>;

interface Call {
  method: string;
  data: any;
  timeoutMs?: number;
  bytes: number;
}

function makeTools(
  queryImpl: QueryImpl,
  opts: {
    connectionType?: 'websocket' | 'webrtc' | null;
    importDir?: string;
    importMaxBytes?: number;
    defaultTimeoutMs?: number;
    /**
     * Whether the transport has negotiated compression on this connection.
     * Defaults to true — a current module. `false` is the permanent plain path:
     * an un-upgraded module, or a browser without `CompressionStream`.
     */
    compression?: boolean;
  } = {}
) {
  const calls: Call[] = [];
  const query = vi.fn(async (method: string, data: any, timeoutMs?: number) => {
    calls.push({ method, data, timeoutMs, bytes: payloadBytes(data) });
    return queryImpl(method, data, timeoutMs);
  });
  const logger: any = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  logger.child = () => logger;
  const compression = opts.compression !== false;
  const foundryClient: any = {
    query,
    getConnectionType: () => opts.connectionType ?? 'websocket',
    isCompressionNegotiated: () => compression,
    // The real encoder, so the tool's guard measures a real serialization rather
    // than a stubbed number. This is the whole point of the guard: it MEASURES.
    measureQueryWireBytes: (method: string, data: any) =>
      wireBytesOf({ type: 'mcp-query', id: 'query-1', data: { method, data } }, compression),
  };
  const tools = new WoDImportActorTools({
    foundryClient,
    logger,
    importDir: opts.importDir,
    importMaxBytes: opts.importMaxBytes ?? 2097152,
    defaultTimeoutMs: opts.defaultTimeoutMs ?? 10000,
  });
  const importCalls = () => calls.filter(c => c.method === 'foundry-mcp-bridge.importActors');
  return { tools, query, calls, importCalls };
}

/**
 * An actor document of roughly `kb` kilobytes, like a real wodchar export.
 *
 * The filler is a run of one character, so this document compresses ~1000x —
 * unrealistically well. That is fine for the transport-shape assertions here
 * (chunk counts, deadlines, per-actor reporting); the ratio claims are measured
 * against the real committed exports in `wire-format.corpus.test.ts` instead.
 */
function actorDoc(name: string, kb = 47, sourceId = `src-${name}`) {
  const doc: Record<string, any> = {
    name,
    type: 'mortal',
    system: { attributes: {}, blob: '' },
    items: [],
    prototypeToken: { texture: { src: `wod20-tokens/${name}.webp` } },
    img: `wod20-portraits/${name}.webp`,
    flags: { wodchar: { sourceId } },
  };
  const overhead = payloadBytes(doc);
  doc.system.blob = 'x'.repeat(Math.max(0, kb * 1024 - overhead));
  return doc;
}

/**
 * An actor document that DEFEATS compression, the way a real one does: a
 * high-entropy `data:` URI on both `img` and `prototypeToken.texture.src`, which
 * is what happens when art is embedded rather than synced to the Foundry server.
 * Random bytes stand in for the WebP; both are already-compressed content, and
 * base64 of them compresses only back toward the 3/4 that base64 added.
 */
function incompressibleActorDoc(name: string, imageKb = 118, sourceId = `src-${name}`) {
  const bytes = randomBytes(imageKb * 1024).toString('base64');
  const dataUri = `data:image/webp;base64,${bytes}`;
  return {
    name,
    type: 'mage',
    system: { attributes: {} },
    items: [],
    img: dataUri,
    prototypeToken: { texture: { src: dataUri } },
    flags: { wodchar: { sourceId } },
  } as Record<string, any>;
}

/** Module behaviour: create everything it is given. */
const createAll: QueryImpl = async (method, data) => {
  if (method === 'foundry-mcp-bridge.ping') return CAPABLE_PONG;
  const results = data.actors.map((d: any, i: number) => ({
    name: d.name,
    id: `id-${d.name}-${i}`,
    status: 'created',
    folder: data.folder ?? 'Foundry MCP Actors',
    sourceId: d.flags?.wodchar?.sourceId ?? null,
  }));
  return { results, total: results.length, counts: {} };
};

/**
 * A bridge with the real-world size ceiling: any single query above ~60 KB
 * rejects with the exact error the six-actor import produced in production.
 */
function simulateSizeCeiling(limitBytes = 60 * 1024): QueryImpl {
  return async (method, data, timeoutMs) => {
    if (method === 'foundry-mcp-bridge.ping') return CAPABLE_PONG;
    if (payloadBytes(data) > limitBytes) {
      throw new Error('Query foundry-mcp-bridge.importActors failed: Query timeout: importActors');
    }
    return createAll(method, data, timeoutMs);
  };
}

describe('Requirement: a batch import bounds the work per bridge call', () => {
  it('a six-actor ~305 KB batch completes with six per-actor results and no timeout', async () => {
    const docs = Array.from({ length: 6 }, (_, i) => actorDoc(`Student${i}`));
    expect(payloadBytes(docs)).toBeGreaterThan(280 * 1024); // the observed ~305 KB

    const { tools, importCalls } = makeTools(simulateSizeCeiling());
    const res: any = await tools.handleImportActor({ actors: docs, folder: 'Berlin Students' });

    expect(res.success).toBe(true);
    expect(res.total).toBe(6);
    expect(res.counts.created).toBe(6);
    expect(res.counts.failed).toBe(0);
    expect(res.counts.unknown).toBe(0);
    expect(res.error).toBeUndefined();
    expect(res.results.map((r: any) => r.name)).toEqual([
      'Student0',
      'Student1',
      'Student2',
      'Student3',
      'Student4',
      'Student5',
    ]);
    // Six queries, each within the ceiling that a single 305 KB query blew.
    expect(importCalls()).toHaveLength(6);
    for (const c of importCalls()) expect(c.bytes).toBeLessThan(60 * 1024);
    expect(res.batches).toEqual({ total: 6, completed: 6 });
  });

  it('the same batch as ONE query would have failed — the stub really discriminates', async () => {
    const docs = Array.from({ length: 6 }, (_, i) => actorDoc(`Student${i}`));
    const { tools, importCalls } = makeTools(simulateSizeCeiling());
    // chunkBytes at its maximum still splits, so force the old shape by asking
    // the bridge directly with all six docs.
    const res: any = await tools.handleImportActor({ actors: docs, chunkBytes: 65536 });
    expect(importCalls().length).toBeGreaterThan(1);
    expect(res.counts.created).toBe(6);
  });

  it('a single small actor is still exactly one query (no behaviour change)', async () => {
    const { tools, importCalls } = makeTools(createAll);
    const res: any = await tools.handleImportActor({ actor: actorDoc('Solo', 2) });
    expect(res.success).toBe(true);
    expect(res.total).toBe(1);
    expect(importCalls()).toHaveLength(1);
    expect(importCalls()[0].data.actors).toHaveLength(1);
  });

  it('passes a per-call timeout, defaulting to the configured queryTimeout', async () => {
    const { tools, importCalls } = makeTools(createAll, { defaultTimeoutMs: 45000 });
    await tools.handleImportActor({ actor: actorDoc('Solo', 2) });
    expect(importCalls()[0].timeoutMs).toBe(45000);
  });

  it('honours an explicit per-call timeoutMs override', async () => {
    const { tools, importCalls } = makeTools(createAll);
    await tools.handleImportActor({ actor: actorDoc('Solo', 2), timeoutMs: 120000 });
    expect(importCalls()[0].timeoutMs).toBe(120000);
  });

  it('scales the deadline for an over-budget indivisible document', async () => {
    const { tools, importCalls } = makeTools(createAll);
    await tools.handleImportActor({ actor: actorDoc('Fat', 120), timeoutMs: 10000 });
    expect(importCalls()[0].timeoutMs).toBe(30000);
  });

  it('honours batchSize as a secondary cap', async () => {
    const docs = Array.from({ length: 4 }, (_, i) => actorDoc(`Tiny${i}`, 1));
    const { tools, importCalls } = makeTools(createAll);
    await tools.handleImportActor({ actors: docs, batchSize: 2 });
    expect(importCalls().map(c => c.data.actors.length)).toEqual([2, 2]);
  });

  it('issues chunks sequentially, never overlapping', async () => {
    // Two concurrent chunks carrying the same sourceId could each miss the
    // other's actor and duplicate it.
    let inFlight = 0;
    let maxInFlight = 0;
    const docs = Array.from({ length: 4 }, (_, i) => actorDoc(`Seq${i}`, 30));
    const { tools } = makeTools(async (method, data) => {
      if (method === 'foundry-mcp-bridge.ping') return CAPABLE_PONG;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight--;
      return createAll(method, data);
    });
    await tools.handleImportActor({ actors: docs });
    expect(maxInFlight).toBe(1);
  });

  // INVERTED by lift-bridge-per-document-size-ceiling. This used to assert that a
  // single document over one 65,536-byte frame was refused on WebRTC. It was a
  // stand-in for a missing mechanism — the server->Foundry direction neither
  // fragmented nor reported a failed send, so the query hung to its deadline.
  // Compression supplies the mechanism, so the refusal is gone.
  it('imports an indivisible document far over one frame on WebRTC, in ONE query', async () => {
    const { tools, importCalls } = makeTools(createAll, { connectionType: 'webrtc' });
    const doc = actorDoc('Whale', 200);
    expect(payloadBytes(doc)).toBeGreaterThan(TRANSPORT_MAX_MESSAGE_BYTES);

    const res: any = await tools.handleImportActor({ actor: doc });

    expect(res.success).toBe(true);
    expect(importCalls()).toHaveLength(1);
    expect(res.counts.created).toBe(1);
    // And it was not refused for its uncompressed size.
    expect(res.error).toBeUndefined();
  });

  it('still refuses, before writing, a document over the frame AFTER compression', async () => {
    // The one payload class compression cannot help: already-compressed bytes.
    const { tools, importCalls } = makeTools(createAll, { connectionType: 'webrtc' });
    const doc = incompressibleActorDoc('Salvador-with-art', 120);
    const res: any = await tools.handleImportActor({ actor: doc });

    expect(res.success).toBe(false);
    expect(importCalls()).toHaveLength(0); // nothing transmitted, nothing written
    // Names the uncompressed size, the compressed size, and the bound.
    expect(res.error).toContain(String(TRANSPORT_MAX_MESSAGE_BYTES));
    expect(res.error).toContain('Salvador-with-art');
    expect(res.error).toMatch(/COMPRESSED on the wire/);
    // And the remedy for the content that defeated compression, not "be smaller".
    expect(res.error).toMatch(/sync the image to the Foundry server/);
    expect(res.error).toMatch(/prototypeToken\.texture\.src/);
    // The refusal is a MEASUREMENT: the plan carries the two sizes it compared,
    // and both are far over the frame.
    const q = res.plan.queries[0];
    expect(q.sendable).toBe(false);
    expect(q.wireBytes).toBeGreaterThan(5 * TRANSPORT_MAX_MESSAGE_BYTES);
    expect(q.bytes).toBeGreaterThan(5 * TRANSPORT_MAX_MESSAGE_BYTES);

    // And this is WHY the guard may not predict from a ratio. Ordinary actor
    // documents compress 6.9x-12x; this one compresses ~1.5x, and once base64'd
    // the enveloped message is actually LARGER than the plain JSON it wraps —
    // compression is a net loss on already-compressed content.
    const doc0 = res.plan.documents[0];
    const ratio = doc0.bytes / doc0.compressedBytes;
    expect(ratio).toBeLessThan(2);
    expect(ratio).toBeGreaterThan(1.2);
    expect(q.wireBytes).toBeGreaterThan(q.bytes);
  });

  it('refuses on WebRTC when the module does not advertise compression, naming THAT remedy', async () => {
    // Old module, new server: no capability observed, so the message would go
    // plain — which for a document this size genuinely cannot be delivered.
    const { tools, importCalls } = makeTools(createAll, {
      connectionType: 'webrtc',
      compression: false,
    });
    const res: any = await tools.handleImportActor({ actor: actorDoc('Whale', 200) });

    expect(res.success).toBe(false);
    expect(importCalls()).toHaveLength(0);
    expect(res.error).toContain(COMPRESSION_CAPABILITY);
    expect(res.error).toMatch(/update the Foundry MCP Bridge module and reload the world/i);
    expect(res.plan.encoding).toBe('plain');
  });

  it('does NOT refuse that same document on WebSocket, where it works today', async () => {
    const { tools, importCalls } = makeTools(createAll, { connectionType: 'websocket' });
    const res: any = await tools.handleImportActor({ actor: actorDoc('Whale', 200) });
    expect(res.success).toBe(true);
    expect(importCalls()).toHaveLength(1);
  });
});

describe('Requirement: a batch reports per-actor results even when it does not complete', () => {
  it('one bad document does not hide the good ones', async () => {
    // Five actors; the module refuses the third and reports it as `failed`,
    // exactly as the new per-actor capture in data-access does.
    const docs = Array.from({ length: 5 }, (_, i) => actorDoc(`A${i}`, 8));
    const { tools } = makeTools(async (method, data) => {
      if (method === 'foundry-mcp-bridge.ping') return CAPABLE_PONG;
      const results = data.actors.map((d: any) =>
        d.name === 'A2'
          ? {
              name: 'A2',
              id: null,
              status: 'failed',
              folder: null,
              sourceId: 'src-A2',
              error: 'Foundry failed to create actor: A2',
            }
          : { name: d.name, id: `id-${d.name}`, status: 'created', folder: 'F', sourceId: null }
      );
      return { results, total: results.length };
    });

    const res: any = await tools.handleImportActor({ actors: docs, folder: 'F' });
    expect(res.success).toBe(true);
    expect(res.total).toBe(5);
    expect(res.counts.created).toBe(4);
    expect(res.counts.failed).toBe(1);
    // Four successes reported individually, with their ids.
    expect(res.results.filter((r: any) => r.status === 'created').map((r: any) => r.id)).toEqual([
      'id-A0',
      'id-A1',
      'id-A3',
      'id-A4',
    ]);
    // The failing actor carries its reason.
    const bad = res.results.find((r: any) => r.status === 'failed');
    expect(bad.name).toBe('A2');
    expect(bad.error).toContain('Foundry failed to create actor');
  });

  it('a timed-out chunk still identifies what earlier chunks created', async () => {
    const docs = Array.from({ length: 4 }, (_, i) => actorDoc(`T${i}`, 40));
    let n = 0;
    const { tools } = makeTools(async (method, data) => {
      if (method === 'foundry-mcp-bridge.ping') return CAPABLE_PONG;
      n++;
      if (n === 3) throw new Error('Query timeout: foundry-mcp-bridge.importActors');
      return createAll(method, data);
    });

    const res: any = await tools.handleImportActor({ actors: docs });
    // Not collapsed into a single error string.
    expect(res.success).toBe(true);
    expect(res.total).toBe(4);
    expect(res.counts.created).toBe(2);
    expect(res.results[0].status).toBe('created');
    expect(res.results[1].status).toBe('created');
    // The caller can determine which actors were created, and which are in doubt.
    expect(res.results[2].status).toBe('unknown');
    expect(res.results[2].error).toMatch(/may or may not have been created/);
    expect(res.results[2].error).toMatch(/idempotent by flags\.wodchar\.sourceId/);
    expect(res.results[3].status).toBe('not-attempted');
    expect(res.batches).toEqual({ total: 4, completed: 2 });
    expect(res.error).toMatch(/Query timeout/);
  });

  it('warns explicitly when an unknown-status doc has no sourceId to reconcile by', async () => {
    const noKey = { name: 'Anon', type: 'mortal', system: {} };
    const { tools } = makeTools(async method => {
      if (method === 'foundry-mcp-bridge.ping') return CAPABLE_PONG;
      throw new Error('Query timeout: foundry-mcp-bridge.importActors');
    });
    const res: any = await tools.handleImportActor({ actor: noKey });
    expect(res.results[0].status).toBe('unknown');
    expect(res.results[0].error).toMatch(/NO sourceId, so a re-run WOULD duplicate it/);
  });

  it('reports success:false only when nothing was attempted, keeping the outcomes', async () => {
    const { tools } = makeTools(async method => {
      if (method === 'foundry-mcp-bridge.ping') return CAPABLE_PONG;
      throw new Error('Not connected to Foundry VTT module');
    });
    const res: any = await tools.handleImportActor({ actor: actorDoc('X', 2) });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Not connected/);
    // Even then, the per-actor outcome is present rather than discarded.
    expect(res.results).toHaveLength(1);
    expect(res.results[0].status).toBe('unknown');
  });

  it('accounts for every requested actor when the module stops early', async () => {
    const docs = Array.from({ length: 3 }, (_, i) => actorDoc(`S${i}`, 1));
    const { tools } = makeTools(async (method, data) => {
      if (method === 'foundry-mcp-bridge.ping') return CAPABLE_PONG;
      // stopOnError: module returns fewer results than docs sent.
      return {
        results: [
          { name: data.actors[0].name, id: null, status: 'failed', folder: null, error: 'nope' },
        ],
        total: 1,
        aborted: true,
      };
    });
    const res: any = await tools.handleImportActor({ actors: docs, stopOnError: true });
    expect(res.total).toBe(3);
    expect(res.counts.failed).toBe(1);
    expect(res.counts.notAttempted).toBe(2);
  });

  it('forwards stopOnError to the module only when the caller sets it', async () => {
    const { tools, importCalls } = makeTools(createAll);
    await tools.handleImportActor({ actor: actorDoc('a', 1) });
    expect('stopOnError' in importCalls()[0].data).toBe(false);
    const second = makeTools(createAll);
    await second.tools.handleImportActor({ actor: actorDoc('a', 1), stopOnError: true });
    expect(second.importCalls()[0].data.stopOnError).toBe(true);
  });
});

describe('Requirement: the import tool offers a dry run', () => {
  it('predicts create/update/skip per actor and writes nothing', async () => {
    const existing = new Set(['src-Known0', 'src-Known1']);
    const docs = [
      actorDoc('Known0', 8),
      actorDoc('Known1', 8),
      actorDoc('New0', 8),
      actorDoc('New1', 8),
      actorDoc('New2', 8),
      actorDoc('New3', 8),
    ];
    const writes: string[] = [];
    const { tools, importCalls } = makeTools(async (method, data) => {
      if (method === 'foundry-mcp-bridge.ping') return CAPABLE_PONG;
      if (data.dryRun !== true) writes.push('WRITE');
      const results = data.actors.map((d: any) => {
        const sid = d.flags?.wodchar?.sourceId;
        return existing.has(sid)
          ? { name: d.name, id: `old-${d.name}`, status: 'would-skip', folder: 'F', sourceId: sid }
          : { name: d.name, id: null, status: 'would-create', folder: 'F', sourceId: sid };
      });
      return { results, total: results.length, dryRun: true };
    });

    const res: any = await tools.handleImportActor({ actors: docs, dryRun: true });
    expect(res.success).toBe(true);
    expect(res.dryRun).toBe(true);
    expect(res.total).toBe(6);
    expect(res.counts.wouldSkip).toBe(2);
    expect(res.counts.wouldCreate).toBe(4);
    // Nothing was written: every query carried dryRun.
    expect(writes).toEqual([]);
    for (const c of importCalls()) expect(c.data.dryRun).toBe(true);
    expect(res.counts.created + res.counts.updated).toBe(0);
  });

  it('reports would-update instead of would-skip when overwrite is set', async () => {
    const { tools } = makeTools(async (method, data) => {
      if (method === 'foundry-mcp-bridge.ping') return CAPABLE_PONG;
      return {
        results: [
          {
            name: data.actors[0].name,
            id: 'old',
            status: data.overwrite ? 'would-update' : 'would-skip',
            folder: 'F',
          },
        ],
        total: 1,
        dryRun: true,
      };
    });
    const res: any = await tools.handleImportActor({
      actor: actorDoc('Known', 2),
      dryRun: true,
      overwrite: true,
    });
    expect(res.counts.wouldUpdate).toBe(1);
  });

  it('refuses a dry run against a module that does not advertise it — rather than importing for real', async () => {
    // The two deploys are independent, so this skew is reachable in practice.
    const { tools, importCalls } = makeTools(async method => {
      if (method === 'foundry-mcp-bridge.ping') return { status: 'ok', moduleVersion: '0.9.0' };
      return createAll(method, { actors: [] });
    });
    const res: any = await tools.handleImportActor({ actor: actorDoc('X', 2), dryRun: true });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/dryRun refused/);
    expect(res.error).toMatch(/performs a REAL import/);
    expect(importCalls()).toHaveLength(0);
  });

  it('does not ping at all when dryRun is not requested', async () => {
    const { tools, calls } = makeTools(createAll);
    await tools.handleImportActor({ actor: actorDoc('X', 2) });
    expect(calls.filter(c => c.method === 'foundry-mcp-bridge.ping')).toHaveLength(0);
  });

  it('the module-version refusal is unmistakably about the module, not about size', async () => {
    // The two refusals used to be indistinguishable in effect while needing
    // opposite remedies: update the module, versus reduce the request.
    const { tools } = makeTools(async method => {
      if (method === 'foundry-mcp-bridge.ping') return { status: 'ok', moduleVersion: '0.9.0' };
      return createAll(method, { actors: [] });
    });
    const res: any = await tools.handleImportActor({ actor: actorDoc('X', 2), dryRun: true });
    expect(res.error).toMatch(/MODULE VERSION, not request size/);
    expect(res.error).toMatch(/reload the world as GM/);
    expect(res.error).toMatch(/Nothing about the size of this request caused this refusal/);
  });
});

describe('Requirement: a dry run reports the transport plan', () => {
  const dryRunModule: QueryImpl = async (method, data) => {
    if (method === 'foundry-mcp-bridge.ping') return CAPABLE_PONG;
    return {
      results: data.actors.map((d: any) => ({
        name: d.name,
        id: null,
        status: 'would-create',
        folder: 'F',
        sourceId: d.flags?.wodchar?.sourceId ?? null,
      })),
      total: data.actors.length,
      dryRun: true,
    };
  };

  it('describes a document larger than one frame instead of refusing it', async () => {
    // The question a caller could not get answered before: this is the case that
    // was refused outright, dryRun included.
    const { tools, importCalls } = makeTools(dryRunModule, { connectionType: 'webrtc' });
    const doc = actorDoc('Salvador', 97);
    expect(payloadBytes(doc)).toBeGreaterThan(TRANSPORT_MAX_MESSAGE_BYTES);

    const res: any = await tools.handleImportActor({ actor: doc, dryRun: true });

    expect(res.success).toBe(true);
    expect(res.dryRun).toBe(true);
    // The verdict is still there.
    expect(res.counts.wouldCreate).toBe(1);
    // And so is the plan, with both sizes MEASURED, the query it lands in and that
    // query's deadline.
    const entry = res.plan.documents[0];
    expect(entry.name).toBe('Salvador');
    expect(entry.bytes).toBeGreaterThan(TRANSPORT_MAX_MESSAGE_BYTES);
    expect(entry.compressedBytes).toBeGreaterThan(0);
    expect(entry.compressedBytes).toBeLessThan(entry.bytes);
    expect(entry.query).toBe(1);
    expect(entry.timeoutMs).toBe(20_000); // scaled for an over-budget chunk
    expect(entry.sendable).toBe(true);
    expect(res.plan.encoding).toBe('gzip');
    expect(res.plan.frameBytes).toBe(TRANSPORT_MAX_MESSAGE_BYTES);
    expect(res.plan.frameEnforced).toBe(true);
    expect(res.plan.totals).toMatchObject({ documents: 1, queries: 1, unsendable: 0 });
    // It was actually sent as a dry run, and nothing was written.
    expect(importCalls()).toHaveLength(1);
    expect(importCalls()[0].data.dryRun).toBe(true);
  });

  it('reports an unsendable document INSIDE the plan and still returns verdicts', async () => {
    const { tools } = makeTools(dryRunModule, { connectionType: 'webrtc' });
    const res: any = await tools.handleImportActor({
      actors: [actorDoc('Fine', 8), incompressibleActorDoc('WithArt', 120)],
      dryRun: true,
    });

    // Not a refusal: the request is described, and the world is untouched either way.
    expect(res.success).toBe(true);
    expect(res.dryRun).toBe(true);
    expect(res.plan.totals.unsendable).toBe(1);

    const blocked = res.plan.documents.find((d: any) => d.name === 'WithArt');
    expect(blocked.sendable).toBe(false);
    expect(blocked.reason).toContain(String(TRANSPORT_MAX_MESSAGE_BYTES));
    expect(blocked.reason).toMatch(/sync the image to the Foundry server/);
    expect(blocked.compressedBytes / blocked.bytes).toBeGreaterThan(0.5); // ~1.5x, not ~9x

    // The other document still has its verdict...
    const verdicts = new Map(res.results.map((r: any) => [r.name, r.status]));
    expect(verdicts.get('Fine')).toBe('would-create');
    // ...and the unsendable one is reported per actor with the bound named.
    expect(verdicts.get('WithArt')).toBe('not-attempted');
    expect(res.results.find((r: any) => r.name === 'WithArt').error).toMatch(/not sendable/);
  });

  it('does not report a plan when dryRun was not asked for', async () => {
    const { tools } = makeTools(createAll);
    const res: any = await tools.handleImportActor({ actor: actorDoc('X', 2) });
    expect(res.plan).toBeUndefined();
  });

  it('marks nothing unsendable on WebSocket, where the frame does not bind', async () => {
    const { tools } = makeTools(dryRunModule, { connectionType: 'websocket' });
    const res: any = await tools.handleImportActor({
      actor: incompressibleActorDoc('WithArt', 120),
      dryRun: true,
    });
    expect(res.plan.frameEnforced).toBe(false);
    expect(res.plan.totals.unsendable).toBe(0);
    expect(res.plan.documents[0].sendable).toBe(true);
  });
});

describe('Requirement: a document supplied by reference is confined to an allow-listed directory', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wod-tool-')));
    await fs.writeFile(
      path.join(dir, 'staged.json'),
      JSON.stringify(actorDoc('Staged', 2)),
      'utf8'
    );
    await fs.writeFile(path.join(dir, 'bad-schema.json'), JSON.stringify({ nope: 1 }), 'utf8');
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('imports a staged document by path', async () => {
    const { tools, importCalls } = makeTools(createAll, { importDir: dir });
    const res: any = await tools.handleImportActor({ actorPath: 'staged.json' });
    expect(res.success).toBe(true);
    expect(res.counts.created).toBe(1);
    expect(importCalls()[0].data.actors[0].name).toBe('Staged');
  });

  it('refuses a traversal path without sending anything', async () => {
    const { tools, calls } = makeTools(createAll, { importDir: dir });
    const res: any = await tools.handleImportActor({ actorPath: '../../etc/passwd.json' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/outside importDir/);
    expect(calls).toHaveLength(0);
  });

  it('refuses every path when no importDir is configured', async () => {
    const { tools, calls } = makeTools(createAll, { importDir: undefined });
    const res: any = await tools.handleImportActor({ actorPath: 'staged.json' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/path intake disabled/);
    expect(calls).toHaveLength(0);
  });

  // The refusal shape, named rather than `any`, so the assertions below are
  // type-checked and add no `no-unsafe-member-access` noise.
  type Rejection = { success: boolean; error?: string };

  // The bare reason is true but sends the reader to a config file that is
  // usually already correct. The real cause is almost always that THIS backend
  // process did not inherit the configured environment, so the refusal has to
  // name that. See the singleton note in index.ts / docs/foundry-import.md.
  it('names the likely cause — a backend that did not inherit the config — when importDir is unset', async () => {
    const { tools } = makeTools(createAll, { importDir: undefined });
    const res = (await tools.handleImportActor({ actorPath: 'staged.json' })) as Rejection;
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/WOD_IMPORT_DIR/);
    expect(res.error).toMatch(/singleton/);
    expect(res.error).toMatch(/31414/);
    // Explicitly contradicts the wrong first instinct.
    expect(res.error).toMatch(/restarting the MCP client will not fix it/);
  });

  // The hint must be a FIXED string. A rejection that escaped a *configured*
  // root must not gain any extra detail — that is the error-hygiene rule in
  // import-path.ts, and the resolved root must never be echoed.
  it('does not attach the configuration hint to a path that escaped a configured root', async () => {
    const { tools } = makeTools(createAll, { importDir: dir });
    const res = (await tools.handleImportActor({
      actorPath: '../../etc/passwd.json',
    })) as Rejection;
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/outside importDir/);
    expect(res.error).not.toMatch(/WOD_IMPORT_DIR/);
    expect(res.error).not.toContain(dir);
  });

  it('validates a staged doc through the SAME schema as an inline one', async () => {
    const { tools, calls } = makeTools(createAll, { importDir: dir });
    const res: any = await tools.handleImportActor({ actorPath: 'bad-schema.json' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/schema:/);
    expect(calls).toHaveLength(0);
  });

  it('rejects mixing inline docs with staged paths', async () => {
    const { tools, calls } = makeTools(createAll, { importDir: dir });
    const res: any = await tools.handleImportActor({
      actor: actorDoc('Inline', 2),
      actorPath: 'staged.json',
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Do not mix/);
    expect(calls).toHaveLength(0);
  });

  it('still chunks path-sourced docs — path intake is not timeout mitigation', async () => {
    for (let i = 0; i < 3; i++) {
      await fs.writeFile(
        path.join(dir, `big${i}.json`),
        JSON.stringify(actorDoc(`Big${i}`, 47)),
        'utf8'
      );
    }
    const { tools, importCalls } = makeTools(simulateSizeCeiling(), { importDir: dir });
    const res: any = await tools.handleImportActor({
      actorPaths: ['big0.json', 'big1.json', 'big2.json'],
    });
    expect(res.counts.created).toBe(3);
    expect(importCalls()).toHaveLength(3);
  });
});

describe('backward compatibility', () => {
  it('keeps the existing input surface and required-field validation', async () => {
    const { tools } = makeTools(createAll);
    expect((await tools.handleImportActor({})).success).toBe(false);
    expect((await tools.handleImportActor({ actors: [] })).success).toBe(false);
    const bad: any = await tools.handleImportActor({ actor: { name: 'x' } });
    expect(bad.success).toBe(false);
    expect(bad.error).toMatch(/Invalid arguments/);
  });

  it('keeps success/total/results with their original meaning and passes docs through verbatim', async () => {
    const doc = actorDoc('Verbatim', 3);
    const { tools, importCalls } = makeTools(createAll);
    const res: any = await tools.handleImportActor({ actor: doc, folder: 'F', overwrite: true });
    expect(Object.keys(res)).toEqual(
      expect.arrayContaining(['success', 'total', 'results', 'counts', 'batches'])
    );
    expect(res.total).toBe(res.results.length);
    expect(importCalls()[0].data).toMatchObject({ folder: 'F', overwrite: true });
    expect(importCalls()[0].data.actors[0]).toEqual(doc);
  });

  it('still advertises exactly one tool, under its original name', () => {
    const { tools } = makeTools(createAll);
    const defs = tools.getToolDefinitions();
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe('worldofdarkness-import-actor');
    // Additive: the original four inputs are all still declared.
    for (const key of ['actor', 'actors', 'folder', 'overwrite']) {
      expect(defs[0].inputSchema.properties).toHaveProperty(key);
    }
  });
});

// ── the staged-archive intake ──────────────────────────────────────────────────

describe('Requirement: a batch of actor documents is importable from one staged archive', () => {
  let dir: string;

  /** Stage `name.zip` containing `members` and return the relative path. */
  async function stage(name: string, members: ZipMemberSpec[]): Promise<string> {
    await fs.writeFile(path.join(dir, name), buildZip(members));
    return name;
  }

  /** A document as it lands in an archive entry: JSON text, one actor. */
  const entryDoc = (name: string, sourceId?: string, kb = 3) =>
    JSON.stringify(
      sourceId === undefined ? withoutProvenance(name, kb) : actorDoc(name, kb, sourceId)
    );

  /** `actorDoc` minus its provenance — what a raw `wod character export` emits. */
  function withoutProvenance(name: string, kb = 3): Record<string, any> {
    const doc = actorDoc(name, kb);
    delete doc.flags;
    doc.img = 'icons/svg/mystery-man.svg';
    doc.prototypeToken = { texture: { src: 'icons/svg/mystery-man.svg' } };
    return doc;
  }

  beforeAll(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wod-import-arc-')));
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('imports every document an archive yields, as if they had been supplied individually', async () => {
    const p = await stage('cast.zip', [
      { name: 'actors/', data: '' },
      { name: 'actors/ana.json', data: entryDoc('Ana', 'src-ana') },
      { name: 'actors/beto.json', data: entryDoc('Beto', 'src-beto') },
      { name: '__MACOSX/actors/._ana.json', data: appleDoubleSidecar() },
    ]);
    const { tools, importCalls } = makeTools(createAll, { importDir: dir });
    const res: any = await tools.handleImportActor({ actorArchive: p, folder: 'Berlin' });

    expect(res.success).toBe(true);
    expect(res.counts.created).toBe(2);
    // The archive never becomes a bridge payload: every query carries only actors.
    for (const call of importCalls()) {
      expect(Object.keys(call.data)).toEqual(expect.arrayContaining(['actors']));
      expect(JSON.stringify(call.data)).not.toContain('cast.zip');
      expect(JSON.stringify(call.data)).not.toContain('__MACOSX');
    }
  });

  it('is mutually exclusive with the inline and per-path intakes', async () => {
    const p = await stage('excl.zip', [{ name: 'a.json', data: entryDoc('Ana', 'src-a') }]);
    const { tools, calls } = makeTools(createAll, { importDir: dir });

    for (const other of [
      { actor: actorDoc('Inline', 3) },
      { actors: [actorDoc('Inline', 3)] },
      { actorPath: 'a.json' },
      { actorPaths: ['a.json'] },
    ]) {
      const res: any = await tools.handleImportActor({ actorArchive: p, ...other });
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/Do not mix intakes/);
    }
    expect(calls).toHaveLength(0); // refused before anything is read or written
  });

  it('refuses an archive when no importDir is configured, without reading the file', async () => {
    const { tools, calls } = makeTools(createAll, { importDir: undefined });
    const res: any = await tools.handleImportActor({ actorArchive: 'cast.zip' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/path intake disabled/);
    expect(calls).toHaveLength(0);
  });

  it('refuses an archive path that escapes importDir, with the same reason a document path gets', async () => {
    const { tools, calls } = makeTools(createAll, { importDir: dir });
    const res: any = await tools.handleImportActor({ actorArchive: '../../etc/passwd.zip' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/outside importDir/);
    expect(calls).toHaveLength(0);
  });

  it('validates archive documents with the SAME schema, and refuses the whole call on one bad doc', async () => {
    const p = await stage('bad.zip', [
      { name: 'ok.json', data: entryDoc('Ana', 'src-a') },
      { name: 'bad.json', data: JSON.stringify({ name: 'No type or system' }) },
    ]);
    const { tools, calls } = makeTools(createAll, { importDir: dir });
    const res: any = await tools.handleImportActor({ actorArchive: p });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/bad\.json: schema/);
    expect(calls).toHaveLength(0);
  });

  it('refuses an archive over the documents-per-call cap, naming the cap and the count', async () => {
    const members = Array.from({ length: WOD_ARCHIVE_LIMITS.MAX_DOCUMENTS + 1 }, (_, i) => ({
      name: `a${i}.json`,
      data: entryDoc(`Actor${i}`, `src-${i}`, 1),
    }));
    const p = await stage('too-many.zip', members);
    const { tools, calls } = makeTools(createAll, { importDir: dir });
    const res: any = await tools.handleImportActor({ actorArchive: p });
    expect(res.success).toBe(false);
    expect(res.error).toContain(String(WOD_ARCHIVE_LIMITS.MAX_DOCUMENTS + 1));
    expect(res.error).toContain(String(WOD_ARCHIVE_LIMITS.MAX_DOCUMENTS));
    expect(res.error).toMatch(/WALL CLOCK/);
    expect(calls).toHaveLength(0);
  });

  it('accounts for every entry in the response, with counts that sum', async () => {
    const p = await stage('mixed.zip', [
      { name: 'actors/', data: '' },
      { name: 'actors/ana.json', data: entryDoc('Ana', 'src-ana') },
      { name: 'actors/notes.txt', data: 'hello' },
      { name: '__MACOSX/actors/._ana.json', data: appleDoubleSidecar() },
    ]);
    const { tools } = makeTools(createAll, { importDir: dir });
    const res: any = await tools.handleImportActor({ actorArchive: p });

    expect(res.archive.path).toBe(p);
    expect(res.archive.counts).toEqual({ entries: 4, documents: 1, ignored: 3, refused: 0 });
    expect(
      res.archive.counts.documents + res.archive.counts.ignored + res.archive.counts.refused
    ).toBe(res.archive.counts.entries);
    for (const entry of res.archive.entries) {
      if (entry.classification !== 'document') expect(entry.reason).toBeTruthy();
    }
  });

  it('names the originating entry on every per-actor outcome, including the ones the server adds', async () => {
    const p = await stage('attribution.zip', [
      { name: 'ana.json', data: entryDoc('Ana', 'src-ana', 40) },
      { name: 'beto.json', data: entryDoc('Beto', 'src-beto', 40) },
    ]);
    // One query per document, and the second one fails: `ana` gets a real outcome
    // from the module, `beto` gets the server's `unknown`. Both must name an entry.
    let seen = 0;
    const failSecond: QueryImpl = async (method, data, timeoutMs) => {
      if (method === 'foundry-mcp-bridge.ping') return CAPABLE_PONG;
      if (++seen === 2) throw new Error('Query timeout: importActors');
      return createAll(method, data, timeoutMs);
    };
    const { tools } = makeTools(failSecond, { importDir: dir });
    const res: any = await tools.handleImportActor({ actorArchive: p, batchSize: 1 });

    expect(res.results).toHaveLength(2);
    expect(res.results.map((r: any) => r.entry)).toEqual(['ana.json', 'beto.json']);
    expect(res.results[0].status).toBe('created');
    expect(res.results[1].status).toBe('unknown');
  });

  it('issues archive documents sequentially, never in parallel', async () => {
    const p = await stage('seq.zip', [
      { name: 'a.json', data: entryDoc('A', 'src-a', 40) },
      { name: 'b.json', data: entryDoc('B', 'src-b', 40) },
      { name: 'c.json', data: entryDoc('C', 'src-c', 40) },
    ]);
    let inFlight = 0;
    let maxInFlight = 0;
    const watched: QueryImpl = async (method, data, timeoutMs) => {
      if (method === 'foundry-mcp-bridge.ping') return CAPABLE_PONG;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 1));
      inFlight--;
      return createAll(method, data, timeoutMs);
    };
    const { tools, importCalls } = makeTools(watched, { importDir: dir });
    const res: any = await tools.handleImportActor({ actorArchive: p });
    expect(res.success).toBe(true);
    expect(importCalls().length).toBeGreaterThan(1);
    expect(maxInFlight).toBe(1);
  });
});

describe('Requirement: every archive document has reconcilable provenance before any write', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wod-import-prov-')));
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  /** A raw exporter document: no provenance, placeholder art. */
  function rawExport(name: string): Record<string, any> {
    const doc = actorDoc(name, 3);
    delete doc.flags;
    doc.img = 'icons/svg/mystery-man.svg';
    return doc;
  }

  async function stageRaw(file: string, names: string[]): Promise<string> {
    await fs.writeFile(
      path.join(dir, file),
      buildZip(names.map(n => ({ name: `${n}.json`, data: JSON.stringify(rawExport(n)) })))
    );
    return file;
  }

  it('the server and the module agree on what "has a source id" means — BOTH flag scopes', async () => {
    // The module resolves flags.wodchar.sourceId, then flags['wod20-combat'].sourceId,
    // then the out-of-band field. A gate built on only the first and third would
    // refuse documents the importer reconciles perfectly well.
    const combat = rawExport('Combat');
    combat.flags = { 'wod20-combat': { sourceId: 'src-combat' } };
    const outOfBand = rawExport('OutOfBand');
    outOfBand.sourceId = 'src-oob';
    const wodchar = rawExport('Wodchar');
    wodchar.flags = { wodchar: { sourceId: 'src-wodchar' } };

    await fs.writeFile(
      path.join(dir, 'scopes.zip'),
      buildZip([
        { name: 'combat.json', data: JSON.stringify(combat) },
        { name: 'oob.json', data: JSON.stringify(outOfBand) },
        { name: 'wodchar.json', data: JSON.stringify(wodchar) },
      ])
    );

    const { tools } = makeTools(createAll, { importDir: dir });
    const res: any = await tools.handleImportActor({ actorArchive: 'scopes.zip' });
    expect(res.success).toBe(true);
    expect(res.archive.entriesWithoutProvenance).toEqual([]);
  });

  it('a document whose flags name only wod20-char is NOT provenance', async () => {
    // The exporter writes flags['wod20-char'] = { line, variant, exportedAt }. It is
    // a different scope from both of the two that carry ids, and carries none.
    const doc = rawExport('Exported');
    doc.flags = { 'wod20-char': { line: 'mage', exportedAt: 0 } };
    await fs.writeFile(
      path.join(dir, 'wod20char.zip'),
      buildZip([{ name: 'exported.json', data: JSON.stringify(doc) }])
    );
    const { tools, calls } = makeTools(createAll, { importDir: dir });
    const res: any = await tools.handleImportActor({ actorArchive: 'wod20char.zip' });
    expect(res.success).toBe(false);
    expect(res.archive.entriesWithoutProvenance).toEqual(['exported.json']);
    expect(calls).toHaveLength(0);
  });

  it('refuses an archive of raw exports before any write, listing every entry', async () => {
    const p = await stageRaw('raw.zip', ['lena', 'jonas', 'mira']);
    const { tools, calls } = makeTools(createAll, { importDir: dir });
    const res: any = await tools.handleImportActor({ actorArchive: p, overwrite: true });

    expect(res.success).toBe(false);
    for (const entry of ['lena.json', 'jonas.json', 'mira.json']) {
      expect(res.error).toContain(entry);
    }
    // The two hazards this gate exists for are both named, because they are what a
    // reader needs in order to act.
    expect(res.error).toMatch(/duplicate/i);
    expect(res.error).toMatch(/portrait/i);
    expect(res.error).toMatch(/firstImport/);
    expect(calls).toHaveLength(0); // not even a ping: nothing was sent
  });

  it('a declared first import proceeds and says, per actor, that a retry would duplicate', async () => {
    const p = await stageRaw('first.zip', ['lena', 'jonas']);
    const { tools } = makeTools(createAll, { importDir: dir });
    const res: any = await tools.handleImportActor({ actorArchive: p, firstImport: true });

    expect(res.success).toBe(true);
    expect(res.counts.created).toBe(2);
    expect(res.archive.firstImportDeclared).toBe(true);
    for (const result of res.results) {
      expect(result.entry).toBeTruthy();
      expect(result.error).toMatch(/NO sourceId, so a re-run WOULD duplicate it/);
    }
  });

  it('does NOT synthesise a source id from the entry name', async () => {
    const p = await stageRaw('nosynth.zip', ['lena']);
    const { tools, importCalls } = makeTools(createAll, { importDir: dir });
    await tools.handleImportActor({ actorArchive: p, firstImport: true });
    // Whatever crossed the bridge must carry no fabricated provenance: a synthesised
    // id makes retry of THIS archive idempotent while making the same character,
    // later imported under its real id, a second actor — an invisible duplicate.
    const sent = importCalls()[0]?.data.actors[0];
    expect(sent.sourceId).toBeUndefined();
    expect(sent.flags?.wodchar?.sourceId).toBeUndefined();
    expect(JSON.stringify(sent)).not.toContain('lena.json');
  });

  it('a dry run REPORTS missing provenance instead of refusing', async () => {
    const p = await stageRaw('dry.zip', ['lena', 'jonas']);
    const { tools } = makeTools(
      async (method, data) => {
        if (method === 'foundry-mcp-bridge.ping') return CAPABLE_PONG;
        return {
          dryRun: true,
          results: data.actors.map((d: any) => ({
            name: d.name,
            id: null,
            status: 'would-create',
            folder: null,
            sourceId: null,
          })),
        };
      },
      { importDir: dir }
    );
    const res: any = await tools.handleImportActor({ actorArchive: p, dryRun: true });

    expect(res.success).toBe(true);
    expect(res.dryRun).toBe(true);
    expect(res.plan.archive.entriesWithoutProvenance).toEqual(['lena.json', 'jonas.json']);
    for (const document of res.plan.documents) {
      expect(document.provenance).toBe('missing');
      expect(document.entry).toBeTruthy();
    }
  });
});

describe('Requirement: a dry run rehearses the unpack and reports the inventory and query cost', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wod-import-dry-')));
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const dryRunModule: QueryImpl = async (method, data) => {
    if (method === 'foundry-mcp-bridge.ping') return CAPABLE_PONG;
    return {
      dryRun: true,
      results: data.actors.map((d: any) => ({
        name: d.name,
        id: 'existing-id',
        status: 'would-update',
        folder: null,
        sourceId: d.flags?.wodchar?.sourceId ?? null,
      })),
    };
  };

  it('reports the inventory, per-document verdicts and provenance, and writes nothing', async () => {
    await fs.writeFile(
      path.join(dir, 'plan.zip'),
      buildZip([
        { name: 'actors/', data: '' },
        { name: 'actors/a.json', data: JSON.stringify(actorDoc('A', 40, 'src-a')) },
        { name: 'actors/b.json', data: JSON.stringify(actorDoc('B', 40, 'src-b')) },
        { name: 'actors/notes.txt', data: 'x' },
      ])
    );
    const { tools, importCalls } = makeTools(dryRunModule, { importDir: dir });
    const res: any = await tools.handleImportActor({ actorArchive: 'plan.zip', dryRun: true });

    expect(res.dryRun).toBe(true);
    expect(res.plan.archive.counts).toEqual({ entries: 4, documents: 2, ignored: 2, refused: 0 });
    // The plan EXTENDS the dependency's structure rather than adding a second one:
    // its own fields are all still there.
    expect(res.plan).toMatchObject({
      frameBytes: expect.any(Number),
      chunkBytes: expect.any(Number),
    });
    expect(res.plan.documents.map((d: any) => d.entry)).toEqual(['actors/a.json', 'actors/b.json']);
    for (const document of res.plan.documents) {
      expect(document.provenance).toBe('resolved');
      expect(document.compressedBytes).toBeGreaterThan(0);
    }
    expect(res.results.every((r: any) => r.status === 'would-update')).toBe(true);
    // `archive` and `plan.archive` are the same object, not two descriptions.
    expect(res.archive).toBe(res.plan.archive);
    // Every query sent carried dryRun.
    for (const call of importCalls()) expect(call.data.dryRun).toBe(true);
  });

  it('reports the query count AND the sum of their deadlines', async () => {
    await fs.writeFile(
      path.join(dir, 'cost.zip'),
      buildZip(
        Array.from({ length: 6 }, (_, i) => ({
          name: `a${i}.json`,
          data: JSON.stringify(actorDoc(`A${i}`, 47, `src-${i}`)),
        }))
      )
    );
    const { tools } = makeTools(dryRunModule, { importDir: dir });
    const res: any = await tools.handleImportActor({ actorArchive: 'cost.zip', dryRun: true });

    expect(res.plan.totals.queries).toBe(res.plan.queries.length);
    expect(res.plan.totals.queries).toBeGreaterThan(1);
    expect(res.plan.totals.summedTimeoutMs).toBe(
      res.plan.queries.reduce((n: number, q: any) => n + q.timeoutMs, 0)
    );
    // The number a caller most needs: nothing else bounds it.
    expect(res.plan.totals.summedTimeoutMs).toBeGreaterThanOrEqual(10000 * res.plan.totals.queries);
  });

  it('STILL refuses an archive it must not expand, without expanding it', async () => {
    // A bomb: 1 KiB of bytes that are not even a valid deflate stream, declared as
    // 100 MiB. Had the reader inflated to produce a friendlier report, it would
    // have failed with a zlib error; the refusal naming the BOUND is the proof that
    // the defence — not doing the work — held in dry-run mode too.
    await fs.writeFile(
      path.join(dir, 'bomb.zip'),
      buildZip([
        {
          name: 'bomb.json',
          data: '',
          method: 8,
          rawBody: Buffer.alloc(1024, 0xff),
          declaredUncompressedSize: 104_857_600,
        },
      ])
    );
    const { tools, calls } = makeTools(dryRunModule, { importDir: dir });
    const res: any = await tools.handleImportActor({ actorArchive: 'bomb.zip', dryRun: true });

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/per-entry bound/);
    expect(res.error).not.toMatch(/Z_DATA_ERROR|incorrect header check/);
    expect(calls).toHaveLength(0);
  });

  it('STILL refuses an encrypted entry in dry-run mode, by its real reason', async () => {
    await fs.writeFile(
      path.join(dir, 'enc.zip'),
      buildZip([
        { name: 'secret.json', data: JSON.stringify(actorDoc('S', 3, 'src-s')), flags: 0x0001 },
      ])
    );
    const { tools, calls } = makeTools(dryRunModule, { importDir: dir });
    const res: any = await tools.handleImportActor({ actorArchive: 'enc.zip', dryRun: true });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/encrypted entry/);
    expect(calls).toHaveLength(0);
  });

  it('refuses an archive with no documents, distinguishably from an unreadable one', async () => {
    await fs.writeFile(path.join(dir, 'nodocs.zip'), buildZip([{ name: 'notes.txt', data: 'x' }]));
    await fs.writeFile(path.join(dir, 'junk.zip'), Buffer.from('not a zip at all'));
    const { tools } = makeTools(dryRunModule, { importDir: dir });

    const noDocs: any = await tools.handleImportActor({ actorArchive: 'nodocs.zip' });
    expect(noDocs.error).toMatch(/no actor documents found/);
    const junk: any = await tools.handleImportActor({ actorArchive: 'junk.zip' });
    expect(junk.error).toMatch(/not a readable archive/);
  });
});

describe('the archive intake is declared honestly in the tool description', () => {
  it('says what it does NOT buy, matching the actorPath prose', () => {
    const { tools } = makeTools(createAll);
    const props: any = tools.getToolDefinitions()[0].inputSchema.properties;
    expect(props).toHaveProperty('actorArchive');
    expect(props).toHaveProperty('firstImport');
    const text: string = props.actorArchive.description;
    expect(text).toMatch(/does NOT let you import more actors per call/);
    expect(text).toMatch(/crosses the bridge in full/);
    expect(text).toMatch(/wall\s*clock/i);
    expect(text).toContain(String(WOD_ARCHIVE_LIMITS.MAX_DOCUMENTS));
    expect(text).toMatch(/sourceId/);
  });
});
