// Extracted from data-access.ts as part of the God-class split (behaviour-preserving).
// See docs/refactor-data-access.md for the module map.
import { PermissionManager } from './permissions.js';
import { FoundrySecurity } from './security.js';
import { ActorResolver } from './actor-resolver.js';

export class JournalManager {
  constructor(
    private security: FoundrySecurity,
    private resolver: ActorResolver,
    private permissions: PermissionManager
  ) {}

  /**
   * Create journal entry for quests, with optional additional pages
   */
  async createJournalEntry(request: {
    name: string;
    content: string;
    folderName?: string;
    additionalPages?: Array<{ name: string; content: string }>;
  }): Promise<{ id: string; name: string; pageCount: number }> {
    this.security.validateFoundryState();

    // Use permission system for journal creation
    const permissionCheck = this.permissions.checkWritePermission('createActor', {
      quantity: 1, // Treat journal creation similar to actor creation for permissions
    });

    if (!permissionCheck.allowed) {
      throw new Error(`Journal creation denied: ${permissionCheck.reason}`);
    }

    try {
      // Build pages array: main page + any additional pages
      const pages: Array<{ type: string; name: string; text: { content: string } }> = [
        {
          type: 'text',
          name: 'Quest Details',
          text: {
            content: request.content,
          },
        },
      ];

      if (request.additionalPages) {
        for (const page of request.additionalPages) {
          pages.push({
            type: 'text',
            name: page.name,
            text: {
              content: page.content,
            },
          });
        }
      }

      // Create journal entry with proper Foundry v13 structure
      const journalData = {
        name: request.name,
        pages,
        ownership: { default: 0 }, // GM only by default
        folder: await this.resolver.getOrCreateFolder(
          request.folderName || request.name,
          'JournalEntry'
        ),
      };

      const journal = await JournalEntry.create(journalData);

      if (!journal) {
        throw new Error('Failed to create journal entry');
      }

      const result = {
        id: journal.id,
        name: journal.name || request.name,
        pageCount: pages.length,
      };

      this.security.auditLog('createJournalEntry', request, 'success');
      return result;
    } catch (error) {
      this.security.auditLog(
        'createJournalEntry',
        request,
        'failure',
        error instanceof Error ? error.message : 'Unknown error'
      );
      throw error;
    }
  }

  /**
   * List all journal entries with page metadata
   */
  async listJournals(): Promise<
    Array<{
      id: string;
      name: string;
      type: string;
      pageCount: number;
      pages: Array<{ id: string; name: string; type: string }>;
    }>
  > {
    this.security.validateFoundryState();

    return game.journal.map((journal: any) => ({
      id: journal.id || '',
      name: journal.name || '',
      type: 'JournalEntry',
      pageCount: journal.pages?.size || 0,
      pages:
        journal.pages?.map((page: any) => ({
          id: page.id || '',
          name: page.name || '',
          type: page.type || 'text',
        })) || [],
    }));
  }

  /**
   * Get journal entry content (first text page + page manifest)
   */
  async getJournalContent(journalId: string): Promise<{
    content: string;
    currentPage?: { id: string; name: string } | undefined;
    allPages: Array<{ id: string; name: string; type: string }>;
    pageCount: number;
    note?: string | undefined;
  } | null> {
    this.security.validateFoundryState();

    const journal = game.journal.get(journalId);
    if (!journal) {
      return null;
    }

    const allPages =
      journal.pages?.map((page: any) => ({
        id: page.id || '',
        name: page.name || '',
        type: page.type || 'text',
      })) || [];
    const pageCount = allPages.length;

    // Get first text page content
    const firstPage = journal.pages.find((page: any) => page.type === 'text');
    if (!firstPage) {
      return { content: '', allPages, pageCount };
    }

    return {
      content: firstPage.text?.content || '',
      currentPage: { id: firstPage.id || '', name: firstPage.name || '' },
      allPages,
      pageCount,
      note:
        pageCount > 1
          ? `This journal has ${pageCount} pages. Use list-journals with journalId and pageId to read other pages: ${allPages.map((p: any) => `"${p.name}" (${p.id})`).join(', ')}`
          : undefined,
    };
  }

  /**
   * Get a specific journal page's content by ID
   */
  async getJournalPageContent(
    journalId: string,
    pageId: string
  ): Promise<{ id: string; name: string; type: string; content: string } | null> {
    this.security.validateFoundryState();

    const journal = game.journal.get(journalId);
    if (!journal) {
      return null;
    }

    const page = journal.pages.get(pageId);
    if (!page) {
      return null;
    }

    return {
      id: page.id || '',
      name: page.name || '',
      type: page.type || 'text',
      content: page.type === 'text' ? page.text?.content || '' : page.src || '',
    };
  }

  /**
   * Update journal entry content
   * - No pageId/newPageName: update first text page (backward compat)
   * - With pageId: update that specific page
   * - With newPageName (no pageId): create a new page
   */
  async updateJournalContent(request: {
    journalId: string;
    content: string;
    pageId?: string | undefined;
    newPageName?: string | undefined;
  }): Promise<{ success: boolean; pageId?: string | undefined; pageName?: string | undefined }> {
    this.security.validateFoundryState();

    // Use permission system for journal updates - treating as createActor permission level
    const permissionCheck = this.permissions.checkWritePermission('createActor', {
      quantity: 1, // Treat journal updates similar to actor creation for permissions
    });

    if (!permissionCheck.allowed) {
      throw new Error(`Journal update denied: ${permissionCheck.reason}`);
    }

    try {
      const journal = game.journal.get(request.journalId);
      if (!journal) {
        throw new Error('Journal entry not found');
      }

      // Mode 1: Create a new page
      if (request.newPageName) {
        const created = await journal.createEmbeddedDocuments('JournalEntryPage', [
          {
            type: 'text',
            name: request.newPageName,
            text: {
              content: request.content,
            },
          },
        ]);
        const newPage = created?.[0];
        this.security.auditLog('updateJournalContent', request, 'success');
        return { success: true, pageId: newPage?.id || '', pageName: request.newPageName };
      }

      // Mode 2: Update a specific page by ID
      if (request.pageId) {
        const page = journal.pages.get(request.pageId);
        if (!page) {
          throw new Error(`Page not found: ${request.pageId}`);
        }
        await page.update({
          'text.content': request.content,
        });
        this.security.auditLog('updateJournalContent', request, 'success');
        return { success: true, pageId: page.id, pageName: page.name };
      }

      // Mode 3: Update first text page or create one if none exists (backward compat)
      const firstPage = journal.pages.find((page: any) => page.type === 'text');

      if (firstPage) {
        // Update existing page
        await firstPage.update({
          'text.content': request.content,
        });
        this.security.auditLog('updateJournalContent', request, 'success');
        return { success: true, pageId: firstPage.id, pageName: firstPage.name };
      } else {
        // Create new text page
        const created = await journal.createEmbeddedDocuments('JournalEntryPage', [
          {
            type: 'text',
            name: 'Quest Details',
            text: {
              content: request.content,
            },
          },
        ]);
        const newPage = created?.[0];
        this.security.auditLog('updateJournalContent', request, 'success');
        return { success: true, pageId: newPage?.id || '', pageName: 'Quest Details' };
      }
    } catch (error) {
      this.security.auditLog(
        'updateJournalContent',
        request,
        'failure',
        error instanceof Error ? error.message : 'Unknown error'
      );
      throw error;
    }
  }
}
