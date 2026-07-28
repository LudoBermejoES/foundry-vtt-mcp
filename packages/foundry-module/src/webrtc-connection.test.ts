/**
 * The module's WebRTC transport: the outbound fragmenter and the inbound
 * compressed branch, driven through the real `WebRTCConnection` with a fake data
 * channel injected (a genuine one needs `RTCPeerConnection`).
 *
 * The fragmenter half exists to pin a defect this change fixes: it measured
 * `json.length` — UTF-16 CODE UNITS — against a byte limit, so a check that exists
 * to keep a message under SCTP's 64 KiB frame could not detect the case it was
 * written for. Compression dissolves that on the compressed path (gzip consumes an
 * encoded byte buffer; there is no `.length` left to get wrong) but NOT here, because
 * this framing layer still splits a text envelope.
 */

import { describe, it, expect } from 'vitest';
import { gzipSync } from 'zlib';
import { WEBRTC_CONSTANTS } from './constants.js';
import {
  WebRTCConnection,
  splitByUtf8Bytes,
  utf8Length,
  type WebRTCConfig,
} from './webrtc-connection.js';
import {
  COMPRESSED_MESSAGE_TYPE,
  COMPRESSION_ENCODING,
  compressMessage,
  type WireMeta,
} from './wire-format.js';

const config: WebRTCConfig = {
  serverHost: 'localhost',
  serverPort: 31415,
  namespace: '/foundry-mcp',
  stunServers: [],
  connectionTimeout: 1,
  debugLogging: false,
};

interface Wired {
  connection: WebRTCConnection;
  sent: string[];
  received: Array<{ message: any; meta: WireMeta }>;
  deliver: (raw: string) => Promise<void>;
}

function wire(): Wired {
  const sent: string[] = [];
  const received: Array<{ message: any; meta: WireMeta }> = [];
  const connection = new WebRTCConnection(config);
  const channel: any = {
    readyState: 'open',
    close: () => undefined,
    send: (raw: string) => sent.push(raw),
  };
  (connection as any).messageHandler = async (message: any, meta: WireMeta) => {
    received.push({ message, meta });
  };
  (connection as any).connectionState = 'connected';
  (connection as any).dataChannel = channel;
  (connection as any).setupDataChannelHandlers();

  return {
    connection,
    sent,
    received,
    deliver: async (raw: string) => {
      await channel.onmessage({ data: raw });
    },
  };
}

describe('splitByUtf8Bytes', () => {
  it('cuts on byte budgets, not code-unit counts', () => {
    // 10 euro signs: 10 UTF-16 units, 30 UTF-8 bytes.
    const parts = splitByUtf8Bytes('€'.repeat(10), 9);
    expect(parts.join('')).toBe('€'.repeat(10));
    for (const part of parts) expect(utf8Length(part)).toBeLessThanOrEqual(9);
    expect(parts).toHaveLength(4); // 3 chars per 9-byte window
  });

  it('never splits a multi-byte character, surrogate pairs included', () => {
    const text = 'a𝕄b€c𝔸'.repeat(50);
    for (const budget of [4, 5, 7, 13, 64]) {
      const parts = splitByUtf8Bytes(text, budget);
      expect(parts.join('')).toBe(text);
      for (const part of parts) {
        // No LONE surrogate anywhere: the string iterator yields one code point
        // per pair, so a code point left inside the surrogate range means a pair
        // was cut in half — which would decode to U+FFFD on the far side.
        for (const codePoint of part) {
          const value = codePoint.codePointAt(0) as number;
          expect(value < 0xd800 || value > 0xdfff).toBe(true);
        }
        expect(utf8Length(part)).toBeLessThanOrEqual(Math.max(4, budget));
      }
    }
  });
});

