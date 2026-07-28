/**
 * Staged-ARCHIVE intake for `worldofdarkness-import-actor`: one `.zip` file in,
 * N actor documents out.
 *
 * NOT A PER-CALL WORK MITIGATION, and less so than the path intake it sits beside.
 * Read import-path.ts:4-11 first, then read this: an archive does not reduce what
 * crosses the bridge at all. Each document it yields travels to Foundry in full,
 * as its own `mcp-query`, exactly as if it had been inlined — so an archive is
 * ~50 sequential bridge queries where a path list was ~50 sequential bridge
 * queries. It saves the operator from enumerating fifty paths and nothing else.
 * The document cap is therefore INHERITED, not raised (`WOD_ARCHIVE_LIMITS.MAX_DOCUMENTS`).
 *
 * WHERE THIS SITS IN THE LAYERING, stated once so it is not rediscovered. An
 * archive is a CONTAINER OF FILES and answers *where the documents come from*;
 * gzip (wire-format.ts) is an ENCODING OF ONE MESSAGE and answers *how a message
 * fits on the wire*. They compose in exactly one direction and never meet:
 *
 *     archive → documents → schema → chunks → gzip → frame
 *
 * By the time compression exists the archive is gone. Consequences: the archive is
 * never an argument to a bridge query, no Foundry module code changes, and this
 * intake needs no module deploy and no world reload.
 *
 * WHY THERE IS A PARSER HERE AND NOT A DEPENDENCY
 * ----------------------------------------------
 * Node's `zlib` reads deflate but has no ZIP container parser, so this file is
 * ~2/3 fixed-layout struct walking. A dependency (`yauzl`, `jszip`, `adm-zip`,
 * `fflate`, …) would remove that arithmetic and, crucially, would remove the
 * defence with it: those readers inflate entries eagerly with no output bound,
 * whereas `zlib.inflateRawSync(buf, { maxOutputLength })` ABORTS at a declared
 * limit. Taking a dependency here would mean giving up the decompression-bomb
 * defence in order to avoid writing a struct walk. (`adm-zip` in particular has a
 * zip-slip CVE history — a dependency whose CVEs are about the thing we most need
 * to get right is not a shortcut.) So: no new runtime dependency in either package.
 *
 * Central-directory-FIRST, which is a technical decision and not a convenience:
 * the entry count, each entry's declared uncompressed size, its compression method
 * and its encryption bit are all readable from a fixed-layout directory at the end
 * of the file BEFORE a single byte is inflated. It also sidesteps the data-descriptor
 * problem for free — a producer that streams (general-purpose bit 3) leaves the
 * LOCAL header's sizes zeroed and writes them after the data, while the central
 * directory always carries the true values. Sizes, method and flags are therefore
 * read from the central directory, NEVER from the local header.
 *
 * SECURITY MODEL — inherits import-path.ts:13-31 verbatim, plus three things
 * -------------------------------------------------------------------------
 *   - ZIP SLIP IS ABSENT, NOT MITIGATED. No entry name is ever joined to a
 *     directory, passed to an `fs` call, or written to disk; NOTHING IS EXTRACTED.
 *     A container carries `../../../../etc/pwned.json` and `/abs/pwned.json`
 *     without complaint, so it offers no protection of its own — the single
 *     decision that makes those harmless is that there is no extraction step. A
 *     later change that uploads archive members to a file store would reintroduce
 *     the hazard and must inherit this prohibition explicitly, not by accident.
 *     Names are ALSO validated lexically below: defence in depth is cheap, and the
 *     names survive into the report, so a name that cannot be safely displayed
 *     should not be accepted in the first place.
 *   - BOUNDED EXPANSION, ON MEASURED OUTPUT. Three declared constants
 *     (`WOD_ARCHIVE_LIMITS` in config.ts, plus `importMaxBytes` as the per-entry
 *     bound). Declared sizes are a cheap pre-filter and never the authority,
 *     because a central directory is attacker-controlled data — refuse early on
 *     the declarations, then inflate under `maxOutputLength` anyway. Whole-archive
 *     refusal, never partial: validation is entirely separable from writing, so
 *     refusing costs nothing while importing "the entries that fit" would satisfy
 *     a request nobody made.
 *   - ERROR HYGIENE, WITH ONE DOCUMENTED RELAXATION. Entry names ARE echoed. An
 *     entry name is strictly file *content*, which import-path.ts:28-31 says never
 *     to report — but "entry 17 of 27 was ignored" is unusable for the one job the
 *     report has, and the archive is a file the operator deliberately staged inside
 *     a directory they opted into, so the name is content the caller already
 *     controls rather than information about the host. Echoed names are sanitised
 *     the way a requested path is (control characters stripped, truncated). The
 *     relaxation does NOT extend to entry DATA: a JSON parse failure never quotes
 *     the offending text.
 */

