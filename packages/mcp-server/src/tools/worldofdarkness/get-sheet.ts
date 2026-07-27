import { z } from 'zod';
import { FoundryClient } from '../../foundry-client.js';
import { Logger } from '../../logger.js';
// Cross-track import: implemented by the systems/worldofdarkness adapter track.
// Signature: export function extractFullSheet(actorData: any, options?): any
import { extractFullSheet } from '../../systems/worldofdarkness/extract.js';

export interface WoDGetSheetToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

/**
 * `include` keys. `flags` and `prototypeToken` are answered by the MODULE (they
 * need a module deploy); `itemIds` is answered entirely server-side by
 * `extractFullSheet`, so it works against any module version.
 */
const INCLUDE_KEYS = ['flags', 'prototypeToken', 'itemIds'] as const;
type IncludeKey = (typeof INCLUDE_KEYS)[number];

/** The subset of `include` that the module has to honour for us. */
const MODULE_INCLUDE_KEYS: IncludeKey[] = ['flags', 'prototypeToken'];

/** Advertised by `handlePing` from module 0.9.3. */
const MODULE_CAPABILITY_INCLUDE = 'getCharacterInfo.include';

// NOTE the schema is `.strict()`: before this change, passing `include` was
// REJECTED, so adding the key is a deliberate schema extension and not something
// a caller could already have been doing.
const getSheetSchema = z
  .object({
    actor: z.string().min(1),
    include: z.array(z.enum(INCLUDE_KEYS)).optional(),
  })
  .strict();

/**
 * `worldofdarkness-get-sheet` — read a World of Darkness actor and return the full
 * structured sheet (attributes, abilities, willpower, pools, virtues, powers,
 * merits, backgrounds, health, bio, …). READ-ONLY.
 *
 * The sheet also carries the actor's art (`img`, `isDefaultImg`, and — on request
 * — the prototype-token texture) and, on request, its `flags`. That combination
 * is what makes a single sheet read sufficient to verify an import end to end:
 * portrait, token art and provenance, with no scene token and no write probe.
 */
