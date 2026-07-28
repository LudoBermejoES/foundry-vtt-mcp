/**
 * ADVERSARIAL tests for the staged-archive intake.
 *
 * Sibling of `import-path.test.ts` and written to the same standard: the happy
 * path is a handful of tests and everything else is an attack. Several assert the
 * stronger property that nothing was WRITTEN — "it returned an error" is not the
 * same as "it did not extract the entry", and only the latter is what the
 * requirement asks for.
 *
 * Every archive here is constructed byte by byte (`__fixtures__/zip-writer.ts`),
 * because most of them are archives no honest producer emits. The measurements
 * against the REAL corpus and the real producers (`zip -r`, Finder's `ditto`) are
 * in `import-archive.corpus.test.ts`, which needs the sibling wod20-char checkout;
 * everything here always runs.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { promises as fs } from 'fs';
import * as fsSync from 'fs';
import fsDefault from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readArchiveBuffer, readActorArchive, ImportArchiveError } from './import-archive.js';
import { ImportPathError } from './import-path.js';
import { WOD_ARCHIVE_LIMITS } from '../../config.js';
import { buildZip, appleDoubleSidecar } from './__fixtures__/zip-writer.js';

const doc = (name: string, sourceId?: string) =>
  JSON.stringify({
    name,
    type: 'mortal',
    system: { willpower: 5 },
    ...(sourceId !== undefined ? { flags: { wodchar: { sourceId } } } : {}),
  });

/** Default reader limits: the archive FILE gate doubles as the per-entry gate. */
const limits = { maxEntryBytes: 2_097_152 };

/**
 * Runs `fn` and asserts NOTHING WAS WRITTEN — two independent ways, because a test
 * that only checks the refusal cannot prove the entry was not extracted, and that
 * is the property the requirement actually asks for.
 *
 *   1. Every filesystem WRITE primitive is spied. Reads are deliberately not: the
 *      reader must read the archive.
 *   2. The whole temp tree is snapshotted before and after. This is the half that
 *      cannot be fooled: a spy on `fs.writeFileSync` only catches a caller that
 *      reached it through the module object, whereas a directory diff catches a
 *      write however it was made. `os.tmpdir()` is where an extractor would most
 *      plausibly put things, and where this file's own sandbox lives.
 */
async function expectNoWrites<T>(fn: () => T | Promise<T>): Promise<unknown> {
  const spies = [
    vi.spyOn(fs, 'writeFile'),
    vi.spyOn(fs, 'appendFile'),
    vi.spyOn(fs, 'mkdir'),
    vi.spyOn(fs, 'open'),
    vi.spyOn(fs, 'rename'),
    vi.spyOn(fs, 'copyFile'),
    vi.spyOn(fsDefault, 'writeFileSync'),
    vi.spyOn(fsDefault, 'appendFileSync'),
    vi.spyOn(fsDefault, 'mkdirSync'),
    vi.spyOn(fsDefault, 'openSync'),
    vi.spyOn(fsDefault, 'createWriteStream'),
  ];
  const before = treeOf(os.tmpdir());
  try {
    // `fn` may throw synchronously (the reader is sync) or reject; both are the
    // outcome under test, so both are returned rather than propagated.
    try {
      return await fn();
    } catch (error) {
      return error;
    }
  } finally {
    for (const spy of spies) {
      expect(spy.mock.calls.length, 'the archive reader must never write').toBe(0);
      spy.mockRestore();
    }
    expect(treeOf(os.tmpdir()), 'no entry may be extracted to disk').toEqual(before);
  }
}

/** Shallow listing of a directory; `[]` if it cannot be read. */
function treeOf(dir: string): string[] {
  try {
    return fsSync.readdirSync(dir).sort();
  } catch {
    return [];
  }
}

