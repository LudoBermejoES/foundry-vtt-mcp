# `data-access.ts` stage 2 — a verified plan for the remaining ~7,000 lines

> **Status: stages 1 and 2 have landed.** This was written as a plan and is now
> part plan, part record. **Stage 1** (actor-mechanics builders) landed as
> `extract-actor-mechanics-builders`; **stage 2** (compendium/creature search)
> landed as `extract-compendium-search`. Both sections are marked, and stage 2's
> in particular records **four claims this document made that turned out to be
> wrong** — kept visible rather than rewritten away, because two of them are traps
> stages 3 and 4 can still walk into. Every line count below `data-access.ts:4448`
> predates stage 1 and is stale; `data-access.ts` is now ~4,270 lines, not ~7,000.
> **Re-derive from the current source before acting on anything here.** That is
> not a caveat — following this document's cluster-A recursion description
> literally would have produced the exact facade back-reference it warns against.

This was a **plan only** when written. Nothing in `packages/foundry-module/src`
was edited to produce it. It supersedes nothing in
`docs/refactor-data-access.md` — it verifies and refines the "not yet extracted"
section at the bottom of that file, using the TypeScript compiler API (not grep)
for the call graph, exactly as the first pass did. See the methodology note at the
end for how to reproduce every number here.

**Snapshot this was built against:** working tree as of 2026-07-27, with a
concurrent WoD-read-path change in flight (uncommitted) touching
`data-access.ts`, `actor-directory.ts`, `queries.ts`, and several
`packages/mcp-server` files. The seam map below accounts for that change —
see "The four-cluster hypothesis, revisited" for exactly where it lands and
why one cluster (character reading) is currently the most volatile part of
the file.

## Method inventory, verified

`FoundryDataAccess` currently has **105 members** (104 methods + the
constructor): **74 public**, **30 private**, wrapping **8 fields** for the
collaborators the first pass already extracted (`persistentIndex`,
`security`, `actorResolver`, `journals`, `worldItems`, `actorDirectory`,
`rollManager`, `sceneTokenManager`) plus `moduleId`.

Of the 105 methods, **43 are already-thin one-line facade delegates** to
those 8 collaborators (e.g. `listActors` → `this.actorDirectory.listActors()`,
`getActiveScene` → `this.sceneTokenManager.getActiveScene()`) — these are
permanent, correctly placed, and out of scope for this pass.

The remaining **61 methods (~5,800 lines of method bodies, plus JSDoc/blank
lines bringing the file to 7,220 raw lines)** are the real subject. A full
call-graph pass over them (every `this.<x>(...)` call site, every
`this.<field>` access, resolved via the TS AST, not text matching) produced
this table:

| Cluster                                          | Methods | Body lines | Depends on                                                                                                                             |
| ------------------------------------------------ | ------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **A — compendium/creature search**               | 20      | ~1,084     | `creature-index.ts` (`persistentIndex`), `security`                                                                                    |
| **B — character reading**                        | 9       | ~969       | `security`, `actor-resolver`                                                                                                           |
| **B′ — flag/token-art helpers (new, in flight)** | 3       | ~43        | `security`; conceptually paired with `actor-directory.ts`                                                                              |
| **C — actor CRUD**                               | 20      | ~2,092     | `security`, `actor-resolver`, **cluster A** (2 call sites, both in `createActorFromCompendium`; `…Entry` reaches cluster A not at all) |
| **D — actor mechanics builders**                 | 9       | ~1,608     | `security`, `actor-resolver` only                                                                                                      |

This confirms the four-cluster hypothesis from `refactor-data-access.md` as
the right axis — **with one addition (B′) that didn't exist when that doc was
written**, and one correction to its risk framing (below).

## The four-cluster hypothesis, revisited

**It survives, with two changes:**

1. **A fifth, tiny cluster exists now: `findActorsByFlag` / `readActorFlags`
   / `extractTokenArt`** (43 lines), added by the concurrent WoD-read-path
   work since the first doc was written. `findActorsByFlag` is already a
   one-line delegate to `actorDirectory` (correctly placed, ignore it).
   `readActorFlags` and `extractTokenArt` are **private, and today called
   from exactly one place: `getCharacterInfo`** — despite being physically
   inserted 2,000 lines away, right after `listActors`/`findActorsByFlag`,
   i.e. in the "already-extracted collaborator wrappers" neighborhood, not
   next to `getCharacterInfo` where they're actually used. Treat this as a
   drafting artifact, not a signal: their only real caller today is
   character-reading, so that's where they belong when this cluster moves —
   _but re-check this at execution time_, because if the in-flight change
   also wires `actor-directory.ts` or the new `findActorsByFlag` bridge to
   call them directly, they'd be better placed as small leaf exports next to
   `ActorDirectory.findActorsByFlag` instead (which already carries the
   sibling "don't use `getFlag`" comment — see the load-bearing-comment
   section, this is the one genuine documentation hazard in this whole plan).

2. **Correction to the doc's own risk framing**: it says "the three
   soft-validation ... comments (still in `data-access.ts`, not yet moved)
   in the actor-mechanics builders." Verified: two of the three (`// 3. Soft
