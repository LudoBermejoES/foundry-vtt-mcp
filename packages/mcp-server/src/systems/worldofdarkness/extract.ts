/**
 * World of Darkness 20th — shared extraction helpers
 *
 * These are the canonical, read-only extractors for WoD PC actors. Both the
 * system adapter (`adapter.ts`) and the bespoke get-sheet tool delegate here,
 * so the exported signatures are load-bearing — do not change them casually.
 *
 * CRITICAL — items-first model. Live actors are all Foundry `type:"PC"`,
 * differentiated by `system.settings.splat`/`.game`/`.variant` (NOT actor type).
 * Only the 9 attributes live under `system.attributes.*`. Abilities, Willpower,
 * pools, virtues, powers, merits, backgrounds, spheres, disciplines, gifts and
 * charms are ALL embedded `items[]`. See IMPLEMENTATION_NOTES.md "WoD data-path
 * reference (AUTHORITATIVE)".
 *
 * Everything is guarded with optional chaining + fallbacks: fixtures/actors may
 * be missing whole sections.
 */

import { artFields } from '../../utils/actor-art.js';

/** Splat → power-trait descriptor. `flag`, when set, gates emission on that `has*` setting. */
const SPLAT_POWER_TRAIT: Record<string, { id: string; name: string; flag?: string }> = {
  mage: { id: 'arete', name: 'Arete', flag: 'hasspheres' },
  vampire: { id: 'bloodpool', name: 'Blood Pool' },
  werewolf: { id: 'rage', name: 'Rage', flag: 'hasrenown' },
  changingbreed: { id: 'rage', name: 'Rage', flag: 'hasrenown' },
  changeling: { id: 'glamour', name: 'Glamour' },
  wraith: { id: 'pathos', name: 'Pathos' },
  mummy: { id: 'sekhem', name: 'Sekhem' },
  hunter: { id: 'conviction', name: 'Conviction' },
  demon: { id: 'faith', name: 'Faith' },
  creature: { id: 'essence', name: 'Essence', flag: 'hasessence' },
};

/** Advantage `system.group` values that denote virtue-family traits (not pools). */
const VIRTUE_GROUPS = new Set(['virtue', 'renown', 'huntervirtue']);

/** Attribute type buckets used to group the 9 visible attributes. */
const ATTRIBUTE_BUCKETS: Record<string, 'physical' | 'social' | 'mental'> = {
  physical: 'physical',
  social: 'social',
  mental: 'mental',
};

// ─── low-level accessors ─────────────────────────────────────────────────────

/**
 * Return the enabled capability flags on the actor's `system.settings` — every
 * `has*` key whose value is `true` (includes the out-of-band `hasessence` /
 * `hascharms` used by the Gods & Monsters creatures line).
 */
export function getCapabilityFlags(actorData: any): Record<string, boolean> {
  const settings = actorData?.system?.settings ?? {};
  const flags: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (key.startsWith('has') && value === true) {
      flags[key] = true;
    }
  }
  return flags;
}

/** Return embedded items of a given `item.type` (e.g. 'Ability', 'Advantage', 'Sphere'). */
export function getEmbeddedItems(actorData: any, itemType: string): any[] {
  const items = actorData?.items;
  if (!Array.isArray(items)) return [];
  return items.filter(it => it?.type === itemType);
}

/** Find an Advantage item by its `system.id` (e.g. 'willpower', 'arete', 'bloodpool'). */
function findAdvantage(actorData: any, id: string): any | undefined {
  return getEmbeddedItems(actorData, 'Advantage').find(it => it?.system?.id === id);
}

/** Shape an Advantage pool as `{ permanent, temporary }`. */
function poolFrom(item: any): { permanent: number; temporary: number } {
  return {
    permanent: item?.system?.permanent ?? 0,
    temporary: item?.system?.temporary ?? 0,
  };
}

// ─── canonical extractor ─────────────────────────────────────────────────────

/**
 * The canonical WoD character extractor. The adapter's `extractCharacterStats`
 * delegates here. Emits ONLY the sections the actor's `has*` capability flags
 * indicate (never fabricates a power trait / spheres / essence for a splat that
 * lacks the flag or the backing item — e.g. a Mortal gets willpower only).
 */