describe('an archive of actor documents is read (happy path)', () => {
  it('yields one document per .json entry, in archive order', () => {
    const zip = buildZip([
      { name: 'actors/', data: '' },
      { name: 'actors/a.json', data: doc('Ana', 'src-a') },
      { name: 'actors/b.json', data: doc('Beto', 'src-b') },
    ]);
    const contents = readArchiveBuffer(zip, 'cast.zip', limits);

    expect(contents.documents.map(d => d.entry)).toEqual(['actors/a.json', 'actors/b.json']);
    expect((contents.documents[0]?.value as { name: string }).name).toBe('Ana');
    expect(contents.counts).toEqual({ entries: 3, documents: 2, ignored: 1, refused: 0 });
    expect(contents.counts.entries).toBe(
      contents.counts.documents + contents.counts.ignored + contents.counts.refused
    );
  });

  it('reads sizes from the CENTRAL DIRECTORY, so a streaming producer works unchanged', () => {
    // A producer that streams (general-purpose bit 3) leaves the local header's
    // sizes zeroed and writes them in a trailing data descriptor. The central
    // directory always carries the true values, so this needs no special case.
    const zip = buildZip([{ name: 'a.json', data: doc('Ana', 'src-a'), streaming: true }]);
    const contents = readArchiveBuffer(zip, 'streamed.zip', limits);
    expect(contents.documents.length).toBe(1);
    expect(contents.documents[0]?.bytes).toBe(Buffer.byteLength(doc('Ana', 'src-a')));
  });

  it('supports method 0 (stored) as well as method 8 (deflate)', () => {
    const zip = buildZip([
      { name: 'stored.json', data: doc('Stored', 's'), method: 0 },
      { name: 'deflated.json', data: doc('Deflated', 'd'), method: 8 },
    ]);
    const contents = readArchiveBuffer(zip, 'both.zip', limits);
    expect(contents.documents.map(d => (d.value as { name: string }).name)).toEqual([
      'Stored',
      'Deflated',
    ]);
  });

  it('measures expansion rather than trusting the declaration', () => {
    const body = doc('Ana', 'src-a');
    const zip = buildZip([{ name: 'a.json', data: body, declaredUncompressedSize: 9 }]);
    const contents = readArchiveBuffer(zip, 'a.zip', limits);
    expect(contents.declaredUncompressedBytes).toBe(9);
    expect(contents.measuredUncompressedBytes).toBe(Buffer.byteLength(body));
  });
});

describe('non-document entries are ignored and reported, never fatal', () => {
  it('ignores directories, __MACOSX sidecars, ._ basenames, .DS_Store and non-.json names', () => {
    const zip = buildZip([
      { name: 'actors/', data: '' },
      { name: 'actors/real.json', data: doc('Real', 'src') },
      { name: '__MACOSX/', data: '' },
      { name: '__MACOSX/actors/._real.json', data: appleDoubleSidecar() },
      { name: 'actors/._stray.json', data: appleDoubleSidecar(163) },
      { name: 'actors/.DS_Store', data: Buffer.from([0, 1, 2, 3]) },
      { name: 'actors/notes.txt', data: 'hello' },
      { name: 'actors/portrait.webp', data: Buffer.from([0x52, 0x49, 0x46, 0x46]) },
    ]);
    const contents = readArchiveBuffer(zip, 'finderish.zip', limits);

    expect(contents.documents.map(d => d.entry)).toEqual(['actors/real.json']);
    expect(contents.counts).toEqual({ entries: 8, documents: 1, ignored: 7, refused: 0 });

    // Ignoring is not discarding: every ignored entry carries the reason, so an
    // operator whose documents were all misnamed learns that from the report
    // instead of from an empty import.
    const reasons = new Map(contents.entries.map(e => [e.name, e.reason]));
    expect(reasons.get('actors/')).toMatch(/directory/i);
    expect(reasons.get('__MACOSX/actors/._real.json')).toMatch(/__MACOSX/);
    expect(reasons.get('actors/._stray.json')).toMatch(/AppleDouble|\._/);
    expect(reasons.get('actors/notes.txt')).toMatch(/\.json/);
    expect(reasons.get('actors/portrait.webp')).toMatch(/\.json/);
    for (const entry of contents.entries) {
      if (entry.classification === 'ignored') expect(entry.reason).toBeTruthy();
    }
  });

  it('THE REGRESSION TEST: an extension-only filter would break this archive', () => {
    // 24 of 24 file entries in a Finder archive end in `.json`, and 12 of them are
    // AppleDouble binaries whose parse fails. If the `__MACOSX/` and `._` name
    // tests are ever refactored away and only the extension test survives, this
    // archive stops importing and starts reporting "invalid JSON".
    const zip = buildZip([
      { name: 'actors/real.json', data: doc('Real', 'src') },
      { name: '__MACOSX/actors/._real.json', data: appleDoubleSidecar() },
    ]);
    const sidecar = appleDoubleSidecar();
    expect(sidecar.readUInt32BE(0)).toBe(0x00051607); // AppleDouble magic
    expect(() => JSON.parse(sidecar.toString('utf8'))).toThrow();

    const contents = readArchiveBuffer(zip, 'finderish.zip', limits);
    expect(contents.documents.length).toBe(1);
    expect(contents.counts.refused).toBe(0);
  });
});

