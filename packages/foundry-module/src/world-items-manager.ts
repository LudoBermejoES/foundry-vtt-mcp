// Extracted from data-access.ts as part of the God-class split (behaviour-preserving).
// See docs/refactor-data-access.md for the module map.
import { FoundrySecurity } from './security.js';

export class WorldItemsManager {
  constructor(private security: FoundrySecurity) {}

  /**
   * List world-level Item documents from the Items sidebar.
   * Optionally filters by type, folder (name or id), or a case-insensitive name substring.
   */
  async listWorldItems(params: { type?: string; folder?: string; nameFilter?: string }): Promise<
    Array<{
      id: string;
      name: string;
      type: string;
      img?: string;
      folderId: string | null;
      folderName: string | null;
    }>
  > {
    this.security.validateFoundryState();

    const { type, folder, nameFilter } = params;
    const nameLower = nameFilter ? nameFilter.toLowerCase() : null;

    // Resolve folder filter to an id if a name/id was provided
    let folderId: string | null = null;
    if (folder && folder.trim().length > 0) {
      const folderTrimmed = folder.trim();
      const folderDoc =
        (game as any).folders?.find(
          (f: any) => f.type === 'Item' && (f.name === folderTrimmed || f.id === folderTrimmed)
        ) ?? null;
      if (!folderDoc) {
        return [];
      }
      folderId = folderDoc.id;
    }

    const result: Array<{
      id: string;
      name: string;
      type: string;
      img?: string;
      folderId: string | null;
      folderName: string | null;
    }> = [];

    for (const item of (game as any).items) {
      if (type && item.type !== type) continue;
      if (folderId && item.folder?.id !== folderId) continue;
      if (nameLower && !(item.name ?? '').toLowerCase().includes(nameLower)) continue;

      result.push({
        id: item.id ?? '',
        name: item.name ?? '',
        type: item.type,
        ...(item.img ? { img: item.img } : {}),
        folderId: item.folder?.id ?? null,
        folderName: item.folder?.name ?? null,
      });
    }

    return result;
  }

  /**
   * Update one or more existing world-level Item documents.
   *
   * Each entry must supply an `id` plus at least one field to change (name,
   * img, system, folder). Uses Item.updateDocuments() for a single batched
   * write. Folder may be supplied as a name or id; if a name is given that
   * does not exist, it is created automatically (same behaviour as
   * createWorldItems).
   */
  async updateWorldItems(params: {
    updates: Array<{
      id: string;
      name?: string;
      img?: string;
      system?: Record<string, any>;
      folder?: string;
    }>;
  }): Promise<{
    updated: Array<{ id: string; name: string; type: string }>;
  }> {
    this.security.validateFoundryState();

    const { updates } = params;

    if (!Array.isArray(updates) || updates.length === 0) {
      throw new Error('updates array is required and must contain at least one entry');
    }

    // Cache folder resolutions so we only look up / create each folder once
    const folderCache = new Map<string, string>(); // folder param → folder id

    const resolveFolderId = async (folder: string): Promise<string> => {
      if (folderCache.has(folder)) return folderCache.get(folder)!;
      const folderTrimmed = folder.trim();
      let folderDoc =
        (game as any).folders?.find(
          (f: any) => f.type === 'Item' && (f.name === folderTrimmed || f.id === folderTrimmed)
        ) ?? null;
      if (!folderDoc) {
        folderDoc = await (Folder as any).create({
          name: folderTrimmed,
          type: 'Item',
          parent: null,
        });
      }
      folderCache.set(folder, folderDoc.id);
      return folderDoc.id;
    };

    const payload: Array<Record<string, any>> = [];

    for (let idx = 0; idx < updates.length; idx++) {
      const upd = updates[idx];
      if (!upd || typeof upd.id !== 'string' || upd.id.trim().length === 0) {
        throw new Error(`updates[${idx}]: "id" is required and must be a non-empty string`);
      }

      const item = (game as any).items?.get(upd.id);
      if (!item) {
        throw new Error(`updates[${idx}]: Item "${upd.id}" not found in world`);
      }

      const patch: Record<string, any> = { _id: upd.id };
      if (upd.name !== undefined) patch.name = upd.name;
      if (upd.img !== undefined) patch.img = upd.img;
      if (upd.system !== undefined) patch.system = upd.system;
      if (upd.folder !== undefined && upd.folder.trim().length > 0) {
        patch.folder = await resolveFolderId(upd.folder.trim());
      }

      payload.push(patch);
    }

    try {
      const updated = await (Item as any).updateDocuments(payload);

      const result = {
        updated: (updated || []).map((doc: any) => ({
          id: doc.id,
          name: doc.name,
          type: doc.type,
        })),
      };

      this.security.auditLog('updateWorldItems', { count: payload.length }, 'success');
      return result;
    } catch (error) {
      this.security.auditLog(
        'updateWorldItems',
        { count: payload.length },
        'failure',
        error instanceof Error ? error.message : 'Unknown error'
      );
      throw error;
    }
  }

