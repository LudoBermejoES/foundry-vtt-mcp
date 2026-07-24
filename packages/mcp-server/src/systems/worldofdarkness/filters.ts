/**
 * World of Darkness 20th — filter schema
 *
 * Filters for search-compendium / list-creatures-by-criteria. WoD has no
 * Challenge Rating; the power-level proxy is the splat's power-trait rating
 * (Arete / Blood Pool / Rage / Essence …). Mirrors dsa5/filters.ts.
 *
 * The schema is `.strict()` so unknown filter keys fail `safeParse` — the
 * adapter's `matchesFilters` returns false on parse failure, rejecting filters
 * meant for other systems.
 */

import { z } from 'zod';

/** Recognised splats (Foundry `system.settings.splat`). */
export const WoDSplats = [
  'mage',
  'vampire',
  'werewolf',
  'changeling',
  'wraith',
  'mummy',
  'demon',
  'exalted',
  'hunter',
  'mortal',
  'creature',
  'changingbreed',
] as const;

export type WoDSplat = (typeof WoDSplats)[number];

/**
 * WoD filter schema (strict — unknown keys rejected).
 */
export const WoDFiltersSchema = z
  .object({
    // Splat / game line.
    splat: z.enum(WoDSplats).optional(),

    // Power-trait rating (Arete/Blood Pool/Rage/Essence …) — power-level proxy.
    powerLevel: z
      .union([
        z.number(),
        z.object({
          min: z.number().optional(),
          max: z.number().optional(),
        }),
      ])
      .optional(),

    // Capability flag the creature must have enabled (e.g. 'hasdisciplines').
    capability: z.string().optional(),
  })
  .strict();

export type WoDFilters = z.infer<typeof WoDFiltersSchema>;

/**
 * Check if a creature index entry matches the given WoD filters.
 */
export function matchesWoDFilters(creature: any, filters: WoDFilters): boolean {
  // Splat filter.
  if (filters.splat) {
    const splat = creature.systemData?.splat;
    if (!splat || splat.toLowerCase() !== filters.splat.toLowerCase()) {
      return false;
    }
  }

  // Power-level (power-trait rating) filter.
  if (filters.powerLevel !== undefined) {
    const level = creature.systemData?.powerLevel;
    if (level === undefined || level === null) return false;

    if (typeof filters.powerLevel === 'number') {
      if (level !== filters.powerLevel) return false;
    } else {
      const min = filters.powerLevel.min ?? -Infinity;
      const max = filters.powerLevel.max ?? Infinity;
      if (level < min || level > max) return false;
    }
  }

  // Capability filter.
  if (filters.capability) {
    const capabilities: string[] = creature.systemData?.capabilities ?? [];
    if (!capabilities.includes(filters.capability)) {
      return false;
    }
  }

  return true;
}

/**
 * Human-readable description of WoD filters.
 */
export function describeWoDFilters(filters: WoDFilters): string {
  const parts: string[] = [];

  if (filters.splat) parts.push(filters.splat);

  if (filters.powerLevel !== undefined) {
    if (typeof filters.powerLevel === 'number') {
      parts.push(`power trait ${filters.powerLevel}`);
    } else {
      const min = filters.powerLevel.min;
      const max = filters.powerLevel.max;
      if (min !== undefined && max !== undefined) parts.push(`power trait ${min}-${max}`);
      else if (min !== undefined) parts.push(`power trait ${min}+`);
      else if (max !== undefined) parts.push(`power trait ≤${max}`);
    }
  }

  if (filters.capability) parts.push(filters.capability);

  return parts.length > 0 ? parts.join(', ') : 'no filters';
}

/** Validate a splat string. */
export function isValidWoDSplat(splat: string): boolean {
  return (WoDSplats as readonly string[]).includes(splat.toLowerCase());
}
