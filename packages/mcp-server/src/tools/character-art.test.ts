/**
 * "Actor art paths SHALL be readable" — the generic read formatters.
 *
 * The module has ALWAYS sent the actor's `img` (`actor-directory.ts` `listActors`
 * and `data-access.ts` `getCharacterInfo` both spread `...(actor.img ? { img } :
 * {})`). These three formatters discarded it and emitted only `hasImage: !!img`,
 * which is `true` for Foundry's `icons/svg/mystery-man.svg` and therefore cannot
 * distinguish a real portrait from a missing one.
 *
 * The fix is additive: `hasImage` keeps its exact value and meaning, and the real
 * path lands beside it. Every test below asserts BOTH halves — the new field and
 * the old field's preservation — because a caller depending on `hasImage`
 * truthiness must keep working.
 */

import { describe, it, expect, vi } from 'vitest';
import { CharacterTools } from './character.js';
import { artFields, isDefaultImg } from '../utils/actor-art.js';

const PORTRAIT = 'wod20-portraits/lena.webp';
const PLACEHOLDER = 'icons/svg/mystery-man.svg';

function makeTools(handlers: Record<string, any>) {
  const calls: string[] = [];
  const query = vi.fn(async (method: string, data: any) => {
    calls.push(method);
    const key = method.replace('foundry-mcp-bridge.', '');
    if (!(key in handlers)) throw new Error(`unexpected query ${method}`);
    const h = handlers[key];
    return typeof h === 'function' ? h(data) : h;
  });
  const logger: any = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  logger.child = () => logger;
  const tools = new CharacterTools({ foundryClient: { query } as any, logger });
  return { tools, calls };
}

function actorInfo(img?: string) {
  return {
    id: 'Lena000000000000',
    name: 'Lena',
    type: 'PC',
    ...(img !== undefined ? { img } : {}),
    system: {},
    items: [
      {
        id: 'item000000000001',
        name: 'Brawl',
        type: 'Ability',
        img: 'icons/svg/item-bag.svg',
        system: {},
      },
    ],
    effects: [],
  };
}

// ─── the placeholder rule itself ─────────────────────────────────────────────

describe('isDefaultImg', () => {
  it('treats a real path as real and the built-in placeholders as default', () => {
    expect(isDefaultImg(PORTRAIT)).toBe(false);
    expect(isDefaultImg(PLACEHOLDER)).toBe(true);
    expect(isDefaultImg('icons/svg/item-bag.svg')).toBe(true);
  });

  it('treats absent/empty as default', () => {
    expect(isDefaultImg(undefined)).toBe(true);
    expect(isDefaultImg('')).toBe(true);
    expect(isDefaultImg(null)).toBe(true);
  });

  it('emits img only when there is one, and isDefaultImg always', () => {
    expect(artFields(PORTRAIT)).toEqual({ img: PORTRAIT, isDefaultImg: false });
    expect(artFields(undefined)).toEqual({ isDefaultImg: true });
  });
});

// ─── list-characters ─────────────────────────────────────────────────────────

describe('list-characters', () => {
  it('returns the real portrait path alongside the untouched hasImage flag', async () => {
    const { tools } = makeTools({
      listActors: [
        { id: 'Lena000000000000', name: 'Lena', type: 'PC', img: PORTRAIT },
        { id: 'Tobi000000000000', name: 'Tobias', type: 'PC', img: PLACEHOLDER },
        { id: 'Nada000000000000', name: 'Nada', type: 'PC' },
      ],
    });

    const res: any = await tools.handleListCharacters({});

    expect(res.characters[0]).toEqual({
      id: 'Lena000000000000',
      name: 'Lena',
      type: 'PC',
      hasImage: true,
      img: PORTRAIT,
      isDefaultImg: false,
    });
    // The placeholder: `hasImage` is still true (unchanged), but no longer the
    // only thing on offer.
    expect(res.characters[1].hasImage).toBe(true);
    expect(res.characters[1].isDefaultImg).toBe(true);
    expect(res.characters[2]).toEqual({
      id: 'Nada000000000000',
      name: 'Nada',
      type: 'PC',
      hasImage: false,
      isDefaultImg: true,
    });
    expect(res.total).toBe(3);
  });

  it('needs no token on any scene: only listActors is queried', async () => {
    const { tools, calls } = makeTools({
      listActors: [{ id: 'Lena000000000000', name: 'Lena', type: 'PC', img: PORTRAIT }],
    });

    await tools.handleListCharacters({});

    expect(calls).toEqual(['foundry-mcp-bridge.listActors']);
  });

  it('deprecates hasImage in the tool description without removing it', () => {
    const { tools } = makeTools({});
    const defs: any[] = tools.getToolDefinitions();
    const list = defs.find(d => d.name === 'list-characters');

    expect(list.description).toMatch(/DEPRECATED/);
    expect(list.description).toMatch(/img/);
  });
});

// ─── get-character ───────────────────────────────────────────────────────────

describe('get-character', () => {
  it('returns img and isDefaultImg alongside hasImage', async () => {
    const { tools } = makeTools({ getCharacterInfo: () => actorInfo(PORTRAIT) });

    const res: any = await tools.handleGetCharacter({ identifier: 'Lena' });

    expect(res.hasImage).toBe(true);
    expect(res.img).toBe(PORTRAIT);
    expect(res.isDefaultImg).toBe(false);
    // Pre-existing fields untouched.
    expect(res.id).toBe('Lena000000000000');
    expect(res.name).toBe('Lena');
    expect(res.items).toHaveLength(1);
  });

  it('flags the placeholder as default while hasImage stays true', async () => {
    const { tools } = makeTools({ getCharacterInfo: () => actorInfo(PLACEHOLDER) });

    const res: any = await tools.handleGetCharacter({ identifier: 'Lena' });

    expect(res.hasImage).toBe(true);
    expect(res.isDefaultImg).toBe(true);
  });

  it('omits img for an actor with none', async () => {
    const { tools } = makeTools({ getCharacterInfo: () => actorInfo() });

    const res: any = await tools.handleGetCharacter({ identifier: 'Lena' });

    expect('img' in res).toBe(false);
    expect(res.hasImage).toBe(false);
    expect(res.isDefaultImg).toBe(true);
  });
});

// ─── get-character-entity ────────────────────────────────────────────────────

describe('get-character-entity', () => {
  it('returns the item art path alongside hasImage', async () => {
    const { tools } = makeTools({ getCharacterInfo: () => actorInfo(PORTRAIT) });

    const res: any = await tools.handleGetCharacterEntity({
      characterIdentifier: 'Lena',
      entityIdentifier: 'Brawl',
    });

    expect(res.entityType).toBe('item');
    expect(res.hasImage).toBe(true);
    expect(res.img).toBe('icons/svg/item-bag.svg');
    expect(res.isDefaultImg).toBe(true);
  });
});
