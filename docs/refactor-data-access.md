# `data-access.ts` God-class split — module map

`packages/foundry-module/src/data-access.ts` held two classes and 138
methods (10,554 lines). `FoundryDataAccess` is `queries.ts`'s only entry
point into Foundry, and `packages/mcp-server` depends on the shapes it
returns, so this split is a **facade + collaborators** refactor: the class
stays the entry point with an unchanged public surface, and its
implementation is delegated to small, single-purpose collaborator classes
held as private fields. No behaviour, signature, or side-effect ordering was
changed — see the drift-safety notes at the end.

## Layout

| File                     | Lines | Extracted from `FoundryDataAccess`                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Depends on                   |
| ------------------------ | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `creature-index.ts`      | 1,452 | The **other** class in the original file, `PersistentCreatureIndex` (26 methods) — file-based creature index cache for D&D5e/PF2e/Cosmere/MGT2e. Already fully self-contained (used only via one field, `this.persistentIndex`); moved verbatim.                                                                                                                                                                                                                                             | —                            |
| `security.ts`            | 219   | `validateFoundryState`, `auditLog`, `sanitizeData`, `removeSensitiveFields`, `isSensitiveOrProblematicField`, `safeJSONStringify` — the output-sanitization/write-audit helpers called from nearly every concern.                                                                                                                                                                                                                                                                            | —                            |
| `actor-resolver.ts`      | 88    | `findActorByIdentifier`, `getOrCreateFolder` — actor/folder lookup used across item CRUD, feature/attack builders, WFRP4e updates, journal/actor creation.                                                                                                                                                                                                                                                                                                                                   | —                            |
| `journal-manager.ts`     | 284   | `createJournalEntry`, `listJournals`, `getJournalContent`, `getJournalPageContent`, `updateJournalContent`.                                                                                                                                                                                                                                                                                                                                                                                  | `security`, `actor-resolver` |
| `world-items-manager.ts` | 270   | `listWorldItems`, `updateWorldItems`, `createWorldItems`.                                                                                                                                                                                                                                                                                                                                                                                                                                    | `security`                   |
| `actor-directory.ts`     | 164   | `listActors`, `getFriendlyNPCs`, `getPartyCharacters`, `getConnectedPlayers`, `findPlayers`, `findActor`.                                                                                                                                                                                                                                                                                                                                                                                    | `security`, `actor-resolver` |
| `roll-manager.ts`        | 918   | Interactive roll-request chat cards: `validateWritePermissions`, `requestPlayerRolls`, `resolveTargetPlayer`, `buildRollFormula`, `getSkillCode`, `buildRollButtonLabel`, `attachRollButtonHandlers`, `saveRollState`, `getRollState`, `saveRollButtonMessageId`, `getRollButtonMessageId`, `getRollStateFromMessage`, `updateRollButtonMessage`, `requestRollStateSave`, `broadcastRollState`, `cleanOldRollStates`, `rollDice`, plus the `rollButtonProcessingStates` in-flight-click map. | `security`                   |
| `scene-token-manager.ts` | 695   | `getActiveScene`, `getTokenDisposition`, `listScenes`, `switchScene`, `getCharacterEntity`, `moveToken`, `updateToken`, `deleteTokens`, `getTokenDetails`, `toggleTokenCondition`, `getAvailableConditions`.                                                                                                                                                                                                                                                                                 | `security`                   |
| `data-access.ts`         | 7,099 | The facade: unchanged public surface, thin delegations to the above, plus everything not yet extracted (see below).                                                                                                                                                                                                                                                                                                                                                                          | all of the above             |

`FoundryDataAccess`'s own fields, in construction order (matters — later
fields' initializers reference earlier ones):

```ts
private moduleId, persistentIndex, security, actorResolver,
        journals, worldItems, actorDirectory, rollManager, sceneTokenManager;
```

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
   behaviour change — this was the actual safety net given the thin (28
   module tests) coverage.

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
5. `addActorsToScene` and `calculateTokenPosition` were deliberately **left
   on the facade** rather than moved into `scene-token-manager.ts`: they're
   reached from the actor-creation flow (`createActorFromCompendium*`), so
   they're a better fit for the actor-CRUD module above once that exists —
   moving them into `scene-token-manager.ts` first would just create a new
   cross-module dependency to undo.

## Load-bearing comments (grep for `Do NOT`/`never`/`WRITES`/`deliberately`)

All 10 are still in `data-access.ts`, verbatim, since they live inside
`importActors` (not-yet-extracted, see above):

- `getOrCreateFolder writes, so dry runs only *look up* folders` (dryRun contract)
- `Read the flag via RAW property access, never actor.getFlag('wodchar', …): getFlag throws …` (the wodchar-scope gotcha)
- `Do NOT refactor this into a post-create setFlag/update — a timeout between the two would leave an invisible actor …` (sourceId-stamping-before-create contract)
- `A skip writes nothing, so settle it BEFORE resolving any folder` (ordering contract for the no-op path)
- the three soft-validation `// 3. Soft validation — collect warnings, do NOT block creation` / `never block` comments in the actor-mechanics builders (still in `data-access.ts`, not yet moved)

When actor CRUD is eventually extracted, these must move to
`actor-crud.ts` **unedited**.

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

There is no automated drift guard for this note (unlike `webgen`'s
generated trees) — if you extract another concern, update the table above
by hand.