import * as zlib from 'zlib';
import { WOD_ARCHIVE_LIMITS } from '../../config.js';
import {
  ImportPathError,
  readStagedFile,
  type ImportPathOptions,
  type ImportPathRejection,
} from './import-path.js';

/** How long an echoed entry name may be. Same discipline as import-path.ts:86. */
const MAX_SHOWN_ENTRY_LENGTH = 120;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

/** General-purpose bit 0: the entry is encrypted. */
const FLAG_ENCRYPTED = 0x0001;
/** General-purpose bit 6: strong encryption. Refused for the same reason. */
const FLAG_STRONG_ENCRYPTION = 0x0040;
/** General-purpose bit 11: the entry name is UTF-8 rather than CP437. */
const FLAG_UTF8_NAME = 0x0800;

export type ArchiveClassification = 'document' | 'ignored' | 'refused';

export interface ArchiveEntry {
  /** Sanitised name — safe to echo, never safe to build a path from. */
  name: string;
  classification: ArchiveClassification;
  /** Why it was ignored or refused. Always set unless it is a document. */
  reason?: string;
  /** Compression method, from the central directory. */
  method: number;
  /** Uncompressed size the ARCHIVE DECLARES. A pre-filter, not the authority. */
  declaredBytes: number;
  compressedBytes: number;
}

export interface ArchiveDocument {
  /** The sanitised entry name this document came from. */
  entry: string;
  /** Parsed JSON, unvalidated: the caller feeds it through `actorDocSchema`. */
  value: unknown;
  /** MEASURED expanded bytes. */
  bytes: number;
}

export interface ArchiveContents {
  entries: ArchiveEntry[];
  documents: ArchiveDocument[];
  counts: { entries: number; documents: number; ignored: number; refused: number };
  /** Size of the archive file itself, which no bound below is about. */
  archiveBytes: number;
  declaredUncompressedBytes: number;
  measuredUncompressedBytes: number;
}

export interface ArchiveLimits {
  /**
   * Per-entry expanded ceiling. The tool passes `wod.importMaxBytes`, so an entry
   * can never carry more than a staged file could.
   */
  maxEntryBytes: number;
  maxEntries?: number;
  maxTotalUncompressedBytes?: number;
}

/**
 * An archive rejection. Subclasses `ImportPathError` so a caller has exactly one
 * error type and one fixed reason set to reason about across both intakes.
 */
export class ImportArchiveError extends ImportPathError {
  /** The sanitised entry the failure is about, when it is about one. */
  readonly entry: string | undefined;
  /**
   * The inventory as far as it got. Present when the archive was READABLE and
   * refused on its contents — which is precisely what distinguishes "no documents
   * found" from "the archive could not be read".
   */
  readonly inventory: ArchiveEntry[] | undefined;

  constructor(
    relativePath: string,
    reason: ImportPathRejection,
    options: { entry?: string; detail?: string; inventory?: ArchiveEntry[] } = {}
  ) {
    const context = [
      options.entry !== undefined ? `entry: ${options.entry}` : undefined,
      options.detail,
    ]
      .filter((part): part is string => part !== undefined)
      .join('; ');
    super(relativePath, reason, context === '' ? undefined : context);
    this.name = 'ImportArchiveError';
    this.entry = options.entry;
    this.inventory = options.inventory;
  }
}

