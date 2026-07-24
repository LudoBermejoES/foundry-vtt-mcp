# `worldofdarkness` MCP integration — implementation notes (Phase 0 discovery)

Ground truth gathered from the fork before writing any code. Both the adapter track and the
bespoke-tools track build against these facts.

## How the fork is wired (verified)

- **MCP entry** `packages/mcp-server/src/index.ts` is a thin stdio wrapper. It proxies
  `list_tools`/`call_tool` to a **backend** over a TCP control channel (127.0.0.1:31414).
  **No changes needed here.**
- **Backend** `packages/mcp-server/src/backend.ts` `startBackend()`:
  - Registers system adapters: `systemRegistry.register(new XAdapter())` (dynamic `import()`s at
    ll.1169-1182). **Add `WorldOfDarknessAdapter` here.**
  - Instantiates each tool class, spreads `...tools.getToolDefinitions()` into `allTools`
    (ll.1415-1446), and dispatches each tool name in a giant `switch (name)` (ll.1510-1755).
    **Add the 7 WoD tool classes + their cases here.**
- **System adapter registry pattern** (`ADDING_NEW_SYSTEMS.md`): 3 files under
  `systems/worldofdarkness/` — `adapter.ts`, `filters.ts`, `index-builder.ts` — plus a barrel
  `index.ts` (mirror `systems/dsa5/index.ts`). Interface: `systems/types.ts` (`SystemAdapter`,
  `IndexBuilder`, `SystemMetadata`, `SystemCreatureIndex`).
- **`SystemId` union** in `systems/types.ts` (l.14) is a closed union. **Add `'worldofdarkness'`
  to it.** Also add a `WoDCreatureIndex` interface + to `AnyCreatureIndex`.
- The 7 generic tools that become WoD-aware once the adapter is registered: `get-character`,
  `list-characters`, `search-compendium`, `list-creatures-by-criteria`, `get-compendium-item`,
  `create-actor-from-compendium`, `list-compendium-packs`.

## Tool-class pattern (mirror `tools/wfrp4e/*.ts`)

```ts
export class WoDRollPoolTools {
  constructor({ foundryClient, logger }) { ... }
  getToolDefinitions() { return [{ name:'worldofdarkness-roll-pool', description, inputSchema }]; }
  async handleRollPool(args) {
    const parsed = schema.safeParse(args); // zod, return {success:false,error} on miss
    return await this.foundryClient.query('foundry-mcp-bridge.<handler>', {...});
  }
}
```

Tool descriptions MUST state `[worldofdarkness only]`. Validate args with zod; return
`{success:false, error}` on bad input rather than throwing.

## Mutation surface — RESOLVED (open Q#1)

The companion Foundry module (`packages/foundry-module/src/queries.ts`) already exposes **generic**
browser-side query handlers. Reuse them via `foundryClient.query('foundry-mcp-bridge.<name>', data)`
— **no new module code** for these:

| Need                                                 | Handler                     | Payload shape                                                     |
| ---------------------------------------------------- | --------------------------- | ----------------------------------------------------------------- |
| Resolve actor by name/id                             | `findActor`                 | `{ identifier }`                                                  |
| Patch actor system fields (health, advantages/pools) | `updateActors`              | `{ updates: [{ id, name?, img?, system }] }` (merges into system) |
| Create a splat actor                                 | `createActors`              | `{ actors: [{ name, type, system }], folder? }`                   |
| Embed items onto an actor                            | `addActorItems`             | `{ actorIdentifier, items: [{ name, type, img?, system? }] }`     |
| Search compendium (Items too)                        | `searchCompendium`          | `{ query, packType?, filters? }` — pass `packType:'Item'`         |
| Enumerate packs                                      | `getAvailablePacks`         | `{}` — dynamic pack discovery                                     |
| Read a compendium doc in full                        | `getCompendiumDocumentFull` | (see actor-creation tool)                                         |
| Read an actor sheet                                  | `getCharacterInfo`          | (see character tool)                                              |

All write handlers do a silent GM-access check. `updateActors`/`addActorItems`/`createActors` are
system-agnostic (`Actor.update` / `createEmbeddedDocuments('Item')` / `Actor.createDocuments`).

### The ONE new module handler required: dice roll → chat

The module has **no** generic "roll a formula now and post to chat" handler (only the interactive
`request-player-rolls` button flow). `worldofdarkness-roll-pool` must post to the world chat log
(spec SHALL), so add ONE minimal handler:

- `packages/foundry-module/src/queries.ts`: register
  `CONFIG.queries[`${modulePrefix}.rollDice`] = this.handleRollDice.bind(this);` (near the wfrp4e
  handlers, l.91) + a `handleRollDice(data)` that calls a new `dataAccess.rollDice(...)`.