validation — collect warnings, never block` at `addAttackToActor` and
   `addAuraToActor`) are indeed cluster D. **The third (`createNpcActor`,
   "do NOT block creation") is cluster C, actor CRUD**, per the same doc's
   own cluster-3 method list. Minor, but worth fixing before anyone uses it
   as a checklist. (There's also a fourth, similar comment at
   `addAttackWithSaveToActor` — "Soft validation — both damage groups
   unified" — not counted in the doc's "three" at all. All four are
   self-contained one-liners with no cross-file hazard; see below.)

**One genuine surprise the AST pass turned up that the first doc didn't
have**: clusters **C and D have zero `this.x()` calls between each other**.
Despite both being "actor stuff," `addFeaturesFromCompendium` (cluster D,
despite its name) reaches compendium packs via the global `game.packs`
directly, not through any cluster-A or cluster-C helper. This means D is
fully independent of both A and C — it only needs `security` +
`actor-resolver`, exactly like the already-extracted collaborators. That
makes D **the lowest-graph-risk cluster of the four**, not (as its size might
suggest) a mid-risk one.

~~The only confirmed cross-cluster edge among the unextracted material is
**C → A**~~ — **wrong twice over, and this is the premise the whole staging order was
built on. Struck in place rather than deleted.**

First correction (made by `extract-compendium-search`): it is one caller, not two.
`createActorFromCompendium` calls `this.findBestCompendiumMatch()` and
`this.getCompendiumDocumentFull()` (both cluster A), once each.
`createActorFromCompendiumEntry` calls `addActorsToScene`, `auditLog`,
`getOrCreateFolder` and `validateFoundryState` — nothing in cluster A.

**Second correction, made by `extract-actor-crud`: there is no C → A edge at all.**
`createActorFromCompendium` — the sole holder of both calls — is **dead surface**:
`public`, 145 lines, and reached from nothing. No intra-class referrer, no member
access in any reach site, no dynamic dispatch. The bridge **query** of that name is
alive and its handler calls `createActorFromCompendiumEntry`, which is why a grep for
the identifier returns four live-looking hits and the check has to be a member-access
analysis. The dead-code requirement made deleting it mandatory rather than optional, so
the C → A edge left with it and `actor-crud.ts` imports **nothing** from
`compendium-search.ts`.

So "**A must be extracted before or together with C**, never after" was a correct
conclusion resting **entirely on dead code**. The order was still the right one — stage
2 was worth doing first on its own merits — but not for the stated reason, and a pass
that had followed this plan literally would have carried 191 lines of dead code into a
new module and preserved a cross-cluster dependency that does not need to exist.

**And the plan never mentions `transactionManager`, which is the one thing in cluster C
that a verbatim move would have turned into a spec violation.** `data-access.ts`
imported the module-level instance `transaction-manager.ts` exported; all eight uses
were cluster C's (six inside the dead method, including the only `startTransaction`);
and a collaborator reaching a shared service by importing a singleton is what the
acyclic-DAG requirement forbids. `extract-actor-crud` injects it and deletes the
instance export. A cross-boundary inventory that only asks about `this.x()` calls
cannot see this shape at all — see the section below, which is exactly such an
inventory.

## Cross-boundary `this.x()` calls, every instance found

By cluster (facade methods that will need `this.x()` → `this.collaborator.x()`
rewrites once their cluster moves into its own class; collaborator names below
are proposed):

**Cluster A → `security`/`creature-index` (`CompendiumSearch` — ✅ landed as `compendium-search.ts`; three of the five bullets below were wrong, corrected in Stage 2):**

- `getCompendiumDocumentFull` calls `this.sanitizeData(...)` → `this.security.sanitizeData(...)`
- `getEnhancedCreatureIndex` calls `this.validateFoundryState()` → `this.security.validateFoundryState()`, and reads `this.persistentIndex` → constructor-injected `PersistentCreatureIndex`
- ~~`rebuildEnhancedCreatureIndex`, `searchCompendium`, `listCreaturesByCriteria`, `fallbackBasicCreatureSearch` all read `this.moduleId` → must be passed into the new collaborator's constructor as a plain string, same as `PersistentCreatureIndex` already receives it~~ — **WRONG on both counts.** `PersistentCreatureIndex`'s constructor takes no arguments; it declares `private moduleId: string = MODULE_ID;` (`creature-index.ts:131`), identical to `FoundryDataAccess`. `compendium-search.ts` follows that precedent, which keeps all **8** `this.moduleId` reads (not 4 — `searchCompendium` alone has 4) textually unchanged in the body diff.
- **Internal, stays `this.x()` inside the new class** (no rewrite, just moves verbatim): `listCreaturesByCriteria` → `passesEnhancedCriteria` → the four `passesXCriteria`, `findBestCompendiumMatch` → `searchCompendium`, `searchCompendium` → `shouldApplyFilters`/`matchesSearchCriteria`/`calculateRelevanceScore`, and the cycle. ~~`searchCompendium` ↔ `fallbackBasicCreatureSearch` (mutually recursive)~~ — **WRONG: there is no direct edge between those two.** The strongly-connected component is `searchCompendium` → `listCreaturesByCriteria` → `fallbackBasicCreatureSearch` → `searchCompendium`. The warning attached to it was correct and the set was not: moving only the named pair leaves the moved `searchCompendium` calling `this.listCreaturesByCriteria` and forces exactly the back-reference it warns about. ~~`prioritizePacksForCreatures` → `getPackPriority`~~ — both deleted as dead.
- **Dead code — four methods, not one.** `passesCriteria` was found here; `passesFilters`, `prioritizePacksForCreatures` and (by cascade) `getPackPriority` are equally unreachable. 220 body lines, deleted ahead of the move in their own commit. The parenthetical was **wrong**: `tsc`'s unused-private-member check needs no standalone class — `noUnusedLocals` is on and TS 5.9 reports TS6133 for an unused private method of any class — and it was silent regardless, because three of the four carried a hand-written `// @ts-ignore - Unused method kept for compatibility`. It would have stayed silent in the new module if those comments had travelled with the bodies.

**Cluster B (+ B′) → `security`/`actor-resolver` (proposed `character-reader.ts`):**

- `getCharacterInfo` calls `this.extractSpellcastingData`, `this.extractTokenArt`, `this.readActorFlags` (all move with it, internal) and `this.sanitizeData` → `this.security.sanitizeData`
- `searchCharacterItems` calls `this.findActorByIdentifier` → `this.actorResolver.findActorByIdentifier`, `this.auditLog` → `this.security.auditLog`, `this.validateFoundryState` → `this.security.validateFoundryState`, plus its own internal `extractDSA5SpellTargeting`/`extractDnD5eSpellTargeting`/`extractPF2eSpellTargeting`/`formatPF2eActionCost` (internal, move together)
- `readActorFlags`/`extractTokenArt` call `this.sanitizeData` → `this.security.sanitizeData`

**Cluster C → `security`/`actor-resolver`/(new) `CompendiumSearch` (proposed `actor-crud.ts`):**