export function extractCharacterStats(actorData: any): any {
  const system = actorData?.system ?? {};
  const settings = system.settings ?? {};
  const flags = getCapabilityFlags(actorData);
  const splat: string = settings.splat ?? '';

  const stats: any = {
    name: actorData?.name,
    type: actorData?.type,
    splat,
    game: settings.game,
    variant: settings.variant,
    attributes: extractAttributes(system),
    abilities: extractAbilities(actorData),
  };

  // Willpower — only when haswillpower (present on effectively every WoD sheet).
  if (flags.haswillpower) {
    const wp = findAdvantage(actorData, 'willpower');
    if (wp) stats.willpower = poolFrom(wp);
  }

  // Power trait — the splat's defining pool (Arete/Blood Pool/Rage/…). Gated on
  // the splat mapping + (where declared) a capability flag + the backing item.
  const powerTrait = extractPowerTrait(actorData, splat, flags);
  if (powerTrait) stats.powerTrait = powerTrait;

  // Other Advantage pools (Quintessence, Paradox, Gnosis, Path, …), keyed by id.
  const pools = extractPools(actorData, splat);
  if (Object.keys(pools).length > 0) stats.pools = pools;

  // Virtues / Renown / Hunter virtues.
  const virtues = extractVirtues(actorData);
  if (Object.keys(virtues).length > 0) stats.virtues = virtues;

  // Health & soak.
  stats.health = extractHealth(system);

  // Splatfields (name → value) and core bio.
  const splatfields = extractSplatfields(system);
  if (Object.keys(splatfields).length > 0) stats.splatfields = splatfields;
  stats.bio = {
    nature: system.bio?.nature ?? '',
    demeanor: system.bio?.demeanor ?? '',
    concept: system.bio?.concept ?? '',
  };

  // Powers (disciplines/gifts/rites/edges/numina/arts/rotes/…) — generic dump.
  const powers = extractPowers(actorData);
  if (powers.length > 0) stats.powers = powers;

  // Feature-backed lists.
  const merits = extractFeatures(actorData, 'wod.types.merit');
  if (merits.length > 0) stats.merits = merits;
  const flaws = extractFeatures(actorData, 'wod.types.flaw');
  if (flaws.length > 0) stats.flaws = flaws;
  const backgrounds = extractFeatures(actorData, 'wod.types.background');
  if (backgrounds.length > 0) stats.backgrounds = backgrounds;
  const specialAdvantages = extractFeatures(actorData, 'wod.types.specialadvantage');
  if (specialAdvantages.length > 0) stats.specialAdvantages = specialAdvantages;

  // Spheres (Mage) — gated on hasspheres.
  if (flags.hasspheres) {
    const spheres = extractLeveledItems(actorData, 'Sphere');
    if (Object.keys(spheres).length > 0) stats.spheres = spheres;
  }

  // Realms (Changeling) — gated on hasrealms.
  if (flags.hasrealms) {
    const realms = extractLeveledItems(actorData, 'Realm');
    if (Object.keys(realms).length > 0) stats.realms = realms;
  }

  // Charms + Essence (Gods & Monsters creatures) — gated on hascharms / hasessence.
  if (flags.hascharms) {
    const charms = extractPowersByType(actorData, 'wod.types.charm');
    if (charms.length > 0) stats.charms = charms;
  }
  if (flags.hasessence) {
    const essence = findAdvantage(actorData, 'essence');
    if (essence) stats.essence = poolFrom(essence);
  }

  return stats;
}

/** Options for {@link extractFullSheet}. All additive; omitting them reproduces the old output. */
export interface FullSheetOptions {
  /**
   * Attach each embedded item's Foundry `id` in `allItems`. Off by default: the
   * ids are pure noise on a 100-item sheet, but without them the sheet cannot
   * feed `manage-actors` `update-items` / `delete-items` without a second read.
   */
  includeItemIds?: boolean;
}

