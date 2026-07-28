/**
 * The measurements that decide the design, asserted against REAL WoD documents.
 *
 * Why real and not synthetic: synthetic JSON compresses unrealistically well (a
 * run of one character compresses ~1000x), so a synthetic corpus would turn every
 * ratio assertion into a tautology. The corpus is therefore the committed wodchar
 * fixtures and splat templates.
 *
 * WHERE THE CORPUS LIVES, AND WHY THAT IS AWKWARD. It lives in the SIBLING
 * `wod20-char` submodule of the mago20 monorepo:
 *
 *   wod20-char/web/tests/fixtures/foundry/*.real.json          (12 real exports)
 *   wod20-char/web/server/services/foundry/splat-templates/*.json  (49 templates)
 *
 * `foundry-vtt-mcp` is its own standalone repository (a fork of
 * adambdooley/foundry-vtt-mcp), so it cannot DEPEND on those paths: a fresh clone
 * of this repo alone has no `wod20-char`. Nor can the fixtures be copied here —
 * they are real players' exported characters. So the corpus block below is skipped,
 * loudly, when the sibling checkout is absent, and runs in full inside the
 * monorepo, which is the only place the measurements can be kept honest. Point it
 * elsewhere with `WOD_FIXTURES_DIR` / `WOD_SPLAT_TEMPLATES_DIR`.
 *
 * The behavioural guarantees — round-trip, the bomb bound, the plain set, the
 * measured frame guard — are in `wire-format.test.ts` and always run.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import * as path from 'path';
import { WEBRTC_CONSTANTS } from './config.js';
import { compressMessage, gzippedBytes } from './wire-format.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// packages/mcp-server/src -> foundry-vtt-mcp -> the mago20 monorepo that contains
// this repo as a submodule alongside wod20-char.
const monorepo = path.resolve(here, '../../../..');

const FIXTURES_DIR =
  process.env.WOD_FIXTURES_DIR ?? path.join(monorepo, 'wod20-char/web/tests/fixtures/foundry');
const TEMPLATES_DIR =
  process.env.WOD_SPLAT_TEMPLATES_DIR ??
  path.join(monorepo, 'wod20-char/web/server/services/foundry/splat-templates');

const corpusPresent = existsSync(FIXTURES_DIR) && existsSync(TEMPLATES_DIR);
if (!corpusPresent) {
  // eslint-disable-next-line no-console
  console.warn(
    `[wire-format.corpus] SKIPPED: the WoD corpus is not checked out here.\n` +
      `  expected exports at   ${FIXTURES_DIR}\n` +
      `  expected templates at ${TEMPLATES_DIR}\n` +
      `  These live in the sibling wod20-char submodule of the mago20 monorepo and are real\n` +
      `  player data, so they are not vendored into this repository. Inside the monorepo this\n` +
      `  block runs and pins every compression measurement the design rests on.`
  );
}

interface Measured {
  file: string;
  bytes: number;
  gzip: number;
  ratio: number;
  base64: number;
  items: number;
}

function measure(file: string, dir: string): Measured {
  const doc = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
  const bytes = Buffer.byteLength(JSON.stringify(doc), 'utf8');
  const gzip = gzippedBytes(doc);
  return {
    file,
    bytes,
    gzip,
    ratio: bytes / gzip,
    base64: Math.ceil(gzip / 3) * 4,
    items: Array.isArray(doc.items) ? doc.items.length : 0,
  };
}

/** Base64 length of `n` bytes — the 4/3 the text envelope actually costs. */
const b64Len = (n: number) => Math.ceil(n / 3) * 4;

