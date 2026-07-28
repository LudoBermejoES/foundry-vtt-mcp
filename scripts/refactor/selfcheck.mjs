#!/usr/bin/env node
/**
 * selfcheck — replays a verified past extraction pass through the two extractors.
 *
 * A tool that cannot reproduce a pass that already happened is not ready for the next
 * one, so the proof is history rather than a synthetic fixture. The body-diff extractor
 * is run across pass 5.3's actor-CRUD move (`3cbe106` → `7bf9c77`) and must land on the
 * recorded result: 25 of 27 moved items byte-identical, the two differences being
 * measured prettier reflows at `createActorFromCompendiumEntry` (90 → 104 columns) and
 * `addWfrp4eItems` (93 → 102), and a third site that lands at exactly 100 columns and is
 * left alone. The surface extractor is run over the current tree and must reproduce the
 * checker-only trap exactly.
 *
 * Follows the convention of scripts/mcp-schema-smoke-test.mjs: a plain node script, run
 * via `npm run test:refactor-tools`. It is deliberately NOT a vitest suite in either
 * workspace, so the 322 + 282 workspace test counts are untouched.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ts, sha256, tokenStream, compareTokens } from './lib/ts-source.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const plan = path.join(here, 'fixtures', 'extract-actor-crud.plan.json');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'refactor-selfcheck-'));

let failures = 0;
let checks = 0;
function check(label, condition, detail = '') {
  checks++;
  if (condition) {
    process.stdout.write(`  ok   ${label}\n`);
    return true;
  }
  failures++;
  process.stdout.write(`  FAIL ${label}${detail ? `\n         ${detail}` : ''}\n`);
  return false;
}

function git(args) {
  return execFileSync('git', args, { cwd: repo, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' });
}

function run(script, args) {
  try {
    const stdout = execFileSync(process.execPath, [path.join(here, script), ...args], {
      cwd: repo,
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'utf8',
    });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status ?? 1, stdout: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

// ── fixtures from history ────────────────────────────────────────────────────

const BASELINE_COMMIT = '3cbe106'; // parent of the deletion commit: the pass's own baseline
const DELETION_COMMIT = 'f4b0fd2'; // the deletion commit, one orphan banner later
const FINAL_COMMIT = '7bf9c77'; // pass 5.3 landed
const BASELINE_SHA256 = 'bb795e5f471d1c5c745c04d88b1a93009ff28f0e5ad9506c038b578610eab795';

const files = {};
try {
  files.baseline = path.join(tmp, 'data-access.baseline.ts');
  fs.writeFileSync(files.baseline, git(['show', `${BASELINE_COMMIT}:packages/foundry-module/src/data-access.ts`]));
  files.postDeletion = path.join(tmp, 'data-access.post-deletion.ts');
  fs.writeFileSync(files.postDeletion, git(['show', `${DELETION_COMMIT}:packages/foundry-module/src/data-access.ts`]));
  files.actual = path.join(tmp, 'actor-crud.final.ts');
  fs.writeFileSync(files.actual, git(['show', `${FINAL_COMMIT}:packages/foundry-module/src/actor-crud.ts`]));
} catch (err) {
  process.stderr.write(`selfcheck: cannot read the historical fixtures from git (${err.message})\n`);
  process.exit(2);
}

process.stdout.write(`refactor tooling selfcheck  (node ${process.version}, typescript ${ts.version})\n\n`);
process.stdout.write(`1. body-diff extractor, replaying pass 5.3 (${BASELINE_COMMIT} → ${FINAL_COMMIT})\n`);

check(
  'the baseline is the file the design recorded (sha256 bb795e5f…)',
  sha256(fs.readFileSync(files.baseline, 'utf8')) === BASELINE_SHA256,
  `got ${sha256(fs.readFileSync(files.baseline, 'utf8'))}`
);

const canonical = run('member-text.mjs', ['diff', '--baseline', files.baseline, '--actual', files.actual, '--plan', plan]);
check('exits 0 — every difference is enumerated or a measured reflow', canonical.code === 0, canonical.stdout.slice(-800));
check('25 of 27 items byte-identical', canonical.stdout.includes('25 of 27 items byte-identical'));
check('exactly 2 reflow-only items', /\n2 reflow-only\n/.test(canonical.stdout));
check('37 substitutions applied (34 re-pointings + 3 export keywords)', /\n {3}37 {2}total/.test(canonical.stdout));
check(
  'createActorFromCompendiumEntry measured 90 → 104 columns',
  canonical.stdout.includes('createActorFromCompendiumEntry: 90 → 104 cols')
);
check('addWfrp4eItems measured 93 → 102 columns', canonical.stdout.includes('addWfrp4eItems: 93 → 102 cols'));
check(
  'the third-longest site lands at exactly 100 columns and prettier leaves it',
  canonical.stdout.includes('createNpcActor: 86 → 100 cols  <-- exactly at the limit')
);
check('35 of 37 sites stay within the print width', canonical.stdout.includes('35 of 37 stay within the print width'));

process.stdout.write(`\n2. a dropped comment is a hard failure, not a reflow (baseline at ${DELETION_COMMIT})\n`);
const dropped = run('member-text.mjs', ['diff', '--baseline', files.postDeletion, '--actual', files.actual, '--plan', plan]);
check('exits 1', dropped.code === 1);
check('reports ActorCreationResult as DIFFERS', /ActorCreationResult\s+DIFFERS/.test(dropped.stdout));
check(
  'names the dropped banner comment as the first token divergence',
  dropped.stdout.includes('"kind":"Comment","text":"// Phase 2: Write Operation Interfaces"')
);
check('the two reflows are still classified as reflow-only', /\n2 reflow-only\n/.test(dropped.stdout));

process.stdout.write(`\n3. a wrong substitution count aborts instead of applying the wrong number of edits\n`);
const wrongPlan = path.join(tmp, 'wrong-count.plan.json');
const planJson = JSON.parse(fs.readFileSync(plan, 'utf8'));
planJson.substitutions.find(s => s.from === 'this.auditLog(').count = 12; // 5.3's stage-B error
fs.writeFileSync(wrongPlan, JSON.stringify(planJson, null, 2));
const aborted = run('member-text.mjs', ['diff', '--baseline', files.baseline, '--actual', files.actual, '--plan', wrongPlan]);
check('exits 2', aborted.code === 2);
check('says nothing was compared', aborted.stdout.includes('Nothing was compared'));
check('reports declared 12 vs measured 15', /plan declares 12 occurrence\(s\), measured 15/.test(aborted.stdout));

process.stdout.write(`\n4. an enumerated deletion makes a disclosed removal pass\n`);
const withDeletion = path.join(tmp, 'with-deletion.plan.json');
const planJson2 = JSON.parse(fs.readFileSync(plan, 'utf8'));
planJson2.deletions = [
  { text: '// Phase 2: Write Operation Interfaces\n', items: ['ActorCreationResult'], count: 1 },
];
fs.writeFileSync(withDeletion, JSON.stringify(planJson2, null, 2));
const disclosed = run('member-text.mjs', ['diff', '--baseline', files.postDeletion, '--actual', files.actual, '--plan', withDeletion]);
check('exits 0 once the banner deletion is enumerated', disclosed.code === 0, disclosed.stdout.slice(-600));
check('25 of 27 byte-identical again', disclosed.stdout.includes('25 of 27 items byte-identical'));

process.stdout.write(`\n5. token identity comes from the parser, not ts.createScanner\n`);
// A member whose body reflows across a template-literal boundary. `ts.createScanner`
// does not re-scan template continuations: it reads the head, then swallows the rest of
// the member into one token and reports a bogus difference. The parser does not.
const before = [
  '  async report(actor: string): Promise<void> {',
  '    this.security.auditLog(`actor ${actor} updated with ${this.count} items`, { actor }, "ok");',
  '  }',
].join('\n');
const after = [
  '  async report(actor: string): Promise<void> {',
  '    this.security.auditLog(',
  '      `actor ${actor} updated with ${this.count} items`,',
  '      { actor },',
  '      "ok"',
  '    );',
  '  }',
].join('\n');
const parserCmp = compareTokens(tokenStream(before, { wrap: 'class' }).tokens, tokenStream(after, { wrap: 'class' }).tokens);
check('the parser calls a pure reflow across a template literal token-identical', parserCmp.identical, JSON.stringify(parserCmp));

function scannerTokens(text) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, /* skipTrivia */ true, ts.LanguageVariant.Standard, text);
  const out = [];
  let kind = scanner.scan();
  while (kind !== ts.SyntaxKind.EndOfFileToken) {
    out.push({ kind: ts.SyntaxKind[kind], text: scanner.getTokenText() });
    kind = scanner.scan();
  }
  return out;
}
const scannerCmp = compareTokens(scannerTokens(before), scannerTokens(after));
check(
  'a raw ts.createScanner reports a bogus difference on the same reflow (the documented trap)',
  !scannerCmp.identical,
  'the scanner agreed — re-check whether this TypeScript version still mis-scans template continuations'
);