describe('an archive with no documents and an unreadable archive are different failures', () => {
  it('reports "no actor documents" for a readable archive carrying none', () => {
    const zip = buildZip([{ name: 'notes.txt', data: 'hello' }]);
    const err = (() => {
      try {
        readArchiveBuffer(zip, 'empty.zip', limits);
      } catch (e) {
        return e as ImportArchiveError;
      }
      return undefined;
    })();
    expect(err).toBeInstanceOf(ImportArchiveError);
    expect(err?.reason).toBe('no actor documents found');
    // The inventory survives the refusal, so the operator can see WHY there were
    // none — which is the difference between this and "unreadable".
    expect(err?.inventory?.length).toBe(1);
  });

  it('reports "not a readable archive" for bytes that are not a ZIP at all', () => {
    const err = (() => {
      try {
        readArchiveBuffer(Buffer.from('this is not a zip file'), 'junk.zip', limits);
      } catch (e) {
        return e as ImportArchiveError;
      }
      return undefined;
    })();
    expect(err?.reason).toBe('not a readable archive');
    expect(err?.inventory).toBeUndefined();
  });
});

describe('zip slip: entry names are validated and never become paths', () => {
  const hostile = [
    ['traversal', '../../../../etc/pwned.json'],
    ['absolute posix', '/abs/pwned.json'],
    ['absolute windows', 'C:\\Windows\\pwned.json'],
    ['backslash separator', '..\\..\\pwned.json'],
    ['NUL byte', 'ok.json\u0000/../pwned.json'],
    ['bare parent segment', 'actors/../../pwned.json'],
  ] as const;

  for (const [label, name] of hostile) {
    it(`refuses ${label} without writing anything`, async () => {
      const zip = buildZip([
        { name, data: doc('Pwned') },
        { name: 'ok.json', data: doc('Ok', 's') },
      ]);
      const err = (await expectNoWrites(() =>
        readArchiveBuffer(zip, 'slip.zip', limits)
      )) as ImportArchiveError;
      expect(err).toBeInstanceOf(ImportArchiveError);
      expect(err.reason).toBe('unsafe entry name');
    });
  }

  it('refuses the WHOLE archive, never importing the entries that passed', () => {
    const zip = buildZip([
      { name: 'good-1.json', data: doc('One', 's1') },
      { name: '../../../../etc/pwned.json', data: doc('Pwned') },
      { name: 'good-2.json', data: doc('Two', 's2') },
    ]);
    expect(() => readArchiveBuffer(zip, 'slip.zip', limits)).toThrow(ImportArchiveError);
  });

  it('nothing is extracted even on the happy path', async () => {
    const zip = buildZip([{ name: 'a.json', data: doc('Ana', 's') }]);
    const contents = (await expectNoWrites(() => readArchiveBuffer(zip, 'a.zip', limits))) as {
      documents: unknown[];
    };
    expect(contents.documents.length).toBe(1);
  });
});

