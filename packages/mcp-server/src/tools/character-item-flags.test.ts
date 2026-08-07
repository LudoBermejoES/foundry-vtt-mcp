/**
 * `manage-world-items` action:"add-to-actor" — the OTHER surface over
 * `foundry-mcp-bridge.addActorItems`.
 *
 * `manage-actors` action:"create-items" documents itself as "identical shape to
 * manage-world-items action:'add-to-actor'", and both send the same payload to
 * the same bridge query. When `flags` became carriable, the two had to stay
 * identical: a zod object STRIPS undeclared keys, so a `flags` added to only one
 * of them would be dropped silently on the other — with no error, and an item
 * that looks created and renders with no description.
 *
 * Note the asymmetry these tests also pin: `handleCreateWorldItems` (action:
 * "create") ALREADY accepted `flags` in its zod schema, but the shared JSON
 * `items` schema never advertised it. Advertising it fixes both actions at once.
 */

import { describe, it, expect, vi } from 'vitest';
import { CharacterTools } from './character.js';

function makeTools() {
  const calls: Array<{ method: string; data: any }> = [];
  const query = vi.fn(async (method: string, data: any) => {
    calls.push({ method, data });
    return { actorName: 'Otto Von Grugger', created: [] };
  });
  const logger: any = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  logger.child = () => logger;
  const tools = new CharacterTools({ foundryClient: { query } as any, logger });
  return { tools, calls };
}

function itemsSchema() {
  const { tools } = makeTools();
  const def = tools.getToolDefinitions().find((t: any) => t.name === 'manage-world-items') as any;
  return def.inputSchema.properties.items;
}

const PROVENANCE = {
  'wod20-char': { id: 'mage/instrument/musica', line: 'mage', sourceType: 'instrument' },
};

// ─── what an agent can SEE ───────────────────────────────────────────────────

describe('the shared items schema advertises flags', () => {
  it('lists flags as an optional free-form object beside name/type/img/system', () => {
    const items = itemsSchema();

    expect(Object.keys(items.items.properties).sort()).toEqual([
      'flags',
      'img',
      'name',
      'system',
      'type',
    ]);
    expect(items.items.required).toEqual(['name', 'type']);
    expect(items.items.properties.flags.type).toBe('object');
    expect(items.items.properties.flags.additionalProperties).toBe(true);
  });
});

// ─── what actually reaches the bridge ────────────────────────────────────────

describe('add-to-actor carries flags through to addActorItems', () => {
  it('forwards caller-supplied flags verbatim', async () => {
    const { tools, calls } = makeTools();

    await tools.handleManageWorldItems({
      action: 'add-to-actor',
      actorIdentifier: 'Otto Von Grugger',
      items: [{ name: 'Música', type: 'Feature', system: { description: '' }, flags: PROVENANCE }],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('foundry-mcp-bridge.addActorItems');
    expect(calls[0].data.items).toEqual([
      { name: 'Música', type: 'Feature', system: { description: '' }, flags: PROVENANCE },
    ]);
  });

  it('sends no flags key when the caller supplies none', async () => {
    const { tools, calls } = makeTools();

    await tools.handleManageWorldItems({
      action: 'add-to-actor',
      actorIdentifier: 'Lena',
      items: [{ name: 'Notes', type: 'Feature' }],
    });

    const sent = calls[0].data.items[0];
    expect(Object.keys(sent).sort()).toEqual(['name', 'type']);
    expect('flags' in sent).toBe(false);
  });

  it.each([
    ['an array', [{ 'wod20-char': {} }]],
    ['null', null],
    ['a string', 'wod20-char'],
  ])('rejects a malformed flags (%s) before touching the bridge', async (_label, flags) => {
    const { tools, calls } = makeTools();

    await expect(
      tools.handleManageWorldItems({
        action: 'add-to-actor',
        actorIdentifier: 'Lena',
        items: [{ name: 'Notes', type: 'Feature', flags }],
      })
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});
