#!/usr/bin/env node
/**
 * member-text — per-member body-diff extractor for the data-access extraction passes.
 *
 * Proves that a member which moved from one file to another moved VERBATIM, by
 * comparing a baseline copy of the source file against the post-move file member by
 * member, with the pass's enumerated re-pointings applied to the baseline first.
 *
 *   extract   emit each member's full text (JSDoc and inline comments included)
 *   closure   the transitive module-scope closure of a moving member set
 *   diff      baseline + counted substitutions  vs  actual, per item
 *
 * Design notes that are load-bearing, all of them paid for by a previous pass:
 *
 *  - `getFullText()`, not `getText()`. A dropped comment must not pass as equivalent.
 *  - A WRONG SUBSTITUTION COUNT ABORTS. It does not apply as many edits as it can
 *    find. Pass 5.3's per-stage counts were wrong in three stages out of four while
 *    the global total was exactly right; the abort turned each into a caught
 *    discrepancy instead of a silent one.
 *  - Formatter reflow is MEASURED, from the column width of each substitution site
 *    against the print width, and then cross-checked against what actually differs.
 *    Neither "the substitution is long so it will reflow" nor "it is short so it
 *    won't" is acceptable evidence: 5.1 asserted the second and 5.3 measured a site
 *    landing at exactly 100 columns that prettier left alone.
 *  - Token identity comes from the parser (see lib/ts-source.mjs), never from
 *    `ts.createScanner`.
 *
 * Run: node scripts/refactor/member-text.mjs <command> [flags]   (no build step)
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  ts,
  readSource,
  sha256,
  extractMembers,
  extractModuleScope,
  moduleScopeClosure,
  tokenStream,
  compareTokens,
  measureSites,
  normalizeItemText,
  parseArgs,
  parseList,
} from './lib/ts-source.mjs';

const TOOL = { name: 'member-text', version: '1.0.0' };

function toolIdentity(extra = {}) {
  return {
    ...TOOL,
    typescript: ts.version,
    node: process.version,
    ...extra,
  };
}

function die(message) {
  process.stderr.write(`member-text: ${message}\n`);
  process.exit(2);
}

// ── line diff (LCS), so a real difference is readable ─────────────────────────

function lineDiff(expected, actual) {
  const a = expected.split('\n');
  const b = actual.split('\n');
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ tag: ' ', line: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ tag: '-', line: a[i++] });
    } else {
      out.push({ tag: '+', line: b[j++] });
    }
  }
  while (i < n) out.push({ tag: '-', line: a[i++] });
  while (j < m) out.push({ tag: '+', line: b[j++] });
  // keep only changed hunks with two lines of context
  const keep = new Set();
  out.forEach((row, idx) => {
    if (row.tag === ' ') return;
    for (let k = Math.max(0, idx - 2); k <= Math.min(out.length - 1, idx + 2); k++) keep.add(k);
  });
  const rendered = [];
  let gap = false;
  out.forEach((row, idx) => {
    if (keep.has(idx)) {
      rendered.push(`${row.tag}${row.line}`);
      gap = false;
    } else if (!gap) {
      rendered.push('@@');
      gap = true;
    }
  });
  return rendered.join('\n');
}

// ── commands ─────────────────────────────────────────────────────────────────

function collectItems(filePath, className, memberNames, moduleNames) {
  const { sourceFile } = readSource(filePath);
  const items = [];
  if (memberNames?.length) {
    if (!className) die(`--class is required to extract members from ${filePath}`);
    items.push(...extractMembers(sourceFile, className, memberNames));
  } else if (className && memberNames === null) {
    items.push(...extractMembers(sourceFile, className, null));
  }
  if (moduleNames?.length) items.push(...extractModuleScope(sourceFile, moduleNames));
  return { sourceFile, items };
}

function cmdExtract(args) {
  const filePath = args.file ?? die('--file is required');
  const className = args.class ?? null;
  const memberNames = parseList(args.members);
  const moduleNames = parseList(args['module-scope']);
  const { sourceFile, items } = collectItems(filePath, className, memberNames, moduleNames);

  const text = fs.readFileSync(filePath, 'utf8');
  const record = {
    tool: toolIdentity({ command: 'extract' }),
    file: path.relative(process.cwd(), filePath),
    fileSha256: sha256(text),
    fileLines: text.split('\n').length,
    class: className,
    items: items.map(i => ({ ...i, fullText: undefined, textSha256: i.sha256 })),
    totalBodyLines: items.reduce((s, i) => s + i.bodyLines, 0),
  };

  if (args.out) {
    fs.mkdirSync(args.out, { recursive: true });
    for (const item of items) {
      fs.writeFileSync(path.join(args.out, `${item.scope}.${item.name}.txt`), item.fullText, 'utf8');
    }
    fs.writeFileSync(path.join(args.out, 'index.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  }
  if (args.json) fs.writeFileSync(args.json, `${JSON.stringify(record, null, 2)}\n`, 'utf8');

  if (args.quiet) return 0;
  process.stdout.write(`${record.file}  sha256 ${record.fileSha256}  ${record.fileLines} lines\n`);
  process.stdout.write(`${items.length} items, ${record.totalBodyLines} body lines (tool ${TOOL.name}@${TOOL.version}, typescript ${ts.version})\n\n`);
  const w = Math.max(...items.map(i => i.name.length), 4);
  process.stdout.write(`${'item'.padEnd(w)}  scope   vis        lines        n  sha256\n`);
  for (const i of items) {
    process.stdout.write(
      `${i.name.padEnd(w)}  ${i.scope.padEnd(6)}  ${i.visibility.padEnd(9)}  ${String(i.startLine).padStart(5)}-${String(i.endLine).padEnd(5)} ${String(i.bodyLines).padStart(4)}  ${i.sha256.slice(0, 12)}\n`
    );
  }
  if (args.out) process.stdout.write(`\nwritten to ${args.out}/\n`);
  return 0;
}

function cmdClosure(args) {
  const filePath = args.file ?? die('--file is required');
  const className = args.class ?? die('--class is required');
  const memberNames = parseList(args.members) ?? die('--members is required');
  const { sourceFile } = readSource(filePath);
  const members = extractMembers(sourceFile, className, memberNames);
  const closure = moduleScopeClosure(sourceFile, members.map(m => m.fullText));
  const oneHop = new Set(
    extractModuleScope(sourceFile)
      .filter(d => members.some(m => new RegExp(`(^|[^\\w$.])${d.name}([^\\w$]|$)`).test(m.fullText)))
      .map(d => d.name)
  );
  const record = {
    tool: toolIdentity({ command: 'closure' }),
    file: path.relative(process.cwd(), filePath),
    class: className,
    members: memberNames,
    closure: closure.map(d => ({
      name: d.name,
      kind: d.kind,
      lines: `${d.startLine}-${d.endLine}`,
      reach: oneHop.has(d.name) ? 'one-hop' : 'transitive-only',
    })),
  };
  if (args.json) fs.writeFileSync(args.json, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  process.stdout.write(`${closure.length} module-scope declarations must travel (tool ${TOOL.name}@${TOOL.version})\n`);
  for (const d of record.closure) {
    process.stdout.write(`  ${d.name.padEnd(28)} ${d.kind.padEnd(22)} ${d.lines.padEnd(12)} ${d.reach}\n`);
  }
  const transitive = record.closure.filter(d => d.reach === 'transitive-only');
  if (transitive.length) {
    process.stdout.write(
      `\n${transitive.length} of these are reached ONLY from another top-level declaration, not from any\n` +
        `moving member: ${transitive.map(d => d.name).join(', ')}.\n` +
        `A one-hop query ("which module-level names do the moved bodies mention?") misses these.\n`
    );
  }
  return 0;
}

function loadPlan(planPath) {
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  plan.printWidth ??= 100;
  plan.members ??= [];
  plan.moduleScope ??= [];
  plan.substitutions ??= [];
  plan.deletions ??= [];
  for (const d of plan.deletions) {
    if (typeof d.text !== 'string') die(`deletion needs a string "text": ${JSON.stringify(d)}`);
    if (d.count === undefined) die(`deletion ${JSON.stringify(d.text)} declares no expected "count"`);
  }
  for (const s of plan.substitutions) {
    if (typeof s.from !== 'string' || typeof s.to !== 'string') die(`substitution needs string "from" and "to": ${JSON.stringify(s)}`);
    if (s.count === undefined && s.perItem === undefined) {
      die(`substitution ${JSON.stringify(s.from)} declares no expected "count" (or "perItem"). A substitution with no expected count cannot abort on a wrong one, which is the whole point.`);
    }
  }
  return plan;
}

function applySubstitutions(items, plan) {
  const tally = [];
  const siteReport = [];
  const abort = [];
  const substituted = new Map();
  for (const item of items) substituted.set(item.name, item.fullText);

  for (const sub of plan.substitutions) {
    const scoped = sub.items ? new Set(sub.items) : null;
    const perItemActual = {};
    let total = 0;
    for (const item of items) {
      if (scoped && !scoped.has(item.name)) continue;
      const before = substituted.get(item.name);
      const occurrences = before.split(sub.from).length - 1;
      if (occurrences === 0) continue;
      const beforeSites = measureSites(before, sub.from);
      const after = before.split(sub.from).join(sub.to);
      substituted.set(item.name, after);
      perItemActual[item.name] = occurrences;
      total += occurrences;
      // Neither `from` nor `to` may contain a newline, so line indices are stable
      // across every substitution; the before/after column widths are therefore
      // measured against the ORIGINAL and FINAL text of the same line, below.
      for (const bs of beforeSites) {
        siteReport.push({
          item: item.name,
          from: sub.from,
          to: sub.to,
          lineInItem: bs.line,
          lineInFile: item.fullStartLine + bs.line - 1,
        });
      }
    }
    const declared = sub.count;
    tally.push({ from: sub.from, to: sub.to, declared, measured: total, perItem: perItemActual });
    if (declared !== undefined && declared !== total) {
      abort.push(`substitution ${JSON.stringify(sub.from)} → ${JSON.stringify(sub.to)}: plan declares ${declared} occurrence(s), measured ${total} (${Object.entries(perItemActual).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'})`);
    }
    if (sub.perItem) {
      for (const [name, expected] of Object.entries(sub.perItem)) {
        const got = perItemActual[name] ?? 0;
        if (got !== expected) abort.push(`substitution ${JSON.stringify(sub.from)} in ${name}: plan declares ${expected}, measured ${got}`);
      }
      for (const [name, got] of Object.entries(perItemActual)) {
        if (!(name in sub.perItem)) abort.push(`substitution ${JSON.stringify(sub.from)} occurs ${got}× in ${name}, which the plan's perItem map does not list`);
      }
    }
  }

  // residual check: the old form must not survive, unless `to` contains `from`
  // (e.g. adding an `export` keyword), in which case the check is meaningless.
  const residual = [];
  for (const sub of plan.substitutions) {
    if (sub.to.includes(sub.from)) continue;
    if (sub.residual === false) continue;
    for (const item of items) {
      if (sub.items && !sub.items.includes(item.name)) continue;
      const left = substituted.get(item.name).split(sub.from).length - 1;
      if (left > 0) residual.push(`${JSON.stringify(sub.from)} still occurs ${left}× in ${item.name} after substitution`);
    }
  }

  // Column widths: original line vs post-substitution line, at every substitution
  // site. This is the measurement that makes a reflow a prediction instead of an
  // assumption. Measured BEFORE any enumerated deletion, because a deletion may
  // remove a line and break the line-index alignment the measurement relies on.
  const originalLines = new Map(items.map(i => [i.name, i.fullText.split('\n')]));
  const substitutedLines = new Map(items.map(i => [i.name, substituted.get(i.name).split('\n')]));
  const width = line => (line ?? '').replace(/\s+$/, '').length;
  for (const site of siteReport) {
    site.before = width(originalLines.get(site.item)[site.lineInItem - 1]);
    site.after = width(substitutedLines.get(site.item)[site.lineInItem - 1]);
    site.overPrintWidth = site.after > plan.printWidth;
    site.atPrintWidth = site.after === plan.printWidth;
    site.finalText = substitutedLines.get(site.item)[site.lineInItem - 1]?.trim();
  }
  for (const sub of plan.substitutions) {
    if (sub.from.includes('\n') || sub.to.includes('\n')) {
      abort.push(`substitution ${JSON.stringify(sub.from)} spans a newline; column measurement assumes it does not`);
    }
  }

  // Enumerated deletions: a disclosed removal (in practice always an orphan section
  // banner that labels nothing once the members below it have moved). Kept separate
  // from re-pointings because it is a different kind of claim, and excluded from the
  // column measurement because it may span lines. Every pass so far has had at least
  // one; 5.3 had two and had only listed one in advance.
  const deletionTally = [];
  for (const del of plan.deletions) {
    const scoped = del.items ? new Set(del.items) : null;
    let total = 0;
    const perItemActual = {};
    for (const item of items) {
      if (scoped && !scoped.has(item.name)) continue;
      const before = substituted.get(item.name);
      const occurrences = before.split(del.text).length - 1;
      if (occurrences === 0) continue;
      substituted.set(item.name, before.split(del.text).join(''));
      perItemActual[item.name] = occurrences;
      total += occurrences;
    }
    deletionTally.push({ text: del.text, declared: del.count, measured: total, perItem: perItemActual });
    if (del.count !== total) {
      abort.push(`deletion ${JSON.stringify(del.text)}: plan declares ${del.count} occurrence(s), measured ${total}`);
    }
  }

  return { substituted, tally, deletionTally, siteReport, abort, residual };
}

function cmdDiff(args) {
  const planPath = args.plan ?? die('--plan is required (see scripts/refactor/README.md)');
  const plan = loadPlan(planPath);
  const baselinePath = args.baseline ?? die('--baseline is required');
  const actualPath = args.actual ?? die('--actual is required');
  const only = parseList(args.items);

  const memberNames = only ? plan.members.filter(n => only.includes(n)) : plan.members;
  const moduleNames = only ? plan.moduleScope.filter(n => only.includes(n)) : plan.moduleScope;

  const baseline = collectItems(baselinePath, args['baseline-class'] ?? plan.baselineClass ?? null, memberNames, moduleNames);
  const actual = collectItems(actualPath, args['actual-class'] ?? plan.actualClass ?? null, memberNames, moduleNames);

  const { substituted, tally, deletionTally, siteReport, abort, residual } = applySubstitutions(baseline.items, plan);

  if (abort.length) {
    process.stderr.write(`\nABORTED — substitution counts do not match the plan.\n\n`);
    for (const line of abort) process.stderr.write(`  ${line}\n`);
    process.stderr.write(
      `\nNothing was compared. A wrong count means the plan's cross-boundary inventory is\n` +
        `wrong, and applying "as many as we can find" would hide that. Fix the plan (or the\n` +
        `code) and re-run.\n`
    );
    return 2;
  }
  if (residual.length) {
    process.stderr.write(`\nABORTED — the pre-move form survives after substitution:\n\n`);
    for (const line of residual) process.stderr.write(`  ${line}\n`);
    return 2;
  }

  const actualByName = new Map(actual.items.map(i => [i.name, i]));
  const results = [];
  for (const item of baseline.items) {
    const expectedText = normalizeItemText(substituted.get(item.name));
    const got = actualByName.get(item.name);
    if (!got) {
      results.push({ name: item.name, scope: item.scope, verdict: 'MISSING', detail: `not present in ${actualPath}` });
      continue;
    }
    const actualText = normalizeItemText(got.fullText);
    const predicted = siteReport.filter(s => s.item === item.name && s.overPrintWidth);
    if (expectedText === actualText) {
      results.push({ name: item.name, scope: item.scope, verdict: 'byte-identical', predictedReflow: predicted.length });
      continue;
    }
    const wrap = item.scope === 'member' ? 'class' : 'none';
    const a = tokenStream(expectedText, { wrap });
    const b = tokenStream(actualText, { wrap });
    const cmp = compareTokens(a.tokens, b.tokens);
    if (cmp.identical) {
      results.push({
        name: item.name,
        scope: item.scope,
        verdict: predicted.length ? 'reflow-only' : 'REFLOW-UNEXPLAINED',
        predictedReflow: predicted.length,
        tokens: a.tokens.length,
        diff: lineDiff(expectedText, actualText),
      });
    } else {
      results.push({
        name: item.name,
        scope: item.scope,
        verdict: 'DIFFERS',
        predictedReflow: predicted.length,
        firstTokenDiff: cmp,
        diff: lineDiff(expectedText, actualText),
      });
    }
  }

  const counts = results.reduce((acc, r) => {
    acc[r.verdict] = (acc[r.verdict] ?? 0) + 1;
    return acc;
  }, {});
  const bad = results.filter(r => r.verdict === 'DIFFERS' || r.verdict === 'MISSING' || r.verdict === 'REFLOW-UNEXPLAINED');
  const unrealizedPredictions = results.filter(r => r.verdict === 'byte-identical' && r.predictedReflow > 0);

  const record = {
    tool: toolIdentity({ command: 'diff' }),
    plan: path.relative(process.cwd(), planPath),
    baseline: { file: path.relative(process.cwd(), baselinePath), sha256: sha256(fs.readFileSync(baselinePath, 'utf8')) },
    actual: { file: path.relative(process.cwd(), actualPath), sha256: sha256(fs.readFileSync(actualPath, 'utf8')) },
    printWidth: plan.printWidth,
    items: baseline.items.length,
    substitutions: tally,
    deletions: deletionTally,
    sites: siteReport,
    results: results.map(r => ({ ...r, diff: undefined })),
    counts,
    ok: bad.length === 0,
  };
  if (args.json) fs.writeFileSync(args.json, `${JSON.stringify(record, null, 2)}\n`, 'utf8');

  // ── report ──
  const out = process.stdout;
  out.write(`member-text diff  (tool ${TOOL.name}@${TOOL.version}, typescript ${ts.version})\n`);
  out.write(`  baseline  ${record.baseline.file}  sha256 ${record.baseline.sha256.slice(0, 16)}\n`);
  out.write(`  actual    ${record.actual.file}  sha256 ${record.actual.sha256.slice(0, 16)}\n`);
  out.write(`  plan      ${record.plan}   printWidth ${plan.printWidth}\n\n`);

  out.write(`Substitutions applied to the baseline (declared == measured, else abort):\n`);
  for (const t of tally) {
    out.write(`  ${String(t.measured).padStart(3)}  ${t.from} → ${t.to}\n`);
  }
  const totalSubs = tally.reduce((s, t) => s + t.measured, 0);
  out.write(`  ${String(totalSubs).padStart(3)}  total\n\n`);

  if (deletionTally.length) {
    out.write(`Enumerated deletions (disclosed removals, not re-pointings):\n`);
    for (const d of deletionTally) {
      out.write(`  ${String(d.measured).padStart(3)}  ${JSON.stringify(d.text)} in ${Object.keys(d.perItem).join(', ') || '(nothing)'}\n`);
    }
    out.write('\n');
  }

  const over = siteReport.filter(s => s.overPrintWidth);
  const atLimit = siteReport.filter(s => s.atPrintWidth);
  const widest = [...siteReport].sort((a, b) => (b.after ?? 0) - (a.after ?? 0)).slice(0, 5);
  out.write(`Column widths at the ${siteReport.length} substitution sites, against printWidth ${plan.printWidth}:\n`);
  out.write(`  ${siteReport.length - over.length} of ${siteReport.length} stay within the print width; ${over.length} cross it.\n`);
  for (const s of widest) {
    const flag = s.overPrintWidth ? '  <-- predicted reflow' : s.atPrintWidth ? '  <-- exactly at the limit; prettier leaves it' : '';
    out.write(`  ${s.item}: ${s.before} → ${s.after} cols${flag}\n`);
  }
  if (atLimit.length && !widest.some(w => w.atPrintWidth)) {
    for (const s of atLimit) out.write(`  ${s.item}: ${s.before} → ${s.after} cols  <-- exactly at the limit; prettier leaves it\n`);
  }
  out.write('\n');

  out.write(`Per-item verdicts (${baseline.items.length} items):\n`);
  const w = Math.max(...results.map(r => r.name.length), 4);
  for (const r of results) {
    out.write(`  ${r.name.padEnd(w)}  ${r.verdict}${r.predictedReflow ? `  (${r.predictedReflow} predicted reflow site${r.predictedReflow > 1 ? 's' : ''})` : ''}\n`);
  }
  out.write('\n');
  const identical = counts['byte-identical'] ?? 0;
  out.write(`${identical} of ${baseline.items.length} items byte-identical after the enumerated substitutions.\n`);
  for (const [verdict, n] of Object.entries(counts)) {
    if (verdict === 'byte-identical') continue;
    out.write(`${n} ${verdict}\n`);
  }

  for (const r of results) {
    if (r.verdict === 'byte-identical' || !r.diff) continue;
    out.write(`\n─── ${r.name} (${r.verdict}) ───\n${r.diff}\n`);
    if (r.firstTokenDiff) {
      out.write(`first token divergence at index ${r.firstTokenDiff.index}: expected ${JSON.stringify(r.firstTokenDiff.expected)} got ${JSON.stringify(r.firstTokenDiff.actual)}\n`);
    }
  }

  if (unrealizedPredictions.length) {
    out.write(
      `\nNote: ${unrealizedPredictions.length} item(s) had a site measured over the print width but came out\n` +
        `byte-identical — prettier did not reflow. That is a wrong prediction, not a defect:\n` +
        `${unrealizedPredictions.map(r => r.name).join(', ')}\n`
    );
  }
  if (bad.length) {
    out.write(
      `\nFAIL: ${bad.length} item(s) differ beyond the enumerated substitutions. The rule the passes\n` +
        `settled on is to RESTORE the pre-move text, not to justify the difference in review.\n`
    );
    return 1;
  }
  out.write(`\nOK: every difference is an enumerated substitution or a measured reflow.\n`);
  return 0;
}

function usage() {
  process.stdout.write(`member-text ${TOOL.version} — per-member body-diff extractor

  extract  --file <ts> [--class <Name>] [--members a,b] [--module-scope X,Y]
           [--out <dir>] [--json <file>] [--quiet]

  closure  --file <ts> --class <Name> --members a,b [--json <file>]

  diff     --baseline <ts> --actual <ts> --plan <plan.json>
           [--baseline-class <Name>] [--actual-class <Name>] [--items a,b]
           [--json <file>]

Exit codes: 0 ok, 1 a real difference, 2 aborted (bad plan / wrong count).
See scripts/refactor/README.md for the plan format and a worked example.
`);
  return 0;
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0];
const commands = { extract: cmdExtract, closure: cmdClosure, diff: cmdDiff };
if (!command || args.help || !commands[command]) process.exit(usage());
process.exit(commands[command](args));
