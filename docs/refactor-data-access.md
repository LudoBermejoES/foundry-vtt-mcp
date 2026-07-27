# `data-access.ts` God-class split — module map

> **This document is spec-designated.** It is the authoritative inventory
> required by the `foundry-module-architecture` capability — see
> `mago20/openspec/specs/foundry-module-architecture/spec.md`, requirement
> _"The module map is the inventory and is updated with every extraction"_, and
> the change that established it, `specify-foundry-module-architecture`.
> Keeping it current is a **requirement**, not a courtesy: any change that
> extracts a concern, adds a collaborator, moves a load-bearing comment, or
> defers a move must update this file in the same change. There is no automated
> drift guard (see "Verifying this file is current").
>
> The forward plan for the remaining clusters lives in
> `refactor-data-access-stage2.md`, which refines — and does not supersede — the
> "Not yet extracted" section below.

`packages/foundry-module/src/data-access.ts` held two classes and 138
methods (10,554 lines). `FoundryDataAccess` is the only entry point into
Foundry for `queries.ts`, `main.ts` and `settings.ts`, and
`packages/mcp-server` depends on the shapes it returns, so this split is a
**facade + collaborators** refactor: the class stays the entry point with an
unchanged externally-reached surface, and its implementation is delegated to
small, single-purpose collaborator classes held as private fields. No
behaviour, signature, or side-effect ordering was changed — see the
drift-safety notes at the end.

## Layout

**Sizes are approximate magnitudes for prioritisation only.** They are quoted
as of the recount below and drift with every commit; describe structure by
symbol and file, never by line number. Recount with
`wc -l packages/foundry-module/src/*.ts`.

| File                     | Lines (approx.) | Extracted from `FoundryDataAccess`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Depends on                                  |
| ------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| `creature-index.ts`      | ~1,450          | The **other** class in the original file, `PersistentCreatureIndex` (26 methods) — file-based creature index cache for D&D5e/PF2e/Cosmere/MGT2e. Already fully self-contained (used only via one field, `this.persistentIndex`); moved verbatim.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | —                                           |
| `security.ts`            | ~220            | `validateFoundryState`, `auditLog`, `sanitizeData`, `removeSensitiveFields`, `isSensitiveOrProblematicField`, `safeJSONStringify` — the output-sanitization/write-audit helpers called from nearly every concern.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | —                                           |
| `actor-resolver.ts`      | ~90             | `findActorByIdentifier`, `getOrCreateFolder` — actor/folder lookup used across item CRUD, feature/attack builders, WFRP4e updates, journal/actor creation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | —                                           |
| `permissions.ts`         | ~255            | Not extracted from `FoundryDataAccess` — a pre-existing cross-cutting module. `PermissionManager`: `checkWritePermission` (10 call sites), `auditPermissionCheck` (3, body currently a no-op), plus three methods called from nowhere. Listed here because the facade now **constructs and injects** it, so it is a third leaf; it no longer exports a module-level `permissionManager` instance.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | —                                           |
| `journal-manager.ts`     | ~285            | `createJournalEntry`, `listJournals`, `getJournalContent`, `getJournalPageContent`, `updateJournalContent`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `security`, `actor-resolver`, `permissions` |
| `world-items-manager.ts` | ~270            | `listWorldItems`, `updateWorldItems`, `createWorldItems`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `security`                                  |
| `actor-directory.ts`     | ~255            | `listActors`, `getFriendlyNPCs`, `getPartyCharacters`, `getConnectedPlayers`, `findPlayers`, `findActor`, **`findActorsByFlag`** (added by the `03a6836` read-path change, which is why this file grew from the 164 lines first recorded here). **Carries a load-bearing comment** — see the inventory below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `security`, `actor-resolver`                |
| `roll-manager.ts`        | ~920            | Interactive roll-request chat cards: `validateWritePermissions`, `requestPlayerRolls`, `resolveTargetPlayer`, `buildRollFormula`, `getSkillCode`, `buildRollButtonLabel`, `attachRollButtonHandlers`, `saveRollState`, `getRollState`, `saveRollButtonMessageId`, `getRollButtonMessageId`, `getRollStateFromMessage`, `updateRollButtonMessage`, `requestRollStateSave`, `broadcastRollState`, `cleanOldRollStates`, `rollDice`, plus the `rollButtonProcessingStates` in-flight-click map.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `security`, `permissions`                   |
| `scene-token-manager.ts` | ~700            | `getActiveScene`, `getTokenDisposition`, `listScenes`, `switchScene`, `getCharacterEntity`, `moveToken`, `updateToken`, `deleteTokens`, `getTokenDetails`, `toggleTokenCondition`, `getAvailableConditions`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `security`, `permissions`                   |
| `compendium-search.ts`   | ~1,110          | The compendium/creature-search cluster, extracted by `extract-compendium-search`: `searchCompendium`, `shouldApplyFilters`, `calculateRelevanceScore`, `matchesSearchCriteria`, `listCreaturesByCriteria`, `passesEnhancedCriteria`, the four `passes*Criteria` system branches (`MGT2e`, `CosmereRpg`, `DnD5e`, `PF2e`), `fallbackBasicCreatureSearch`, `findBestCompendiumMatch`, `getCompendiumDocumentFull`, `getAvailablePacks`, `getEnhancedCreatureIndex`, `rebuildEnhancedCreatureIndex` — **16 members, 864 body lines** — plus the nine type declarations only they use (`CompendiumSearchResult`, the five-member creature-index family, `CompendiumEntryFull`/`CompendiumItem`/`CompendiumEffect`). Nothing here writes, so there is **no audit call anywhere in the module**. `persistentIndex` is **constructor-injected**, not constructed: a second instance would type-check and split the rebuild writer from every reader. Pinned by `compendium-search.test.ts` (81 cases). Carries **no** load-bearing comment. | `security`, `creature-index`                |
| `actor-mechanics.ts`     | ~1,890          | The nine actor-mechanics builders: `useItem`, `addSaveFeatureToActor`, `addAttackToActor`, `addAuraToActor`, `addPassiveFeatureToActor`, `addAttackWithSaveToActor`, `setActorSpellcasting`, `addSpellsToActor`, `addFeaturesFromCompendium`, plus the module-level dnd5e helpers only they use (`slugify`, the attack/aura/attack+save canonical damage-type sets, the four spellcasting slot tables). **`createNpcActor` is NOT one of them** — it is actor CRUD, and it sits physically between two of the nine, so a contiguous excision takes it along. **Carries three load-bearing comments** — see the inventory below.                                                                                                                                                                                                                                                                                                                                                                                                      | `security`, `actor-resolver`                |
| `data-access.ts`         | ~4,270          | The facade: unchanged externally-reached surface, thin delegations to the above, plus everything not yet extracted (see below). Was 7,099 at `902f3f0`; the `03a6836` read-path change added the `include`-option plumbing and the flag/token-art helpers, `extract-actor-mechanics-builders` took ~1,740 lines back out, and `extract-compendium-search` took a further ~1,210 (994 for the move, 242 for the four dead methods deleted ahead of it).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | all of the above                            |

