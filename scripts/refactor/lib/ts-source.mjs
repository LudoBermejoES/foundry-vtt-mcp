/**
 * Shared TypeScript-compiler-API helpers for the refactor-verification scripts.
 *
 * These exist because four consecutive extraction passes (5.0 actor-mechanics,
 * 5.1 compendium-search, 5.3 actor-crud, and their proposals) each hand-wrote the
 * same member visitor in scratch space and threw it away. Everything here is
 * read-only: nothing in this directory is shipped, bundled, or imported by the
 * `src` tree of either package.
 *
 * Two hard-won rules are encoded here rather than left to the caller:
 *
 *  1. Token identity is computed from the PARSER, never from `ts.createScanner`.
 *     A raw scanner does not re-scan template-literal continuations: it reads the
 *     head of a template, then swallows the remainder of the member into one bogus
 *     token and reports a difference on a body that was merely reflowed. The parser
 *     re-scans correctly, so `node.getChildren()` down to leaf tokens is the only
 *     trustworthy token stream. (Found by pass 5.3.)
 *
 *  2. Comments are emitted INTO the token stream, in source position. A dropped
 *     JSDoc block or a dropped inline comment therefore cannot masquerade as a
 *     formatter reflow — it shows up as a missing token.
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import ts from 'typescript';

export { ts };

/** Read a file and parse it. `setParentNodes` is required for `getChildren()`. */
export function readSource(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const sourceFile = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return { filePath, text, sourceFile };
}

export function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The name of a class member, or null for things with no static name. */
export function memberName(member) {
  if (member.name) {
    if (ts.isIdentifier(member.name) || ts.isPrivateIdentifier(member.name)) return member.name.text;
    if (ts.isStringLiteral(member.name) || ts.isNumericLiteral(member.name)) return member.name.text;
    if (ts.isComputedPropertyName(member.name)) return member.name.getText();
  }
  if (ts.isConstructorDeclaration(member)) return 'constructor';
  return null;
}

export function visibilityOf(member) {
  const mods = ts.getCombinedModifierFlags(member);
  if (mods & ts.ModifierFlags.Private) return 'private';
  if (mods & ts.ModifierFlags.Protected) return 'protected';
  if (member.name && ts.isPrivateIdentifier(member.name)) return 'private';
  return 'public';
}

