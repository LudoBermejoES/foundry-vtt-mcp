/**
 * `manage-actors` — "embedded-item creation SHALL be discoverable on the
 * actor-management surface".
 *
 * The point of this requirement is DISCOVERABILITY: creating an embedded item was
 * always possible (via `manage-world-items` action:"add-to-actor"), but the only
 * documentation of that lived in a source comment no agent ever reads, so the
 * surface offering update-items/delete-items looked like create was impossible.
 *
 * These tests therefore assert two different kinds of thing: what an agent can
 * SEE (the tool definition), and that the existing path is untouched.
 */

import { describe, it, expect, vi } from 'vitest';
import { ActorManagementTools } from './actor-management.js';

interface Call {
  method: string;
  data: any;
}

function makeTools() {
  const calls: Call[] = [];
  const query = vi.fn(async (method: string, data: any) => {
    calls.push({ method, data });
    if (method === 'foundry-mcp-bridge.getWorldInfo') {
      return { system: { id: 'worldofdarkness' } };
    }
    return { success: true, method };
  });
  const logger: any = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  logger.child = () => logger;
  const tools = new ActorManagementTools({ foundryClient: { query } as any, logger });
  const bridge = () => calls.filter(c => c.method !== 'foundry-mcp-bridge.getWorldInfo');
  return { tools, calls, bridge };
}

function definition() {
  const { tools } = makeTools();
  return tools.getToolDefinitions()[0] as any;
}

// ─── Scenario: an agent can find how to add an item ──────────────────────────

describe('the surface makes item creation discoverable', () => {
  it('lists create-items in the action enum', () => {
    const def = definition();

    expect(def.inputSchema.properties.action.enum).toEqual([
      'create',
      'update',
      'delete',
      'create-items',
      'update-items',
      'delete-items',
      'describe',
    ]);
  });

  it('describes create-items and names the equivalent sibling tool', () => {
    const def = definition();

    expect(def.description).toMatch(/"create-items"/);
    expect(def.description).toMatch(/manage-world-items/);
    expect(def.description).toMatch(/add-to-actor/);
  });

  it('documents the items payload, so the action is usable from the schema alone', () => {
    const def = definition();
    const items = def.inputSchema.properties.items;

    expect(items.items.required).toEqual(['name', 'type']);
    expect(Object.keys(items.items.properties).sort()).toEqual(['img', 'name', 'system', 'type']);
    expect(def.inputSchema.properties.actorIdentifier.description).toMatch(/create-items/);
  });
});

// ─── The existing creation path is reused, not duplicated ────────────────────

describe('create-items forwards to the existing query', () => {
  it('sends exactly the addActorItems payload that manage-world-items sends', async () => {
    const { tools, bridge } = makeTools();

    await tools.handleManageActors({
      action: 'create-items',
      actorIdentifier: 'Lena',
      items: [
        { name: 'Streetwise', type: 'Ability', system: { type: 'wod.abilities.talent', value: 2 } },
      ],
    });

    expect(bridge()).toHaveLength(1);
    expect(bridge()[0].method).toBe('foundry-mcp-bridge.addActorItems');
    expect(bridge()[0].data).toEqual({
      actorIdentifier: 'Lena',
      items: [
        { name: 'Streetwise', type: 'Ability', system: { type: 'wod.abilities.talent', value: 2 } },
      ],
    });
  });

  it('accepts an item with no system data', async () => {
    const { tools, bridge } = makeTools();

    const res: any = await tools.handleManageActors({
      action: 'create-items',
      actorIdentifier: 'Lena',
      items: [{ name: 'Notes', type: 'Feature' }],
    });

    expect(res.success).toBe(true);
    expect(bridge()[0].data.items).toEqual([{ name: 'Notes', type: 'Feature' }]);
  });

  it('rejects an empty items array before touching the bridge', async () => {
    const { tools, bridge } = makeTools();

    await expect(
      tools.handleManageActors({ action: 'create-items', actorIdentifier: 'Lena', items: [] })
    ).rejects.toThrow();
    expect(bridge()).toEqual([]);
  });
});

// ─── The behaviour of every pre-existing action is unchanged ─────────────────

describe('existing actions keep working unchanged', () => {
  it('update-items still hits updateActorItems with the same payload', async () => {
    const { tools, bridge } = makeTools();

    await tools.handleManageActors({
      action: 'update-items',
      actorIdentifier: 'Lena',
      itemUpdates: [{ id: 'item000000000001', system: { value: 4 } }],
    });

    expect(bridge()[0].method).toBe('foundry-mcp-bridge.updateActorItems');
    expect(bridge()[0].data).toEqual({
      actorIdentifier: 'Lena',
      itemUpdates: [{ id: 'item000000000001', system: { value: 4 } }],
    });
  });

  it('delete-items still hits deleteActorItems', async () => {
    const { tools, bridge } = makeTools();

    await tools.handleManageActors({
      action: 'delete-items',
      actorIdentifier: 'Lena',
      itemIds: ['item000000000001'],
    });

    expect(bridge()[0].method).toBe('foundry-mcp-bridge.deleteActorItems');
  });

  it('create / update / delete still route to their own queries', async () => {
    const create = makeTools();
    await create.tools.handleManageActors({
      action: 'create',
      actors: [{ name: 'Lena', type: 'PC' }],
    });
    expect(create.bridge()[0].method).toBe('foundry-mcp-bridge.createActors');

    const update = makeTools();
    await update.tools.handleManageActors({
      action: 'update',
      updates: [{ id: 'Lena000000000000', name: 'Lena B.' }],
    });
    expect(update.bridge()[0].method).toBe('foundry-mcp-bridge.updateActors');

    const del = makeTools();
    await del.tools.handleManageActors({ action: 'delete', ids: ['Lena000000000000'] });
    expect(del.bridge()[0].method).toBe('foundry-mcp-bridge.deleteActors');
  });

  it('still rejects an unknown action', async () => {
    const { tools } = makeTools();

    await expect(tools.handleManageActors({ action: 'add-items' })).rejects.toThrow();
  });
});