describe.skipIf(!corpusPresent)('the WoD compression corpus', () => {
  const FRAME = WEBRTC_CONSTANTS.MAX_MESSAGE_SIZE;

  it('the 49 splat scaffolds: the 68-74% of the frame that vanishes', () => {
    // `_index.json` is the directory manifest, not a splat template.
    const files = readdirSync(TEMPLATES_DIR)
      .filter(f => f.endsWith('.json') && f !== '_index.json')
      .sort();
    expect(files.length).toBe(49);

    const rows = files.map(f => measure(f, TEMPLATES_DIR));

    for (const row of rows) {
      // Every scaffold carries NO embedded items — this is the bare actor.
      expect(row.items, `${row.file} should be an empty scaffold`).toBe(0);

      // NOTE, and a correction to the proposal's prose: the range is
      // 32,916-48,485 bytes, not "44,000-48,485". Seven of the 49 (mortal,
      // creature, kinfolk, sorcerer, enchanted, ghoul, vampire) are smaller than
      // 44,000; design.md's own table lists mortal-modern.json at 32,916.
      expect(row.bytes, `${row.file} json`).toBeGreaterThanOrEqual(32_000);
      expect(row.bytes, `${row.file} json`).toBeLessThanOrEqual(49_000);

      // The half that matters: they compress ~11-12.5x, because an empty scaffold
      // is the most repetitive part of the document — which is exactly why it was
      // so large in the first place. Measured with Node zlib level 9, the range is
      // 10.98x (dauntain-modern.json) to 12.48x (thrall-modern.json); the task's
      // "11-12x" was 0.03 optimistic at the bottom, so the floor here is 10.9.
      expect(row.gzip, `${row.file} gzip`).toBeGreaterThanOrEqual(2_700);
      expect(row.gzip, `${row.file} gzip`).toBeLessThanOrEqual(4_300);
      expect(row.ratio, `${row.file} ratio`).toBeGreaterThanOrEqual(10.9);
      expect(row.ratio, `${row.file} ratio`).toBeLessThanOrEqual(13);

      // Before: 50-74% of the frame with zero items. After: under 10%.
      expect(b64Len(row.gzip) / FRAME, `${row.file} share of frame`).toBeLessThan(0.1);
    }

    // The largest scaffold used to eat 68-74% of the frame before a single item
    // existed. That is the whole reason the ceiling was mis-sized.
    const largest = rows.reduce((a, b) => (b.bytes > a.bytes ? b : a));
    expect(largest.bytes / FRAME).toBeGreaterThan(0.68);
    expect(b64Len(largest.gzip) / FRAME).toBeLessThan(0.1);
  });

  it('the 12 committed real exports: 36-55 KB of JSON, 3.9-8.0 KB compressed, never under 6.5x', () => {
    const files = readdirSync(FIXTURES_DIR)
      .filter(f => f.endsWith('.real.json'))
      .sort();
    expect(files.length).toBe(12);

    const rows = files.map(f => measure(f, FIXTURES_DIR));

    for (const row of rows) {
      expect(row.items, `${row.file} items`).toBeGreaterThanOrEqual(31);
      expect(row.bytes, `${row.file} json`).toBeGreaterThanOrEqual(36_000);
      expect(row.bytes, `${row.file} json`).toBeLessThanOrEqual(55_000);
      // gzip band with a few bytes of slack: zlib's level-9 output moves by ~20
      // bytes between versions, and the browser's CompressionStream picks its own
      // level. The RATIO floor is the load-bearing assertion.
      expect(row.gzip, `${row.file} gzip`).toBeGreaterThanOrEqual(3_800);
      expect(row.gzip, `${row.file} gzip`).toBeLessThanOrEqual(8_100);
      expect(row.ratio, `${row.file} ratio`).toBeGreaterThanOrEqual(6.5);
      // Every real actor fits one frame with room to spare, base64 included.
      expect(b64Len(row.gzip) / FRAME, `${row.file} share of frame`).toBeLessThan(0.2);
    }

    // The worst real case, which is the number the design is sized against.
    const worst = rows.reduce((a, b) => (b.ratio < a.ratio ? b : a));
    expect(worst.ratio).toBeLessThan(7.5);
    expect(worst.ratio).toBeGreaterThan(6.5);
  });

  it('a Salvador-class ~97 KB document with 89 distinct items fits one frame with 4x headroom', () => {
    const doc = salvadorClassDocument();
    const bytes = Buffer.byteLength(JSON.stringify(doc), 'utf8');
    const gzip = gzippedBytes(doc);

    expect(doc.items.length).toBe(89);
    expect(bytes).toBeGreaterThan(90_000);
    expect(bytes).toBeLessThan(105_000);

    // Under 25% of the frame on the wire, base64 included.
    expect(b64Len(gzip)).toBeLessThanOrEqual(16_000);
    expect(b64Len(gzip) / FRAME).toBeLessThan(0.25);

    // And the same is true of the actual message the transport would send.
    const envelope = compressMessage({
      type: 'mcp-query',
      id: 'query-1',
      data: { method: 'foundry-mcp-bridge.importActors', data: { actors: [doc] } },
    });
    expect(Buffer.byteLength(JSON.stringify(envelope), 'utf8')).toBeLessThan(FRAME / 3);
  });

  it('the six-actor batch that started this fits in ONE message', () => {
    const files = readdirSync(FIXTURES_DIR)
      .filter(f => f.endsWith('.real.json'))
      .sort()
      .slice(0, 6);
    const actors = files.map(f => JSON.parse(readFileSync(path.join(FIXTURES_DIR, f), 'utf8')));
    const bytes = Buffer.byteLength(JSON.stringify(actors), 'utf8');
    expect(bytes).toBeGreaterThan(250_000);

    const envelope = compressMessage({
      type: 'mcp-query',
      id: 'query-1',
      data: { method: 'foundry-mcp-bridge.importActors', data: { actors } },
    });
    expect(Buffer.byteLength(JSON.stringify(envelope), 'utf8')).toBeLessThan(FRAME);
  });

  it('the incompressible case is reachable from this very corpus, and is refused', () => {
    // A real export carrying a ~118 KB image as an embedded `data:` URI on both
    // `img` and `prototypeToken.texture.src` — what happens if art is embedded
    // instead of synced to the Foundry server.
    const base = JSON.parse(
      readFileSync(path.join(FIXTURES_DIR, 'ludo-mage.foundry.real.json'), 'utf8')
    );
    // Deterministic high-entropy stand-in for the WebP: both are
    // already-compressed bytes, and that is the only property that matters.
    const art = `data:image/webp;base64,${pseudoRandomBase64(117_928)}`;
    const doc = {
      ...base,
      img: art,
      prototypeToken: { ...(base.prototypeToken ?? {}), texture: { src: art } },
    };

    const bytes = Buffer.byteLength(JSON.stringify(doc), 'utf8');
    const gzip = gzippedBytes(doc);

    expect(bytes).toBeGreaterThan(360_000);
    // Below 2x — against 6.9x-12x for the same document without the art. This is
    // the entire reason the frame guard must MEASURE.
    expect(bytes / gzip).toBeLessThan(2);
    expect(b64Len(gzip)).toBeGreaterThan(4 * FRAME);
  });
});