describe('expansion is bounded, and the bound is enforced on MEASURED output', () => {
  /** design.md §2d's bomb: one entry declaring 100 MiB. */
  const bombDeclared = 104_857_600;

  it('refuses on the DECLARED size without inflating the entry', async () => {
    // The body is deliberately NOT a valid deflate stream. If the reader inflated
    // before checking the declaration, it would fail with a zlib error; the fact
    // that the reason is the BOUND is the proof that the defence is "do not do the
    // work", not "recover from it".
    const zip = buildZip([
      {
        name: 'bomb.json',
        data: '',
        method: 8,
        rawBody: Buffer.alloc(1024, 0xff),
        declaredUncompressedSize: bombDeclared,
      },
    ]);
    const err = (await expectNoWrites(() =>
      readArchiveBuffer(zip, 'bomb.zip', limits)
    )) as ImportArchiveError;

    expect(err).toBeInstanceOf(ImportArchiveError);
    expect(err.reason).toBe('entry expands beyond the per-entry bound');
    // The error names the bound exceeded, in our own numbers — never file contents.
    expect(err.message).toContain(String(limits.maxEntryBytes));
    expect(err.message).not.toMatch(/Z_DATA_ERROR|incorrect header check/);
    // Ratio, which is the property that makes it a bomb: 1,027x here.
    expect(bombDeclared / zip.byteLength).toBeGreaterThan(1000);
  });

  it('refuses on the declared TOTAL when no single entry breaches the per-entry bound', () => {
    // Ten entries each declaring 1 MiB: every one passes the per-entry gate, and
    // the sum is what the archive's own file size can never reveal.
    const entries = Array.from({ length: 10 }, (_, i) => ({
      name: `e${i}.json`,
      data: '{}',
      declaredUncompressedSize: 1_048_576,
    }));
    const err = (() => {
      try {
        readArchiveBuffer(buildZip(entries), 'many.zip', {
          maxEntryBytes: 2_097_152,
          maxTotalUncompressedBytes: 4_194_304,
        });
      } catch (e) {
        return e as ImportArchiveError;
      }
      return undefined;
    })();
    expect(err?.reason).toBe('archive expands beyond the total bound');
    expect(err?.message).toContain('4194304');
  });

  it('and refuses the SAME payload a second time when the declaration lies', () => {
    // Defeating the pre-filter is trivial — a ZIP central directory is
    // attacker-controlled data, so an attacker simply declares a small size. The
    // measured bound is what actually holds, and it must not be derived from the
    // declaration: `zlib.inflateRawSync(…, { maxOutputLength })` aborts with
    // ERR_BUFFER_TOO_LARGE. Neither defence alone is sufficient; both are cheap.
    const fat = 'a'.repeat(3 * 1024 * 1024);
    const zip = buildZip([
      { name: 'liar.json', data: JSON.stringify({ pad: fat }), declaredUncompressedSize: 512 },
    ]);
    expect(zip.byteLength).toBeLessThan(64 * 1024); // a small file, honestly small

    const err = (() => {
      try {
        readArchiveBuffer(zip, 'liar.zip', { maxEntryBytes: 1_048_576 });
      } catch (e) {
        return e as ImportArchiveError;
      }
      return undefined;
    })();
    expect(err?.reason).toBe('entry expands beyond the per-entry bound');
    expect(err?.message).toContain('1048576');
    // Reported against the MEASURED bound, not the 512 bytes it claimed.
    expect(err?.message).not.toContain('512');
  });

  it('bounds the raw entry count against an entry-count bomb', () => {
    const entries = Array.from({ length: 40 }, (_, i) => ({ name: `e${i}.json`, data: '{}' }));
    const err = (() => {
      try {
        readArchiveBuffer(buildZip(entries), 'swarm.zip', { maxEntryBytes: 1024, maxEntries: 8 });
      } catch (e) {
        return e as ImportArchiveError;
      }
      return undefined;
    })();
    expect(err?.reason).toBe('too many entries');
    expect(err?.message).toContain('8');
  });

  it('the raw-entry bound is set well above what real producers emit', () => {
    // macOS "Compress" multiplies entries by ~2.25x (27 for 12 documents), so the
    // parse bound must never bind before the document cap does.
    expect(WOD_ARCHIVE_LIMITS.MAX_RAW_ENTRIES).toBeGreaterThan(
      WOD_ARCHIVE_LIMITS.MAX_DOCUMENTS * 3
    );
    // The document cap is the SAME number, for the same reason, as `actorPaths`.
    expect(WOD_ARCHIVE_LIMITS.MAX_DOCUMENTS).toBe(50);
  });
});