export class WoDGetSheetTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor({ foundryClient, logger }: WoDGetSheetToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'WoDGetSheetTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'worldofdarkness-get-sheet',
        description:
          '[worldofdarkness only] Read a World of Darkness actor and return its full structured ' +
          'sheet: the nine attributes, abilities (talents/skills/knowledges), willpower, pools ' +
          '(rage, gnosis, blood, quintessence, glamour, essence, …), virtues, powers ' +
          '(disciplines/gifts/spheres/charms), merits, flaws, backgrounds, health track and bio. ' +
          'Also returns the actor id and its real portrait path ("img", plus "isDefaultImg" — true ' +
          "when there is no portrait or it is still Foundry's placeholder). Use " +
          'include: ["prototypeToken","flags"] to also get the token texture path and the actor\'s ' +
          'flags (e.g. flags.wodchar.sourceId) — enough to VERIFY AN IMPORT end to end (portrait, ' +
          'token, provenance) without needing a token placed on a scene and without a write probe. ' +
          'include: ["itemIds"] adds each embedded item\'s id so the sheet can feed manage-actors ' +
          'update-items / delete-items directly. ' +
          'READ-ONLY — makes no changes. USE THIS to inspect a character before rolling or editing.',
        inputSchema: {
          type: 'object',
          properties: {
            actor: {
              type: 'string',
              description: 'Actor name or 16-character Foundry id',
            },
            include: {
              type: 'array',
              items: { type: 'string', enum: [...INCLUDE_KEYS] },
              description:
                'Optional extras, omitted by default to keep the sheet small: ' +
                '"prototypeToken" (token texture path/scale/ring), "flags" (provenance, e.g. ' +
                'flags.wodchar.sourceId), "itemIds" (Foundry id of every embedded item). ' +
                '"prototypeToken"/"flags" need Foundry MCP Bridge module 0.9.3+; against an older ' +
                'module the request is refused rather than answered with silently missing fields.',
            },
          },
          required: ['actor'],
        },
      },
    ];
  }

  async handleGetSheet(args: unknown) {
    const parsed = getSheetSchema.safeParse(args);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      return { success: false, error: `Invalid arguments: ${detail}` };
    }

    const { actor, include } = parsed.data;
    const requested: IncludeKey[] = include ?? [];
    const moduleIncludes = MODULE_INCLUDE_KEYS.filter(k => requested.includes(k));
    this.logger.info('Reading WoD sheet', { actor, include: requested });

    try {
      // A module too old to understand `include` DROPS it and answers with no
      // `flags` / `prototypeToken` at all. That response is indistinguishable
      // from "this actor has no provenance and no token art" — a plausible,
      // wrong answer to the exact question the caller asked. Refuse instead,
      // exactly as `worldofdarkness-import-actor` refuses `dryRun`.
      if (moduleIncludes.length > 0) {
        const gate = await this.assertIncludeSupported(moduleIncludes);
        if (gate !== null) return gate;
      }

      const found = await this.foundryClient.query('foundry-mcp-bridge.findActor', {
        identifier: actor,
      });
      if (!found || !found.id) {
        return { success: false, error: `Actor not found: ${actor}` };
      }

      const actorData = await this.foundryClient.query('foundry-mcp-bridge.getCharacterInfo', {
        characterId: found.id,
        // Only sent when asked for, so an unchanged call is byte-identical on the wire.
        ...(moduleIncludes.length > 0 ? { include: moduleIncludes } : {}),
      });
      if (!actorData || actorData.success === false) {
        return { success: false, error: actorData?.error ?? `Failed to read actor: ${actor}` };
      }

      const sheet = extractFullSheet(actorData, {
        includeItemIds: requested.includes('itemIds'),
      });

      // Belt and braces behind the capability gate: report what the module
      // actually honoured rather than letting a missing field imply a fact.
      const honoured: string[] = Array.isArray(actorData.included) ? actorData.included : [];
      const dropped = moduleIncludes.filter(k => !honoured.includes(k));

      return {
        success: true,
        sheet,
        ...(requested.length > 0 ? { include: requested } : {}),
        ...(dropped.length > 0
          ? {
              warning:
                `The connected module did not confirm include: ${dropped.join(', ')}. ` +
                'Those fields may be missing from the sheet even though the actor carries them — ' +
                'do not read their absence as fact. Update the Foundry module and reload as GM.',
            }
          : {}),
      };
    } catch (error) {
      this.logger.error('Failed to read WoD sheet', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Refuse module-answered `include` keys unless the connected module advertises
   * the capability. Returns `null` when supported, or the error envelope.
   *
   * The server bundle and the Foundry module deploy independently, so a NEW
   * server routinely talks to an OLD module.
   */
  private async assertIncludeSupported(
    keys: IncludeKey[]
  ): Promise<{ success: false; error: string } | null> {
    try {
      const pong = await this.foundryClient.query('foundry-mcp-bridge.ping', undefined, 10000);
      const caps: unknown = pong?.capabilities;
      if (Array.isArray(caps) && caps.includes(MODULE_CAPABILITY_INCLUDE)) return null;
      return {
        success: false,
        error:
          `include: [${keys.join(', ')}] refused: the connected Foundry MCP Bridge module does ` +
          `not advertise "${MODULE_CAPABILITY_INCLUDE}" (module version ` +
          `${pong?.moduleVersion ?? 'unknown'}). An older module silently drops the option and ` +
          'answers with those fields missing, which is indistinguishable from the actor not ' +
          'having them — so nothing is reported rather than reporting a guess. Update the ' +
          'Foundry module and reload the world as GM, or call without `include` ' +
          '(the sheet still carries `img` and `isDefaultImg`).',
      };
    } catch (error) {
      return {
        success: false,
        error: `include: [${keys.join(', ')}] refused: could not confirm module capabilities — ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      };
    }
  }
}
