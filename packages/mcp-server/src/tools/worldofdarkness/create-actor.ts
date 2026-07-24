import { z } from 'zod';
import { FoundryClient } from '../../foundry-client.js';
import { Logger } from '../../logger.js';

export interface WoDCreateActorToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

const SPLATS = [
  'mage',
  'vampire',
  'werewolf',
  'changeling',
  'wraith',
  'hunter',
  'mortal',
  'creature',
] as const;

type Splat = (typeof SPLATS)[number];

const createActorSchema = z
  .object({
    name: z.string().min(1),
    splat: z.enum(SPLATS),
    actorType: z.string().min(1).default('PC'),
  })
  .strict();

// The 18 fixed capability flags (+ the two out-of-band creature flags).
const ALL_FLAGS = [
  'haswillpower',
  'hasvirtue',
  'hasrenown',
  'hasquintessence',
  'hasdisciplines',
  'hascombinationdisciplines',
  'hasrituals',
  'hasgifts',
  'hasrites',
  'hasshapes',
  'hasapocalypticforms',
  'hasspheres',
  'hasrotes',
  'hasresonances',
  'hasnuminas',
  'hasrealms',
  'haslores',
  'hasedges',
  'hasessence',
  'hascharms',
] as const;

// Which flags are true per game line (everything else defaults to false).
const FLAGS_BY_SPLAT: Record<Splat, string[]> = {
  mage: ['hasspheres', 'hasquintessence', 'haswillpower'],
  vampire: ['hasvirtue', 'haswillpower'],
  werewolf: ['hasrenown', 'haswillpower'],
  changeling: ['haswillpower'],
  wraith: ['haswillpower'],
  hunter: ['haswillpower'],
  mortal: ['haswillpower'],
  creature: ['haswillpower', 'hasessence', 'hascharms'],
};

function buildSettings(splat: Splat): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  for (const flag of ALL_FLAGS) settings[flag] = false;
  for (const flag of FLAGS_BY_SPLAT[splat]) settings[flag] = true;
  settings.splat = splat;
  settings.game = splat;
  settings.variant = '';
  settings.era = 'modern';
  return settings;
}

/**
 * `worldofdarkness-create-actor` — create a new World of Darkness actor with the
 * correct per-line capability flags so its sheet opens without error.
 */
export class WoDCreateActorTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor({ foundryClient, logger }: WoDCreateActorToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'WoDCreateActorTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'worldofdarkness-create-actor',
        description:
          '[worldofdarkness only] Create a new World of Darkness actor for the given splat ' +
          '(mage, vampire, werewolf, changeling, wraith, hunter, mortal, creature). Sets the ' +
          'correct system.settings capability flags for that line (e.g. vampire → virtue + ' +
          'willpower; mage → spheres + quintessence + willpower; creature → willpower + essence + ' +
          'charms) plus splat/game/variant, so the sheet opens cleanly. Add traits/powers ' +
          'afterwards with worldofdarkness-add-items.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'The new actor name.',
            },
            splat: {
              type: 'string',
              enum: [...SPLATS],
              description: 'Game line / character type.',
            },
            actorType: {
              type: 'string',
              description: 'Foundry actor type (default "PC").',
            },
          },
          required: ['name', 'splat'],
        },
      },
    ];
  }

  async handleCreateActor(args: unknown) {
    const parsed = createActorSchema.safeParse(args);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      return { success: false, error: `Invalid arguments: ${detail}` };
    }

    const { name, splat, actorType } = parsed.data;
    this.logger.info('Creating WoD actor', { name, splat, actorType });

    try {
      const result = await this.foundryClient.query('foundry-mcp-bridge.createActors', {
        actors: [
          {
            name,
            type: actorType,
            system: { settings: buildSettings(splat) },
          },
        ],
      });

      if (result?.success === false) {
        return { success: false, error: result.error ?? 'Failed to create actor' };
      }

      const created = Array.isArray(result?.created) ? result.created[0] : undefined;
      return {
        success: true,
        splat,
        actor: created ?? null,
      };
    } catch (error) {
      this.logger.error('Failed to create WoD actor', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }
}