- Every one of `addActorItems`, `removeActorItems`, `setActorOwnership`, `updateWfrp4eActor`, `addWfrp4eItems`, `getActorOwnership`, `createNpcActor`, `addActorsToScene`, `createActorFromCompendium`, `createActorFromCompendiumEntry` calls some subset of `this.auditLog`/`this.findActorByIdentifier`/`this.validateFoundryState` → the standard `this.security.x()`/`this.actorResolver.x()` rewrite
- `createActorFromCompendium` **also** calls `this.findBestCompendiumMatch` and `this.getCompendiumDocumentFull` → **cross-cluster**, becomes `this.compendiumSearch.findBestCompendiumMatch()` / `this.compendiumSearch.getCompendiumDocumentFull()`. Cluster A now exists, so this re-pointing is available today, and doing it lets the temporary private `findBestCompendiumMatch` facade wrapper be deleted in the same diff. **`createActorFromCompendiumEntry` does NOT call into cluster A** — it calls `addActorsToScene`, `auditLog`, `getOrCreateFolder`, `validateFoundryState`. There is one C→A caller, not two.
- `createActorFromCompendiumEntry`, `createNpcActor`, `createActors`, `importActors` call `this.getOrCreateFolder` → already a thin wrapper to `this.actorResolver.getOrCreateFolder` (no new rewrite risk — this call is already one hop from the leaf)
- `createActorFromCompendium`/`createActorFromCompendiumEntry` call `this.addActorsToScene` (stays internal — moves with the cluster); `addActorsToScene` calls its own private sibling `this.calculateTokenPosition` (internal)
- `createActorFromSource` calls `this.getOrCreateFolder` (as above) and reads `this.moduleId`
- `createActors` calls `this.normalizeMGT2eSkillKeys` (private sibling, internal, moves with it)
- **Zero `this.x()` calls at all**: `updateActors`, `updateActorItems`, `deleteActorItems`, `deleteActors` — these four touch only Foundry globals (`game.actors`, etc.), nothing to rewrite

**Cluster D → `security`/`actor-resolver` only (proposed `actor-mechanics.ts`):**

- All nine of `useItem`, `addSaveFeatureToActor`, `addAttackToActor`, `addAuraToActor`, `addPassiveFeatureToActor`, `addAttackWithSaveToActor`, `setActorSpellcasting`, `addSpellsToActor`, `addFeaturesFromCompendium` call only `this.auditLog`/`this.findActorByIdentifier`/`this.validateFoundryState` — the same three-call rewrite, nine times, with **no other cross-boundary or intra-cluster calls at all**. This is the most repetitive and mechanically safest cluster in the file.

**`addActorsToScene`/`calculateTokenPosition` — confirmed, doc's note #5 is correct**: these two stayed on the facade in the first pass and use `game.scenes.current`/`game.actors.get`/module-level `permissionManager`/`ERROR_MESSAGES` imports directly, **not** `this.sceneTokenManager`. They belong with cluster C (actor creation), not `scene-token-manager.ts`, exactly as the doc predicted.

## Stage-by-stage plan

Ordered so failures localize and risk rises last — **and re-ordered from a
naive A→B→C→D pass by one fact the first doc couldn't know**: **the
concurrent WoD-read-path change is editing cluster B and B′ right now** (see
below). Attempting a stage there today isn't just riskier code — it's a
guaranteed textual collision with someone else's uncommitted work.

I checked this precisely: `git diff -- data-access.ts` currently has 4 hunks.
Three sit inside/adjacent to `getCharacterInfo` (near lines 15, 335, 392) and
inside the new `findActorsByFlag`/`readActorFlags`/`extractTokenArt` block
(line ~2425). **Zero hunks touch anything in clusters A, C, or D** (line 2634
onward except the untouched tail of cluster A, and everything past that is
clean). That gives a concrete, checkable safety boundary for staging order.

### Stage 1 — Actor mechanics builders (cluster D) → `actor-mechanics.ts` — ✅ **LANDED**

> **Landed** as OpenSpec change `extract-actor-mechanics-builders`. What this
> section predicted held, with three corrections worth carrying forward:
>
> 1. **The byte-for-byte diff recommendation below is now a spec requirement,
>    not advice.** `foundry-module-architecture` gained _"A move of hand-written
>    bodies is gated by a per-method text diff, not by type-checking alone"_,
>    which binds stages 2–4 as well: enumerate the mechanical re-pointings in
>    advance, diff every moved body against its pre-move source, and treat any
>    other differing line as a defect to revert rather than a difference to
>    justify. It also requires characterization tests pinning **the document
>    handed to Foundry** to exist and pass against the **pre-move** source
>    before a move starts.
> 2. **"Zero tests here" was true when written and was fixed first.**
>    `14d392c` added `actor-mechanics.test.ts` — 41 cases across all nine
>    builders plus `createNpcActor`, on a shared fake-Foundry fixture — as the
>    precondition. The move consumed it; it did not author it.
> 3. **"Private helpers pulled with it: none" was right about methods and wrong
>    about module scope.** There are no private sibling _methods_, but nine
>    **module-level** bindings at the foot of `data-access.ts` were reachable
>    only from these nine bodies and had to move with them: `slugify` (all three
>    of its callers moved), `ATTACK_DAMAGE_CANONICAL`,
>    `ATTACK_PROPERTY_CANONICAL`, `AURA_DAMAGE_CANONICAL`,
>    `ATTACK_WITH_SAVE_DAMAGE_CANONICAL`, and the four spellcasting slot tables.
>    Leaving them behind would have been a circular import
>    (`actor-mechanics.ts` → `data-access.ts`) and an R2 violation; `tsc`'s
>    `noUnusedLocals` forces the question either way. The `NPC_*` set and the
>    three `npc*` functions stayed, with `createNpcActor`.
>
> Measured outcome: 36 re-pointings applied (9 + 9 + 18, exactly as predicted),
> nine bodies byte-identical to baseline + those re-pointings, one further
> permitted difference (a `prettier` reflow of the one line an enumerated
> re-pointing pushed past 100 columns), externally-reached surface diff empty,
> `data-access.ts` 7,221 → ~5,480.

- **Moves**: `useItem`, `addSaveFeatureToActor`, `addAttackToActor`,
  `addAuraToActor`, `addPassiveFeatureToActor`, `addAttackWithSaveToActor`,
  `setActorSpellcasting`, `addSpellsToActor`, `addFeaturesFromCompendium` (9
  methods, ~1,608 body lines)
- **Private helpers pulled with it**: none — every one of the nine is a
  public leaf method with no private siblings in this cluster
- **New file depends on**: `security.ts`, `actor-resolver.ts` (both already
  leaves)
- **Constructor injection**: `new ActorMechanics(security, actorResolver)`
- **What could break**: purely mechanical `this.validateFoundryState()` →
  `this.security.validateFoundryState()` / `this.findActorByIdentifier()` →
  `this.actorResolver.findActorByIdentifier()` / `this.auditLog()` →
  `this.security.auditLog()`, applied identically nine times. The realistic
  failure mode is a **copy-paste transcription slip inside one 100-280 line
  method body** (these are long, repetitive, hand-built item/effect data
  objects), not a call-graph error — `tsc` catches every missed rewrite as a
  compile error (no `this.security`/`this.actorResolver` typo survives), but
  it cannot catch "moved a line to the wrong place inside the body." Since
  there are zero tests here, the only backstop is a byte-for-byte diff of
  each moved method body against its pre-move source (not just a `tsc`-clean
  build).
