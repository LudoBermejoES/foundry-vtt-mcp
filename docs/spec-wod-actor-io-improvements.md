# Design spec: World of Darkness actor I/O improvements

**Status:** design only — no implementation in this document.
**Scope:** the `worldofdarkness-*` actor read/write surface plus the two generic
tools it leans on (`list-characters`, `manage-actors`) and the query transport
underneath them.
**Motivation:** six concrete friction points hit while importing six mortal PCs
into a live production world. Each item below is written as _observed symptom →
root cause (with file:line) → proposed change (with the layers it touches)_.

Format precedent: [`spec-create-npc.md`](spec-create-npc.md) — same 4-layer
architecture section, per-field tables, staged plan.

---

## 1. Context

### 1.1 Repository layout

| Path                       | What                                                                             |
| -------------------------- | -------------------------------------------------------------------------------- |
| `packages/mcp-server/`     | Node.js MCP server (TypeScript, stdio to the agent, WebSocket/WebRTC to Foundry) |
| `packages/foundry-module/` | The Foundry VTT module (browser context, GM client)                              |

> **Correction to the precedent spec — itself corrected.** `spec-create-npc.md`
> listed a third workspace as `packages/shared/`. That **path** is wrong, and an
> earlier revision of this note over-corrected by saying the workspace "does not
> exist in this fork". It does exist: it is `shared/` at the **repo root**,
> published as `@foundry-mcp/shared`, and it is in the root `package.json`
> `workspaces` array (`["packages/*", "shared"]`).
>
> What is true is that it is **not actually shared**. It exports ~74 symbols, of
> which 7 are consumed anywhere — the campaign types, imported by exactly one
> file, `packages/mcp-server/src/tools/campaign-management.ts`.
> `packages/foundry-module` does not declare it as a dependency and re-declares
> the response shapes locally; see `packages/foundry-module/src/data-access.ts`
> — _"Local type definitions to avoid shared package import issues"_ — above the
> local `CharacterInfo` interface. So the operative rule is unchanged: any spec
> that says "add the type to `shared`" and expects both packages to pick it up is
> stale, and a response-shape change must be edited in **both** packages (three
> places, if the shape also has a `shared/` copy). See
> `docs/refactor-data-access.md` and the `foundry-module-architecture`
> capability's response-shape-mirroring requirement.

### 1.2 The 4-layer architecture

Every tool in this repo, WoD included, is wired through the same four layers:

1. **Server tool class** — `packages/mcp-server/src/tools/worldofdarkness/*.ts`.
   Zod validation, then `foundryClient.query('foundry-mcp-bridge.<method>', payload)`.
2. **Backend registration** — `packages/mcp-server/src/backend.ts`, four touch
   points per tool: import (`backend.ts:37-44`), instantiation
   (`backend.ts:1229-1236`), `allTools` spread (`backend.ts:1468-1469`), and a
   `case` in the dispatch switch (`backend.ts:1629-1667`).
3. **Query handler** — `packages/foundry-module/src/queries.ts`. Registered into
   Foundry's `CONFIG.queries` table (e.g. `queries.ts:132` for `importActors`);
   does the GM check (`validateGMAccess()`), `validateFoundryState()`, coarse
   argument validation, then delegates.
4. **Data access** — `packages/foundry-module/src/data-access.ts`. The actual
   Foundry API calls (`Actor.create`, `actor.update`,
   `createEmbeddedDocuments`, …).

Transport between layers 2 and 3: a raw `ws` `WebSocketServer` in `noServer`
mode (`packages/mcp-server/src/foundry-connector.ts:98-111`), or a WebRTC data
channel, selected by `foundry.connectionType`. Requests are `mcp-query`
messages; responses are `mcp-response` messages correlated by `id`
(`foundry-connector.ts:215-234`, `packages/foundry-module/src/socket-bridge.ts:265-291`).

### 1.3 Facts about the transport that this spec depends on

| Fact                                                                                                                                                  | Where                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Query timeout is a **hardcoded 10 000 ms**, not read from config                                                                                      | `foundry-connector.ts:382` — `}, 10000); // 10 second timeout`                                                        |
| The timeout error string is `Query timeout: ${method}`                                                                                                | `foundry-connector.ts:381`                                                                                            |
| `query()` takes **no** timeout parameter — `query(method, data?)`                                                                                     | `foundry-connector.ts:359`, wrapper at `foundry-client.ts:57`                                                         |
| `foundry.connectionTimeout` (default 10 000, env `FOUNDRY_CONNECTION_TIMEOUT`) exists but is **never read** by `foundry-connector.ts`                 | `config.ts:18`, `config.ts:68`                                                                                        |
| WebSocket path sets no `maxPayload` → `ws` default of 100 MiB                                                                                         | `foundry-connector.ts:98`                                                                                             |
| WebRTC path is capped by SCTP at 64 KiB per message and chunks at 50 KiB, with a 30 s reassembly timeout                                              | `config.ts` → `WEBRTC_CONSTANTS.MAX_MESSAGE_SIZE`, `CHUNK_SIZE`, `CHUNK_TIMEOUT_MS`                                   |
| Tool responses are truncated at `toolResponseMaxChars`, default 20 000                                                                                | `config.ts:48`                                                                                                        |
| A timed-out query is **not cancelled** on the Foundry side; the late `mcp-response` is silently dropped because `pendingQueries` no longer has the id | `foundry-connector.ts:379-382` (delete + reject), `foundry-connector.ts:215-234` (`if (pending)` … else fall through) |

### 1.4 Affected existing tools

| Tool                           | Layer-1 file                                                                | Touched by item              |
| ------------------------------ | --------------------------------------------------------------------------- | ---------------------------- |
| `worldofdarkness-import-actor` | `tools/worldofdarkness/import-actor.ts`                                     | 1, 4, 6                      |
| `worldofdarkness-get-sheet`    | `tools/worldofdarkness/get-sheet.ts` + `systems/worldofdarkness/extract.ts` | 2, 3                         |
| `get-character`                | `tools/character.ts:786-811`                                                | 3                            |
| `list-characters`              | `tools/character.ts:432-463`                                                | 3, 4                         |
| `manage-actors`                | `tools/actor-management.ts`                                                 | 5                            |
| `manage-world-items`           | `tools/character.ts:670-689`                                                | 5 (reference implementation) |

### 1.5 Deployment cost — why "which package changes" decides priority

A change confined to `packages/mcp-server/` ships by rebuilding and restarting
the MCP server. A change that touches `packages/foundry-module/` needs a
**second** deploy — the module must be rebuilt, copied to the Foundry data
directory, and the world reloaded — and the two deploys are independent, so a
stale module silently answers new server queries with old shapes. Every proposal
below is therefore tagged **server-only** or **module deploy**.

---

## 2. The evidence

### Item 1 — Batch import times out with no partial results

**Observed.** `worldofdarkness-import-actor` called with `actors: [6 docs]`,
~305 KB of JSON total, failed with:

```
Query foundry-mcp-bridge.importActors failed: Query timeout: foundry-mcp-bridge.importActors
```

