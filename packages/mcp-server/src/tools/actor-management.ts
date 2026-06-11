/**
 * Actor Management Tools
 *
 * Generic CRUD operations for Foundry Actor documents and their embedded Items.
 * Works with any game system and any actor type — no hardcoded types.
 *
 * Actor actions:  create, update, delete
 * Item actions:   update-items, delete-items  (embedded items on an actor)
 * Listing actors is handled by the existing list-characters tool.
 * Adding items is handled by manage-world-items → add-to-actor.
 */

import { z } from 'zod';
import { FoundryClient } from '../foundry-client.js';
import { Logger } from '../logger.js';
import { detectGameSystem } from '../utils/system-detection.js';

// ── mgt2e skill normalisation ─────────────────────────────────────────────────

/**
 * Skills that have named specialities in mgt2e.
 * The first entry in each array is the *primary* speciality used when expanding
 * a bare number shorthand (e.g. `{ pilot: 2 }`).
 */
export const MGT2E_SKILL_SPECS: Record<string, string[]> = {
  animals: ['handling', 'veterinary', 'training'],
  art: ['performer', 'holography', 'instrument', 'visualMedia', 'write'],
  athletics: ['dexterity', 'endurance', 'strength'],
  drive: ['hovercraft', 'mole', 'track', 'walker', 'wheel'],
  electronics: ['comms', 'computers', 'remoteOps', 'sensors'],
  engineer: ['mDrive', 'jDrive', 'lifeSupport', 'power'],
  flyer: ['airship', 'grav', 'ornithopter', 'rotor', 'wing'],
  gunner: ['turret', 'ortillery', 'screen', 'capital'],
  guncombat: ['archaic', 'energy', 'slug'],
  heavyweapons: ['artillery', 'portable', 'vehicle'],
  melee: ['unarmed', 'blade', 'bludgeon', 'natural'],
  pilot: ['smallCraft', 'spacecraft', 'capitalShips'],
  seafarer: ['oceanShips', 'personal', 'sail', 'submarine'],
  tactics: ['military', 'naval'],
};

/**
 * Normalize mgt2e skill keys and expand shorthands before sending to Foundry.
 *
 * Runs server-side (Node.js) so it's never affected by browser module cache.
 *
 * SIMPLE SKILLS (admin, carouse, stealth, …):
 *   mgt2e DataModel requires `id` to store value; otherwise level stays 0.
 *   `{ admin: 3 }`          →  `{ id:'admin', value:3, trained:true }`
 *   `{ admin: {value:3} }`  →  `{ id:'admin', value:3 }`
 *
 * SPEC-SKILLS (guncombat, pilot, heavyweapons, …):
 *   _prepareDerivedData() overrides parent.value with min(active spec values).
 *   Number shorthand sets parent value AND the primary speciality.
 *   `{ pilot: 2 }`  →  `{ value:2, trained:true, specialities:{ smallCraft:{value:2,trained:true} } }`
 *   Object with specialities: spread-merged (adding id would corrupt the DataModel).
 *   Object without specialities: id injected so simple-skill level persists.
 */