- **Collision risk with the concurrent change**: none — confirmed no diff
  hunks in this line range.

### Stage 2 — Compendium/creature search (cluster A) → `compendium-search.ts` — ✅ **LANDED**

Landed as `extract-compendium-search`. **Four things this section stated turned
out to be wrong**, each corrected below from an AST re-derivation against the tree
the pass actually ran on. They are left visible rather than rewritten away,
because two of the four are traps that later stages can still walk into.

- **Moved**: `rebuildEnhancedCreatureIndex`, `searchCompendium`,
  `shouldApplyFilters`, `calculateRelevanceScore`, `listCreaturesByCriteria`,
  `passesEnhancedCriteria`, `passesMGT2eCriteria`, `passesCosmereRpgCriteria`,
  `passesDnD5eCriteria`, `passesPF2eCriteria`, `fallbackBasicCreatureSearch`,
  `matchesSearchCriteria`, `getAvailablePacks`, `getCompendiumDocumentFull`,
  `findBestCompendiumMatch`, `getEnhancedCreatureIndex` — **16 members, 864 body
  lines**, plus nine type declarations. `data-access.ts` 5,481 → 4,271;
  `compendium-search.ts` 1,107.
- **Correction 1 — four methods were dead, not one.** This section said "decide
  and act on `passesCriteria` (dead)". Also dead: `passesFilters` (94 lines),
  `prioritizePacksForCreatures` (33) and, by cascade, `getPackPriority` (13) —
  220 body lines in total, deleted in their own commit ahead of the move. **The
  claim elsewhere in this document that "`tsc`'s unused-private-member check will
  confirm once it's a private method of a standalone class" is wrong twice over**:
  the check needs no standalone class (`noUnusedLocals` is on and TS 5.9 reports
  TS6133 for an unused private method of any class), and it was silent anyway
  because three of the four carried a hand-written `// @ts-ignore - Unused method
kept for compatibility`. Migrated verbatim, the new module would have been
  silent too. Check the reach sites; never take a clean type-check as evidence
  where a suppression is in scope.
- **Correction 2 — the recursion is a three-cycle, and the pair this section named
  has no direct edge.** There is **no** `searchCompendium` →
  `fallbackBasicCreatureSearch` call. The strongly-connected component is
  `searchCompendium` → `listCreaturesByCriteria` → `fallbackBasicCreatureSearch`
  → `searchCompendium` (call sites `:1427`, `:1820`/`:1970`, `:2236` in the
  pre-move file), and its third member is itself reached from `queries.ts`.
  Following this section literally — move the pair, leave the rest — would have
  left the moved `searchCompendium` calling `this.listCreaturesByCriteria` and
  forced the facade back-reference this section warns against. The hazard was
  real; the set named would have caused it. **Later stages must compute the SCC,
  not copy it**: stage 3's own candidate
  (`createActorFromCompendium`/`…Entry` → `addActorsToScene` →
  `calculateTokenPosition`) looks like a tree on current evidence, which is
  exactly the kind of claim this one got wrong. **Recomputed by
  `extract-actor-crud`: it is a tree, confirmed** —
  `createActorFromCompendiumEntry` → `addActorsToScene` → `calculateTokenPosition`,
  with no back edge, so there was no cycle to move atomically. All three moved in one
  commit anyway, which is what the tree shape allows and a cycle would have forced.
- **Correction 3 — `createActorFromCompendiumEntry` does not call into this
  cluster.** `…Entry` calls `addActorsToScene`, `auditLog`, `getOrCreateFolder`
  and `validateFoundryState`. There is exactly **one** C→A caller,
  `createActorFromCompendium`, with one call each to `findBestCompendiumMatch` and
  `getCompendiumDocumentFull` — so stage 3 has half the surface here that this
  document implies. **Superseded by `extract-actor-crud`: stage 3 has NO surface here.**
  That one C→A caller was dead surface and was deleted, so the count is zero, not one.
- **Correction 4 — `moduleId` was NOT passed as a constructor string.** This
  document recommended "a plain string, same as `PersistentCreatureIndex` already
  receives it". `PersistentCreatureIndex`'s constructor takes **no arguments**; it
  declares `private moduleId: string = MODULE_ID;` (`creature-index.ts:131`),
  character-for-character what `FoundryDataAccess` does. The new module follows
  that precedent, which keeps all 8 `this.moduleId` reads textually unchanged in
  the body diff. Following the recommendation would have added a constructor
  parameter no sibling has and 8 needless diff lines.
- **What this section got right, and it mattered**: `persistentIndex` **is**
  constructor-injected and no second `PersistentCreatureIndex` was constructed.
  That is the one wiring mistake here that neither `tsc` nor a body diff nor a
  surface diff can see. The test that catches it is
  `compendium-search.test.ts`'s "constructing FoundryDataAccess creates EXACTLY
  ONE PersistentCreatureIndex", which asserts the exact list of hooks that
  constructor registers. Note that a rebuild-then-read round trip does **not**
  catch it — `PersistentCreatureIndex` keeps no in-memory index, so two instances
  share state through the file and the round trip passes either way.
- **Facade members left behind**: six thin delegations for the externally-reached
  members, plus a **temporary** `private` wrapper for `findBestCompendiumMatch`,
  deletable when stage 3 re-points its one caller. **What happened instead:
  `extract-actor-crud` deleted the wrapper because its one caller was itself
  DELETED as dead surface, not re-pointed.** A temporary bridge's expiry condition is
  the _absence of a caller_, not the arrival of a particular pass — worth internalising,
  because the mirror-image mistake is live right now: `getOrCreateFolder`'s wrapper is
  down to one caller (`importActors`, a permanent deferral) and is therefore
  **permanent**, while `auditLog`/`findActorByIdentifier` are down to one caller each
  and expire at stage 4. Same shape, three different lifetimes.
  `getCompendiumDocumentFull`'s delegation is **permanent** — `queries.ts`
  reaches it. Those two look identical in a diff and have different lifetimes.
- **`getSystemSchema` is not in this cluster** (109 lines, no graph edges, pure
  static data) and sits physically inside the region the last four cluster members
  occupy. It stayed.

### Stage 3 — Actor CRUD (cluster C) → `actor-crud.ts` — ✅ **LANDED** as `extract-actor-crud`