describe('entries the reader must not read are refused by name and reason', () => {
  it('refuses an encrypted entry on general-purpose bit 0, with a real reason', () => {
    // Without checking the flag, inflation fails with Z_DATA_ERROR — safe by
    // accident, with a useless reason.
    const zip = buildZip([{ name: 'secret.json', data: doc('Secret', 's'), flags: 0x0001 }]);
    const err = (() => {
      try {
        readArchiveBuffer(zip, 'encrypted.zip', limits);
      } catch (e) {
        return e as ImportArchiveError;
      }
      return undefined;
    })();
    expect(err?.reason).toBe('encrypted entry');
    expect(err?.entry).toBe('secret.json');
    expect(err?.message).not.toMatch(/Z_DATA_ERROR|incorrect header check/);
  });

  it('refuses an unsupported compression method by number', () => {
    const zip = buildZip([{ name: 'bz.json', data: doc('Bzip', 's'), method: 12 }]);
    const err = (() => {
      try {
        readArchiveBuffer(zip, 'bzip2.zip', limits);
      } catch (e) {
        return e as ImportArchiveError;
      }
      return undefined;
    })();
    expect(err?.reason).toBe('unsupported compression method');
    expect(err?.message).toContain('12');
  });

  it('refuses ZIP64', () => {
    for (const overrides of [{ totalEntries: 0xffff }, { centralDirectoryOffset: 0xffffffff }]) {
      const zip = buildZip([{ name: 'a.json', data: doc('Ana', 's') }], overrides);
      const err = (() => {
        try {
          readArchiveBuffer(zip, 'big.zip', limits);
        } catch (e) {
          return e as ImportArchiveError;
        }
        return undefined;
      })();
      expect(err?.reason).toBe('ZIP64 is not supported');
    }
  });

  it('refuses a .json entry whose content is not JSON, without echoing the parser message', () => {
    const zip = buildZip([{ name: 'broken.json', data: '{ not json' }]);
    const err = (() => {
      try {
        readArchiveBuffer(zip, 'broken.zip', limits);
      } catch (e) {
        return e as ImportArchiveError;
      }
      return undefined;
    })();
    expect(err?.reason).toBe('invalid JSON in entry');
    expect(err?.entry).toBe('broken.json');
    expect(err?.message).not.toContain('not json');
  });

  it('finds the end-of-central-directory record behind a trailing comment', () => {
    const zip = buildZip([{ name: 'a.json', data: doc('Ana', 's') }], { comment: 'x'.repeat(300) });
    expect(readArchiveBuffer(zip, 'commented.zip', limits).documents.length).toBe(1);
  });
});

