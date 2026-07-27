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

| File                     | Lines (approx.) | Extracted from `FoundryDataAccess`                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Depends on                   |
| ------------------------ | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `creature-index.ts`      | ~1,450          | The **other** class in the original file, `PersistentCreatureIndex` (26 methods) — file-based creature index cache for D&D5e/PF2e/Cosmere/MGT2e. Already fully self-contained (used only via one field, `this.persistentIndex`); moved verbatim.                                                                                                                                                                                                                                             | —                            |
| `security.ts`            | ~220            | `validateFoundryState`, `auditLog`, `sanitizeData`, `removeSensitiveFields`, `isSensitiveOrProblematicField`, `safeJSONStringify` — the output-sanitization/write-audit helpers called from nearly every concern.                                                                                                                                                                                                                                                                            | —                            |
| `actor-resolver.ts`      | ~90             | `findActorByIdentifier`, `getOrCreateFolder` — actor/folder lookup used across item CRUD, feature/attack builders, WFRP4e updates, journal/actor creation.                                                                                                                                                                                                                                                                                                                                   | —                            |
| `journal-manager.ts`     | ~285            | `createJournalEntry`, `listJournals`, `getJournalContent`, `getJournalPageContent`, `updateJournalContent`.                                                                                                                                                                                                                                                                                                                                                                                  | `security`, `actor-resolver` |
| `world-items-manager.ts` | ~270            | `listWorldItems`, `updateWorldItems`, `createWorldItems`.                                                                                                                                                                                                                                                                                                                                                                                                                                    | `security`                   |
| `actor-directory.ts`     | ~255            | `listActors`, `getFriendlyNPCs`, `getPartyCharacters`, `getConnectedPlayers`, `findPlayers`, `findActor`, **`findActorsByFlag`** (added by the `03a6836` read-path change, which is why this file grew from the 164 lines first recorded here). **Carries a load-bearing comment** — see the inventory below.                                                                                                                                                                                | `security`, `actor-resolver` |
| `roll-manager.ts`        | ~920            | Interactive roll-request chat cards: `validateWritePermissions`, `requestPlayerRolls`, `resolveTargetPlayer`, `buildRollFormula`, `getSkillCode`, `buildRollButtonLabel`, `attachRollButtonHandlers`, `saveRollState`, `getRollState`, `saveRollButtonMessageId`, `getRollButtonMessageId`, `getRollStateFromMessage`, `updateRollButtonMessage`, `requestRollStateSave`, `broadcastRollState`, `cleanOldRollStates`, `rollDice`, plus the `rollButtonProcessingStates` in-flight-click map. | `security`                   |
| `scene-token-manager.ts` | ~700            | `getActiveScene`, `getTokenDisposition`, `listScenes`, `switchScene`, `getCharacterEntity`, `moveToken`, `updateToken`, `deleteTokens`, `getTokenDetails`, `toggleTokenCondition`, `getAvailableConditions`.                                                                                                                                                                                                                                                                                 | `security`                   |
| `data-access.ts`         | ~7,220          | The facade: unchanged externally-reached surface, thin delegations to the above, plus everything not yet extracted (see below). Was 7,099 at `902f3f0`; the `03a6836` read-path change added the `include`-option plumbing and the flag/token-art helpers.                                                                                                                                                                                                                                   | all of the above             |

`FoundryDataAccess`'s own fields, in construction order (matters — later
fields' initializers reference earlier ones):

```ts
private moduleId, persistentIndex, security, actorResolver,
        journals, worldItems, actorDirectory, rollManager, sceneTokenManager;
```

## The externally-reached surface (the compatibility boundary)

The frozen surface is defined by **who reaches it**, not by the
`public`/`private` modifier — the spec's compatibility-boundary requirement
turns on exactly this. Measured against the current source, the class declares
**113 members** (74 non-private methods + 30 private methods + 9 private
collaborator fields), of which **61 are actually reached from outside**.

There are exactly **five** external reach sites, and `queries.ts` is not the
only one:

