/**
 * ADVERSARIAL tests for the allow-listed path intake.
 *
 * Requirement: "a document supplied by reference SHALL be confined to an
 * allow-listed directory ... a path escaping it — by traversal, symlink, or
 * absolute path — SHALL be rejected WITHOUT READING THE FILE."
 *
 * The happy path is one test. Everything else here is an escape attempt, and
 * several assert the stronger property that `fs.readFile` was never called —
 * "it returned an error" is not the same as "it did not open the file", and only
 * the latter is what the requirement asks for.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { promises as fs } from 'fs';
import * as fsSync from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveImportPath, readActorDocFromPath, ImportPathError } from './import-path.js';

let sandbox: string; // realpath'd temp root
let importDir: string; // the allow-listed directory
let outsideDir: string; // a sibling the allow-list must never reach
let secretPath: string; // the file an attacker wants

const validDoc = { name: 'Staged Actor', type: 'mortal', system: { willpower: 5 } };

beforeAll(async () => {
  sandbox = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wod-import-')));
  importDir = path.join(sandbox, 'wod20-import');
  outsideDir = path.join(sandbox, 'outside');
  await fs.mkdir(importDir);
  await fs.mkdir(outsideDir);
  await fs.mkdir(path.join(importDir, 'nested'));

  secretPath = path.join(outsideDir, 'secret.json');
  await fs.writeFile(secretPath, JSON.stringify({ ssh_key: 'TOP-SECRET' }), 'utf8');

  await fs.writeFile(path.join(importDir, 'good.json'), JSON.stringify(validDoc), 'utf8');
  await fs.writeFile(path.join(importDir, 'nested', 'deep.json'), JSON.stringify(validDoc), 'utf8');
  await fs.writeFile(path.join(importDir, 'broken.json'), '{ not json', 'utf8');
  await fs.writeFile(path.join(importDir, 'notjson.txt'), 'hello', 'utf8');

  // A symlink that LIVES inside the allow-list but POINTS outside it.
  fsSync.symlinkSync(secretPath, path.join(importDir, 'escape.json'));
  // A symlinked directory inside the allow-list whose target is outside.
  fsSync.symlinkSync(outsideDir, path.join(importDir, 'escapedir'));
});

afterAll(async () => {
  await fs.rm(sandbox, { recursive: true, force: true });
});

const opts = () => ({ importDir, maxBytes: 2097152 });

/** Runs `fn` with fs.readFile/open spied, asserting neither was called. */
async function expectNoFileRead(fn: () => Promise<unknown>): Promise<unknown> {
  const readFile = vi.spyOn(fs, 'readFile');
  const open = vi.spyOn(fs, 'open');
  try {
    return await fn().then(
      v => v,
      e => e
    );
  } finally {
    expect(readFile, 'fs.readFile must not be called for a rejected path').not.toHaveBeenCalled();
    expect(open, 'fs.open must not be called for a rejected path').not.toHaveBeenCalled();
    readFile.mockRestore();
    open.mockRestore();
  }
}

describe('a staged document is imported by path (happy path)', () => {
  it('reads and parses a file inside the allow-listed directory', async () => {
    await expect(readActorDocFromPath('good.json', opts())).resolves.toEqual(validDoc);
  });

  it('accepts a nested path inside the root', async () => {
    await expect(readActorDocFromPath('nested/deep.json', opts())).resolves.toEqual(validDoc);
  });

  it('accepts an absolute path that is genuinely inside the root', async () => {
    const abs = path.join(importDir, 'good.json');
    await expect(readActorDocFromPath(abs, opts())).resolves.toEqual(validDoc);
  });
});

describe('traversal is refused without reading the file', () => {
  it('rejects ../ escaping the root', async () => {
    const err = (await expectNoFileRead(() =>
      readActorDocFromPath('../outside/secret.json', opts())
    )) as Error;
    expect(err).toBeInstanceOf(ImportPathError);
    expect((err as ImportPathError).reason).toBe('outside importDir');
  });

  it('rejects deep ../../ traversal to a real system path', async () => {
    const err = (await expectNoFileRead(() =>
      readActorDocFromPath('../../../../../../etc/hosts.json', opts())
    )) as Error;
    expect((err as ImportPathError).reason).toBe('outside importDir');
  });

  it('rejects traversal that dips into the root first', async () => {
    const err = (await expectNoFileRead(() =>
      readActorDocFromPath('nested/../../outside/secret.json', opts())
    )) as Error;
    expect((err as ImportPathError).reason).toBe('outside importDir');
  });

  it('rejects a NUL-byte truncation attempt', async () => {
    const err = (await expectNoFileRead(() =>
      readActorDocFromPath('good.json\0../../outside/secret.json', opts())
    )) as Error;
    expect((err as ImportPathError).reason).toBe('outside importDir');
  });
});

describe('symlink escape is refused without reading the file', () => {
  it('rejects a symlink inside the root pointing at a file outside it', async () => {
    const err = (await expectNoFileRead(() =>
      readActorDocFromPath('escape.json', opts())
    )) as Error;
    expect((err as ImportPathError).reason).toBe('outside importDir');
  });

  it('rejects a path through a symlinked directory whose target is outside', async () => {
    const err = (await expectNoFileRead(() =>
      readActorDocFromPath('escapedir/secret.json', opts())
    )) as Error;
    expect((err as ImportPathError).reason).toBe('outside importDir');
  });
});

