/**
 * The bridge wire format.
 *
 * These pin the measurements the design rests on, not just the behaviour — because
 * two of the design's decisions are ONLY defensible as measurements, and a later
 * change that quietly reverses them would otherwise look harmless:
 *
 *   - the forced plain-envelope set exists because compression makes control
 *     messages BIGGER (see "control messages get bigger" below);
 *   - the frame guard measures rather than predicts, because the compression ratio
 *     is a property of the content (6.9x-12x for actor JSON, 1.5x for embedded art).
 *
 * The ratio claims over the real committed WoD exports live in
 * `wire-format.corpus.test.ts`, which needs the wodchar fixtures.
 */

import { describe, it, expect } from 'vitest';
import { gzipSync, gunzipSync } from 'zlib';
import { randomBytes } from 'crypto';
import { WEBRTC_CONSTANTS } from './config.js';
import {
  COMPRESSED_MESSAGE_TYPE,
  COMPRESSION_CAPABILITY,
  COMPRESSION_ENCODING,
  compressMessage,
  decompressEnvelope,
  gzippedBytes,
  isCompressedEnvelope,
  mustSendPlain,
  PING_QUERY_METHOD,
  wireBytesOf,
  WireDecodeError,
} from './wire-format.js';
// The Foundry module's mirror of the same constants. Cross-package import on
// purpose: it is what makes the equality below a mechanism instead of a comment.
import { WEBRTC_CONSTANTS as MODULE_WEBRTC_CONSTANTS } from '../../foundry-module/src/constants.js';
import {
  COMPRESSED_MESSAGE_TYPE as MODULE_ENVELOPE_TYPE,
  COMPRESSION_CAPABILITY as MODULE_CAPABILITY,
  COMPRESSION_ENCODING as MODULE_ENCODING,
  compressMessage as moduleCompressMessage,
  decompressEnvelope as moduleDecompressEnvelope,
} from '../../foundry-module/src/wire-format.js';

const query = (method: string, data?: any) => ({
  type: 'mcp-query',
  id: 'query-7',
  data: { method, data },
});

describe('Requirement: the transport size constants have one declaration per package, proven equal', () => {
  it('the module mirror matches the server constants field for field', () => {
    // If this fails, the two files below disagree and one of them was changed
    // alone. Both must be edited together:
    //   packages/mcp-server/src/config.ts            (WEBRTC_CONSTANTS)
    //   packages/foundry-module/src/constants.ts     (WEBRTC_CONSTANTS)
    // The Foundry module cannot import @foundry-mcp/shared: it is browser-loaded
    // ESM built by plain tsc, so a bare specifier would not resolve at runtime.
    for (const field of ['MAX_MESSAGE_SIZE', 'CHUNK_SIZE', 'MAX_DECOMPRESSED_BYTES'] as const) {
      expect(
        MODULE_WEBRTC_CONSTANTS[field],
        `${field} differs: packages/foundry-module/src/constants.ts says ` +
          `${MODULE_WEBRTC_CONSTANTS[field]}, packages/mcp-server/src/config.ts says ` +
          `${WEBRTC_CONSTANTS[field]}`
      ).toBe(WEBRTC_CONSTANTS[field]);
    }
  });

  it('no size constant is declared inside a function body', async () => {
    const { readFileSync } = await import('fs');
    const source = readFileSync(
      new URL('../../foundry-module/src/webrtc-connection.ts', import.meta.url),
      'utf8'
    );
    // These used to be `const MAX_MESSAGE_SIZE = 65536` inside `sendMessage`.
    expect(source).not.toMatch(/const\s+MAX_MESSAGE_SIZE\s*=/);
    expect(source).not.toMatch(/const\s+CHUNK_SIZE\s*=/);
    expect(source).toMatch(/WEBRTC_CONSTANTS/);
  });

  it('the two packages agree on the envelope vocabulary', () => {
    expect(MODULE_ENVELOPE_TYPE).toBe(COMPRESSED_MESSAGE_TYPE);
    expect(MODULE_ENCODING).toBe(COMPRESSION_ENCODING);
    expect(MODULE_CAPABILITY).toBe(COMPRESSION_CAPABILITY);
  });
});