| Reach site                | Accesses | Notes                                                                                                                                             |
| ------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `queries.ts`              | ~116     | The bridge. 75 `CONFIG.queries[…]` registrations, each a `handleX` that calls `this.dataAccess.X(…)`.                                             |
| `main.ts`                 | 7        | `queryHandlers.dataAccess.attachRollButtonHandlers` (`:638`, `:646`), `.rebuildEnhancedCreatureIndex` (`:137`–`:138`), `.saveRollState` (`:557`). |
| `settings.ts`             | 2        | `bridge?.dataAccess?.rebuildEnhancedCreatureIndex` (`:47`).                                                                                       |
| `import-actors.test.ts`   | —        | 28 cases, all targeting `importActors`.                                                                                                           |
| `actor-read-path.test.ts` | —        | 17 cases, targeting `getCharacterInfo`'s flags/art fields and `findActorsByFlag`.                                                                 |

**Consequence for extraction passes:** three members (`attachRollButtonHandlers`,
`rebuildEnhancedCreatureIndex`, `saveRollState`) are reached **only** from
`main.ts`/`settings.ts` and by no query handler and no test. Judging the boundary
from `queries.ts` alone would classify them as internal and therefore freely
deletable, which would silently break the roll-button chat hook and the
creature-index rebuild setting. Always include `main.ts` and `settings.ts`.

13 non-private members are reached from nowhere at all (`getCharacterEntity`,
`createActorFromCompendium` — the bridge query of that name is handled by
`handleCreateActorFromCompendium`, which calls
`createActorFromCompendiumEntry` instead — plus 9 roll-state members reached
only from inside `roll-manager.ts`, and `broadcastRollState`/`cleanOldRollStates`).
These are dead-surface candidates, **not** cleaned up here: deleting a
non-private member is a boundary change under the spec and belongs to its own
change.

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
   `this.resolver.X()`, with the collaborator instance **constructor-injected**
   (e.g. `new JournalManager(security, actorResolver)`), not reached for
   via a back-reference to the facade. This keeps the dependency graph a
   DAG (`security`/`actor-resolver` are leaves; concern modules depend on
   them, never the reverse) and makes a forgotten rewrite a **compile
   error** (`tsc` fails with "property does not exist"), not a silent
   behaviour change — this was the actual safety net given the thin coverage
   (at the time of the split, one test file with 28 cases, all of them
   targeting `importActors`).

   **Current coverage, recounted:** 2 test files, **45 cases** —
   `import-actors.test.ts` (28) and `actor-read-path.test.ts` (17, added by
   `03a6836`). Workspace-wide `npm run test --workspaces` is 327 (282
   `mcp-server` + 45 `foundry-module`). The "28" first recorded here was
   correct for the single test file that existed then; it is now the count of
   one of two files, not of the package.

Three genuinely dead private wrapper methods
(`removeSensitiveFields`/`isSensitiveOrProblematicField`/`safeJSONStringify`)
were deleted from `data-access.ts` rather than kept as unused wrappers,
since after `sanitizeData` was rewritten to delegate directly to
`security.sanitizeData()`, nothing else in the facade called them —
`tsc`'s unused-private-member check caught this immediately.

## Not yet extracted (highest-value next stages)

`data-access.ts` is still 7,099 lines. In priority order for a follow-up
pass, using the same facade+collaborator pattern:

1. **Compendium/creature search** (~1,500 lines): `searchCompendium`,
   `shouldApplyFilters`, `passesFilters`, `calculateRelevanceScore`,
   `listCreaturesByCriteria` + the five `passes*Criteria` variants,
   `fallbackBasicCreatureSearch`, `prioritizePacksForCreatures`,
   `getPackPriority`, `passesCriteria`, `matchesSearchCriteria`,
   `getCompendiumDocumentFull`, `findBestCompendiumMatch`,
   `getAvailablePacks`, `rebuildEnhancedCreatureIndex`,
   `getEnhancedCreatureIndex`. Depends on `creature-index.ts` + `security`.
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
   `actor-resolver`, and (via `findBestCompendiumMatch`/
   `getCompendiumDocumentFull`) the not-yet-extracted search module, plus
   `addActorsToScene` from `scene-token-manager.ts`.
4. **Actor mechanics builders** (~2,500 lines): `addSaveFeatureToActor`,
   `addAttackToActor`, `addAuraToActor`, `addPassiveFeatureToActor`,
   `addAttackWithSaveToActor`, `setActorSpellcasting`, `addSpellsToActor`,
   `addFeaturesFromCompendium`, `useItem`. Depends on `security` +
   `actor-resolver`.

## Deliberately left on the facade (recorded deferrals)

These members look like they belong to an existing collaborator but are
**intentionally** still on `FoundryDataAccess`. Under the spec's facade and DAG
requirements a recorded deferral is permitted; an unrecorded one is a violation.
Anything added to this section needs a member, a destination, and a reason.

