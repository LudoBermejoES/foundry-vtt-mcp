# Refactor-verification tooling

Two read-only extractors for the `data-access.ts` facade-extraction passes, plus a
selfcheck that replays a verified past pass through them.

They are **not shipped**: nothing here is imported by `packages/*/src`, nothing is
bundled into the Foundry module or the MCP server, `madge`/`knip`/`eslint` do not see
them (`.mjs`, outside every workspace), and they are deliberately **not** under
`packages/foundry-module/src/` — that directory is what the passes analyse, and a file
added to it changes member counts, surface lists and madge's file count.

Run them with plain `node`; there is no build step. `typescript` is already a root
devDependency, and it is the only dependency. **No new dependency was added.**

```bash
node scripts/refactor/member-text.mjs      --help
node scripts/refactor/reached-surface.mjs   --help
npm run test:refactor-tools                 # the selfcheck (31 checks)
```

## Why these exist

Three extraction passes — `extract-actor-mechanics-builders` (5.0),
`extract-compendium-search` (5.1), `extract-actor-crud` (5.3) — each hand-wrote the
same compiler-API code in scratch space and threw it away, four times counting the
proposals. Each pass's design recorded "should these finally be committed?" as an open
question and deferred it on scope-creep grounds. This is the resolution.

Every rule encoded below was paid for by one of those passes. Read
`openspec/changes/archive/2026-07-27-extract-actor-crud/{design,tasks}.md` for the
long version.

---

## 1. `member-text.mjs` — per-member body diff

Proves a member that moved between files moved **verbatim**, by comparing a baseline
copy of the source file against the post-move file item by item, with the pass's
enumerated re-pointings applied to the baseline first.

### `extract`

```bash
node scripts/refactor/member-text.mjs extract \
  --file packages/foundry-module/src/data-access.ts \
  --class FoundryDataAccess \
  --members createNpcActor,createActors \
  --module-scope NPC_SIZE_MAP,npcFormatCR \
  --out /tmp/baseline --json /tmp/baseline.json
```

Emits each item's **full text** — `getFullText()`, so leading JSDoc and section
banners travel with the member — one file per item, plus an `index.json` with line
ranges, body-line counts and per-item sha256. Omit `--members` to get every member of
the class. The source file's own sha256 and line count are reported, because both prior
passes found the file had moved between the design being written and the move starting.

### `closure`

```bash
node scripts/refactor/member-text.mjs closure \
  --file packages/foundry-module/src/data-access.ts \
  --class FoundryDataAccess --members createNpcActor,createActors
```

The **transitive** closure of module-scope declarations that must travel with a moving
member set, each tagged `one-hop` or `transitive-only`. The tag is the point: pass 5.3
found `NPC_SKILL_MAP` (read only by `npcBuildSkillsBlock`, itself module-level) and
`CreatedActorInfo` (surviving only as the element type inside another interface's
declaration) — neither is mentioned by any moving member, so the query both earlier
passes ran, "which module-level names do the moved bodies mention?", returns neither.

### `diff`

```bash
node scripts/refactor/member-text.mjs diff \
  --baseline /tmp/data-access.before.ts \
  --actual   packages/foundry-module/src/actor-crud.ts \
  --plan     scripts/refactor/fixtures/extract-actor-crud.plan.json \
  [--items addActorItems,removeActorItems]   # e.g. just this stage's members
```

Exit codes: **0** every difference is enumerated or a measured reflow; **1** a real
difference; **2** aborted — the plan is wrong.

`--items` narrows a run to one commit's worth of members, which is how a staged pass
gets a per-stage gate instead of only an end-of-pass one.

### The plan file

```json
{
  "printWidth": 100,
  "baselineClass": "FoundryDataAccess",
  "actualClass": "ActorCrud",
  "members": ["addActorItems", "createNpcActor"],
  "moduleScope": ["NPC_SIZE_MAP"],
  "substitutions": [
    { "from": "this.auditLog(", "to": "this.security.auditLog(", "count": 15 },
    {
      "from": "interface SceneTokenPlacement",
      "to": "export interface SceneTokenPlacement",
      "count": 1,
      "items": ["SceneTokenPlacement"]
    }
  ],
  "deletions": [{ "text": "// ─── mgt2e ───\n", "items": ["deleteActors"], "count": 1 }]
}
```

- `count` is **required** on every substitution, and it is the total across the
  selected items. `perItem: {"createNpcActor": 2}` adds a per-item assertion (and then
  an item the map does not list is also an abort).
- `items` scopes a substitution to named items.
- `deletions` are enumerated, disclosed removals — in practice always an orphan section
  banner that labels nothing once the members below it have moved. Every pass so far
  had at least one; 5.3 had two and had listed one.

### What the tool refuses to do

**A wrong substitution count aborts.** It does not apply as many edits as it can find.
5.3's per-stage counts were wrong in three stages out of four while the global total was
exactly right; the abort turned each into a caught discrepancy instead of a silent one.

