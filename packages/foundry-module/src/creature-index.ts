// Extracted from data-access.ts as part of the God-class split (behaviour-preserving).
// See docs/refactor-data-access.md for the module map.
//
// Types below are intentionally duplicated from data-access.ts (this fork has no
// packages/shared — see the comment at the top of data-access.ts) rather than
// imported, to keep this module free of a circular dependency on its own consumer.
import { MODULE_ID } from './constants.js';

// D&D 5e Enhanced Creature Index
interface DnD5eCreatureIndex {
  id: string;
  name: string;
  type: string;
  pack: string;
  packLabel: string;
  challengeRating: number;
  creatureType: string;
  size: string;
  hitPoints: number;
  armorClass: number;
  hasSpells: boolean;
  hasLegendaryActions: boolean;
  alignment: string;
  description?: string;
  img?: string;
}

// Pathfinder 2e Enhanced Creature Index
interface PF2eCreatureIndex {
  id: string;
  name: string;
  type: string;
  pack: string;
  packLabel: string;
  level: number; // PF2e: -1 to 25+
  traits: string[]; // PF2e: ['dragon', 'fire', 'amphibious']
  creatureType: string; // Primary trait extracted from traits array
  rarity: string; // PF2e: 'common', 'uncommon', 'rare', 'unique'
  size: string;
  hitPoints: number;
  armorClass: number;
  hasSpells: boolean;
  alignment: string;
  description?: string;
  img?: string;
}

// Cosmere RPG (Plotweaver) Enhanced Creature Index
//
// Plotweaver categorises adversaries by `tier` (1-4) and `role`
// (minion/rival/boss) rather than CR or level — those are the primary
// encounter-design dials. Defenses are split into phy/cog/spi instead
// of a single AC, and Investiture is the Surge/Stormlight resource.
interface CosmereRpgCreatureIndex {
  id: string;
  name: string;
  type: string; // 'adversary' for compendium creatures
  pack: string;
  packLabel: string;
  tier: number; // 1-4
  role: string; // minion | rival | boss | (system-extended)
  creatureType: string; // humanoid | animal | spren | …
  subtype: string; // free-form secondary type
  size: string;
  hitPoints: number; // resources.hea.max (override-aware)
  focus: number; // resources.foc.max
  investiture: number; // resources.inv.max — typically 0
  hasInvestiture: boolean;
  defensePhysical: number;
  defenseCognitive: number;
  defenseSpiritual: number;
  deflect: number;
  walkSpeed: number;
  description?: string;
  img?: string;
}

interface MGT2eCreatureIndex {
  id: string;
  name: string;
  type: string; // traveller | npc | creature | spacecraft | …
  pack: string;
  packLabel: string;
  hits: number;
  creatureType: string;
  hasPsionics: boolean;
  characteristics: Record<string, { value: number; dm: number }>;
  img?: string;
}

// Union type across all supported systems
type EnhancedCreatureIndex =
  | DnD5eCreatureIndex
  | PF2eCreatureIndex
  | CosmereRpgCreatureIndex
  | MGT2eCreatureIndex;

interface PersistentIndexMetadata {
  version: string;
  timestamp: number;
  packFingerprints: Map<string, PackFingerprint>;
  totalCreatures: number;
  gameSystem: string; // 'dnd5e' or 'pf2e'
}

interface PackFingerprint {
  packId: string;
  packLabel: string;
  lastModified: number;
  documentCount: number;
  checksum: string;
}

interface PersistentEnhancedIndex {
  metadata: PersistentIndexMetadata;
  creatures: EnhancedCreatureIndex[];
}

/**
 * Persistent Enhanced Creature Index System
 * Stores pre-computed creature data in JSON file within Foundry world directory for instant filtering
 * Uses file-based storage following Foundry best practices for large data sets
 */
export class PersistentCreatureIndex {
  private moduleId: string = MODULE_ID;
  private readonly INDEX_VERSION = '1.0.0';
  private readonly INDEX_FILENAME = 'enhanced-creature-index.json';
  private buildInProgress = false;
  private hooksRegistered = false;

  constructor() {
    this.registerFoundryHooks();
  }

  /**
   * Get the file path for the enhanced creature index
   */
  private getIndexFilePath(): string {
    // Store in world data directory using world ID
    return `worlds/${game.world.id}/${this.INDEX_FILENAME}`;
  }

  /**
   * Get or build the enhanced creature index
   */
  async getEnhancedIndex(): Promise<EnhancedCreatureIndex[]> {
    // Check if we have a valid persistent index
    const existingIndex = await this.loadPersistedIndex();

    if (existingIndex && this.isIndexValid(existingIndex)) {
      return existingIndex.creatures;
    }

    // Build new index if needed
    return await this.buildEnhancedIndex();
  }

  /**
   * Force rebuild of the enhanced index
   */
  async rebuildIndex(): Promise<EnhancedCreatureIndex[]> {
    return await this.buildEnhancedIndex(true);
  }

