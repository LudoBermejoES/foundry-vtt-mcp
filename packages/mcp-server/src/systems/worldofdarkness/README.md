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

| Tool                             | Purpose                                                                                                                                                 | Bridge handler used                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `worldofdarkness-roll-pool`      | Roll a d10 pool vs difficulty (specialty 10-again, 1s-cancel, botch, Willpower auto-success); posts to chat                                             | `rollDice` (new)                   |
| `worldofdarkness-apply-damage`   | Apply/heal bashing/lethal/aggravated on the health track                                                                                                | `findActor` + `updateActors`       |
| `worldofdarkness-adjust-trait`   | Spend/gain a pool (Willpower, Blood, Quintessence, Rage, Gnosis, Glamour, Essence, …)                                                                   | `updateActorItems`                 |
| `worldofdarkness-search-content` | Search the `wod20-compendium-es` Item packs (dynamic discovery)                                                                                         | `searchCompendium` (packType Item) |
| `worldofdarkness-add-items`      | Embed compendium Items onto an actor (all-or-nothing)                                                                                                   | `addActorItems`                    |
| `worldofdarkness-create-actor`   | Create a splat actor with the right `system.settings` flags                                                                                             | `createActors`                     |
| `worldofdarkness-get-sheet`      | Full structured splat sheet + art paths, and `flags` / `prototypeToken` / item ids on `include` (read-only)                                             | `getCharacterInfo` (`include`)     |
| `worldofdarkness-import-actor`   | Create/update actors from full exported Actor JSON — inline, staged paths, or one staged `.zip` (chunked, per-actor results, `dryRun` + transport plan) | `importActors`                     |
| `worldofdarkness-find-actors`    | Map external source ids (`flags.wodchar.sourceId`) to Foundry actor ids; reports unmatched + duplicates                                                 | `findActorsByFlag` (new)           |

`roll-pool` and `find-actors` are the only tools that required a new browser-side handler (`rollDice`
and `findActorsByFlag` in `foundry-module`); the rest reuse existing generic module primitives.
`get-sheet`'s `include: ['flags','prototypeToken']` extends an existing handler rather than adding one.

**Server/module skew.** The server bundle and the Foundry module deploy independently, so a new server
routinely talks to an old module. Anything whose absence would read as a FACT is pre-flighted against
the capability list `handlePing` advertises and refused if unsupported, never answered with a guess:
`import-actor`'s `dryRun` (`importActors.dryRun`), `get-sheet`'s `include`
(`getCharacterInfo.include`), and `find-actors` itself (`findActorsByFlag`). Module 0.9.3+ for the
last two.

**Three import intakes, mutually exclusive.** `import-actor` takes documents exactly one way per call:
inline (`actor` / `actors`), staged paths (`actorPath` / `actorPaths`), or **one staged `.zip`
(`actorArchive`, `import-archive.ts`)**. Mixing them is refused rather than concatenated, because a
half-import from the wrong source is invisible. All three converge on the same `actorDocSchema` and the
same per-document batch path, so there is one validation path and one set of retry semantics.

The archive is an **intake** — it answers _where the documents come from_ — and it is unpacked in this
server before any bridge message exists. It is not a transport concern and does not meet the wire
compression below: `archive → documents → schema → chunks → gzip → frame`, one direction, and by the
time a message exists the archive is gone. So **no module change, no new bridge query, and no GM world
reload** — unusual in this codebase, and the reason it is worth stating. It also buys **no extra
capacity**: the cap is the same 50 documents (`WOD_ARCHIVE_LIMITS.MAX_DOCUMENTS` in `config.ts`) because
the constraint is aggregate wall clock, and every document still crosses the bridge in full, one
sequential query at a time. Non-document entries (directories, `__MACOSX/` sidecars, `._*`, non-`.json`)
are ignored and reported, never fatal — macOS "Compress" emits 27 entries for 12 documents and all 24 of
its file entries end in `.json`. Every document must carry a resolvable `sourceId` or the whole archive
is refused before anything is written; raw `wod character export` output carries none. Full prose lives
in the consuming monorepo's `docs/foundry-import.md` ("Or stage a whole cast as one `.zip`"); the design
record is `import-archive.ts`'s own header.

**No per-document size ceiling.** `import-actor` used to refuse any single document over 65,536 bytes on
the WebRTC transport, which made a ~97 KB Mage export unimportable — and unpredictable, because the
refusal pre-empted `dryRun` too. Compressed JSON is now the bridge wire format (module 0.9.5+ advertises
`transport.compression.gzip`), real WoD actor documents compress 6.9x–12.5x, and the refusal is gone.
What remains is a refusal on the **measured compressed** size of the message that would actually be
sent — which in practice only fires for art embedded as a base64 `data:` URI, whose remedy is to sync the
image to the Foundry server and repoint `img`. `chunkBytes` is a per-query **work** budget in
uncompressed bytes, not a size ceiling. See
[`docs/transport-wire-format.md`](../../../../../docs/transport-wire-format.md).

## Registration

`backend.ts`: `systemRegistry.register(new WorldOfDarknessAdapter())`, plus the 9 tool classes in
`allTools` + the dispatch `switch`. See `IMPLEMENTATION_NOTES.md` for the full design record.