/**
 * Superset of {@link extractCharacterStats}: adds a complete grouped dump of ALL
 * embedded items (name, type, system.type, rating) for audit/export. Read-only.
 *
 * ART AND PROVENANCE (additive — no previously-returned field changes name or
 * meaning):
 *   - `id`             always. Its absence used to force a second `findActor`
 *                      round-trip for anything wanting to act on what it read.
 *   - `img`            always when the actor has one — the REAL path.
 *   - `isDefaultImg`   always. The meaningful version of `hasImage`.
 *   - `prototypeToken` when the module was asked for it (`include`) — this is the
 *                      only way to see token art WITHOUT a token on a scene.
 *   - `flags`          when the module was asked for it — carries
 *                      `flags.wodchar.sourceId`, so provenance is readable
 *                      without using a write path as a read probe.
 *
 * `prototypeToken` / `flags` are copied from the actor payload only when the
 * module actually sent them. They are never defaulted to `{}`: an empty object
 * would be indistinguishable from "the actor has no flags", which is a different
 * (and false) claim. The caller learns which extras were honoured from
 * `actorData.included`, echoed by the module.
 */
export function extractFullSheet(actorData: any, options?: FullSheetOptions): any {
  const base = extractCharacterStats(actorData);
  const items = Array.isArray(actorData?.items) ? actorData.items : [];
  const withItemIds = options?.includeItemIds === true;

  const allItems: Record<string, any[]> = {};
  for (const it of items) {
    const bucket = it?.type ?? 'Unknown';
    (allItems[bucket] ??= []).push({
      // Live bridge payloads carry `id`; a raw exported document carries `_id`.
      ...(withItemIds ? { id: it?.id ?? it?._id ?? null } : {}),
      name: it?.name,
      type: it?.type,
      systemType: it?.system?.type ?? null,
      rating: itemRating(it),
    });
  }

  return {
    ...base,
    ...(actorData?.id || actorData?._id ? { id: actorData.id ?? actorData._id } : {}),
    // The placeholder test lives in exactly one place for every read formatter.
    ...artFields(actorData?.img),
    ...(actorData?.prototypeToken !== undefined && actorData.prototypeToken !== null
      ? { prototypeToken: actorData.prototypeToken }
      : {}),
    ...(actorData?.flags !== undefined && actorData.flags !== null
      ? { flags: actorData.flags }
      : {}),
    capabilities: getCapabilityFlags(actorData),
    allItems,
  };
}

// ─── section extractors ──────────────────────────────────────────────────────

function extractAttributes(system: any): {
  physical: Record<string, number>;
  social: Record<string, number>;
  mental: Record<string, number>;
} {
  const result = {
    physical: {} as Record<string, number>,
    social: {} as Record<string, number>,
    mental: {} as Record<string, number>,
  };
  const attributes = system?.attributes ?? {};
  for (const [key, raw] of Object.entries(attributes)) {
    const attr = raw as any;
    // Skip the always-hidden 5e helper traits (composure, resolve).
    if (attr?.isvisible === false) continue;
    const bucket = ATTRIBUTE_BUCKETS[attr?.type];
    if (!bucket) continue;
    result[bucket][key] = attr?.value ?? 0;
  }
  return result;
}

function extractAbilities(actorData: any): {
  talents: Record<string, number>;
  skills: Record<string, number>;
  knowledges: Record<string, number>;
} {
  const result = {
    talents: {} as Record<string, number>,
    skills: {} as Record<string, number>,
    knowledges: {} as Record<string, number>,
  };
  for (const it of getEmbeddedItems(actorData, 'Ability')) {
    const t: string = it?.system?.type ?? '';
    let bucket: 'talents' | 'skills' | 'knowledges' | null = null;
    if (t === 'wod.abilities.talent') bucket = 'talents';
    else if (t === 'wod.abilities.skill') bucket = 'skills';
    else if (t === 'wod.abilities.knowledge') bucket = 'knowledges';
    if (!bucket) continue;
    result[bucket][it?.name] = it?.system?.value ?? 0;
  }
  return result;
}

