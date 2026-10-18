import { Notice, Plugin, TFile, requestUrl } from 'obsidian';
import { JiraSyncSettingTab } from './settings-tab';
import {
  DEFAULT_SETTINGS,
  isJiraAuthMode,
  isRecencyField,
  isRecencyUnit,
  normalizeMappingPath,
  normalizeRecencyValue,
  prepareMappingsForSave,
  syncIntervalToMilliseconds,
  type PluginSettings,
} from './settings';
import {
  collectAssigneesFromIssues,
  jiraAssigneeDisplayName,
  jiraAssigneeIdentity,
  normalizeAssigneeMappings,
  prepareAssigneeMappingsForSave,
  type KnownJiraAssignee,
} from './sync/assignee';
import { SyncCoordinator } from './sync/coordinator';
import { syncAllMappings } from './sync/engine';
import { emptyLedger, type LedgerStore, type PendingLink, normalizeLedgerStore } from './sync/ledger';
import { collectSyncErrors, formatSyncNotice } from './sync/report';
import { SyncReportModal } from './sync/report-modal';
import { pathsReferToSameNote, resolveMarkdownFile } from './vault/resolve-note';
import { JiraClient } from './jira/client';
import { createObsidianRequestTransport } from './jira/http';
import { JiraApiError, type JiraBoard } from './jira/types';

interface PluginData {
  settings: PluginSettings;
  ledger: LedgerStore;
  pendingLinks: PendingLink[];
}

const FILE_CHANGE_DEBOUNCE_MS = 10_000;

export default class JiraSyncPlugin extends Plugin {
  settings: PluginSettings = { ...DEFAULT_SETTINGS };
  ledger: LedgerStore = emptyLedger();
  pendingLinks: PendingLink[] = [];

  private readonly coordinator = new SyncCoordinator();
  private intervalId: number | null = null;
  private readonly fileDebounceTimers = new Map<string, number>();
  /** Paths currently being written by sync — ignore their modify events. */
  private readonly writingPaths = new Set<string>();