No per-actor outcome came back. Re-running as six single-actor calls (~47 KB
each) succeeded every time, so nothing about the documents themselves was wrong.

**Root cause.** Three compounding causes, in order of confidence:

1. **A fixed 10 s ceiling on an unbounded-duration operation.**
   `foundry-connector.ts:382` hardcodes `setTimeout(..., 10000)`. Meanwhile
   `DataAccess.importActors` (`data-access.ts:9873`) is a **sequential** `for`
   loop that per actor awaits `getOrCreateFolder`, then `Actor.create(doc)`
   (`data-access.ts:9940`) — which itself creates every embedded item and the
   prototype token. Six actors of ~100 items each is comfortably over 10 s on a
   live world; one actor is not. The observed 1-succeeds/6-fails split is
   exactly what a fixed wall-clock ceiling on a linear-in-N operation looks
   like.
2. **Per-actor results are accumulated but only returned at the end.**
   `results` is built inside the loop and returned once at
   `data-access.ts:9952`. There is no incremental reporting, so a timeout
   discards work the module already knows about.
3. **A single failing actor aborts the batch.** `data-access.ts:9942` throws
   `Foundry failed to create actor: ${doc.name}` from inside the loop, which
   propagates out of `handleImportActors` (`queries.ts:2066`) and collapses the
   whole call to one error string. Same for the per-doc validation loop at
   `queries.ts` (`each actor document must have name, type, and system`).

> **Disagreement with the framing.** The premise says _"The actors were left
> untouched (good)."_ The code offers no such guarantee, and this should be
> treated as a correctness bug rather than a UX wart. On timeout the server
> deletes the `pendingQueries` entry and rejects (`foundry-connector.ts:379-382`);
> it never sends a cancel message. The module's `handleMCPQuery`
> (`socket-bridge.ts:265-291`) keeps awaiting the handler and eventually calls
> `callback(...)`, whose `mcp-response` is dropped because `pending` is
> `undefined` (`foundry-connector.ts:215-234`). So `Actor.create()` calls already
> in flight **complete**, and any actors created before the deadline **stay
> created**, invisibly. Today's run happening to leave the world clean was luck
> (most likely the timeout fired before the first `Actor.create` resolved), not a
> property of the design. A caller that retries a timed-out batch without
> `overwrite` is relying on `flags.wodchar.sourceId` idempotency to save it — and
> per Item 2 it has no way to verify that the flag was actually stamped.

**Proposed change.**

- **1a — Server-side chunking (server-only).** `handleImportActor` splits `docs`
  into sub-batches of `batchSize` (default 1) and issues one
  `foundry-mcp-bridge.importActors` query per sub-batch, concatenating
  `results`. Default 1 is deliberate: it makes the _observed-good_ path the
  default and makes each query's duration independent of the requested batch
  size. Callers who know their world is fast can raise it.
- **1b — Configurable query timeout (server-only).** Add
  `foundry.queryTimeout` to `ConfigSchema` (`config.ts:7-53`) with env
  `FOUNDRY_QUERY_TIMEOUT`, following the `connectionTimeout` pattern exactly
  (`config.ts:18` + `config.ts:68`); add an optional third parameter
  `query(method, data?, timeoutMs?)` to `FoundryConnector.query`
  (`foundry-connector.ts:359`) and `FoundryClient.query` (`foundry-client.ts:57`),
  defaulting to the config value, defaulting _that_ to the current 10 000 so
  nothing changes for existing callers. `import-actor.ts` passes a longer
  per-query timeout.
- **1c — Per-actor results survive failure (module deploy).** Wrap each loop
  iteration of `data-access.ts:9873-9950` in `try/catch` and push
  `{ name, id: null, status: 'failed', error }` instead of throwing, unless a
  new `stopOnError: true` is passed. Move the per-doc `name`/`type`/`system`
  validation out of the abort-the-batch loop in `queries.ts` and into the same
  per-actor result. Add `counts: { created, updated, skipped, failed }` to the
  return.
- **1d — Documented ceiling (docs-only).** Whatever the defaults, the tool
  description states the tested envelope: one actor of ~50 KB per query;
  `batchSize` above 1 is opt-in.

**Deliberately not proposed:** a cancel/abort message to the Foundry side.
Foundry's `CONFIG.queries` contract gives the module no abort hook, and
`Actor.create` is not cancellable. Chunking to 1 makes the blast radius of an
un-cancellable in-flight write exactly one actor, which is the achievable fix.

---

### Item 2 — An actor's `flags` are not readable through any tool

**Observed.** Idempotency for import keys entirely off
`flags.wodchar.sourceId`. No read tool returns `flags`. The only way to answer
"does this actor already carry sourceId X?" was to fire
`worldofdarkness-import-actor` with `overwrite: false` and check whether the
result said `skipped` — i.e. using a **write** path as a read probe, on a
production world.

**Root cause.** `DataAccess.getCharacterInfo` (`data-access.ts:1681`) builds an
explicit allow-list of fields — `id`, `name`, `type`, `img`, `system`, `items`,
`effects`, plus PF2e extras (`data-access.ts:1699-1734`). `flags` is not in it,
at either the actor or the item level (`data-access.ts:1705-1713`). The local
`CharacterInfo` interface (`data-access.ts:5-17`) has no `flags` field either.
`findActor` (`data-access.ts:7069`) returns `{ id, name }` only.
`worldofdarkness-get-sheet` cannot recover it: it calls `findActor` then
`getCharacterInfo` then `extractFullSheet` (`get-sheet.ts:70-85`), and
`extractFullSheet` (`extract.ts:179-199`) returns a curated sheet that includes
neither `flags` nor even the actor `id`.

Note the extra trap this creates for anyone tempted to fix it in the module:
flags under the `wodchar` scope **must** be read by raw property access, never
`actor.getFlag('wodchar', …)`, because `getFlag` throws for a scope that is not
core / the system id / the world id / an active module id. The existing code
documents and does this correctly at `data-access.ts:9851-9864`; a new read path
must copy that approach.

**Proposed change (module deploy + server).**

- **2a** Add an optional `include` array to `getCharacterInfo`'s query payload.
  When it contains `flags`, attach `flags: this.sanitizeData(actor.flags)`
  (read via `foundry.utils.getProperty`, per `data-access.ts:9857`). Absent
  `include`, the response shape is byte-identical to today.
- **2b** Add `flags` to the local `CharacterInfo` interface in **both** packages
  (see §1.1).
- **2c** Surface it on `worldofdarkness-get-sheet` via a new `include`
  parameter (§4.3) that is threaded down and merged into the returned `sheet`
  as `sheet.flags`.
- **2d** Also surface `sheet.id` unconditionally. Its absence
  (`extract.ts:194-198`) forces a second `findActor` round-trip for anything
  that wants to act on the actor it just read, and adding a field to an object
  breaks no client.

---

### Item 3 — Art paths (`img`, `prototypeToken.texture.src`) are not readable either

