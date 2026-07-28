/**
 * Allow-listed path intake for `worldofdarkness-import-actor`.
 *
 * NOT A TIMEOUT MITIGATION. Read this before extending it. Reading a document
 * server-side removes the *agent's* token cost and the retyping-corruption risk
 * of inlining ~47 KB of JSON per actor into a tool call. It does NOT reduce what
 * crosses the bridge: the parsed document travels to Foundry in full, as the same
 * `mcp-query` it would have travelled as if it had been inlined. Path intake must
 * never be described or relied upon as a way to import more actors per call — the
 * per-call work ceiling (see import-chunking.ts) is the only thing that bounds
 * that, and this surface makes oversized batches *easier* to ask for.
 *
 * SECURITY MODEL
 * --------------
 * The MCP server runs as the user and the path argument originates from a model,
 * so prompt-injected text can name any file. This must not become an
 * arbitrary-file-read primitive. Mandatory rules, all enforced below:
 *
 *   - Opt-in root. Resolution happens only inside `config.wod.importDir`. With it
 *     unset, every path is refused; there is no implicit default root.
 *   - Rejection happens BEFORE the file is opened. The lexical containment check
 *     runs first (catching `../` and absolute paths outside the root with zero
 *     filesystem access), then `fs.realpath` (which resolves symlinks but does not
 *     read contents) re-checks containment, then the size cap is checked via
 *     `stat`. Only after all of that is the file read.
 *   - One named file per entry, with the permitted extension PARAMETERISED (see
 *     `ImportPathOptions.extension`): `.json` for a document, `.zip` for the
 *     archive intake (import-archive.ts). No globs, no recursion, no directory
 *     listing. The containment logic below is the ONLY copy — two copies of a
 *     containment check is the failure this whole model exists to avoid, so a new
 *     intake parameterises this resolver rather than growing its own.
 *   - Error hygiene. Failures report the caller's own relative path plus one of a
 *     fixed set of reasons. Never a resolved absolute path, never file contents,
 *     and the reason for anything escaping the root is always `outside importDir`
 *     — so a rejected path's existence is never confirmed or denied.
 */

import { promises as fs } from 'fs';
import * as path from 'path';

/**
 * The fixed set of rejection reasons. Archive reasons live here rather than in
 * import-archive.ts so the set stays enumerable in one place — the discipline is
 * "a caller can only ever be told one of these", and that is only checkable if
 * they are all visible together.
 */
export type ImportPathRejection =
  // ── shared with every intake ───────────────────────────────────────────────
  | 'path intake disabled (wod.importDir is not configured)'
  | 'outside importDir'
  | 'not found'
  | 'not a regular file'
  | 'too large'
  // ── document intake ───────────────────────────────────────────────────────
  | 'must be a .json file'
  | 'invalid JSON'
  // ── archive intake (import-archive.ts) ────────────────────────────────────
  | 'must be a .zip file'
  | 'not a readable archive'
  | 'ZIP64 is not supported'
  | 'too many entries'
  | 'unsafe entry name'
  | 'encrypted entry'
  | 'unsupported compression method'
  | 'entry expands beyond the per-entry bound'
  | 'archive expands beyond the total bound'
  | 'invalid JSON in entry'
  | 'no actor documents found';

export class ImportPathError extends Error {
  readonly relativePath: string;
  readonly reason: ImportPathRejection;

  /**
   * `context` carries OUR OWN numbers — a bound that was exceeded, a compression
   * method number, a sanitised entry name — never anything read out of a file.
   * The one deliberate narrowing is the entry name, which import-archive.ts
   * sanitises before passing it; see that file's header for why identifying the
   * failing entry is worth it and where the line is drawn.
   */
  constructor(relativePath: string, reason: ImportPathRejection, context?: string) {
    // The message deliberately contains only what the caller already supplied
    // plus, optionally, our own numbers.
    super(`${relativePath}: ${reason}${context !== undefined ? ` (${context})` : ''}`);
    this.name = 'ImportPathError';
    this.relativePath = relativePath;
    this.reason = reason;
  }
}

/** Extensions any intake may permit, and the rejection each one produces. */
const EXTENSION_REJECTION = {
  '.json': 'must be a .json file',
  '.zip': 'must be a .zip file',
} as const satisfies Record<string, ImportPathRejection>;

export type PermittedExtension = keyof typeof EXTENSION_REJECTION;

export interface ImportPathOptions {
  /** `config.wod.importDir`. Undefined/empty ⇒ path intake is disabled. */
  importDir?: string | undefined;
  /** `config.wod.importMaxBytes`. */
  maxBytes: number;
  /** The one permitted extension. Defaults to `.json`. */
  extension?: PermittedExtension;
}

