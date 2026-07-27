// Extracted from data-access.ts as part of the God-class split (behaviour-preserving).
// See docs/refactor-data-access.md for the module map.
//
// The character-reading cluster: eleven methods that read ONE actor and project it — its
// items, effects, spellcasting, flags and prototype-token art — into a transport shape.
// Two are reached from outside the facade (`getCharacterInfo` and `searchCharacterItems`,
// both from queries.ts) and keep a thin delegation there; the other nine are private and
// are reached only from inside this module. Between them they hold two four-way
// `systemId` dispatches (pf2e / dnd5e / dsa5 / wfrp4e) and three independent
// limit-truncation sites, so they are pinned by characterization tests asserting the
// returned RESULT SET per system branch — its contents, its ordering and its truncation —
// rather than the return envelope (see character-reader.test.ts).
//
// Depends on exactly two cross-cutting leaves and holds NO reference to FoundryDataAccess:
// `security` for Foundry-state validation, output sanitisation and the one audit call this
// cluster makes, and `actorResolver` for actor lookup. No FIELD read crosses the boundary:
// there is no `moduleId` here, unlike ActorCrud and CompendiumSearch, because no member of
// this cluster referenced MODULE_ID.
//
// `readActorFlags` and `extractTokenArt` ARE part of this cluster, and their apparent
// grouping with `findActorsByFlag` in actor-directory.ts is a coincidence of a comment
// rather than of code. All three carry the same "never `actor.getFlag()`" warning and
// 03a6836 added them together adjacently, but `findActorsByFlag` reads a flag at a
// caller-supplied dotted path through its own inline closure and returns ONE stringified
// scalar per actor — a different question from "all of ONE actor's flags, sanitised", and
// not expressible in terms of it. ActorDirectory's seven methods all return identity
// tuples over SETS of actors; not one returns an actor's contents and not one sanitises
// anything. These two return a sanitised detail projection of a single actor and are the
// field builders for `CharacterInfo.flags` and `CharacterInfo.prototypeToken`, whose
// declaration lives here; their sole caller is `getCharacterInfo`. If ActorDirectory ever
// acquires a DIRECT caller for either, the remedy is to lift the shared part into a
// cross-cutting leaf and inject it into both — NOT to relocate the member into a sibling
// concern module.
//
// `searchCharacterItems` is a READ that nevertheless calls `auditLog` (with a
// `matchCount`), alone among the read paths in this package, and it is the sole reason the
// facade's private `auditLog` wrapper existed at all. That is the pre-move behaviour,
// moved verbatim and pinned as observed. If auditing a read is wrong it is a one-line
// behaviour change with its own argument — do not "fix" it inside a relocation.
//
// Nothing here was deduplicated or reshaped: `searchCharacterItems`'s `let description`
// reassignment, `extractSpellcastingData`'s repeated `actorAny.items.filter` scans and
// `getCharacterInfo`'s duplicated `actor.items` traversals all moved verbatim.

// Local type definitions to avoid shared package import issues
export interface CharacterInfo {
  id: string;
  name: string;
  type: string;
  img?: string;
  /**
   * Opt-in (`include: ['flags']`). Absent unless requested, so default
   * responses stay the size they have always been.
   *
   * MIRROR WARNING: these types are duplicated, not shared. The same two fields
   * exist in `shared/src/types.ts` (`CharacterInfo`) and are consumed on the
   * server in `systems/worldofdarkness/extract.ts`. Change one, change all.
   */
  flags?: Record<string, unknown>;
  /** Opt-in (`include: ['prototypeToken']`). The token ART, curated — see extractTokenArt. */
  prototypeToken?: Record<string, unknown>;
  /** Echo of the `include` keys the module actually honoured. See getCharacterInfo. */
  included?: string[];
  system: Record<string, unknown>;
  items: CharacterItem[];
  effects: CharacterEffect[];
  actions?: any[]; // PF2e actions (strikes, spells, etc.)
  itemVariants?: any[]; // Item rule element variants (ChoiceSet, etc.)
  itemToggles?: any[]; // Item rule element toggles (RollOption, ToggleProperty, equipped)
  spellcasting?: SpellcastingEntry[]; // PF2e/D&D 5e spellcasting entries
}

export interface SpellcastingEntry {
  id: string;
  name: string;
  tradition?: string | undefined; // arcane, divine, primal, occult (PF2e)
  type: string; // prepared, spontaneous, innate, focus (PF2e) or class name (5e)
  ability?: string | undefined; // spellcasting ability (int, wis, cha)
  dc?: number | undefined;
  attack?: number | undefined;
  slots?: Record<string, { value: number; max: number }> | undefined; // spell slots per level/rank
  spells: SpellInfo[];
}

export interface SpellInfo {
  id: string;
  name: string;
  level: number; // spell level/rank
  prepared?: boolean | undefined; // for prepared casters
  expended?: boolean | undefined; // has this spell slot been used
  traits?: string[] | undefined;
  actionCost?: string | undefined; // 1, 2, 3, reaction, free
  // Targeting info - helps Claude decide whether to specify targets
  range?: string | undefined; // "touch", "self", "60 feet", etc.
  target?: string | undefined; // "1 creature", "self", "area", etc.
  area?: string | undefined; // "20-foot radius", "30-foot cone", etc. (for template spells)
}

interface CharacterItem {
  id: string;
  name: string;
  type: string;
  img?: string;
  system: Record<string, unknown>;
}

interface CharacterEffect {
  id: string;
  name: string;
  icon?: string;
  disabled: boolean;
  duration?: {
    type: string;
    duration?: number;
    remaining?: number;
  };
}