**Read the four struck claims below before planning anything from this section.** One of
them — the C → A dependency — is the premise this document's whole staging order was
built on, and it was true only of dead code.

Landed as **five commits inside one OpenSpec change** (a deletion plus four move
stages), not as four changes: the stages share one module boundary, so splitting them
across changes would either restate the ownership requirement four times or let the
later stages land as implementations of a delta written for the first. The staging shape
below was right; four of its specifics were wrong, and each is struck in place because
each is the kind of claim a later reader would act on.

Result: 20 cluster members / 2,092 body lines, of which **16 moved (1,511)**, **two were
deleted rather than moved (191)** and **two stayed (390)**. 34 re-pointings of five
shapes. `data-access.ts` 4,271 → ~2,620.

- **3a (near-zero risk)**: `updateActors`, `updateActorItems`, `deleteActorItems`,
  `deleteActors`. **Zero `this.x()` calls of any kind** — they touch only
  `game.actors`/embedded-document APIs. Correct, and it became **stage A**: the commit
  that establishes the file, the class, the constructor and the wiring, chosen to go
  first precisely _because_ it carries zero re-pointings, so a wiring mistake fails
  alone rather than inside a diff carrying 34 substitutions.
- **3b (low risk, mechanical)**: `setActorOwnership`, `updateWfrp4eActor`,
  `addWfrp4eItems`, `getActorOwnership`. ~~Same three-call rewrite pattern as cluster
  D~~ — **wrong for two of the four, and the count matters because it is what a counted
  substitution is checked against.** `updateWfrp4eActor` and `addWfrp4eItems` do make
  all four calls. `getActorOwnership` makes **two** (`validateFoundryState`,
  `findActorByIdentifier` — **no audit call at all**, on a read path).
  `setActorOwnership` makes **one** (`validateFoundryState` only — **no audit call on a
  write path**). That last asymmetry was moved verbatim and pinned as observed: adding
  the audit call would be a behaviour change smuggled into a relocation.
- **3c (low-medium risk)**: `createNpcActor`, `createActors`, `normalizeMGT2eSkillKeys`
  (private, moves with `createActors`, its only caller) — all correct. ~~`getSystemSchema`
  (no calls at all, pure static reference data — can go anywhere, put it here)~~ —
  **wrong, and it is a decision rather than a detail.** `getSystemSchema` creates
  nothing, updates nothing, deletes nothing and touches no actor; it is **not actor
  CRUD**, and "can go anywhere" is not the same as "belongs anywhere". Putting it in
  `actor-crud.ts` because a convenient stage was passing would give that module a
  concern it does not own. It **stayed on the facade**, recorded as a residual with its
  reason, and `extract-actor-crud` added a requirement stating the exclusion because
  three separate documents have now proposed three different homes for it. Its home is
  stage 4's decision to argue on the merits.
  **Also missing from this sub-stage's list: the seven module-level `NPC_*`/`npc*`
  bindings.** One of them, `NPC_SKILL_MAP`, has **zero** class-member references — it is
  read only by `npcBuildSkillsBlock`, itself module-level — so the travelling set has to
  be a **transitive** closure over top-level declarations, not the answer to "which
  names do the moved bodies mention?". A one-hop query breaks the build in the new file.
- **3d (medium-high risk, depends on stage 2 being done)**: ~~`createActorFromCompendium`~~
  (**deleted — dead surface**), `createActorFromCompendiumEntry`,
  ~~`createActorFromSource`~~ (**deleted — dead by cascade**), `addActorsToScene`,
  `calculateTokenPosition`. ~~Requires stage 2's `compendiumSearch` collaborator to exist
  first (the cross-cluster call).~~ — **it requires nothing from stage 2**: both
  cross-cluster calls were inside the deleted method. `addActorsToScene` does read the
  module-level `ERROR_MESSAGES` import (carried into the new file, correct) but **not**
  `permissionManager`: it reads the facade's injected `this.permissions` **field**, which
  is a different thing and is handled by giving the collaborator a same-named injected
  field so the two reads move with zero diff. And the item this plan does not mention at
  all: **two bare `transactionManager.` module-level identifier uses**, which became
  `this.transactionManager.` — a third shape of permitted difference, and the reason the
  singleton export had to go.
  Also **`CreatedActorInfo`**: after the deletion it has zero class-member references and
  survives only as the element type inside `ActorCreationResult`'s declaration — the same
  two-hop relationship as `NPC_SKILL_MAP`, seen from the other side, and the reason it
  travels but is **not** imported back.
- **What could break, all of 3a–3d**: the rewrite-miss-is-a-compile-error safety net
  applied throughout and caught nothing, because the assembly was mechanical (every
  member sliced from a hashed byte copy of `data-access.ts`, every re-pointing a counted
  substitution that aborts on a wrong count). ~~The specific new risk in 3d is the
  cross-collaborator call (`this.compendiumSearch.x()`)~~ — **there is no such call.**
  The real gate was the per-member body diff: 25 of 27 moved items byte-identical, two
  differing only by a prettier reflow the pre-substitution column measurement predicted.
- **Collision risk with the concurrent change**: moot — that change landed long before.

### Stage 4 — Character reading (cluster B + B′) → `character-reader.ts` — **defer, don't run yet**

- **Moves (once the concurrent change lands)**: `getCharacterInfo`,
  `searchCharacterItems`, `extractSpellcastingData`,
  `formatPF2eActionCost`, `extractPF2eSpellSlots`,
  `extractDnD5eSpellSlots`, `extractDnD5eSpellTargeting`,
  `extractPF2eSpellTargeting`, `extractDSA5SpellTargeting`, plus (pending
  confirmation of where the in-flight branch ultimately wants them)
  `readActorFlags`, `extractTokenArt`
- **Why defer**: two independent reasons, not one.
  1. **Live git collision.** The exact lines this stage would touch
     (`getCharacterInfo`'s body, and the brand-new
     `readActorFlags`/`extractTokenArt` methods) are mid-edit in an
     uncommitted working tree right now. Staging this today means either
     editing on top of someone else's uncommitted diff or racing it.
  2. **The seam isn't settled yet.** `readActorFlags`/`extractTokenArt`
     currently have exactly one caller (`getCharacterInfo`) but sit
     physically in the actor-directory neighborhood of the file — a strong
     hint the author may still be deciding whether they belong with
     character-reading or with `actor-directory.ts`. Moving them now risks
     redoing the move once that's settled.
