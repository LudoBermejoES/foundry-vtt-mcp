/**
 * The bridge wire format — Foundry-module (browser) side.
 *
 * Mirror of `packages/mcp-server/src/wire-format.ts`; that file carries the full
 * rationale (why always-on rather than size-triggered, why the plain set is
 * keyed by `type`, why text framing rather than binary, and why fragmenting the
 * server->Foundry direction is designed but deferred). Only the differences that
 * matter here are repeated:
 *
 * - The primitives are the platform's `CompressionStream` / `DecompressionStream`
 *   rather than Node `zlib`, so both directions are ASYNCHRONOUS in this package.
 * - `isCompressionAvailable()` IS the feature detection. The module advertises
 *   `transport.compression.gzip` only when it returns true, so an engine without
 *   the primitive is simply never sent compressed traffic and there is no
 *   engine-version table to maintain.
 * - A response is compressed IF AND ONLY IF the request it answers arrived
 *   compressed. The request is itself proof the peer speaks compression, so this
 *   direction needs no negotiation of its own and the two directions cannot
 *   disagree.
 */

import { WEBRTC_CONSTANTS } from './constants.js';

export const COMPRESSED_MESSAGE_TYPE = 'compressed-message';
export const COMPRESSION_ENCODING = 'gzip';
export const COMPRESSION_CAPABILITY = 'transport.compression.gzip';
export const PING_QUERY_METHOD = 'foundry-mcp-bridge.ping';

export interface CompressedEnvelope {
  type: typeof COMPRESSED_MESSAGE_TYPE;
  encoding: string;
  originalType: string;
  originalId: string;
  payload: string;
}

/** How an inbound message arrived, so a reply can be encoded the same way. */
export interface WireMeta {
  /** True when the message arrived inside a `compressed-message` envelope. */
  compressed: boolean;
}

export class WireDecodeError extends Error {
  constructor(
    message: string,
    readonly originalId: string | undefined,
    readonly originalType: string | undefined
  ) {
    super(message);
    this.name = 'WireDecodeError';
  }
}

/**
 * The advertisement IS the feature detect. Both halves are checked: this client
 * must be able to decompress what the server sends AND compress what it answers.
 */
export function isCompressionAvailable(): boolean {
  return (
    typeof DecompressionStream === 'function' &&
    typeof CompressionStream === 'function' &&
    typeof TextEncoder === 'function' &&
    typeof TextDecoder === 'function'
  );
}

/** See the server-side `mustSendPlain`: keyed on `type`, never on size. */
export function mustSendPlain(message: any): boolean {
  const type = message?.type;
  if (type !== 'mcp-query' && type !== 'mcp-response') return true;
  if (type === 'mcp-query' && message?.data?.method === PING_QUERY_METHOD) return true;
  return false;
}

export function isCompressedEnvelope(message: any): message is CompressedEnvelope {
  return (
    !!message &&
    message.type === COMPRESSED_MESSAGE_TYPE &&
    typeof message.payload === 'string' &&
    typeof message.encoding === 'string'
  );
}

/** UTF-8 byte length of a string. */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

// `btoa`/`atob` operate on binary strings, and `String.fromCharCode(...bytes)`
// blows the call stack somewhere around 100 KB of argument spread — which is
// exactly the payload size this change exists to carry. Both directions walk in
// fixed windows instead.
const B64_WINDOW = 0x8000;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += B64_WINDOW) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, Math.min(i + B64_WINDOW, bytes.length)))
    );
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  // Allocated from an explicit ArrayBuffer so the type is the non-shared
  // `BufferSource` the stream writer accepts.
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Wrap a message in a compressed envelope. Never called for `mustSendPlain`. */
export async function compressMessage(message: any): Promise<CompressedEnvelope> {
  const bytes = new TextEncoder().encode(JSON.stringify(message));
  const stream = new CompressionStream(COMPRESSION_ENCODING);
  const writer = stream.writable.getWriter();
  const written = (async () => {
    await writer.write(bytes);
    await writer.close();
  })();

  const reader = stream.readable.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      parts.push(value);
      total += value.byteLength;
    }
  }
  await written;

  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }

  return {
    type: COMPRESSED_MESSAGE_TYPE,
    encoding: COMPRESSION_ENCODING,
    originalType: typeof message?.type === 'string' ? message.type : 'unknown',
    originalId: typeof message?.id === 'string' ? message.id : '',
    payload: bytesToBase64(out),
  };
}

/**
 * Unwrap a compressed envelope, aborting past `maxBytes` of output.
 *
 * SECURITY. `DecompressionStream` imposes no size limit of its own, so the count
 * is kept WHILE READING and the retained chunks are dropped and the stream
 * cancelled the moment the bound would be crossed — the output is never
 * materialised, and nothing partially decompressed is ever returned, so no
 * handler (and therefore no world write) can be driven by a truncated payload.
 */
export async function decompressEnvelope(
  envelope: CompressedEnvelope,
  maxBytes: number = WEBRTC_CONSTANTS.MAX_DECOMPRESSED_BYTES
): Promise<any> {
  const { originalId, originalType, encoding, payload } = envelope;

  if (encoding !== COMPRESSION_ENCODING) {
    throw new WireDecodeError(
      `Unsupported compressed-message encoding "${encoding}" (this module speaks "${COMPRESSION_ENCODING}")`,
      originalId,
      originalType
    );
  }
  if (!isCompressionAvailable()) {
    throw new WireDecodeError(
      'Received a compressed message but this runtime has no DecompressionStream',
      originalId,
      originalType
    );
  }

  let json: string;
  try {
    const stream = new DecompressionStream(COMPRESSION_ENCODING);
    const writer = stream.writable.getWriter();
    const written = (async () => {
      await writer.write(base64ToBytes(payload));
      await writer.close();
    })();
    // Errors on the write side surface on the read side too; swallow the
    // duplicate so an over-bound cancel does not produce an unhandled rejection.
    written.catch(() => undefined);

    const reader = stream.readable.getReader();
    let parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (total + value.byteLength > maxBytes) {
        parts = [];
        await reader.cancel().catch(() => undefined);
        throw new WireDecodeError(
          `Refused a compressed message that decompresses beyond the ${maxBytes}-byte maximum ` +
            `(decompression-bomb guard); nothing was dispatched`,
          originalId,
          originalType
        );
      }
      total += value.byteLength;
      parts.push(value);
    }

    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.byteLength;
    }
    json = new TextDecoder().decode(out);
  } catch (error) {
    if (error instanceof WireDecodeError) throw error;
    throw new WireDecodeError(
      `Could not decode a compressed message (encoding ${encoding}): ${
        error instanceof Error ? error.message : String(error)
      }`,
      originalId,
      originalType
    );
  }

  try {
    return JSON.parse(json);
  } catch (error) {
    throw new WireDecodeError(
      `Decompressed a compressed message but it was not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
      originalId,
      originalType
    );
  }
}

/**
 * The reply the module sends when it cannot decode an inbound message.
 *
 * SHAPE MATTERS, and the shape the existing chunk-reassembly failure path uses
 * (`{ type: 'error', requestId }`, webrtc-peer.ts) is NOT it: the peer's
 * `handleMessage` routes `mcp-response` (by `id`) and `pong`, and falls through
 * everything else to a debug log — so an `error` message rejects nothing and the
 * caller still waits out its deadline. A failed `mcp-response` keyed by the
 * originating query id is what actually rejects the pending promise.
 */
export function decodeFailureResponse(error: WireDecodeError): any {
  return {
    type: 'mcp-response',
    id: error.originalId || 'unknown',
    data: { success: false, error: error.message },
  };
}