  /**
   * Load persisted index from JSON file
   */
  private async loadPersistedIndex(): Promise<PersistentEnhancedIndex | null> {
    try {
      const filePath = this.getIndexFilePath();

      // Check if file exists using Foundry's FilePicker
      let fileExists = false;
      try {
        const browseResult = await (
          foundry as any
        ).applications.apps.FilePicker.implementation.browse('data', `worlds/${game.world.id}`);
        fileExists = browseResult.files.some((f: any) => f.endsWith(this.INDEX_FILENAME));
      } catch (error) {
        // Directory doesn't exist or other error, return null
        return null;
      }

      if (!fileExists) {
        return null;
      }

      // Load file content
      const response = await fetch(filePath);
      if (!response.ok) {
        console.warn(`[${this.moduleId}] Failed to load index file: ${response.status}`);
        return null;
      }

      const rawData = await response.json();

      // Convert Map data back from JSON
      const metadata = rawData.metadata;
      if (metadata?.packFingerprints) {
        metadata.packFingerprints = new Map(metadata.packFingerprints);
      }

      return rawData;
    } catch (error) {
      console.warn(`[${this.moduleId}] Failed to load persisted index from file:`, error);
      return null;
    }
  }

  /**
   * Save enhanced index to JSON file
   */
  private async savePersistedIndex(index: PersistentEnhancedIndex): Promise<void> {
    try {
      // Convert Map to Array for JSON serialization
      const saveData = {
        ...index,
        metadata: {
          ...index.metadata,
          packFingerprints: Array.from(index.metadata.packFingerprints.entries()),
        },
      };

      const jsonContent = JSON.stringify(saveData, null, 2);

      // Create a File object and upload it using Foundry's file system
      const file = new File([jsonContent], this.INDEX_FILENAME, { type: 'application/json' });

      // Upload the file to the world directory
      const uploadResponse = await (
        foundry as any
      ).applications.apps.FilePicker.implementation.upload('data', `worlds/${game.world.id}`, file);

      if (uploadResponse) {
      } else {
        throw new Error('File upload failed');
      }
    } catch (error) {
      console.error(`[${this.moduleId}] Failed to save enhanced index to file:`, error);
      throw error;
    }
  }