describe('Requirement: compressed JSON is the wire format for query traffic', () => {
  it('wraps a query in a type-declared envelope carrying encoding, type and request id', () => {
    const envelope = compressMessage(query('foundry-mcp-bridge.importActors', { actors: [] }));
    expect(envelope.type).toBe(COMPRESSED_MESSAGE_TYPE);
    expect(envelope.encoding).toBe('gzip');
    expect(envelope.originalType).toBe('mcp-query');
    // Carried so a decode failure can be answered against the request that
    // caused it rather than dropped.
    expect(envelope.originalId).toBe('query-7');
    expect(isCompressedEnvelope(envelope)).toBe(true);
  });

  it('is gzip on the wire — self-identifying magic, not a bare deflate stream', () => {
    const envelope = compressMessage(query('x', { a: 1 }));
    const raw = Buffer.from(envelope.payload, 'base64');
    expect(raw[0]).toBe(0x1f);
    expect(raw[1]).toBe(0x8b);
  });

  it('round-trips a payload byte-identically, accents and astral plane included', () => {
    const message = query('foundry-mcp-bridge.importActors', {
      actors: [
        {
          name: 'Salvador Pacheco-König',
          system: { biography: 'Añoranza — «sueños» de un tecnómago 𝕄𝔸𝔾𝔼 🜍' },
        },
      ],
    });
    const back = decompressEnvelope(compressMessage(message));
    expect(back).toEqual(message);
    expect(JSON.stringify(back)).toBe(JSON.stringify(message));
  });

  it('interoperates with the module codec in both directions', async () => {
    const request = query('foundry-mcp-bridge.importActors', { actors: [{ name: 'Ludo' }] });
    // server -> module
    expect(await moduleDecompressEnvelope(compressMessage(request))).toEqual(request);
    // module -> server
    const response = { type: 'mcp-response', id: 'query-7', data: { success: true, data: [1, 2] } };
    expect(decompressEnvelope((await moduleCompressMessage(response)) as any)).toEqual(response);
  });
});

describe('Requirement: the plain-envelope set is closed, keyed by type, and justified by measurement', () => {
  it('control messages get BIGGER compressed — which is why they stay plain', () => {
    // The measurement the exception set rests on. If a later change starts
    // compressing the handshake or liveness exchange, this fails.
    const cases: Array<[string, any]> = [
      ['ping query', query(PING_QUERY_METHOD)],
      ['transport pong', { type: 'pong', id: 'query-7', data: { timestamp: 0, status: 'ok' } }],
    ];
    for (const [label, message] of cases) {
      const plain = Buffer.byteLength(JSON.stringify(message), 'utf8');
      const enveloped = Buffer.byteLength(
        JSON.stringify({
          type: COMPRESSED_MESSAGE_TYPE,
          encoding: COMPRESSION_ENCODING,
          originalType: message.type,
          originalId: message.id ?? '',
          payload: gzipSync(Buffer.from(JSON.stringify(message), 'utf8'), { level: 9 }).toString(
            'base64'
          ),
        }),
        'utf8'
      );
      expect(plain, `${label} should be small`).toBeLessThan(250);
      expect(enveloped, `${label}: compression must be a net LOSS at this size`).toBeGreaterThan(
        plain
      );
    }
  });

  it('forces the capability handshake plain — it cannot ride inside what it negotiates', () => {
    expect(mustSendPlain(query(PING_QUERY_METHOD))).toBe(true);
    // Decided from the type and method, never from size: a huge ping stays plain,
    // a tiny import query still compresses.
    expect(mustSendPlain(query(PING_QUERY_METHOD, { padding: 'x'.repeat(200_000) }))).toBe(true);
    expect(mustSendPlain(query('foundry-mcp-bridge.importActors', {}))).toBe(false);
  });

  it('forces liveness, unsolicited emissions and framing envelopes plain', () => {
    for (const type of [
      'ping',
      'pong',
      'bridge-status',
      'chunked-message',
      'job-completed',
      'map-generation-progress',
      'error',
    ]) {
      expect(mustSendPlain({ type, id: 'x' }), `${type} must stay plain`).toBe(true);
    }
  });

  it('compresses query traffic in both directions and nothing else', () => {
    expect(mustSendPlain({ type: 'mcp-query', id: 'q', data: { method: 'm' } })).toBe(false);
    expect(mustSendPlain({ type: 'mcp-response', id: 'q', data: { success: true } })).toBe(false);
  });

  it('wireBytesOf never compresses a forced-plain message even when asked to', () => {
    const ping = query(PING_QUERY_METHOD);
    expect(wireBytesOf(ping, true)).toBe(Buffer.byteLength(JSON.stringify(ping), 'utf8'));
  });
});

