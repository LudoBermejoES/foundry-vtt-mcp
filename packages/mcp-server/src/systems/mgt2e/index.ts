/**
 * Mongoose Traveller 2e System Module
 *
 * Exports for mgt2e system support in the Registry Pattern architecture.
 */

// Type definitions (from central types.ts)
export type { MGT2eCreatureIndex } from '../types.js';

// Index builder (runs in Foundry browser context)
export { MGT2eIndexBuilder } from './index-builder.js';

// System adapter (runs in MCP server Node.js context)
export { MGT2eAdapter } from './adapter.js';

// Filter system
export {
  MGT2eCreatureTypes,
  MGT2eFiltersSchema,
  matchesMGT2eFilters,
  describeMGT2eFilters,
} from './filters.js';
export type { MGT2eCreatureType, MGT2eFilters } from './filters.js';

// Constants
export {
  CHARACTERISTIC_NAMES,
  SKILL_KEYS,
  ACTOR_TYPES,
  ITEM_TYPES,
  FIELD_PATHS,
  calcDM,
} from './constants.js';
