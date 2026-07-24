# World of Darkness (`worldofdarkness`) system support

Adapter + bespoke tools for the **World of Darkness 20th Anniversary** Foundry system fork
(`Foundry_WoD20`, id `worldofdarkness`) — Mage/Vampire/Werewolf/Changeling/Wraith/Hunter/Mortal and
the Gods & Monsters **creatures** line. Companion content lives in the `wod20-compendium-es` module
(Item packs, `<line>-<kind>`).

## Data model (important)

Live actors are Foundry `type: "PC"`, differentiated by `system.settings.splat`/`.game`/`.variant`
(not by actor type). **Only the 9 attributes live under `system.attributes.*`.** Abilities,
Willpower, pools, virtues, Spheres, powers, merits, backgrounds, disciplines, gifts, and **Charms**
are all embedded `items[]`:

- Attributes → `system.attributes.<key>.value` (9: str/dex/sta, cha/man/app, per/int/wits).
- Capability flags → `system.settings.has*` (18 fixed + `hasessence`/`hascharms` for creatures).
  Extraction emits only the sections an actor's flags enable.
- Abilities → `Ability` items (`system.type` = `wod.abilities.{talent,skill,knowledge}`, rating
  `system.value`).
- Willpower / pools / virtues → `Advantage` items (`system.permanent`/`.temporary`; identify by
  `system.id`/`system.group`). Power trait per line: Arete / Blood Pool / Rage+Gnosis / Glamour /
  Pathos / Conviction / **Essence** (creatures).
- Powers/merits/flaws/backgrounds/special-advantages/charms → `Power`/`Feature` items by
  `system.type` (`wod.types.{discipline,gift,rite,edge,charm,merit,flaw,background,specialadvantage,…}`).
- Health → `system.health.damage.{bashing,lethal,aggravated}`; soak → `system.soak`.

## Files

- `adapter.ts` — `WorldOfDarknessAdapter` (registry pattern): makes the 7 generic system-aware tools
  (`get-character`, `list-characters`, `search-compendium`, `list-creatures-by-criteria`,
  `get-compendium-item`, `create-actor-from-compendium`, `list-compendium-packs`) WoD-correct.
- `extract.ts` — shared items-first extractors (`extractCharacterStats`, `extractFullSheet`,
  `getCapabilityFlags`, `getEmbeddedItems`); also used by `worldofdarkness-get-sheet`.
- `filters.ts` — WoD filter schema (splat / power-level / capability), strict (rejects unknown keys).
- `index-builder.ts` — creature index over Actor packs (splat, capability set, power-trait rating).
- `__fixtures__/` — real PC exports (mage/vampire/werewolf/mortal/creature) for the adapter tests.

## Bespoke `worldofdarkness-*` tools (`../../tools/worldofdarkness/`)

| Tool                             | Purpose                                                                                                     | Bridge handler used                |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `worldofdarkness-roll-pool`      | Roll a d10 pool vs difficulty (specialty 10-again, 1s-cancel, botch, Willpower auto-success); posts to chat | `rollDice` (new)                   |
| `worldofdarkness-apply-damage`   | Apply/heal bashing/lethal/aggravated on the health track                                                    | `findActor` + `updateActors`       |
| `worldofdarkness-adjust-trait`   | Spend/gain a pool (Willpower, Blood, Quintessence, Rage, Gnosis, Glamour, Essence, …)                       | `updateActorItems`                 |
| `worldofdarkness-search-content` | Search the `wod20-compendium-es` Item packs (dynamic discovery)                                             | `searchCompendium` (packType Item) |
| `worldofdarkness-add-items`      | Embed compendium Items onto an actor (all-or-nothing)                                                       | `addActorItems`                    |
| `worldofdarkness-create-actor`   | Create a splat actor with the right `system.settings` flags                                                 | `createActors`                     |
| `worldofdarkness-get-sheet`      | Full structured splat sheet (read-only)                                                                     | `getCharacterInfo`                 |

Only `roll-pool` required a new browser-side handler (`rollDice` in `foundry-module`); the rest reuse
existing generic module primitives.

## Registration

`backend.ts`: `systemRegistry.register(new WorldOfDarknessAdapter())`, plus the 7 tool classes in
`allTools` + the dispatch `switch`. See `IMPLEMENTATION_NOTES.md` for the full design record.
