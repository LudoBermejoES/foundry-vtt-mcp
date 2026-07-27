/**
 * Byte-aware batching for `worldofdarkness-import-actor`.
 *
 * WHY BYTE-AWARE AND NOT COUNT-AWARE
 * ----------------------------------
 * A six-actor import (~305 KB of JSON) failed with
 * `Query timeout: foundry-mcp-bridge.importActors`, while the same six actors
 * imported one at a time (~47 KB each) succeeded every time. There are two
 * independent ceilings behind that, and only a byte budget respects both:
 *
 * 1. WALL CLOCK. `DataAccess.importActors` is a sequential loop; per actor it
 *    awaits `Actor.create(doc)`, which creates every embedded item and the
 *    prototype token. Cost is linear in the actor's item count, so a fixed
 *    query deadline is a limit on total serialized work — which correlates far
 *    better with bytes than with a document count. (An actor with 5 items and
 *    one with 150 are both "1".)
 *
 * 2. TRANSPORT MESSAGE SIZE. `foundry.connectionType` defaults to `'auto'`, so a
 *    deployment may resolve to WebSocket *or* WebRTC, and the two have wildly
 *    different limits:
 *      - WebSocket: `foundry-connector.ts` sets no `maxPayload`, so `ws`
 *        defaults to 100 MiB. 305 KB is a non-issue.
 *      - WebRTC: SCTP caps a data-channel message at
 *        `WEBRTC_CONSTANTS.MAX_MESSAGE_SIZE` (64 KiB), and the documented safe
 *        threshold is `CHUNK_SIZE` (50 KiB). ~47 KB per actor is uncomfortably
 *        close to both.
 *
 *    Worse, and worth stating explicitly because it is not documented anywhere
 *    else: the server→Foundry direction does NOT chunk. `WebRTCPeer.sendMessage`
 *    (webrtc-peer.ts:180) is a bare `dataChannel.send(JSON.stringify(message))`
 *    inside a try/catch that only *logs* on failure. Only the Foundry→server
 *    direction chunks (foundry-module/src/webrtc-connection.ts:206-218). So on a
 *    WebRTC deployment an oversized `mcp-query` is dropped with nothing but a
 *    warn line, and the caller sees exactly the `Query timeout` observed above.
 *
 * Building the byte budget therefore makes the fix correct under *either*
 * transport, without first having to determine which one production resolves to.
 */

import { WEBRTC_CONSTANTS } from '../../config.js';

/**
 * Default per-query serialized budget: the documented WebRTC-safe threshold.
 * Below `MAX_MESSAGE_SIZE` (64 KiB) with headroom for the `mcp-query` envelope,
 * JSON escaping and chunk metadata. Also small enough that one query is roughly
 * "one actor's worth of Foundry work", which is the empirically good path.
 */
export const DEFAULT_CHUNK_BUDGET_BYTES = WEBRTC_CONSTANTS.CHUNK_SIZE;

/**
 * Hard per-message ceiling. Only enforceable-as-a-rejection on the WebRTC
 * transport; on WebSocket the real limit is `ws`'s 100 MiB default and rejecting
 * here would break callers who import one large actor successfully today.
 */
export const TRANSPORT_MAX_MESSAGE_BYTES = WEBRTC_CONSTANTS.MAX_MESSAGE_SIZE;

/** Serialized size of a value as it will travel over the bridge. */
export function payloadBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
}

export interface DocChunk<T> {
  docs: T[];
  /** Serialized bytes of `docs` (excluding the surrounding query envelope). */
  bytes: number;
  /**
   * True when this chunk holds a single document that is itself over budget.
   * A document is indivisible — we cannot split one actor across two queries —
   * so it is sent alone and the over-budget condition is surfaced rather than
   * hidden.
   */
  oversized: boolean;
}

/**
 * Pack documents into chunks whose serialized size stays within `budgetBytes`.
 *
 * Order is preserved (chunks are issued sequentially, never in parallel — two
 * concurrent chunks carrying the same `sourceId` could each fail to see the
 * other's actor and duplicate it).
 *
 * `maxDocsPerChunk` is a secondary cap so a caller can still say "one actor per
 * query" for a world slow enough that even a 50 KiB chunk exceeds the deadline.
 */
export function chunkDocsByBytes<T>(
  docs: readonly T[],
  budgetBytes: number = DEFAULT_CHUNK_BUDGET_BYTES,
  maxDocsPerChunk: number = Number.MAX_SAFE_INTEGER
): DocChunk<T>[] {
  const chunks: DocChunk<T>[] = [];
  if (docs.length === 0) return chunks;

  const budget = Math.max(1, budgetBytes);
  const docCap = Math.max(1, maxDocsPerChunk);

  let current: T[] = [];
  let currentBytes = 2; // "[]"

  const flush = () => {
    if (current.length === 0) return;
    chunks.push({
      docs: current,
      bytes: currentBytes,
      oversized: current.length === 1 && currentBytes > budget,
    });
    current = [];
    currentBytes = 2;
  };

  for (const doc of docs) {
    // +1 for the comma joining this entry to the previous one.
    const size = payloadBytes(doc) + (current.length > 0 ? 1 : 0);
    const wouldExceedBytes = current.length > 0 && currentBytes + size > budget;
    const wouldExceedCount = current.length >= docCap;
    if (wouldExceedBytes || wouldExceedCount) flush();
    current.push(doc);
    currentBytes += current.length === 1 ? payloadBytes(doc) : size;
  }
  flush();

  return chunks;
}

/**
 * A per-chunk deadline. The base default covers a chunk of roughly one actor;
 * chunks carrying more serialized work get proportionally more time, because
 * per-actor cost scales with embedded-item count and is not knowable up front.
 */
export function chunkTimeoutMs(
  chunk: DocChunk<unknown>,
  baseTimeoutMs: number,
  budgetBytes: number = DEFAULT_CHUNK_BUDGET_BYTES
): number {
  const factor = Math.max(1, Math.ceil(chunk.bytes / Math.max(1, budgetBytes)));
  return Math.min(600000, baseTimeoutMs * factor);
}