  /**
   * Check if existing index is valid (all packs unchanged)
   */
  private isIndexValid(existingIndex: PersistentEnhancedIndex): boolean {
    // Check version
    if (existingIndex.metadata.version !== this.INDEX_VERSION) {
      return false;
    }

    // NEW: Check system compatibility
    const currentSystem = (game as any).system.id;
    if (existingIndex.metadata.gameSystem !== currentSystem) {
      console.log(
        `[${this.moduleId}] System changed from ${existingIndex.metadata.gameSystem} to ${currentSystem}, index invalidated`
      );
      return false;
    }

    // Check each pack fingerprint
    const actorPacks = Array.from(game.packs.values()).filter(
      pack => pack.metadata.type === 'Actor'
    );

    for (const pack of actorPacks) {
      const currentFingerprint = this.generatePackFingerprint(pack);
      const savedFingerprint = existingIndex.metadata.packFingerprints.get(pack.metadata.id);

      if (!savedFingerprint) {
        return false;
      }

      if (!this.fingerprintsMatch(currentFingerprint, savedFingerprint)) {
        return false;
      }
    }

    // Check if any saved packs no longer exist
    for (const [packId] of existingIndex.metadata.packFingerprints) {
      if (!game.packs.get(packId)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Register Foundry hooks for real-time pack change detection
   */
  private registerFoundryHooks(): void {
    if (this.hooksRegistered) return;

    // Listen for compendium document changes
    Hooks.on('createDocument', (document: any) => {
      if (
        document.pack &&
        (document.type === 'npc' || document.type === 'character' || document.type === 'creature')
      ) {
        this.invalidateIndex();
      }
    });

    Hooks.on('updateDocument', (document: any) => {
      if (
        document.pack &&
        (document.type === 'npc' || document.type === 'character' || document.type === 'creature')
      ) {
        this.invalidateIndex();
      }
    });

    Hooks.on('deleteDocument', (document: any) => {
      if (
        document.pack &&
        (document.type === 'npc' || document.type === 'character' || document.type === 'creature')
      ) {
        this.invalidateIndex();
      }
    });

    // Listen for pack creation/deletion
    Hooks.on('createCompendium', (pack: any) => {
      if (pack.metadata.type === 'Actor') {
        this.invalidateIndex();
      }
    });

    Hooks.on('deleteCompendium', (pack: any) => {
      if (pack.metadata.type === 'Actor') {
        this.invalidateIndex();
      }
    });

    this.hooksRegistered = true;
  }

  /**
   * Invalidate the current index (mark for rebuild on next access)
   */
  private async invalidateIndex(): Promise<void> {
    try {
      // Check if auto-rebuild is enabled
      const autoRebuild = game.settings.get(this.moduleId, 'autoRebuildIndex');

      if (!autoRebuild) {
        return;
      }

      // Delete the index file to force rebuild
      const filePath = this.getIndexFilePath();

      try {
        // Check if file exists first by trying to browse to the world directory
        const browseResult = await (
          foundry as any
        ).applications.apps.FilePicker.implementation.browse('data', `worlds/${game.world.id}`);
        const fileExists = browseResult.files.some((f: any) => f.endsWith(this.INDEX_FILENAME));

        if (fileExists) {
          // File exists, delete it using fetch with DELETE method
          await fetch(filePath, { method: 'DELETE' });
          // File deletion completed (or failed silently)
        }
      } catch (error) {
        // File doesn't exist or deletion failed - that's okay
      }
    } catch (error) {
      console.warn(`[${this.moduleId}] Failed to invalidate index:`, error);
    }
  }

  /**
   * Generate fingerprint for pack change detection with improved accuracy
   */
  private generatePackFingerprint(pack: any): PackFingerprint {
    // Get actual modification time if available
    let lastModified = Date.now();
    if (pack.metadata.lastModified) {
      lastModified = new Date(pack.metadata.lastModified).getTime();
    }

    return {
      packId: pack.metadata.id,
      packLabel: pack.metadata.label,
      lastModified,
      documentCount: pack.index?.size || 0,
      checksum: this.generatePackChecksum(pack),
    };
  }

  /**
   * Generate checksum for pack contents
   */
  private generatePackChecksum(pack: any): string {
    // Simple checksum based on pack metadata and size
    const data = `${pack.metadata.id}-${pack.metadata.label}-${pack.index?.size || 0}`;
    return btoa(data).slice(0, 16); // Simple hash for demonstration
  }

  /**
   * Compare two pack fingerprints
   */
  private fingerprintsMatch(current: PackFingerprint, saved: PackFingerprint): boolean {
    return current.documentCount === saved.documentCount && current.checksum === saved.checksum;
  }

  /**
   * Build enhanced creature index from all Actor packs with detailed progress tracking
   */
  private async buildEnhancedIndex(force = false): Promise<EnhancedCreatureIndex[]> {
    if (this.buildInProgress && !force) {
      throw new Error('Index build already in progress');
    }

    // Detect game system ONCE at build time
    const gameSystem = (game as any).system.id;

    console.log(`[${this.moduleId}] Building enhanced creature index for system: ${gameSystem}`);

    // Route to system-specific builder
    if (gameSystem === 'pf2e') {
      return await this.buildPF2eIndex(force);
    } else if (gameSystem === 'dnd5e') {
      return await this.buildDnD5eIndex(force);
    } else if (gameSystem === 'cosmere-rpg') {
      return await this.buildCosmereRpgIndex(force);
    } else if (gameSystem === 'mgt2e') {
      return await this.buildMGT2eIndex(force);
    } else {
      // Unknown system — skip silently rather than blocking world load
      console.warn(
        `[${this.moduleId}] Enhanced creature index not implemented for system: ${gameSystem}. Skipping.`
      );
      return [];
    }
  }

  /**
   * Build D&D 5e enhanced creature index
   */
  private async buildDnD5eIndex(_force = false): Promise<DnD5eCreatureIndex[]> {
    this.buildInProgress = true;

    const startTime = Date.now();
    let progressNotification: any = null;
    let totalErrors = 0; // Track extraction errors

    try {
      const actorPacks = Array.from(game.packs.values()).filter(
        pack => pack.metadata.type === 'Actor'
      );
      const enhancedCreatures: DnD5eCreatureIndex[] = [];
      const packFingerprints = new Map<string, PackFingerprint>();

      // Show initial progress notification
      ui.notifications?.info(
        `Starting enhanced creature index build from ${actorPacks.length} packs...`
      );

      for (let i = 0; i < actorPacks.length; i++) {
        const pack = actorPacks[i];
        const progressPercent = Math.round((i / actorPacks.length) * 100);

        // Update progress notification every few packs or for important packs
        if (i % 3 === 0 || pack.metadata.label.toLowerCase().includes('monster')) {
          if (progressNotification) {
            progressNotification.remove();
          }
          progressNotification = ui.notifications?.info(
            `Building creature index... ${progressPercent}% (${i + 1}/${actorPacks.length}) Processing: ${pack.metadata.label}`
          );
        }

        try {
          // Ensure pack index is loaded
          if (!pack.indexed) {
            await pack.getIndex({});
          }

          // Generate pack fingerprint for change detection
          packFingerprints.set(pack.metadata.id, this.generatePackFingerprint(pack));

          // Show pack processing details for large packs
          const packSize = pack.index?.size || 0;
          if (packSize > 50) {
            if (progressNotification) {
              progressNotification.remove();
            }
            progressNotification = ui.notifications?.info(
              `Processing large pack: ${pack.metadata.label} (${packSize} documents)...`
            );
          }

          // Process creatures in this pack
          const packResult = await this.extractDnD5eDataFromPack(pack);
          enhancedCreatures.push(...packResult.creatures);
          totalErrors += packResult.errors;

          // Pack processing completed: ${pack.metadata.label} - ${packResult.creatures.length} creatures extracted

          // Show milestone notifications for significant progress
          if (i === 0 || (i + 1) % 5 === 0 || i === actorPacks.length - 1) {
            const totalCreaturesSoFar = enhancedCreatures.length;
            if (progressNotification) {
              progressNotification.remove();
            }
            progressNotification = ui.notifications?.info(
              `Index Progress: ${i + 1}/${actorPacks.length} packs complete, ${totalCreaturesSoFar} creatures indexed`
            );
          }
        } catch (error) {
          console.warn(`[${this.moduleId}] Failed to process pack ${pack.metadata.label}:`, error);
          // Show error notification for pack failures
          ui.notifications?.warn(
            `Warning: Failed to index pack "${pack.metadata.label}" - continuing with other packs`
          );
        }
      }

      // Clear progress notification and show final processing step
      if (progressNotification) {
        progressNotification.remove();
      }
      ui.notifications?.info(
        `Saving enhanced index to world database... (${enhancedCreatures.length} creatures)`
      );

      // Create persistent index structure
      const persistentIndex: PersistentEnhancedIndex = {
        metadata: {
          version: this.INDEX_VERSION,
          timestamp: Date.now(),
          packFingerprints,
          totalCreatures: enhancedCreatures.length,
          gameSystem: 'dnd5e', // Mark as D&D 5e index
        },
        creatures: enhancedCreatures,
      };

      // Save to world flags
      await this.savePersistedIndex(persistentIndex);

      const buildTimeSeconds = Math.round((Date.now() - startTime) / 1000);
      const errorText = totalErrors > 0 ? ` (${totalErrors} extraction errors)` : '';
      const successMessage = `Enhanced creature index complete! ${enhancedCreatures.length} creatures indexed from ${actorPacks.length} packs in ${buildTimeSeconds}s${errorText}`;

      ui.notifications?.info(successMessage);

      return enhancedCreatures;
    } catch (error) {
      // Clear any progress notifications on error
      if (progressNotification) {
        progressNotification.remove();
      }

      const errorMessage = `Failed to build enhanced creature index: ${error instanceof Error ? error.message : 'Unknown error'}`;
      console.error(`[${this.moduleId}] ${errorMessage}`);
      ui.notifications?.error(errorMessage);

      throw error;
    } finally {
      this.buildInProgress = false;

      // Ensure progress notification is cleared
      if (progressNotification) {
        progressNotification.remove();
      }
    }
  }

  /**
   * Extract D&D 5e data from all documents in a pack
   */
  private async extractDnD5eDataFromPack(
    pack: any
  ): Promise<{ creatures: DnD5eCreatureIndex[]; errors: number }> {
    const creatures: DnD5eCreatureIndex[] = [];
    let errors = 0;

    try {
      // Load all documents from pack
      const documents = await pack.getDocuments();

      for (const doc of documents) {
        try {
          // Only process NPCs, characters, and creatures
          if (doc.type !== 'npc' && doc.type !== 'character' && doc.type !== 'creature') {
            continue;
          }

          const result = this.extractDnD5eCreatureData(doc, pack);
          if (result) {
            creatures.push(result.creature);
            errors += result.errors;
          }
        } catch (error) {
          console.warn(
            `[${this.moduleId}] Failed to extract data from ${doc.name} in ${pack.metadata.label}:`,
            error
          );
          errors++;
        }
      }
    } catch (error) {
      console.warn(
        `[${this.moduleId}] Failed to load documents from ${pack.metadata.label}:`,
        error
      );
      errors++;
    }

    return { creatures, errors };
  }

  /**
   * Extract D&D 5e creature data from a single document
   */
  private extractDnD5eCreatureData(
    doc: any,
    pack: any
  ): { creature: DnD5eCreatureIndex; errors: number } | null {
    try {
      const system = doc.system || {};

      // Extract challenge rating with comprehensive fallbacks
      // Based on debug logs: system.details.cr contains the actual value
      let challengeRating =
        system.details?.cr ??
        system.details?.cr?.value ??
        system.cr?.value ??
        system.cr ??
        system.attributes?.cr?.value ??
        system.attributes?.cr ??
        system.challenge?.rating ??
        system.challenge?.cr ??
        0;

      // Handle null values (spell effects, etc.)
      if (challengeRating === null || challengeRating === undefined) {
        challengeRating = 0;
      }

      if (typeof challengeRating === 'string') {
        if (challengeRating === '1/8') challengeRating = 0.125;
        else if (challengeRating === '1/4') challengeRating = 0.25;
        else if (challengeRating === '1/2') challengeRating = 0.5;
        else challengeRating = parseFloat(challengeRating) || 0;
      }

      // Ensure it's a number
      challengeRating = Number(challengeRating) || 0;

      // Extract creature type with proper type checking
      // Based on debug logs: system.details.type.value contains the actual value
      let creatureType =
        system.details?.type?.value ??
        system.details?.type ??
        system.type?.value ??
        system.type ??
        system.race?.value ??
        system.race ??
        system.details?.race ??
        'unknown';

      // Handle null/undefined values properly
      if (creatureType === null || creatureType === undefined || creatureType === '') {
        creatureType = 'unknown';
      }

      // Ensure creatureType is a string before calling toLowerCase()
      if (typeof creatureType !== 'string') {
        creatureType = String(creatureType || 'unknown');
      }

      // Extract size with proper type checking
      let size =
        system.traits?.size?.value ||
        system.traits?.size ||
        system.size?.value ||
        system.size ||
        system.details?.size ||
        'medium';

      // Ensure size is a string
      if (typeof size !== 'string') {
        size = String(size || 'medium');
      }

      // Extract hit points with more fallbacks
      const hitPoints =
        system.attributes?.hp?.max ||
        system.hp?.max ||
        system.attributes?.hp?.value ||
        system.hp?.value ||
        system.health?.max ||
        system.health?.value ||
        0;

      // Extract armor class with more fallbacks
      const armorClass =
        system.attributes?.ac?.value ||
        system.ac?.value ||
        system.attributes?.ac ||
        system.ac ||
        system.armor?.value ||
        system.armor ||
        10;

      // Extract alignment with proper type checking
      let alignment =
        system.details?.alignment?.value ||
        system.details?.alignment ||
        system.alignment?.value ||
        system.alignment ||
        'unaligned';

      // Ensure alignment is a string
      if (typeof alignment !== 'string') {
        alignment = String(alignment || 'unaligned');
      }

      // Check for spells with more comprehensive detection
      const hasSpells = !!(
        system.spells ||
        system.attributes?.spellcasting ||
        (system.details?.spellLevel && system.details.spellLevel > 0) ||
        (system.resources?.spell && system.resources.spell.max > 0) ||
        system.spellcasting ||
        system.traits?.spellcasting ||
        system.details?.spellcaster
      );

      // Check for legendary actions with more comprehensive detection
      const hasLegendaryActions = !!(
        system.resources?.legact ||
        system.legendary ||
        (system.resources?.legres && system.resources.legres.value > 0) ||
        system.details?.legendary ||
        system.traits?.legendary ||
        (system.resources?.legendary && system.resources.legendary.max > 0)
      );

      // DEBUG: Log what we extracted for comparison

      // Successful extraction
      return {
        creature: {
          id: doc._id,
          name: doc.name,
          type: doc.type,
          pack: pack.metadata.id,
          packLabel: pack.metadata.label,
          challengeRating,
          creatureType: creatureType.toLowerCase(),
          size: size.toLowerCase(),
          hitPoints,
          armorClass,
          hasSpells,
          hasLegendaryActions,
          alignment: alignment.toLowerCase(),
          description: doc.system?.details?.biography || doc.system?.description || '',
          img: doc.img,
        },
        errors: 0,
      };
    } catch (error) {
      console.warn(`[${this.moduleId}] Failed to extract enhanced data from ${doc.name}:`, error);

      // Return a basic fallback record with error count instead of null to avoid losing creatures
      return {
        creature: {
          id: doc._id,
          name: doc.name,
          type: doc.type,
          pack: pack.metadata.id,
          packLabel: pack.metadata.label,
          challengeRating: 0,
          creatureType: 'unknown',
          size: 'medium',
          hitPoints: 1,
          armorClass: 10,
          hasSpells: false,
          hasLegendaryActions: false,
          alignment: 'unaligned',
          description: 'Data extraction failed',
          img: doc.img || '',
        },
        errors: 1,
      };
    }
  }

  /**
   * Build Pathfinder 2e enhanced creature index
   */
  private async buildPF2eIndex(_force = false): Promise<PF2eCreatureIndex[]> {
    this.buildInProgress = true;

    const startTime = Date.now();
    let progressNotification: any = null;
    let totalErrors = 0;

    try {
      const actorPacks = Array.from(game.packs.values()).filter(
        pack => pack.metadata.type === 'Actor'
      );
      const enhancedCreatures: PF2eCreatureIndex[] = [];
      const packFingerprints = new Map<string, PackFingerprint>();

      ui.notifications?.info(
        `Starting PF2e creature index build from ${actorPacks.length} packs...`
      );

      let currentPack = 0;
      for (const pack of actorPacks) {
        currentPack++;

        if (progressNotification) {
          progressNotification.remove();
        }
        progressNotification = ui.notifications?.info(
          `Building PF2e index: Pack ${currentPack}/${actorPacks.length} (${pack.metadata.label})...`
        );

        const fingerprint = await this.generatePackFingerprint(pack);
        packFingerprints.set(pack.metadata.id, fingerprint);

        const result = await this.extractPF2eDataFromPack(pack);
        enhancedCreatures.push(...result.creatures);
        totalErrors += result.errors;
      }

      if (progressNotification) {
        progressNotification.remove();
      }
      ui.notifications?.info(
        `Saving PF2e index to world database... (${enhancedCreatures.length} creatures)`
      );

      const persistentIndex: PersistentEnhancedIndex = {
        metadata: {
          version: this.INDEX_VERSION,
          timestamp: Date.now(),
          packFingerprints,
          totalCreatures: enhancedCreatures.length,
          gameSystem: 'pf2e', // Mark as PF2e index
        },
        creatures: enhancedCreatures,
      };

      await this.savePersistedIndex(persistentIndex);

      const buildTimeSeconds = Math.round((Date.now() - startTime) / 1000);
      const errorText = totalErrors > 0 ? ` (${totalErrors} extraction errors)` : '';
      const successMessage = `PF2e creature index complete! ${enhancedCreatures.length} creatures indexed from ${actorPacks.length} packs in ${buildTimeSeconds}s${errorText}`;

      ui.notifications?.info(successMessage);

      return enhancedCreatures;
    } catch (error) {
      if (progressNotification) {
        progressNotification.remove();
      }

      const errorMessage = `Failed to build PF2e creature index: ${error instanceof Error ? error.message : 'Unknown error'}`;
      console.error(`[${this.moduleId}] ${errorMessage}`);
      ui.notifications?.error(errorMessage);

      throw error;
    } finally {
      this.buildInProgress = false;

      if (progressNotification) {
        progressNotification.remove();
      }
    }
  }

  /**
   * Extract PF2e creature data from all documents in a pack
   */
  private async extractPF2eDataFromPack(
    pack: any
  ): Promise<{ creatures: PF2eCreatureIndex[]; errors: number }> {
    const creatures: PF2eCreatureIndex[] = [];
    let errors = 0;

    try {
      const documents = await pack.getDocuments();

      for (const doc of documents) {
        try {
          // Support NPCs, characters, and creatures
          if (doc.type !== 'npc' && doc.type !== 'character' && doc.type !== 'creature') {
            continue;
          }

          const result = this.extractPF2eCreatureData(doc, pack);
          if (result) {
            creatures.push(result.creature);
            errors += result.errors;
          }
        } catch (error) {
          console.warn(
            `[${this.moduleId}] Failed to extract PF2e data from ${doc.name} in ${pack.metadata.label}:`,
            error
          );
          errors++;
        }
      }
    } catch (error) {
      console.warn(
        `[${this.moduleId}] Failed to load documents from ${pack.metadata.label}:`,
        error
      );
      errors++;
    }

    return { creatures, errors };
  }

  /**
   * Extract Pathfinder 2e creature data from a single document
   */
  private extractPF2eCreatureData(
    doc: any,
    pack: any
  ): { creature: PF2eCreatureIndex; errors: number } | null {
    try {
      const system = doc.system || {};

      // Level extraction (PF2e primary power metric)
      let level = system.details?.level?.value ?? 0;
      level = Number(level) || 0;

      // Traits extraction (PF2e uses array of traits)
      const traitsValue = system.traits?.value || [];
      const traits = Array.isArray(traitsValue) ? traitsValue : [];

      // Extract primary creature type from traits
      const creatureTraits = [
        'aberration',
        'animal',
        'beast',
        'celestial',
        'construct',
        'dragon',
        'elemental',
        'fey',
        'fiend',
        'fungus',
        'humanoid',
        'monitor',
        'ooze',
        'plant',
        'undead',
      ];
      const creatureType =
        traits.find((t: string) => creatureTraits.includes(t.toLowerCase()))?.toLowerCase() ||
        'unknown';

      // Rarity extraction (PF2e specific)
      const rarity = system.traits?.rarity || 'common';

      // Size extraction
      let size = system.traits?.size?.value || 'med';
      // Normalize PF2e size values (tiny, sm, med, lg, huge, grg)
      const sizeMap: Record<string, string> = {
        tiny: 'tiny',
        sm: 'small',
        med: 'medium',
        lg: 'large',
        huge: 'huge',
        grg: 'gargantuan',
      };
      size = sizeMap[size.toLowerCase()] || 'medium';

      // Hit Points
      const hitPoints = system.attributes?.hp?.max || 0;

      // Armor Class
      const armorClass = system.attributes?.ac?.value || 10;

      // Spellcasting detection (PF2e uses spellcasting entries)
      const spellcasting = system.spellcasting || {};
      const hasSpells = Object.keys(spellcasting).length > 0;

      // Alignment
      let alignment = system.details?.alignment?.value || 'N';
      if (typeof alignment !== 'string') {
        alignment = String(alignment || 'N');
      }

      return {
        creature: {
          id: doc._id,
          name: doc.name,
          type: doc.type,
          pack: pack.metadata.id,
          packLabel: pack.metadata.label,
          level,
          traits,
          creatureType,
          rarity,
          size,
          hitPoints,
          armorClass,
          hasSpells,
          alignment: alignment.toUpperCase(),
          description: system.details?.publicNotes || system.details?.biography || '',
          img: doc.img,
        },
        errors: 0,
      };
    } catch (error) {
      console.warn(`[${this.moduleId}] Failed to extract PF2e data from ${doc.name}:`, error);

      // Fallback with error count
      return {
        creature: {
          id: doc._id,
          name: doc.name,
          type: doc.type,
          pack: pack.metadata.id,
          packLabel: pack.metadata.label,
          level: 0,
          traits: [],
          creatureType: 'unknown',
          rarity: 'common',
          size: 'medium',
          hitPoints: 1,
          armorClass: 10,
          hasSpells: false,
          alignment: 'N',
          description: 'Data extraction failed',
          img: doc.img || '',
        },
        errors: 1,
      };
    }
  }

  /**
   * Build Cosmere RPG (Plotweaver) enhanced creature index.
   *
   * Indexes `adversary`-type actors. Player characters are excluded —
   * they're individual sheets, not encounter material.
   */
  private async buildCosmereRpgIndex(_force = false): Promise<CosmereRpgCreatureIndex[]> {
    this.buildInProgress = true;

    const startTime = Date.now();
    let progressNotification: any = null;
    let totalErrors = 0;

    try {
      const actorPacks = Array.from(game.packs.values()).filter(
        pack => pack.metadata.type === 'Actor'
      );
      const enhancedCreatures: CosmereRpgCreatureIndex[] = [];
      const packFingerprints = new Map<string, PackFingerprint>();

      ui.notifications?.info(
        `Starting Cosmere RPG creature index build from ${actorPacks.length} packs...`
      );

      for (let i = 0; i < actorPacks.length; i++) {
        const pack = actorPacks[i];
        const progressPercent = Math.round((i / actorPacks.length) * 100);

        if (i % 3 === 0 || pack.metadata.label.toLowerCase().includes('adversar')) {
          if (progressNotification) {
            progressNotification.remove();
          }
          progressNotification = ui.notifications?.info(
            `Building creature index... ${progressPercent}% (${i + 1}/${actorPacks.length}) Processing: ${pack.metadata.label}`
          );
        }

        try {
          if (!pack.indexed) {
            await pack.getIndex({});
          }

          packFingerprints.set(pack.metadata.id, this.generatePackFingerprint(pack));

          const packResult = await this.extractCosmereRpgDataFromPack(pack);
          enhancedCreatures.push(...packResult.creatures);
          totalErrors += packResult.errors;

          if (i === 0 || (i + 1) % 5 === 0 || i === actorPacks.length - 1) {
            const totalCreaturesSoFar = enhancedCreatures.length;
            if (progressNotification) {
              progressNotification.remove();
            }
            progressNotification = ui.notifications?.info(
              `Index Progress: ${i + 1}/${actorPacks.length} packs complete, ${totalCreaturesSoFar} creatures indexed`
            );
          }
        } catch (error) {
          console.warn(`[${this.moduleId}] Failed to process pack ${pack.metadata.label}:`, error);
          ui.notifications?.warn(
            `Warning: Failed to index pack "${pack.metadata.label}" - continuing with other packs`
          );
        }
      }

      if (progressNotification) {
        progressNotification.remove();
      }
      ui.notifications?.info(
        `Saving enhanced index to world database... (${enhancedCreatures.length} creatures)`
      );

      const persistentIndex: PersistentEnhancedIndex = {
        metadata: {
          version: this.INDEX_VERSION,
          timestamp: Date.now(),
          packFingerprints,
          totalCreatures: enhancedCreatures.length,
          gameSystem: 'cosmere-rpg',
        },
        creatures: enhancedCreatures,
      };

      await this.savePersistedIndex(persistentIndex);

      const buildTimeSeconds = Math.round((Date.now() - startTime) / 1000);
      const errorText = totalErrors > 0 ? ` (${totalErrors} extraction errors)` : '';
      const successMessage = `Cosmere RPG creature index complete! ${enhancedCreatures.length} creatures indexed from ${actorPacks.length} packs in ${buildTimeSeconds}s${errorText}`;

      ui.notifications?.info(successMessage);

      return enhancedCreatures;
    } catch (error) {
      if (progressNotification) {
        progressNotification.remove();
      }

      const errorMessage = `Failed to build Cosmere RPG creature index: ${error instanceof Error ? error.message : 'Unknown error'}`;
      console.error(`[${this.moduleId}] ${errorMessage}`);
      ui.notifications?.error(errorMessage);

      throw error;
    } finally {
      this.buildInProgress = false;
      if (progressNotification) {
        progressNotification.remove();
      }
    }
  }

  // ─── mgt2e index builder ────────────────────────────────────────────────────

  private calcMGT2eDM(value: number): number {
    if (value <= 0) return -3;
    if (value <= 2) return -2; // matches calcDM() in mcp-server constants.ts
    if (value <= 5) return -1;
    if (value <= 8) return 0;
    if (value <= 11) return 1;
    if (value <= 14) return 2;
    return 3;
  }

  private async buildMGT2eIndex(_force = false): Promise<MGT2eCreatureIndex[]> {
    this.buildInProgress = true;
    const startTime = Date.now();
    let progressNotification: any = null;
    let totalErrors = 0;

    try {
      const actorPacks = Array.from(game.packs.values()).filter(
        pack => pack.metadata.type === 'Actor'
      );
      const enhancedCreatures: MGT2eCreatureIndex[] = [];
      const packFingerprints = new Map<string, PackFingerprint>();

      ui.notifications?.info(
        `Starting Traveller creature index build from ${actorPacks.length} packs...`
      );

      for (let i = 0; i < actorPacks.length; i++) {
        const pack = actorPacks[i];
        if (!pack.indexed) await pack.getIndex({});
        packFingerprints.set(pack.metadata.id, this.generatePackFingerprint(pack));

        if (i % 3 === 0) {
          if (progressNotification) progressNotification.remove();
          progressNotification = ui.notifications?.info(
            `Building Traveller index... ${Math.round((i / actorPacks.length) * 100)}% — ${pack.metadata.label}`
          );
        }

        try {
          const result = await this.extractMGT2eDataFromPack(pack);
          enhancedCreatures.push(...result.creatures);
          totalErrors += result.errors;
        } catch (error) {
          console.warn(`[${this.moduleId}] Failed to process pack ${pack.metadata.label}:`, error);
        }
      }

      if (progressNotification) progressNotification.remove();

      const persistentIndex: PersistentEnhancedIndex = {
        metadata: {
          version: this.INDEX_VERSION,
          timestamp: Date.now(),
          packFingerprints,
          totalCreatures: enhancedCreatures.length,
          gameSystem: 'mgt2e',
        },
        creatures: enhancedCreatures,
      };

      await this.savePersistedIndex(persistentIndex);

      const secs = Math.round((Date.now() - startTime) / 1000);
      const errText = totalErrors > 0 ? ` (${totalErrors} errors)` : '';
      ui.notifications?.info(
        `Traveller creature index complete! ${enhancedCreatures.length} actors indexed in ${secs}s${errText}`
      );

      return enhancedCreatures;
    } catch (error) {
      if (progressNotification) progressNotification.remove();
      const msg = `Failed to build Traveller creature index: ${error instanceof Error ? error.message : 'Unknown error'}`;
      console.error(`[${this.moduleId}] ${msg}`);
      ui.notifications?.error(msg);
      throw error;
    } finally {
      this.buildInProgress = false;
      if (progressNotification) progressNotification.remove();
    }
  }

  private async extractMGT2eDataFromPack(
    pack: any
  ): Promise<{ creatures: MGT2eCreatureIndex[]; errors: number }> {
    const creatures: MGT2eCreatureIndex[] = [];
    let errors = 0;

    try {
      const documents = await pack.getDocuments();
      for (const doc of documents) {
        // Index creature, npc and traveller actor types
        if (!['creature', 'npc', 'traveller'].includes(doc.type)) continue;

        try {
          const system = (doc as any).system ?? {};
          const chars = system.characteristics ?? {};
          const charMap: Record<string, { value: number; dm: number }> = {};
          for (const [k, v] of Object.entries(chars)) {
            const val = typeof v === 'object' ? ((v as any).value ?? 0) : (v as number);
            charMap[k.toUpperCase()] = { value: val, dm: this.calcMGT2eDM(val) };
          }

          const hitsMax =
            typeof system.hits === 'object'
              ? (system.hits.max ?? system.hits.value ?? 0)
              : (system.hits ?? 0);

          const hasPsionics = (charMap['PSI']?.value ?? 0) > 0;
          const creatureType = system.details?.type ?? system.details?.creatureType ?? '';

          creatures.push({
            id: doc.id,
            name: doc.name,
            type: doc.type,
            pack: pack.collection,
            packLabel: pack.metadata?.label ?? pack.collection,
            hits: hitsMax,
            creatureType,
            hasPsionics,
            characteristics: charMap,
            img: (doc as any).img,
          });
        } catch {
          errors++;
        }
      }
    } catch {
      errors++;
    }

    return { creatures, errors };
  }

  /**
   * Extract Cosmere RPG creatures from a single pack.
   */
  private async extractCosmereRpgDataFromPack(
    pack: any
  ): Promise<{ creatures: CosmereRpgCreatureIndex[]; errors: number }> {
    const creatures: CosmereRpgCreatureIndex[] = [];
    let errors = 0;

    try {
      const documents = await pack.getDocuments();

      for (const doc of documents) {
        try {
          if (doc.type !== 'adversary') {
            continue;
          }

          const result = this.extractCosmereRpgCreatureData(doc, pack);
          if (result) {
            creatures.push(result.creature);
            errors += result.errors;
          }
        } catch (error) {
          console.warn(
            `[${this.moduleId}] Failed to extract Cosmere RPG data from ${doc.name} in ${pack.metadata.label}:`,
            error
          );
          errors++;
        }
      }
    } catch (error) {
      console.warn(
        `[${this.moduleId}] Failed to load documents from ${pack.metadata.label}:`,
        error
      );
      errors++;
    }

    return { creatures, errors };
  }

  /**
   * Resolve a Cosmere DerivedValueField (`{value, derived, override?, useOverride, bonus?}`).
   * Honours `useOverride: true` so manually-typed values (like Investiture max
   * on a sheet the system can't auto-derive) come through correctly.
   */
  private readDerived(field: any): number | undefined {
    if (field == null) return undefined;
    if (typeof field === 'number') return field;
    if (typeof field === 'object') {
      if (field.useOverride === true && typeof field.override === 'number') {
        return field.override;
      }
      if (typeof field.value === 'number') return field.value;
      if (typeof field.derived === 'number') return field.derived;
    }
    return undefined;
  }

  /**
   * Extract a single Cosmere RPG adversary into the creature index format.
   */
  private extractCosmereRpgCreatureData(
    doc: any,
    pack: any
  ): { creature: CosmereRpgCreatureIndex; errors: number } | null {
    try {
      const system = doc.system ?? {};

      const tier = typeof system.tier === 'number' ? system.tier : 0;
      const role =
        typeof system.role === 'string' && system.role.length > 0
          ? system.role.toLowerCase()
          : 'unknown';

      const size =
        typeof system.size === 'string' && system.size.length > 0
          ? system.size.toLowerCase()
          : 'medium';

      const creatureType =
        typeof system.type?.id === 'string' && system.type.id.length > 0
          ? system.type.id.toLowerCase()
          : 'unknown';

      const subtype =
        typeof system.type?.subtype === 'string' && system.type.subtype.length > 0
          ? system.type.subtype
          : '';

      const hitPoints = this.readDerived(system.resources?.hea?.max) ?? 0;
      const focus = this.readDerived(system.resources?.foc?.max) ?? 0;
      const investiture = this.readDerived(system.resources?.inv?.max) ?? 0;

      const defensePhysical = this.readDerived(system.defenses?.phy) ?? 0;
      const defenseCognitive = this.readDerived(system.defenses?.cog) ?? 0;
      const defenseSpiritual = this.readDerived(system.defenses?.spi) ?? 0;

      const deflect = this.readDerived(system.deflect) ?? 0;
      const walkSpeed = this.readDerived(system.movement?.walk?.rate) ?? 0;

      return {
        creature: {
          id: doc._id,
          name: doc.name,
          type: doc.type,
          pack: pack.metadata.id,
          packLabel: pack.metadata.label,
          tier,
          role,
          creatureType,
          subtype,
          size,
          hitPoints,
          focus,
          investiture,
          hasInvestiture: investiture > 0,
          defensePhysical,
          defenseCognitive,
          defenseSpiritual,
          deflect,
          walkSpeed,
          img: doc.img,
        },
        errors: 0,
      };
    } catch (error) {
      console.warn(
        `[${this.moduleId}] Failed to extract Cosmere RPG data from ${doc.name}:`,
        error
      );
      return {
        creature: {
          id: doc._id,
          name: doc.name,
          type: doc.type,
          pack: pack.metadata.id,
          packLabel: pack.metadata.label,
          tier: 0,
          role: 'unknown',
          creatureType: 'unknown',
          subtype: '',
          size: 'medium',
          hitPoints: 0,
          focus: 0,
          investiture: 0,
          hasInvestiture: false,
          defensePhysical: 0,
          defenseCognitive: 0,
          defenseSpiritual: 0,
          deflect: 0,
          walkSpeed: 0,
          description: 'Data extraction failed',
          img: doc.img || '',
        },
        errors: 1,
      };
    }
  }
}