/** Strip control characters and truncate, exactly as a requested path is. */
function showEntry(name: string): string {
  /* eslint-disable-next-line no-control-regex */
  const clean = name.replace(/[\u0000-\u001f\u007f]/g, '');
  return clean.length > MAX_SHOWN_ENTRY_LENGTH
    ? `${clean.slice(0, MAX_SHOWN_ENTRY_LENGTH)}…`
    : clean;
}

/**
 * Lexical name validation. Refuses a parent-directory segment, an absolute prefix
 * (POSIX or a Windows drive letter), a backslash separator, or a NUL byte —
 * mirroring the NUL check at import-path.ts:93-95.
 *
 * DEFENCE IN DEPTH ONLY. Nothing below this line joins an entry name to a path, so
 * none of these names could reach the filesystem even if this check did not exist.
 * It is here because the names are echoed, and because the art follow-up will turn
 * entry names into upload destinations — at which point this stops being belt and
 * braces and becomes the load-bearing check.
 */
function isUnsafeEntryName(name: string): boolean {
  if (name.includes('\u0000')) return true;
  if (name.includes('\\')) return true;
  if (name.startsWith('/')) return true;
  if (/^[a-zA-Z]:/.test(name)) return true;
  return name.split('/').includes('..');
}

interface CentralEntry {
  name: string;
  shown: string;
  flags: number;
  method: number;
  declaredBytes: number;
  compressedBytes: number;
  localOffset: number;
}

