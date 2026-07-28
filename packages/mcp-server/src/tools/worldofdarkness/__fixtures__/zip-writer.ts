/**
 * A minimal ZIP *writer*, for tests only.
 *
 * WHY THIS EXISTS AND WHY IT IS NOT A DEPENDENCY. The archive intake
 * (`../import-archive.ts`) is a *reader*, and the measurements it is built on
 * (`openspec/changes/import-actor-batch-from-archive/design.md` §2d) include four
 * archives no honest producer emits: entry names that traverse out of the archive
 * root, a central directory that lies about an entry's uncompressed size, an entry
 * with the encryption bit set, and an unsupported compression method. `zip(1)`
 * cannot be asked for most of those, and a checked-in binary archive is opaque to
 * review and cannot be regenerated when a fixture changes (tasks §1.1). So the
 * hostile cases are BUILT, byte by byte, at test time.
 *
 * It writes only what the reader is specified to read: local file headers, stored
 * (method 0) or raw-deflate (method 8) member data, a central directory, and an
 * end-of-central-directory record. No ZIP64, no encryption, no data descriptors
 * beyond the ability to zero the local header's sizes the way a streaming producer
 * does — which is exactly the case the reader sidesteps by taking sizes from the
 * central directory instead.
 *
 * Every override below exists to construct one documented adversarial archive.
 * Nothing here is imported by production code.
 */

import * as zlib from 'zlib';

export interface ZipMemberSpec {
  /** Entry name, written verbatim — including names a reader must refuse. */
  name: string;
  data: Buffer | string;
  /**
   * Compression method. 0 (stored) and 8 (deflate) are produced faithfully;
   * any other number is *declared* while the bytes are stored, so the reader's
   * "refuse by number" path can be exercised.
   */
  method?: number;
  /** General-purpose bit flags to OR in. Bit 0 (0x0001) is "encrypted". */
  flags?: number;
  /**
   * Override the uncompressed size written to the CENTRAL DIRECTORY only. This is
   * how a lying archive is built: the declaration is attacker-controlled data, so
   * a small declared size must not license unbounded inflation.
   */
  declaredUncompressedSize?: number;
  /**
   * Zero the LOCAL header's sizes, as a producer that streams (general-purpose
   * bit 3) does before writing a trailing data descriptor. The central directory
   * still carries the true values, which is the whole reason the reader reads it.
   */
  streaming?: boolean;
  /**
   * Replace the member body verbatim, bypassing compression. Used to write bytes
   * that are NOT a valid deflate stream while still declaring method 8 — which is
   * how "the refusal was reached without inflating the entry" is proved: had the
   * reader inflated, it would have failed with a zlib error instead of the bound.
   */
  rawBody?: Buffer;
}

export interface ZipOverrides {
  /** Force the EOCD's entry count — e.g. 0xffff, the ZIP64 marker. */
  totalEntries?: number;
  /** Force the EOCD's central-directory offset — e.g. 0xffffffff. */
  centralDirectoryOffset?: number;
  /** Trailing archive comment, so the EOCD is not the last 22 bytes. */
  comment?: string;
}

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;

function crc32(buf: Buffer): number {
  // Node >= 20.12 exposes zlib.crc32. The reader does not verify CRCs, so a
  // fallback of 0 changes nothing it observes.
  const fn = (zlib as unknown as { crc32?: (b: Buffer) => number }).crc32;
  return typeof fn === 'function' ? fn(buf) : 0;
}

function compress(data: Buffer, method: number): Buffer {
  if (method === 8) return zlib.deflateRawSync(data);
  // Stored, and also the fallback for a *declared* method we are not going to
  // honour: the reader must refuse on the number before touching the bytes.
  return data;
}

/** Build a ZIP archive in memory from an explicit member list. */
export function buildZip(members: ZipMemberSpec[], overrides: ZipOverrides = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const member of members) {
    const raw = Buffer.isBuffer(member.data) ? member.data : Buffer.from(member.data, 'utf8');
    const method = member.method ?? 8;
    const flags = member.flags ?? 0;
    const body = member.rawBody ?? compress(raw, method);
    const name = Buffer.from(member.name, 'utf8');
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0, 12); // date
    local.writeUInt32LE(member.streaming === true ? 0 : crc, 14);
    local.writeUInt32LE(member.streaming === true ? 0 : body.length, 18);
    local.writeUInt32LE(member.streaming === true ? 0 : raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(member.declaredUncompressedSize ?? raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }

  const centralBytes = Buffer.concat(centrals);
  const comment = Buffer.from(overrides.comment ?? '', 'utf8');

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIGNATURE, 0);
  eocd.writeUInt16LE(0, 4); // this disk
  eocd.writeUInt16LE(0, 6); // disk with central directory
  eocd.writeUInt16LE(overrides.totalEntries ?? members.length, 8);
  eocd.writeUInt16LE(overrides.totalEntries ?? members.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(overrides.centralDirectoryOffset ?? offset, 16);
  eocd.writeUInt16LE(comment.length, 20);

  return Buffer.concat([...locals, centralBytes, eocd, comment]);
}

/**
 * The 471-byte AppleDouble sidecar `ditto -c -k --sequesterRsrc` writes for each
 * file, reproduced from its magic and layout so the CLASSIFIER can be tested on a
 * non-macOS runner (tasks §1.2). The first four bytes — `00 05 16 07` — are the
 * AppleDouble magic; the point of the fixture is that the name ends in `.json`
 * and `JSON.parse` of the body fails, which is what makes an extension-only
 * filter turn every Finder-produced archive into an "invalid JSON" error.
 */
export function appleDoubleSidecar(byteLength = 471): Buffer {
  const buf = Buffer.alloc(byteLength);
  buf.writeUInt32BE(0x00051607, 0); // AppleDouble magic
  buf.writeUInt32BE(0x00020000, 4); // version 2
  buf.write('Mac OS X        ', 8, 16, 'ascii'); // the filler `JSON.parse` chokes on
  return buf;
}