function extractPowerTrait(
  actorData: any,
  splat: string,
  flags: Record<string, boolean>
): { name: string; permanent: number; temporary: number } | undefined {
  const descriptor = SPLAT_POWER_TRAIT[splat];
  if (!descriptor) return undefined; // mortals & unknown splats have no power trait
  if (descriptor.flag && !flags[descriptor.flag]) return undefined;
  const item = findAdvantage(actorData, descriptor.id);
  if (!item) return undefined;
  return { name: descriptor.name, ...poolFrom(item) };
}

function extractPools(
  actorData: any,
  splat: string
): Record<string, { permanent: number; temporary: number }> {
  const powerTraitId = SPLAT_POWER_TRAIT[splat]?.id;
  const pools: Record<string, { permanent: number; temporary: number }> = {};
  for (const it of getEmbeddedItems(actorData, 'Advantage')) {
    const id: string = it?.system?.id ?? '';
    const group: string = it?.system?.group ?? '';
    if (!id) continue;
    if (id === 'willpower' || id === powerTraitId) continue;
    if (VIRTUE_GROUPS.has(group)) continue;
    pools[id] = poolFrom(it);
  }
  return pools;
}

function extractVirtues(actorData: any): Record<string, number> {
  const virtues: Record<string, number> = {};
  for (const it of getEmbeddedItems(actorData, 'Advantage')) {
    const group: string = it?.system?.group ?? '';
    if (!VIRTUE_GROUPS.has(group)) continue;
    virtues[it?.name] = it?.system?.permanent ?? 0;
  }
  return virtues;
}

function extractHealth(system: any): {
  damage: { bashing: number; lethal: number; aggravated: number };
  totalLevels: number;
} {
  const dmg = system?.health?.damage ?? {};
  return {
    damage: {
      bashing: dmg.bashing ?? 0,
      lethal: dmg.lethal ?? 0,
      aggravated: dmg.aggravated ?? 0,
    },
    totalLevels: system?.traits?.health?.totalhealthlevels?.value ?? 0,
  };
}

function extractSplatfields(system: any): Record<string, any> {
  const splatfields = system?.bio?.splatfields ?? {};
  const result: Record<string, any> = {};
  for (const [key, raw] of Object.entries(splatfields)) {
    const field = raw as any;
    result[key] = field && typeof field === 'object' && 'value' in field ? field.value : field;
  }
  return result;
}

/** All Power items as `{ name, type, rating }` (disciplines, gifts, charms, rites, …). */
function extractPowers(
  actorData: any
): Array<{ name: string; type: string | null; rating: number }> {
  return getEmbeddedItems(actorData, 'Power').map(it => ({
    name: it?.name,
    type: it?.system?.type ?? null,
    rating: it?.system?.value ?? it?.system?.rank ?? 0,
  }));
}

/** Power items filtered by `system.type` (e.g. charms). */
function extractPowersByType(
  actorData: any,
  systemType: string
): Array<{ name: string; type: string; rating: number }> {
  return getEmbeddedItems(actorData, 'Power')
    .filter(it => it?.system?.type === systemType)
    .map(it => ({ name: it?.name, type: systemType, rating: it?.system?.value ?? 0 }));
}

/** Feature items filtered by `system.type` → `{ name, rating }`. */
function extractFeatures(
  actorData: any,
  systemType: string
): Array<{ name: string; rating: number }> {
  return getEmbeddedItems(actorData, 'Feature')
    .filter(it => it?.system?.type === systemType)
    .map(it => ({ name: it?.name, rating: it?.system?.value ?? 0 }));
}

/** Leveled items keyed by name → `system.value` (Sphere, Realm). */
function extractLeveledItems(actorData: any, itemType: string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const it of getEmbeddedItems(actorData, itemType)) {
    result[it?.name] = it?.system?.value ?? 0;
  }
  return result;
}

/** Best-effort rating for the audit dump: Advantage → permanent, else system.value/rank. */
function itemRating(it: any): number {
  if (it?.type === 'Advantage') return it?.system?.permanent ?? 0;
  return it?.system?.value ?? it?.system?.rank ?? 0;
}