/** True iff `candidate` is the root itself or lies beneath it. */
function isContained(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  return candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/**
 * Resolve a caller-supplied path to an absolute path inside the configured root,
 * WITHOUT reading the file. Throws `ImportPathError` on any escape.
 *
 * Exported separately from `readActorDocFromPath` so the rejection logic can be
 * tested on its own — a test that asserts "rejected" via the read path cannot
 * prove the file was never opened.
 */
export async function resolveImportPath(
  requested: string,
  options: ImportPathOptions
): Promise<string> {
  // A path is echoed back in errors, so normalise what we will echo first and
  // keep it short; never echo anything we derived from the filesystem.
  const shown = requested.length > 200 ? `${requested.slice(0, 200)}…` : requested;

  if (!options.importDir || options.importDir.trim() === '') {
    throw new ImportPathError(shown, 'path intake disabled (wod.importDir is not configured)');
  }

  // A NUL byte truncates the path in some syscalls; treat it as an escape attempt.
  if (requested.includes('\0')) {
    throw new ImportPathError(shown, 'outside importDir');
  }

  const extension: PermittedExtension = options.extension ?? '.json';
  if (path.extname(requested).toLowerCase() !== extension) {
    throw new ImportPathError(shown, EXTENSION_REJECTION[extension]);
  }

  // The root must itself exist and be a directory, and we compare against its
  // REAL path so that a symlinked root does not defeat the containment check.
  let realRoot: string;
  try {
    realRoot = await fs.realpath(path.resolve(options.importDir));
    const rootStat = await fs.stat(realRoot);
    if (!rootStat.isDirectory()) {
      throw new ImportPathError(shown, 'path intake disabled (wod.importDir is not configured)');
    }
  } catch (error) {
    if (error instanceof ImportPathError) throw error;
    throw new ImportPathError(shown, 'path intake disabled (wod.importDir is not configured)');
  }

  // ── Check 1: lexical. Zero filesystem access. Catches `../` traversal and any
  // absolute path outside the root. `path.resolve` normalises `..` segments, so a
  // relative path is joined to the root and an absolute one replaces it entirely
  // — either way what comes out must still be inside the root.
  const lexical = path.resolve(realRoot, requested);
  if (!isContained(realRoot, lexical)) {
    throw new ImportPathError(shown, 'outside importDir');
  }

  // ── Check 2: symlinks. `realpath` follows every link in the chain; it does not
  // read file contents. A file that exists inside the root but points outside it
  // is rejected here, still before any open().
  let real: string;
  try {
    real = await fs.realpath(lexical);
  } catch {
    // Includes ENOENT. Report `not found` only for a path that passed the lexical
    // containment check, so this never confirms anything about paths outside.
    throw new ImportPathError(shown, 'not found');
  }
  if (!isContained(realRoot, real)) {
    throw new ImportPathError(shown, 'outside importDir');
  }

  return real;
}

/**
 * Resolve, size-check and read one staged file as bytes.
 *
 * The shared half of every staged intake: resolve (§ above), `stat` for the size
 * gate BEFORE opening, then read. Both the document intake and the archive intake
 * go through this, so the ordering — and the fact that the size cap is checked
 * against `stat` rather than after reading — exists in exactly one place.
 */
export async function readStagedFile(
  requested: string,
  options: ImportPathOptions
): Promise<Buffer> {
  const shown = requested.length > 200 ? `${requested.slice(0, 200)}…` : requested;
  const resolved = await resolveImportPath(requested, options);

  const stat = await fs.stat(resolved).catch(() => {
    throw new ImportPathError(shown, 'not found');
  });
  if (!stat.isFile()) {
    throw new ImportPathError(shown, 'not a regular file');
  }
  if (stat.size > options.maxBytes) {
    throw new ImportPathError(shown, 'too large');
  }

  return await fs.readFile(resolved).catch(() => {
    throw new ImportPathError(shown, 'not found');
  });
}

/**
 * Resolve, size-check and parse one staged actor document.
 *
 * Returns the parsed JSON only; the caller feeds it through the SAME
 * `actorDocSchema` an inline document goes through, so there is exactly one
 * validation path.
 */
export async function readActorDocFromPath(
  requested: string,
  options: ImportPathOptions
): Promise<unknown> {
  const shown = requested.length > 200 ? `${requested.slice(0, 200)}…` : requested;
  const bytes = await readStagedFile(requested, options);

  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    // Deliberately does not include the parser's message: it quotes the offending
    // source text, which would leak file contents.
    throw new ImportPathError(shown, 'invalid JSON');
  }
}