describe('Requirement: serialized size is measured in bytes', () => {
  it('fragments a message whose UTF-16 length is UNDER the threshold but whose bytes are OVER the frame', () => {
    const { connection, sent } = wire();

    // 40,000 euro signs: 40,000 UTF-16 code units — comfortably under the 51,200
    // fragment threshold, so the old `json.length` check sent it as ONE message —
    // but 120,000 UTF-8 bytes, nearly twice the 65,536-byte SCTP frame. This is the
    // message the old check could not see.
    const message = { type: 'mcp-response', id: 'query-1', data: '€'.repeat(40_000) };
    const json = JSON.stringify(message);
    expect(json.length).toBeLessThan(WEBRTC_CONSTANTS.CHUNK_SIZE);
    expect(utf8Length(json)).toBeGreaterThan(WEBRTC_CONSTANTS.MAX_MESSAGE_SIZE);

    connection.sendMessage(message);

    expect(sent.length).toBeGreaterThan(1);
    for (const frame of sent) {
      // Every frame fits the transport's real, byte-denominated limit.
      expect(utf8Length(frame)).toBeLessThanOrEqual(WEBRTC_CONSTANTS.MAX_MESSAGE_SIZE);
      expect(JSON.parse(frame).type).toBe('chunked-message');
    }

    // And the fragments reassemble to the original, byte for byte.
    const reassembled = sent
      .map(f => JSON.parse(f))
      .sort((a, b) => a.chunkIndex - b.chunkIndex)
      .map(f => f.chunk)
      .join('');
    expect(JSON.parse(reassembled)).toEqual(message);
  });

  it('still sends a small message as one frame', () => {
    const { connection, sent } = wire();
    connection.sendMessage({ type: 'pong', id: 'q', data: { status: 'ok' } });
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]).type).toBe('pong');
  });

  it('re-throws a failed send so the caller knows', () => {
    const connection = new WebRTCConnection(config);
    (connection as any).connectionState = 'connected';
    (connection as any).dataChannel = {
      readyState: 'open',
      send: () => {
        throw new Error('OperationError: Failure to send data');
      },
    };
    expect(() => connection.sendMessage({ type: 'pong', id: 'q' })).toThrow(/Failure to send data/);
  });
});

describe('Requirement: the encoding is discriminable from the declared type', () => {
  it('routes a compressed envelope by type and reports how it arrived', async () => {
    const { received, deliver } = wire();
    const inner = {
      type: 'mcp-query',
      id: 'query-5',
      data: { method: 'foundry-mcp-bridge.importActors', data: { actors: [{ name: 'Ludo' }] } },
    };
    await deliver(JSON.stringify(await compressMessage(inner)));

    expect(received).toHaveLength(1);
    expect(received[0].message).toEqual(inner);
    // The `compressed` note is what makes the response answer IN KIND.
    expect(received[0].meta.compressed).toBe(true);
  });

  it('still handles a plain message untouched, and marks it plain', async () => {
    const { received, deliver } = wire();
    const message = { type: 'ping', id: 'query-6' };
    await deliver(JSON.stringify(message));
    expect(received[0].message).toEqual(message);
    expect(received[0].meta.compressed).toBe(false);
  });

  it('interleaves plain and compressed messages safely, in either order', async () => {
    const { received, deliver } = wire();
    await deliver(JSON.stringify({ type: 'ping', id: 'a' }));
    await deliver(JSON.stringify(await compressMessage({ type: 'mcp-query', id: 'b', data: {} })));
    await deliver(JSON.stringify({ type: 'ping', id: 'c' }));
    expect(received.map(r => r.message.id)).toEqual(['a', 'b', 'c']);
    expect(received.map(r => r.meta.compressed)).toEqual([false, true, false]);
  });
});

describe('Requirement: a decode failure is answered against its request', () => {
  it('answers an over-bound expansion with an error, dispatching nothing', async () => {
    const { received, sent, deliver } = wire();
    const bomb = gzipSync(Buffer.alloc(64 * 1024 * 1024), { level: 9 });
    await deliver(
      JSON.stringify({
        type: COMPRESSED_MESSAGE_TYPE,
        encoding: COMPRESSION_ENCODING,
        originalType: 'mcp-query',
        originalId: 'query-99',
        payload: bomb.toString('base64'),
      })
    );

    // Nothing reached a handler, so no world write could be driven by it.
    expect(received).toHaveLength(0);

    expect(sent).toHaveLength(1);
    const reply = JSON.parse(sent[0]);
    expect(reply.type).toBe('mcp-response');
    expect(reply.id).toBe('query-99');
    expect(reply.data.success).toBe(false);
    expect(reply.data.error).toContain(String(WEBRTC_CONSTANTS.MAX_DECOMPRESSED_BYTES));
  });

  it('answers a corrupt payload with a decode error rather than dropping it', async () => {
    const { received, sent, deliver } = wire();
    await deliver(
      JSON.stringify({
        type: COMPRESSED_MESSAGE_TYPE,
        encoding: COMPRESSION_ENCODING,
        originalType: 'mcp-query',
        originalId: 'query-77',
        payload: Buffer.from('definitely not gzip').toString('base64'),
      })
    );
    expect(received).toHaveLength(0);
    const reply = JSON.parse(sent[0]);
    expect(reply.id).toBe('query-77');
    expect(reply.data.error).toMatch(/Could not decode/);
  });
});