// A dropped comment must never look like a reflow.
const withComment = before.replace('    this.security', '    // audit the write\n    this.security');
const commentCmp = compareTokens(tokenStream(withComment, { wrap: 'class' }).tokens, tokenStream(before, { wrap: 'class' }).tokens);
check('a dropped comment is a token difference', !commentCmp.identical);

process.stdout.write(`\n6. surface extractor: the checker-only trap, on the current tree\n`);
const srcDir = 'packages/foundry-module/src';
const surfaceArgs = [
  'extract',
  '--facade',
  `${srcDir}/data-access.ts`,
  '--class',
  'FoundryDataAccess',
  '--files',
  [`${srcDir}/queries.ts`, `${srcDir}/main.ts`, `${srcDir}/settings.ts`, `${srcDir}/socket-bridge.ts`, `${srcDir}/*.test.ts`, `${srcDir}/__fixtures__/fake-foundry.ts`].join(','),
  '--tsconfig',
  'packages/foundry-module/tsconfig.json',
  '--json',
  path.join(tmp, 'surface.json'),
];
const surface = run('reached-surface.mjs', surfaceArgs);
check('exits 0', surface.code === 0, surface.stdout.slice(-600));
const capture = JSON.parse(fs.readFileSync(path.join(tmp, 'surface.json'), 'utf8'));
check(
  'checker-only finds 62 members from 2 files — the recorded trap',
  capture.passes.checker.count === 62 && capture.passes.checker.contributingFiles.length === 2,
  `got ${capture.passes.checker.count} from ${capture.passes.checker.contributingFiles.length} files`
);
// Derived, not frozen: the tsconfig excludes `**/*.test.*` and `src/__fixtures__/**`, so
// exactly the test files and the fixture are invisible to the checker. Asserting a count
// instead went stale the moment a pass added a sixth test file (`character-reader.test.ts`,
// the characterization precondition for 5.2) — a green tool reported red for a reason that
// was not about the code, which is the failure mode this whole file exists to prevent.
const isTestOrFixture = f => /\.test\.ts$/.test(f) || f.includes('/__fixtures__/');
const scanned = capture.tool.files;
check(
  'the checker cannot see any test file or the fixture, and can see everything else',
  capture.passes.checker.filesNotInProgram.slice().sort().join(',') ===
    scanned.filter(isTestOrFixture).sort().join(','),
  `notInProgram=[${capture.passes.checker.filesNotInProgram.join(', ')}] scanned-test-or-fixture=[${scanned.filter(isTestOrFixture).join(', ')}]`
);
// 65 is the gate figure and is asserted exactly. The contributing-file list is derived:
// every scanned file reaches the facade except the ones named here, each of which does not
// touch `FoundryDataAccess` at all:
//   - `socket-bridge.ts`      — transport; it dispatches to CONFIG.queries, never to the facade.
//   - `__fixtures__/`         — the fake Foundry world, which the facade is driven against.
//   - `wire-format.test.ts`, `webrtc-connection.test.ts` — transport tests added by
//     lift-bridge-per-document-size-ceiling, for the same reason as socket-bridge.ts.
// Named rather than counted, exactly as the comment above records: a green tool must not
// report red because a pass added a test file that was never about this class.
const nonReachingScanned = [
  '/socket-bridge.ts',
  '/wire-format.test.ts',
  '/webrtc-connection.test.ts',
];
const expectedContributors = scanned
  .filter(f => !nonReachingScanned.some(suffix => f.endsWith(suffix)) && !f.includes('/__fixtures__/'))
  .sort();