**Observed.** After re-importing with `overwrite: true`, there was no way to
confirm the portraits and token art survived. `list-characters` returns no image
information beyond a boolean. `get-character` and `worldofdarkness-get-sheet`
return no path. The only route to a real path was `get-token-details`
(`tools/token-manipulation.ts:133`) on a token that happened to be **placed on a
scene** — structurally impossible for an actor with no token, which is most
imported actors.

**Root cause — and it is cheaper to fix than it looks.** The module already
sends the actor's `img`. It is dropped by the **server-side formatters**:

| Site                       | Code                                              | Effect                                                      |
| -------------------------- | ------------------------------------------------- | ----------------------------------------------------------- |
| `data-access.ts:1703`      | `...(actor.img ? { img: actor.img } : {})`        | module **does** send `img`                                  |
| `data-access.ts:3713-3720` | `listActors()` returns `{ id, name, type, img? }` | module **does** send `img`                                  |
| `character.ts:452`         | `hasImage: !!actor.img`                           | `list-characters` throws the path away                      |
| `character.ts:795`         | `hasImage: !!characterData.img`                   | `get-character` throws the path away                        |
| `extract.ts:194-198`       | returns `{...base, capabilities, allItems}`       | `worldofdarkness-get-sheet` emits **no** image field at all |

So exposing the actor **`img`** is a **server-only** change in three formatters
— no module deploy. `prototypeToken` is genuinely absent from the module payload
and does need a module change.

`hasImage` is also actively misleading, exactly as the framing states:
`!!entity.img` is `true` for Foundry's default `icons/svg/mystery-man.svg`, so
"has an image" answers a question nobody asked. The same pattern is repeated in
six system adapters (`systems/*/adapter.ts`) and in `compendium.ts:468`,
`compendium.ts:846`, `scene.ts:156`, `character.ts:395`.

> **Partial disagreement with the framing.** The framing says `get-character`
> and `worldofdarkness-get-sheet` "return only `hasImage`". `get-character` does.
> `worldofdarkness-get-sheet` returns _nothing at all_ about art — it is one step
> worse, not equal. It is also the tool a WoD caller would naturally reach for.

**Proposed change.**

- **3a (server-only)** Add `img: <string | undefined>` **alongside** the existing
  `hasImage` in `list-characters` (`character.ts:448-453`) and `get-character`
  (`character.ts:786-796`).
- **3b (server-only)** Add `img` and `isDefaultImg` to the WoD sheet in
  `extract.ts:194-198`, where `isDefaultImg` is
  `!img || img === 'icons/svg/mystery-man.svg'`. This is the _meaningful_
  version of `hasImage`, under a new name, so no existing field changes meaning.
- **3c (module deploy)** Add `prototypeToken` to the `include`-gated portion of
  `getCharacterInfo` (same mechanism as 2a), and surface
  `sheet.prototypeToken.texture.src` (plus `scale`, `ring` if present).
- **3d (server-only, non-breaking deprecation)** Keep `hasImage` emitting exactly
  what it emits today. Mark it deprecated in the tool descriptions only. Do not
  redefine it — see §5.

---

### Item 4 — No way to look an actor up by `sourceId`

**Observed.** An importer that wants "create if absent, otherwise report the
Foundry id" has no read path. Mapping six external ids to six Foundry actor ids
required a full `list-characters` dump and matching on **name**, which is
neither unique nor stable.

**Root cause.** The reverse index exists but is private to the write path:
`findBySourceId` is a local closure inside `DataAccess.importActors`
(`data-access.ts:9858-9864`) and is never registered as a query.
`findActor` (`data-access.ts:7069`) matches id or name only.

**Proposed change (module deploy + new server tool).** A read-only
`worldofdarkness-find-actors` tool over a new
`foundry-mcp-bridge.findActorsByFlag` query. Filter on a flag path + value, so
the same query serves `wodchar.sourceId` and any future scope, rather than
hardcoding one key. Returns `{ id, name, type, img, folder, flags }` per match.
Deliberately plural: a duplicated `sourceId` is a real failure mode the caller
needs to see rather than have silently collapsed to `find()`'s first hit — note
that `data-access.ts:9859` uses `find()`, so today a duplicate sourceId means
one of the two actors is permanently unreachable by import.

This also lets `worldofdarkness-import-actor` gain a **`dryRun: true`** mode:
resolve each doc's sourceId against the world and report the would-be
`created`/`updated`/`skipped` verdict **without writing**, which is the read
probe Item 2's workaround was faking.

---

### Item 5 — Embedded item creation