describe('absolute paths outside the root are refused without reading the file', () => {
  it('rejects an absolute path to a sibling directory', async () => {
    const err = (await expectNoFileRead(() => readActorDocFromPath(secretPath, opts()))) as Error;
    expect((err as ImportPathError).reason).toBe('outside importDir');
  });

  it('rejects an absolute path whose prefix merely LOOKS like the root', async () => {
    // `${importDir}-evil` shares importDir as a string prefix. A naive
    // `startsWith(root)` check would let this through; the separator-aware check
    // must not.
    const sneaky = `${importDir}-evil/secret.json`;
    const err = (await expectNoFileRead(() => readActorDocFromPath(sneaky, opts()))) as Error;
    expect((err as ImportPathError).reason).toBe('outside importDir');
  });
});

describe('the intake is opt-in and narrow', () => {
  it('refuses every path when importDir is unset — no implicit default root', async () => {
    const err = (await expectNoFileRead(() =>
      readActorDocFromPath('good.json', { importDir: undefined, maxBytes: 2097152 })
    )) as Error;
    expect((err as ImportPathError).reason).toBe(
      'path intake disabled (wod.importDir is not configured)'
    );
  });

  it('refuses a blank importDir', async () => {
    const err = (await expectNoFileRead(() =>
      readActorDocFromPath('good.json', { importDir: '   ', maxBytes: 2097152 })
    )) as Error;
    expect((err as ImportPathError).reason).toBe(
      'path intake disabled (wod.importDir is not configured)'
    );
  });

  it('refuses a non-.json extension without reading it', async () => {
    const err = (await expectNoFileRead(() =>
      readActorDocFromPath('notjson.txt', opts())
    )) as Error;
    expect((err as ImportPathError).reason).toBe('must be a .json file');
  });

  it('refuses a directory even when named .json-ish', async () => {
    const err = (await readActorDocFromPath('nested', opts()).catch(e => e)) as Error;
    expect((err as ImportPathError).reason).toBe('must be a .json file');
  });

  it('refuses a file over the size cap after opening nothing but stat', async () => {
    const err = (await readActorDocFromPath('good.json', {
      importDir,
      maxBytes: 8,
    }).catch(e => e)) as ImportPathError;
    expect(err.reason).toBe('too large');
  });

  it('reports a missing in-root file as not found', async () => {
    const err = (await readActorDocFromPath('nope.json', opts()).catch(e => e)) as ImportPathError;
    expect(err.reason).toBe('not found');
  });
});

describe('error hygiene', () => {
  it('never leaks a resolved absolute path or file contents', async () => {
    for (const attempt of ['../outside/secret.json', 'escape.json', secretPath, 'broken.json']) {
      const err = (await readActorDocFromPath(attempt, opts()).catch(e => e)) as ImportPathError;
      expect(err).toBeInstanceOf(ImportPathError);
      expect(err.message).not.toContain('TOP-SECRET');
      expect(err.message).not.toContain('ssh_key');
      // The only path in the message is the one the caller supplied.
      expect(err.message.replace(attempt, '')).not.toContain(sandbox);
    }
  });

  it('gives the same reason for "escapes and exists" and "escapes and does not exist"', async () => {
    // Otherwise the error is an existence oracle for arbitrary paths.
    const exists = (await readActorDocFromPath(secretPath, opts()).catch(
      e => e
    )) as ImportPathError;
    const missing = (await readActorDocFromPath(path.join(outsideDir, 'ghost.json'), opts()).catch(
      e => e
    )) as ImportPathError;
    expect(exists.reason).toBe('outside importDir');
    expect(missing.reason).toBe('outside importDir');
  });

  it('does not echo the JSON parser message (which quotes file contents)', async () => {
    const err = (await readActorDocFromPath('broken.json', opts()).catch(
      e => e
    )) as ImportPathError;
    expect(err.reason).toBe('invalid JSON');
    expect(err.message).not.toContain('not json');
  });

  it('truncates an absurdly long requested path before echoing it', async () => {
    const long = `${'a'.repeat(5000)}.json`;
    const err = (await readActorDocFromPath(long, opts()).catch(e => e)) as ImportPathError;
    expect(err.relativePath.length).toBeLessThanOrEqual(201);
  });
});

describe('resolveImportPath is independently usable', () => {
  it('returns the realpath for a legitimate file', async () => {
    await expect(resolveImportPath('good.json', opts())).resolves.toBe(
      path.join(importDir, 'good.json')
    );
  });

  it('rejects when the configured root itself does not exist', async () => {
    const err = (await resolveImportPath('good.json', {
      importDir: path.join(sandbox, 'no-such-dir'),
      maxBytes: 2097152,
    }).catch(e => e)) as ImportPathError;
    expect(err.reason).toBe('path intake disabled (wod.importDir is not configured)');
  });

  it('rejects when the configured root is a file, not a directory', async () => {
    const err = (await resolveImportPath('good.json', {
      importDir: path.join(importDir, 'good.json'),
      maxBytes: 2097152,
    }).catch(e => e)) as ImportPathError;
    expect(err.reason).toBe('path intake disabled (wod.importDir is not configured)');
  });
});
