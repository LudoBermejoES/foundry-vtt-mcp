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
> "Not yet extracted" section below. **All four of its stages have now run**;
> that document is a completed plan, kept for its corrections and its record of
> what each stage got wrong.

> **The decomposition is complete.** As of `extract-character-reading` (pass 5.2)
> **no cluster remains outstanding**, and every member of `FoundryDataAccess` is a
> thin delegation, a wrapper whose lifetime is recorded on the member, a residual
> recorded below with a decided destination, or dead surface recorded with the tool
> that measured it. See "What remains on the facade, and why" below for the
> enumeration the completion requirement demands. A large member found on the
> facade is not evidence that the refactor stopped — check that section first; the
> absence of a record there is a defect in this map, not an unfinished cluster.

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

| File                     | Lines (approx.) | Extracted from `FoundryDataAccess`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Depends on                                                         |
| ------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `creature-index.ts`      | ~1,450          | The **other** class in the original file, `PersistentCreatureIndex` (26 methods) — file-based creature index cache for D&D5e/PF2e/Cosmere/MGT2e. Already fully self-contained (used only via one field, `this.persistentIndex`); moved verbatim.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | —                                                                  |
| `security.ts`            | ~220            | `validateFoundryState`, `auditLog`, `sanitizeData`, `removeSensitiveFields`, `isSensitiveOrProblematicField`, `safeJSONStringify` — the output-sanitization/write-audit helpers called from nearly every concern.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | —                                                                  |
| `actor-resolver.ts`      | ~90             | `findActorByIdentifier`, `getOrCreateFolder` — actor/folder lookup used across item CRUD, feature/attack builders, WFRP4e updates, journal/actor creation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | —                                                                  |
| `permissions.ts`         | ~255            | Not extracted from `FoundryDataAccess` — a pre-existing cross-cutting module. `PermissionManager`: `checkWritePermission` (10 call sites), `auditPermissionCheck` (3, body currently a no-op), plus three methods called from nowhere. Listed here because the facade now **constructs and injects** it, so it is a third leaf; it no longer exports a module-level `permissionManager` instance.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | —                                                                  |
| `transaction-manager.ts` | ~275            | Not extracted from `FoundryDataAccess` either — a pre-existing cross-cutting module, listed here from `extract-actor-crud` onward because the facade now **constructs and injects** it, making it a **fourth leaf**. `TransactionManager`: `startTransaction`, `addAction`, `commitTransaction`, `rollbackTransaction`, `createTokenCreationAction` and the rollback machinery. Its `export const transactionManager = new TransactionManager()` was **deleted** by that pass: `data-access.ts` was the only source importer, all eight uses were actor CRUD's, and a collaborator reaching a shared service by singleton import is what the acyclic-DAG requirement forbids. Instance identity is load-bearing here rather than hygienic — unlike the other leaves this class is **stateful** (`activeTransactions`, `transactionHistory`), so two instances genuinely diverge. **Now reached by nothing that can be triggered** — see the follow-ups section.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | —                                                                  |
| `journal-manager.ts`     | ~285            | `createJournalEntry`, `listJournals`, `getJournalContent`, `getJournalPageContent`, `updateJournalContent`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `security`, `actor-resolver`, `permissions`                        |
| `world-items-manager.ts` | ~270            | `listWorldItems`, `updateWorldItems`, `createWorldItems`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `security`                                                         |
| `actor-directory.ts`     | ~255            | `listActors`, `getFriendlyNPCs`, `getPartyCharacters`, `getConnectedPlayers`, `findPlayers`, `findActor`, **`findActorsByFlag`** (added by the `03a6836` read-path change, which is why this file grew from the 164 lines first recorded here). **Carries a load-bearing comment** — see the inventory below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `security`, `actor-resolver`                                       |
| `roll-manager.ts`        | ~920            | Interactive roll-request chat cards: `validateWritePermissions`, `requestPlayerRolls`, `resolveTargetPlayer`, `buildRollFormula`, `getSkillCode`, `buildRollButtonLabel`, `attachRollButtonHandlers`, `saveRollState`, `getRollState`, `saveRollButtonMessageId`, `getRollButtonMessageId`, `getRollStateFromMessage`, `updateRollButtonMessage`, `requestRollStateSave`, `broadcastRollState`, `cleanOldRollStates`, `rollDice`, plus the `rollButtonProcessingStates` in-flight-click map.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `security`, `permissions`                                          |
| `scene-token-manager.ts` | ~700            | `getActiveScene`, `getTokenDisposition`, `listScenes`, `switchScene`, `getCharacterEntity`, `moveToken`, `updateToken`, `deleteTokens`, `getTokenDetails`, `toggleTokenCondition`, `getAvailableConditions`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `security`, `permissions`                                          |
| `compendium-search.ts`   | ~1,110          | The compendium/creature-search cluster, extracted by `extract-compendium-search`: `searchCompendium`, `shouldApplyFilters`, `calculateRelevanceScore`, `matchesSearchCriteria`, `listCreaturesByCriteria`, `passesEnhancedCriteria`, the four `passes*Criteria` system branches (`MGT2e`, `CosmereRpg`, `DnD5e`, `PF2e`), `fallbackBasicCreatureSearch`, `findBestCompendiumMatch`, `getCompendiumDocumentFull`, `getAvailablePacks`, `getEnhancedCreatureIndex`, `rebuildEnhancedCreatureIndex` — **16 members, 864 body lines** — plus the nine type declarations only they use (`CompendiumSearchResult`, the five-member creature-index family, `CompendiumEntryFull`/`CompendiumItem`/`CompendiumEffect`). Nothing here writes, so there is **no audit call anywhere in the module**. `persistentIndex` is **constructor-injected**, not constructed: a second instance would type-check and split the rebuild writer from every reader. Pinned by `compendium-search.test.ts` (81 cases). Carries **no** load-bearing comment.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `security`, `creature-index`                                       |
| `actor-mechanics.ts`     | ~1,890          | The nine actor-mechanics builders: `useItem`, `addSaveFeatureToActor`, `addAttackToActor`, `addAuraToActor`, `addPassiveFeatureToActor`, `addAttackWithSaveToActor`, `setActorSpellcasting`, `addSpellsToActor`, `addFeaturesFromCompendium`, plus the module-level dnd5e helpers only they use (`slugify`, the attack/aura/attack+save canonical damage-type sets, the four spellcasting slot tables). **`createNpcActor` is NOT one of them** — it is actor CRUD, and it sits physically between two of the nine, so a contiguous excision takes it along. **Carries three load-bearing comments** — see the inventory below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `security`, `actor-resolver`                                       |
| `actor-crud.ts`          | ~1,800          | The actor-CRUD cluster, extracted by `extract-actor-crud`: `createActorFromCompendiumEntry`, `addActorItems`, `removeActorItems`, `addActorsToScene`, `calculateTokenPosition`, `setActorOwnership`, `updateWfrp4eActor`, `addWfrp4eItems`, `getActorOwnership`, `createNpcActor`, `createActors`, `normalizeMGT2eSkillKeys`, `updateActors`, `updateActorItems`, `deleteActorItems`, `deleteActors` — **16 members, 1,511 body lines** — plus the eleven module-level declarations only they use (`ActorCreationResult`, `CreatedActorInfo`, `SceneTokenPlacement`, `TokenPlacementResult`, the four `NPC_*` tables and the three `npc*` helpers). `calculateTokenPosition` and `normalizeMGT2eSkillKeys` stay **private** — reached only from inside the cluster. **`importActors` and `getSystemSchema` are NOT here** (see the deferrals table and the residuals note). `TransactionManager` is **constructor-injected**, never imported. Carries **one** load-bearing comment (`createNpcActor`'s soft-validation marker). Pinned by `actor-crud.test.ts` (155 cases). Imports **nothing** from `compendium-search.ts`: the cluster's only two calls into it lived inside `createActorFromCompendium`, which was dead surface and was deleted rather than moved.                                                                                                                                                                                                                                                                                                                             | `security`, `actor-resolver`, `permissions`, `transaction-manager` |
| `character-reader.ts`    | ~1,200          | The character-reading cluster, extracted by `extract-character-reading`: `getCharacterInfo`, `searchCharacterItems`, `extractSpellcastingData`, `formatPF2eActionCost`, `extractPF2eSpellSlots`, `extractDnD5eSpellSlots`, `extractDnD5eSpellTargeting`, `extractPF2eSpellTargeting`, `extractDSA5SpellTargeting`, **`readActorFlags`** and **`extractTokenArt`** — **11 members, 995 body lines**, all of which moved: the only cluster of the four with no dead member, no misfiled neighbour and no internal deferral. Plus the five module-level declarations only they use (`CharacterInfo`, `SpellcastingEntry`, `SpellInfo`, `CharacterItem`, `CharacterEffect`), of which `CharacterItem` and `CharacterEffect` are **transitive-only** — referenced by no method body, only from inside `CharacterInfo`'s declaration — and are therefore left unexported and **not** imported back. Nine of the eleven are `private`; only `getCharacterInfo` and `searchCharacterItems` are reached from outside, both from `queries.ts`. `readActorFlags`/`extractTokenArt` are here and **not** in `actor-directory.ts` — see the resolved deferral row. **Carries six load-bearing comments**, one of them inside an interface declaration. Pinned by `character-reader.test.ts` (142 cases, proven against 112 mutations). No field read crosses the boundary, so unlike `ActorCrud` and `CompendiumSearch` there is **no `moduleId`** here. `searchCharacterItems` is the package's only read path that calls `auditLog`; that is pre-move behaviour, moved verbatim, not to be "fixed" in place. | `security`, `actor-resolver`                                       |
| `data-access.ts`         | ~1,520          | The facade: unchanged externally-reached surface, thin delegations to the above, plus the recorded residuals, wrappers and dead surface enumerated below. Was 7,099 at `902f3f0`; the `03a6836` read-path change added the `include`-option plumbing and the flag/token-art helpers, `extract-actor-mechanics-builders` took ~1,740 lines back out, `extract-compendium-search` took a further ~1,210 (994 for the move, 242 for the four dead methods deleted ahead of it), `extract-actor-crud` took ~1,650 (223 for the dead `createActorFromCompendium` surface and its cascade, deleted ahead of the move, then the 16 members and their eleven module-level declarations out and 14 delegations plus the wrapper-lifetime notes in), and `extract-character-reading` took ~1,100 (the 11 members and their five declarations out, two delegations plus one type import in, and the three expired `private` wrappers deleted). **Nothing is awaiting extraction.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | all of the above                                                   |

`FoundryDataAccess`'s own fields, in construction order (matters — later
fields' initializers reference earlier ones):

```ts
private moduleId, persistentIndex, security, actorResolver, permissions,
        journals, worldItems, actorDirectory, rollManager, sceneTokenManager,
        actorMechanics, compendiumSearch, transactions, actorCrud, characterReader;
```

`permissions` sits with the other leaves, **before** `journals`/`rollManager`/
`sceneTokenManager`, which receive it as a constructor argument.
`actorMechanics` takes `(security, actorResolver)`. `compendiumSearch` takes
`(security, persistentIndex)` — note the second argument: it is the
facade's **existing** `persistentIndex`, and passing a fresh
`new PersistentCreatureIndex()` there compiles, breaks no other test, and
silently splits the index's writer (`rebuildEnhancedCreatureIndex`, driven from
`main.ts`/`settings.ts`) from every reader. The test that catches it is
`compendium-search.test.ts`'s "constructing FoundryDataAccess creates EXACTLY ONE
PersistentCreatureIndex", which asserts the exact list of Foundry hooks the index
constructor registers. The rebuild-then-read round trip does **not** catch it:
`PersistentCreatureIndex` holds no in-memory index, so two instances share state
through the file and the round trip passes either way.