- **Once it's safe to run**: re-sync (`codegraph sync` or re-run the AST
  script below) before staging, because the concurrent change may have
  added more fields to `CharacterInfo` or more calls out of
  `getCharacterInfo` than exist in this snapshot.
- **Test coverage note**: this is, right now, **the best-tested cluster in
  the file** other than `importActors` — see the test-coverage section.

### Stage 5 (optional, last, or never) — `importActors` and the rest of actor CRUD's tail

See the risk-ranking section below — this is `importActors` specifically, not the rest
of cluster C (handled by `extract-actor-crud`). The verdict is now **permanent
deferral**, restated as a requirement, and it has a consequence later passes are bound
by: `importActors` is the **only** remaining caller of the facade's private
`getOrCreateFolder` wrapper, so that wrapper is permanent and must not be deleted on the
reasoning that the cluster which used it has moved.

## The compatibility boundary

`FoundryDataAccess`'s public surface (what `queries.ts` and `mcp-server`
depend on) is **74 methods** right now (73 from the first pass + the new
`findActorsByFlag`). It must not change shape (name, parameter shape, return
shape) at any stage — only _where the body lives_ changes.

Reproduce the exact list used for this plan, and re-run it after every stage
to diff against the previous run:

```bash
cd /Users/ludo/code/mago20/foundry-vtt-mcp
node -e '
const ts = require("./node_modules/typescript");
const fs = require("fs");
const filePath = "packages/foundry-module/src/data-access.ts";
const src = fs.readFileSync(filePath, "utf8");
const sf = ts.createSourceFile(filePath, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
let classNode;
ts.forEachChild(sf, n => { if (ts.isClassDeclaration(n) && n.name?.text === "FoundryDataAccess") classNode = n; });
const pub = classNode.members
  .filter(m => (ts.isMethodDeclaration(m)) && !(m.modifiers||[]).some(x => x.getText(sf) === "private"))
  .map(m => `${m.name.getText(sf)}(${m.parameters.map(p => p.getText(sf)).join(", ")})`)
  .sort();
console.log(pub.join("\n"));
' > /tmp/public-surface-before.txt

# ...perform one stage...

node -e '<same script>' > /tmp/public-surface-after.txt
diff /tmp/public-surface-before.txt /tmp/public-surface-after.txt   # must be empty
```

This is the same technique (TS AST, not text matching) the first pass used
to verify its 73-method surface was unchanged across all seven of its
stages — it catches a signature drift as a diff line, and a name typo would
already have failed `tsc` before you got this far.

## Load-bearing comments inventory

Grepped for `Do NOT`/`do not`/`never`/`NEVER`/`WRITES`/`writes,`/`deliberately`/
`CRITICAL`/`only *`/`load-bearing`/`RECONCIL` across the whole file (a
superset of the four markers asked for, to catch anything the concurrent
change might have added):

| Comment (location, abbreviated)                                                                                                | Guards                                                                                                                                                                                      | Destination stage                                                                                                                               | Hazard                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `2430-2431`: "why the flag must NOT be read with `actor.getFlag()`"                                                            | facade wrapper JSDoc on `findActorsByFlag`                                                                                                                                                  | Stays on facade forever — it's the wrapper's own doc, already correctly placed (points at `ActorDirectory.findActorsByFlag`, already extracted) | None                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `2452-2461`: "Read via raw property access... NEVER `actor.getFlag(...)`... **Same rule as `importActors`' `findBySourceId`**" | `readActorFlags`                                                                                                                                                                            | Stage 4 (deferred)                                                                                                                              | **Yes — the only real hazard in this inventory.** This comment cross-references `importActors` by name. If `readActorFlags` moves into `character-reader.ts` while `importActors` stays on the facade (or moves into a different `actor-crud.ts`), the sentence still reads correctly in prose but no longer names a file, so a future reader can't find the sibling rule without knowing both files exist. **Fix mechanically at move time**: rewrite to name the actual destination file, e.g. "Same rule as `actor-crud.ts`'s `importActors`." Do this in the same diff that moves `readActorFlags`, not as a follow-up. |
| `6502-6508`: "dryRun... getOrCreateFolder writes, so dry runs only _look up_ folders"                                          | `importActors` (param JSDoc)                                                                                                                                                                | Stage 5 / permanent tail                                                                                                                        | None — self-contained, no other file named                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `6555-6560`: "Read the flag via RAW property access, never `actor.getFlag('wodchar', …)`..."                                   | `importActors`'s `findBySourceId`                                                                                                                                                           | Stage 5 / permanent tail                                                                                                                        | None in itself (this is the comment #2 points at); if `importActors` ever moves, update #2's cross-reference again to match wherever it landed                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `6613-6623`: "RECONCILABILITY — this ordering is load-bearing... Do NOT refactor this into a post-create setFlag/update..."    | `importActors` sourceId-stamp-before-create ordering                                                                                                                                        | Stage 5 / permanent tail                                                                                                                        | None — self-contained                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `6641-6643`: "A skip writes nothing, so settle it BEFORE resolving any folder"                                                 | `importActors` no-op-path ordering                                                                                                                                                          | Stage 5 / permanent tail                                                                                                                        | None                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `6662-6664`: "so an update that keeps its folder never reaches getOrCreateFolder"                                              | `importActors` folder-placement ordering                                                                                                                                                    | Stage 5 / permanent tail                                                                                                                        | None                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `4903-4905`, `5081-5083`, `5316-5318`, `5588-5590`: four "soft validation — collect warnings, never/do NOT block" comments     | `createNpcActor` (**cluster C**, not D — correcting the first doc), `addAttackToActor` (D), `addAuraToActor` (D), `addAttackWithSaveToActor` (D, the fourth one the first doc didn't count) | 3c (createNpcActor) / ✅ Stage 1 (the other three — **moved**, see below)                                                                       | None — all four are self-contained one-liners, no cross-file reference. **But do not locate them by grepping `never`:** the fourth reads "both damage groups unified" and `createNpcActor`'s reads "do NOT block creation", so the grep at the head of this section finds only two of the four. The reliable locator is the `// 3. Soft validation` marker prefix.                                                                                                                                                                                                                                                          |

**Net: the doc's claim of "10 load-bearing comments, all in `importActors`" is
now 12+ once the concurrent change's two new comments are counted (2430,
2452), and one of those two — the `readActorFlags` cross-reference — is the
single comment in this whole file whose correctness depends on which file
its sibling ends up in.** Everything else is genuinely a verbatim, no-edits
move.

