#!/usr/bin/env node
/**
 * reached-surface — externally-reached-surface extractor for the data-access
 * extraction passes.
 *
 * Emits the set of members of a facade class that anything outside that class
 * reaches, WITH the signature text, so a relocation pass can prove its before/after
 * surface diff is empty. Also reports dead surface: non-private members reached by
 * nothing.
 *
 *   extract  capture the reached surface of a class from a set of reach sites
 *   diff     two captures; exit 1 if the surface changed
 *
 * The trap this exists to avoid, which bit pass 5.1 and was written up by 5.3:
 *
 *   A TYPE-CHECKER-ONLY PASS IS WRONG. On this repo it reported 62 members across 2
 *   files when the truth was 65+ across 7 of 9, because
 *     - the package tsconfig excludes the test files and the fixtures directory, so
 *       they are not in the program at all;
 *     - `settings.ts` reaches through `bridge?.dataAccess?.X`, `main.ts` through
 *       `this.queryHandlers?.dataAccess.X`, and the tests through
 *       `const da = await makeDataAccess()` — all of which resolve to `any`, so the
 *       checker cannot see the receiver's class even in a file it does compile.
 *   Three members inside a file the checker DID see were missed for the second reason.
 *
 * So the answer is the UNION of a checker pass and a receiver-text pass, plus a
 * deliberately over-approximating pass as a sensitivity check (5.3's found exactly two
 * false positives, both explainable: a same-named private field in `settings.ts` and a
 * socket-message discriminant string in `main.ts`).
 *
 * Because different tools legitimately disagree by a member or two, THE TOOL'S IDENTITY
 * IS PART OF THE OUTPUT — name, version, mode, receivers, checker scope, file list.
 * The dead-surface count on this class has been reported as 13, 7, 9 and 8 by four
 * successive hand-written extractors; a number without its tool is not a measurement.
 * `diff` refuses to compare two captures taken by different tool identities.
 *
 * Run: node scripts/refactor/reached-surface.mjs <command> [flags]   (no build step)
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  ts,
  readSource,
  findClass,
  memberName,
  visibilityOf,
  signatureOf,
  parseArgs,
  parseList,
} from './lib/ts-source.mjs';

const TOOL = { name: 'reached-surface', version: '1.0.0' };

function die(message) {
  process.stderr.write(`reached-surface: ${message}\n`);
  process.exit(2);
}

function expandFiles(entries) {
  const out = [];
  for (const entry of entries) {
    if (!entry.includes('*')) {
      out.push(path.resolve(entry));
      continue;
    }
    const dir = path.dirname(entry);
    const base = path.basename(entry);
    const rx = new RegExp(`^${base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    for (const name of fs.readdirSync(dir).sort()) {
      if (rx.test(name)) out.push(path.resolve(dir, name));
    }
  }
  return [...new Set(out)];
}

/** Every member of the facade class, with signature and visibility. */
function facadeMembers(facadePath, className) {
  const { sourceFile } = readSource(facadePath);
  const cls = findClass(sourceFile, className);
  const members = new Map();
  for (const member of cls.members) {
    const name = memberName(member);
    if (name === null || name === 'constructor') continue;
    members.set(name, {
      name,
      kind: ts.SyntaxKind[member.kind],
      visibility: visibilityOf(member),
      signature: signatureOf(member, sourceFile),
      line: sourceFile.getLineAndCharacterOfPosition(member.getStart(sourceFile)).line + 1,
    });
  }
  return members;
}

/** Last identifier segment of a receiver expression, optional chaining stripped. */
function receiverTail(text) {
  const flat = text.replace(/[!?]/g, '').trim();
  const seg = flat.split('.').pop() ?? '';
  return seg.replace(/\(.*\)$/, '').trim();
}

function accessName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression)) {
    return node.argumentExpression.text;
  }
  return null;
}

function addHit(map, name, file, line, pass) {
  if (!map.has(name)) map.set(name, { name, sites: [], passes: new Set() });
  const rec = map.get(name);
  const site = `${file}:${line}`;
  if (!rec.sites.includes(site)) rec.sites.push(site);
  rec.passes.add(pass);
}