`transactions` and `actorCrud` are last, added by `extract-actor-crud`.
`transactions` is `new TransactionManager()` — the facade owns the single instance
purely so it can inject it; the name `transactionManager` now belongs to the
collaborator's field, which is what keeps the two moved reads textually unchanged.
`actorCrud` takes `(security, actorResolver, permissions, transactions)`. No existing
field was reordered and `new FoundryDataAccess()` is still argument-free.

`characterReader` is last, added by `extract-character-reading`, and takes
`(security, actorResolver)` — the same two-parameter shape as `actorMechanics`.
The field names inside `CharacterReader` are `security` and `actorResolver`
**deliberately**, not by accident of style: `ActorDirectory` names its resolver field
`resolver`, and matching that convention instead would have silently changed the text
of the `findActorByIdentifier` re-pointing, which the per-member body diff is there to
hold byte-identical. Fifteen fields now; still argument-free.

## The externally-reached surface (the compatibility boundary)

The frozen surface is defined by **who reaches it**, not by the
`public`/`private` modifier — the spec's compatibility-boundary requirement
turns on exactly this. Measured against the current source, the class declares
**101 members** (73 non-private methods + 13 private methods + 14 private
collaborator/config fields + the constructor — the 10th field is `permissions`,
added by `inject-permission-manager`, the 11th `actorMechanics`, added by
`extract-actor-mechanics-builders`, the 12th `compendiumSearch`, added by
`extract-compendium-search`, the 13th and 14th `transactions`/`actorCrud`, added by
`extract-actor-crud`), of which **66 are actually reached from outside** —
65 class members plus `ensureButtonStatesForMessage`, which `main.ts` probes on
the facade object and which **is not a member of the class at all**.

The non-private count fell by exactly one across the extractions, and only because
`extract-actor-crud` deleted one **dead surface** member (`createActorFromCompendium`,
which no reach site accessed): every externally-reached member keeps a thin
delegation, which is the point. The private count fell from 30 to 17 with
`extract-compendium-search` (nine private helpers moved out, four private dead
methods deleted) and to 13 with `extract-actor-crud` (`createActorFromSource` and
the `findBestCompendiumMatch` wrapper deleted, `calculateTokenPosition` and
`normalizeMGT2eSkillKeys` moved out and stayed private on `ActorCrud`). The nine mechanics builders and the six
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

That extractor is now **committed**, at `scripts/refactor/reached-surface.mjs` —
do not write a fourth one. It runs all three passes, refuses to diff two captures
taken by different tool identities, and reports the **65 class members** and the
**66 reached names** on separate lines (the 66th being the
`ensureButtonStatesForMessage` probe above), which is what stops the two figures
in this document reading as a tool artefact. `scripts/refactor/README.md` has the
invocation; `npm run test:refactor-tools` replays both `extract-compendium-search`
and `extract-actor-crud` and confirms the surface diff was empty across each.

There are **eight** external reach sites, and `queries.ts` is not the only one.
(This said "exactly five" until `extract-actor-mechanics-builders`; `14d392c`
added a third test file and did not update the count, `c1f12d5` a fourth, and
`3cbe106` a fifth (`actor-crud.test.ts`). Recount, do not trust a figure here that a
later commit could have invalidated. Note that the union count of reached members did
**not** move when the fifth test file arrived: 66 before and after. A new test file
adds a reach site without necessarily adding surface.)