**Post-stage-1 status:** the three cluster-D soft-validation comments now live
in `actor-mechanics.ts` (~462 `addAttackToActor`, ~697 `addAuraToActor`, ~969
`addAttackWithSaveToActor`), moved verbatim; `createNpcActor`'s stayed in
`data-access.ts` (~4564) with the method. The per-method body diff the spec now
requires is what proves that mechanically — a dropped or reflowed comment is a
diff line, and the default disposition of an unexplained diff line is revert.
All line numbers in this section predate stage 1 and are stale by roughly
−1,740 lines below the cluster; recount rather than trusting them.

## Risk ranking, actor-CRUD called out specifically

Lowest to highest:

1. **Stage 3a** (`updateActors`/`updateActorItems`/`deleteActorItems`/`deleteActors`) — ✅ landed as `extract-actor-crud`'s **stage A**. No `this.x()` calls, and — the reason it went first within that pass, beyond confidence-building — it is the commit that establishes the file, class, constructor and wiring, so it does that with **zero** re-pointings and a wiring mistake fails alone.
2. **Stage 1** (actor-mechanics builders, cluster D) — mechanical, repetitive, zero cross-cluster edges, no tests; risk is transcription error in long method bodies, not architecture.
3. **Stage 3b** (`setActorOwnership`/`updateWfrp4eActor`/`addWfrp4eItems`/`getActorOwnership`) — ✅ landed. ~~Same shape as stage 1.~~ Two of the four are not: `getActorOwnership` makes two calls and `setActorOwnership` one, and **neither audits**. 19 re-pointings in that commit, not the 23 the task list derived from this claim.
4. **Stage 2** (compendium search, cluster A) — ✅ landed. Internally more complex (a three-member recursive cycle, 5-way system dispatch), but self-contained. The predicted risk — "the two facade wrapper methods it must leave behind for cluster C" — was mis-stated: only **one** wrapper is a cluster-C bridge (`findBestCompendiumMatch`, private, temporary), while `getCompendiumDocumentFull`'s delegation is permanent because `queries.ts` reaches it independently. The realised risk was elsewhere: five re-pointings against 864 moved body lines left `tsc` with almost nothing to catch.
5. **Stage 3c** (`createNpcActor`/`createActors`) — ✅ landed. Pulled in the `createNpcActor` soft-validation comment, verbatim, plus **seven** module-level `NPC_*`/`npc*` bindings this plan does not list — one of which (`NPC_SKILL_MAP`) no moved body references at all. Not `getSystemSchema`: see the stage 3 section.
6. **Stage 3d** (compendium-backed actor creation) — ✅ landed. ~~Depends on stage 2 existing; medium, because a wiring mistake in the new cross-collaborator call would surface as "actor creation from compendium silently fails to find a match"~~ — **there is no cross-collaborator call.** Both were inside `createActorFromCompendium`, which was dead surface and was deleted. The real content of that commit turned out to be the `PermissionManager` and `TransactionManager` injections, the removal of `transaction-manager.ts`'s singleton export, and the four travelling type declarations.
7. **Stage 4** (character reading) — **the only stage left.** — code-risk is actually moderate-low (best test coverage in the file besides `importActors`), but **currently has the highest _process_ risk** because it's mid-edit by someone else. Not a code problem, a sequencing problem.
8. **`importActors` — the highest-risk single method in the file, called out on its own.**

**Verdict on `importActors`: leave it as the permanent facade tail. Do not
schedule it as part of this decomposition.** Reasoning:

- It was verified against a **live production world today**. Any transcription
  slip that reaches production silently (e.g. a subtly reordered
  `resolveFolder`/sourceId-stamp/skip-check, or a dropped `await`) would only
  manifest as an intermittent duplicate-actor bug under a slow or timed-out
  request — exactly the failure mode its own comments exist to prevent, and
  exactly the kind of bug code review is worst at catching in a large diff.
- Its LOC savings are small relative to the risk: **~280 of ~7,000 lines,
  about 4%**. It is _already_ well-isolated (a single cross-call to
  `getOrCreateFolder`, itself already a thin `actor-resolver` wrapper) — its
  current placement on the facade isn't creating any of the coupling this
  refactor is trying to remove, and leaving it in place blocks nothing else
  in this plan (stages 1–3 don't touch it).
- It genuinely does have the **best test coverage of anything in the class**
  (all 25 of the module's pre-existing tests target it exclusively, covering
  dry-run, reconciliation, folder placement, and per-actor error capture). If
  someone insists on moving it anyway, that's the one argument in favor: a
  move that leaves all 25 assertions passing unchanged is about as strong a
  behavior-preservation proof as this codebase can produce without a live
  smoke test. But that proof only covers the scenarios the 25 tests thought
  to write — it does not cover "reached a live production world."
- If it is ever moved, do it **solo** — its own stage, nothing bundled with
  it, run only when no one is depending on the live server, followed by a
  manual dry-run smoke test against a scratch world (never production)
  before calling it done.

## Test-coverage reality

> **Stale — recount before relying on it.** As of `extract-compendium-search` the
> package has **4 test files, 167 cases** (`import-actors.test.ts` 28,
> `actor-read-path.test.ts` 17, `actor-mechanics.test.ts` 41,
> `compendium-search.test.ts` 81); workspace-wide `npm run test --workspaces` is
> **449**. Recommendations 1 and 2 below are done. Clusters A and D are no longer
> unguarded; **clusters B and C still are**, except `importActors`. The paragraph
> below is left as written because its _argument_ — that `tsc` plus manual diffing
> is the only net over long hand-built bodies — is what motivated both test changes
> and still applies to stages 3 and 4.

**28** was the number quoted before this session's concurrent work; as of
right now the package has **2 test files, ~43-45 test cases** (`vitest run`
reports 45), because the in-flight WoD-read-path change just added
`actor-read-path.test.ts` (~18 tests) alongside the pre-existing
`import-actors.test.ts` (25 tests). That is genuinely good news for stage 4
— but it means, precisely:

- **Covered**: `importActors` (25 tests) and `getCharacterInfo`'s new
  flags/art fields + `findActorsByFlag` (18 tests). That's **3 of 61**
  methods in scope for this plan.
- **Completely unguarded by any test**: all 20 compendium/creature-search
  methods (cluster A), the other 8 character-reading methods (cluster B),
  all 20 actor-CRUD methods except `importActors` (cluster C), and all 9
  actor-mechanics builders (cluster D) — **58 of 61 methods**, including
  every method in stages 1, 2, and 3 of this plan.
- Every stage 1–3 relies on `tsc` (wrong collaborator/name = compile error)
  and manual line-for-line diffing as the _only_ safety net. That was true
  of the first pass too, and it held for seven stages — but the first pass's
  stages were mostly "move a whole self-contained class or a tight group of
  wrapper methods verbatim." Stages 1 and D specifically involve **long
  (100-280 line), hand-built, mostly-similar-looking method bodies** where a
  misplaced block wouldn't be a compile error.

**Cheapest tests worth adding first, in priority order:**

1. ✅ **DONE — One characterization test per stage-1/D method, before moving it**
   — not full coverage, just "call it with a representative payload against a
   fake actor, snapshot the resulting embedded-item `system` data and the
   `auditLog` call." These nine methods build near-identical shapes (item
   data + warnings array + `createEmbeddedDocuments` call), so one shared
   test helper (a fake `Actor`/fake `game` harness, which `import-actors.test.ts`
   and `actor-read-path.test.ts` both already build independently — worth
   factoring out into one shared fixture) makes each individual test cheap.
   This is the single highest-value thing to do before stage 1, because it's
   the stage with the most "long body, easy to mis-transcribe, currently zero
   tests" risk in the whole plan.

   Landed as `14d392c`: the shared fixture is
   `src/__fixtures__/fake-foundry.ts` and the tests are
   `src/actor-mechanics.test.ts` (41 cases, all nine builders plus
   `createNpcActor`). They assert whole documents with `toEqual`, not spot
   checks, and they were green against the **pre-move** source before stage 1
   started — which is now the spec's requirement, not just good practice. The
   remaining recommendations below (2 and 3) are unchanged and still pending.