  /**
   * Create one or more world-level Item documents (Items sidebar, not embedded on an actor).
   *
   * Uses Item.createDocuments() with no parent so items appear in the Foundry
   * Items sidebar and can be dragged onto any actor sheet. Optionally places
   * items inside a named/id-resolved folder, creating the folder if necessary.
   */
  async createWorldItems(params: {
    items: Array<{
      name: string;
      type: string;
      img?: string;
      system?: Record<string, any>;
    }>;
    folder?: string;
  }): Promise<{
    folderId: string | null;
    folderName: string | null;
    created: Array<{ id: string; name: string; type: string }>;
  }> {
    this.security.validateFoundryState();

    const { items, folder } = params;

    if (!Array.isArray(items) || items.length === 0) {
      throw new Error('items array is required and must contain at least one entry');
    }

    const itemDocTypes = (game as any).system?.documentTypes?.Item;
    const validTypes: string[] | null =
      itemDocTypes && typeof itemDocTypes === 'object' ? Object.keys(itemDocTypes) : null;

    const payload = items.map((it, idx) => {
      if (!it || typeof it.name !== 'string' || it.name.trim().length === 0) {
        throw new Error(`items[${idx}]: "name" is required and must be a non-empty string`);
      }
      if (typeof it.type !== 'string' || it.type.trim().length === 0) {
        throw new Error(`items[${idx}] ("${it.name}"): "type" is required`);
      }
      if (validTypes && !validTypes.includes(it.type)) {
        throw new Error(
          `items[${idx}] ("${it.name}"): unknown type "${it.type}" for system "${(game.system as any)?.id}". ` +
            `Valid Item types: ${validTypes.join(', ')}`
        );
      }

      const doc: Record<string, any> = { name: it.name, type: it.type };
      if (it.img) doc.img = it.img;
      if (it.system && typeof it.system === 'object') doc.system = it.system;
      if (Array.isArray((it as any).effects)) doc.effects = (it as any).effects;
      if ((it as any).flags && typeof (it as any).flags === 'object') doc.flags = (it as any).flags;
      return doc;
    });

    // Resolve or create the target folder
    let folderDoc: any = null;
    if (folder && folder.trim().length > 0) {
      const folderTrimmed = folder.trim();
      folderDoc =
        (game as any).folders?.find(
          (f: any) => f.type === 'Item' && (f.name === folderTrimmed || f.id === folderTrimmed)
        ) ?? null;

      if (!folderDoc) {
        folderDoc = await (Folder as any).create({
          name: folderTrimmed,
          type: 'Item',
          parent: null,
        });
      }

      for (const doc of payload) {
        doc.folder = folderDoc.id;
      }
    }

    try {
      const created = await (Item as any).createDocuments(payload);

      const result = {
        folderId: folderDoc ? folderDoc.id : null,
        folderName: folderDoc ? folderDoc.name : null,
        created: (created || []).map((doc: any) => ({
          id: doc.id,
          name: doc.name,
          type: doc.type,
        })),
      };

      this.security.auditLog(
        'createWorldItems',
        { folder: folder ?? null, count: payload.length },
        'success'
      );
      return result;
    } catch (error) {
      this.security.auditLog(
        'createWorldItems',
        { folder: folder ?? null, count: payload.length },
        'failure',
        error instanceof Error ? error.message : 'Unknown error'
      );
      throw error;
    }
  }
}
