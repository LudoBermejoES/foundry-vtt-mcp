/**
 * World of Darkness 20th System Module
 *
 * Exports for `worldofdarkness` (M20/V20/W20/…) support in the Registry Pattern
 * architecture. Mirrors dsa5/index.ts.
 */

// Type definitions (from central types.ts)
export type { WoDCreatureIndex } from '../types.js';

// System adapter (runs in MCP server Node.js context)
export { WorldOfDarknessAdapter } from './adapter.js';

// Index builder (runs in Foundry browser context)
export { WoDIndexBuilder } from './index-builder.js';

// Filter system
export {
  WoDSplats,
  WoDFiltersSchema,
  matchesWoDFilters,
  describeWoDFilters,
  isValidWoDSplat,
} from './filters.js';
export type { WoDSplat, WoDFilters } from './filters.js';

// Shared extraction helpers (also imported by the bespoke get-sheet tool)
export {
  getCapabilityFlags,
  getEmbeddedItems,
  extractCharacterStats,
  extractFullSheet,
} from './extract.js';