describe('Requirement: decompression is bounded, and a failure is surfaced against its request', () => {
  it('refuses an expansion beyond the documented maximum without retaining it', () => {
    // 64 MiB of zeroes compresses to ~64 KB: one frame in, a bomb out. gzip's
    // theoretical ceiling is ~1032:1, so this is not a contrived shape.
    const bomb = gzipSync(Buffer.alloc(64 * 1024 * 1024), { level: 9 });
    expect(bomb.length).toBeLessThan(WEBRTC_CONSTANTS.MAX_MESSAGE_SIZE);

    const envelope = {
      type: COMPRESSED_MESSAGE_TYPE as typeof COMPRESSED_MESSAGE_TYPE,
      encoding: COMPRESSION_ENCODING as typeof COMPRESSION_ENCODING,
      originalType: 'mcp-response',
      originalId: 'query-7',
      payload: bomb.toString('base64'),
    };

    let thrown: unknown;
    try {
      decompressEnvelope(envelope);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WireDecodeError);
    const err = thrown as WireDecodeError;
    expect(err.message).toContain(String(WEBRTC_CONSTANTS.MAX_DECOMPRESSED_BYTES));
    expect(err.message).toMatch(/nothing was dispatched/);
    // Answerable against the request that caused it.
    expect(err.originalId).toBe('query-7');
  });

  it('accepts an expansion just under the bound', () => {
    const payload = { type: 'mcp-response', id: 'q', data: 'y'.repeat(1024 * 1024) };
    expect(decompressEnvelope(compressMessage(payload))).toEqual(payload);
  });

  it('reports a corrupt payload as a decode error against the request', () => {
    const envelope = {
      type: COMPRESSED_MESSAGE_TYPE as typeof COMPRESSED_MESSAGE_TYPE,
      encoding: COMPRESSION_ENCODING as typeof COMPRESSION_ENCODING,
      originalType: 'mcp-response',
      originalId: 'query-9',
      payload: Buffer.from('not gzip at all').toString('base64'),
    };
    expect(() => decompressEnvelope(envelope)).toThrow(WireDecodeError);
    try {
      decompressEnvelope(envelope);
    } catch (error) {
      expect((error as WireDecodeError).originalId).toBe('query-9');
      expect((error as WireDecodeError).message).toMatch(/Could not decode/);
    }
  });

  it('rejects an unknown encoding rather than guessing', () => {
    const envelope = compressMessage(query('m'));
    expect(() => decompressEnvelope({ ...envelope, encoding: 'brotli' as any })).toThrow(
      /Unsupported compressed-message encoding "brotli"/
    );
  });

  it('rejects a well-formed gzip stream that is not JSON', () => {
    const envelope = {
      type: COMPRESSED_MESSAGE_TYPE as typeof COMPRESSED_MESSAGE_TYPE,
      encoding: COMPRESSION_ENCODING as typeof COMPRESSION_ENCODING,
      originalType: 'mcp-response',
      originalId: 'query-3',
      payload: gzipSync(Buffer.from('<html>not json</html>')).toString('base64'),
    };
    expect(() => decompressEnvelope(envelope)).toThrow(/not valid JSON/);
  });
});

describe('Requirement: a message still over the frame after compression is refused, on a measured size', () => {
  it('measures rather than predicts: art embedded as a data URI compresses ~1.5x', () => {
    // The residual ceiling made concrete. Random bytes stand in for a real WebP;
    // both are already-compressed content.
    const art = `data:image/webp;base64,${randomBytes(117_928).toString('base64')}`;
    const doc = { name: 'Ludo', img: art, prototypeToken: { texture: { src: art } } };

    const bytes = Buffer.byteLength(JSON.stringify(doc), 'utf8');
    const compressed = gzippedBytes(doc);
    const ratio = bytes / compressed;

    expect(bytes).toBeGreaterThan(300_000);
    expect(ratio).toBeLessThan(2);
    // Still multiple frames over the bound after compression — and about five
    // frames once base64-enveloped, which is the quantity that actually has to fit.
    // No ratio drawn from ordinary actor documents (6.9x-12x) could have predicted
    // this one.
    expect(compressed).toBeGreaterThan(3 * WEBRTC_CONSTANTS.MAX_MESSAGE_SIZE);
    const onWire = wireBytesOf(
      { type: 'mcp-query', id: 'q', data: { method: 'm', data: doc } },
      true
    );
    expect(onWire).toBeGreaterThan(4 * WEBRTC_CONSTANTS.MAX_MESSAGE_SIZE);
  });

  it('reports a wire size that is what the transport would really send', () => {
    const message = query('foundry-mcp-bridge.importActors', {
      actors: [{ name: 'x'.repeat(5000) }],
    });
    const measured = wireBytesOf(message, true);
    const envelope = compressMessage(message);
    expect(measured).toBe(Buffer.byteLength(JSON.stringify(envelope), 'utf8'));
    // And the plain measurement is the plain serialization, not an estimate.
    expect(wireBytesOf(message, false)).toBe(Buffer.byteLength(JSON.stringify(message), 'utf8'));
  });

  it('gzippedBytes is a measurement of the same bytes zlib produces', () => {
    const value = { a: 'repeated '.repeat(500) };
    expect(gzippedBytes(value)).toBe(
      gzipSync(Buffer.from(JSON.stringify(value), 'utf8'), { level: 9 }).length
    );
    expect(JSON.parse(gunzipSync(gzipSync(Buffer.from(JSON.stringify(value)))).toString())).toEqual(
      value
    );
  });
});