| Reach site                  | Accesses | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `queries.ts`                | ~116     | The bridge. 75 `CONFIG.queries[…]` registrations, each a `handleX` that calls `this.dataAccess.X(…)`.                                                                                                                                                                                                                                                                                                                                                                                                     |
| `main.ts`                   | 7        | `queryHandlers.dataAccess.attachRollButtonHandlers` (`:638`, `:646`), `.rebuildEnhancedCreatureIndex` (`:137`–`:138`), `.saveRollState` (`:557`).                                                                                                                                                                                                                                                                                                                                                         |
| `settings.ts`               | 2        | `bridge?.dataAccess?.rebuildEnhancedCreatureIndex` (`:47`).                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `import-actors.test.ts`     | —        | 28 cases, all targeting `importActors`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `actor-read-path.test.ts`   | —        | 17 cases, targeting `getCharacterInfo`'s flags/art fields and `findActorsByFlag`.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `actor-mechanics.test.ts`   | —        | 41 characterization cases, targeting all nine mechanics builders plus `createNpcActor`. Added by `14d392c` as the precondition for extracting them; they pin the **document handed to Foundry**, not the return envelope.                                                                                                                                                                                                                                                                                 |
| `actor-crud.test.ts`        | —        | 155 characterization cases, targeting the fourteen externally-reached actor-CRUD members (`calculateTokenPosition` and `normalizeMGT2eSkillKeys` are private and are exercised **through** `addActorsToScene` and `createActors`). Added by `3cbe106` as the precondition for extracting them; they pin the **document handed to Foundry** plus the audit call, not the return envelope. Proven against **98 mutations, 98 caught**.                                                                      |
| `compendium-search.test.ts` | —        | 81 characterization cases, targeting the six externally-reached search members (the other ten are private and are exercised **through** `searchCompendium`/`listCreaturesByCriteria`). Added by `c1f12d5` as the precondition for extracting them; they pin the **returned result set** — contents, ordering, ranking, truncation at the limit, and the filter decision that determines membership, one case per system branch. Includes the wiring gate that catches a second `PersistentCreatureIndex`. |

**Consequence for extraction passes:** three members (`attachRollButtonHandlers`,
`rebuildEnhancedCreatureIndex`, `saveRollState`) are reached **only** from
`main.ts`/`settings.ts` and by no query handler and no test. Judging the boundary
from `queries.ts` alone would classify them as internal and therefore freely
deletable, which would silently break the roll-button chat hook and the
creature-index rebuild setting. Always include `main.ts` and `settings.ts`.

**Recounted by `extract-actor-crud`: 8 non-private members are reached from nowhere
at all** — it was 9 before that pass, and 9 is what `extract-compendium-search`
measured (against the 13 recorded when this section was written). The one that went
is `createActorFromCompendium`, which `extract-actor-crud` **deleted**: the bridge
query of that name is handled by `handleCreateActorFromCompendium`, which calls
`createActorFromCompendiumEntry` instead. The remaining eight are
`getCharacterEntity` plus seven roll-state members reached only from inside
`roll-manager.ts` — `getRollState`, `saveRollButtonMessageId`,
`getRollButtonMessageId`, `getRollStateFromMessage`, `requestRollStateSave`,
`broadcastRollState`, `cleanOldRollStates`. `updateRollButtonMessage` is **not** one
of them: `main.ts:529` reaches it, which is exactly the trap this section warns about.

**Report the tool with the number.** Five successive counts have said 13, 7, 9, 8 and
9, and the disagreements are tool artefacts, not code changes: the 7 came from a list
that omitted `createActorFromCompendium` and `requestRollStateSave`; 9 and 8 are the
same measurement either side of one deletion. The 8 above was produced by: a
`ts.createSourceFile` + `ClassDeclaration.members` visitor over `data-access.ts`
keeping the `public` methods, minus the **union** externally-reached extractor
(type checker ∪ receiver-text match, over all eight reach sites), requiring in addition
**zero intra-class referrers** (calls and bare property reads). A count without its
extractor is not a recount.

None of the eight is in the compendium/creature-search or actor-CRUD clusters, and
neither pass touched them. They remain dead-surface candidates, **not** cleaned up in
passing: seven are roll-state members and want one boundary change of their own.
Deleting a non-private member is a boundary change under the spec.

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

   **Current coverage, recounted:** 5 test files, **322 cases** —
   `import-actors.test.ts` (28), `actor-read-path.test.ts` (17, added by
   `03a6836`), `actor-mechanics.test.ts` (41, added by `14d392c`),
   `compendium-search.test.ts` (81, added by `c1f12d5`) and
   `actor-crud.test.ts` (155, added by `3cbe106`).
   Workspace-wide `npm run test --workspaces` is 604 (282 `mcp-server` + 322
   `foundry-module`). The "28" first recorded here was correct for the single
   test file that existed then; it is now the count of one of five files, not
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

   **`extract-actor-crud` is the third, and it is the first with a reflow the
   measurement predicted.** 34 re-pointings of **five** shapes across 1,511 moved body
   lines, 16 members and 11 module-level declarations, landed as five commits. Four
   things from it are worth reusing.
   - **A third shape of permitted difference: a bare module-level identifier becoming
     an injected field read.** `transactionManager.addAction(…)` →
     `this.transactionManager.addAction(…)`, twice. After `this.helper()` calls (the
     mechanics pass) and bare field reads (the search pass), each of three consecutive
     passes has met a new shape. The response is to keep **enumerating** them, not to
     broaden the permitted-difference clause to "consequences of relocation" — that
     phrase is elastic and the requirement's teeth are precisely that an unenumerated
     difference is a defect by default.
   - **Measure the column width of every site before substituting, then check which
     lines actually crossed.** Two of the 34 did: 90 → 104 in
     `createActorFromCompendiumEntry` and 93 → 102 in `addWfrp4eItems`, both reflowed
     by prettier, both disclosed per occurrence. The third-longest landed at **exactly
     100** and prettier left it alone. That is the whole method: neither assert a
     reflow will happen (the search pass did and got none) nor assume none will.
   - **Verify token-identity with the PARSER, not a raw scanner.** `ts.createScanner`
     does not re-scan template-literal continuations and swallows the rest of a member
     into one bogus token, which reads as a token difference on a body that is merely
     reflowed. Use the parse tree's leaves — and emit **comments** into the stream in
     place, or a dropped comment passes as a reflow, which is exactly the failure the
     load-bearing-comment scenario of the body-diff requirement exists to catch.
   - **A per-stage substitution count is worth asserting even when the global total is
     right.** The task list's per-stage counts were wrong for three of the four stages
     (12 vs 8 `auditLog` in stage B, 2 vs 1 `validateFoundryState` in stage C, 1 vs 2
     in stage D) while the global 9/15/5/3/2 was exactly right. Counted substitution
     that aborts on a wrong count turned each into a caught discrepancy.

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

## The four clusters (all extracted)

**All four are done.** This section is kept as the record of what each pass
corrected, not as a plan. `data-access.ts` is down to ~1,520 lines from 10,554 and
**no cluster remains outstanding** — see "What remains on the facade, and why".
(Cluster 4, the actor-mechanics builders, landed first —
`extract-actor-mechanics-builders` — because it is the only one of the four with zero
`this.x()` edges to another unextracted cluster. Cluster 1 followed as
`extract-compendium-search`, on the stated grounds that **A must precede C**:
`createActorFromCompendium` calls two of its members. Cluster 3 landed third as
`extract-actor-crud`, and **corrected that premise**: `createActorFromCompendium` was
**dead surface**, so the C→A edge existed only inside a method nothing could reach.
The ordering constraint was a correct conclusion resting entirely on dead code — the
order was still the right one, but not for the recorded reason.)

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

**~~2. Character reading~~ — done.** Moved to `character-reader.ts` by
`extract-character-reading`; see the Layout table. The **~700 lines** recorded here was
an understatement, the member list was short by two, and the record's coverage claim was
not merely wrong but inverted. Corrected by the AST re-derivation that pass performed:

