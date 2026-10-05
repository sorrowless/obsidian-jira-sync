import { describe, expect, it, vi } from 'vitest';
import type { JiraIssue } from '../jira/types';
import type { JiraClient } from '../jira/client';
import type { ConflictPolicy } from '../settings';
import {
  emptyLedger,
  ledgerEntryKey,
  makeLedgerEntry,
  mappingKey,
  type LedgerStore,
  type PendingLink,
} from './ledger';
import { syncAllMappings } from './engine';

const BASE_URL = 'https://jira.example';
const NOTE_PATH = 'Tasks/Test.md';
const BOARD_ID = 42;

const DEFAULT_COLUMNS = {
  columnConfig: {
    columns: [
      { name: 'To Do', statuses: [{ id: '1', name: 'To Do' }] },
      { name: 'In Progress', statuses: [{ id: '2', name: 'In Progress' }] },
      { name: 'Review', statuses: [{ id: '3', name: 'Review' }] },
      { name: 'Done', statuses: [{ id: '4', name: 'Done' }] },
    ],
  },
};

function browseLink(key: string, title: string): string {
  return `- [ ] [${title}](${BASE_URL}/browse/${key})`;
}

function inProgressLink(key: string, title: string): string {
  return `- [/] [${title}](${BASE_URL}/browse/${key})`;
}

function issueRow(
  key: string,
  summary: string,
  overrides: Partial<JiraIssue['fields']> = {},
): JiraIssue {
  return {
    id: `id-${key}`,
    key: key.toUpperCase(),
    fields: {
      summary,
      description: '',
      status: {
        id: '1',
        name: 'To Do',
        statusCategory: { key: 'new' },
      },
      project: { id: '1', key: 'PROJ' },
      issuetype: { id: '1', name: 'Task', subtask: false },
      labels: [],
      duedate: null,
      updated: '2026-01-01T00:00:00.000Z',
      ...overrides,
    },
  };
}

interface MockClientBundle {
  client: JiraClient;
  issues: Map<string, JiraIssue>;
  getBoard: ReturnType<typeof vi.fn>;
  getBoardConfiguration: ReturnType<typeof vi.fn>;
  listBoardIssues: ReturnType<typeof vi.fn>;
  createIssue: ReturnType<typeof vi.fn>;
  updateIssue: ReturnType<typeof vi.fn>;
  listTransitions: ReturnType<typeof vi.fn>;
  transitionIssue: ReturnType<typeof vi.fn>;
  getIssue: ReturnType<typeof vi.fn>;
}

