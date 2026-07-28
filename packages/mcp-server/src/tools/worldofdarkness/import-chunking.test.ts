/**
 * Byte-aware chunking for the WoD actor import.
 *
 * Requirement: "a batch import SHALL bound the work per bridge call."
 * These cover the pure packing function; import-actor.test.ts covers the tool
 * actually issuing one query per chunk.
 */

import { describe, it, expect } from 'vitest';
import {
  chunkDocsByBytes,
  chunkTimeoutMs,
  payloadBytes,
  DEFAULT_CHUNK_BUDGET_BYTES,
  TRANSPORT_MAX_MESSAGE_BYTES,
} from './import-chunking.js';

/** A document whose serialized size is approximately `bytes`. */
function docOfBytes(name: string, bytes: number) {
  const doc: Record<string, any> = { name, type: 'mortal', system: { filler: '' } };
  const overhead = payloadBytes(doc);
  doc.system.filler = 'x'.repeat(Math.max(0, bytes - overhead));
  return doc;
}

describe('payloadBytes', () => {
  it('measures UTF-8 bytes, not JS string length', () => {
    // A 3-byte character must count as 3, or the budget under-counts and a
    // chunk can exceed the transport cap.
    expect(payloadBytes('€')).toBe(payloadBytes('abc'));
  });
});

describe('chunkDocsByBytes', () => {
  it('returns no chunks for an empty batch', () => {
    expect(chunkDocsByBytes([])).toEqual([]);
  });

  it('keeps small docs together in one chunk', () => {
    const docs = [docOfBytes('a', 100), docOfBytes('b', 100), docOfBytes('c', 100)];
    const chunks = chunkDocsByBytes(docs, 10000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].docs).toHaveLength(3);
    expect(chunks[0].oversized).toBe(false);
  });

  it('splits by BYTES, not by count — six ~47 KB actors become six chunks', () => {
    const docs = Array.from({ length: 6 }, (_, i) => docOfBytes(`actor-${i}`, 47 * 1024));
    const chunks = chunkDocsByBytes(docs);
    expect(chunks).toHaveLength(6);
    for (const c of chunks) {
      expect(c.docs).toHaveLength(1);
      expect(c.bytes).toBeLessThanOrEqual(DEFAULT_CHUNK_BUDGET_BYTES);
    }
  });

  it('packs unequal docs greedily without exceeding the budget', () => {
    // Same document COUNT, wildly different sizes: a count-based scheme would
    // treat these identically and blow the budget on the first chunk.
    const docs = [
      docOfBytes('big', 40 * 1024),
      docOfBytes('small1', 2 * 1024),
      docOfBytes('small2', 2 * 1024),
      docOfBytes('big2', 40 * 1024),
    ];
    const chunks = chunkDocsByBytes(docs, DEFAULT_CHUNK_BUDGET_BYTES);
    for (const c of chunks) {
      expect(c.bytes).toBeLessThanOrEqual(DEFAULT_CHUNK_BUDGET_BYTES);
    }
    // Order preserved across chunks (chunks are issued sequentially).
    expect(chunks.flatMap(c => c.docs.map((d: any) => d.name))).toEqual([
      'big',
      'small1',
      'small2',
      'big2',
    ]);
  });

  it('flags a single indivisible over-budget doc rather than splitting it', () => {
    const chunks = chunkDocsByBytes([docOfBytes('huge', 80 * 1024)]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].docs).toHaveLength(1);
    // `oversized` no longer means "refuse". Since
    // lift-bridge-per-document-size-ceiling it means only "give this query a
    // deadline scaled to its size" — the document travels, compressed, in one
    // query, even though it is larger than a transport frame uncompressed.
    expect(chunks[0].oversized).toBe(true);
    expect(chunks[0].bytes).toBeGreaterThan(TRANSPORT_MAX_MESSAGE_BYTES);
  });

  it('gives an over-frame chunk a scaled deadline instead of refusing it', () => {
    // The Salvador case: ~97 KB in one indivisible document, budget 51,200 B.
    const chunk = chunkDocsByBytes([docOfBytes('salvador', 97 * 1024)])[0];
    expect(chunk.bytes).toBeGreaterThan(TRANSPORT_MAX_MESSAGE_BYTES);
    expect(chunkTimeoutMs(chunk, 10_000)).toBe(20_000);
  });

  it('honours the secondary per-chunk document cap', () => {
    const docs = Array.from({ length: 5 }, (_, i) => docOfBytes(`a${i}`, 100));
    const chunks = chunkDocsByBytes(docs, 1_000_000, 2);
    expect(chunks.map(c => c.docs.length)).toEqual([2, 2, 1]);
  });

  it('reports a chunk size that matches what will actually be serialized', () => {
    const docs = [docOfBytes('a', 1000), docOfBytes('b', 1000)];
    const chunks = chunkDocsByBytes(docs, 1_000_000);
    expect(chunks[0].bytes).toBe(payloadBytes(chunks[0].docs));
  });
});

describe('chunkTimeoutMs', () => {
  it('leaves a within-budget chunk at the base timeout', () => {
    const [chunk] = chunkDocsByBytes([docOfBytes('a', 10 * 1024)]);
    expect(chunkTimeoutMs(chunk, 10000)).toBe(10000);
  });

  it('scales an over-budget chunk up proportionally', () => {
    // 120 KiB against a 50 KiB budget ⇒ ceil(2.4) = 3 budgets' worth of work.
    const [chunk] = chunkDocsByBytes([docOfBytes('huge', 120 * 1024)]);
    expect(chunkTimeoutMs(chunk, 10000)).toBe(30000);
  });

  it('never exceeds the config maximum', () => {
    const [chunk] = chunkDocsByBytes([docOfBytes('huge', 5 * 1024 * 1024)]);
    expect(chunkTimeoutMs(chunk, 600000)).toBe(600000);
  });
});