**It does not assume a reflow either way.** It measures the column width of the
original and post-substitution line at every substitution site against `printWidth`,
and cross-checks the prediction against what actually differs. 5.1 predicted a reflow
from a +9-character substitution and got none (its four sites went 64→73, 55→64, 53→62,
59→68 against 100). 5.3 predicted both of its reflows from measurement and correctly
left alone a site that landed at exactly 100 columns. An item that comes out
token-identical but had **no** site over the print width is reported as
`REFLOW-UNEXPLAINED` and fails.

**Token identity comes from the parser, never `ts.createScanner`.** A raw scanner does
not re-scan template-literal continuations: it reads the head of a template, then
swallows the rest of the member into one bogus token and reports a difference on a body
that was merely reflowed. `lib/ts-source.mjs` walks `node.getChildren()` down to leaf
tokens instead. The selfcheck asserts both halves — the parser calls the reflow
identical, and the scanner still gets it wrong.

**Comments are tokens.** They are emitted into the stream in source position, so a
dropped JSDoc block or inline comment cannot masquerade as a reflow. Comment text is
whitespace-normalised (`*` line prefixes stripped) so a re-indent is not a difference,
but a removal is.

When something differs beyond the plan, the rule the passes settled on is **restore the
pre-move text**, not justify the difference in review.

---

## 2. `reached-surface.mjs` — externally-reached surface

Emits the set of facade-class members that anything outside the class reaches, **with
the signature text**, so a pass can prove its before/after surface diff is empty. Also
reports dead surface: non-private members reached by nothing.

```bash
node scripts/refactor/reached-surface.mjs extract \
  --facade packages/foundry-module/src/data-access.ts \
  --class FoundryDataAccess \
  --files 'packages/foundry-module/src/queries.ts,packages/foundry-module/src/main.ts,packages/foundry-module/src/settings.ts,packages/foundry-module/src/socket-bridge.ts,packages/foundry-module/src/*.test.ts,packages/foundry-module/src/__fixtures__/fake-foundry.ts' \
  --tsconfig packages/foundry-module/tsconfig.json \
  --json /tmp/surface.before.json

# …make the move, then re-capture, then:
node scripts/refactor/reached-surface.mjs diff /tmp/surface.before.json /tmp/surface.after.json
```

`--files` takes comma-separated paths; `*` is allowed in the basename. `--receivers`
defaults to `dataAccess,da`. Exit codes: **0** empty diff, **1** the surface changed,
**2** misuse.

Capture **before every commit and after every commit**, not only at the ends of the
pass — that is the gate that catches a stage which transiently drops a delegation.

### The trap this exists to avoid

**A type-checker-only pass is wrong.** On this repo it reports **62 members from 2
files** when the union reports **65**, from every scanned file except `socket-bridge.ts`
and the fixture, because

- the package `tsconfig.json` excludes `*.test.*` and `src/__fixtures__/**`, so **every**
  test file and the fake-Foundry fixture are **not in the program at all** (six test
  files as of `8d14064`, and the count grows with each characterization change — the
  selfcheck derives the invisible set from the exclude rule rather than freezing its
  size, because freezing it turned a green tool red for a reason that was not about the
  code); and
- `settings.ts` reaches through `bridge?.dataAccess?.X`, `main.ts` through
  `this.queryHandlers?.dataAccess.X`, and the tests through
  `const da = await makeDataAccess()` — all `any`, so the checker cannot see the
  receiver's class **even in a file it does compile**. That is how it misses
  `attachRollButtonHandlers`, `saveRollState` and `updateRollButtonMessage` inside
  `main.ts`, which it does see.

So the answer is the **union** of a checker pass and a receiver-text pass. The tool runs
both, plus a deliberately over-approximating third pass (any property access, string
element access, or bare string literal whose name is a class member) as a sensitivity
check. On this class the over-approximation adds two false positives in shipped files, both
explainable and worth re-checking rather than assuming: `moduleId` is `settings.ts`'s
own private field, and `requestRollStateSave` at `main.ts:550` is a socket-message
discriminant (`data.type === 'requestRollStateSave'`), not a facade call. It also picks
up `describe('<memberName>', …)` titles from the test files — `extractPF2eSpellSlots`
and `extractDnD5eSpellSlots` since `8d14064` — which are bare string literals matching a
**private** member name, so they can never be a reach. The selfcheck's rule is therefore
"the two documented names, else sited only inside a test file"; an unexplained extra in
`queries.ts`, `main.ts` or `settings.ts` fails.

`--checker-scope files` adds the scanned files to the program instead of taking the
tsconfig's file list as-is. Useful for diagnosis; the default (`tsconfig`) is what
reproduces the trap honestly.

### The tool's identity is part of its output

