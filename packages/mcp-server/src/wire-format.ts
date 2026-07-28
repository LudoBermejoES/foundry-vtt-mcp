/**
 * The bridge wire format — server side.
 *
 * Compressed JSON is the wire format for query traffic, not a fallback engaged
 * by size. Every `mcp-query` the server sends and every `mcp-response` it
 * receives travels gzip-compressed, base64-encoded, inside a text envelope:
 *
 *   { type: 'compressed-message', encoding: 'gzip', originalType, originalId,
 *     payload: '<base64 of gzip of the serialized original message>' }
 *
 * WHY ALWAYS-ON AND NOT "ABOVE N BYTES"
 * -------------------------------------
 * A size threshold would leave both sides needing the discriminator logic
 * anyway, while confining it to the branch that fires only on large payloads —
 * the least-exercised and most load-bearing path — and would add a
 * "compress above N" constant to pick, defend and mirror across two packages.
 *
 * WHY A CLOSED, TYPE-KEYED SET STAYS PLAIN (`mustSendPlain`)
 * ---------------------------------------------------------
 * At control-message sizes compression makes messages BIGGER. Measured
 * (gzip -9, base64, full envelope):
 *
 *   - `mcp-query` for `foundry-mcp-bridge.ping`:  79 B plain -> 234 B enveloped
 *   - transport `pong`:                            79 B plain -> 225 B enveloped
 *
 * so the exception set is a measurement, not a preference (wire-format.test.ts
 * asserts it, so a later change cannot quietly compress the handshake). It is
 * keyed on message `type` and NEVER on size:
 *
 *   1. the capability handshake (`foundry-mcp-bridge.ping` and its response) —
 *      forced, since it is how each side discovers whether the peer speaks
 *      compression, so it cannot ride inside the encoding it negotiates;
 *   2. transport liveness (`ping` / `pong`);
 *   3. unsolicited status emissions (`bridge-status`, anything via
 *      `emitToServer`) and every other non-query message type;
 *   4. framing envelopes (`chunked-message`), whose header must be readable in
 *      order to reassemble the payload that rides inside it.
 *
 * Only `mcp-query` (server->module) and `mcp-response` (module->server) are
 * compressible, so the rule below is a whitelist: anything else is plain by
 * construction.
 *
 * WHY TEXT AND NOT BINARY FRAMES
 * ------------------------------
 * Binary would save the 33% base64 overhead but adds a SECOND discrimination
 * axis (`typeof event.data`) on top of the `type` switch, in a codebase where
 * `JSON.parse(event.data)` is assumed unconditionally on three receive paths; it
 * needs binary-mode configuration on two transports; and it would not compose
 * with the module's existing string fragmenter (which splits a serialized
 * string). Net wire reduction after base64 is still 6.5x-7.5x on real actor
 * payloads, which is affordable and measured.
 *
 * DEFERRED: FRAGMENTING THE SERVER->FOUNDRY DIRECTION
 * ---------------------------------------------------
 * Compression raises the frame bound; it does not remove it. The designed
 * backstop is `compress -> serialize -> fragment if still over`, in that order
 * (compressing first is what makes fragmentation almost never fire, and the
 * fragment count is not knowable until after compression). It is deliberately
 * NOT built: compression clears every realistic actor with ~4x headroom, and the
 * expensive half is a reassembler the Foundry module does not have. Trigger to
 * build it: a payload legitimately over one frame AFTER compression whose
 * content cannot be de-embedded (a genuine >400 KB actor, or a batch that must
 * travel as one query). See also
 * `openspec/changes/lift-bridge-per-document-size-ceiling/design.md`.
 *
 * NOT THIS: "import a zip archive of several actor files" is a different
 * feature — batch intake, a sibling of the import tool's `actorPaths` staged
 * files — and has nothing to do with this transport encoding.
 */

import { gzipSync, gunzipSync } from 'zlib';
import { WEBRTC_CONSTANTS } from './config.js';

/** Envelope `type` that declares a compressed payload. */
export const COMPRESSED_MESSAGE_TYPE = 'compressed-message';

/**
 * The one encoding. gzip rather than deflate/deflate-raw: the three measure
 * within 12-18 bytes of each other on every real payload, so the choice is not
 * about ratio. gzip has a self-identifying 2-byte magic (1f 8b), is the name an
 * operator recognises in a log line, and is spelled identically by Node's
 * `zlib.gzipSync` and the browser's `CompressionStream('gzip')`.
 */
export const COMPRESSION_ENCODING = 'gzip';

/** Capability the module advertises through the `ping` capability list. */
export const COMPRESSION_CAPABILITY = 'transport.compression.gzip';

/** The handshake query. Forced plain — it negotiates the encoding. */
export const PING_QUERY_METHOD = 'foundry-mcp-bridge.ping';