export function findClass(sourceFile, className) {
  let found = null;
  const visit = node => {
    if (ts.isClassDeclaration(node) && node.name?.text === className) found = node;
    if (!found) ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  if (!found) {
    const names = [];
    ts.forEachChild(sourceFile, n => {
      if (ts.isClassDeclaration(n) && n.name) names.push(n.name.text);
    });
    throw new Error(`class ${className} not found in ${sourceFile.fileName} (classes present: ${names.join(', ') || 'none'})`);
  }
  return found;
}

/**
 * The signature text of a member: everything from its first modifier through the
 * end of the return type, i.e. the part a delegation has to reproduce. Whitespace
 * is collapsed so that a re-indent is not reported as a signature change.
 */
export function signatureOf(member, sourceFile) {
  const start = member.getStart(sourceFile);
  let end;
  if (member.body) end = member.body.getStart(sourceFile);
  else if (member.initializer) end = member.initializer.getStart(sourceFile);
  else end = member.getEnd();
  return sourceFile.text.slice(start, end).replace(/\s+/g, ' ').trim().replace(/[;{]$/, '').trim();
}

/**
 * Extract class members with their FULL text — `getFullText()`, so leading JSDoc
 * and leading comment banners travel with the member. A dropped comment must not
 * pass as equivalent, which is exactly why this is not `getText()`.
 */
export function extractMembers(sourceFile, className, names = null) {
  const cls = findClass(sourceFile, className);
  const wanted = names ? new Set(names) : null;
  const out = [];
  for (const member of cls.members) {
    const name = memberName(member);
    if (name === null) continue;
    if (wanted && !wanted.has(name)) continue;
    const fullText = member.getFullText(sourceFile);
    const startLine = sourceFile.getLineAndCharacterOfPosition(member.getStart(sourceFile)).line + 1;
    const endLine = sourceFile.getLineAndCharacterOfPosition(member.getEnd()).line + 1;
    const fullStartLine = sourceFile.getLineAndCharacterOfPosition(member.getFullStart()).line + 1;
    out.push({
      name,
      scope: 'member',
      fullStartLine,
      kind: ts.SyntaxKind[member.kind],
      visibility: visibilityOf(member),
      startLine,
      endLine,
      bodyLines: endLine - startLine + 1,
      signature: signatureOf(member, sourceFile),
      fullText,
      sha256: sha256(fullText),
    });
  }
  if (wanted) {
    const missing = [...wanted].filter(n => !out.some(o => o.name === n));
    if (missing.length) throw new Error(`members not found on ${className}: ${missing.join(', ')}`);
  }
  return out;
}

const TOP_LEVEL_NAME_GETTERS = [
  [ts.isInterfaceDeclaration, n => n.name.text],
  [ts.isTypeAliasDeclaration, n => n.name.text],
  [ts.isEnumDeclaration, n => n.name.text],
  [ts.isFunctionDeclaration, n => n.name?.text],
  [ts.isClassDeclaration, n => n.name?.text],
];

/**
 * Extract top-level (module-scope) declarations by name. A `const a = 1, b = 2;`
 * statement is reported once per declared name but carries the whole statement's
 * text, because that is what has to move.
 *
 * Module scope is where a task list that is complete about `this.x()` calls goes
 * silently wrong: pass 5.3 found two bindings (`NPC_SKILL_MAP`, `CreatedActorInfo`)
 * that NO class member references — they are reached only from another top-level
 * declaration. Callers should therefore ask for the transitive closure, not the
 * one-hop set; `moduleScopeClosure()` below does that.
 */
export function extractModuleScope(sourceFile, names = null) {
  const wanted = names ? new Set(names) : null;
  const out = [];
  const push = (name, stmt) => {
    if (!name) return;
    if (wanted && !wanted.has(name)) return;
    const fullText = stmt.getFullText(sourceFile);
    const startLine = sourceFile.getLineAndCharacterOfPosition(stmt.getStart(sourceFile)).line + 1;
    const endLine = sourceFile.getLineAndCharacterOfPosition(stmt.getEnd()).line + 1;
    const fullStartLine = sourceFile.getLineAndCharacterOfPosition(stmt.getFullStart()).line + 1;
    out.push({
      name,
      scope: 'module',
      fullStartLine,
      kind: ts.SyntaxKind[stmt.kind],
      visibility: ts.getCombinedModifierFlags(stmt) & ts.ModifierFlags.Export ? 'export' : 'local',
      startLine,
      endLine,
      bodyLines: endLine - startLine + 1,
      signature: '',
      fullText,
      sha256: sha256(fullText),
    });
  };
  for (const stmt of sourceFile.statements) {
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) push(decl.name.text, stmt);
      }
      continue;
    }
    for (const [test, get] of TOP_LEVEL_NAME_GETTERS) {
      if (test(stmt)) {
        push(get(stmt), stmt);
        break;
      }
    }
  }
  if (wanted) {
    const missing = [...wanted].filter(n => !out.some(o => o.name === n));
    if (missing.length) throw new Error(`module-scope declarations not found in ${sourceFile.fileName}: ${missing.join(', ')}`);
  }
  return out;
}

/**
 * Transitive closure of the module-scope declarations reachable from a set of
 * seed texts (typically the moving members' full text). Answers the question a
 * one-hop query gets wrong: "which top-level names must travel with this move?"
 */
export function moduleScopeClosure(sourceFile, seedTexts) {
  const all = extractModuleScope(sourceFile);
  const byName = new Map(all.map(d => [d.name, d]));
  const mentions = (text, name) => new RegExp(`(^|[^\\w$.])${name.replace(/[$]/g, '\\$')}([^\\w$]|$)`).test(text);
  const reached = new Map();
  let frontier = seedTexts.slice();
  while (frontier.length) {
    const next = [];
    for (const text of frontier) {
      for (const [name, decl] of byName) {
        if (reached.has(name)) continue;
        if (!mentions(text, name)) continue;
        reached.set(name, decl);
        next.push(decl.fullText);
      }
    }
    frontier = next;
  }
  return [...reached.values()].sort((a, b) => a.startLine - b.startLine);
}

