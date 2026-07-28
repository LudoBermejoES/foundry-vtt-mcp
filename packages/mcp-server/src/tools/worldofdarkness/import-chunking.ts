/**
 * Byte-aware batching for `worldofdarkness-import-actor`.
 *
 * WHY BYTE-AWARE AND NOT COUNT-AWARE
 * ----------------------------------
 * A six-actor import (~305 KB of JSON) failed with
 * `Query timeout: foundry-mcp-bridge.importActors`, while the same six actors
 * imported one at a time (~47 KB each) succeeded every time. Two independent
 * ceilings were behind that. ONE OF THEM IS GONE, and the surviving one is the
 * only reason this file still exists:
 *
 * 1. WALL CLOCK — still real, and now the sole justification. `DataAccess.importActors`
 *    is a sequential loop; per actor it awaits `Actor.create(doc)`, which creates
 *    every embedded item and the prototype token (data-access.ts:1276-1466). Cost
 *    is linear in the actor's item count, so a fixed query deadline is a limit on
 *    total serialized WORK — which correlates far better with bytes than with a
 *    document count. (An actor with 5 items and one with 150 are both "1".) A
 *    6-actor query is 6x the Foundry work whether or not it fits in one frame.
 *
 * 2. TRANSPORT MESSAGE SIZE — no longer a reason to chunk, and no longer a reason
 *    to refuse. Compressed JSON is now the bridge wire format (wire-format.ts):
 *    every `mcp-query` travels gzipped inside a `compressed-message` envelope once
 *    the module has advertised `transport.compression.gzip`. Real WoD actor
 *    documents compress 6.9x-12x, so a ~97 KB actor lands at ~16 KB of the
 *    65,536-byte frame — 24%, with 4x headroom — and even the six-actor batch that
 *    started this (277,676 B) fits in ONE message at 34,904 B.
 *
 *    HISTORY, kept because it explains a refusal that used to live in
 *    import-actor.ts: fragmentation in this repo is one-directional. The module
 *    splits and the server reassembles; the server->Foundry direction did neither,
 *    so on WebRTC an oversized `mcp-query` was dropped with one warn line and the
 *    caller observed exactly the `Query timeout` above. The tool therefore refused
 *    any single document over `MAX_MESSAGE_SIZE` before writing — a stand-in for a
 *    missing mechanism, not an oversight. Compression supplies the mechanism, and
 *    an undeliverable send now rejects its query immediately
 *    (foundry-connector.ts), so the refusal is gone. Fragmenting the
 *    server->Foundry direction remains the designed backstop and is deliberately
 *    deferred; see wire-format.ts for the ordering and the trigger.
 *
 * WHAT STILL BINDS
 * ----------------
 *   - one frame, measured AFTER compression: `WEBRTC_CONSTANTS.MAX_MESSAGE_SIZE`
 *     (65,536 B). Enforced by the import tool on a measured size only, never
 *     predicted from a ratio — an actor carrying an embedded 118 KB image
 *     compresses 1.5x, not 9x.
 *   - one staged document file: `wod.importMaxBytes` (2 MiB default).
 *   - this file's per-query WORK budget, in uncompressed bytes.
 */

import { WEBRTC_CONSTANTS } from '../../config.js';

/**
 * Default per-query serialized budget, in UNCOMPRESSED bytes: ~one actor's worth
 * of Foundry work, which is the empirically good path. The value happens to equal
 * the transport's old fragment threshold; that is now a coincidence of history, not
 * a transport constraint — nothing about this number is about message size any
 * more.
 */
export const DEFAULT_CHUNK_BUDGET_BYTES = WEBRTC_CONSTANTS.CHUNK_SIZE;

/**
 * Upper bound accepted for `chunkBytes`, in uncompressed bytes.
 *
 * NOT the frame size — that would be re-asserting the size ceiling this change
 * removed. The bound is wall-clock: `chunkTimeoutMs` scales a query's deadline by
 * `ceil(bytes / budget)` and caps it at 600 s, so above ~1 MiB of work in one query
 * a caller is asking for more Foundry work than the maximum deadline can cover.
 * At the measured ~47 KB per WoD actor, 1 MiB is ~22 actors created inside one
 * query — already far beyond anything tested.
 */
export const MAX_CHUNK_BUDGET_BYTES = 1024 * 1024;

/**
 * One transport frame, in bytes. Retained under its old name because it is still
 * the bound the tool checks — but it is now checked against the MEASURED COMPRESSED
 * size of the message that would actually be sent, not against a document's
 * uncompressed size, and it is no longer `chunkBytes`' maximum.
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
   *
   * A document is indivisible — we cannot split one actor across two queries — so
   * it is sent alone. This flag NO LONGER MEANS "refuse": it means only "this query
   * gets a deadline scaled to its size" (`chunkTimeoutMs`). It used to be the
   * trigger for a pre-write refusal on WebRTC, back when an oversized `mcp-query`
   * was silently dropped by the transport.
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