> **Disagreement with the framing — the premise is factually wrong as stated.**
> The framing says embedded items "can be updated and deleted but never
> created", and that a small in-place repair "forces a full actor re-import".
> Two existing paths already create embedded items on an actor:
>
> 1. **`manage-world-items` with `action: "add-to-actor"`** —
>    `character.ts:161`, dispatched at `character.ts:682` to
>    `handleAddActorItems`, which calls the module's
>    `foundry-mcp-bridge.addActorItems`. It accepts a free-form
>    `items[].system` object (`character.ts:183-188`), so an arbitrary Ability
>    item with arbitrary system data **is** creatable today. GM-only.
> 2. **`worldofdarkness-add-items`** — `tools/worldofdarkness/add-items.ts`,
>    which hits the same `addActorItems` query (`add-items.ts:173`). This one is
>    restricted: every item must resolve by name against the
>    `wod20-compendium-es` Item packs, all-or-nothing
>    (`add-items.ts:112-152`), so it genuinely cannot create an item that no
>    pack contains.
>
> The real defect is **discoverability and surface symmetry**, not absence.
> `manage-actors` advertises `update-items` and `delete-items`
> (`actor-management.ts:62`) and mentions the create path only in a source
> comment the agent never sees (`actor-management.ts:10`: _"Adding items is
> handled by manage-world-items → add-to-actor"_). An agent that correctly
> reaches for `manage-actors` to repair embedded items on an actor finds two
> thirds of CRUD and reasonably concludes create is impossible. That is exactly
> what happened. Reframed this way the fix is still worth doing, and it is
> nearly free.

**Proposed change (server-only).** Add `create-items` to `manage-actors` as a
**thin alias** that forwards to the existing `foundry-mcp-bridge.addActorItems`
query — the same one `manage-world-items → add-to-actor` and
`worldofdarkness-add-items` already use. No module change, no new module query,
no second code path to keep in sync. Plus:

- Amend the `manage-actors` description to name the sibling tool explicitly for
  the case it does not cover.
- Amend the `worldofdarkness-add-items` description to say what to do when a
  name resolves in no pack — currently it returns
  `Could not resolve item "X" … nothing was added` with no forward pointer, and
  the WoD case that motivated this item (an Ability item a splat template does
  not seed, and which no pack contains) lands exactly there.

---

### Item 6 — Large payloads must be inlined into the tool call

**Observed.** A faithful WoD actor document is ~47 KB. Six is ~282 KB the agent
must emit verbatim into a tool call — expensive, and a silent-corruption risk,
since a single mistyped character inside a `system` blob produces a
structurally valid document with wrong data and no error. The workaround was to
bypass the agent: drive the MCP server directly over stdio from a script that
read the documents from disk.

**Root cause.** `actorDocSchema` (`import-actor.ts:16-29`) accepts only inline
objects. There is no reference/indirection form. This is a deliberate and
correct default — but it makes the _only_ way to import a faithful actor "have
the model retype it".

**Proposed change (server-only).** Accept `actorPaths: string[]` (and singular
`actorPath`) on `worldofdarkness-import-actor`. The MCP server reads and
`JSON.parse`s each file, then feeds the results through the **existing**
`actorDocSchema` — the parsed object is validated identically to an inline one,
so there is exactly one validation path. Precedent for `fs` in the server
package: `comfyui-client.ts:2`, `lock.ts:9`, `backend.ts:1`.

**Security boundary — this must not become an arbitrary-file-read primitive.**
The server runs as the user, and the argument comes from a model, so a naive
implementation lets prompt-injected text name `~/.ssh/id_rsa` and get its bytes
back in an error message or an actor's biography field. Constraints, all
mandatory:

| Constraint           | Rule                                                                                                                                                                                                                                                |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Allow-list root      | Resolve against a single configured directory, `wod.importDir` (§4.2). If unset, `actorPaths` is **rejected** — opt-in, no implicit default root.                                                                                                   |
| No escape            | `path.resolve` then `fs.realpath`, then require the result to be inside the realpath'd root. Rejects `..`, absolute paths outside the root, and symlinks pointing out.                                                                              |
| Extension            | `.json` only.                                                                                                                                                                                                                                       |
| Size cap             | Reject files over a configured `wod.importMaxBytes` (default 2 MiB).                                                                                                                                                                                |
| No directory listing | No globs, no recursion, no "read the whole folder". One named file per entry.                                                                                                                                                                       |
| Error hygiene        | On any failure return only the **relative** path and a fixed reason (`not found` / `outside importDir` / `too large` / `invalid JSON` / `schema: <field>`). Never echo file contents or absolute paths. Never confirm existence of a rejected path. |

The natural root is a staging directory under the Foundry data dir, e.g.
`<dataDir>/wod20-import/<slug>.json`. `getFoundryDataDir()`
(`utils/platform.ts:49-67`) and the existing `foundry.dataPath` config already
give a canonical anchor; the module has FilePicker upload/browse precedent for
the same directory (`queries.ts:1288-1310`) if a future variant ever needs the
module to read it instead.

> **Honest limit of this fix.** Reading server-side removes the _agent's_ token
> cost and the retyping-corruption risk. It does **not** shrink what crosses the
> bridge to Foundry — the full document still travels as an `mcp-query`. Item 6
> therefore does not mitigate Item 1, and shipping it without Item 1 would make
> oversized batches _easier_ to request and just as likely to time out. Ship
> Item 1 first (see §6).
>
> One further caveat: with `foundry.remoteMode: true` the MCP server need not be
> the machine the caller is on, so `actorPaths` resolves on the _server's_ disk.
> The tool description must say so, and `wod.importDir` being unset by default
> means a remote deployment does not silently expose a path surface.

---

## 3. Priority ranking

Ranked by **caller pain ÷ implementation cost**, with one override: anything
that can silently corrupt production state outranks convenience regardless of
the ratio. Cost is dominated by _which package changes_ (§1.5) — a server-only
change is roughly a third of the effort of one that needs a module deploy and a
world reload, because the module deploy is where the two-deploy staleness trap
lives.

| Rank   | Item                                      | Pain                                            | Cost                                                      | One-line justification                                                                                                                                                                      |
| ------ | ----------------------------------------- | ----------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P0** | **1 — batch timeout / partial results**   | Blocking                                        | Medium, server-only for 1a/1b                             | It is the only item that hard-blocks the task _and_ the only one that can leave production state wrong-and-unobservable (§2 Item 1 disagreement) — the correctness override applies.        |
| **P1** | **3 — expose `img`**                      | High                                            | Near-zero, server-only                                    | Verification is currently impossible for a token-less actor, yet the module already sends `img` and three formatters throw it away — the highest-value single-line change in this document. |
| **P2** | **4 — lookup by `sourceId`**              | High                                            | Medium, module deploy                                     | Turns "probe by attempting a write" into a read, and unlocks `dryRun`, which is the safety net Item 1 needs; costs one module deploy, so it should carry Item 2 along with it.              |
| **P3** | **2 — expose `flags`**                    | Medium                                          | Low **if bundled with P2**                                | Same module deploy, same `include` mechanism, and it is what makes P0's idempotency auditable rather than assumed — cheap as a rider, poor value as a solo deploy.                          |
| **P4** | **5 — `create-items` on `manage-actors`** | Low (a working path already exists — §2 Item 5) | Near-zero, server-only alias                              | Pure discoverability, but it forwards to an existing query and costs one dispatch case, so the ratio still beats P5.                                                                        |
| **P5** | **6 — path/reference intake**             | High token cost, but fully worked around        | High: new security surface, config, path-validation tests | The most expensive item, the only one that adds an attack surface, and the one with a proven workaround (stdio script) — and it is actively _harmful_ to ship before P0.                    |

Rationale for the two rankings that look counter-intuitive:

- **3 above 4** despite 4 being the more architecturally interesting fix: Item 3
  is server-only and Item 4 is not. Item 3 can be in the caller's hands the same
  hour; Item 4 waits on a module build, a copy to the data dir, and a world
  reload.
- **6 last** despite being the item that cost the most tokens today: it is the
  only item whose failure mode is a security incident rather than an inconvenience,
  and it is the only one where the workaround already used in production is
  genuinely fine. Rushing it is the worst available trade.

---

## 4. Proposed schema changes

### 4.1 `worldofdarkness-import-actor` — new input fields

All additive and optional. Existing calls parse and behave identically.

| Field         | Type     | Req | Default                | Validation                                                                             |
| ------------- | -------- | --- | ---------------------- | -------------------------------------------------------------------------------------- |
| `actor`       | object   | ❌  | —                      | _unchanged_ — `actorDocSchema` (`import-actor.ts:16-29`)                               |
| `actors`      | object[] | ❌  | —                      | _unchanged_ — non-empty when present                                                   |
| `folder`      | string   | ❌  | —                      | _unchanged_ — `min 1`                                                                  |
| `overwrite`   | boolean  | ❌  | `false`                | _unchanged_                                                                            |
| `actorPath`   | string   | ❌  | —                      | non-empty; `.json`; resolved inside `wod.importDir`; rejected if `wod.importDir` unset |
| `actorPaths`  | string[] | ❌  | —                      | 1–50 entries; each validated as `actorPath`                                            |
| `batchSize`   | int      | ❌  | `1`                    | 1–10; actors per underlying `importActors` query                                       |
| `stopOnError` | boolean  | ❌  | `false`                | `true` restores today's abort-on-first-failure behaviour                               |
| `dryRun`      | boolean  | ❌  | `false`                | resolve + report verdicts, write nothing (requires Item 4)                             |
| `timeoutMs`   | int      | ❌  | `foundry.queryTimeout` | 1 000–600 000; per-query override, threaded into `query(method, data, timeoutMs)`      |

Refinement (replaces the current `.refine` at `import-actor.ts:38-40`): exactly
one _category_ of source must be present — inline (`actor`/`actors`) **or** path
(`actorPath`/`actorPaths`). Mixing them is rejected with an explicit message
rather than silently concatenated, so a caller can never half-import from the
wrong source.

**Response shape** (additive — `success`, `total`, `results` keep their meaning
and position; `results[]` entries gain fields, existing ones unchanged):

```typescript
{
  success: true,
  total: number,                        // unchanged: results.length
  results: Array<{
    name: string,
    id: string | null,
    status: 'created' | 'updated' | 'skipped' | 'failed' | 'would-create'
          | 'would-update' | 'would-skip',   // 'failed' + dryRun verdicts are new
    folder: string | null,
    sourceId?: string,                       // new: the key actually stamped
    error?: string,                          // new: present iff status === 'failed'
  }>,
  counts: { created: number, updated: number,   // new
            skipped: number, failed: number },
  batches: { total: number, completed: number },// new: visible progress on partial failure
  dryRun?: true,                                // new: present only when dryRun
}
```

On a mid-batch timeout the tool now returns `success: true` with a `counts.failed`
tally and `batches.completed < batches.total`, instead of a bare
`{ success: false, error: 'Query timeout: …' }`. A `success: false` is reserved
for "nothing was attempted" (schema failure, no GM, no connection).

### 4.2 New config fields (`packages/mcp-server/src/config.ts`)

Follows the `connectionTimeout` precedent exactly — a Zod field in
`ConfigSchema` (`config.ts:7-53`) plus a `process.env` read in `rawConfig`
(`config.ts:55-92`).

| Field                  | Type   | Req | Default   | Env var                 | Validation                                                                              |
| ---------------------- | ------ | --- | --------- | ----------------------- | --------------------------------------------------------------------------------------- |
| `foundry.queryTimeout` | number | ❌  | `10000`   | `FOUNDRY_QUERY_TIMEOUT` | `min(1000).max(600000)`                                                                 |
| `wod.importDir`        | string | ❌  | _unset_   | `WOD_IMPORT_DIR`        | absolute path; must exist and be a directory at first use; unset ⇒ path intake disabled |
| `wod.importMaxBytes`   | number | ❌  | `2097152` | `WOD_IMPORT_MAX_BYTES`  | `min(1024).max(33554432)`                                                               |

`foundry.queryTimeout` defaults to `10000` so behaviour is bit-identical until
someone sets the env var. The dead `foundry.connectionTimeout` (§1.3) is left
alone — repurposing it would silently change the meaning of an env var users may
already have set.

### 4.3 `worldofdarkness-get-sheet` — new input field

| Field     | Type     | Req | Default | Validation                                       |
| --------- | -------- | --- | ------- | ------------------------------------------------ |
| `actor`   | string   | ✅  | —       | _unchanged_ — `min 1`, name or 16-char id        |
| `include` | string[] | ❌  | `[]`    | each of `flags` \| `prototypeToken` \| `itemIds` |

Note `getSheetSchema` is currently `.strict()` (`get-sheet.ts:13-17`), so adding
the key is required before any caller can pass it — today it would be rejected.

**Response additions to `sheet`** (all additive):

| Field            | Type                | When                          | Notes                                                                                                                                                                      |
| ---------------- | ------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`             | string              | always                        | Item 2d — removes a redundant `findActor` round-trip                                                                                                                       |
| `img`            | string \| undefined | always                        | Item 3b — the real path                                                                                                                                                    |
| `isDefaultImg`   | boolean             | always                        | Item 3b — the _meaningful_ `hasImage`                                                                                                                                      |
| `flags`          | object              | `include: ['flags']`          | read via raw property access, per `data-access.ts:9851-9864`                                                                                                               |
| `prototypeToken` | object              | `include: ['prototypeToken']` | `{ texture: { src, scaleX, scaleY }, ring? }`                                                                                                                              |
| `allItems[].id`  | string              | `include: ['itemIds']`        | `extractFullSheet` currently drops item ids (`extract.ts:186-191`), so its output cannot feed `update-items` / `delete-items` — a caller must re-fetch via `get-character` |

### 4.4 New tool: `worldofdarkness-find-actors` (Item 4)

Read-only. Layer 1 file: `packages/mcp-server/src/tools/worldofdarkness/find-actors.ts`,
matching the existing WoD file naming (`get-sheet.ts`, `add-items.ts`, …).

| Field      | Type     | Req | Default              | Validation                                                                        |
| ---------- | -------- | --- | -------------------- | --------------------------------------------------------------------------------- |
| `flagPath` | string   | ❌  | `'wodchar.sourceId'` | dotted path, `/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)+$/`; scope + key, max 4 segments |
| `values`   | string[] | ❌  | —                    | 1–100 entries; exact match, any-of                                                |
| `exists`   | boolean  | ❌  | —                    | `true` ⇒ any actor carrying the flag at all                                       |
| `type`     | string   | ❌  | —                    | optional actor-type filter, mirroring `list-characters`                           |

Refinement: exactly one of `values` / `exists` must be present.

**Response:**

```typescript
{
  success: true,
  matches: Array<{
    id: string,
    name: string,
    type: string,
    img: string | undefined,
    folder: string | null,
    flagValue: string,
  }>,
  total: number,
  duplicates: string[],   // flag values matched by >1 actor — see §2 Item 4
  unmatched: string[],    // requested values with no actor (only when `values` given)
}
```

`unmatched` is what makes the tool usable as an existence probe: an importer
sends its six sourceIds and gets back exactly which need creating.

### 4.5 `manage-actors` — new `create-items` action (Item 5)

| Field             | Type     | Req                   | Default | Validation                                                                                                                                                              |
| ----------------- | -------- | --------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `action`          | enum     | ✅                    | —       | add `'create-items'` to the enum at `actor-management.ts:62` and the `z.enum` at `actor-management.ts:193`                                                              |
| `actorIdentifier` | string   | ✅ for `create-items` | —       | `min 1`; name or id — same field `update-items`/`delete-items` already use (`actor-management.ts:150-153`)                                                              |
| `items`           | object[] | ✅ for `create-items` | —       | `min 1`; each `{ name: string(min 1), type: string(min 1), img?: string, system?: record }` — identical to the `manage-world-items` item shape (`character.ts:165-192`) |

Dispatch: a new `case 'create-items'` in `handleManageActors`
(`actor-management.ts:197-210`) → a `handleCreateItems` that forwards to
`foundry-mcp-bridge.addActorItems` with `{ actorIdentifier, items }`, the exact
payload `add-items.ts:173` already sends. Apply `adapter.normalizePayload` to
each `system` if the adapter provides it, matching `handleCreate`
(`actor-management.ts:244-249`).

### 4.6 Module-side query contract changes (module deploy)

| Query                                 | Change                                                                                                                                                                 | Compatibility                                                                                                                                                        |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `foundry-mcp-bridge.getCharacterInfo` | Accept optional `include: string[]`; attach `flags` / `prototypeToken` when requested                                                                                  | Additive. Absent `include`, response is unchanged — an old server talking to a new module is unaffected                                                              |
| `foundry-mcp-bridge.importActors`     | Accept `stopOnError`, `dryRun`; per-actor `try/catch`; return `counts`                                                                                                 | Additive. Defaults reproduce today's behaviour except that a single bad actor no longer aborts the batch — **the one intentional behaviour change**, justified in §5 |
| `foundry-mcp-bridge.findActorsByFlag` | **New.** Registered in `registerHandlers()` alongside `queries.ts:132`; GM check via `validateGMAccess()` then `validateFoundryState()`, matching `handleImportActors` | New method name — a **new server against an old module** gets an unregistered-query error. See §5                                                                    |
| `foundry-mcp-bridge.addActorItems`    | **No change** — reused as-is by `create-items`                                                                                                                         | —                                                                                                                                                                    |

---

## 5. Backward compatibility

Every change in this spec is additive. Concretely:

**New optional input fields only.** No field is removed, renamed, retyped, or
made required. `importActorSchema` is `.passthrough()` on the doc
(`import-actor.ts:29`) and non-strict at the top level, so old calls keep
parsing. The one schema that must be _loosened_ rather than extended is
`getSheetSchema`, which is `.strict()` (`get-sheet.ts:13-17`) — adding `include`
to it is still purely additive for callers that omit it.

**New response fields only.** Existing keys keep their names, types, and
meanings. New keys are appended.

**`hasImage` — the field this spec is most tempted to change, and will not.**
`hasImage: !!entity.img` (`character.ts:395`, `:452`, `:795`, plus
`compendium.ts:468`, `:846`, `scene.ts:156`, and six `systems/*/adapter.ts`) is
misleading: the Foundry default `icons/svg/mystery-man.svg` makes it `true`.
Redefining it to mean "has a _non-default_ image" would be a silent semantic
break — any client branching on it would flip behaviour with no type error, no
schema change, and no version bump to notice. Rejected. Instead:

1. `img` is added next to `hasImage`, carrying the real value.
2. `isDefaultImg` is added as the correctly-named boolean.
3. `hasImage` keeps emitting `!!img` **forever** in the current tools, and is
   marked deprecated in tool _descriptions_ only.
4. No **new** tool or response emits `hasImage`. `worldofdarkness-find-actors`
   returns `img`; the WoD sheet returns `img` + `isDefaultImg`.

The same reasoning bars "just make `get-character` return `system.flags`" or
"just always include `prototypeToken`": unconditionally fattening
`getCharacterInfo` inflates every existing caller's response against the
20 000-char `toolResponseMaxChars` truncation (`config.ts:48`) and could silently
truncate data callers depend on today. Hence the `include` opt-in.

**The one intentional behaviour change**, called out explicitly: with Item 1c, a
batch containing one invalid actor currently fails entirely and will instead
succeed partially with `status: 'failed'` on that entry. A caller that treats
`success: true` as "all actors imported" would be wrong. Mitigations: (a)
`stopOnError: true` restores the old semantics exactly; (b) `counts.failed` and
`batches` make the partial outcome unmissable in the response; (c) the tool
description states that `success: true` means "the batch ran", not "everything
succeeded". This trade is worth making because the current behaviour is the
thing that produced an unactionable error today.

**Version skew across the two deploys** (§1.5) is the real compatibility hazard,
and it is asymmetric:

- _New server, old module._ Server-only items (1a, 1b, 3a, 3b, 5, 6) work
  unchanged — they either stay inside the server or use queries the old module
  already has. `include`-gated fields silently come back absent, which degrades
  cleanly. `findActorsByFlag` fails loudly with an unregistered-query error,
  which is the correct outcome; the tool description should name the minimum
  module version.
- _Old server, new module._ Everything is unchanged, because every module change
  is gated on a parameter an old server never sends.

Therefore: **bump `packages/foundry-module/module.json` `version`** (currently
`0.9.0`) on the module deploy, and have the server log a warning when a
module-gated feature is requested and the response lacks the expected key.

---

## 6. Staged implementation plan

Stages are ordered so that **no stage can be shipped in an order that makes
things worse** — in particular Item 6 cannot precede Item 1.

### Stage A — "stop the bleeding", server-only, no module deploy

Items **1a, 1b, 3a, 3b, 5**.

| Change                                                             | File                                                     |
| ------------------------------------------------------------------ | -------------------------------------------------------- |
| Chunking + `batchSize` + result concatenation + `counts`/`batches` | `tools/worldofdarkness/import-actor.ts`                  |
| `foundry.queryTimeout` + `query(method, data, timeoutMs?)`         | `config.ts`, `foundry-connector.ts`, `foundry-client.ts` |
| `img` alongside `hasImage`                                         | `tools/character.ts:448-453`, `:786-796`                 |
| `img` + `isDefaultImg` on the WoD sheet                            | `systems/worldofdarkness/extract.ts:194-198`             |
| `create-items` action + dispatch                                   | `tools/actor-management.ts`                              |

**Testable against:** re-run today's exact failing call — six actors, ~305 KB —
and it must return per-actor results instead of a timeout, with
`batches.total === 6` at the default `batchSize: 1`. Then
`worldofdarkness-get-sheet` on each imported actor must return the real portrait
path, and `list-characters` must include `img`. Unit-level: `import-actor`
chunking with a mocked `foundryClient.query` (3 actors + `batchSize: 2` ⇒ 2
queries, results concatenated in order); one query rejecting ⇒ 2 `failed`
entries, not a thrown error. `hasImage` must still be present and unchanged in
every existing test fixture — that assertion is the guard for §5.

### Stage B — "make the import auditable", module deploy

Items **2, 3c, 4, 1c**.

| Change                                         | File                                                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `include`-gated `flags` + `prototypeToken`     | `foundry-module/src/data-access.ts:1699-1734`, `queries.ts`                                 |
| `CharacterInfo.flags` in both packages         | `data-access.ts:5-17` and the server-side counterpart                                       |
| New `findActorsByFlag` query                   | `queries.ts` (register near `:132`), `data-access.ts` (promote the closure at `:9858-9864`) |
| Per-actor `try/catch`, `stopOnError`, `counts` | `data-access.ts:9873-9952`; move per-doc validation out of `queries.ts`'s abort loop        |
| New `worldofdarkness-find-actors` tool         | `tools/worldofdarkness/find-actors.ts` + 4 touch points in `backend.ts`                     |
| `include` on the WoD sheet                     | `tools/worldofdarkness/get-sheet.ts`, `systems/worldofdarkness/extract.ts`                  |
| `module.json` version bump                     | `foundry-module/module.json:5`                                                              |

**Testable against:** `worldofdarkness-find-actors` with the six known
sourceIds must return six matches with the right Foundry ids and an empty
`unmatched` — cross-checked against the ids recorded from Stage A's import.
`worldofdarkness-get-sheet` with `include: ['flags']` must show
`flags.wodchar.sourceId` matching the source document, and the `getFlag`
regression must be covered: assert the read path never calls
`actor.getFlag('wodchar', …)` (which throws for an unregistered scope —
`data-access.ts:9851-9856`). A batch with one deliberately malformed actor must
yield 5 × `created` + 1 × `failed`, and `stopOnError: true` must restore the
old all-or-nothing outcome. Verify old-server/new-module skew by calling
`getCharacterInfo` with no `include` and diffing the response against a
pre-change fixture byte-for-byte.

### Stage C — "cheap to ask for", server-only, gated on Stage A

Item **6**, plus `dryRun` (which needs Stage B's lookup).

| Change                                                                  | File                                                                     |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `wod.importDir` / `wod.importMaxBytes`                                  | `config.ts`                                                              |
| Path resolution + allow-list guard                                      | new `utils/import-paths.ts`                                              |
| `actorPath` / `actorPaths` intake feeding the existing `actorDocSchema` | `tools/worldofdarkness/import-actor.ts`                                  |
| `dryRun` verdicts                                                       | `tools/worldofdarkness/import-actor.ts` (+ Stage B's `findActorsByFlag`) |

**Testable against:** the path guard is the deliverable and needs adversarial
unit tests, not a happy path — `../../../etc/passwd`, an absolute path outside
the root, a symlink inside the root pointing outside it, a `.json.txt`
extension, a 3 MiB file, a directory passed as a file, a path containing a NUL
byte, and `actorPaths` with `wod.importDir` unset (must reject, not fall back to
a default root). Each must fail with a fixed reason string that contains neither
file contents nor an absolute path. End-to-end: stage the six documents in
`<dataDir>/wod20-import/`, import by path, and diff the resulting actors against
the Stage A import — they must be identical, proving the two intake routes share
one validation path.

### Build verification (all stages)

Per the precedent spec's §5, adjusted for the absent `shared` package (§1.1):

```bash
cd packages/mcp-server     && node_modules/.bin/tsc --noEmit   # Stages A, C
cd packages/foundry-module && node_modules/.bin/tsc --noEmit   # Stage B
```

---

## 7. Non-goals

- **Cancelling in-flight Foundry work on timeout.** No abort hook exists in
  Foundry's `CONFIG.queries` contract and `Actor.create` is not cancellable
  (§2 Item 1). Chunking to one actor per query bounds the damage instead; the
  underlying gap is documented, not fixed.
- **Transactional / all-or-nothing batch import.** `transactionManager` exists
  (`data-access.ts:3`) but rolling back a partially created multi-actor import
  including embedded items is a much larger design. Per-actor idempotency via
  `flags.wodchar.sourceId` plus `dryRun` is the substitute.
- **Redefining or removing `hasImage`.** Explicitly rejected in §5.
- **Generalising `flags`/`sourceId` reads to non-WoD systems.**
  `worldofdarkness-find-actors` is WoD-namespaced by convention even though
  `findActorsByFlag` is system-agnostic; a generic `find-actors` tool is a
  separate proposal.
- **Server-side rendering, resizing, or validating that `img` paths exist on
  disk.** This spec exposes the stored path; it does not verify the file
  resolves. Token art generation stays with `foundtyvtt-token-creator`.
- **Streaming or progress-push over the bridge.** `batches.completed` in the
  final response is the progress mechanism; a real progress channel would need a
  new message type on both sides.
- **Writing `flags` through any tool.** All flag work here is read-only, except
  the `sourceId` stamping `importActors` already does (`data-access.ts:9885-9888`).
- **Fixing the six `systems/*/adapter.ts` copies of the `hasImage` pattern.**
  Out of scope; noted in §2 Item 3 only so the deprecation's true blast radius
  is on record.
- **Repurposing the dead `foundry.connectionTimeout`** (§1.3). It is unused, but
  users may already set `FOUNDRY_CONNECTION_TIMEOUT`; a new key is safer than
  giving an existing one new meaning.

---

## 8. Open questions

1. ~~**Is the WebRTC transport in play in the production deployment?**~~
   **CLOSED — and the question turned out not to need answering.** Chunking was
   implemented **byte-aware**, which is correct under either transport, so the
   design no longer depends on which one production resolves to. Recorded so it
   is not re-derived:
   - `foundry.connectionType` defaults to `'auto'` (`config.ts:19`), so _either_
     transport is reachable in a given deployment without any config change. Any
     count-based scheme would have been correct only by luck.
   - **The server→Foundry direction does not chunk.** `WebRTCPeer.sendMessage`
     (`webrtc-peer.ts:180-192`) is a bare
     `this.dataChannel.send(JSON.stringify(message))` wrapped in a try/catch that
     only calls `logger.error` — it never throws to the caller and never splits.
     Only the **Foundry→server** direction chunks
     (`foundry-module/src/webrtc-connection.ts:206-218`, which does check
     `size > CHUNK_SIZE`). So on a WebRTC deployment an oversized `mcp-query` is
     dropped, the module never receives it, and the caller observes exactly the
     `Query timeout: foundry-mcp-bridge.importActors` reported in Item 1 — with no
     error anywhere except one server-side log line. This asymmetry is a second,
     independent root cause for Item 1 on that transport and is _not_ fixed by
     this change; it is bounded by the byte budget (see below) and left as debt in
     §9.
   - Implemented budget: `DEFAULT_CHUNK_BUDGET_BYTES = WEBRTC_CONSTANTS.CHUNK_SIZE`
     (50 KiB) per query, overridable per call via `chunkBytes` (max
     `MAX_MESSAGE_SIZE`, 64 KiB). A single document is indivisible, so one over
     budget is sent alone; if it also exceeds `MAX_MESSAGE_SIZE` **and** the active
     transport is WebRTC, the request is refused before any write, naming the
     ceiling. On WebSocket it is not refused, because `ws`'s 100 MiB default means
     it works there today and refusing would be a regression.

> ### SUPERSEDED — the paragraph immediately above, and the transport asymmetry it rests on
>
> **`lift-bridge-per-document-size-ceiling` replaces all of it.** Kept for the
> record of why the refusal existed, not as a description of current behaviour.
> What changed, in one place —
> [`transport-wire-format.md`](transport-wire-format.md) is now the single live
> description:
>
> - **Compressed JSON is the bridge wire format.** Every `mcp-query` /
>   `mcp-response` travels gzipped inside a `compressed-message` envelope once the
>   module advertises `transport.compression.gzip`. Real WoD actor documents
>   compress 6.9x–12.5x, so the ~97 KB document this section refused now fits one
>   frame with ~4x headroom.
> - **`chunkBytes` is no longer bounded by `MAX_MESSAGE_SIZE`.** Its max is
>   `MAX_CHUNK_BUDGET_BYTES` (1 MiB) and its only justification is wall-clock:
>   transport size stopped being a reason to chunk.
> - **The `connectionType === 'webrtc'` size refusal is deleted.** What remains is
>   a refusal on the **measured compressed** size of the message that would
>   actually be sent — never a ratio applied to an uncompressed size.
> - **The silent send is fixed.** `WebRTCPeer.sendMessage` re-throws and the
>   pending query rejects at once, so an undeliverable message no longer surfaces
>   a deadline later as `Query timeout`.
> - **The asymmetry itself is unchanged and still recorded as debt:** the
>   server→Foundry direction still does not fragment. Compression made that
>   unnecessary for every realistic payload rather than fixing it; the designed
>   backstop and its trigger are in
>   [`transport-wire-format.md`](transport-wire-format.md).

2. **Should `batchSize` default to 1 or 2?** 1 is provably safe from today's
   evidence; 2 halves the round-trips. Needs one timing measurement of a
   single-actor `importActors` on the production world to decide.
3. **Should `dryRun` live on `worldofdarkness-import-actor` or only on
   `worldofdarkness-find-actors`?** `find-actors` + `unmatched` already answers
   "what exists". `dryRun` adds "and what would the verdict be, including the
   `overwrite` interaction" — worth it only if callers actually need the verdict
   rather than the existence bit.
4. **`wod.importDir` default.** Unset (opt-in) is the safe choice and what §4.2
   specifies. Worth confirming nobody expects a working default, because "it
   didn't work until I set an env var" is a real usability cost paid for a real
   security gain.

---

## 9. Known technical debt surfaced but not addressed

Following the precedent spec's §6 — recorded so it is not rediscovered:

- `foundry.connectionTimeout` (`config.ts:18`) is parsed, validated, and never
  read by `foundry-connector.ts`. Dead config with a live env var.
- `foundry-client.ts:33` logs _"Starting Foundry connector socket.io server"_
  while the implementation is a raw `ws` server (`foundry-connector.ts:98`).
  Misleading during debugging.
- `data-access.ts:9859` uses `find()` for the sourceId lookup, so a duplicated
  `sourceId` makes one actor permanently unreachable by import.
  `worldofdarkness-find-actors`'s `duplicates` field exposes the condition; it
  does not prevent it.
- `extractFullSheet` (`extract.ts:186-191`) omits embedded item `id`s, so its
  output cannot feed `update-items` / `delete-items` without a second
  `get-character` call. Item 4.3's `include: ['itemIds']` addresses it only if
  that stage ships.
- A late `mcp-response` arriving after a timeout is dropped with no log
  (`foundry-connector.ts:215-234`), erasing the evidence that the Foundry side
  finished. A `logger.warn` on an unmatched response id would have made Item 1
  diagnosable in minutes.
- **`WebRTCPeer.sendMessage` (`webrtc-peer.ts:180-192`) neither chunks nor
  reports.** It has no `size > CHUNK_SIZE` branch (unlike its module-side
  counterpart, `webrtc-connection.ts:206-218`) and swallows the send failure in a
  `catch` that only logs, so the promise in `query()` is left to time out. On a
  WebRTC deployment any oversized outbound query therefore fails silently. Items 1a
  and the byte budget make the WoD import stay under the cap, but the transport bug
  affects **every** tool with a large payload and is not fixed here. Fixing it means
  porting the module's chunking loop into `sendMessage` and, at minimum, rethrowing
  the send error.

---

## 10. What shipped for Items 2–5 (the read path) — module 0.9.3

Recorded so the sections above are not read as unbuilt design. Items 1 and 6 shipped
earlier (see §8 Q1); Items 2, 3, 4 and 5 shipped here. Where the implementation
diverges from the proposal above, the divergence is stated, not smoothed over.

### As proposed

- **2a / 3c** `getCharacterInfo` takes an optional `include: string[]`
  (`data-access.ts` `getCharacterInfo`, threaded from `queries.ts`
  `handleGetCharacterInfo`). `flags` attaches the sanitized flag object read by RAW
  property access (`readActorFlags`); `prototypeToken` attaches curated token art
  (`extractTokenArt`). Absent `include`, the response is byte-identical to before.
- **2b** `flags` / `prototypeToken` / `included` added to the local `CharacterInfo`
  in the module **and** to `shared/src/types.ts` + `schemas.ts`. The types are
  duplicated, not shared at runtime; each copy carries a mirror warning.
- **2d / 3b** `extractFullSheet` now emits `id`, `img` and `isDefaultImg`
  unconditionally, and `flags` / `prototypeToken` when the payload carries them.
- **3a** `img` + `isDefaultImg` added beside the untouched `hasImage` in
  `list-characters`, `get-character` and `get-character-entity` (`character.ts`),
  and beside `hasImage` in the WoD adapter's `formatCreatureForList`.
- **3d** `hasImage` is unchanged in value and meaning and marked DEPRECATED in the
  `list-characters` / `get-character` descriptions only.
- **4** `worldofdarkness-find-actors` over the new `findActorsByFlag` query
  (`actor-directory.ts`), GM-gated in `queries.ts` like every other actor query.
- **4.3** `get-sheet`'s `.strict()` schema gains `include`, with `itemIds` answered
  entirely server-side.
- **5** `manage-actors` gains `create-items` as a thin alias over the existing
  `addActorItems` query, plus the description fix; the misleading source-only
  comment at the top of `actor-management.ts` now explains itself.

### Divergences from §4

1. **`unmatched` / `duplicates` are computed on the SERVER**, not returned by the
   module. `findActorsByFlag` returns `{ matches, total }` only; `find-actors.ts`
   derives the other two from the matches and the caller's `values`. One
   implementation instead of two, the module stays a dumb lookup, and the
   derivation is unit-testable without a fake Foundry world.
2. **The `include` response carries `included`** — the keys the module actually
   honoured — which §4.6 did not specify. Without it, "no `flags` in the response"
   from an old module is indistinguishable from "this actor has no flags". One is
   a fact about the world; the other is a fact about the deploy.
3. **`prototypeToken` is curated, not passed through whole.** Only
   `texture.{src,scaleX,scaleY}`, `name`, `actorLink` and `ring` — the fields that
   answer "did the token art survive?". The full prototypeToken is mostly vision
   and bar configuration and would dominate the sheet.
4. **`isDefaultImg` lives in one place for every formatter**
   (`utils/actor-art.ts`), not re-derived per call site as §3b's per-tool wording
   implied.
5. **The skew guard was extended beyond `dryRun`.** `get-sheet`'s module-answered
   `include` and `find-actors` are both pre-flighted against `handlePing`'s
   capability list (`getCharacterInfo.include`, `findActorsByFlag`) and REFUSED
   against an older module. A sheet read that quietly omits `flags` would let a
   caller conclude an imported actor carries no `sourceId` — precisely the
   wrong-but-plausible answer the `dryRun` precedent exists to prevent. A plain
   `get-sheet` call (no `include`) still works against any module version and still
   returns `img`.

### Not done, deliberately

- `get-character` was **not** given an `include` for `prototypeToken`. It is the
  generic cross-system read tool; this delta is the WoD surface, and `get-sheet` is
  the tool a WoD caller reaches for (§2 Item 3's own note). Actor `img` is exposed
  there regardless, which is what the token-less-actor scenario needs.
- §9's `find()` debt is unchanged: `find-actors` now REPORTS a duplicated
  `sourceId` in `duplicates`, but the import still resolves to the first hit.
