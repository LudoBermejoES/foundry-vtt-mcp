/**
 * Mongoose Traveller 2e Filter System
 *
 * Zod schemas and filter matching logic for mgt2e creatures/actors.
 */

import { z } from 'zod';

/**
 * Creature types in mgt2e (broad categories)
 */
export const MGT2eCreatureTypes = [
  'animal',
  'humanoid',
  'drone',
  'robot',
  'alien',
  'exotic',
  'unknown',
] as const;
export type MGT2eCreatureType = (typeof MGT2eCreatureTypes)[number];

/**
 * Zod schema for mgt2e creature/actor filters
 */
export const MGT2eFiltersSchema = z.object({
  // Power level range (based on hits/HP)
  minHits: z.number().optional(),
  maxHits: z.number().optional(),

  // Creature type
  creatureType: z.enum(MGT2eCreatureTypes).optional(),

  // Actor type filter (creature, npc, traveller, spacecraft...)
  actorType: z.string().optional(),

  // Has psionics
  hasPsionics: z.boolean().optional(),

  // Name search
  name: z.string().optional(),
});

export type MGT2eFilters = z.infer<typeof MGT2eFiltersSchema>;

/**
 * Check if a creature matches the given filters
 */
export function matchesMGT2eFilters(creature: any, filters: MGT2eFilters): boolean {
  const data = creature.systemData ?? {};

  if (filters.minHits !== undefined && (data.hits ?? 0) < filters.minHits) return false;
  if (filters.maxHits !== undefined && (data.hits ?? 0) > filters.maxHits) return false;
  if (filters.creatureType && data.creatureType !== filters.creatureType) return false;
  if (filters.actorType && creature.type !== filters.actorType) return false;
  if (filters.hasPsionics !== undefined && !!data.hasPsionics !== filters.hasPsionics) return false;
  if (filters.name && !creature.name.toLowerCase().includes(filters.name.toLowerCase()))
    return false;

  return true;
}

/**
 * Human-readable description of active filters
 */
export function describeMGT2eFilters(filters: MGT2eFilters): string {
  const parts: string[] = [];

  if (filters.name) parts.push(`name contains "${filters.name}"`);
  if (filters.actorType) parts.push(`type: ${filters.actorType}`);
  if (filters.creatureType) parts.push(`creature type: ${filters.creatureType}`);
  if (filters.minHits !== undefined || filters.maxHits !== undefined) {
    const min = filters.minHits ?? 0;
    const max = filters.maxHits ?? '∞';
    parts.push(`hits ${min}–${max}`);
  }
  if (filters.hasPsionics) parts.push('psionic');

  return parts.length > 0 ? parts.join(', ') : 'no filters';
}