`FoundryDataAccess`'s own fields, in construction order (matters — later
fields' initializers reference earlier ones):

```ts
private moduleId, persistentIndex, security, actorResolver, permissions,
        journals, worldItems, actorDirectory, rollManager, sceneTokenManager,
        actorMechanics, compendiumSearch;
```

`permissions` sits with the other leaves, **before** `journals`/`rollManager`/
`sceneTokenManager`, which receive it as a constructor argument.
`actorMechanics` takes `(security, actorResolver)`. `compendiumSearch` is last
and takes `(security, persistentIndex)` — note the second argument: it is the
facade's **existing** `persistentIndex`, and passing a fresh
`new PersistentCreatureIndex()` there compiles, breaks no other test, and
silently splits the index's writer (`rebuildEnhancedCreatureIndex`, driven from
`main.ts`/`settings.ts`) from every reader. The test that catches it is
`compendium-search.test.ts`'s "constructing FoundryDataAccess creates EXACTLY ONE
PersistentCreatureIndex", which asserts the exact list of Foundry hooks the index
constructor registers. The rebuild-then-read round trip does **not** catch it:
`PersistentCreatureIndex` holds no in-memory index, so two instances share state
through the file and the round trip passes either way.

## The externally-reached surface (the compatibility boundary)

The frozen surface is defined by **who reaches it**, not by the
`public`/`private` modifier — the spec's compatibility-boundary requirement
turns on exactly this. Measured against the current source, the class declares
**104 members** (74 non-private methods + 17 private methods + 12 private
collaborator/config fields + the constructor — the 10th field is `permissions`,
added by `inject-permission-manager`, the 11th `actorMechanics`, added by
`extract-actor-mechanics-builders`, the 12th `compendiumSearch`, added by
`extract-compendium-search`), of which **66 are actually reached from outside** —
65 class members plus `ensureButtonStatesForMessage`, which `main.ts` probes on
the facade object and which **is not a member of the class at all**.

The non-private count is unchanged by the extractions: every externally-reached
member keeps a thin delegation, which is the point. The private count fell from
30 to 17 because nine private helpers moved into `compendium-search.ts` and four
private dead methods were deleted. The nine mechanics builders and the six
externally-reached search members stayed on the surface as thin delegations for
exactly this reason — all fifteen are reached, so none was droppable as dead
surface.