| Member                              | Apparent home                                         | Why it stays, for now                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `addActorsToScene`                  | `scene-token-manager.ts`                              | Reached from the actor-creation flow (`createActorFromCompendium`/`…Entry`), not from any scene/token path, and it uses the module-level `permissionManager`/`ERROR_MESSAGES` imports directly rather than `this.sceneTokenManager`. Moving it to `scene-token-manager.ts` first would create a cross-module dependency that the actor-CRUD extraction would immediately have to undo. Goes with **actor CRUD** (cluster 3). |
| `calculateTokenPosition`            | `scene-token-manager.ts`                              | Private sibling called only by `addActorsToScene`; moves with it, for the same reason.                                                                                                                                                                                                                                                                                                                                       |
| `readActorFlags`, `extractTokenArt` | `actor-directory.ts` (adjacent to `findActorsByFlag`) | Added by `03a6836` and physically placed next to the `actor-directory` wrappers, but their only caller today is `getCharacterInfo`. They go with **character reading** (cluster 2) unless a later change gives `ActorDirectory` a direct caller — re-check at extraction time. `readActorFlags` carries a cross-referencing load-bearing comment; see the inventory below.                                                   |
| `permissionManager` (not injected)  | constructor injection                                 | A pre-existing module-level singleton imported directly by `journal-manager`, `roll-manager` and `scene-token-manager`. The spec's injection requirement explicitly carves this out; closing the carve-out is its own change.                                                                                                                                                                                                |

## Load-bearing comments (grep for `Do NOT`/`never`/`NEVER`/`WRITES`/`deliberately`/`RECONCIL`/`CRITICAL`)

**Recounted: 13, and they are no longer all in `data-access.ts`.** The earlier
claim ("all 10, all inside `importActors`") was true at `902f3f0` and is now
wrong in both respects — `03a6836` added three and put one of them in an
already-extracted collaborator. Line numbers are indicative only.

### In `data-access.ts`

| Location                                                                                                             | Guards                                                                                           | Destination cluster                                |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| `~358` — "Read WITHOUT `getFlag()`"                                                                                  | `getCharacterInfo`'s flags option (param JSDoc)                                                  | Character reading                                  |
| `~2430` — "including why the flag must NOT be read with `actor.getFlag()`"                                           | the `findActorsByFlag` facade wrapper's own JSDoc, pointing at `ActorDirectory.findActorsByFlag` | **Stays on the facade** — it documents the wrapper |
| `~2457` — "NEVER `actor.getFlag(scope, key)`, which throws for any scope that is not …"                              | `readActorFlags`                                                                                 | Character reading                                  |
| `~4906` — "Soft validation — collect warnings, do NOT block creation"                                                | `createNpcActor`                                                                                 | **Actor CRUD**, not mechanics builders             |
| `~5084` — "Soft validation — collect warnings, never block"                                                          | `addAttackToActor`                                                                               | Actor mechanics builders                           |
| `~5319` — "Soft validation — collect warnings, never block"                                                          | `addAuraToActor`                                                                                 | Actor mechanics builders                           |
| `~5591` — "Soft validation — both damage groups unified"                                                             | `addAttackWithSaveToActor`                                                                       | Actor mechanics builders                           |
| `~6506` — "getOrCreateFolder writes, so dry runs only _look up_ folders"                                             | `importActors` dryRun contract                                                                   | Actor CRUD tail                                    |
| `~6557` — "Read the flag via RAW property access, never `actor.getFlag('wodchar', …)`: getFlag throws …"             | `importActors`' `findBySourceId`                                                                 | Actor CRUD tail                                    |
| `~6616` — "RECONCILABILITY — this ordering is load-bearing … Do NOT refactor this into a post-create setFlag/update" | the sourceId stamp-before-`Actor.create` ordering                                                | Actor CRUD tail                                    |
| `~6642` — "A skip writes nothing, so settle it BEFORE resolving any folder"                                          | `importActors` no-op path ordering                                                               | Actor CRUD tail                                    |
| `~6665` — "so an update that keeps its folder never reaches getOrCreateFolder"                                       | `importActors` folder-placement ordering                                                         | Actor CRUD tail                                    |

Earlier counts said "three soft-validation comments in the actor-mechanics
builders". There are **four**, and one of the four (`createNpcActor`) is in
actor CRUD, not the builders. Corrected above.

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