/** Locate the end-of-central-directory record, scanning back past any comment. */
function findEndOfCentralDirectory(bytes: Buffer): number | null {
  // The comment length field is 16 bits, so the EOCD starts at most 65,535 + 22
  // bytes from the end. Scanning further would be scanning the members.
  const earliest = Math.max(0, bytes.length - (0xffff + 22));
  for (let i = bytes.length - 22; i >= earliest; i--) {
    if (bytes.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  return null;
}

/**
 * Parse an in-memory archive into an inventory plus the documents it yields.
 *
 * Exported separately from `readActorArchive` so the container logic can be tested
 * without staging a file — the same reason `resolveImportPath` is exported
 * separately from `readActorDocFromPath`.
 *
 * `shown` is the caller's own path, echoed in errors; it is never used to open
 * anything.
 */
export function readArchiveBuffer(
  bytes: Buffer,
  shown: string,
  limits: ArchiveLimits
): ArchiveContents {
  const maxEntries = limits.maxEntries ?? WOD_ARCHIVE_LIMITS.MAX_RAW_ENTRIES;
  const maxTotal =
    limits.maxTotalUncompressedBytes ?? WOD_ARCHIVE_LIMITS.MAX_TOTAL_UNCOMPRESSED_BYTES;

  const central = readCentralDirectory(bytes, shown, maxEntries);

  // ── Pass 1: the DECLARATIONS. Everything knowable before inflating anything.
  const entries: ArchiveEntry[] = [];
  const candidates: CentralEntry[] = [];
  let declaredTotal = 0;

  for (const entry of central) {
    if (isUnsafeEntryName(entry.name)) {
      entries.push(describe(entry, 'refused', 'unsafe entry name'));
      throw new ImportArchiveError(shown, 'unsafe entry name', {
        entry: entry.shown,
        inventory: entries,
      });
    }

    declaredTotal += entry.declaredBytes;

    const ignored = ignoreReason(entry.name);
    if (ignored !== null) {
      entries.push(describe(entry, 'ignored', ignored));
      continue;
    }

    // Only entries we are actually going to expand are gated: an ignored sidecar
    // is never inflated, so its method and encryption bit are irrelevant, and
    // refusing on them would break the most likely producer.
    if ((entry.flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) !== 0) {
      entries.push(describe(entry, 'refused', 'encrypted'));
      throw new ImportArchiveError(shown, 'encrypted entry', {
        entry: entry.shown,
        inventory: entries,
      });
    }
    if (entry.method !== METHOD_STORED && entry.method !== METHOD_DEFLATE) {
      entries.push(describe(entry, 'refused', `compression method ${entry.method}`));
      throw new ImportArchiveError(shown, 'unsupported compression method', {
        entry: entry.shown,
        detail: `method ${entry.method}; only 0 (stored) and 8 (deflate) are supported`,
        inventory: entries,
      });
    }
    if (entry.declaredBytes > limits.maxEntryBytes) {
      entries.push(describe(entry, 'refused', 'declared size over the per-entry bound'));
      throw new ImportArchiveError(shown, 'entry expands beyond the per-entry bound', {
        entry: entry.shown,
        detail: `declares ${entry.declaredBytes} bytes, bound is ${limits.maxEntryBytes}`,
        inventory: entries,
      });
    }

    entries.push(describe(entry, 'document'));
    candidates.push(entry);
  }

  if (declaredTotal > maxTotal) {
    throw new ImportArchiveError(shown, 'archive expands beyond the total bound', {
      detail: `declares ${declaredTotal} bytes across ${central.length} entries, bound is ${maxTotal}`,
      inventory: entries,
    });
  }

  if (candidates.length === 0) {
    throw new ImportArchiveError(shown, 'no actor documents found', {
      detail:
        `${central.length} entr${central.length === 1 ? 'y' : 'ies'} were read and all were ` +
        `ignored — see the inventory for each one's reason. The archive itself is readable`,
      inventory: entries,
    });
  }

  // ── Pass 2: expand, MEASURING as we go. The declarations above bought us the
  // right to start; they are not evidence about what comes out.
  const documents: ArchiveDocument[] = [];
  let measuredTotal = 0;

  for (const entry of candidates) {
    const remaining = maxTotal - measuredTotal;
    const expanded = expand(bytes, entry, shown, Math.min(limits.maxEntryBytes, remaining), {
      maxEntryBytes: limits.maxEntryBytes,
      maxTotal,
      inventory: entries,
    });
    measuredTotal += expanded.byteLength;

    let value: unknown;
    try {
      value = JSON.parse(expanded.toString('utf8'));
    } catch {
      // Deliberately without the parser's message: it quotes the offending source
      // text, which is entry DATA and outside the one relaxation this file allows.
      markRefused(entries, entry.shown, 'not valid JSON');
      throw new ImportArchiveError(shown, 'invalid JSON in entry', {
        entry: entry.shown,
        inventory: entries,
      });
    }

    documents.push({ entry: entry.shown, value, bytes: expanded.byteLength });
  }

  return {
    entries,
    documents,
    counts: {
      entries: entries.length,
      documents: entries.filter(e => e.classification === 'document').length,
      ignored: entries.filter(e => e.classification === 'ignored').length,
      refused: entries.filter(e => e.classification === 'refused').length,
    },
    archiveBytes: bytes.byteLength,
    declaredUncompressedBytes: declaredTotal,
    measuredUncompressedBytes: measuredTotal,
  };
}

/**
 * Resolve a staged archive path and read it.
 *
 * The path goes through the SAME resolver a staged document does, with only the
 * permitted extension parameterised: opt-in root, lexical containment, then
 * `fs.realpath`, then the `stat` size gate. With `importDir` unset an archive is
 * refused exactly as a document path is.
 */
export async function readActorArchive(
  requested: string,
  options: ImportPathOptions
): Promise<ArchiveContents> {
  const shown = requested.length > 200 ? `${requested.slice(0, 200)}…` : requested;
  const bytes = await readStagedFile(requested, { ...options, extension: '.zip' });
  return readArchiveBuffer(bytes, shown, { maxEntryBytes: options.maxBytes });
}

// ── internals ───────────────────────────────────────────────────────────────────

function describe(
  entry: CentralEntry,
  classification: ArchiveClassification,
  reason?: string
): ArchiveEntry {
  return {
    name: entry.shown,
    classification,
    ...(reason !== undefined ? { reason } : {}),
    method: entry.method,
    declaredBytes: entry.declaredBytes,
    compressedBytes: entry.compressedBytes,
  };
}

/** Flip an already-inventoried document entry to `refused` when expansion fails. */
function markRefused(entries: ArchiveEntry[], shown: string, reason: string): void {
  const found = entries.find(e => e.name === shown);
  if (found !== undefined) {
    found.classification = 'refused';
    found.reason = reason;
  }
}

/**
 * Why an entry is not an actor document, or `null` if it might be one.
 *
 * ORDER IS LOAD-BEARING, and this is the measurement that decides it. macOS
 * "Compress" on a folder of 12 documents emits 27 entries, of which 24 are files
 * and ALL 24 END IN `.json` — 12 of them AppleDouble sidecars under `__MACOSX/`
 * whose expansion yields a ~471-byte binary (magic `00 05 16 07`) that fails
 * `JSON.parse`. So an extension filter alone does not merely miss something: it
 * turns every Finder-produced archive into an "invalid JSON" error. The name tests
 * must run BEFORE the extension test, never instead of it and never after it.
 */
function ignoreReason(name: string): string | null {
  if (name.endsWith('/')) return 'directory entry';
  const segments = name.split('/');
  const basename = segments[segments.length - 1] ?? '';
  if (segments.includes('__MACOSX')) return 'macOS metadata sidecar (__MACOSX)';
  if (basename.startsWith('._')) return 'macOS AppleDouble sidecar (._ prefix)';
  if (basename === '.DS_Store') return 'operating-system metadata';
  if (basename.startsWith('.')) return 'hidden file';
  if (!basename.toLowerCase().endsWith('.json')) return 'not a .json entry';
  return null;
}

/** Walk the central directory. Nothing here inflates anything. */
function readCentralDirectory(bytes: Buffer, shown: string, maxEntries: number): CentralEntry[] {
  const eocd = findEndOfCentralDirectory(bytes);
  if (eocd === null || eocd + 22 > bytes.length) {
    throw new ImportArchiveError(shown, 'not a readable archive', {
      detail: 'no end-of-central-directory record',
    });
  }

  const totalEntries = bytes.readUInt16LE(eocd + 10);
  const centralSize = bytes.readUInt32LE(eocd + 12);
  const centralOffset = bytes.readUInt32LE(eocd + 16);

  // ZIP64 is refused rather than supported: its markers only appear above 4 GiB
  // or 65,535 entries, both orders of magnitude beyond every bound here, so
  // supporting it would be code with no reachable purpose.
  if (totalEntries === 0xffff || centralOffset === 0xffffffff || centralSize === 0xffffffff) {
    throw new ImportArchiveError(shown, 'ZIP64 is not supported', {
      detail: 'the archive declares ZIP64 markers; split or shrink it',
    });
  }

  if (totalEntries > maxEntries) {
    throw new ImportArchiveError(shown, 'too many entries', {
      detail: `declares ${totalEntries} entries, bound is ${maxEntries}`,
    });
  }
  if (centralOffset + centralSize > bytes.length) {
    throw new ImportArchiveError(shown, 'not a readable archive', {
      detail: 'the central directory lies outside the file',
    });
  }

  const entries: CentralEntry[] = [];
  let cursor = centralOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new ImportArchiveError(shown, 'not a readable archive', {
        detail: `central directory entry ${i + 1} of ${totalEntries} is malformed`,
      });
    }
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const compressedBytes = bytes.readUInt32LE(cursor + 20);
    const declaredBytes = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);

    const nameEnd = cursor + 46 + nameLength;
    if (nameEnd > bytes.length) {
      throw new ImportArchiveError(shown, 'not a readable archive', {
        detail: `central directory entry ${i + 1} names past the end of the file`,
      });
    }
    // Bit 11 says the name is UTF-8; otherwise it is nominally CP437, which Node
    // cannot decode. `latin1` is a lossless byte-preserving stand-in and this name
    // is only ever displayed, never resolved, so an imperfect transliteration of a
    // legacy name costs nothing.
    const name = bytes
      .subarray(cursor + 46, nameEnd)
      .toString((flags & FLAG_UTF8_NAME) !== 0 ? 'utf8' : 'latin1');

    entries.push({
      name,
      shown: showEntry(name),
      flags,
      method,
      declaredBytes,
      compressedBytes,
      localOffset,
    });
    cursor = nameEnd + extraLength + commentLength;
  }

  return entries;
}