- `packages/foundry-module/src/data-access.ts`: `rollDice({ formula, flavor, whisper })` →
  `const roll = new Roll(formula); await roll.evaluate();` then `await roll.toMessage({ flavor,
speaker: ChatMessage.getSpeaker() , ...(whisper? {whisper}: {}) }, { create:true, rollMode: whisper?'gmroll':'publicroll' });`
  Return `{ success:true, total: roll.total, dice: roll.dice[0]?.results?.map(r=>r.result) ?? [] }`.
  (Model the Roll/toMessage usage on data-access.ts ~l.6013.)

**WoD success/botch counting stays MCP-side as a PURE function** (`countPool(dice, {difficulty,
specialty, willpower})`) so it is unit-testable with seeded dice arrays (task 2.2). The module just
rolls + posts + returns faces; the tool applies `countPool` to the returned faces and shapes the
result for Claude.

Consequence: the **companion Foundry module must be rebuilt + redeployed** to the live world for
roll-pool to work. The other 6 tools work against the currently-deployed module (existing handlers).

## Build / deploy

- MCP server: `cd foundry-vtt-mcp && npm run build && npm run bundle:server` → produces
  `packages/mcp-server/dist/index.bundle.cjs` (the global `foundry-mcp` MCP entry points here).
- Foundry module (only because of `rollDice`): its own build (check `packages/foundry-module`
  scripts) + redeploy to the live world (human-gated, like the system).
- Bump the fork version; commit+push the submodule; bump the pin in mago20.

## WoD dice mechanics (roll-pool `countPool`)

M20 storyteller: die ≥ difficulty (default 6) = success; specialty → each 10 = 2 successes
(10-again); each 1 cancels a success; net = max(0, successes − ones) (+1 if willpower,
uncancellable); botch = 0 successes AND ≥1 one (willpower auto-success prevents botch);
fail = 0 net and no 1. Report `{ pool, difficulty, dice, successes, ones, net, outcome, autoSuccess }`.

## WoD data-path reference (AUTHORITATIVE — from wod20-char foundry service + real fixtures)

> **CRITICAL — items-first model.** Live actors in our world are all Foundry `type: "PC"`
> (differentiated by `system.settings.splat`/`.game`/`.variant`, NOT actor type). Only the **9
> attributes** live under `system.*`. **Abilities, Willpower, pools, virtues, powers, merits,
> backgrounds, spheres, disciplines, gifts, charms are ALL embedded `items[]`.** The old
> design.md path table (`system.abilities.*`, `system.advantages.willpower`) is WRONG for these
> PC actors — do not use it. Read from `items[]`. Keep a defensive fallback to `system.abilities`/
> `system.advantages` object maps for any legacy template-driven typed actor, but items-first is
> the primary path.

### Attributes — `system.attributes.<key>` (the only `system.*` trait block)

9 keys: `strength,dexterity,stamina` (physical); `charisma,manipulation,appearance` (social);
`perception,intelligence,wits` (mental). Each: `{ value, bonus, total, max:5, type, speciality,
isvisible, ... }`. **rating = `.value`**. (Also two always-hidden 5e fields `composure`,`resolve`.)

### `system.settings` — capability flags drive extraction

18 fixed `has*` flags: `haswillpower, hasvirtue, hasrenown, hasquintessence, hasdisciplines,
hascombinationdisciplines, hasrituals, hasgifts, hasrites, hasshapes, hasapocalypticforms,
hasspheres, hasrotes, hasresonances, hasnuminas, hasrealms, haslores, hasedges`. Plus, for the
**creatures / Gods & Monsters** line only: **`hasessence: true`, `hascharms: true`** (out-of-band).
Also `settings.splat`, `.game`, `.variant`, `.era`, `.soak`. Per-line true flags:
mage→`hasspheres,hasquintessence,haswillpower`; vampire→`hasvirtue,haswillpower`;
werewolf→`hasrenown,haswillpower`; changeling/hunter/mortal/creatures→`haswillpower`
(creatures also `hasessence,hascharms`).

### Embedded `items[]` — the rest of the sheet

Migrated items (`Ability`,`Advantage`,`Sphere`,`Realm`) nest settings under **`system.settings.*`**;
un-migrated (`Power`,`Feature`,`Trait`,`Rote`,weapons,`Armor`,`Item`,`Fetish`) keep them **flat on
`system.*`**. Rating for leveled traits = **`system.value`** (Advantage pools use
`system.permanent`/`.temporary`).