check(
  'the union finds 65 members, contributed by every scanned file that reaches the facade',
  capture.passes.union.count === 65 &&
    capture.passes.union.contributingFiles.slice().sort().join(',') ===
      expectedContributors.join(','),
  `got ${capture.passes.union.count} across [${capture.passes.union.contributingFiles.join(', ')}]`
);
const missed = capture.surface.filter(m => !m.passes.includes('checker')).map(m => m.name);
check(
  'the three members the checker misses inside a file it does see are named',
  ['attachRollButtonHandlers', 'saveRollState', 'updateRollButtonMessage'].every(n => missed.includes(n)) && missed.length === 3,
  missed.join(', ')
);
// The invariant is "every extra is explainable and none is a real reach", not a frozen
// name list. Two are documented in the README and live in shipped files: `moduleId` is
// settings.ts's own private field, `requestRollStateSave` is a socket-message discriminant
// at main.ts:550. Everything else must be sited ONLY inside a test file — those are
// `describe('<memberName>', …)` titles, which the sensitivity pass counts as bare string
// literals by design. An extra appearing in queries.ts / main.ts / settings.ts that is NOT
// one of the two documented names is a possible real reach and fails here.
const overExtras = capture.passes.overApproximation.extras;
const documentedFalsePositives = ['moduleId', 'requestRollStateSave'];
const siteIsTestOrFixture = s => isTestOrFixture(s.replace(/:\d+$/, ''));
const unexplained = overExtras.filter(
  e => !documentedFalsePositives.includes(e.name) && !e.sites.every(siteIsTestOrFixture)
);
check(
  'every over-approximation extra is explainable: the two documented ones, else test-file-only',
  documentedFalsePositives.every(n => overExtras.some(e => e.name === n)) &&
    unexplained.length === 0,
  `unexplained=[${unexplained.map(e => `${e.name} @ ${e.sites.join(' ')}`).join('; ')}] all=[${overExtras.map(e => e.name).join(', ')}]`
);
check('the census is internally consistent', capture.census.consistent === true, JSON.stringify(capture.census));
check(
  'reconciles the record\'s 65 and 66: 65 class members + the ensureButtonStatesForMessage probe',
  capture.census.reachedNames === 66 && capture.nonMemberProbes.length === 1 && capture.nonMemberProbes[0].name === 'ensureButtonStatesForMessage',
  JSON.stringify(capture.nonMemberProbes)
);
process.stdout.write(`  info dead surface on this tree: ${capture.dead.count} per ${capture.dead.tool}\n`);

process.stdout.write(`\n7. a surface capture diffed against itself is empty; a tool mismatch aborts\n`);
const same = run('reached-surface.mjs', ['diff', path.join(tmp, 'surface.json'), path.join(tmp, 'surface.json')]);
check('exits 0 and says EMPTY', same.code === 0 && same.stdout.includes('EMPTY'));
const mutated = JSON.parse(fs.readFileSync(path.join(tmp, 'surface.json'), 'utf8'));
mutated.tool.version = '0.9.0';
mutated.tool.receivers = ['dataAccess'];
fs.writeFileSync(path.join(tmp, 'surface.other-tool.json'), JSON.stringify(mutated));
const mismatch = run('reached-surface.mjs', ['diff', path.join(tmp, 'surface.json'), path.join(tmp, 'surface.other-tool.json')]);
check('refuses to compare captures from different tool identities', mismatch.code === 2 && mismatch.stdout.includes('ABORTED'));

process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