/**
 * Expand one entry under a MEASURED bound.
 *
 * `zlib.inflateRawSync(…, { maxOutputLength })` throws `ERR_BUFFER_TOO_LARGE` at
 * the bound rather than materialising the output and checking afterwards, which is
 * the property this whole design rests on and the reason no dependency was taken.
 * No partially-expanded entry is ever returned or handed onward.
 *
 * Note the two lengths that come from DIFFERENT headers, deliberately: the name and
 * extra-field lengths come from the LOCAL header (they are always correct there,
 * and are what locate the data), while the sizes, method and flags come from the
 * CENTRAL directory (a streaming producer zeroes them locally).
 */
function expand(
  bytes: Buffer,
  entry: CentralEntry,
  shown: string,
  maxOutputLength: number,
  ctx: { maxEntryBytes: number; maxTotal: number; inventory: ArchiveEntry[] }
): Buffer {
  const local = entry.localOffset;
  if (local + 30 > bytes.length || bytes.readUInt32LE(local) !== LOCAL_SIGNATURE) {
    markRefused(ctx.inventory, entry.shown, 'local header is malformed');
    throw new ImportArchiveError(shown, 'not a readable archive', {
      entry: entry.shown,
      detail: 'local header is missing or malformed',
      inventory: ctx.inventory,
    });
  }
  const nameLength = bytes.readUInt16LE(local + 26);
  const extraLength = bytes.readUInt16LE(local + 28);
  const start = local + 30 + nameLength + extraLength;
  const end = start + entry.compressedBytes;
  if (end > bytes.length) {
    markRefused(ctx.inventory, entry.shown, 'data runs past the end of the file');
    throw new ImportArchiveError(shown, 'not a readable archive', {
      entry: entry.shown,
      detail: 'entry data runs past the end of the file',
      inventory: ctx.inventory,
    });
  }
  const body = bytes.subarray(start, end);

  if (entry.method === METHOD_STORED) {
    if (body.byteLength > maxOutputLength) {
      throw boundBreach(entry, shown, body.byteLength, maxOutputLength, ctx);
    }
    return body;
  }

  try {
    // `maxOutputLength` is min(per-entry bound, total budget still unspent) — the
    // BOUND, never the size the archive declared. Deriving it from the declaration
    // would be exactly the mistake the pre-filter is allowed to make and this is
    // not: a small declared size must not license unbounded expansion.
    return zlib.inflateRawSync(body, { maxOutputLength: Math.max(1, maxOutputLength) });
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === 'ERR_BUFFER_TOO_LARGE') {
      throw boundBreach(entry, shown, null, maxOutputLength, ctx);
    }
    markRefused(ctx.inventory, entry.shown, 'could not be expanded');
    throw new ImportArchiveError(shown, 'not a readable archive', {
      entry: entry.shown,
      detail: 'the entry could not be expanded',
      inventory: ctx.inventory,
    });
  }
}