describe('error hygiene', () => {
  it('sanitises and truncates an echoed entry name', () => {
    // Entry names ARE echoed — a report that says "entry 17 of 27 was ignored" is
    // unusable — but they are file content, so they are sanitised the way a
    // requested path is: control characters stripped, truncated to a fixed length.
    const nasty = `a${'\u0007\u001b'}${'b'.repeat(400)}.json`;
    const zip = buildZip([{ name: nasty, data: '{ not json' }]);
    const err = (() => {
      try {
        readArchiveBuffer(zip, 'nasty.zip', limits);
      } catch (e) {
        return e as ImportArchiveError;
      }
      return undefined;
    })();
    expect(err?.entry).toBeDefined();
    expect(err?.entry?.length).toBeLessThanOrEqual(121);
    // eslint-disable-next-line no-control-regex -- asserting control chars are GONE
    expect(err?.entry).not.toMatch(/[\u0000-\u001f\u007f]/);
  });

  it('sanitises names in the inventory too, not only in errors', () => {
    const zip = buildZip([
      { name: 'good.json', data: doc('Ana', 's') },
      { name: `note\u0007s.txt`, data: 'x' },
    ]);
    const contents = readArchiveBuffer(zip, 'mixed.zip', limits);
    for (const entry of contents.entries) {
      // eslint-disable-next-line no-control-regex -- asserting control chars are GONE
      expect(entry.name).not.toMatch(/[\u0000-\u001f\u007f]/);
    }
  });
});

describe('the archive path is resolved by the SAME rules as a staged document', () => {
  let sandbox: string;
  let importDir: string;
  let outsideDir: string;

  beforeAll(async () => {
    sandbox = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wod-archive-')));
    importDir = path.join(sandbox, 'wod20-import');
    outsideDir = path.join(sandbox, 'outside');
    await fs.mkdir(importDir);
    await fs.mkdir(outsideDir);

    const zip = buildZip([
      { name: 'a.json', data: doc('Ana', 'src-a') },
      { name: 'b.json', data: doc('Beto', 'src-b') },
    ]);
    await fs.writeFile(path.join(importDir, 'cast.zip'), zip);
    await fs.writeFile(path.join(outsideDir, 'secret.zip'), zip);
    await fs.writeFile(path.join(importDir, 'doc.json'), doc('Inline', 's'));
    fsSync.symlinkSync(path.join(outsideDir, 'secret.zip'), path.join(importDir, 'escape.zip'));
  });

  afterAll(async () => {
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  const opts = () => ({ importDir, maxBytes: 2_097_152 });

  it('reads an archive staged inside the allow-listed directory', async () => {
    const contents = await readActorArchive('cast.zip', opts());
    expect(contents.documents.map(d => d.entry)).toEqual(['a.json', 'b.json']);
    expect(contents.archiveBytes).toBeGreaterThan(0);
  });

  it('refuses every archive when importDir is unset — no implicit default root', async () => {
    const err = (await readActorArchive('cast.zip', {
      importDir: undefined,
      maxBytes: 2_097_152,
    }).catch(e => e)) as ImportPathError;
    expect(err.reason).toBe('path intake disabled (wod.importDir is not configured)');
  });

  it('refuses a non-.zip path — the extension check is PARAMETERISED, not duplicated', async () => {
    const err = (await readActorArchive('doc.json', opts()).catch(e => e)) as ImportPathError;
    expect(err.reason).toBe('must be a .zip file');
  });

  it('refuses traversal and symlink escape with the same reason a document path gets', async () => {
    for (const attempt of ['../outside/secret.zip', 'escape.zip']) {
      const err = (await readActorArchive(attempt, opts()).catch(e => e)) as ImportPathError;
      expect(err.reason, attempt).toBe('outside importDir');
    }
  });

  it('gates the archive FILE by importMaxBytes', async () => {
    const err = (await readActorArchive('cast.zip', { importDir, maxBytes: 8 }).catch(
      e => e
    )) as ImportPathError;
    expect(err.reason).toBe('too large');
  });

  it('never leaks the resolved absolute path', async () => {
    for (const attempt of ['../outside/secret.zip', 'escape.zip', 'doc.json', 'nope.zip']) {
      const err = (await readActorArchive(attempt, opts()).catch(e => e)) as ImportPathError;
      expect(err.message.replace(attempt, '')).not.toContain(sandbox);
    }
  });
});