function runReceiverPass(files, members, receivers) {
  const hits = new Map();
  // Names probed on the facade OBJECT that are not members of the facade CLASS.
  // `main.ts:650` does `queryHandlers.dataAccess.ensureButtonStatesForMessage($html)`
  // and no such member exists. It is part of the compatibility boundary anyway, and a
  // members-only extractor omits it silently — which is the entire difference between
  // the two reach counts in the archived record (65 class members vs 66 reached names).
  const nonMembers = new Map();
  const contributing = new Set();
  for (const file of files) {
    const { sourceFile } = readSource(file);
    const rel = path.relative(process.cwd(), file);
    const visit = node => {
      const name = accessName(node);
      if (name !== null) {
        const tail = receiverTail(node.expression.getText(sourceFile));
        if (receivers.includes(tail)) {
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
          if (members.has(name)) {
            addHit(hits, name, rel, line, 'receiver');
            contributing.add(rel);
          } else {
            addHit(nonMembers, name, rel, line, 'receiver');
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sourceFile, visit);
  }
  return { hits, nonMembers, contributing };
}

function runOverPass(files, members) {
  const hits = new Map();
  const contributing = new Set();
  for (const file of files) {
    const { sourceFile } = readSource(file);
    const rel = path.relative(process.cwd(), file);
    const visit = node => {
      let name = accessName(node);
      if (name === null && ts.isStringLiteralLike(node)) name = node.text;
      if (name !== null && members.has(name)) {
        addHit(hits, name, rel, sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1, 'over');
        contributing.add(rel);
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sourceFile, visit);
  }
  return { hits, contributing };
}

function runCheckerPass(files, members, className, tsconfigPath, scope) {
  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (configFile.error) die(`cannot read ${tsconfigPath}: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, ' ')}`);
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(tsconfigPath));
  let fileNames = parsed.fileNames.map(f => path.resolve(f));
  if (scope === 'files') fileNames = [...new Set([...fileNames, ...files])];
  const program = ts.createProgram(fileNames, { ...parsed.options, noEmit: true });
  const checker = program.getTypeChecker();

  const hits = new Map();
  const contributing = new Set();
  const notInProgram = [];
  for (const file of files) {
    const sourceFile = program.getSourceFile(file);
    const rel = path.relative(process.cwd(), file);
    if (!sourceFile) {
      notInProgram.push(rel);
      continue;
    }
    const visit = node => {
      const name = accessName(node);
      if (name !== null && members.has(name)) {
        const type = checker.getNonNullableType(checker.getTypeAtLocation(node.expression));
        const symbol = type.getSymbol() ?? type.aliasSymbol;
        if (symbol?.getName() === className) {
          addHit(hits, name, rel, sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1, 'checker');
          contributing.add(rel);
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sourceFile, visit);
  }
  return { hits, contributing, notInProgram, programFiles: fileNames.length };
}

function mergeHits(...maps) {
  const out = new Map();
  for (const map of maps) {
    for (const [name, rec] of map) {
      if (!out.has(name)) out.set(name, { name, sites: [], passes: new Set() });
      const target = out.get(name);
      for (const site of rec.sites) if (!target.sites.includes(site)) target.sites.push(site);
      for (const p of rec.passes) target.passes.add(p);
    }
  }
  return out;
}

function surfaceOf(hits, members) {
  return [...hits.keys()]
    .sort()
    .map(name => ({
      name,
      visibility: members.get(name).visibility,
      signature: members.get(name).signature,
      passes: [...hits.get(name).passes].sort(),
      files: [...new Set(hits.get(name).sites.map(s => s.split(':')[0]))].sort(),
      sites: hits.get(name).sites,
    }));
}

function cmdExtract(args) {
  const facadePath = path.resolve(args.facade ?? die('--facade is required'));
  const className = args.class ?? die('--class is required');
  const fileEntries = parseList(args.files) ?? die('--files is required (comma-separated; `*` allowed in the basename)');
  const files = expandFiles(fileEntries).filter(f => path.resolve(f) !== facadePath);
  const receivers = parseList(args.receivers) ?? ['dataAccess', 'da'];
  const tsconfigPath = path.resolve(args.tsconfig ?? path.join(path.dirname(facadePath), '..', 'tsconfig.json'));
  const checkerScope = args['checker-scope'] ?? 'tsconfig';
  if (!['tsconfig', 'files'].includes(checkerScope)) die(`--checker-scope must be tsconfig or files`);

  const members = facadeMembers(facadePath, className);
  const receiver = runReceiverPass(files, members, receivers);
  const checker = runCheckerPass(files, members, className, tsconfigPath, checkerScope);
  const over = runOverPass(files, members);
  const union = mergeHits(checker.hits, receiver.hits);

  const surface = surfaceOf(union, members);
  const overSurface = surfaceOf(over.hits, members);
  const unionNames = new Set(surface.map(m => m.name));
  const overOnly = overSurface.filter(m => !unionNames.has(m.name));

  const nonPrivate = [...members.values()].filter(m => m.visibility !== 'private');
  const dead = nonPrivate.filter(m => !unionNames.has(m.name));

  const identity = {
    ...TOOL,
    typescript: ts.version,
    node: process.version,
    mode: 'union(checker,receiver)+sensitivity',
    class: className,
    facade: path.relative(process.cwd(), facadePath),
    receivers,
    checkerScope,
    tsconfig: path.relative(process.cwd(), tsconfigPath),
    files: files.map(f => path.relative(process.cwd(), f)),
  };

  // Census. Within one run the identity
  //   reached(non-private) + dead == non-private
  // is true by construction (dead IS the non-private complement of reached), so it is
  // not a check on this run. It is emitted because it IS a check on the numbers a
  // DOCUMENT quotes, which is where the disagreements have actually happened: this
  // class's reach count has been written as both 65 and 66 and its dead surface as 13,
  // 7, 9 and 8. 65 + 8 = 73 non-private members holds; the 66 counts one extra NAME,
  // `ensureButtonStatesForMessage`, which is probed on the facade object and is not a
  // member of the class — reported separately below rather than folded into either
  // figure, because both are true and only one of them is a member count.
  const reachedNonPrivate = surface.filter(m => m.visibility !== 'private').length;
  const nonMemberProbes = [...receiver.nonMembers.values()]
    .map(r => ({ name: r.name, sites: r.sites }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const census = {
    nonPrivate: nonPrivate.length,
    reachedNonPrivate,
    dead: dead.length,
    reachedPrivate: surface.length - reachedNonPrivate,
    consistent: reachedNonPrivate + dead.length === nonPrivate.length,
    reachedClassMembers: surface.length,
    nonMemberProbes: nonMemberProbes.length,
    reachedNames: surface.length + nonMemberProbes.length,
  };

  const record = {
    tool: identity,
    census,
    classMembers: {
      total: members.size,
      private: [...members.values()].filter(m => m.visibility === 'private').length,
      nonPrivate: nonPrivate.length,
    },
    passes: {
      checker: {
        count: checker.hits.size,
        contributingFiles: [...checker.contributing].sort(),
        filesNotInProgram: checker.notInProgram,
        programFileCount: checker.programFiles,
      },
      receiver: { count: receiver.hits.size, contributingFiles: [...receiver.contributing].sort() },
      union: { count: surface.length, contributingFiles: [...new Set(surface.flatMap(m => m.files))].sort() },
      overApproximation: { count: overSurface.length, extras: overOnly.map(m => ({ name: m.name, sites: m.sites })) },
    },
    surface,
    nonMemberProbes,
    dead: {
      count: dead.length,
      tool: `${TOOL.name}@${TOOL.version} ${identity.mode}`,
      members: dead.map(m => ({ name: m.name, visibility: m.visibility, line: m.line, signature: m.signature })),
    },
  };

  if (args.json) fs.writeFileSync(args.json, `${JSON.stringify(record, null, 2)}\n`, 'utf8');

  const out = process.stdout;
  out.write(`reached-surface  (tool ${TOOL.name}@${TOOL.version}, typescript ${ts.version}, mode ${identity.mode})\n`);
  out.write(`  class      ${className} in ${identity.facade}  (${members.size} members: ${record.classMembers.nonPrivate} non-private, ${record.classMembers.private} private)\n`);
  out.write(`  reach sites scanned  ${files.length}\n`);
  out.write(`  receivers  ${receivers.join(', ')}\n`);
  out.write(`  checker    ${tsconfigPath.replace(`${process.cwd()}/`, '')} scope=${checkerScope} (${checker.programFiles} files in program)\n\n`);

  out.write(`| pass | members | files contributing |\n`);
  out.write(`| checker only        | ${String(checker.hits.size).padStart(3)} | ${[...checker.contributing].sort().map(f => path.basename(f)).join(', ') || 'none'} |\n`);
  out.write(`| receiver text       | ${String(receiver.hits.size).padStart(3)} | ${[...receiver.contributing].sort().map(f => path.basename(f)).join(', ') || 'none'} |\n`);
  out.write(`| UNION               | ${String(surface.length).padStart(3)} | ${record.passes.union.contributingFiles.map(f => path.basename(f)).join(', ') || 'none'} |\n`);
  out.write(`| over-approximation  | ${String(overSurface.length).padStart(3)} | sensitivity check |\n\n`);

  if (checker.notInProgram.length) {
    out.write(
      `The checker pass could not see ${checker.notInProgram.length} of the ${files.length} scanned files — they are not in\n` +
        `the program under this tsconfig: ${checker.notInProgram.map(f => path.basename(f)).join(', ')}\n` +
        `This is the checker-only trap. The union pass covers them.\n\n`
    );
  }
  const missedByChecker = surface.filter(m => !m.passes.includes('checker'));
  if (missedByChecker.length) {
    out.write(`${missedByChecker.length} member(s) the checker missed but the receiver-text pass found:\n`);
    for (const m of missedByChecker) out.write(`  ${m.name.padEnd(34)} ${m.sites.join(' ')}\n`);
    out.write('\n');
  }
  if (overOnly.length) {
    out.write(`Sensitivity check: ${overOnly.length} extra name(s) under the over-approximation. Check each by hand —\n`);
    out.write(`a false positive here is a same-named field elsewhere or a string discriminant, not a reach:\n`);
    for (const m of overOnly) out.write(`  ${m.name.padEnd(34)} ${m.sites.join(' ')}\n`);
    out.write('\n');
  }

  if (nonMemberProbes.length) {
    out.write(
      `${nonMemberProbes.length} name(s) probed ON the facade object that are NOT members of the class — part of\n` +
        `the compatibility boundary, and invisible to a members-only extractor:\n`
    );
    for (const p of nonMemberProbes) out.write(`  ${p.name.padEnd(34)} ${p.sites.join(' ')}\n`);
    out.write('\n');
  }

  out.write(`${surface.length} externally-reached members (union)`);
  out.write(census.reachedPrivate ? `, ${census.reachedPrivate} of them private (reached through an \`any\`).\n` : `.\n`);
  if (nonMemberProbes.length) {
    out.write(`${census.reachedNames} externally-reached NAMES (${surface.length} class members + ${nonMemberProbes.length} non-member probe(s)).\n`);
  }
  out.write(`${dead.length} dead surface — non-private, reached by nothing — per ${record.dead.tool}:\n`);
  for (const m of record.dead.members) out.write(`  ${m.name.padEnd(34)} ${identity.facade}:${m.line}\n`);
  out.write(
    `\nCensus check: reached(non-private) ${census.reachedNonPrivate} + dead ${census.dead} = ${census.reachedNonPrivate + census.dead} ` +
      `vs non-private members ${census.nonPrivate} — ${census.consistent ? 'consistent' : 'INCONSISTENT'}\n`
  );
  if (!census.consistent) {
    out.write(`A reach count that breaks this identity against its own dead count is arithmetically\nimpossible. Recount before quoting either number.\n`);
  }
  if (args.json) out.write(`\nwritten to ${args.json}\n`);
  return 0;
}

function cmdDiff(args) {
  const beforePath = args._[1] ?? args.before ?? die('usage: diff <before.json> <after.json>');
  const afterPath = args._[2] ?? args.after ?? die('usage: diff <before.json> <after.json>');
  const before = JSON.parse(fs.readFileSync(beforePath, 'utf8'));
  const after = JSON.parse(fs.readFileSync(afterPath, 'utf8'));

  const identityOf = r => [r.tool.name, r.tool.version, r.tool.mode, r.tool.class, (r.tool.receivers ?? []).join('+'), r.tool.checkerScope].join(' | ');
  const out = process.stdout;
  out.write(`reached-surface diff\n  before ${beforePath}\n         ${identityOf(before)}\n  after  ${afterPath}\n         ${identityOf(after)}\n\n`);
  if (identityOf(before) !== identityOf(after) && !args['allow-tool-mismatch']) {
    process.stderr.write(
      `ABORTED: the two captures were taken by different tool identities, so a difference\n` +
        `between them is not evidence about the code. Four hand-written extractors have\n` +
        `reported this class's dead surface as 13, 7, 9 and 8. Re-capture both sides with one\n` +
        `tool, or pass --allow-tool-mismatch if you really mean to compare tools.\n`
    );
    return 2;
  }

  const b = new Map(before.surface.map(m => [m.name, m]));
  const a = new Map(after.surface.map(m => [m.name, m]));
  const removed = [...b.keys()].filter(n => !a.has(n)).sort();
  const added = [...a.keys()].filter(n => !b.has(n)).sort();
  const changed = [...b.keys()]
    .filter(n => a.has(n) && a.get(n).signature !== b.get(n).signature)
    .sort();

  const bProbes = new Set((before.nonMemberProbes ?? []).map(p => p.name));
  const aProbes = new Set((after.nonMemberProbes ?? []).map(p => p.name));
  const probesRemoved = [...bProbes].filter(n => !aProbes.has(n)).sort();
  const probesAdded = [...aProbes].filter(n => !bProbes.has(n)).sort();

  out.write(`before ${before.surface.length} members, after ${after.surface.length} members\n`);
  if (bProbes.size || aProbes.size) {
    out.write(`before ${bProbes.size} non-member probe(s), after ${aProbes.size}\n`);
  }
  for (const n of probesRemoved) out.write(`  - (probe) ${n}\n`);
  for (const n of probesAdded) out.write(`  + (probe) ${n}\n`);
  const fileSetChanged = [...a.keys()]
    .filter(n => b.has(n) && b.get(n).files.join(',') !== a.get(n).files.join(','))
    .sort();
  for (const n of removed) out.write(`  - ${n}   ${b.get(n).signature}\n`);
  for (const n of added) out.write(`  + ${n}   ${a.get(n).signature}\n`);
  for (const n of changed) out.write(`  ~ ${n}\n      before ${b.get(n).signature}\n      after  ${a.get(n).signature}\n`);
  if (fileSetChanged.length) {
    out.write(`\nInformational — same members, different reach files (not a surface change):\n`);
    for (const n of fileSetChanged) out.write(`  ${n}: ${b.get(n).files.join(',')} → ${a.get(n).files.join(',')}\n`);
  }
  if (before.dead.count !== after.dead.count) {
    out.write(`\nDead surface: ${before.dead.count} → ${after.dead.count} (per ${after.dead.tool})\n`);
  }
  const total = removed.length + added.length + changed.length + probesRemoved.length + probesAdded.length;
  if (total === 0) {
    out.write(`\nEMPTY: the externally-reached surface is unchanged.\n`);
    return 0;
  }
  out.write(
    `\nNOT EMPTY: ${removed.length} removed, ${added.length} added, ${changed.length} signature change(s), ` +
      `${probesRemoved.length + probesAdded.length} non-member probe change(s).\n`
  );
  return 1;
}

function usage() {
  process.stdout.write(`reached-surface ${TOOL.version} — externally-reached-surface extractor

  extract --facade <ts> --class <Name> --files a.ts,b.ts,'dir/*.test.ts'
          [--receivers dataAccess,da] [--tsconfig <path>]
          [--checker-scope tsconfig|files] [--json <file>]

  diff    <before.json> <after.json> [--allow-tool-mismatch]

Exit codes: 0 ok / empty diff, 1 the surface changed, 2 misuse.
See scripts/refactor/README.md.
`);
  return 0;
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0];
const commands = { extract: cmdExtract, diff: cmdDiff };
if (!command || args.help || !commands[command]) process.exit(usage());
process.exit(commands[command](args));