function createMockClient(initial: JiraIssue[] = []): MockClientBundle {
  const issues = new Map<string, JiraIssue>();
  for (const row of initial) {
    issues.set(row.key.toUpperCase(), structuredClone(row));
  }
  let nextId = 100;

  const getBoard = vi.fn(async () => ({
    id: BOARD_ID,
    name: 'Test board',
    location: { projectKey: 'PROJ' },
  }));

  const getBoardConfiguration = vi.fn(async () => structuredClone(DEFAULT_COLUMNS));

  const listBoardIssues = vi.fn(async () => [...issues.values()].map((row) => structuredClone(row)));

  const listBoardIssuesForSync = vi.fn(
    async (
      _boardId: number,
      _fields?: string[],
      filter: { labels?: readonly string[] } | readonly string[] = {},
    ) => {
      const all = [...issues.values()].map((row) => structuredClone(row));
      const labels: readonly string[] = Array.isArray(filter)
        ? filter
        : ((filter as { labels?: readonly string[] }).labels ?? []);
      if (!labels.length) {
        return all;
      }
      const wanted = new Set(labels.map((label: string) => String(label).toLowerCase()));
      return all.filter((issue) =>
        (issue.fields.labels ?? []).some((label) => wanted.has(String(label).toLowerCase())),
      );
    },
  );

  const getIssue = vi.fn(async (issueKey: string) => {
    const row = issues.get(issueKey.toUpperCase());
    if (!row) {
      throw new Error(`Issue ${issueKey} not found`);
    }
    return structuredClone(row);
  });

  const createIssue = vi.fn(async (input: {
    projectKey: string;
    summary: string;
    description?: string;
    labels?: string[];
    parentKey?: string | null;
  }) => {
    const key = `PROJ-${nextId}`;
    nextId += 1;
    const created = issueRow(key, input.summary, {
      description: input.description ?? '',
      labels: input.labels ?? [],
      parent: input.parentKey ? { key: input.parentKey } : undefined,
      issuetype: {
        id: input.parentKey ? 'sub' : '1',
        name: input.parentKey ? 'Sub-task' : 'Task',
        subtask: Boolean(input.parentKey),
      },
    });
    issues.set(key, created);
    return structuredClone(created);
  });

  const updateIssue = vi.fn(async (issueKey: string, input: {
    summary?: string;
    description?: string;
    labels?: string[];
  }) => {
    const row = issues.get(issueKey.toUpperCase());
    if (!row) {
      throw new Error(`Issue ${issueKey} not found`);
    }
    if (input.summary !== undefined) {
      row.fields.summary = input.summary;
    }
    if (input.description !== undefined) {
      row.fields.description = input.description;
    }
    if (input.labels !== undefined) {
      row.fields.labels = [...input.labels];
    }
    row.fields.updated = '2026-06-01T12:00:01.000Z';
  });

  const listTransitions = vi.fn(async () => [
    { id: 't-todo', name: 'To Do', to: { id: '1', name: 'To Do' } },
    { id: 't-progress', name: 'In Progress', to: { id: '2', name: 'In Progress' } },
    { id: 't-review', name: 'Review', to: { id: '3', name: 'Review' } },
    { id: 't-done', name: 'Done', to: { id: '4', name: 'Done' } },
  ]);

  const transitionIssue = vi.fn(async (issueKey: string, transitionId: string) => {
    const row = issues.get(issueKey.toUpperCase());
    if (!row) {
      return;
    }
    const map: Record<string, { id: string; name: string; category: string }> = {
      't-todo': { id: '1', name: 'To Do', category: 'new' },
      't-progress': { id: '2', name: 'In Progress', category: 'indeterminate' },
      't-review': { id: '3', name: 'Review', category: 'indeterminate' },
      't-done': { id: '4', name: 'Done', category: 'done' },
    };
    const target = map[transitionId];
    if (target) {
      row.fields.status = {
        id: target.id,
        name: target.name,
        statusCategory: { key: target.category },
      };
      row.fields.updated = '2026-06-01T12:00:02.000Z';
    }
  });

  const client = {
    getBoard,
    getBoardConfiguration,
    listBoardIssues,
    listBoardIssuesForSync,
    createIssue,
    updateIssue,
    listTransitions,
    transitionIssue,
    getIssue,
  } as unknown as JiraClient;

  return {
    client,
    issues,
    getBoard,
    getBoardConfiguration,
    listBoardIssues,
    createIssue,
    updateIssue,
    listTransitions,
    transitionIssue,
    getIssue,
  };
}

async function runSync(options: {
  note: string;
  mock: MockClientBundle;
  ledger?: LedgerStore;
  pending?: PendingLink[];
  dryRun?: boolean;
  conflictPolicy?: ConflictPolicy;
  labels?: string[];
  startDateFieldId?: string;
  actualEndFieldId?: string;
  targetEndFieldId?: string;
}): Promise<{
  result: Awaited<ReturnType<typeof syncAllMappings>>;
  written: string;
  writeNote: ReturnType<typeof vi.fn>;
  ledger: LedgerStore;
}> {
  const ledger = options.ledger ?? emptyLedger();
  const pending = options.pending ?? [];
  let written = '';
  const writeNote = vi.fn(async (_path: string, content: string) => {
    written = content;
  });
  const readNote = vi.fn(async () => options.note);

  const result = await syncAllMappings(
    [{ notePath: NOTE_PATH, boardId: BOARD_ID, labels: options.labels ?? [] }],
    ledger,
    pending,
    {
      baseUrl: BASE_URL,
      conflictPolicy: options.conflictPolicy ?? 'prefer-obsidian',
      client: options.mock.client,
      startDateFieldId: options.startDateFieldId ?? '',
      actualEndFieldId: options.actualEndFieldId,
      targetEndFieldId: options.targetEndFieldId,
      readNote,
      writeNote,
      dryRun: options.dryRun,
      now: () => '2026-06-01T12:00:00.000Z',
    },
  );

  return { result, written, writeNote, ledger };
}