// ── token identity, via the parser ────────────────────────────────────────────

const COMMENT = 'Comment';

function normalizeCommentText(raw) {
  return raw
    .split('\n')
    .map(l => l.trim().replace(/^\*+\s?/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function collectComments(text, from, to, seen, out) {
  const ranges = [
    ...(ts.getTrailingCommentRanges(text, from) ?? []),
    ...(ts.getLeadingCommentRanges(text, from) ?? []),
  ]
    .filter(r => r.pos >= from && r.end <= to)
    .sort((a, b) => a.pos - b.pos);
  for (const r of ranges) {
    if (seen.has(r.pos)) continue;
    seen.add(r.pos);
    out.push({ kind: COMMENT, text: normalizeCommentText(text.slice(r.pos, r.end)) });
  }
}

/**
 * The token stream of a snippet, comments included in position.
 *
 * `wrap: 'class'` wraps a class-member snippet in a throwaway class so it parses;
 * the wrapper contributes the same fixed tokens to both sides of any comparison.
 */
export function tokenStream(snippet, { wrap = 'none' } = {}) {
  const prefix = wrap === 'class' ? 'class __Wrap__ {\n' : '';
  const suffix = wrap === 'class' ? '\n}\n' : '';
  const text = prefix + snippet + suffix;
  const sf = ts.createSourceFile('__snippet__.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const tokens = [];
  const seenComments = new Set();
  let cursor = 0;
  const walk = node => {
    const children = node.getChildren(sf);
    if (children.length === 0) {
      const start = node.getStart(sf, /* includeJsDocComment */ false);
      collectComments(text, cursor, start, seenComments, tokens);
      cursor = node.getEnd();
      if (node.kind === ts.SyntaxKind.EndOfFileToken) return;
      tokens.push({ kind: ts.SyntaxKind[node.kind], text: node.getText(sf) });
      return;
    }
    for (const child of children) walk(child);
  };
  walk(sf);
  const diagnostics = sf.parseDiagnostics ?? [];
  return { tokens, parseErrors: diagnostics.length };
}

/** Compare two token streams. Returns the first index at which they diverge. */
export function compareTokens(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i].kind !== b[i].kind || a[i].text !== b[i].text) {
      return { identical: false, index: i, expected: a[i], actual: b[i] };
    }
  }
  if (a.length !== b.length) {
    return {
      identical: false,
      index: n,
      expected: a[n] ?? null,
      actual: b[n] ?? null,
      reason: 'length',
    };
  }
  return { identical: true };
}

// ── column-width measurement ─────────────────────────────────────────────────

/**
 * Every line of `text` containing `needle`, with its column width.
 *
 * The point of this is that a formatter reflow is a MEASURED consequence of a
 * substitution's effect on column width against the print width, never an
 * assumption from the substitution's length. Pass 5.1 predicted a reflow from a
 * +9-character substitution and got none (64→73, 55→64, 53→62, 59→68 against 100);
 * pass 5.3 predicted both of its reflows correctly from measurement and correctly
 * left alone a line that landed at exactly 100.
 */
export function measureSites(text, needle) {
  const lines = text.split('\n');
  const sites = [];
  lines.forEach((line, i) => {
    let at = line.indexOf(needle);
    while (at !== -1) {
      sites.push({ line: i + 1, columns: line.replace(/\s+$/, '').length, text: line });
      at = line.indexOf(needle, at + needle.length);
    }
  });
  return sites;
}

/** Trim artefacts of a member's position in its old file, keeping all content. */
export function normalizeItemText(fullText) {
  const lines = fullText.split('\n');
  let start = 0;
  while (start < lines.length && lines[start].trim() === '') start++;
  let end = lines.length;
  while (end > start && lines[end - 1].trim() === '') end--;
  return lines
    .slice(start, end)
    .map(l => l.replace(/\s+$/, ''))
    .join('\n');
}

export function parseList(value) {
  if (!value) return null;
  return value
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

/** Minimal `--flag value` / `--flag=value` / `--bool` parser. */
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[arg.slice(2)] = true;
    else {
      out[arg.slice(2)] = next;
      i++;
    }
  }
  return out;
}