export function normalizeMGT2eSkillsInSystem(system: Record<string, any>): Record<string, any> {
  const normalizeSpecValues = (specs: Record<string, any>): Record<string, any> => {
    const result: Record<string, any> = {};
    for (const [k, v] of Object.entries(specs)) {
      result[k] = typeof v === 'number' ? { value: v, trained: v > 0 } : v;
    }
    return result;
  };

  const normalizeSkillEntry = (sk: string, sv: any): any => {
    const defaultSpecs = MGT2E_SKILL_SPECS[sk];
    const isSpecSkill = defaultSpecs !== undefined;
    if (typeof sv === 'number') {
      if (isSpecSkill) {
        // Set both the parent stored value AND the primary spec.
        // mgt2e displays the stored parent value; no id to avoid DataModel corruption.
        return {
          value: sv,
          trained: sv > 0,
          specialities: { [defaultSpecs[0]]: { value: sv, trained: sv > 0 } },
        };
      } else {
        return { id: sk, value: sv, trained: sv > 0 };
      }
    } else if (sv && typeof sv === 'object') {
      if (sv.specialities && typeof sv.specialities === 'object') {
        return { ...sv, specialities: normalizeSpecValues(sv.specialities) };
      } else {
        return { id: (sv as any).id ?? sk, ...sv };
      }
    }
    return sv;
  };

  const result: Record<string, any> = {};
  for (const [key, val] of Object.entries(system)) {
    if (key === 'skills' && val && typeof val === 'object' && !Array.isArray(val)) {
      const normalized: Record<string, any> = {};
      for (const [sk, sv] of Object.entries(val as Record<string, any>)) {
        const lk = sk.toLowerCase();
        normalized[lk] = normalizeSkillEntry(lk, sv);
      }
      result['skills'] = normalized;
    } else if (key.startsWith('skills.-=')) {
      result[`skills.-=${key.slice('skills.-='.length).toLowerCase()}`] = val;
    } else if (key.startsWith('skills.')) {
      const rest = key.slice('skills.'.length);
      const dotIdx = rest.indexOf('.');
      if (dotIdx === -1) {
        result[`skills.${rest.toLowerCase()}`] = val;
      } else {
        const skillKey = rest.substring(0, dotIdx).toLowerCase();
        const subPath = rest.substring(dotIdx);
        result[`skills.${skillKey}${subPath}`] = val;
      }
    } else {
      result[key] = val;
    }
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────

export interface ActorManagementToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

export class ActorManagementTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor({ foundryClient, logger }: ActorManagementToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'ActorManagementTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'manage-actors',
        description:
          'Create, update, or delete Actor documents in Foundry VTT. Works with any game system.\n' +
          '- "create": Create one or more actors of any type with arbitrary system data.\n' +
          '  mgt2e valid actor types: traveller, npc, creature, spacecraft, vehicle, world, package, swarm.\n' +
          '- "update": Update one or more existing actors by ID. Merges into existing system data.\n' +
          '- "delete": Permanently delete one or more actors by ID.\n' +
          '\n' +
          'mgt2e DATA MODEL NOTES:\n' +
          '• Characteristics for traveller/npc — two formats accepted:\n' +
          '  Full: { STR:{value:8,show:true}, DEX:{value:9,show:true}, ... } (show:true added automatically)\n' +
          '  Shorthand: { str:8, dex:9, end:7, int:8, edu:10, soc:7 } — uppercase + show:true applied automatically.\n' +
          '  Hits (STR+DEX+END) are calculated automatically if omitted.\n' +
          '• Skills for traveller/npc — two formats accepted:\n' +
          '  Shorthand: { pilot:2, medic:1 } — sets level, marks as trained automatically.\n' +
          '  Full: { pilot:{value:0,trained:true,specialities:{spacecraft:{value:2,trained:true}}} }\n' +
          '• Personal details live at system.sophont (NOT system.details — that path does not exist):\n' +
          '  { sophont: { species:"Human", gender:"M", age:34, profession:"Navy", homeworld:"Regina" } }\n' +
          '  Shorthand: system.details:{species,gender,age,career,homeworld} is remapped to sophont automatically.\n' +
          '• Creature behaviour: system.behaviour = "carnivore pouncer" (space-separated lowercase keys)\n' +
          '  Valid keys: herbivore, omnivore, carnivore, scavenger, pouncer, chaser, killer, siren, etc.\n' +
          '• Creature traits: system.traits = "camouflaged, tough, flyer 3" (comma-separated string)\n' +
          '\n' +
          'mgt2e ITEM RESTRICTIONS (what can go on which actor type):\n' +
          '• traveller: weapon, armour, augment, term, associate, item, software — NOT cargo/hardware/role/worlddata\n' +
          '• npc: weapon, armour, augment, item, software — NOT term/associate/cargo/hardware/role/worlddata\n' +
          '• creature: weapon, armour, augment, item, software — NOT term/associate/cargo/hardware/role/worlddata\n' +
          '• spacecraft: weapon, armour, augment, cargo, hardware, role, software, item — NOT term/associate/worlddata\n' +
          '• world: cargo, item, software, worlddata — NOT term/associate/role\n' +
          'NOTE: term and associate items are ONLY valid on traveller actors (not npc/creature).\n' +
          '\n' +
          'mgt2e HARDWARE ITEMS (for spacecraft):\n' +
          '  hardware.system discriminators: "drive" (j/m/r), "power", "bridge", "sensor", "armour",\n' +
          '    "weapon", "cargo", "stateroom", "fuel", "computer", "general"\n' +
          '  For correct tonnage display include: hardware.tonnage.tonCalc and hardware.tonnage.costCalc\n' +
          '  Ship weapon items need weapon.scale:"spacecraft" and weapon.power field.\n' +
          '\n' +
          'mgt2e SOFTWARE ITEMS — REQUIRED sub-object or the spacecraft sheet crashes:\n' +
          '  system: { software: { class:"spacecraft", type:"generic", interface:"none", bandwidth:N } }\n' +
          '  Bandwidth by type: Maneuver/0→0, Library/0→0, Jump Control/N→N*5,\n' +
          '    Fire Control/N→N*5, Auto-Repair/N→N*5, Evade/N→N*5.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['create', 'update', 'delete', 'update-items', 'delete-items'],
              description:
                'Operation to perform.\n' +
                '- "create" / "update" / "delete": actor-level CRUD.\n' +
                '- "update-items": update one or more items embedded in an actor (by item ID).\n' +
                '- "delete-items": permanently delete embedded items from an actor.',
            },
            // ── create ──────────────────────────────────────────────────────
            actors: {
              type: 'array',
              minItems: 1,
              description:
                'Required for "create". One or more actor definitions. ' +
                'Each must have a name and a type valid for the active game system.',
              items: {
                type: 'object',
                properties: {
                  name: {
                    type: 'string',
                    description: 'Display name of the actor.',
                  },
                  type: {
                    type: 'string',
                    description:
                      'Actor type as defined by the game system ' +
                      '(e.g. "traveller", "npc", "creature", "spacecraft", "vehicle", "world").',
                  },
                  img: {
                    type: 'string',
                    description: 'Optional icon/portrait path.',
                  },
                  system: {
                    type: 'object',
                    description:
                      'System-specific data. Free-form object — whatever fields the system accepts.\n' +
                      'mgt2e traveller examples:\n' +
                      '  characteristics: { STR:{value:8,show:true}, DEX:{value:9,show:true}, END:{value:7,show:true}, INT:{value:8,show:true}, EDU:{value:10,show:true}, SOC:{value:7,show:true} }\n' +
                      '  skills: { pilot:{value:2,trained:true}, medic:{value:1,trained:true} }\n' +
                      '  sophont: { species:"Human", profession:"Navy", age:34, homeworld:"Regina" }\n' +
                      'Skill with speciality: { engineer:{value:0,trained:true,specialities:{jDrive:{value:2,trained:true}}} }',
                    additionalProperties: true,
                  },
                },
                required: ['name', 'type'],
              },
            },
            folder: {
              type: 'string',
              description:
                'For "create": folder name/ID to place actors in (created if absent). ' +
                'Defaults to "Foundry MCP Actors".',
            },
            // ── update ──────────────────────────────────────────────────────
            updates: {
              type: 'array',
              minItems: 1,
              description:
                'Required for "update". One or more actor patches. ' +
                'Each entry must include "id" plus at least one field to change.',
              items: {
                type: 'object',
                properties: {
                  id: {
                    type: 'string',
                    description: 'ID of the actor to update.',
                  },
                  name: {
                    type: 'string',
                    description: 'New display name.',
                  },
                  img: {
                    type: 'string',
                    description: 'New icon/portrait path.',
                  },
                  system: {
                    type: 'object',
                    description:
                      'System-specific fields to update. Merged into the existing system data ' +
                      '(top-level keys only — nested objects replace, not merge). ' +
                      'Examples for mgt2e: { characteristics: {...}, skills: {...}, details: {...} }',
                    additionalProperties: true,
                  },
                },
                required: ['id'],
              },
            },
            // ── delete ──────────────────────────────────────────────────────
            ids: {
              type: 'array',
              items: { type: 'string' },
              minItems: 1,
              description: 'Required for "delete". IDs of the actors to delete.',
            },
            // ── update-items ─────────────────────────────────────────────────
            actorIdentifier: {
              type: 'string',
              description: 'Required for "update-items" and "delete-items". Actor name or ID.',
            },
            itemUpdates: {
              type: 'array',
              minItems: 1,
              description:
                'Required for "update-items". Patches for embedded items. ' +
                'Each entry must include the item "id" plus fields to change. ' +
                'The "system" object is merged at the top level.',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'ID of the embedded item.' },
                  name: { type: 'string', description: 'New display name.' },
                  img: { type: 'string', description: 'New icon path.' },
                  system: {
                    type: 'object',
                    additionalProperties: true,
                    description:
                      'System fields to update. Passed directly to Foundry — use the exact ' +
                      'field names the system expects. For mgt2e hardware use the "hardware" sub-object ' +
                      '(e.g. { hardware: { system: "drive", tons: 25, rating: 2, mount: "none", ... } })',
                  },
                },
                required: ['id'],
              },
            },
            // ── delete-items ─────────────────────────────────────────────────
            itemIds: {
              type: 'array',
              items: { type: 'string' },
              minItems: 1,
              description: 'Required for "delete-items". IDs of the embedded items to delete.',
            },
          },
          required: ['action'],
        },
      },
    ];
  }

  async handleManageActors(args: any): Promise<any> {
    const { action } = z
      .object({
        action: z.enum(['create', 'update', 'delete', 'update-items', 'delete-items']),
      })
      .parse(args);

    switch (action) {
      case 'create':
        return this.handleCreate(args);
      case 'update':
        return this.handleUpdate(args);
      case 'delete':
        return this.handleDelete(args);
      case 'update-items':
        return this.handleUpdateItems(args);
      case 'delete-items':
        return this.handleDeleteItems(args);
    }
  }

  // ── create ────────────────────────────────────────────────────────────────

  private async handleCreate(args: any): Promise<any> {
    const schema = z.object({
      actors: z
        .array(
          z.object({
            name: z.string().min(1),
            type: z.string().min(1),
            img: z.string().optional(),
            system: z.record(z.any()).optional(),
          })
        )
        .min(1),
      folder: z.string().optional(),
    });

    const { actors, folder } = schema.parse(args);

    this.logger.info('Creating actors', {
      count: actors.length,
      types: actors.map(a => a.type),
    });

    const result = await this.foundryClient.query('foundry-mcp-bridge.createActors', {
      actors,
      folder,
    });

    return result;
  }

  // ── update ────────────────────────────────────────────────────────────────

  private async handleUpdate(args: any): Promise<any> {
    const schema = z.object({
      updates: z
        .array(
          z.object({
            id: z.string().min(1),
            name: z.string().optional(),
            img: z.string().optional(),
            system: z.record(z.any()).optional(),
          })
        )
        .min(1),
    });

    const { updates } = schema.parse(args);

    this.logger.info('Updating actors', { count: updates.length });

    // mgt2e: normalize skill keys server-side to avoid Electron module cache issues
    const gameSystem = await detectGameSystem(this.foundryClient, this.logger);
    const normalizedUpdates =
      gameSystem === 'mgt2e'
        ? updates.map(u =>
            u.system !== undefined ? { ...u, system: normalizeMGT2eSkillsInSystem(u.system) } : u
          )
        : updates;

    const result = await this.foundryClient.query('foundry-mcp-bridge.updateActors', {
      updates: normalizedUpdates,
    });

    return result;
  }

  // ── delete ────────────────────────────────────────────────────────────────

  private async handleDelete(args: any): Promise<any> {
    const schema = z.object({
      ids: z.array(z.string().min(1)).min(1),
    });

    const { ids } = schema.parse(args);

    this.logger.info('Deleting actors', { count: ids.length });

    const result = await this.foundryClient.query('foundry-mcp-bridge.deleteActors', { ids });

    return result;
  }

  // ── update-items ────────────────────────────────────────────────────────────

  private async handleUpdateItems(args: any): Promise<any> {
    const schema = z.object({
      actorIdentifier: z.string().min(1),
      itemUpdates: z
        .array(
          z.object({
            id: z.string().min(1),
            name: z.string().optional(),
            img: z.string().optional(),
            system: z.record(z.any()).optional(),
          })
        )
        .min(1),
    });

    const { actorIdentifier, itemUpdates } = schema.parse(args);

    this.logger.info('Updating actor embedded items', {
      actorIdentifier,
      count: itemUpdates.length,
    });

    const result = await this.foundryClient.query('foundry-mcp-bridge.updateActorItems', {
      actorIdentifier,
      itemUpdates,
    });

    return result;
  }

  // ── delete-items ────────────────────────────────────────────────────────────

  private async handleDeleteItems(args: any): Promise<any> {
    const schema = z.object({
      actorIdentifier: z.string().min(1),
      itemIds: z.array(z.string().min(1)).min(1),
    });

    const { actorIdentifier, itemIds } = schema.parse(args);

    this.logger.info('Deleting actor embedded items', {
      actorIdentifier,
      count: itemIds.length,
    });

    const result = await this.foundryClient.query('foundry-mcp-bridge.deleteActorItems', {
      actorIdentifier,
      itemIds,
    });

    return result;
  }
}
