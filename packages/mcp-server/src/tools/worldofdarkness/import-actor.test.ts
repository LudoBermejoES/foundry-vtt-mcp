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