Every capture carries `tool`: name, version, TypeScript version, mode, class, receivers,
checker scope and the file list. `diff` **refuses** to compare two captures whose tool
identity differs (`--allow-tool-mismatch` to override), because a difference between
two tools is not evidence about the code. This class's dead-surface count has been
reported as **13, 7, 9 and 8** by four successive hand-written extractors. A number
without its tool is not a measurement.

Each capture also prints a census: `reached(non-private) + dead == non-private`. Within
one run that identity holds by construction, so it is not a check on the run — it is a
check on the numbers a **document** quotes, which is where the disagreements actually
happened.

It also reports **names probed on the facade object that are not members of the class**.
`main.ts:650` does `queryHandlers.dataAccess.ensureButtonStatesForMessage($html)` and no
such member exists; it is part of the compatibility boundary anyway, and a members-only
extractor omits it silently. `diff` treats an added or removed probe as a surface change.

---

## 3. `selfcheck.mjs` — the actual proof

```bash
npm run test:refactor-tools
```

A plain node script, following `scripts/mcp-schema-smoke-test.mjs`'s convention rather
than adding a vitest suite to either workspace, so the 322 + 282 workspace test counts
are untouched. It reconstructs its fixtures from git history and asserts, in 31 checks:

1. **The body-diff extractor replays pass 5.3** (`3cbe106` → `7bf9c77`): baseline
   sha256 `bb795e5f…` as the design recorded it, 37 substitutions (34 re-pointings + 3
   `export` keywords), **25 of 27 items byte-identical**, exactly 2 reflow-only, the two
   reflows measured at 90 → 104 and 93 → 102 columns, and the third-longest site landing
   at exactly 100 and left alone.
2. **A dropped comment fails hard.** Re-run against the `f4b0fd2` baseline, where the
   `// Phase 2: Write Operation Interfaces` banner is still attached to
   `ActorCreationResult` and was deleted in stage D: exit 1, `DIFFERS`, and the banner
   named as the first token divergence. It is not classified as a reflow.
3. **A wrong count aborts** (`this.auditLog(` declared 12 where there are 15 — 5.3's
   stage-B error): exit 2, nothing compared.
4. **An enumerated deletion makes a disclosed removal pass**: the same run as (2) exits
   0 once the banner is declared.
5. **Parser vs scanner**, on a synthetic reflow across a template literal: the parser
   calls it identical, `ts.createScanner` still reports a bogus difference, and a dropped
   comment is a token difference.
6. **The surface extractor reproduces the checker-only trap** on the current tree: 62
   members from 2 files vs 65 from the union, every test file and the fixture invisible to
   the checker, the three named checker-misses, and every over-approximation extra
   explainable. The three file-census assertions here are **derived** from the tsconfig
   exclude rule and the scanned list, not frozen as integers.
7. **`diff` is empty against itself and aborts on a tool mismatch.**

If (6) starts failing at 65, check whether a pass deliberately changed the facade's
external surface. It should not have: an empty surface diff is the gate.

---

## Reproductions on record

| Pass                            | Move                  | Body diff                                      | Surface diff                           |
| ------------------------------- | --------------------- | ---------------------------------------------- | -------------------------------------- |
| 5.1 `extract-compendium-search` | `c1f12d5` → `e4c0409` | not replayed                                   | 65 → 65, **empty**                     |
| 5.3 `extract-actor-crud`        | `3cbe106` → `7bf9c77` | **25 / 27 byte-identical**, 2 measured reflows | 65 → 65, **empty**; dead surface 9 → 8 |

Both surface reproductions were run from `git worktree --detach` checkouts with the root
`node_modules` symlinked in.

Every number in the archived record reproduces, including the one that looks like a
disagreement. `extract-actor-crud`'s design tabulates **65** and its execution note says
"the union extractor measures **66**, not 65"; both are right and they count different
things, which the module map states and which the tool now reports on separate lines:

- **65 externally-reached class members** — the figure a surface diff is about, and the
  one the census closes against the member count (65 reached + 8 dead = 73 non-private
  at `7bf9c77`; 65 + 9 = 74 at `3cbe106`).
- **66 externally-reached names** — those 65 plus `ensureButtonStatesForMessage`, probed
  on the facade object at `main.ts:650` and **not a member of the class at all**.

A members-only extractor reports 65 and silently drops the probe; a names-only extractor
reports 66 and cannot close the census. Reporting both is why the two figures stop
looking like a tool artefact. `extract-compendium-search`'s "66 before, 66 after" is the
same names figure, and its empty-diff conclusion reproduces exactly.

The dead-surface list reproduces name for name (`getRollState`,
`saveRollButtonMessageId`, `getRollButtonMessageId`, `getRollStateFromMessage`,
`requestRollStateSave`, `broadcastRollState`, `cleanOldRollStates`,
`getCharacterEntity`), and `createActorFromCompendium` is the ninth on the pre-deletion
tree — which is what makes 9 → 8 the recorded consequence of deleting it.