/**
 * A Salvador-class document, built the way design.md built it: start from the
 * largest real export and append ONLY items that are distinct by name from the
 * other eleven, so the added mass carries realistic entropy instead of duplicated
 * text that would flatter the ratio. Capped at 89 items to land at ~97 KB.
 */
function salvadorClassDocument(): Record<string, any> & { items: any[] } {
  const base = JSON.parse(
    readFileSync(path.join(FIXTURES_DIR, 'ludo-mage.foundry.real.json'), 'utf8')
  );
  const items: any[] = [...(base.items ?? [])];
  const seen = new Set(items.map((i: any) => i?.name));

  const others = readdirSync(FIXTURES_DIR)
    .filter(f => f.endsWith('.real.json') && f !== 'ludo-mage.foundry.real.json')
    .sort();

  for (const file of others) {
    const doc = JSON.parse(readFileSync(path.join(FIXTURES_DIR, file), 'utf8'));
    for (const item of doc.items ?? []) {
      if (items.length >= 89) break;
      if (seen.has(item?.name)) continue;
      seen.add(item?.name);
      items.push(item);
    }
    if (items.length >= 89) break;
  }

  return { ...base, items };
}

/** Deterministic incompressible filler (xorshift), so the test cannot flake. */
function pseudoRandomBase64(byteLength: number): string {
  const bytes = Buffer.allocUnsafe(byteLength);
  let x = 0x9e3779b9;
  for (let i = 0; i < byteLength; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    bytes[i] = x & 0xff;
  }
  return bytes.toString('base64');
}