- **11 members, 995 body lines** (1,083 with JSDoc and leading trivia), **all of which
  moved**. `refactor-data-access-stage2.md:52` gave the cluster as "9 / ~969" and listed
  `readActorFlags`/`extractTokenArt` separately as a "fifth, tiny cluster (43 lines)".
  Measured: the nine are **970** body lines, the pair are **25**, and the "43" counted
  `findActorsByFlag`'s 18-line **facade delegation** in with them — which is not this
  cluster's, does not move, and keeps the JSDoc that documents it.
- **"Best test coverage in the file besides `importActors`" was false, and it inverts.**
  `actor-read-path.test.ts` has 17 cases, of which **eight exercise
  `ActorDirectory.findActorsByFlag`** and touch no cluster-B code at all; the nine that
  reach `getCharacterInfo` are, without exception, about the opt-in extras. So the
  coverage the record was thinking of was coverage of `readActorFlags` and
  `extractTokenArt` — 25 of 995 lines, and by coincidence exactly the two members whose
  home was the open question. **Eight of eleven members had zero coverage: 805 body
  lines, 81% of the cluster**, including both four-way `systemId` dispatches and all
  three limit-truncation sites. That is why the characterization change
  (`8d14064`, 142 cases, proven against 112 mutations, all 112 caught) was a
  **precondition** and needed pf2e-, dnd5e- and dsa5-shaped actor factories the shared
  fixture did not have.
- **The internal call graph is a single weakly-connected component spanning all eleven
  members** — 13 caller→callee edges over 24 call sites. No earlier cluster was like
  this: 5.3's internal edges were two isolated pairs, each wholly inside one stage, so
  no stage boundary ever cut an edge and no bridge was ever needed. Here every
  non-trivial split cuts one, the direction is forced (a callee may move ahead of its
  caller behind a bridge; a caller may never move ahead of its callee), and the pass
  needed **five** temporary bridges. `design.md`'s "18 intra-cluster calls, 14 call
  sites" is wrong in both figures: **13 edges, 24 sites**, and the 14 is
  `extractSpellcastingData`'s own site count — correct for stage B, misapplied to the
  cluster.
- **8 re-pointings in 3 shapes** — 5 × `sanitizeData`, 1 × `validateFoundryState`,
  1 × `auditLog`, 1 × `findActorByIdentifier`, every one a `this.helper()` call. The
  smallest and most homogeneous set of the four passes (5.1: 26 across 5 shapes; 5.3:
  34 across 5). **No field read crosses the boundary at all.**
- **Two formatter reflows, both inside `extractTokenArt`**, both predicted by
  measurement and confirmed to the column: `94 → 103` and `92 → 101`. The second is
  **one column** over the 100-column print width and does reflow, which is the mirror
  of 5.3's site that landed at exactly 100 and did not. Evaluate the threshold per
  line; never as a rule of thumb.
- **Stage A could not carry the wiring, contrary to the pass's own design.** The design
  had the module, the class, the constructor and the facade field landing in a
  zero-body first commit, and claimed that commit type-checks. It does not: under
  `noUnusedLocals` an empty `CharacterReader`'s two constructor parameter properties are
  TS6138 and the facade's unreferenced `characterReader` field is TS6133. Neither
  dependency is read by any moved body until `searchCharacterItems` (stage C), because
  stage B's seven members make **no** cross-boundary call. So stage A carried the type
  closure alone, the field arrived in stage B with the bridges, and the constructor
  parameters in stage C. The final text is identical; only which commit introduces it
  moved. The lesson generalises: **a wiring-only commit is not independently gatable
  under `noUnusedLocals` — only a declarations-only commit is.**

  **~~3. Actor CRUD~~ — done.** Moved to `actor-crud.ts` by `extract-actor-crud`; see
  the Layout table. The **~2,500 lines** recorded here was an overstatement and the
  members list was wrong in four places, each corrected by the AST re-derivation that
  pass performed:

- **20 members, 2,092 body lines** (the total the stage-2 table gave, exactly), of
  which **16 moved (1,511 body lines)**, **two were deleted, not moved (191)** and
  **two stayed (390)**.
- **`createActorFromCompendium` was dead surface**, not a live C→A caller. It is
  `public`, 145 lines, and reached from nothing: no intra-class referrer, no member
  access in any of the eight reach sites, no dynamic dispatch (`this[`, `(this as any)`
  and `dataAccess[` are all zero). The confusable part is that the bridge **query** of
  that name is alive (`queries.ts:53`, called from
  `mcp-server/src/tools/actor-creation.ts:160` and
  `systems/dsa5/character-creator.ts:192`) while its handler calls
  `createActorFromCompendiumEntry`. A grep for the identifier returns four live-looking
  hits and **none** of them is a call — the check has to be a member-access analysis.
  Its removal was an explicit **boundary change**; `createActorFromSource` (dead by
  cascade), the `ActorCreationRequest` declaration and the temporary private
  `findBestCompendiumMatch` wrapper were **internal** deletions. The two
  classifications look identical in a diff, which is why they are recorded per member.
- **`transactionManager` appears in no earlier document, and moving it verbatim would
  have been a spec violation.** All eight uses were in this cluster (six of them inside
  the deleted method, including the only `startTransaction`). See the Layout table row.
- **`getSystemSchema` is not actor CRUD** — see the residuals note below.

**One claim in the record about the `CompendiumSearchResult` import was wrong and is
worth naming**, because it is the shape of mistake that type-checks in reverse: the
plan said its only use was the deleted wrapper's return type, so the import should go.
It had **two** uses — the deleted wrapper's, and the **retained** `searchCompendium`
delegation's, which `queries.ts` reaches. Removing it is TS2552. Count the uses; do
not infer them from what a pass is deleting.

**Residual, not part of any cluster: `getSystemSchema`.** 109 lines, zero call-graph
edges in either direction, `public`, reached from `queries.ts`. It creates nothing,
updates nothing, deletes nothing and touches no actor — it returns a static description
of a game system's data shape. `extract-actor-crud` deliberately left it on the facade
and the ownership requirement it added states the exclusion as a **requirement**,
because "it has no edges, so it can go into whichever file is convenient" has now been
recorded as guidance three times and is not a reason to give a module a concern it does
not own. It also sits physically between `createWorldItems` and
`getCompendiumDocumentFull`, so a contiguous cut through cluster 1's region would have
adopted it silently. **Its home is pass 5.2's decision to argue on the merits**: if
`character-reader.ts` wants it, take it; if not, it wants a home of its own or a
recorded permanent residency. Do not leave it recorded as "can go anywhere" for a
fourth document.

**Resolved by `extract-character-reading`, and a second residual found alongside it.**
`character-reader.ts` does **not** want `getSystemSchema`: it reads no actor, and it
returns an mgt2e enum reference derived from live `CONFIG.MGT2` plus a static table of
valid field keys, which describes _the game system_, not a character. Filing it there
because a stage was passing is precisely the failure the exclusion requirement names.