**Do not read the 66 as "5 more than the 61 recorded before `extract-compendium-search`".**
It is not a comparable figure: 61 was produced by a different extractor. The 66
was measured by unioning two detectors over all seven reach sites — the type
checker (which resolves `queries.ts`'s `this.dataAccess.X`) and a receiver-text
match on `da`/`…dataAccess` (needed because `settings.ts`'s
`bridge?.dataAccess?.X`, `main.ts`'s `this.queryHandlers?.dataAccess.X` and the
test files' `const da = await makeDataAccess()` all go through an `any`, which the
checker cannot resolve). Note also that the package `tsconfig.json` **excludes**
`**/*.test.*`, so an extractor built from `parsed.fileNames` alone silently omits
all four test files — which are part of the boundary. What matters for a
restructuring pass is that the _same_ extractor run before and after diffs to
nothing; for `extract-compendium-search` it did, on both the strict and a
deliberately over-approximating pass. No member is reached **only** from a test
file.

There are **seven** external reach sites, and `queries.ts` is not the only one.
(This said "exactly five" until `extract-actor-mechanics-builders`; `14d392c`
added a third test file and did not update the count, and `c1f12d5` added a
fourth. Recount, do not trust a figure here that a later commit could have
invalidated.)

| Reach site                  | Accesses | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `queries.ts`                | ~116     | The bridge. 75 `CONFIG.queries[…]` registrations, each a `handleX` that calls `this.dataAccess.X(…)`.                                                                                                                                                                                                                                                                                                                                                                                                     |
| `main.ts`                   | 7        | `queryHandlers.dataAccess.attachRollButtonHandlers` (`:638`, `:646`), `.rebuildEnhancedCreatureIndex` (`:137`–`:138`), `.saveRollState` (`:557`).                                                                                                                                                                                                                                                                                                                                                         |
| `settings.ts`               | 2        | `bridge?.dataAccess?.rebuildEnhancedCreatureIndex` (`:47`).                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `import-actors.test.ts`     | —        | 28 cases, all targeting `importActors`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `actor-read-path.test.ts`   | —        | 17 cases, targeting `getCharacterInfo`'s flags/art fields and `findActorsByFlag`.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `actor-mechanics.test.ts`   | —        | 41 characterization cases, targeting all nine mechanics builders plus `createNpcActor`. Added by `14d392c` as the precondition for extracting them; they pin the **document handed to Foundry**, not the return envelope.                                                                                                                                                                                                                                                                                 |
| `compendium-search.test.ts` | —        | 81 characterization cases, targeting the six externally-reached search members (the other ten are private and are exercised **through** `searchCompendium`/`listCreaturesByCriteria`). Added by `c1f12d5` as the precondition for extracting them; they pin the **returned result set** — contents, ordering, ranking, truncation at the limit, and the filter decision that determines membership, one case per system branch. Includes the wiring gate that catches a second `PersistentCreatureIndex`. |

**Consequence for extraction passes:** three members (`attachRollButtonHandlers`,
`rebuildEnhancedCreatureIndex`, `saveRollState`) are reached **only** from
`main.ts`/`settings.ts` and by no query handler and no test. Judging the boundary
from `queries.ts` alone would classify them as internal and therefore freely
deletable, which would silently break the roll-button chat hook and the
creature-index rebuild setting. Always include `main.ts` and `settings.ts`.

**Recounted by `extract-compendium-search`: 9 non-private members are reached from
nowhere at all**, not the 13 recorded when this section was written. In full:
`createActorFromCompendium` (the bridge query of that name is handled by
`handleCreateActorFromCompendium`, which calls `createActorFromCompendiumEntry`
instead), `getCharacterEntity`, and seven roll-state members reached only from
inside `roll-manager.ts` — `getRollState`, `saveRollButtonMessageId`,
`getRollButtonMessageId`, `getRollStateFromMessage`, `requestRollStateSave`,
`broadcastRollState`, `cleanOldRollStates`. `updateRollButtonMessage` is **not**
one of them: `main.ts:529` reaches it, which is exactly the trap this section
warns about.

None of the nine is in the compendium/creature-search cluster and none was
touched by that pass. They remain dead-surface candidates, **not** cleaned up
here: deleting a non-private member is a boundary change under the spec and
belongs to its own change. The four methods `extract-compendium-search` **did**
delete were all `private`, which is a different classification — see the
extraction note below.

The figure is recorded here rather than left implicit because it is the one number
in this document a future pass would act on. Two intermediate recounts have now
disagreed with it (13, then 7, then 9): the 7 came from a list that omitted
`createActorFromCompendium` and `requestRollStateSave`. Recount before acting.

A reproducible extractor for this list (TS compiler API, ~90 lines, no
dependency beyond the `typescript` already in the repo) is described in
`refactor-data-access-stage2.md` under "The compatibility boundary". Run before
and after a pass and diff; the diff across `902f3f0` is empty, and across
`03a6836` it shows exactly that commit's two intentional additive changes
(`findActorsByFlag` added, `getCharacterInfo` gaining `options?`).

## Why not a pure by-system split

Confirmed before touching anything: only 14 of 138 methods name a system
(7 PF2e, 6 DnD5e, 1 DSA5), and system branching happens at ~16 dispatch
sites on hardcoded ids _inside_ otherwise-generic methods. A by-system split
would have moved those 14 methods and left a ~9,000-line file. The seams
that actually exist are call-graph clusters around **shared cross-cutting
utilities** (`validateFoundryState`/`auditLog`/`sanitizeData` — used from
~60 call sites across every concern; `findActorByIdentifier`/
`getOrCreateFolder` — used from item CRUD, feature builders, journals,
actor creation) plus **concern groups** (rolls, journals, world items,
scenes/tokens, actor directory, actor CRUD, actor mechanics builders,
compendium/creature search, character reading). This is the axis the split
follows.

## Handling cross-boundary calls (the "mind `this`" problem)

Two mechanisms, chosen per case:

1. **Methods that stay on the facade** call other facade methods exactly as
   before (`this.validateFoundryState()`, `this.auditLog(...)`, etc.) — those
   stayed as thin `private`/public wrapper methods on `FoundryDataAccess`
   that delegate one line to the matching collaborator
   (`this.security.validateFoundryState()`). No caller anywhere in the
   700+ remaining call sites needed to change.
2. **Methods that moved into a collaborator** had their internal
   cross-cutting calls rewritten from `this.X()` to `this.security.X()` /
   `this.resolver.X()` / `this.permissions.X()`, with the collaborator instance
   **constructor-injected**
   (e.g. `new JournalManager(security, actorResolver, permissions)`), not
   reached for via a back-reference to the facade — and not via a module-level
   singleton import either. This keeps the dependency graph a
   DAG (`security`/`actor-resolver`/`permissions` are the **three** leaves;
   concern modules depend on
   them, never the reverse) and makes a forgotten rewrite a **compile
   error** (`tsc` fails with "property does not exist"), not a silent
   behaviour change — this was the actual safety net given the thin coverage
   (at the time of the split, one test file with 28 cases, all of them
   targeting `importActors`).

   **Current coverage, recounted:** 4 test files, **167 cases** —
   `import-actors.test.ts` (28), `actor-read-path.test.ts` (17, added by
   `03a6836`), `actor-mechanics.test.ts` (41, added by `14d392c`) and
   `compendium-search.test.ts` (81, added by `c1f12d5`).
   Workspace-wide `npm run test --workspaces` is 449 (282 `mcp-server` + 167
   `foundry-module`). The "28" first recorded here was correct for the single
   test file that existed then; it is now the count of one of four files, not
   of the package.

   **And type-checking is no longer the whole gate.** For a cluster of
   hand-written data-object bodies, `tsc` catches every missed `this.X()`
   rewrite and cannot see a mis-transcription _inside_ a 270-line literal. The
   spec now also requires a **per-method byte-for-byte body diff** against the
   pre-move source, with the expected mechanical re-pointings enumerated in
   advance and every other differing line treated as a defect to revert — plus
   characterization tests that pass against the pre-move source **before** the
   move. `extract-actor-mechanics-builders` is the first pass held to it:
   36 re-pointings enumerated (9 `validateFoundryState`, 9
   `findActorByIdentifier`, 18 `auditLog`), nine bodies diffed, one permitted
   extra difference (a prettier reflow forced by one of the 36 pushing a line
   past 100 columns).

   **`extract-compendium-search` is the second, and it shows the other extreme:
   five re-pointings against 864 moved body lines**, so `tsc` had almost nothing
   to catch and effectively all the risk sat on the body diff. Two things follow,
   both worth reusing.
   - **A re-pointing is not necessarily a call.** This cluster's cross-boundary
     surface was 4 × `this.sanitizeData(…)` and 1 × `this.validateFoundryState()`
     — and, separately, 11 **bare field reads** (`this.moduleId` × 8,
     `this.persistentIndex` × 3). Those eleven were made **zero-diff** by giving
     the collaborator fields of the _same names_: `private moduleId: string =
MODULE_ID;` as a field initializer (matching `data-access.ts` and
     `creature-index.ts:131`, and **not** the constructor-string form stage 2
     recommended, which has no precedent in this package) plus a
     constructor-injected `persistentIndex`. Re-pointing them at a bare
     `MODULE_ID` would have added 8 permitted differences to a diff whose whole
     purpose is to be nearly empty, and bought nothing — the field has to be
     declared either way, and a forgotten declaration is a compile error either
     way.
   - **One difference was neither a re-pointing nor a reflow, and it is
     structural rather than incidental.** The single moved member the facade must
     still call — `findBestCompendiumMatch`, kept alive for
     `createActorFromCompendium` — had to lose its `private` modifier, because a
     `private` member of the collaborator is unreachable from the facade (TS2341)
     and is also reported unused (TS6133). Expect exactly one such line per moved
     member that a retained facade wrapper delegates to, and enumerate it up
     front rather than discovering it at type-check time.
   - **13 of the 16 bodies came out byte-identical, and no reflow occurred at
     all**, despite `this.sanitizeData(` → `this.security.sanitizeData(` adding 9
     characters at four sites: measured, the longest lands at 73 columns against a
     100-column print width. Predict reflow from measured column widths, not from
     the length of the substitution.

Three genuinely dead private wrapper methods
(`removeSensitiveFields`/`isSensitiveOrProblematicField`/`safeJSONStringify`)
were deleted from `data-access.ts` rather than kept as unused wrappers,
since after `sanitizeData` was rewritten to delegate directly to
`security.sanitizeData()`, nothing else in the facade called them —
`tsc`'s unused-private-member check caught this immediately.

`extract-compendium-search` deleted four more, and they are a different case
worth distinguishing: `passesFilters`, `prioritizePacksForCreatures`,
`passesCriteria` and — by cascade — `getPackPriority`, 220 body lines reached from
nothing. All four were `private`, so this was an **internal** deletion, not dead
surface and not a boundary change. `tsc` had **not** caught them, and would not
have: three carried a hand-written `// @ts-ignore - Unused method kept for
compatibility` (or "Legacy method"), deleted with them. Take nothing from a clean
type-check where a suppression is in scope — check the reach sites. The one
without a suppression, `getPackPriority`, was read by one of the dead three, so
deleting them made the cascade self-verifying: the compiler reported exactly one
new TS6133.

## Not yet extracted (highest-value next stages)

`data-access.ts` is down to ~4,270 lines. In priority order for a follow-up
pass, using the same facade+collaborator pattern. (Cluster 4, the actor-mechanics
builders, was the first of these to land — `extract-actor-mechanics-builders` —
and its row has moved up into the Layout table. `refactor-data-access-stage2.md`
records why it went first: it is the only one of the four with zero `this.x()`
edges to another unextracted cluster. Cluster 1 followed, as
`extract-compendium-search`, because **A must precede C**:
`createActorFromCompendium` calls two of its members.)

**~~1. Compendium/creature search~~ — done.** Moved to `compendium-search.ts` by
`extract-compendium-search`; see the Layout table. The **~1,500 lines** recorded
here was an overstatement, and the members list above it was wrong in three
places, each corrected by the AST re-derivation that pass performed:

- **20 members, 1,084 body lines**, of which **16 moved (864 body lines)** and
  **four were deleted, not moved** — `passesFilters`,
  `prioritizePacksForCreatures`, `getPackPriority`, `passesCriteria`: 220 body
  lines reached from nothing. All four were **`private`**, so under the
  compatibility-boundary requirement these were deletions of **internal**
  members, **not** dead surface and **not** boundary changes. Three of them
  carried a hand-written `// @ts-ignore - Unused method kept for compatibility`
  (or "Legacy method") whose claim the reach analysis falsified; those comments
  are not load-bearing and were deleted with the members. `noUnusedLocals` is on
  and TS **does** report TS6133 for an unused private method, so the diagnostic
  had been silenced by hand — a clean type-check attested to nothing there.
  `getPackPriority` carried no suppression because the dead
  `prioritizePacksForCreatures` read it, which made the cascade self-verifying:
  deleting the other three produced exactly one new error, TS6133 on
  `getPackPriority`.
- **The recursion is a three-cycle, not a pair.** Every earlier document said
  "`searchCompendium` ↔ `fallbackBasicCreatureSearch` are mutually recursive".
  There is **no direct edge** between them. The strongly-connected component is
  `searchCompendium` → `listCreaturesByCriteria` → `fallbackBasicCreatureSearch`
  → `searchCompendium`, and its third member is itself externally reached from
  `queries.ts`. Moving only the named pair would have left the moved
  `searchCompendium` calling `this.listCreaturesByCriteria` and forced a
  back-reference to the facade — the prohibited outcome, produced by following the
  record literally. Compute the SCC, do not copy it from prose.
- **`createActorFromCompendiumEntry` does not call into this cluster.** The
  earlier claim that `createActorFromCompendium`/`…Entry` both do is wrong:
  `…Entry` calls `addActorsToScene`, `auditLog`, `getOrCreateFolder` and
  `validateFoundryState`, none of which is in it. There is exactly **one**
  cluster-C → cluster-A caller, `createActorFromCompendium`, with one call each to
  `findBestCompendiumMatch` and `getCompendiumDocumentFull`.

**Follow-up this pass deliberately did not do:** the five-member creature-index
type family (`DnD5eCreatureIndex`, `PF2eCreatureIndex`,
`CosmereRpgCreatureIndex`, `MGT2eCreatureIndex`, `EnhancedCreatureIndex`) is now
declared in **three** places inside this one package — `creature-index.ts`,
`compendium-search.ts`, and `packages/mcp-server/src/systems/types.ts`'s
differently-shaped mirror — where before it was two. The first two copies are
**byte-identical** today, and `compendium-search.ts` already imports
`PersistentCreatureIndex` from `creature-index.ts`, so importing the types
instead of copying them would change the moved bodies by not one character.
Rejected anyway, for the pass: it needs `creature-index.ts` edited to export five
declarations (a second module changed by a relocation pass), and the response-shape
mirroring requirement records this family as declared in three trees with up to
four copies each and structurally divergent between them (flat vs nested
`systemData`, `hasSpells` vs `hasSpellcasting`) — reconciling two of four while
ignoring the other two is the half-change that requirement exists to forbid. Worth
raising as its own change, with its own inventory, and the third copy is a fair
argument for raising it soon.

2. **Character reading** (~700 lines): `getCharacterInfo`,
   `searchCharacterItems`, `extractSpellcastingData` and its
   PF2e/DnD5e/DSA5 slot/targeting helpers. Depends on `security` +
   `actor-resolver`.
3. **Actor CRUD** (~2,500 lines, highest risk — see load-bearing comments
   below): `createActorFromCompendium(Entry)`, `createActorFromSource`,
   `addActorItems`, `removeActorItems`, `setActorOwnership`,
   `getActorOwnership`, `updateWfrp4eActor`, `addWfrp4eItems`,
   `normalizeMGT2eSkillKeys`, `createNpcActor`, `createActors`,
   `importActors`, `updateActors`, `deleteActors`, `updateActorItems`,
   `deleteActorItems`, `getSystemSchema`. Depends on `security`,
   `actor-resolver`, and — via `createActorFromCompendium`'s one call to each of
   `findBestCompendiumMatch`/`getCompendiumDocumentFull` — on
   `compendium-search.ts`, which now exists, so those two calls should be
   re-pointed at `this.compendiumSearch.…` and the private
   `findBestCompendiumMatch` facade wrapper deleted in the same diff (see the
   deferrals table). Plus `addActorsToScene` from `scene-token-manager.ts`. Its own
   cycle candidate — `createActorFromCompendium`/`…Entry` → `addActorsToScene` →
   `calculateTokenPosition` — **must be computed as a strongly-connected
   component, not assumed**: on current evidence it is a tree, not a cycle, but
   that is exactly the claim cluster 1's record got wrong.
   `getSystemSchema` (109 lines, zero graph edges in or out, pure static data) sits
   physically between `createWorldItems` and `getCompendiumDocumentFull` and was
   **not** part of cluster 1 — a contiguous cut through that region would have
   adopted it silently.

**~~4. Actor mechanics builders~~ — done.** Moved to `actor-mechanics.ts` by
`extract-actor-mechanics-builders`; see the Layout table. The **~2,500 lines**
recorded here was an overstatement carried from the original estimate (it looks
derived by halving the remaining ~5,000 between clusters 3 and 4). Measured:
**1,608 body lines** across the nine, matching stage-2's ~1,608; the file that
now holds them, with its header and the module-level helpers, is ~1,890.
Cluster 3 is genuinely ~2,100.

## Deliberately left on the facade (recorded deferrals)

These members look like they belong to an existing collaborator but are
**intentionally** still on `FoundryDataAccess`. Under the spec's facade and DAG
requirements a recorded deferral is permitted; an unrecorded one is a violation.
Anything added to this section needs a member, a destination, and a reason.

| Member                                             | Apparent home                                                | Why it stays, for now                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `addActorsToScene`                                 | `scene-token-manager.ts`                                     | Reached from the actor-creation flow (`createActorFromCompendium`/`…Entry`), not from any scene/token path, and it uses the facade's own `this.permissions` field and the module-level `ERROR_MESSAGES` import directly rather than `this.sceneTokenManager`. Moving it to `scene-token-manager.ts` first would create a cross-module dependency that the actor-CRUD extraction would immediately have to undo. Goes with **actor CRUD** (cluster 3).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `calculateTokenPosition`                           | `scene-token-manager.ts`                                     | Private sibling called only by `addActorsToScene`; moves with it, for the same reason.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `readActorFlags`, `extractTokenArt`                | `actor-directory.ts` (adjacent to `findActorsByFlag`)        | Added by `03a6836` and physically placed next to the `actor-directory` wrappers, but their only caller today is `getCharacterInfo`. They go with **character reading** (cluster 2) unless a later change gives `ActorDirectory` a direct caller — re-check at extraction time. `readActorFlags` carries a cross-referencing load-bearing comment; see the inventory below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `importActors`                                     | an actor-CRUD module (cluster 3)                             | **Permanent** deferral, recorded by `extract-actor-mechanics-builders` — not "optional, last, or never" any more. Two reasons, neither of them "it is small". (1) **Its placement causes none of the coupling this refactor exists to remove:** it has exactly one cross-call, `getOrCreateFolder`, already a thin `actor-resolver` wrapper — one hop from a leaf. Moving it would shorten no dependency path and break no cycle, so it is a large method living in a large file, not a God-class symptom. (2) **Its risk is asymmetric in a way no other method's is:** it carries five load-bearing comments, four of them write-ordering contracts, and its failure mode is _silent duplicate actors under a slow or timed-out request_ — which is why it has comments instead of tests for those paths, and why its 28 green cases are not evidence about that path (they cover dry-run, reconciliation, folder placement and per-actor error capture: the scenarios someone thought to write). It has been verified against a live production world. If it is ever moved: solo change, nothing bundled, all 28 cases green unchanged, then a dry-run smoke test against a scratch world — never production. Nothing in the remaining clusters requires it. |
| `findBestCompendiumMatch` (the **facade wrapper**) | `compendium-search.ts` — where the implementation already is | **Temporary, with an explicit expiry condition.** The method itself moved with cluster 1; what stays on the facade is a one-line `private` wrapper delegating to `this.compendiumSearch.findBestCompendiumMatch(…)`. It exists solely so `createActorFromCompendium` — actor CRUD, cluster 3 — keeps compiling, and nothing outside the class reaches it. **Expiry: when cluster 3 lands.** That pass re-points its one caller at `this.compendiumSearch.…`, after which the wrapper has no caller inside the class and is deletable under the compatibility-boundary requirement's second scenario. Delete it then. Do **not** conflate it with `getCompendiumDocumentFull`'s delegation, which looks identical in the diff and is **permanent**: `queries.ts` reaches that one, so R1 requires it forever, independently of cluster 3. Conflating the two gets the wrong one deleted. The moved implementation also had to lose its `private` modifier so the wrapper can call it — the one difference in `extract-compendium-search`'s body diff that was not an enumerated re-pointing.                                                                                                                                                                     |
| `createNpcActor`                                   | stays put until cluster 3 runs                               | Not a new deferral, but worth naming here because it is the one members list that has been misfiled twice: it is **actor CRUD**, it sits physically _between_ `addSaveFeatureToActor` and `addAttackToActor`, and it was the sole caller of `getOrCreateFolder` in that span. `extract-actor-mechanics-builders` moved the nine builders around it as two non-contiguous ranges and left it, its `NPC_*` module-level helpers, and its soft-validation comment behind. A contiguous block excision of the cluster's old line span would have taken it along silently.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

## Load-bearing comments (grep for `Do NOT`/`never`/`NEVER`/`WRITES`/`deliberately`/`RECONCIL`/`CRITICAL`)

**Still 13 after `extract-compendium-search`, which moved none of them: the
compendium/creature-search cluster carries no load-bearing comment at all.** The
marker phrases appear nowhere in its 864 moved body lines — as expected, since a
cluster that only reads and returns has no write-ordering or idempotency contract
to record. The `data-access.ts` line numbers below were re-measured after that
pass; they are still indicative only.

**Recounted: 13, and they are no longer all in `data-access.ts` — nor even in
two files.** The earlier claim ("all 10, all inside `importActors`") was true at
`902f3f0` and is now wrong in both respects — `03a6836` added three and put one
of them in an already-extracted collaborator, and
`extract-actor-mechanics-builders` moved three more into `actor-mechanics.ts`.
Line numbers are indicative only.

### In `data-access.ts`

| Location                                                                                                             | Guards                                                                                           | Destination cluster                                |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| `~232` — "Read WITHOUT `getFlag()`"                                                                                  | `getCharacterInfo`'s flags option (param JSDoc)                                                  | Character reading                                  |
| `~1292` — "including why the flag must NOT be read with `actor.getFlag()`"                                           | the `findActorsByFlag` facade wrapper's own JSDoc, pointing at `ActorDirectory.findActorsByFlag` | **Stays on the facade** — it documents the wrapper |
| `~1318` — "NEVER `actor.getFlag(scope, key)`, which throws for any scope that is not …"                              | `readActorFlags`                                                                                 | Character reading                                  |
| `~3354` — "Soft validation — collect warnings, do NOT block creation"                                                | `createNpcActor`                                                                                 | **Actor CRUD**, not mechanics builders             |
| `~3759` — "getOrCreateFolder writes, so dry runs only _look up_ folders"                                             | `importActors` dryRun contract                                                                   | Actor CRUD tail (**permanent deferral**)           |
| `~3810` — "Read the flag via RAW property access, never `actor.getFlag('wodchar', …)`: getFlag throws …"             | `importActors`' `findBySourceId`                                                                 | Actor CRUD tail (**permanent deferral**)           |
| `~3869` — "RECONCILABILITY — this ordering is load-bearing … Do NOT refactor this into a post-create setFlag/update" | the sourceId stamp-before-`Actor.create` ordering                                                | Actor CRUD tail (**permanent deferral**)           |
| `~3895` — "A skip writes nothing, so settle it BEFORE resolving any folder"                                          | `importActors` no-op path ordering                                                               | Actor CRUD tail (**permanent deferral**)           |
| `~3918` — "so an update that keeps its folder never reaches getOrCreateFolder"                                       | `importActors` folder-placement ordering                                                         | Actor CRUD tail (**permanent deferral**)           |

### In `actor-mechanics.ts` (moved verbatim by `extract-actor-mechanics-builders`)

| Location                                                    | Guards                     | Notes                                                                                                                                                                                                           |
| ----------------------------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~462` — "Soft validation — collect warnings, never block"  | `addAttackToActor`         | Home reached. No cross-file reference, so the move was verbatim with nothing to re-point.                                                                                                                       |
| `~697` — "Soft validation — collect warnings, never block"  | `addAuraToActor`           | Same.                                                                                                                                                                                                           |
| `~969` — "Soft validation — **both damage groups unified**" | `addAttackWithSaveToActor` | Same — and the one a `never block` grep misses; see the locator warning below. It sits inside the longest body in the cluster (277 lines), which is exactly where a dropped line is least likely to be noticed. |

**Locate these by the `// 3. Soft validation` marker prefix, not by grepping
`never block`.** That grep finds two of the four:
`addAttackWithSaveToActor`'s reads "both damage groups unified" and
`createNpcActor`'s reads "do NOT block creation". The heading of this section
lists `never` among its grep terms and is therefore itself an incomplete locator
for this family.

Earlier counts said "three soft-validation comments in the actor-mechanics
builders". There are **four**, and one of the four (`createNpcActor`) is in
actor CRUD, not the builders — so three moved to `actor-mechanics.ts` and one
stayed. Corrected above.

What these three record is a decision the code's shape does not reveal: the
builders **deliberately** collect warnings and complete the write rather than
rejecting the request. A reader seeing an apparently unused `warnings` array
would reasonably "fix" it into a throw.

### Outside `data-access.ts` — the ones the earlier count missed

| Location                                                                                                                                                                                 | Guards                                   | Hazard                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `actor-directory.ts:157-166` — "CRITICAL — the flag is read by RAW property access, never `actor.getFlag(scope, key)` … Same rule as the import path (`data-access.ts` `importActors`)." | `ActorDirectory.findActorsByFlag`        | **The one genuine documentation hazard in the package.** It names `data-access.ts` explicitly. When `importActors` moves, this cross-reference goes stale — the prose still reads correctly but no longer names a real file. Update it **in the same diff** that moves `importActors`. The same applies in reverse to the `~2457` `readActorFlags` comment, which cross-references `importActors` by name. |
| `queries.ts:416-423` — "Append-only; never remove an entry … the server pre-flights this list and refuses a dry run unless the capability is advertised."                                | the ping/pong `capabilities` string list | This is the cross-package version handshake the spec's mirroring requirement leans on. It has **no type declaration on either side**; the contract is the comment.                                                                                                                                                                                                                                         |

When actor CRUD is extracted, every comment marked "Actor CRUD" above must move
to the new file **unedited**, except the two cross-references named in the
hazard table, which must be re-pointed at their new files in the same diff.

## Pre-existing oddities noticed while moving code (left alone, not bugs)

Nothing rose to the level of a behavioural bug in the ~2,900 lines examined
closely enough to move by hand. Two pre-existing code smells, both moved
verbatim and already covered by the 50-error eslint baseline:

- `attachRollButtonHandlers`'s click handler reads
  `button.data('button-id')` into `buttonId` twice: once in the handler's
  outer scope (used by the guard clauses and by the `finally` block, which
  is a sibling of the `try`, not nested in it) and again, redundantly, inside
  the `try` block, shadowing the outer one for that block only. Both reads
  return the same DOM attribute value, so this is dead re-computation, not
  a correctness issue — `finally`'s reference resolves to the outer,
  already-guarded `buttonId` either way.
- Several `if (character) { }` / `if (owner) { }` empty blocks in
  `resolveTargetPlayer` and elsewhere (flagged by eslint's `no-empty`,
  part of the baseline) — vestigial from removed debug logging, no
  behavioural effect.
- `PersistentCreatureIndex`'s `Hooks.on('createDocument'/'updateDocument'/…)`
  handlers call `this.invalidateIndex()` (an `async` method) without
  awaiting it (eslint `no-floating-promises`, part of the baseline).
  Foundry's `Hooks` API invokes listeners synchronously and does not await
  them, so this is the only shape available here, not an oversight.

## Verifying this file is current

There is no automated drift guard for this note (unlike `webgen`'s generated
trees), and the spec makes keeping it current a requirement rather than a
courtesy — so verify by hand, in the same change as the extraction:

```bash
cd /Users/ludo/code/mago20/foundry-vtt-mcp
wc -l packages/foundry-module/src/*.ts | sort -rn      # the Layout table's sizes
grep -rn 'dataAccess[?]\?\.' packages/foundry-module/src --include='*.ts' \
  | awk -F: '{print $1}' | sort | uniq -c              # the external reach sites
grep -nE 'Do NOT|do NOT|NEVER|never |WRITES|writes,|deliberately|RECONCIL|CRITICAL' \
  packages/foundry-module/src/*.ts | grep -v '\.test\.ts'   # load-bearing comments
npx vitest run --reporter=dot                          # the test count
```

If a figure here disagrees with the source, the map is the defect — correct the
map. A stale map is never licence to ignore the requirements it records.