  async onload(): Promise<void> {
    await this.loadPluginData();

    this.addCommand({
      id: 'jira-sync-now',
      name: 'Sync now',
      callback: () => {
        void this.requestSync('manual', this.settings.dryRunDefault);
      },
    });

    this.addCommand({
      id: 'jira-sync-preview',
      name: 'Preview sync (dry run)',
      callback: () => {
        void this.requestSync('preview', true);
      },
    });

    this.addRibbonIcon('sync', 'Jira Sync: Sync now', () => {
      void this.requestSync('ribbon', this.settings.dryRunDefault);
    });

    this.addSettingTab(new JiraSyncSettingTab(this.app, this));

    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (!(file instanceof TFile) || file.extension !== 'md') {
          return;
        }
        this.onMappedFileModified(file.path);
      }),
    );

    this.restartScheduler();

    if (this.settings.syncOnStartup) {
      window.setTimeout(() => {
        void this.requestSync('startup', false);
      }, 1_000);
    }
  }

  onunload(): void {
    this.clearIntervalTimer();
    for (const timer of this.fileDebounceTimers.values()) {
      window.clearTimeout(timer);
    }
    this.fileDebounceTimers.clear();
  }

  async loadPluginData(): Promise<void> {
    const raw = (await this.loadData()) as
      | (Partial<PluginData> & Partial<PluginSettings>)
      | null;

    if (raw && typeof raw === 'object' && 'settings' in raw && raw.settings) {
      this.settings = normalizeSettings(raw.settings);
      this.ledger = normalizeLedger(raw.ledger);
      this.pendingLinks = normalizePendingLinks(raw.pendingLinks);
      return;
    }

    this.settings = normalizeSettings(raw ?? {});
    this.ledger = emptyLedger();
    this.pendingLinks = [];
  }

  async saveSettings(): Promise<void> {
    prepareMappingsForSave(this.settings.mappings);
    prepareAssigneeMappingsForSave(this.settings.assigneeMappings);
    await this.savePluginData();
    this.restartScheduler();
  }

  async savePluginData(): Promise<void> {
    const data: PluginData = {
      settings: this.settings,
      ledger: this.ledger,
      pendingLinks: this.pendingLinks,
    };
    await this.saveData(data);
  }

  async clearSyncState(): Promise<number> {
    const cleared = Object.keys(this.ledger.entries).length + this.pendingLinks.length;
    this.ledger = emptyLedger();
    this.pendingLinks = [];
    await this.savePluginData();
    return cleared;
  }

  restartScheduler(): void {
    this.clearIntervalTimer();
    if (!this.settings.syncIntervalEnabled) {
      return;
    }
    const ms = syncIntervalToMilliseconds(
      this.settings.syncIntervalValue,
      this.settings.syncIntervalUnit,
    );
    this.intervalId = window.setInterval(() => {
      void this.requestSync('interval', false);
    }, ms);
  }

  createJiraClient(): JiraClient {
    return new JiraClient({
      baseUrl: this.settings.jiraBaseUrl,
      authMode: this.settings.authMode,
      email: this.settings.jiraEmail,
      token: this.settings.jiraApiToken,
      transport: createObsidianRequestTransport(requestUrl),
    });
  }

  async testJiraConnection(): Promise<
    { ok: true; displayName: string; boardCount: number } | { ok: false; message: string }
  > {
    try {
      const client = this.createJiraClient();
      const result = await client.testConnection();
      return { ok: true, displayName: result.displayName, boardCount: result.boardCount };
    } catch (error) {
      return { ok: false, message: formatConnectionError(error) };
    }
  }

  async findStartDateField(): Promise<
    { ok: true; fieldId: string; name: string } | { ok: false; message: string }
  > {
    return this.findJiraFieldByName('Start date');
  }

  async findJiraFieldByName(
    name: string,
  ): Promise<{ ok: true; fieldId: string; name: string } | { ok: false; message: string }> {
    try {
      const client = this.createJiraClient();
      const field = await client.findFieldByName(name);
      if (!field) {
        return { ok: false, message: `No field named “${name}” was found.` };
      }
      return { ok: true, fieldId: field.id, name: field.name };
    } catch (error) {
      return { ok: false, message: formatConnectionError(error) };
    }
  }

  /**
   * Load assignees already present on mapped boards (not the full user directory).
   * Stores them in settings.knownAssignees for the mapping dropdown.
   */
  async refreshKnownAssignees(): Promise<
    { ok: true; count: number } | { ok: false; message: string }
  > {
    const boardIds = [
      ...new Set(
        this.settings.mappings
          .map((mapping) => mapping.boardId)
          .filter((id) => Number.isFinite(id) && id > 0),
      ),
    ];
    if (boardIds.length === 0) {
      return { ok: false, message: 'Add at least one board mapping before loading assignees.' };
    }

    try {
      const client = this.createJiraClient();
      const byId = new Map<string, KnownJiraAssignee>();
      for (const boardId of boardIds) {
        const users = await client.listBoardAssignees(boardId);
        for (const user of users) {
          const accountId = jiraAssigneeIdentity(user);
          if (!accountId) {
            continue;
          }
          const key = accountId.toLowerCase();
          if (byId.has(key)) {
            continue;
          }
          byId.set(key, {
            accountId,
            displayName: jiraAssigneeDisplayName(user) || accountId,
            name: String(user.name ?? '').trim() || undefined,
          });
        }
        // Also harvest from the sync fetch path in case Agile board view is sparse.
        try {
          const issues = await client.listBoardIssuesForSync(boardId, ['assignee']);
          for (const known of collectAssigneesFromIssues(issues)) {
            const key = known.accountId.toLowerCase();
            if (!byId.has(key)) {
              byId.set(key, known);
            }
          }
        } catch {
          // Best-effort.
        }
      }
      this.settings.knownAssignees = [...byId.values()].sort((a, b) =>
        a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' }),
      );
      await this.saveSettings();
      return { ok: true, count: this.settings.knownAssignees.length };
    } catch (error) {
      return { ok: false, message: formatConnectionError(error) };
    }
  }

  async listBoardLabels(
    boardId: number,
  ): Promise<{ ok: true; labels: string[] } | { ok: false; message: string }> {
    try {
      const client = this.createJiraClient();
      const labels = await client.listBoardLabels(boardId);
      return { ok: true, labels };
    } catch (error) {
      return { ok: false, message: formatConnectionError(error) };
    }
  }

  async listBoards(): Promise<
    { ok: true; boards: JiraBoard[] } | { ok: false; message: string }
  > {
    try {
      const client = this.createJiraClient();
      const boards = await client.listBoards();
      return { ok: true, boards };
    } catch (error) {
      return { ok: false, message: formatConnectionError(error) };
    }
  }

  async requestSync(reason: string, dryRun: boolean): Promise<void> {
    await this.coordinator.request(reason, dryRun, async (activeReason, activeDryRun) => {
      await this.runSync(activeReason, activeDryRun);
    });
  }

  private async runSync(reason: string, dryRun: boolean): Promise<void> {
    if (!this.settings.jiraBaseUrl.trim() || !this.settings.jiraApiToken.trim()) {
      new Notice('Jira Sync: set the base URL and API token before syncing.');
      return;
    }
    if (this.settings.authMode === 'cloud' && !this.settings.jiraEmail.trim()) {
      new Notice('Jira Sync: Cloud auth requires an email address.');
      return;
    }
    if (this.settings.mappings.length === 0) {
      new Notice('Jira Sync: add at least one note ↔ board mapping.');
      return;
    }

    let client: JiraClient;
    try {
      client = this.createJiraClient();
    } catch (error) {
      new Notice(`Jira Sync: ${formatConnectionError(error)}`);
      return;
    }

    new Notice(
      dryRun
        ? `Jira Sync: dry-run starting (${reason})…`
        : `Jira Sync: starting (${reason})…`,
    );

    try {
      const result = await syncAllMappings(
        this.settings.mappings,
        this.ledger,
        this.pendingLinks,
        {
          baseUrl: this.settings.jiraBaseUrl,
          conflictPolicy: this.settings.conflictPolicy,
          client,
          startDateFieldId: this.settings.startDateFieldId,
          actualEndFieldId: this.settings.actualEndFieldId,
          targetEndFieldId: this.settings.targetEndFieldId,
          assigneeMappings: this.settings.assigneeMappings,
          dryRun,
          readNote: async (path) => {
            const file = resolveMarkdownFile(this.app, path);
            return this.app.vault.read(file);
          },
          writeNote: async (path, content) => {
            const file = resolveMarkdownFile(this.app, path);
            this.writingPaths.add(file.path);
            try {
              await this.app.vault.modify(file, content);
            } finally {
              window.setTimeout(() => {
                this.writingPaths.delete(file.path);
              }, 500);
            }
          },
        },
      );

      if (!dryRun) {
        await this.savePluginData();
      }

      const errors = collectSyncErrors(result);
      const noticeText = formatSyncNotice(result);
      new Notice(noticeText, errors.length > 0 ? 15_000 : 8_000);

      for (const line of errors) {
        console.error(`Jira Sync: ${line}`);
      }

      if (dryRun || errors.length > 0) {
        new SyncReportModal(this.app, result).open();
      }
    } catch (error) {
      new Notice(`Jira Sync failed: ${formatConnectionError(error)}`, 15_000);
      console.error('Jira Sync failed', error);
    }
  }

  private onMappedFileModified(path: string): void {
    if (!this.settings.syncOnFileChange) {
      return;
    }
    if (this.writingPaths.has(path) || this.coordinator.isRunning) {
      return;
    }
    const mapped = this.settings.mappings.some((mapping) =>
      pathsReferToSameNote(mapping.notePath, path),
    );
    if (!mapped) {
      return;
    }

    const existing = this.fileDebounceTimers.get(path);
    if (existing !== undefined) {
      window.clearTimeout(existing);
    }

    const timer = window.setTimeout(() => {
      this.fileDebounceTimers.delete(path);
      void this.requestSync('file-change', false);
    }, FILE_CHANGE_DEBOUNCE_MS);
    this.fileDebounceTimers.set(path, timer);
  }

  private clearIntervalTimer(): void {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}