2. ✅ **DONE — A handful of `searchCompendium`/`listCreaturesByCriteria`
   tests** before stage 2 — at minimum one per system-specific
   `passesXCriteria` branch (5 systems) plus one exercising the recursion
   path, since that's the one place in cluster A where a move-time slip
   (splitting the cycle across files, or losing the recursion) would be
   entirely invisible to `tsc`.

   Landed as `c1f12d5`: `src/compendium-search.test.ts`, **81 cases**, on an
   extended `src/__fixtures__/fake-foundry.ts` that gained a fake `game.packs`
   (`metadata`/`index`/`getDocuments`/`getDocument`) — which no existing test
   needed and so did not exist. They pin the returned result set in full
   (contents, ordering, ranking, truncation at the limit) plus the filter
   decision that determines membership, with one case per system branch, and
   they were green against the **pre-move** source. Verified to bite: 35
   deliberate mutations of the pre-move `data-access.ts` — flipped comparisons,
   defence/size/creatureType key swaps across the near-identical branches,
   discriminator reordering, each of the four `sanitizeData` sites
   individually, both limits, every CR-band boundary, a dropped
   `validateFoundryState()`, `every`→`some`, a severed cycle, and a second
   `PersistentCreatureIndex` — all 35 caught.

   Two things it taught that generalise. **The recursion test has to drive the
   real cycle**, not a stub: "drives the whole three-cycle in one call" is what
   fails (6 cases) when the cycle is severed. And **~25 of
   `calculateRelevanceScore`'s 59 lines are unobservable through the facade** —
   it receives the already-built result envelope, which carries no `system`, so
   `entryCR` is always `0` and `entryType` always `''`, and the creatureType
   (+20) and challengeRating (+15/+10) bonuses can never fire. The tests
   therefore pin the _consequence_ (a CR range and a creatureType filter cannot
   reorder results) rather than asserting something vacuous. For those lines the
   body diff is the only guard, which is a reason not to "tidy" an apparently
   dead scoring branch while moving it.

3. ~~**A `createActorFromCompendium` test asserting the compendium-search
   cross-call** before stage 3d specifically~~ — **moot, and instructively so.**
   There was nothing to test: `createActorFromCompendium` was dead surface and was
   deleted, so the cross-call it was supposed to protect never existed at runtime. A
   test written for it would have pinned code nothing could reach. What stage 3
   **did** need, and got as `3cbe106`, was 155 characterization cases over the
   fourteen reachable actor-CRUD members, proven against 98 mutations.
4. Do **not** invest in new tests for `importActors` beyond what's already
   there — it's already the best-covered method in the file, and (per the
   verdict above) the plan is to leave it untouched anyway.

If only one of these is worth doing, it's #1 — factor the fake-Foundry-world
test harness the two existing test files each built independently into one
shared fixture, then write nine short characterization tests against it
before touching cluster D. That single investment de-risks the
lowest-hanging, highest-line-count, zero-coverage stage in this whole plan.

## What I would leave alone entirely

Beyond the `importActors` verdict above: the 43 already-thin facade wrapper
methods (delegates to the first pass's 8 collaborators) need no further
work — they're already single-line delegates and touching them again would
be motion without value. ~~And `getSystemSchema` (zero calls, pure static data) can go into whichever file is
convenient in stage 3 without needing its own analysis~~ — **struck.** It is true that
it has no graph edges in or out; it does not follow that it can go anywhere. It is not
actor CRUD, `extract-actor-crud` left it on the facade as a recorded residual, and the
ownership requirement that pass added states the exclusion as a requirement, because
"can go anywhere" had by then been read as "put it in the file a stage is already
touching" in three documents. Stage 4 decides its home on the merits.

## Methodology (how every number above was produced)

1. `codegraph sync` against the live (concurrently-edited) working tree, then
   `codegraph node FoundryDataAccess` for the member list with line numbers —
   cross-checked against a plain `grep -nE` method-signature scan of the raw
   file, which agreed on all 104 methods + constructor.
2. A TS-compiler-API script (`ts.createSourceFile` + a visitor over
   `ClassDeclaration.members`) walked every method body of
   `FoundryDataAccess`, collecting every `this.<ident>(...)` call expression
   and every bare `this.<ident>` property access, keyed to line ranges. This
   is the same technique as the public-surface diff above, just applied to
   the whole class instead of only its public members — it is what
   produced every "calls" and "cross-boundary" claim in this document, not
   grep.
3. `git diff -- packages/foundry-module/src/data-access.ts` (`--` scoping so
   this stays read-only and never touches the index) for the exact line
   ranges under concurrent edit, cross-checked against the method inventory
   from step 1 to determine which clusters are safe to stage today.
4. `npx vitest run --reporter=verbose` in `packages/foundry-module` for the
   exact current test count and which methods each test file exercises.