/**
 * Level 9. The payload is compressed once and read once, the CPU cost on a
 * ~100 KB document is single-digit milliseconds, and level 9 buys the last few
 * bytes of frame headroom for free at these sizes (level 6 measures within 20
 * bytes on every fixture). The module's `CompressionStream` has no level knob,
 * so the reverse direction uses whatever the engine picks; nothing depends on
 * the two matching.
 */
const GZIP_LEVEL = 9;

export interface CompressedEnvelope {
  type: typeof COMPRESSED_MESSAGE_TYPE;
  encoding: typeof COMPRESSION_ENCODING;
  /** `type` of the wrapped message, for logs and routing symmetry. */
  originalType: string;
  /**
   * Id of the request the wrapped message belongs to. Carried so a decode
   * failure can be answered AGAINST that request instead of dropped — the
   * difference between a caller learning the reason at once and waiting out its
   * deadline.
   */
  originalId: string;
  payload: string;
}

/** Raised for any failure to decode a compressed envelope, bound included. */
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
 * True when this message must travel as plain JSON regardless of what the peer
 * supports. Decided from `type` (and, for the handshake, the query method) —
 * never from serialized size.
 */
export function mustSendPlain(message: any): boolean {
  const type = message?.type;
  // Whitelist: only query traffic is compressible.
  if (type !== 'mcp-query' && type !== 'mcp-response') return true;
  // The capability handshake cannot ride inside the encoding it negotiates.
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

/** Wrap a message in a compressed envelope. Never called for `mustSendPlain`. */
export function compressMessage(message: any): CompressedEnvelope {
  const json = JSON.stringify(message);
  const payload = gzipSync(Buffer.from(json, 'utf8'), { level: GZIP_LEVEL }).toString('base64');
  return {
    type: COMPRESSED_MESSAGE_TYPE,
    encoding: COMPRESSION_ENCODING,
    originalType: typeof message?.type === 'string' ? message.type : 'unknown',
    originalId: typeof message?.id === 'string' ? message.id : '',
    payload,
  };
}

/**
 * Unwrap a compressed envelope, refusing an expansion beyond `maxBytes`.
 *
 * The bound is enforced by zlib WHILE INFLATING (`maxOutputLength`), so an
 * over-sized expansion is never materialised, and nothing partially
 * decompressed is ever returned to a caller — no handler can be driven by a
 * truncated payload.
 */
export function decompressEnvelope(
  envelope: CompressedEnvelope,
  maxBytes: number = WEBRTC_CONSTANTS.MAX_DECOMPRESSED_BYTES
): any {
  const { originalId, originalType, encoding, payload } = envelope;

  if (encoding !== COMPRESSION_ENCODING) {
    throw new WireDecodeError(
      `Unsupported compressed-message encoding "${encoding}" (this build speaks "${COMPRESSION_ENCODING}")`,
      originalId,
      originalType
    );
  }

  let inflated: Buffer;
  try {
    inflated = gunzipSync(Buffer.from(payload, 'base64'), { maxOutputLength: maxBytes });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // zlib enforces `maxOutputLength` by refusing the allocation, and surfaces it
    // as ERR_BUFFER_TOO_LARGE ("Cannot create a Buffer larger than N bytes") — the
    // code is the reliable signal; the text is matched only as a fallback.
    const tooBig =
      (error as { code?: string })?.code === 'ERR_BUFFER_TOO_LARGE' ||
      /maxOutputLength|larger than \d+ bytes|ERR_BUFFER_TOO_LARGE/i.test(message);
    throw new WireDecodeError(
      tooBig
        ? `Refused a compressed message that decompresses beyond the ${maxBytes}-byte maximum ` +
          `(decompression-bomb guard); nothing was dispatched`
        : `Could not decode a compressed message (encoding ${encoding}): ${message}`,
      originalId,
      originalType
    );
  }

  try {
    return JSON.parse(inflated.toString('utf8'));
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
 * Serialized size, in bytes, of the message as it would go on the wire — the
 * compressed envelope when `compressed`, the plain JSON otherwise.
 *
 * This is the only sanctioned way to answer "will this fit in a frame": it
 * MEASURES, and callers must never predict a compressed size from an assumed
 * ratio. The spread is the whole point — ordinary actor documents compress
 * 6.9x-12x, but one carrying a 118 KB WebP as an embedded `data:` URI compresses
 * 1.5x (369,259 B -> 245,480 B), five times over the frame.
 */
export function wireBytesOf(message: any, compressed: boolean): number {
  const onWire = compressed && !mustSendPlain(message) ? compressMessage(message) : message;
  return Buffer.byteLength(JSON.stringify(onWire), 'utf8');
}

/**
 * Measured gzip size, in bytes, of a value's serialized JSON. Reported per
 * document by the import tool's dry-run plan. Measured, never predicted.
 */
export function gzippedBytes(value: unknown): number {
  return gzipSync(Buffer.from(JSON.stringify(value ?? null), 'utf8'), { level: GZIP_LEVEL }).length;
}