function normalizeSettings(saved: Partial<PluginSettings>): PluginSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    authMode: isJiraAuthMode(saved.authMode) ? saved.authMode : DEFAULT_SETTINGS.authMode,
    conflictPolicy:
      saved.conflictPolicy === 'prefer-jira' || saved.conflictPolicy === 'prefer-obsidian'
        ? saved.conflictPolicy
        : DEFAULT_SETTINGS.conflictPolicy,
    mappings: Array.isArray(saved.mappings)
      ? saved.mappings.map((mapping) => ({
          notePath: normalizeMappingPath(
            typeof mapping?.notePath === 'string' ? mapping.notePath : '',
          ),
          boardId:
            typeof mapping?.boardId === 'number' && Number.isFinite(mapping.boardId)
              ? mapping.boardId
              : 0,
          boardName:
            typeof mapping?.boardName === 'string' && mapping.boardName.trim()
              ? mapping.boardName.trim()
              : undefined,
          labels: Array.isArray(mapping?.labels)
            ? mapping.labels.map((label) => String(label))
            : [],
          recencyValue: normalizeRecencyValue(
            typeof mapping?.recencyValue === 'number' ? mapping.recencyValue : 0,
          ),
          recencyUnit: isRecencyUnit(mapping?.recencyUnit) ? mapping.recencyUnit : 'days',
          recencyField: isRecencyField(mapping?.recencyField)
            ? mapping.recencyField
            : 'updated',
        }))
      : [],
    dryRunDefault: Boolean(saved.dryRunDefault),
    startDateFieldId:
      typeof saved.startDateFieldId === 'string' ? saved.startDateFieldId.trim() : '',
    actualEndFieldId:
      typeof saved.actualEndFieldId === 'string' ? saved.actualEndFieldId.trim() : '',
    targetEndFieldId:
      typeof saved.targetEndFieldId === 'string' && saved.targetEndFieldId.trim()
        ? saved.targetEndFieldId.trim()
        : 'duedate',
    assigneeMappings: normalizeAssigneeMappings(
      Array.isArray(saved.assigneeMappings) ? saved.assigneeMappings : [],
    ),
    knownAssignees: Array.isArray(saved.knownAssignees)
      ? saved.knownAssignees
          .map((item) => ({
            accountId: String(item?.accountId ?? '').trim(),
            displayName:
              String(item?.displayName ?? '').trim() ||
              String(item?.accountId ?? '').trim(),
            name: String(item?.name ?? '').trim() || undefined,
          }))
          .filter((item) => item.accountId.length > 0)
      : [],
  };
}

function normalizeLedger(raw: LedgerStore | undefined): LedgerStore {
  return normalizeLedgerStore(raw);
}

function normalizePendingLinks(raw: PendingLink[] | undefined): PendingLink[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      mappingKey: String(item.mappingKey ?? ''),
      issueKey: String(item.issueKey ?? '').toUpperCase(),
      title: String(item.title ?? ''),
      description: String(item.description ?? ''),
      status:
        item.status === 'todo' || item.status === 'in_progress' || item.status === 'done'
          ? item.status
          : 'todo',
      parentIssueKey:
        item.parentIssueKey === null || item.parentIssueKey === undefined
          ? null
          : String(item.parentIssueKey).toUpperCase(),
      jiraUpdated: String(item.jiraUpdated ?? ''),
    }))
    .filter((item) => item.mappingKey && item.issueKey);
}

function formatConnectionError(error: unknown): string {
  if (error instanceof JiraApiError) {
    return `${error.message} (HTTP ${error.status})`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