function mappingLedgerKey(issueKey: string): string {
  return ledgerEntryKey(mappingKey(NOTE_PATH, BOARD_ID), issueKey);
}

describe('sync engine', () => {
  it('creates a remote issue from an unlinked checklist task', async () => {
    const mock = createMockClient();
    const { result, written, writeNote } = await runSync({
      note: '- [ ] Buy milk',
      mock,
    });

    expect(mock.createIssue).toHaveBeenCalledTimes(1);
    expect(mock.createIssue.mock.calls[0]?.[0]?.summary).toBe('Buy milk');
    expect(result.mappings[0]?.counts.createdRemote).toBe(1);
    expect(writeNote).toHaveBeenCalledTimes(1);
    expect(written).toContain('/browse/PROJ-100');
    expect(written).toContain('Buy milk');
  });

  it('creates a local task from a remote-only board issue', async () => {
    const mock = createMockClient([
      issueRow('PROJ-55', 'Orphan remote', {
        description: 'Line one\nLine two',
      }),
    ]);
    const { result, written, writeNote } = await runSync({
      note: '# Notes\n',
      mock,
    });

    expect(result.mappings[0]?.counts.createdLocal).toBe(1);
    expect(writeNote).toHaveBeenCalledTimes(1);
    expect(written).toContain('[Orphan remote]');
    expect(written).toContain('/browse/PROJ-55');
    expect(written).toContain('- Line one');
  });

  it('pushes a local title change to Jira', async () => {
    const mock = createMockClient([issueRow('PROJ-1', 'Old title')]);
    const key = mappingKey(NOTE_PATH, BOARD_ID);
    const ledger = emptyLedger();
    ledger.entries[mappingLedgerKey('PROJ-1')] = makeLedgerEntry({
      issueKey: 'PROJ-1',
      mappingKey: key,
      title: 'Old title',
      description: '',
      status: 'todo',
      jiraStatusId: '1',
      jiraStatusName: 'To Do',
      parentIssueKey: null,
      jiraUpdated: '2026-01-01T00:00:00.000Z',
    });

    const { result } = await runSync({
      note: browseLink('PROJ-1', 'New title'),
      mock,
      ledger,
    });

    expect(result.mappings[0]?.counts.pushed).toBe(1);
    expect(mock.updateIssue).toHaveBeenCalled();
    const updateCall = mock.updateIssue.mock.calls.find((call) => call[0] === 'PROJ-1');
    expect(updateCall?.[1]?.summary).toBe('New title');
  });

  it('pulls a remote title change into the note', async () => {
    const mock = createMockClient([
      issueRow('PROJ-2', 'Remote title', {
        updated: '2026-02-01T00:00:00.000Z',
      }),
    ]);
    const key = mappingKey(NOTE_PATH, BOARD_ID);
    const ledger = emptyLedger();
    ledger.entries[mappingLedgerKey('PROJ-2')] = makeLedgerEntry({
      issueKey: 'PROJ-2',
      mappingKey: key,
      title: 'Old title',
      description: '',
      status: 'todo',
      jiraStatusId: '1',
      jiraStatusName: 'To Do',
      parentIssueKey: null,
      jiraUpdated: '2026-01-01T00:00:00.000Z',
    });

    const { result, written, writeNote } = await runSync({
      note: browseLink('PROJ-2', 'Old title'),
      mock,
      ledger,
    });

    expect(result.mappings[0]?.counts.pulled).toBe(1);
    expect(writeNote).toHaveBeenCalledTimes(1);
    expect(written).toContain('[Remote title]');
  });

  it('resolves conflicts with prefer-obsidian by pushing', async () => {
    const mock = createMockClient([
      issueRow('PROJ-3', 'Remote title', {
        updated: '2026-02-01T00:00:00.000Z',
      }),
    ]);
    const key = mappingKey(NOTE_PATH, BOARD_ID);
    const ledger = emptyLedger();
    ledger.entries[mappingLedgerKey('PROJ-3')] = makeLedgerEntry({
      issueKey: 'PROJ-3',
      mappingKey: key,
      title: 'Ledger title',
      description: '',
      status: 'todo',
      jiraStatusId: '1',
      jiraStatusName: 'To Do',
      parentIssueKey: null,
      jiraUpdated: '2026-01-01T00:00:00.000Z',
    });

    const { result } = await runSync({
      note: browseLink('PROJ-3', 'Obsidian title'),
      mock,
      ledger,
      conflictPolicy: 'prefer-obsidian',
    });

    expect(result.mappings[0]?.counts.conflictsResolved).toBe(1);
    expect(
      result.mappings[0]?.actions.some((action) => action.kind === 'conflict-push'),
    ).toBe(true);
    const updateCall = mock.updateIssue.mock.calls.find((call) => call[0] === 'PROJ-3');
    expect(updateCall?.[1]?.summary).toBe('Obsidian title');
  });

  it('resolves conflicts with prefer-jira by pulling', async () => {
    const mock = createMockClient([
      issueRow('PROJ-4', 'Remote wins', {
        updated: '2026-02-01T00:00:00.000Z',
      }),
    ]);
    const key = mappingKey(NOTE_PATH, BOARD_ID);
    const ledger = emptyLedger();
    ledger.entries[mappingLedgerKey('PROJ-4')] = makeLedgerEntry({
      issueKey: 'PROJ-4',
      mappingKey: key,
      title: 'Ledger title',
      description: '',
      status: 'todo',
      jiraStatusId: '1',
      jiraStatusName: 'To Do',
      parentIssueKey: null,
      jiraUpdated: '2026-01-01T00:00:00.000Z',
    });

    const { result, written } = await runSync({
      note: browseLink('PROJ-4', 'Obsidian title'),
      mock,
      ledger,
      conflictPolicy: 'prefer-jira',
    });

    expect(result.mappings[0]?.counts.conflictsResolved).toBe(1);
    expect(
      result.mappings[0]?.actions.some((action) => action.kind === 'conflict-pull'),
    ).toBe(true);
    expect(written).toContain('[Remote wins]');
  });

  it('reconciles Review labels without leaving Review when checkbox stays [/]', async () => {
    const mock = createMockClient([
      issueRow('PROJ-7', 'In review', {
        status: {
          id: '3',
          name: 'Review',
          statusCategory: { key: 'indeterminate' },
        },
        labels: ['in-progress', 'bug'],
        updated: '2026-01-01T00:00:00.000Z',
      }),
    ]);
    const key = mappingKey(NOTE_PATH, BOARD_ID);
    const ledger = emptyLedger();
    ledger.entries[mappingLedgerKey('PROJ-7')] = makeLedgerEntry({
      issueKey: 'PROJ-7',
      mappingKey: key,
      title: 'In review',
      description: '',
      status: 'in_progress',
      jiraStatusId: '3',
      jiraStatusName: 'Review',
      parentIssueKey: null,
      jiraUpdated: '2026-01-01T00:00:00.000Z',
    });

    const { result } = await runSync({
      note: inProgressLink('PROJ-7', 'In review'),
      mock,
      ledger,
    });

    expect(result.mappings[0]?.counts.unchanged).toBe(1);
    expect(result.mappings[0]?.counts.labelReconciliations).toBe(1);
    expect(mock.transitionIssue).not.toHaveBeenCalled();
    const labelUpdate = mock.updateIssue.mock.calls.find(
      (call) => call[0] === 'PROJ-7' && call[1]?.labels !== undefined,
    );
    expect(labelUpdate?.[1]?.labels).toEqual(['bug', 'review']);
  });

  it('does not write the note in dry-run mode', async () => {
    const mock = createMockClient();
    const ledgerBefore = emptyLedger();
    const { writeNote, ledger } = await runSync({
      note: '- [ ] Dry run task',
      mock,
      ledger: ledgerBefore,
      dryRun: true,
    });

    expect(writeNote).not.toHaveBeenCalled();
    expect(Object.keys(ledger.entries)).toHaveLength(0);
    expect(mock.createIssue).not.toHaveBeenCalled();
  });

  it('recovers a pending link instead of creating a duplicate issue', async () => {
    const mock = createMockClient();
    const key = mappingKey(NOTE_PATH, BOARD_ID);
    const pending: PendingLink[] = [
      {
        mappingKey: key,
        issueKey: 'PROJ-88',
        title: 'Pending task',
        description: '',
        status: 'todo',
        parentIssueKey: null,
        jiraUpdated: '2026-05-01T00:00:00.000Z',
      },
    ];

    const { result, written, writeNote } = await runSync({
      note: '- [ ] Pending task',
      mock,
      pending,
    });

    expect(mock.createIssue).not.toHaveBeenCalled();
    expect(result.mappings[0]?.counts.recoveredPendingLinks).toBe(1);
    expect(writeNote).toHaveBeenCalledTimes(1);
    expect(written).toContain('/browse/PROJ-88');
    expect(
      result.mappings[0]?.actions.some((action) => action.kind === 'recovered-pending'),
    ).toBe(true);
  });

  it('imports only board issues matching the mapping label filter', async () => {
    const mock = createMockClient([
      issueRow('PROJ-1', 'Alpha task', { labels: ['project-a'] }),
      issueRow('PROJ-2', 'Beta task', { labels: ['project-b'] }),
      issueRow('PROJ-3', 'Untagged task', { labels: [] }),
    ]);

    const { result, written } = await runSync({
      note: '# Notes\n',
      mock,
      labels: ['project-a'],
    });

    expect(result.mappings[0]?.counts.createdLocal).toBe(1);
    expect(written).toContain('Alpha task');
    expect(written).not.toContain('Beta task');
    expect(written).not.toContain('Untagged task');
  });

  it('attaches mapping filter labels when creating a remote issue', async () => {
    const mock = createMockClient();
    await runSync({
      note: '- [ ] Tagged from note',
      mock,
      labels: ['project-a'],
    });

    const createdLabels = mock.createIssue.mock.calls[0]?.[0]?.labels as string[] | undefined;
    expect(createdLabels).toEqual(expect.arrayContaining(['project-a', 'to-do']));
  });

  it('imports due from actual end and derives start from time tracking', async () => {
    const mock = createMockClient([
      issueRow('PROJ-50', 'Timed task', {
        duedate: '2026-10-10',
        customfield_actual: '2026-10-03T08:00:00.000+03:00',
        customfield_start: null,
        timetracking: { timeSpentSeconds: 3600 },
      }),
    ]);

    const { result, written } = await runSync({
      note: '# Notes\n',
      mock,
      startDateFieldId: 'customfield_start',
      actualEndFieldId: 'customfield_actual',
      targetEndFieldId: 'duedate',
    });

    expect(written).toContain('Timed task');
    expect(written).toContain('🛫');
    expect(written).toContain('📅');
    expect(
      result.mappings[0]?.actions.some((action) => action.kind === 'derive-start'),
    ).toBe(true);
    expect(result.message).toContain('actual end − time tracking');

    const startWrite = mock.updateIssue.mock.calls.find(
      (call) => call[0] === 'PROJ-50' && call[1]?.customFields?.customfield_start,
    );
    expect(startWrite).toBeTruthy();
  });

  it('pushes Obsidian due date to target end, not actual end', async () => {
    const mock = createMockClient([
      issueRow('PROJ-51', 'Due push', {
        duedate: '2026-10-10',
        customfield_actual: '2026-10-03',
      }),
    ]);

    const note =
      '- [ ] [Due push](https://jira.example/browse/PROJ-51) 📅 2026-11-01\n';
    const { ledger } = await runSync({
      note,
      mock,
      actualEndFieldId: 'customfield_actual',
      // First sync establishes ledger with pulled actual-end due.
      conflictPolicy: 'prefer-jira',
    });

    // Second sync: local due differs from remote actual-end due → push with prefer-obsidian.
    const noteChanged =
      '- [ ] [Due push](https://jira.example/browse/PROJ-51) 📅 2026-11-15\n';
    await runSync({
      note: noteChanged,
      mock,
      ledger,
      actualEndFieldId: 'customfield_actual',
      conflictPolicy: 'prefer-obsidian',
    });

    const duePush = mock.updateIssue.mock.calls.find(
      (call) => call[0] === 'PROJ-51' && call[1]?.duedate === '2026-11-15',
    );
    expect(duePush).toBeTruthy();
    const actualWrites = mock.updateIssue.mock.calls.filter(
      (call) => call[1]?.customFields?.customfield_actual !== undefined,
    );
    expect(actualWrites).toHaveLength(0);
  });
});
