/**
 * The archive measurements that decide the design, asserted against the REAL WoD
 * corpus and against the real archive producers.
 *
 * Each figure here justifies a design decision that would otherwise look
 * arbitrary, so each one must fail loudly if it stops holding
 * (`openspec/changes/import-actor-batch-from-archive/tasks.md` §1):
 *
 *   §1.1  the four packings, and how little ZIP costs over `.tar.gz`
 *   §1.2  the macOS trap — the measurement that decides how unknown entries are
 *         treated, and the reason an extension-only filter is a broken feature
 *   §1.3  the 50-document numbers, which justify INHERITING the document cap
 *   §1.5  provenance: a fresh export carries none, which is why §5's gate exists
 *
 * WHERE THE CORPUS LIVES, AND WHY THAT IS AWKWARD. Same constraint as
 * `src/wire-format.corpus.test.ts`, for the same reason: `foundry-vtt-mcp` is a
 * standalone repository, the exports are real players' characters and cannot be
 * vendored here, and a fresh clone has no sibling `wod20-char`. So this block skips
 * loudly outside the mago20 monorepo and runs in full inside it, which is the only
 * place the measurements can be kept honest. Override with `WOD_FIXTURES_DIR`.
 *
 * The archives are BUILT at test time, never committed: a checked-in zip is opaque
 * to review and cannot be regenerated when a fixture changes (§1.1). Every
 * *behavioural* guarantee — the classifier, the bounds, the hostile archives — is
 * in `import-archive.test.ts`, which always runs.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { fileURLToPath } from 'url';
import * as os from 'os';
import * as path from 'path';
import { readArchiveBuffer } from './import-archive.js';
import { chunkDocsByBytes, chunkTimeoutMs, payloadBytes } from './import-chunking.js';
import { WOD_ARCHIVE_LIMITS } from '../../config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// packages/mcp-server/src/tools/worldofdarkness -> foundry-vtt-mcp -> the mago20
// monorepo that holds this repo as a submodule alongside wod20-char.
const monorepo = path.resolve(here, '../../../../../..');
const FIXTURES_DIR =
  process.env.WOD_FIXTURES_DIR ?? path.join(monorepo, 'wod20-char/web/tests/fixtures/foundry');

const corpusPresent = existsSync(FIXTURES_DIR);
if (!corpusPresent) {
  // eslint-disable-next-line no-console
  console.warn(
    `[import-archive.corpus] SKIPPED: the WoD corpus is not checked out here.\n` +
      `  expected exports at ${FIXTURES_DIR}\n` +
      `  These live in the sibling wod20-char submodule of the mago20 monorepo and are real\n` +
      `  player data, so they are not vendored into this repository. Inside the monorepo this\n` +
      `  block runs and pins every archive measurement the design rests on.`
  );
}

/** `ditto` is macOS-only; it is what Finder's "Compress" actually runs. */
const dittoAvailable = process.platform === 'darwin';
if (corpusPresent && !dittoAvailable) {
  // eslint-disable-next-line no-console
  console.warn(
    `[import-archive.corpus] the Finder/ditto packing is SKIPPED: this runner is ` +
      `${process.platform}, and \`ditto -c -k --sequesterRsrc --keepParent\` exists only on macOS. ` +
      `The CLASSIFIER half of that measurement is asserted byte-for-byte in ` +
      `import-archive.test.ts, which always runs.`
  );
}

const limits = { maxEntryBytes: 2_097_152 };

let sandbox: string;
let plainZip: Buffer;
let fixtureNames: string[];

beforeAll(() => {
  if (!corpusPresent) return;
  sandbox = path.join(os.tmpdir(), `wod-archive-corpus-${process.pid}`);
  const actors = path.join(sandbox, 'actors');
  mkdirSync(actors, { recursive: true });

  fixtureNames = readdirSync(FIXTURES_DIR)
    .filter(f => f.endsWith('.real.json'))
    .sort();
  for (const name of fixtureNames) {
    writeFileSync(path.join(actors, name), readFileSync(path.join(FIXTURES_DIR, name)));
  }

  execFileSync('zip', ['-q', '-r', 'plain.zip', 'actors'], { cwd: sandbox });
  plainZip = readFileSync(path.join(sandbox, 'plain.zip'));
});