| Concept                                                                                                                                      | `item.type`                    | `system.type`                                                                                 | rating field                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Talent/Skill/Knowledge                                                                                                                       | `Ability`                      | `wod.abilities.{talent,skill,knowledge}`                                                      | `system.value` (id=`system.id`, spec=`system.speciality`)                                                                            |
| Willpower                                                                                                                                    | `Advantage`                    | `wod.advantages.advantages` (id `willpower`)                                                  | `system.permanent`/`.temporary`                                                                                                      |
| Pools (Arete, Quintessence, Paradox, Rage, Gnosis, Blood Pool, Glamour, Banality, Nightmare, Pathos, Conviction, Path/Humanity, **Essence**) | `Advantage`                    | `wod.advantages.advantages`                                                                   | `system.permanent`/`.temporary`; identify by `system.id` and `system.group` (`quintessence`/`essence`/`""`)                          |
| Virtues                                                                                                                                      | `Advantage`                    | —                                                                                             | `system.group` ∈ `virtue` (conscience/selfcontrol/courage) · `renown` (glory/honor/wisdom/rank) · `huntervirtue` (mercy/vision/zeal) |
| Sphere (Mage)                                                                                                                                | `Sphere`                       | (none; `system.id`+`value`)                                                                   | `system.value` (mage always emits 9)                                                                                                 |
| Realm (Changeling)                                                                                                                           | `Realm`                        | (none)                                                                                        | `system.value`                                                                                                                       |
| Background                                                                                                                                   | `Feature`                      | `wod.types.background`                                                                        | `system.value`                                                                                                                       |
| Merit / Flaw                                                                                                                                 | `Feature`                      | `wod.types.merit` / `wod.types.flaw`                                                          | —                                                                                                                                    |
| **Special Advantage (G&M)**                                                                                                                  | `Feature`                      | `wod.types.specialadvantage`                                                                  | `system.value`                                                                                                                       |
| Discipline (Vampire)                                                                                                                         | `Power`                        | `wod.types.discipline` (container) + `wod.types.disciplinepower` children (`system.parentid`) | container `system.value` = dots                                                                                                      |
| Gift (Werewolf)                                                                                                                              | `Power`                        | `wod.types.gift`                                                                              | level from `system.rank`                                                                                                             |
| Rite / Edge / Numina / Combination / Ritual                                                                                                  | `Power`                        | `wod.types.{rite,edge,numina,combination,ritual}`                                             | —                                                                                                                                    |
| Art (Changeling)                                                                                                                             | `Power`                        | `wod.types.art`(container)/`artpower`                                                         | —                                                                                                                                    |
| **Charm (G&M)**                                                                                                                              | `Power`                        | `wod.types.charm` (`game:"mage"`)                                                             | `system.value`                                                                                                                       |
| Rote (Mage)                                                                                                                                  | `Rote`                         | `wod.types.rote`                                                                              | —                                                                                                                                    |
| Combat maneuver                                                                                                                              | `Trait`                        | `wod.types.maneuver`                                                                          | —                                                                                                                                    |
| Shapeform                                                                                                                                    | `Trait`                        | `wod.types.shapeform`                                                                         | —                                                                                                                                    |
| Weapon                                                                                                                                       | `Melee Weapon`/`Ranged Weapon` | (none)                                                                                        | —                                                                                                                                    |
| Armor                                                                                                                                        | `Armor`                        | (none)                                                                                        | —                                                                                                                                    |

Provenance flags on items: `flags['wod20-char']` or `flags['wod20-compendium-es']` carry
`{id,line,source_type,...}` (useful for labeling but not required).

### Health / damage — `system.health` + `system.soak`

`system.health.damage = { bashing, lethal, aggravated, woundlevel, woundpenalty, chimerical:{...} }`;
7 wound levels `system.health.{bruised,hurt,injured,wounded,mauled,crippled,incapacitated} =
{value,total,penalty,label}`. Total levels: `system.traits.health.totalhealthlevels = {value,max}`.
Soak: `system.soak = { bashing, lethal, aggravated, chimerical:{...} }`. **apply-damage** patches
`system.health.damage.{bashing,lethal,aggravated}`.

### Bio / splatfields — `system.bio`

`system.bio.{worldanvil,name,nature,demeanor,derangement,concept,appearance,background,notes,
roleplaytip}` + `system.bio.splatfields`. Mage splatfields: `{affiliation,sect,affinity,essence,
paradigm,practice,instruments}` (each `{label,value,type,listdata,isremovable,isvisible}`); other
lines mostly `{}`. Vampire **generation** is a splatfield (`system.bio.splatfields.generation`),
not an Advantage.

### `getPowerLevel` (index) / adjust-trait pool set

Power trait per line: mage→Arete, vampire→Blood Pool (or generation), werewolf→Rage/Gnosis,
changeling→Glamour, wraith→Pathos, hunter→Conviction, creatures→Essence. Read from the matching
`Advantage` item's `system.permanent`.

### Real fixtures to copy for adapter unit tests (all `type:"PC"`)

`mage-pc-export.real.json` (mage), `vampire-pc-export.real.json` (vampire),
`werewolf-pc-export.real.json` (werewolf), `mortal-mage.foundry.real.json` (mortal),
`familiar-creature-pc-export.real.json` (creature: Essence advantage + Charm powers).
Source dir: `wod20-char/web/tests/fixtures/foundry/`. NOTE baseline exports carry only
Abilities+Advantages(+Spheres for mage / shapeforms for werewolf); Disciplines/Gifts/Edges appear
as `Power` items only once picked — tests must not assume they're present in baseline fixtures.