/**
 * The measured-bound refusal, attributed to whichever bound actually bound.
 *
 * `maxOutputLength` is the *lesser* of the per-entry bound and what is left of the
 * total, so the message must say which one was reached or a caller cannot tell "one
 * huge actor" from "fifty ordinary ones".
 */
function boundBreach(
  entry: CentralEntry,
  shown: string,
  measured: number | null,
  maxOutputLength: number,
  ctx: { maxEntryBytes: number; maxTotal: number; inventory: ArchiveEntry[] }
): ImportArchiveError {
  markRefused(ctx.inventory, entry.shown, 'expanded beyond the bound');
  const perEntryBound = maxOutputLength >= ctx.maxEntryBytes;
  const measuredNote =
    measured !== null ? `measured ${measured} bytes` : 'expansion aborted at the bound';
  return new ImportArchiveError(
    shown,
    perEntryBound
      ? 'entry expands beyond the per-entry bound'
      : 'archive expands beyond the total bound',
    {
      entry: entry.shown,
      detail: perEntryBound
        ? `${measuredNote}, bound is ${ctx.maxEntryBytes}`
        : `${measuredNote}, and only ${maxOutputLength} of the ${ctx.maxTotal}-byte total remained`,
      inventory: ctx.inventory,
    }
  );
}