afterAll(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

describe.skipIf(!corpusPresent)('the WoD archive corpus', () => {
  it('§1.1 the 12 committed real exports, packed four ways', () => {
    expect(fixtureNames.length).toBe(12);

    const raw = fixtureNames.reduce(
      (n, f) => n + readFileSync(path.join(FIXTURES_DIR, f)).byteLength,
      0
    );
    const minified = fixtureNames.reduce(
      (n, f) => n + payloadBytes(JSON.parse(readFileSync(path.join(FIXTURES_DIR, f), 'utf8'))),
      0
    );

    // Exact, and both reproduce design.md §2a on the nose.
    expect(raw).toBe(847_872);
    expect(minified).toBe(548_883);

    // `zip -r` (deflate). Exact: the entry names are the fixture names, so there
    // is nothing here that varies between runs.
    expect(plainZip.byteLength).toBe(70_701);

    // `tar czf` for comparison only — the format was REJECTED (design.md §3), and
    // this assertion exists so the size argument for it stays honest rather than
    // remaining a claim: ZIP is a few per cent LARGER, and that is the whole of
    // tar's size advantage.
    //
    // Only the direction and the order of magnitude are asserted, not a figure.
    // A `.tar.gz` embeds each member's mtime, uid and gid in its 512-byte headers,
    // so its compressed size moves with how the files were staged; design.md §2a
    // measured 72,219 B (ZIP +2.1%) against 67,x00 B here (ZIP +5%). Whichever it
    // is, it is noise at this scale, which is the point.
    execFileSync('tar', ['czf', 'plain.tar.gz', 'actors'], { cwd: sandbox });
    const targz = readFileSync(path.join(sandbox, 'plain.tar.gz')).byteLength;
    expect(plainZip.byteLength / targz).toBeGreaterThan(1);
    expect(plainZip.byteLength / targz).toBeLessThan(1.1);

    // And the reader gets all twelve out of the `zip -r` archive.
    const contents = readArchiveBuffer(plainZip, 'plain.zip', limits);
    expect(contents.documents.length).toBe(12);
    expect(contents.counts.documents).toBe(12);
  });

  it.skipIf(!dittoAvailable)(
    '§1.2 the macOS trap: 27 entries for 12 documents, and all 24 file entries end in .json',
    () => {
      execFileSync(
        'ditto',
        ['-c', '-k', '--sequesterRsrc', '--keepParent', 'actors', 'finder.zip'],
        { cwd: sandbox }
      );
      const finderZip = readFileSync(path.join(sandbox, 'finder.zip'));
      const contents = readArchiveBuffer(finderZip, 'finder.zip', limits);

      // The inventory, exactly as design.md §2c measured it.
      expect(contents.counts.entries).toBe(27);
      const dirs = contents.entries.filter(e => e.name.endsWith('/'));
      const files = contents.entries.filter(e => !e.name.endsWith('/'));
      expect(dirs.length).toBe(3);
      expect(files.length).toBe(24);

      // THE FINDING: every one of the 24 file entries ends in `.json`. An
      // extension filter is therefore not sufficient — it classifies 12 binary
      // AppleDouble sidecars as actor documents and turns every Finder-produced
      // archive into an "invalid JSON" error.
      expect(files.filter(e => e.name.toLowerCase().endsWith('.json')).length).toBe(24);

      const sidecars = files.filter(e => e.name.startsWith('__MACOSX/'));
      expect(sidecars.length).toBe(12);
      for (const sidecar of sidecars) {
        expect(sidecar.classification).toBe('ignored');
        expect(sidecar.name).toMatch(/__MACOSX\/actors\/\._.*\.real\.json$/);
      }

      // And exactly the twelve real documents are recognised.
      expect(contents.documents.length).toBe(12);
      expect(contents.counts.ignored).toBe(15); // 3 directories + 12 sidecars
      expect(contents.counts.refused).toBe(0);
      expect(contents.counts.entries).toBe(
        contents.counts.documents + contents.counts.ignored + contents.counts.refused
      );

      // The sidecars are tiny, and how tiny is NOT a property of the design:
      // `--sequesterRsrc` writes whatever extended attributes the source file
      // carries, so the same fixture yields a 471-byte sidecar out of a working
      // checkout (design.md §2c) and a 163-byte one when staged freshly, as here.
      // The load-bearing half — the AppleDouble magic and that `JSON.parse` fails
      // — is pinned byte-for-byte in import-archive.test.ts, which always runs.
      for (const sidecar of sidecars) {
        expect(sidecar.declaredBytes, sidecar.name).toBeGreaterThan(0);
        expect(sidecar.declaredBytes, sidecar.name).toBeLessThan(1024);
      }

      // Finder multiplies entries by 2.25x here, which is why the raw-entry bound
      // is a SEPARATE bound from the document cap: a single 50-ENTRY cap would let
      // a Finder archive carry only ~22 actors while a `zip -r` archive carried 50.
      expect(contents.counts.entries / contents.counts.documents).toBeCloseTo(2.25, 2);
      // …and why MAX_RAW_ENTRIES is set well above it.
      expect(WOD_ARCHIVE_LIMITS.MAX_RAW_ENTRIES).toBeGreaterThan(
        WOD_ARCHIVE_LIMITS.MAX_DOCUMENTS * 2.25
      );
    }
  );

  it('§1.3 fifty documents: the file gate passes, and nothing else bounds the expansion', () => {
    // Built by cycling the sorted twelve, which is how design.md §2b built it.
    const fiftyDir = path.join(sandbox, 'fifty');
    mkdirSync(fiftyDir, { recursive: true });
    let declaredTotal = 0;
    for (let i = 0; i < 50; i++) {
      const source = fixtureNames[i % 12];
      const bytes = readFileSync(path.join(FIXTURES_DIR, source));
      declaredTotal += bytes.byteLength;
      writeFileSync(path.join(fiftyDir, `${String(i).padStart(2, '0')}.json`), bytes);
    }
    execFileSync('zip', ['-q', '-j', '-r', '../fifty.zip', '.'], { cwd: fiftyDir });
    const fiftyZip = readFileSync(path.join(sandbox, 'fifty.zip'));

    // Exact, and name-independent: the sum of the twelve raw fixtures cycled to 50.
    expect(declaredTotal).toBe(3_529_028);

    const contents = readArchiveBuffer(fiftyZip, 'fifty.zip', limits);
    expect(contents.documents.length).toBe(50);
    expect(contents.declaredUncompressedBytes).toBe(3_529_028);

    // THE FINDING. The archive FILE sails through the staged-file size gate — an
    // archive's whole point is that the file is small — while carrying 3.5 MB of
    // documents. So a TOTAL uncompressed bound is not belt-and-braces: it is the
    // only bound in that dimension.
    const importMaxBytes = 2_097_152;
    expect(fiftyZip.byteLength).toBeLessThan(importMaxBytes);
    expect(importMaxBytes / fiftyZip.byteLength).toBeGreaterThan(7);
    expect(contents.declaredUncompressedBytes / importMaxBytes).toBeGreaterThan(1.68);

    // THE OTHER FINDING, and the reason the document cap is inherited rather than
    // raised: 50 documents is ~50 SEQUENTIAL bridge queries, each with its own
    // deadline, and `chunkTimeoutMs` caps each query at 600,000 ms while nothing
    // caps their sum.
    const docs = contents.documents.map(d => d.value);
    const chunks = chunkDocsByBytes(docs, 51_200);
    expect(chunks.length).toBe(50);
    const summed = chunks.reduce((n, c) => n + chunkTimeoutMs(c, 10_000, 51_200), 0);
    expect(summed).toBe(580_000); // ~9.7 minutes inside ONE tool call
    expect(summed).toBeGreaterThan(500_000);

    // The document count is exactly the cap, so an archive one document larger is
    // the refusal §3.3 owes the caller.
    expect(contents.documents.length).toBe(WOD_ARCHIVE_LIMITS.MAX_DOCUMENTS);
  });

  it('§1.5 a fresh export carries NO provenance and a placeholder portrait', () => {
    const contents = readArchiveBuffer(plainZip, 'plain.zip', limits);
    const werewolf = contents.documents.find(d => d.entry.endsWith('werewolf-pc-export.real.json'));
    expect(werewolf).toBeDefined();
    const doc = werewolf?.value as Record<string, any>;

    expect(doc.name).toBe('Hombre lobo');
    expect((doc.items as unknown[]).length).toBe(42);

    // The pair of traps `docs/foundry-import.md` warns about, measured on the
    // corpus most likely to be zipped first rather than assumed of some future
    // export. This is the whole evidence base for the provenance gate: without a
    // source id a retry duplicates, and with `overwrite` that `img` is applied
    // over the live portrait.
    expect(doc.flags?.wodchar?.sourceId).toBeUndefined();
    expect(doc.sourceId).toBeUndefined();
    expect(doc.img).toBe('icons/svg/mystery-man.svg');
    expect(doc.prototypeToken?.texture?.src).toBe('icons/svg/mystery-man.svg');

    // True of ALL twelve, so the default state of an archive of fresh exports is
    // "no document can be reconciled". If the exporter ever starts emitting
    // provenance this breaks, which is correct: it would change the default.
    for (const document of contents.documents) {
      const value = document.value as Record<string, any>;
      expect(value.flags?.wodchar?.sourceId, document.entry).toBeUndefined();
      expect(value.flags?.['wod20-combat']?.sourceId, document.entry).toBeUndefined();
      expect(value.sourceId, document.entry).toBeUndefined();
      expect(value.img, document.entry).toBe('icons/svg/mystery-man.svg');
    }
  });
});
