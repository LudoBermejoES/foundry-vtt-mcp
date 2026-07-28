/**
 * The Foundry-module half of the bridge wire format.
 *
 * This runs the REAL browser primitives: Node has had global `CompressionStream` /
 * `DecompressionStream` since v17, so the same code path the Foundry client takes is
 * exercised here without a browser. The interop assertions against the server's
 * `zlib` codec are in `packages/mcp-server/src/wire-format.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import { gzipSync } from 'zlib';
import { WEBRTC_CONSTANTS } from './constants.js';
import {
  COMPRESSED_MESSAGE_TYPE,
  COMPRESSION_CAPABILITY,
  COMPRESSION_ENCODING,
  compressMessage,
  decodeFailureResponse,
  decompressEnvelope,
  isCompressedEnvelope,
  isCompressionAvailable,
  mustSendPlain,
  utf8ByteLength,
  WireDecodeError,
} from './wire-format.js';

const envelopeOf = (payload: Buffer, originalId = 'query-1') => ({
  type: COMPRESSED_MESSAGE_TYPE as typeof COMPRESSED_MESSAGE_TYPE,
  encoding: COMPRESSION_ENCODING,
  originalType: 'mcp-query',
  originalId,
  payload: payload.toString('base64'),
});

describe('Requirement: the module advertises compression only when the primitive is present', () => {
  it('detects the primitives that the advertisement stands for', () => {
    // The advertisement IS the feature detect — there is no engine-version table.
    expect(isCompressionAvailable()).toBe(true);
    expect(COMPRESSION_CAPABILITY).toBe('transport.compression.gzip');
  });

  it('reports unavailable when DecompressionStream is missing, and refuses to decode', async () => {
    const original = (globalThis as any).DecompressionStream;
    try {
      delete (globalThis as any).DecompressionStream;
      expect(isCompressionAvailable()).toBe(false);
      await expect(decompressEnvelope(envelopeOf(gzipSync(Buffer.from('{}'))))).rejects.toThrow(
        /no DecompressionStream/
      );
    } finally {
      (globalThis as any).DecompressionStream = original;
    }
  });
});

describe('Requirement: compressed JSON is the wire format for query traffic', () => {
  it('round-trips a query byte-identically', async () => {
    const message = {
      type: 'mcp-response',
      id: 'query-4',
      data: { success: true, data: { results: Array.from({ length: 50 }, (_, i) => ({ i })) } },
    };
    const envelope = await compressMessage(message);
    expect(isCompressedEnvelope(envelope)).toBe(true);
    expect(envelope.originalType).toBe('mcp-response');
    expect(envelope.originalId).toBe('query-4');
    expect(await decompressEnvelope(envelope)).toEqual(message);
  });

  it('survives accented Spanish and an astral-plane character', async () => {
    // This corpus is Spanish, and the old size check counted UTF-16 code units.
    const message = {
      type: 'mcp-response',
      id: 'q',
      data: { text: 'Salvador Pacheco-König — «Añoranza» 𝕄𝔸𝔾𝔼 🜍 汉字' },
    };
    const back = await decompressEnvelope(await compressMessage(message));
    expect(back).toEqual(message);
    expect(JSON.stringify(back)).toBe(JSON.stringify(message));
  });

  it('handles a payload far larger than the base64 window without blowing the stack', async () => {
    // `String.fromCharCode(...bytes)` on a spread array dies somewhere near 100 KB,
    // which is exactly the payload size this change exists to carry.
    const message = {
      type: 'mcp-response',
      id: 'q',
      data: { blob: Array.from({ length: 20_000 }, (_, i) => `item-${i}-${i % 7}`) },
    };
    const envelope = await compressMessage(message);
    expect(envelope.payload.length).toBeGreaterThan(40_000);
    expect(await decompressEnvelope(envelope)).toEqual(message);
  });

  it('emits gzip, not a bare deflate stream', async () => {
    const envelope = await compressMessage({ type: 'mcp-response', id: 'q', data: {} });
    const raw = Buffer.from(envelope.payload, 'base64');
    expect([raw[0], raw[1]]).toEqual([0x1f, 0x8b]);
  });
});

describe('Requirement: the plain set is closed and keyed by type', () => {
  it('keeps the handshake, liveness, unsolicited emissions and framing plain', () => {
    expect(
      mustSendPlain({ type: 'mcp-query', id: 'q', data: { method: 'foundry-mcp-bridge.ping' } })
    ).toBe(true);
    for (const type of ['ping', 'pong', 'bridge-status', 'chunked-message', 'job-completed']) {
      expect(mustSendPlain({ type }), type).toBe(true);
    }
    expect(mustSendPlain({ type: 'mcp-response', id: 'q', data: {} })).toBe(false);
  });

  it('decides from the type, never from the size', () => {
    const hugePing = {
      type: 'mcp-query',
      id: 'q',
      data: { method: 'foundry-mcp-bridge.ping', data: { pad: 'x'.repeat(200_000) } },
    };
    expect(mustSendPlain(hugePing)).toBe(true);
    expect(mustSendPlain({ type: 'mcp-response', id: 'q', data: { tiny: 1 } })).toBe(false);
  });
});

describe('Requirement: decompression is bounded, and a failure is surfaced against its request', () => {
  it('aborts an expansion past the bound without retaining the output', async () => {
    // A payload well inside one frame that expands to 64 MiB.
    const bomb = gzipSync(Buffer.alloc(64 * 1024 * 1024), { level: 9 });
    expect(bomb.length).toBeLessThan(WEBRTC_CONSTANTS.MAX_MESSAGE_SIZE);

    let thrown: unknown;
    try {
      await decompressEnvelope(envelopeOf(bomb, 'query-8'));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WireDecodeError);
    const error = thrown as WireDecodeError;
    expect(error.message).toContain(String(WEBRTC_CONSTANTS.MAX_DECOMPRESSED_BYTES));
    expect(error.message).toMatch(/nothing was dispatched/);
    expect(error.originalId).toBe('query-8');
  });

  it('honours a tighter explicit bound', async () => {
    const payload = gzipSync(Buffer.from(JSON.stringify({ a: 'x'.repeat(10_000) })), { level: 9 });
    await expect(decompressEnvelope(envelopeOf(payload), 1024)).rejects.toThrow(
      /1024-byte maximum/
    );
  });

  it('reports a corrupt payload against its request instead of dropping it', async () => {
    const envelope = envelopeOf(Buffer.from('this is not gzip'), 'query-11');
    let thrown: unknown;
    try {
      await decompressEnvelope(envelope);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WireDecodeError);
    expect((thrown as WireDecodeError).originalId).toBe('query-11');
  });

  it('rejects an unknown encoding rather than guessing', async () => {
    const envelope = { ...envelopeOf(gzipSync(Buffer.from('{}'))), encoding: 'br' };
    await expect(decompressEnvelope(envelope)).rejects.toThrow(/Unsupported compressed-message/);
  });

  it('the failure reply is the shape that actually rejects the pending query', () => {
    // NOT `{ type: 'error', requestId }` — the server's handleMessage routes
    // `mcp-response` by `id` and `pong`, and logs anything else at debug, so an
    // `error` message would reject nothing and the caller would still wait out its
    // deadline.
    const reply = decodeFailureResponse(new WireDecodeError('boom', 'query-3', 'mcp-query'));
    expect(reply.type).toBe('mcp-response');
    expect(reply.id).toBe('query-3');
    expect(reply.data.success).toBe(false);
    expect(reply.data.error).toBe('boom');
  });
});

describe('utf8ByteLength', () => {
  it('counts bytes, not UTF-16 code units', () => {
    expect(utf8ByteLength('abc')).toBe(3);
    expect(utf8ByteLength('é')).toBe(2);
    expect(utf8ByteLength('€')).toBe(3);
    expect(utf8ByteLength('𝕄')).toBe(4); // 2 UTF-16 units, 4 bytes
    expect('𝕄'.length).toBe(2);
  });
});