And it is not alone. **`getWorldInfo`** — 17 body lines, `public`, a real implementation
rather than a delegation, **zero** call-graph edges in either direction, reached only
from `queries.ts`, no state validation ("World info doesn't require special permissions
as it's basic metadata"), and its own two interfaces (`WorldInfo`, `WorldUser`) used by
nothing else — appears in **no cluster in any document in this record**, and no document
had ever noticed. The claim "character reading is the only cluster left" was true of
_clusters_ and hid the fact that two unowned members remained, only one of which was
recorded.

The two are **one concern**, and naming it is what gives `getSystemSchema` a home on the
merits rather than a module of one: **a read-only description of the world and the game
system** — identity, versions, connected users, and the system's enumerated field values
— _as opposed to the contents of the world_. Everything else in the package answers
"what is _in_ this world"; these two answer "what _is_ this world, and what will this
system accept". Their home is **`packages/foundry-module/src/world-metadata.ts`**, a
collaborator with **no constructor dependencies** — not even `security`, since neither
member validates, audits or sanitises anything today and giving it one would be a
behaviour change rather than a relocation.

**The relocation is a separate following change**, and both members remain recorded
residuals until it lands. Bundling a second, unrelated module boundary into a cluster
extraction would put two ownership specifications in one delta; and it needs its own
characterization precondition anyway — both members have **zero** coverage, and
`getSystemSchema`'s output depends on live `CONFIG.MGT2`, which no fixture provides.

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

| Member                                                               | Apparent home                                                | Why it stays, for now                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| ~~`addActorsToScene`~~ — **resolved**                                | `scene-token-manager.ts`                                     | Went with **actor CRUD** to `actor-crud.ts`, as recorded. It never belonged to any scene/token path: it is reached from the actor-creation flow, and it reads the facade's own `permissions` field, `moduleId` and the module-level `ERROR_MESSAGES` directly rather than `this.sceneTokenManager`. Moving it to `scene-token-manager.ts` first would have created a cross-module dependency the actor-CRUD extraction had to undo.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ~~`calculateTokenPosition`~~ — **resolved**                          | `scene-token-manager.ts`                                     | Went with `addActorsToScene`, and stayed `private` on `ActorCrud`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ~~`readActorFlags`, `extractTokenArt`~~ — **resolved**               | `character-reader.ts`                                        | **Went with character reading, and the conditional is discharged.** This row was a conditional, not a decision, for four documents, and it is why pass 5.2 was scheduled last. Four independent reasons, any one sufficient. (1) **Structural:** their sole caller `getCharacterInfo` moved, so leaving them behind would force the back-reference the acyclic-DAG requirement forbids outright; sending them to `ActorDirectory` would make `CharacterReader` depend on a sibling concern module for two helpers of 6 and 19 lines, and force both to become non-private for a caller in another module. Character reading is the only home needing **no new edge at all**. (2) **Subject matter:** every one of `ActorDirectory`'s seven methods returns _identity tuples over sets of actors_ (`{id, name}` …); not one returns an actor's contents and not one sanitises anything. These two take a single `Actor` and return a _sanitised detail projection of it_ — they are the field builders for `CharacterInfo.flags` and `CharacterInfo.prototypeToken`, whose declaration travels with the cluster, and both fields' JSDoc names them. (3) **Dependency:** all three of their cross-boundary calls are `sanitizeData`, which `ActorDirectory` **never uses** — sending them there would have split the `sanitizeData` wrapper across two destinations and made both modules inject `FoundrySecurity` for one helper. (4) **The apparent pairing with `findActorsByFlag` is a coincidence of a comment, not of code.** `03a6836` added all three together, placed them adjacently and gave each a "never `actor.getFlag()`" warning — but `findActorsByFlag`'s implementation is _already_ in `actor-directory.ts` and reads flags through its **own** inline `readFlag` closure at a caller-supplied dotted path, returning `String(raw)`: one scalar for many actors. `readActorFlags` returns the whole sanitised flags object for **one** actor. Neither is expressible in terms of the other, so there is no duplication to consolidate and therefore no pull toward co-location. What they share is a fact about Foundry, and the load-bearing-comment requirement already keeps that fact in two files independently. **What would overturn this:** `ActorDirectory` acquiring a **direct caller** for either — and the remedy would then be to lift the shared part into a cross-cutting **leaf**, not to relocate the member into a sibling concern module. |     |
| `importActors`                                                       | an actor-CRUD module (cluster 3)                             | **Permanent** deferral, recorded by `extract-actor-mechanics-builders` — not "optional, last, or never" any more. Two reasons, neither of them "it is small". (1) **Its placement causes none of the coupling this refactor exists to remove:** it has exactly one cross-call, `getOrCreateFolder`, already a thin `actor-resolver` wrapper — one hop from a leaf. Moving it would shorten no dependency path and break no cycle, so it is a large method living in a large file, not a God-class symptom. (2) **Its risk is asymmetric in a way no other method's is:** it carries five load-bearing comments, four of them write-ordering contracts, and its failure mode is _silent duplicate actors under a slow or timed-out request_ — which is why it has comments instead of tests for those paths, and why its 28 green cases are not evidence about that path (they cover dry-run, reconciliation, folder placement and per-actor error capture: the scenarios someone thought to write). It has been verified against a live production world. If it is ever moved: solo change, nothing bundled, all 28 cases green unchanged, then a dry-run smoke test against a scratch world — never production. Nothing in the remaining clusters requires it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ~~`findBestCompendiumMatch`~~ (the **facade wrapper**) — **deleted** | `compendium-search.ts` — where the implementation already is | **Gone, and the reason it went is the point.** `extract-actor-crud` deleted it, but NOT by re-pointing its caller at `this.compendiumSearch.…` as this row predicted: its only caller, `createActorFromCompendium`, was **dead surface and was deleted**. A temporary bridge's expiry condition is _the absence of a caller_, not the arrival of a particular pass — so it expired one commit earlier than the plan expected and for a different reason. `getCompendiumDocumentFull`'s delegation, which looks identical in a diff, is **permanent** (`queries.ts` reaches it) and was deliberately untouched. The moved implementation keeps the non-`private` modifier it had to acquire in `extract-compendium-search`. **The closing claim here — "a public member of a collaborator, which is unremarkable" — was wrong, and `extract-character-reading` made it the evidence for a requirement.** It is reached by **nothing** in the repository (`grep -rn findBestCompendiumMatch packages shared scripts` matches only the declaration; the surface extractor reports 6 reached + 1 dead = 7 non-private on `CompendiumSearch`): dead surface on a collaborator, created entirely by the bridge mechanism, type-checking cleanly, failing no test, and **invisible to the facade's own surface diff because it is not a member of the facade**. Pass 5.2's bridge-visibility requirement exists because of it, and mandates restoring visibility in the same commit that deletes a bridge. **Do not "fix" this one by restoring `private`: it does not compile.** With no caller left, `private` makes it TS6133 under `noUnusedLocals` — pass 5.2 tried it and measured exactly that. The two visibility-honest states are `private` **with** a caller, or **deleted**, so the remedy for this member is deletion and it belongs to the dead-surface boundary change in the follow-ups table. The correction this yields to the requirement's own reasoning is worth keeping: the defect is invisible to type-checking only _while the modifier stays wide_, so `noUnusedLocals` **is** the mechanical detector — available to any pass that attempts the restoration instead of assuming it. Diagnosed in place on the member.                                                                                                                                                                                                                                       |
| ~~`createNpcActor`~~ — **resolved**                                  | actor CRUD                                                   | Moved to `actor-crud.ts` by `extract-actor-crud`, together with its seven `NPC_*`/`npc*` module-level bindings and its soft-validation comment. Kept here as a record because it is the members list that was misfiled twice: it sits physically _between_ `addSaveFeatureToActor` and `addAttackToActor`, so a contiguous excision of the mechanics cluster would have taken it along silently — and in this pass the same interleaving meant a contiguous cut would have taken the **neighbours** instead. Per-member AST extraction both times, never a block cut.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

| `getSystemSchema` (109 lines), `getWorldInfo` (17) | **`world-metadata.ts`** — decided, not yet created | **Residuals with a decided destination, as of `extract-character-reading`.** Both are `public`, real implementations rather than delegations, with **zero** call-graph edges in either direction, reached only from `queries.ts`, and neither validates Foundry state, audits, sanitises or resolves an actor. Together they are one concern — a read-only description of the world and the game system, as opposed to its contents — and `world-metadata.ts` takes **no constructor dependencies**, because giving it one in order to use it would be a behaviour change rather than a relocation. `WorldInfo` and `WorldUser` travel with `getWorldInfo`. `getSystemSchema` also sits physically between `createWorldItems` and `getCompendiumDocumentFull`, so a contiguous cut through cluster 1's region would have adopted it silently. **`getWorldInfo` is new to this record** — it was in no cluster in any document and nothing had classified it. The move is a separate following change; it needs its own characterization precondition (both have zero coverage and `getSystemSchema` reads live `CONFIG.MGT2`, which no fixture provides). |
| `getOrCreateFolder` (the **facade wrapper**) | `actor-resolver.ts` — where the implementation already is | **PERMANENT**, and it is the wrapper a later pass is most likely to delete by mistake. It is `private` and, after `extract-actor-crud`, has exactly **one** caller — `importActors`, which is itself a **permanent deferral** and therefore never moves. So the wrapper never becomes dead. Do not read "one caller" as "about to expire", and do not delete it reasoning that the actor-CRUD cluster which called it four times has moved: that reasoning type-checks cleanly and breaks the one method in the file whose failure mode is silent duplicate actors. Its lifetime is recorded on the member itself. |
| ~~`auditLog`, `findActorByIdentifier`~~ (the **facade wrappers**) — **deleted** | `security.ts` / `actor-resolver.ts` | **Gone, exactly as predicted and in the predicted commit.** Each had dropped to one caller — `searchCharacterItems` — when actor CRUD moved, and `extract-character-reading` deleted both in the stage that moved it. Both were `private`, so both were **internal** deletions and neither was a boundary change. `searchCharacterItems` is the reason `auditLog` existed at all: it is the package's only **read** path that audits. |
| ~~`sanitizeData`~~ (the **facade wrapper**) — **deleted** | `security.ts` | **Gone.** All five callers (`getCharacterInfo` ×2, `readActorFlags`, `extractTokenArt` ×2 — the one distribution the record got exactly right) moved with the character-reading cluster, and it was deleted in the same commit. `private`, so an **internal** deletion. Two of its five sites are the pass's two formatter reflows. |
| `validateFoundryState` (the **facade wrapper**) | `security.ts` — where the implementation already is | **PERMANENT, and it is now the third distinct way a wrapper can look deletable while it is not.** It is a boundary member (`queries.ts` reaches it directly in many places) and after `extract-character-reading` it has **zero intra-class callers** — `searchCharacterItems`, its last one, moved and now calls `security.validateFoundryState()` directly. So "nothing inside the class calls it any more" joins "the cluster that used it has moved" and "it is down to one caller" on the list of readings that each look like expiry, are each wrong for a wrapper in this tree, and each type-check cleanly in the pass that commits them. Its comment was rewritten in the same commit that removed the caller it named — a permanent wrapper whose comment names a caller that no longer exists misdirects the next pass exactly as a missing classification would. `getCompendiumDocumentFull` is the same shape. |

## Load-bearing comments (grep for `Do NOT`/`never`/`NEVER`/`WRITES`/`deliberately`/`RECONCIL`/`CRITICAL`)

**Now 17, and `extract-character-reading` moved six of them** — the largest number any
pass has relocated, into `character-reader.ts`. The count rose from 13 because that pass
**re-read the cluster instead of grepping it**: the map had recorded two for character
reading, and there are **six**, because three of them carry none of the marker phrases
this heading lists. Before it, `extract-actor-crud` moved exactly one
(`createNpcActor`'s soft-validation marker) and `extract-compendium-search` moved none —
the marker phrases appear nowhere in its 864 moved body lines, as expected of a cluster
that only reads and returns. **The heading's grep is an incomplete locator and always
has been:** read the cluster as well as grepping it. Line numbers throughout are
indicative only.

**One of the six travels inside an `interface`, in the commit that moves no method
body**, and that is the reason `extract-character-reading` had to add a
per-_declaration_ diff requirement: the per-method body-diff gate's obligation is stated
per method, so `CharacterInfo.flags`'s MIRROR WARNING would have had **no mechanical
check at all**. It now has one, at threshold zero.

**The two cross-file references: one is correct and must not be touched, the other is a
recorded residual and must not be "fixed".**

- **`actor-directory.ts:165` is correct as it stands and MUST NOT be edited.** It names
  `data-access.ts`'s `importActors`, which is a permanent deferral and did not move. The
  instruction to update it "in the same diff that moves `importActors`" describes a diff
  that will never exist.
- **`readActorFlags`'s comment now references a symbol in another file without naming
  the file, and that is recorded rather than repaired.** After the move its text —
  "Same rule as `importActors`' `findBySourceId`." — sits in `character-reader.ts` while
  `importActors` is in `data-access.ts`. `refactor-data-access-stage2.md:496` calls this
  "the only real hazard in this inventory" and prescribes rewriting it at move time to
  read "Same rule as `actor-crud.ts`'s `importActors`". **That instruction is wrong three
  ways and was deliberately not applied.** (1) `importActors` **never moved** — it is a
  recorded permanent deferral, still on the facade — so the prescribed text would name a
  file that does not contain it. (2) The comment names **no file** today, so the
  staleness the instruction describes never existed; it is a symbol reference.
  (`refactor-data-access.md`'s own earlier claim that this comment and
  `actor-directory.ts:157-166` "both name `data-access.ts`'s `importActors`" was an
  overstatement — only the first does.) (3) Editing it at all is what the
  load-bearing-comment requirement forbids: such a comment SHALL move **unedited**, and
  the body diff turns that into a mechanical check, since an edited comment line is a
  differing line no re-pointing produced. It moved verbatim and the body diff confirms
  it. If a later change wants to qualify it, that is the requirement's "explicitly
  overturned with a stated reason" route and belongs in its own change.

**Recounted: 13, and they are no longer all in `data-access.ts` — nor even in
two files.** The earlier claim ("all 10, all inside `importActors`") was true at
`902f3f0` and is now wrong in both respects — `03a6836` added three and put one
of them in an already-extracted collaborator, and
`extract-actor-mechanics-builders` moved three more into `actor-mechanics.ts`.
Line numbers are indicative only.

### In `data-access.ts`

| Location                                                                                                             | Guards                                                                                           | Destination cluster                                |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| `~1053` — "including why the flag must NOT be read with `actor.getFlag()`"                                           | the `findActorsByFlag` facade wrapper's own JSDoc, pointing at `ActorDirectory.findActorsByFlag` | **Stays on the facade** — it documents the wrapper |
| `~3759` — "getOrCreateFolder writes, so dry runs only _look up_ folders"                                             | `importActors` dryRun contract                                                                   | Actor CRUD tail (**permanent deferral**)           |
| `~3810` — "Read the flag via RAW property access, never `actor.getFlag('wodchar', …)`: getFlag throws …"             | `importActors`' `findBySourceId`                                                                 | Actor CRUD tail (**permanent deferral**)           |
| `~3869` — "RECONCILABILITY — this ordering is load-bearing … Do NOT refactor this into a post-create setFlag/update" | the sourceId stamp-before-`Actor.create` ordering                                                | Actor CRUD tail (**permanent deferral**)           |
| `~3895` — "A skip writes nothing, so settle it BEFORE resolving any folder"                                          | `importActors` no-op path ordering                                                               | Actor CRUD tail (**permanent deferral**)           |
| `~3918` — "so an update that keeps its folder never reaches getOrCreateFolder"                                       | `importActors` folder-placement ordering                                                         | Actor CRUD tail (**permanent deferral**)           |

### In `character-reader.ts` (all six moved verbatim by `extract-character-reading`)

**Six, where this map previously recorded two for the cluster.** Three of them carry
**none** of the marker phrases in this section's heading, so they were located by reading
the cluster rather than grepping it — which is the general lesson, not an incident.

| Location                                                                                                                                                                                         | Guards                                        | Notes                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~38` — "MIRROR WARNING: these types are duplicated, not shared … `shared/src/types.ts` … `systems/worldofdarkness/extract.ts`. Change one, change all."                                         | `CharacterInfo.flags`                         | **Inside an `interface` declaration**, moved in the commit that moved no method body — so the per-_method_ body-diff gate covered it not at all. This is the comment that forced the per-declaration diff requirement, verified at threshold **zero**. No marker phrase from the heading's grep except, incidentally, none: "MIRROR WARNING" is not in the list. |
| `~152` — "Read WITHOUT `getFlag()` — see the note on `readActorFlags`."                                                                                                                          | `getCharacterInfo`'s `include` param JSDoc    | An **intra-file** cross-reference now, where before it pointed at a sibling member in the same file — the one cross-reference this pass shortened rather than lengthened.                                                                                                                                                                                        |
| `~210` — "Nothing here runs unless the caller asked, so the default response shape is unchanged."                                                                                                | the opt-in extras block in `getCharacterInfo` | Records the back-compatibility contract of `options.include`: an OLD server talking to a NEW module must see a byte-identical default response. No marker phrase.                                                                                                                                                                                                |
| `~223` — "Honoured even when the actor has no prototypeToken — the caller learns 'asked and answered: there is none', not 'the module ignored me'."                                              | the `prototypeToken` honoured-echo            | Records why `included` lists a key whose value came back `null`: the difference between a fact and a silent lie about provenance. No marker phrase.                                                                                                                                                                                                              |
| `~1155` — "NEVER `actor.getFlag(scope, key)`, which throws for any scope that is not core / the system id / the world id / an active module id … Same rule as `importActors`' `findBySourceId`." | `readActorFlags`                              | **Moved verbatim, and deliberately NOT "fixed".** See the cross-reference note above: the prescribed mechanical rewrite would have named `actor-crud.ts`, which does not contain `importActors`. The residual — a symbol reference across a file boundary that names no file — is **recorded here rather than repaired inside a relocation**.                    |
| `~1173` — "`prototypeToken` is a DataModel, so it is converted with `toObject()` first; `Object.keys()` on the live model does not necessarily expose schema fields."                            | `extractTokenArt`'s `toObject()` call         | Sits **immediately above a line that reflows**. Both of the pass's two formatter reflows are inside `extractTokenArt`, and the first is the statement this comment guards, so the two-line diff there is the statement reflowing — the comment itself is byte-identical, which was asserted separately so the two could not be confused.                         |

The map's third nearby entry — the `findActorsByFlag` **facade wrapper**'s JSDoc — is
**not** this cluster's and correctly stayed on the facade with the wrapper it documents.
Its 18-line delegation is also the thing the stage-2 plan's "43-line trio" miscounted
into the cluster.

### In `actor-crud.ts` (moved verbatim by `extract-actor-crud`)

| Location                                                                | Guards           | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~904` — "3. Soft validation — collect warnings, do NOT block creation" | `createNpcActor` | Home reached. The **fourth** of the four soft-validation markers and the one the mechanics pass deliberately left behind, because `createNpcActor` is actor CRUD. Located by the `// 3. Soft validation` marker prefix, **not** by grepping `never block` — this one says "do NOT block creation". Verified verbatim by the body diff, which emits comments as part of the token stream so a dropped comment cannot pass as a formatter reflow. |

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

The comment marked "Actor CRUD" moved to `actor-crud.ts` unedited when
`extract-actor-crud` ran, and the six marked "Character reading" moved to
`character-reader.ts` unedited when `extract-character-reading` ran. The five marked
"Actor CRUD tail (permanent deferral)" are `importActors`' and stay where they are —
which is the cheapest possible outcome for the requirement that governs them, and part
of why that deferral is permanent. **Neither cross-reference in the hazard table needed
re-pointing, and neither got any:** `actor-directory.ts:165` names `importActors`, which
never moved and is still in `data-access.ts`, so it remains correct; the reciprocal
`readActorFlags` comment names no file, so there was nothing to re-point. The hazard
table's claim that the `readActorFlags` comment "cross-references `importActors` by name"
is right, and its implication that it therefore names a **file** is not — which is
exactly how the prescribed "mechanical fix" came to point at the wrong one.

## What remains on the facade, and why (the decomposition is complete)

**This is the enumeration the completion requirement demands, and it exists so a later
reader can tell a finished decomposition from an abandoned one.** With the last cluster
extracted, the no-new-concern requirement's second permitted category — "a member
belonging to one of the clusters recorded in the module map as not yet extracted" — is
**empty**. Without a positive statement of the end state, an unowned member on the facade
is indistinguishable from a member awaiting a pass that is never coming, and the natural
reading of a large residual is that the refactor stopped rather than finished.

**Deliberately not expressed as a line count.** A quoted size cannot express the
difference between a delegation and a concern; a file of delegations and a file of
concerns can be the same size, and only this enumeration distinguishes them. The figure
this capability's own `## Purpose` used to pin went stale in every one of the four passes.

`FoundryDataAccess` contains, and is intended to contain, exactly these five categories:

1. **Thin delegations** — 71 of its 73 non-private methods, one or a few lines each,
   forwarding to twelve collaborators (`security`, `actorResolver`, `permissions`,
   `journals`, `worldItems`, `actorDirectory`, `rollManager`, `sceneTokenManager`,
   `actorMechanics`, `compendiumSearch`, `actorCrud`, `characterReader`) plus the two
   injected leaves (`persistentIndex`, `transactions`).
2. **Three permanent wrappers**, each with its lifetime recorded **on the member**:
   `validateFoundryState` and `getCompendiumDocumentFull` (boundary members reached from
   `queries.ts`, the first now with **no intra-class caller at all**), and
   `getOrCreateFolder` (its only caller, `importActors`, is a permanent deferral and
   therefore never moves). It is the **one** remaining `private` method on the class.
3. **One permanent deferral**: `importActors`, 281 body lines, with its five load-bearing
   comments — argued, recorded, and verified against a live production world. Its
   failure mode is silent duplicate actors under a slow or timed-out request, which is
   why it has write-ordering comments rather than tests for those paths.
4. **Two recorded residuals with a decided destination**: `getSystemSchema` (109 lines)
   and `getWorldInfo` (17), both bound for `world-metadata.ts` in a following change.
5. **Eight dead-surface members** awaiting one boundary change of their own —
   `getRollState`, `saveRollButtonMessageId`, `getRollButtonMessageId`,
   `getRollStateFromMessage`, `requestRollStateSave`, `broadcastRollState`,
   `cleanOldRollStates`, `getCharacterEntity`. Seven are roll-state members.

Plus five interface declarations the retained delegations name (`SceneInfo`,
`SceneToken`, `SceneNote`, `WorldInfo`, `WorldUser`) and exactly one type imported back
from a collaborator (`CharacterInfo`, the `getCharacterInfo` delegation's return type).

**Nothing else.** Every future member is a delegation, or belongs in a collaborator from
the outset. Completion is **not** claimed for any member of an extracted concern that
remains implemented here: a residual is a member belonging to no extracted concern, and a
member that duplicates or pre-empts a collaborator's concern is a one-home violation to
be resolved rather than recorded.

**The dead-surface count is reported with the tool that produced it**, always. It is
**8**, per `reached-surface@1.0.0 union(checker,receiver)+sensitivity`, and the census
closes: 65 reached + 8 dead = 73 non-private methods. Four successive hand-written
extractors reported this class's dead surface as **13, 7, 9 and 8**, and the committed
tool has now reported 8 twice — the integer is tool-relative, and reporting it bare has
already caused four recounts. Alongside it, on a **collaborator**, sits a ninth dead
member the facade's own extractor structurally cannot see:
`CompendiumSearch.findBestCompendiumMatch`.

## Named follow-ups (raised by a pass, deliberately not done by it)

Each of these was found while moving code, is a real finding, and is explicitly **not**
a relocation — so none was folded into the pass that found it.

| Follow-up                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Raised by                                                    | Why it is not a relocation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`addActorsToScene`'s `transactionId?` parameter, and the whole of `TransactionManager`.** After `createActorFromCompendium` was deleted, **nothing calls `startTransaction`**, nothing passes a `transactionId` (`queries.ts:558` and `createActorFromCompendiumEntry` both omit it), and the two guarded `transactionManager` uses inside `addActorsToScene` are **unreachable through the facade** while remaining statically live. So a ~275-line collaborator with rollback machinery is now reached by nothing that can be triggered. | `extract-actor-crud`                                         | Removing the parameter is a **boundary change** (it is part of a public signature); removing the module is a **behaviour question**. The block was moved verbatim, guard and all, and the module is listed in the Layout table as an injected leaf. Whoever takes this on should decide both at once. **Restated unchanged by `extract-character-reading`:** the character-reading cluster touches no transaction, so that pass's evidence neither supports nor weakens the verdict, and it stays a follow-up.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **The five-member creature-index type family is declared in three places inside this package.** `creature-index.ts`, `compendium-search.ts` (byte-identical today), and `packages/mcp-server/src/systems/types.ts`'s differently-shaped mirror.                                                                                                                                                                                                                                                                                              | `extract-compendium-search`                                  | Consolidating needs `creature-index.ts` edited to export five declarations — a second module changed by a relocation pass — and the response-shape mirroring requirement records the family as declared in three trees with up to four copies each and **structurally divergent** between them (flat vs nested `systemData`, `hasSpells` vs `hasSpellcasting`). Reconciling two of four is the half-change that requirement forbids. Its own change, with its own inventory.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **`setActorOwnership` writes ownership with no audit call**, alone among the write paths in `actor-crud.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                 | `extract-actor-crud`                                         | Pinned as **observed** behaviour by `actor-crud.test.ts` and moved verbatim. If it is a defect it is a one-line behaviour change with its own argument; noted so the next reader of `actor-crud.ts` does not "fix" it inside a relocation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ~~**The body-diff / surface-diff / module-scope extractors have now been built in scratch space four times.**~~ **RESOLVED — they are committed, at `scripts/refactor/`.** `member-text.mjs` (per-member body diff, the transitive module-scope closure, the parse-tree token-identity check), `reached-surface.mjs` (checker ∪ receiver-text ∪ over-approximation), `selfcheck.mjs` (`npm run test:refactor-tools`). Read `scripts/refactor/README.md` **before** the next pass; do not write a sixth extractor.                            | all three extraction passes                                  | ~~Bundling a new committed script into an extraction pass is scope creep.~~ Resolved as its own change instead of inside a pass, which is what the objection actually asked for. The tooling reproduces both landed moves: 25 of 27 items byte-identical across `extract-actor-crud` with the two prettier reflows measured at 90 → 104 and 93 → 102 columns, and an **empty** surface diff across `extract-compendium-search` and `extract-actor-crud` alike. Nothing lives under `packages/foundry-module/src/`, on purpose: a file added there changes the member counts, surface lists and madge file count that the passes measure. **`extract-character-reading` was the first pass to USE them rather than rebuild them, and they held:** the `closure` subcommand reproduced the transitive declaration set exactly (5 declarations, `CharacterItem`/`CharacterEffect` tagged `transitive-only`), `extract` reproduced all eleven members' line ranges and body counts, and `diff` produced 15-of-16 byte-identical with 1 reflow-only. Two things it needed and found: the **per-declaration** differ turned out to already exist — `diff` accepts declarations as items via `moduleScope`, which the README's `SceneTokenPlacement` example shows — and the differ's refusal to accept a `from` spanning a newline is correct but means a _multi-line insertion_ cannot be enumerated, which matters when `getFullText()` attributes a whole module header to the first declaration in a new file. Three of the 31 selfchecks had also gone red at `8d14064` for reasons that were not about the code (a sixth test file); they now derive their file census instead of freezing it. |
| **`world-metadata.ts` does not exist yet.** `getSystemSchema` (109 lines) and `getWorldInfo` (17) are one concern — the read-only description of the world and the game system — with a **decided** home and no module to move into.                                                                                                                                                                                                                                                                                                         | `extract-character-reading`                                  | Bundling a second, unrelated module boundary into a cluster extraction would put two ownership specifications in one delta, which is the mirror of the prohibition on splitting one boundary across several changes. It also needs its own characterization precondition: both members have **zero** coverage, and `getSystemSchema` reads live `CONFIG.MGT2`, which no fixture provides. `WorldInfo`/`WorldUser` travel with `getWorldInfo`; the module takes **no** constructor dependencies.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **`searchCharacterItems` audits a read.** It is the only read path in the package that calls `auditLog` (with a `matchCount`), and it is the sole reason the facade's private `auditLog` wrapper existed at all.                                                                                                                                                                                                                                                                                                                             | `extract-character-reading`                                  | Moved verbatim, and the audit call is **pinned** by the precondition tests rather than merely carried. If auditing reads is wrong it is a one-line behaviour change with its own argument; noted so the next reader of `character-reader.ts` does not "fix" it inside a relocation — the same note `extract-actor-crud` left about `setActorOwnership` writing _without_ an audit call, from the opposite direction.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Nine dead members want one boundary change.** The eight on the facade — `getRollState`, `saveRollButtonMessageId`, `getRollButtonMessageId`, `getRollStateFromMessage`, `requestRollStateSave`, `broadcastRollState`, `cleanOldRollStates`, `getCharacterEntity` (seven of them roll-state) — **plus `CompendiumSearch.findBestCompendiumMatch`**, which is `public`, reached by nothing, and cannot simply be re-privatised (`private` makes it TS6133).                                                                                  | `extract-character-reading`, restating four earlier recounts | Removing a non-private member reached from outside is a **boundary change** and needs its own declaration; a relocation pass may not make one in passing. Sweep all nine at once, and note that for `findBestCompendiumMatch` the remedy is **deletion**, not visibility restoration — the two honest states are `private` with a caller or deleted. Count them with the committed extractor and report the tool: **8** on the facade per `reached-surface@1.0.0`, after four hand-written extractors said 13, 7, 9 and 8.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

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
grep -c 'return this\.\(actorCrud\|compendiumSearch\|actorMechanics\|characterReader\)\.' \
  packages/foundry-module/src/data-access.ts           # the delegation counts
node scripts/refactor/reached-surface.mjs extract \
  --facade packages/foundry-module/src/data-access.ts --class FoundryDataAccess \
  --files 'packages/foundry-module/src/queries.ts,packages/foundry-module/src/main.ts,packages/foundry-module/src/settings.ts,packages/foundry-module/src/socket-bridge.ts,packages/foundry-module/src/*.test.ts,packages/foundry-module/src/__fixtures__/fake-foundry.ts' \
  --tsconfig packages/foundry-module/tsconfig.json     # the surface, the census, the dead count
npm run test:refactor-tools                            # the extractors themselves (31 checks)
grep -nE 'Do NOT|do NOT|NEVER|never |WRITES|writes,|deliberately|RECONCIL|CRITICAL' \
  packages/foundry-module/src/*.ts | grep -v '\.test\.ts'   # load-bearing comments
npx vitest run --reporter=dot                          # the test count
```

If a figure here disagrees with the source, the map is the defect — correct the
map. A stale map is never licence to ignore the requirements it records.
