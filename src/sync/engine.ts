import { parseNoteTasks } from '../note/parser';
import { toJiraDueDatePayload } from '../note/dates';
import type { ParsedTaskNode } from '../note/types';
import type { JiraClient } from '../jira/client';
import { describeIssueSyncFilter } from '../jira/issue-filter';
import { recencyJql, type RecencyField, type RecencyUnit } from '../jira/jql';
import {
  mappingRecencyFilter,
  type ConflictPolicy,
} from '../settings';
import {
  emptyActions,
  type SyncActionDetail,
} from './actions';
import {
  decideAssigneeReconcile,
  findMappingByObsidianValue,
  normalizeAssigneeMappings,
  toJiraAssigneePayload,
  type AssigneeMapping,
} from './assignee';
import {
  buildTargetEndWritePayload,
  dateIssueFieldIds,
  type DateFieldConfig,
} from './issue-dates';
import {
  mergeMappingLabels,
  normalizeMappingLabels,
} from './label-filter';
import {
  DEFAULT_TIME_SPENT_FIELD_ID,
  decideTimeSpentReconcile,
  timeSpentIssueFieldIds,
} from './timespent';
import { reconcileStatusLabels, desiredStatusLabel } from './labels';
import {
  cloneLedger,
  commitMappingLedger,
  contentHash,
  contentSnapshot,
  descriptionFromLines,
  descriptionToLines,
  ledgerEntryKey,
  makeLedgerEntry,
  mappingKey,
  normalizeDescription,
  type ContentSnapshot,
  type LedgerEntry,
  type LedgerStore,
  type PendingLink,
} from './ledger';
import {
  columnsFromBoardConfig,
  indexRemoteIssues,
  toRemoteIssueView,
  type RemoteIssueView,
} from './remote';
import {
  pickColumnForCoarseStatus,
  type BoardColumnView,
  type TaskStatus,
} from './status';
import {
  applyRootReplacements,
  checkboxCharForStatus,
  renderTask,
  type RenderableTask,
} from './writer';

export interface SyncMapping {
  notePath: string;
  boardId: number;
  /** Empty = all board issues; otherwise OR-match any listed label. */
  labels?: string[];
  /** Optional recency window (`0` / omit = no limit). */
  recencyValue?: number;
  recencyUnit?: RecencyUnit;
  recencyField?: RecencyField;
}

export interface SyncEngineOptions {
  baseUrl: string;
  conflictPolicy: ConflictPolicy;
  client: JiraClient;
  /** Custom field id for Start date; empty skips writing start to Jira. */
  startDateFieldId: string;
  /** Actual end field; when set, wins over target end for Obsidian due. */
  actualEndFieldId?: string;
  /** Target end field (default `duedate`); Obsidian due pushes here. */
  targetEndFieldId?: string;
  /** Jira ↔ Obsidian Dataview assignee mappings. */
  assigneeMappings?: AssigneeMapping[];
  /** Jira field for pull-only `[timespent:: seconds]` (default `timetracking`). */
  timeSpentFieldId?: string;
  readNote: (path: string) => Promise<string>;
  writeNote: (path: string, content: string) => Promise<void>;
  /** When true, list remotes but do not mutate Jira, notes, or the real ledger. */
  dryRun?: boolean;
  now?: () => string;
}

export interface MappingSyncCounts {
  createdRemote: number;
  createdLocal: number;
  pushed: number;
  pulled: number;
  conflictsResolved: number;
  unchanged: number;
  unresolvedRemovals: number;
  recoveredPendingLinks: number;
  labelReconciliations: number;
  assigneeReconciliations: number;
  timeSpentReconciliations: number;
}

export interface MappingSyncResult {
  notePath: string;
  boardId: number;
  /** Normalized filter labels used for this run (empty = whole board). */
  labels: string[];
  /** Recency filter used for this run, or null when disabled. */
  recency: { field: RecencyField; value: number; unit: RecencyUnit } | null;
  counts: MappingSyncCounts;
  /** Per-task actions for informative dry-run / sync reports. */
  actions: SyncActionDetail[];
  errors: string[];
  unresolvedIssueKeys: string[];
  /** Creates that reached Jira but could not be written into the note. */
  pendingLinks: PendingLink[];
}

export interface SyncRunResult {
  mappings: MappingSyncResult[];
  message: string;
  dryRun: boolean;
}

export type { SyncActionDetail } from './actions';

interface MutableTask {
  lineIndex: number | null;
  endLineIndex: number | null;
  indent: string;
  listMarker: string;
  checkboxChar: string;
  status: TaskStatus | null;
  title: string;
  descriptionLines: string[];
  issueKey: string | null;
  startDate: string | null;
  dueDate: string | null;
  assignee: string | null;
  timeSpentSeconds: number | null;
  children: MutableTask[];
  parent: MutableTask | null;
  isNew: boolean;
  dirty: boolean;
}

interface MappingContext {
  columns: BoardColumnView[];
  projectKey: string;
  dateFields: DateFieldConfig;
  issueFields: string[];
  /** Normalized OR-filter labels for this mapping (empty = all issues). */
  filterLabels: string[];
  assigneeMappings: AssigneeMapping[];
  timeSpentFieldId: string;
}

let fakeIssueCounter = 0;

export async function syncAllMappings(
  mappings: SyncMapping[],
  ledger: LedgerStore,
  pendingLinks: PendingLink[],
  options: SyncEngineOptions,
): Promise<SyncRunResult> {
  const results: MappingSyncResult[] = [];
  const dryRun = options.dryRun === true;
  const nextPending = [...pendingLinks];

  for (const mapping of mappings) {
    const notePath = normalizeNotePath(mapping.notePath);
    const boardId = mapping.boardId;
    const labels = normalizeMappingLabels(mapping.labels);
    const recency = mappingRecencyFilter(mapping);

    if (!notePath && !(boardId > 0)) {
      continue;
    }

    if (!notePath || boardId <= 0) {
      results.push({
        notePath,
        boardId,
        labels: [],
        recency: null,
        counts: emptyCounts(),
        actions: emptyActions(),
        errors: [
          !notePath && boardId > 0
            ? `Mapping is incomplete: note path is missing (board id ${boardId})`
            : `Mapping is incomplete: board id is missing (note path "${notePath}")`,
        ],
        unresolvedIssueKeys: [],
        pendingLinks: [],
      });
      continue;
    }

    try {
      const result = await syncOneMapping(
        {
          notePath,
          boardId,
          labels,
          recencyValue: mapping.recencyValue,
          recencyUnit: mapping.recencyUnit,
          recencyField: mapping.recencyField,
        },
        ledger,
        nextPending,
        { ...options, dryRun },
      );
      results.push(result);

      const key = mappingKey(notePath, boardId, labels);
      for (let i = nextPending.length - 1; i >= 0; i -= 1) {
        if (nextPending[i]?.mappingKey === key) {
          nextPending.splice(i, 1);
        }
      }
      if (!dryRun) {
        nextPending.push(...result.pendingLinks);
      }
    } catch (error) {
      results.push({
        notePath,
        boardId,
        labels,
        recency,
        counts: emptyCounts(),
        actions: emptyActions(),
        errors: [errorMessage(error)],
        unresolvedIssueKeys: [],
        pendingLinks: [],
      });
    }
  }

  pendingLinks.splice(0, pendingLinks.length, ...nextPending);

  const errorCount = results.reduce((sum, item) => sum + item.errors.length, 0);
  const totals = results.reduce((acc, item) => addCounts(acc, item.counts), emptyCounts());
  const allActions = results.flatMap((item) => item.actions);

  return {
    mappings: results,
    dryRun,
    message: summarizeRun(totals, errorCount, mappings.length, dryRun, allActions),
  };
}

export async function syncOneMapping(
  mapping: SyncMapping,
  ledger: LedgerStore,
  pendingLinks: PendingLink[],
  options: SyncEngineOptions,
): Promise<MappingSyncResult> {
  const counts = emptyCounts();
  const actions = emptyActions();
  const errors: string[] = [];
  const unresolvedKeys: string[] = [];
  const createdPending: PendingLink[] = [];
  const now = options.now ?? (() => new Date().toISOString());
  const dryRun = options.dryRun === true;
  const filterLabels = normalizeMappingLabels(mapping.labels);
  const recency = mappingRecencyFilter(mapping);
  const key = mappingKey(mapping.notePath, mapping.boardId, filterLabels);
  const workingLedger = cloneLedger(ledger);
  const syncFilter = { labels: filterLabels, recency };

  const markdown = await options.readNote(mapping.notePath);
  const parsed = parseNoteTasks(markdown, { jiraBaseUrl: options.baseUrl });
  const roots = parsed.map((node) => fromParsed(node, null));

  let ctx: MappingContext;
  try {
    ctx = await loadMappingContext(
      options.client,
      mapping.boardId,
      {
        startDateFieldId: options.startDateFieldId,
        actualEndFieldId: options.actualEndFieldId,
        targetEndFieldId: options.targetEndFieldId,
      },
      filterLabels,
      options.assigneeMappings,
      options.timeSpentFieldId,
    );
  } catch (error) {
    return {
      notePath: mapping.notePath,
      boardId: mapping.boardId,
      labels: filterLabels,
      recency,
      counts,
      actions,
      errors: [errorMessage(error)],
      unresolvedIssueKeys: [],
      pendingLinks: [],
    };
  }

  if (!ctx.projectKey) {
    errors.push(`Board ${mapping.boardId} has no project key; cannot create issues`);
  }

  let remoteMap = new Map<string, RemoteIssueView>();
  if (ctx.issueFields.length) {
    try {
      // Label/recency filtering is applied inside the client (JQL / Agile). Do
      // not re-filter client-side: Cloud Agile often returns labels: [] even
      // when the issue matched labels in ("…") server-side.
      const fetched = await options.client.listBoardIssuesForSync(
        mapping.boardId,
        ctx.issueFields,
        syncFilter,
      );
      const indexed = indexRemoteIssues(fetched, ctx.columns, {
        dateFields: ctx.dateFields,
        timeSpentFieldId: ctx.timeSpentFieldId,
        mappingProjectKey: ctx.projectKey,
      });
      remoteMap = indexed.remoteMap;
      for (const cycleError of indexed.cycleErrors) {
        errors.push(cycleError);
      }
    } catch (error) {
      errors.push(errorMessage(error));
    }
  }

  const hasActiveFilter =
    filterLabels.length > 0 || Boolean(recencyJql(recency));
  if (hasActiveFilter && remoteMap.size === 0 && errors.length === 0) {
    errors.push(
      `No Jira issues matched ${describeIssueSyncFilter(syncFilter)} for board ${mapping.boardId}. ` +
        'Confirm the label spelling, recency window, and that issues are in the board’s project.',
    );
  }

  const localByKey = new Map<string, MutableTask>();
  const localOrder: MutableTask[] = [];
  walkMutable(roots, (task) => {
    localOrder.push(task);
    if (task.issueKey !== null) {
      localByKey.set(task.issueKey.toUpperCase(), task);
    }
  });

  const mappingPending = pendingLinks.filter((item) => item.mappingKey === key);

  for (const local of localOrder) {
    const parentIssueKey = local.parent?.issueKey?.toUpperCase() ?? null;

    if (local.issueKey === null) {
      const recovered = takePendingMatch(mappingPending, local.title, parentIssueKey);
      if (recovered) {
        const issueKey = recovered.issueKey.toUpperCase();
        local.issueKey = issueKey;
        local.dirty = true;
        markRootDirty(local);
        localByKey.set(issueKey, local);
        writeLedgerFromLocal(
          workingLedger,
          key,
          issueKey,
          local,
          parentIssueKey,
          recovered.status,
          recovered.jiraUpdated,
          '',
          '',
          now,
        );
        counts.recoveredPendingLinks += 1;
        counts.createdRemote += 1;
        actions.push({
          kind: 'recovered-pending',
          title: local.title,
          issueKey,
          detail: 'relink previously created Jira issue that was not yet written into the note',
        });
        continue;
      }

      if (!ctx.projectKey) {
        errors.push(`Create remote "${local.title}": board project key is unknown`);
        continue;
      }

      const startErr = startDateConfigError(local, ctx.dateFields.startDateFieldId ?? '');
      if (startErr) {
        errors.push(startErr);
      }

      try {
        const status = local.status ?? 'todo';
        const targetColumn = pickColumnForCoarseStatus(ctx.columns, status);
        const initialLabels: string[] = mergeMappingLabels([], filterLabels);
        if (targetColumn) {
          const label = desiredStatusLabel(targetColumn.name);
          if (label) {
            initialLabels.push(label);
          }
        }

        const created = dryRun
          ? fakeCreatedIssue(local, ctx.projectKey, status, targetColumn, now(), initialLabels)
          : await createRemoteIssue(
              options.client,
              ctx,
              local,
              parentIssueKey,
              status,
              initialLabels,
              startErr === undefined,
            );

        if (!dryRun && targetColumn) {
          await transitionToColumn(options.client, created.key, targetColumn, false);
          const refreshed = await options.client.getIssue(created.key, ctx.issueFields);
          const view = toRemoteIssueView(refreshed, ctx.columns, {
            dateFields: ctx.dateFields,
            timeSpentFieldId: ctx.timeSpentFieldId,
          });
          Object.assign(created, view);
        }

        local.issueKey = created.key;
        local.dirty = true;
        markRootDirty(local);
        localByKey.set(created.key, local);

        if (!dryRun) {
          await runLabelReconcile(
            options.client,
            created,
            ctx,
            dryRun,
            counts,
            actions,
          );
        }
        await runAssigneeReconcile(
          options.client,
          local,
          created,
          ctx,
          dryRun,
          counts,
          actions,
          errors,
        );
        runTimeSpentReconcile(local, created, counts, actions);

        writeLedgerFromRemote(workingLedger, key, created, now);

        createdPending.push({
          mappingKey: key,
          issueKey: created.key,
          title: local.title,
          description: descriptionFromLines(local.descriptionLines),
          status,
          parentIssueKey,
          jiraUpdated: created.updated || now(),
        });
        counts.createdRemote += 1;
        actions.push({
          kind: 'create-remote',
          title: local.title,
          issueKey: created.key,
          detail: 'unlinked checklist item in the note',
        });
      } catch (error) {
        errors.push(`Create remote "${local.title}": ${errorMessage(error)}`);
      }
      continue;
    }

    const issueKey = local.issueKey.toUpperCase();
    const remote = remoteMap.get(issueKey);
    const entry = workingLedger.entries[ledgerEntryKey(key, issueKey)];

    if (!remote) {
      if (entry) {
        entry.unresolved = true;
        unresolvedKeys.push(issueKey);
        counts.unresolvedRemovals += 1;
        actions.push({
          kind: 'unresolved-missing-remote',
          title: local.title || entry.title,
          issueKey,
          detail: 'still linked in the note, but Jira no longer returns this issue on the board',
        });
      } else {
        errors.push(`Linked issue ${issueKey} is missing in Jira and has no ledger entry`);
      }
      continue;
    }

    const localSnap = localSnapshot(local, parentIssueKey, entry);
    const remoteSnap = remoteSnapshot(remote);
    const localHash = contentHash(localSnap);
    const remoteHash = contentHash(remoteSnap);

    if (!entry) {
      if (localHash === remoteHash) {
        writeLedgerFromRemote(workingLedger, key, remote, now);
        counts.unchanged += 1;
        actions.push({ kind: 'unchanged', title: local.title, issueKey });
        await writeDerivedStartIfNeeded(
          options.client,
          remote,
          ctx,
          dryRun,
          actions,
        );
        await runLabelReconcile(
          options.client,
          remote,
          ctx,
          dryRun,
          counts,
          actions,
        );
        await runAssigneeReconcile(
          options.client,
          local,
          remote,
          ctx,
          dryRun,
          counts,
          actions,
          errors,
        );
        runTimeSpentReconcile(local, remote, counts, actions);
      } else if (options.conflictPolicy === 'prefer-obsidian') {
        await pushLocal(
          options,
          ctx,
          local,
          remote,
          parentIssueKey,
          key,
          workingLedger,
          now,
          counts,
          actions,
          errors,
          true,
          dryRun,
        );
      } else {
        pullRemote(
          local,
          remote,
          key,
          workingLedger,
          now,
          counts,
          actions,
          true,
        );
        await writeDerivedStartIfNeeded(
          options.client,
          remote,
          ctx,
          dryRun,
          actions,
        );
        await runLabelReconcile(
          options.client,
          remote,
          ctx,
          dryRun,
          counts,
          actions,
        );
        await runAssigneeReconcile(
          options.client,
          local,
          remote,
          ctx,
          dryRun,
          counts,
          actions,
          errors,
        );
        runTimeSpentReconcile(local, remote, counts, actions);
      }
      continue;
    }

    const localChanged = localHash !== entry.contentHash;
    const remoteChanged =
      remoteHash !== entry.contentHash || remote.updated !== entry.jiraUpdated;

    if (!localChanged && !remoteChanged) {
      entry.unresolved = false;
      counts.unchanged += 1;
      actions.push({ kind: 'unchanged', title: local.title, issueKey });
      await writeDerivedStartIfNeeded(
        options.client,
        remote,
        ctx,
        dryRun,
        actions,
      );
      await runLabelReconcile(
          options.client,
          remote,
          ctx,
          dryRun,
          counts,
          actions,
        );
      await runAssigneeReconcile(
        options.client,
        local,
        remote,
        ctx,
        dryRun,
        counts,
        actions,
        errors,
      );
      runTimeSpentReconcile(local, remote, counts, actions);
      continue;
    }

    if (localChanged && !remoteChanged) {
      await pushLocal(
        options,
        ctx,
        local,
        remote,
        parentIssueKey,
        key,
        workingLedger,
        now,
        counts,
        actions,
        errors,
        false,
        dryRun,
      );
      continue;
    }

    if (!localChanged && remoteChanged) {
      pullRemote(
        local,
        remote,
        key,
        workingLedger,
        now,
        counts,
        actions,
        false,
      );
      await writeDerivedStartIfNeeded(
        options.client,
        remote,
        ctx,
        dryRun,
        actions,
      );
      await runLabelReconcile(
          options.client,
          remote,
          ctx,
          dryRun,
          counts,
          actions,
        );
      await runAssigneeReconcile(
        options.client,
        local,
        remote,
        ctx,
        dryRun,
        counts,
        actions,
        errors,
      );
      runTimeSpentReconcile(local, remote, counts, actions);
      continue;
    }

    if (options.conflictPolicy === 'prefer-obsidian') {
      await pushLocal(
        options,
        ctx,
        local,
        remote,
        parentIssueKey,
        key,
        workingLedger,
        now,
        counts,
        actions,
        errors,
        true,
        dryRun,
      );
    } else {
      pullRemote(
        local,
        remote,
        key,
        workingLedger,
        now,
        counts,
        actions,
        true,
      );
      await writeDerivedStartIfNeeded(
        options.client,
        remote,
        ctx,
        dryRun,
        actions,
      );
      await runLabelReconcile(
          options.client,
          remote,
          ctx,
          dryRun,
          counts,
          actions,
        );
      await runAssigneeReconcile(
        options.client,
        local,
        remote,
        ctx,
        dryRun,
        counts,
        actions,
        errors,
      );
      runTimeSpentReconcile(local, remote, counts, actions);
    }
  }

  const remotes = [...remoteMap.values()].sort((a, b) => {
    if (a.parentIssueKey === null && b.parentIssueKey !== null) {
      return -1;
    }
    if (a.parentIssueKey !== null && b.parentIssueKey === null) {
      return 1;
    }
    return a.key.localeCompare(b.key);
  });

  for (const remote of remotes) {
    if (localByKey.has(remote.key)) {
      continue;
    }
    const entry = workingLedger.entries[ledgerEntryKey(key, remote.key)];
    if (entry) {
      entry.unresolved = true;
      unresolvedKeys.push(remote.key);
      counts.unresolvedRemovals += 1;
      actions.push({
        kind: 'unresolved-missing-local',
        title: entry.title || remote.title,
        issueKey: remote.key,
        detail: 'was synced before, still exists in Jira, but is no longer in the note',
      });
      continue;
    }

    const created = createLocalNode(remote);
    const parentLocal =
      remote.parentIssueKey !== null
        ? localByKey.get(remote.parentIssueKey) ?? null
        : null;
    if (parentLocal) {
      created.indent = `${parentLocal.indent}    `;
      created.parent = parentLocal;
      parentLocal.children.push(created);
      markRootDirty(parentLocal);
    } else {
      created.isNew = true;
      roots.push(created);
    }
    localByKey.set(remote.key, created);
    writeLedgerFromRemote(workingLedger, key, remote, now);
    await writeDerivedStartIfNeeded(
      options.client,
      remote,
      ctx,
      dryRun,
      actions,
    );
    await runLabelReconcile(
          options.client,
          remote,
          ctx,
          dryRun,
          counts,
          actions,
        );
    await runAssigneeReconcile(
      options.client,
      created,
      remote,
      ctx,
      dryRun,
      counts,
      actions,
      errors,
    );
    runTimeSpentReconcile(created, remote, counts, actions);
    counts.createdLocal += 1;
    const importDetails = ['exists in Jira and was never synced to this note'];
    if (remote.startDateSource === 'derived' && remote.startDateDerivedDetail) {
      importDetails.push(remote.startDateDerivedDetail);
    } else if (remote.dueDateSource === 'actual-end') {
      importDetails.push('due date from actual end');
    }
    actions.push({
      kind: 'create-local',
      title: remote.title,
      issueKey: remote.key,
      detail: importDetails.join('; '),
    });
  }

  const nextMarkdown = writeMarkdown(markdown, roots, options.baseUrl);
  const noteChanged = nextMarkdown !== markdown;

  if (noteChanged) {
    if (dryRun) {
      return {
        notePath: mapping.notePath,
        boardId: mapping.boardId,
        labels: filterLabels,
        recency,
        counts,
        actions,
        errors,
        unresolvedIssueKeys: unresolvedKeys,
        pendingLinks: [],
      };
    }

    try {
      await options.writeNote(mapping.notePath, nextMarkdown);
    } catch (error) {
      errors.push(`Write note failed: ${errorMessage(error)}`);
      return {
        notePath: mapping.notePath,
        boardId: mapping.boardId,
        labels: filterLabels,
        recency,
        counts: {
          ...counts,
          createdLocal: 0,
        },
        actions,
        errors,
        unresolvedIssueKeys: unresolvedKeys,
        pendingLinks: createdPending,
      };
    }
  }

  if (!dryRun) {
    commitMappingLedger(ledger, workingLedger, key);
  }

  return {
    notePath: mapping.notePath,
    boardId: mapping.boardId,
    labels: filterLabels,
    recency,
    counts,
    actions,
    errors,
    unresolvedIssueKeys: unresolvedKeys,
    pendingLinks: [],
  };
}

async function pushLocal(
  options: SyncEngineOptions,
  ctx: MappingContext,
  local: MutableTask,
  remote: RemoteIssueView,
  parentIssueKey: string | null,
  key: string,
  ledger: LedgerStore,
  now: () => string,
  counts: MappingSyncCounts,
  actions: SyncActionDetail[],
  errors: string[],
  isConflict: boolean,
  dryRun: boolean,
): Promise<void> {
  const startErr = startDateConfigError(local, ctx.dateFields.startDateFieldId ?? '');
  if (startErr) {
    errors.push(startErr);
  }

  try {
    const status = local.status ?? remote.status;
    const targetWrite = buildTargetEndWritePayload(ctx.dateFields, local.dueDate);
    const startFields =
      startErr === undefined
        ? buildStartCustomFields(ctx.dateFields.startDateFieldId ?? '', local.startDate)
        : undefined;

    if (!dryRun) {
      await options.client.updateIssue(remote.key, {
        summary: local.title,
        description: descriptionFromLines(local.descriptionLines),
        duedate: targetWrite.duedate,
        customFields: mergeCustomFields(targetWrite.customFields, startFields),
      });
      const wantedParent = parentIssueKey?.toUpperCase() ?? null;
      const remoteParent = remote.parentIssueKey?.toUpperCase() ?? null;
      if (wantedParent && wantedParent !== remoteParent) {
        if (remoteParent) {
          await options.client.unlinkChildBlocksParent(remote.key, remoteParent);
        }
        await options.client.linkChildBlocksParent(remote.key, wantedParent);
      } else if (!wantedParent && remoteParent) {
        await options.client.unlinkChildBlocksParent(remote.key, remoteParent);
      }
    }

    let columnName = remote.columnName;
    let jiraStatusId = remote.jiraStatusId;
    let jiraStatusName = remote.jiraStatusName;

    if (status !== remote.status) {
      const targetColumn = pickColumnForCoarseStatus(ctx.columns, status);
      if (targetColumn) {
        await transitionToColumn(options.client, remote.key, targetColumn, dryRun);
        columnName = targetColumn.name;
        const primaryStatusId = targetColumn.statusIds[0];
        if (primaryStatusId) {
          jiraStatusId = primaryStatusId;
        }
        jiraStatusName = targetColumn.name;
      }
    }

    const labelRemote: RemoteIssueView = {
      ...remote,
      title: local.title,
      description: normalizeDescription(descriptionFromLines(local.descriptionLines)),
      status,
      columnName,
      jiraStatusId,
      jiraStatusName,
      parentIssueKey,
      startDate: local.startDate,
      dueDate: local.dueDate,
      labels: remote.labels,
    };

    await runLabelReconcile(
          options.client,
          labelRemote,
          ctx,
          dryRun,
          counts,
          actions,
        );
    await runAssigneeReconcile(
      options.client,
      local,
      labelRemote,
      ctx,
      dryRun,
      counts,
      actions,
      errors,
    );
    runTimeSpentReconcile(local, labelRemote, counts, actions);

    writeLedgerFromLocal(
      ledger,
      key,
      remote.key,
      local,
      parentIssueKey,
      status,
      now(),
      jiraStatusId,
      jiraStatusName,
      now,
    );

    local.dirty = true;
    markRootDirty(local);

    if (isConflict) {
      counts.conflictsResolved += 1;
      actions.push({
        kind: 'conflict-push',
        title: local.title,
        issueKey: remote.key,
        detail: 'both sides changed; Obsidian wins',
      });
    } else {
      counts.pushed += 1;
      actions.push({
        kind: 'push',
        title: local.title,
        issueKey: remote.key,
      });
    }
  } catch (error) {
    errors.push(`Push ${remote.key}: ${errorMessage(error)}`);
  }
}

function pullRemote(
  local: MutableTask,
  remote: RemoteIssueView,
  key: string,
  ledger: LedgerStore,
  now: () => string,
  counts: MappingSyncCounts,
  actions: SyncActionDetail[],
  isConflict: boolean,
): void {
  local.title = remote.title;
  local.descriptionLines = descriptionToLines(remote.description);
  local.status = remote.status;
  local.checkboxChar = checkboxCharForStatus(remote.status);
  local.startDate = remote.startDate;
  local.dueDate = remote.dueDate;
  local.issueKey = remote.key;
  local.dirty = true;
  markRootDirty(local);
  writeLedgerFromRemote(ledger, key, remote, now);
  const details: string[] = [];
  if (isConflict) {
    details.push('both sides changed; Jira wins');
  }
  if (remote.startDateSource === 'derived' && remote.startDateDerivedDetail) {
    details.push(remote.startDateDerivedDetail);
  } else if (remote.dueDateSource === 'actual-end') {
    details.push('due date from actual end');
  }
  if (isConflict) {
    counts.conflictsResolved += 1;
    actions.push({
      kind: 'conflict-pull',
      title: remote.title,
      issueKey: remote.key,
      detail: details.join('; ') || undefined,
    });
  } else {
    counts.pulled += 1;
    actions.push({
      kind: 'pull',
      title: remote.title,
      issueKey: remote.key,
      detail: details.length > 0 ? details.join('; ') : undefined,
    });
  }
}

/**
 * When start was derived from actual end − time tracking and the Jira Start
 * field is still empty, write the calculated start into Jira and report it.
 */
async function writeDerivedStartIfNeeded(
  client: JiraClient,
  remote: RemoteIssueView,
  ctx: MappingContext,
  dryRun: boolean,
  actions: SyncActionDetail[],
): Promise<void> {
  if (remote.startDateSource !== 'derived' || !remote.startDate) {
    return;
  }
  if (remote.jiraStartDate) {
    return;
  }
  const startFieldId = ctx.dateFields.startDateFieldId?.trim() ?? '';
  if (!startFieldId) {
    return;
  }
  const detail =
    remote.startDateDerivedDetail ??
    'set start date from actual end − time tracking';
  if (!dryRun) {
    const customFields = buildStartCustomFields(startFieldId, remote.startDate);
    if (customFields) {
      await client.updateIssue(remote.key, { customFields });
    }
  }
  actions.push({
    kind: 'derive-start',
    title: remote.title,
    issueKey: remote.key,
    detail,
  });
}

/**
 * Sync Dataview `[assignee:: …]` ↔ Jira assignee for open tasks.
 * Skipped when both Obsidian and Jira are done. Unmapped users are ignored.
 */
async function runAssigneeReconcile(
  client: JiraClient,
  local: MutableTask,
  remote: RemoteIssueView,
  ctx: MappingContext,
  dryRun: boolean,
  counts: MappingSyncCounts,
  actions: SyncActionDetail[],
  errors: string[],
): Promise<void> {
  if (ctx.assigneeMappings.length === 0) {
    return;
  }
  if (local.status === 'done' && remote.status === 'done') {
    return;
  }

  const decision = decideAssigneeReconcile({
    localAssignee: local.assignee,
    remoteAssigneeId: remote.assigneeAccountId,
    mappings: ctx.assigneeMappings,
  });

  if (decision.action === 'none') {
    return;
  }

  try {
    if (decision.action === 'set-local') {
      local.assignee = decision.obsidianValue;
      local.dirty = true;
      markRootDirty(local);
      counts.assigneeReconciliations += 1;
      actions.push({
        kind: 'reconcile-assignee',
        title: local.title,
        issueKey: remote.key,
        detail: decision.detail,
      });
      return;
    }

    if (!dryRun) {
      await client.updateIssue(remote.key, {
        assignee: toJiraAssigneePayload(decision.mapping),
      });
    }
    remote.assigneeAccountId = decision.mapping.jiraAccountId;
    remote.assigneeDisplayName = decision.mapping.jiraDisplayName;
    counts.assigneeReconciliations += 1;
    actions.push({
      kind: 'reconcile-assignee',
      title: local.title,
      issueKey: remote.key,
      detail: decision.detail,
    });
  } catch (error) {
    errors.push(`Assignee ${remote.key}: ${errorMessage(error)}`);
  }
}

/**
 * Pull-only: Dataview `[timespent:: seconds]` ← Jira time spent for open tasks.
 * Skipped when both sides are done. Never writes back to Jira.
 */
function runTimeSpentReconcile(
  local: MutableTask,
  remote: RemoteIssueView,
  counts: MappingSyncCounts,
  actions: SyncActionDetail[],
): void {
  if (local.status === 'done' && remote.status === 'done') {
    return;
  }
  const decision = decideTimeSpentReconcile({
    localSeconds: local.timeSpentSeconds,
    remoteSeconds: remote.timeSpentSeconds,
  });
  if (decision.action === 'none') {
    return;
  }
  local.timeSpentSeconds = decision.seconds;
  local.dirty = true;
  markRootDirty(local);
  counts.timeSpentReconciliations += 1;
  actions.push({
    kind: 'reconcile-timespent',
    title: local.title,
    issueKey: remote.key,
    detail: decision.detail,
  });
}

async function runLabelReconcile(
  client: JiraClient,
  remote: RemoteIssueView,
  ctx: MappingContext,
  dryRun: boolean,
  counts: MappingSyncCounts,
  actions: SyncActionDetail[],
): Promise<void> {
  const filterLabels = ctx.filterLabels;
  const statusResult = await reconcileStatusLabels(
    client,
    remote.key,
    remote.labels,
    remote.columnName,
    ctx.columns,
    dryRun,
  );
  let labels = statusResult.labels;
  if (statusResult.changed) {
    counts.labelReconciliations += 1;
    actions.push({
      kind: 'reconcile-labels',
      title: remote.title,
      issueKey: remote.key,
      detail: `align labels with column "${remote.columnName}"`,
    });
  }

  const withFilter = mergeMappingLabels(labels, filterLabels);
  const beforeSet = new Set(labels.map((label) => label.toLowerCase()));
  const afterSet = new Set(withFilter.map((label) => label.toLowerCase()));
  const needsFilterWrite =
    afterSet.size !== beforeSet.size || [...afterSet].some((label) => !beforeSet.has(label));

  if (needsFilterWrite) {
    if (!dryRun) {
      await client.updateIssue(remote.key, { labels: withFilter });
    }
    labels = withFilter;
    counts.labelReconciliations += 1;
    actions.push({
      kind: 'reconcile-labels',
      title: remote.title,
      issueKey: remote.key,
      detail: `ensure mapping filter labels (${normalizeMappingLabels(filterLabels).join(', ')})`,
    });
  }

  remote.labels = labels;
}

async function loadMappingContext(
  client: JiraClient,
  boardId: number,
  dateFields: DateFieldConfig,
  filterLabels: readonly string[] = [],
  assigneeMappings: readonly AssigneeMapping[] | undefined = [],
  timeSpentFieldId: string | undefined = DEFAULT_TIME_SPENT_FIELD_ID,
): Promise<MappingContext> {
  const [board, config] = await Promise.all([
    client.getBoard(boardId),
    client.getBoardConfiguration(boardId),
  ]);
  const columns = columnsFromBoardConfig(config);
  const projectKey = String(board.location?.projectKey ?? '').trim();
  const normalizedDateFields: DateFieldConfig = {
    startDateFieldId: dateFields.startDateFieldId?.trim() || undefined,
    actualEndFieldId: dateFields.actualEndFieldId?.trim() || undefined,
    targetEndFieldId: dateFields.targetEndFieldId?.trim() || 'duedate',
  };
  const normalizedTimeSpent =
    timeSpentFieldId?.trim() || DEFAULT_TIME_SPENT_FIELD_ID;
  const issueFields = [
    'summary',
    'description',
    'status',
    'issuetype',
    'project',
    'parent',
    'issuelinks',
    'labels',
    'assignee',
    'updated',
    'created',
    ...dateIssueFieldIds(normalizedDateFields),
    ...timeSpentIssueFieldIds(normalizedTimeSpent),
  ];
  return {
    columns,
    projectKey,
    dateFields: normalizedDateFields,
    issueFields: [...new Set(issueFields)],
    filterLabels: normalizeMappingLabels(filterLabels),
    assigneeMappings: normalizeAssigneeMappings(assigneeMappings),
    timeSpentFieldId: normalizedTimeSpent,
  };
}

async function createRemoteIssue(
  client: JiraClient,
  ctx: MappingContext,
  local: MutableTask,
  parentIssueKey: string | null,
  status: TaskStatus,
  labels: string[],
  includeStartField: boolean,
): Promise<RemoteIssueView> {
  const targetWrite = buildTargetEndWritePayload(ctx.dateFields, local.dueDate);
  const startFields = includeStartField
    ? buildStartCustomFields(ctx.dateFields.startDateFieldId ?? '', local.startDate)
    : undefined;
  const assigneeMapping = findMappingByObsidianValue(ctx.assigneeMappings, local.assignee);

  // Nesting = Blocks link (child blocks parent), not Sub-task / hierarchy parent.
  const created = await client.createIssue({
    projectKey: ctx.projectKey,
    summary: local.title,
    description: descriptionFromLines(local.descriptionLines),
    labels: labels.length > 0 ? labels : undefined,
    duedate: targetWrite.duedate,
    assignee: assigneeMapping ? toJiraAssigneePayload(assigneeMapping) : undefined,
    customFields: mergeCustomFields(targetWrite.customFields, startFields),
  });

  if (parentIssueKey) {
    await client.linkChildBlocksParent(created.key, parentIssueKey);
  }

  const view = toRemoteIssueView(created, ctx.columns, {
    dateFields: ctx.dateFields,
    timeSpentFieldId: ctx.timeSpentFieldId,
  });
  return parentIssueKey
    ? { ...view, parentIssueKey: parentIssueKey.toUpperCase() }
    : view;
}

async function transitionToColumn(
  client: JiraClient,
  issueKey: string,
  column: BoardColumnView,
  dryRun: boolean,
): Promise<void> {
  if (dryRun || column.statusIds.length === 0) {
    return;
  }
  const allowed = new Set(column.statusIds);
  const transitions = await client.listTransitions(issueKey);
  const match = transitions.find((transition) => allowed.has(String(transition.to.id)));
  if (match) {
    await client.transitionIssue(issueKey, match.id);
  }
}

function takePendingMatch(
  pending: PendingLink[],
  title: string,
  parentIssueKey: string | null,
): PendingLink | null {
  const index = pending.findIndex(
    (item) => item.title === title && item.parentIssueKey === parentIssueKey,
  );
  if (index < 0) {
    return null;
  }
  const [match] = pending.splice(index, 1);
  return match ?? null;
}

function fakeCreatedIssue(
  local: MutableTask,
  projectKey: string,
  status: TaskStatus,
  column: BoardColumnView | null,
  updated: string,
  labels: string[] = [],
): RemoteIssueView {
  fakeIssueCounter += 1;
  const key = `FAKE-${fakeIssueCounter}`;
  const columnName = column?.name ?? 'To Do';
  return {
    key,
    title: local.title,
    description: normalizeDescription(descriptionFromLines(local.descriptionLines)),
    status,
    jiraStatusId: column?.statusIds[0] ?? '',
    jiraStatusName: columnName,
    columnName,
    parentIssueKey: local.parent?.issueKey?.toUpperCase() ?? null,
    labels: [...labels],
    startDate: local.startDate,
    dueDate: local.dueDate,
    startDateSource: local.startDate ? 'field' : null,
    dueDateSource: local.dueDate ? 'target-end' : null,
    jiraStartDate: local.startDate,
    startDateDerivedDetail: null,
    assigneeAccountId: null,
    assigneeDisplayName: null,
    timeSpentSeconds: local.timeSpentSeconds,
    updated,
    projectKey,
    isSubtask: local.parent?.issueKey !== null && local.parent?.issueKey !== undefined,
  };
}

function mergeCustomFields(
  ...parts: Array<Record<string, unknown> | undefined>
): Record<string, unknown> | undefined {
  const merged: Record<string, unknown> = {};
  for (const part of parts) {
    if (!part) {
      continue;
    }
    Object.assign(merged, part);
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function writeLedgerFromRemote(
  ledger: LedgerStore,
  key: string,
  remote: RemoteIssueView,
  now: () => string,
): void {
  ledger.entries[ledgerEntryKey(key, remote.key)] = makeLedgerEntry({
    issueKey: remote.key,
    mappingKey: key,
    title: remote.title,
    description: remote.description,
    status: remote.status,
    jiraStatusId: remote.jiraStatusId,
    jiraStatusName: remote.jiraStatusName,
    parentIssueKey: remote.parentIssueKey,
    startDate: remote.startDate,
    dueDate: remote.dueDate,
    jiraUpdated: remote.updated || now(),
    lastSyncedAt: now(),
    unresolved: false,
  });
}

function writeLedgerFromLocal(
  ledger: LedgerStore,
  key: string,
  issueKey: string,
  local: MutableTask,
  parentIssueKey: string | null,
  status: TaskStatus,
  jiraUpdated: string,
  jiraStatusId: string,
  jiraStatusName: string,
  now: () => string,
): void {
  ledger.entries[ledgerEntryKey(key, issueKey)] = makeLedgerEntry({
    issueKey,
    mappingKey: key,
    title: local.title,
    description: normalizeDescription(descriptionFromLines(local.descriptionLines)),
    status,
    jiraStatusId,
    jiraStatusName,
    parentIssueKey,
    startDate: local.startDate,
    dueDate: local.dueDate,
    jiraUpdated,
    lastSyncedAt: now(),
    unresolved: false,
  });
}

function localSnapshot(
  local: MutableTask,
  parentIssueKey: string | null,
  entry: LedgerEntry | undefined,
): ContentSnapshot {
  const status = local.status ?? entry?.status ?? 'todo';
  let jiraStatusId = '';
  let jiraStatusName = '';
  if (entry) {
    if (status === entry.status) {
      jiraStatusId = entry.jiraStatusId;
      jiraStatusName = entry.jiraStatusName;
    } else {
      jiraStatusId = `local:${status}`;
      jiraStatusName = `local:${status}`;
    }
  }
  return contentSnapshot({
    title: local.title,
    description: descriptionFromLines(local.descriptionLines),
    status,
    jiraStatusId,
    jiraStatusName,
    parentIssueKey,
    startDate: local.startDate,
    dueDate: local.dueDate,
  });
}

function remoteSnapshot(remote: RemoteIssueView): ContentSnapshot {
  return contentSnapshot({
    title: remote.title,
    description: remote.description,
    status: remote.status,
    jiraStatusId: remote.jiraStatusId,
    jiraStatusName: remote.jiraStatusName,
    parentIssueKey: remote.parentIssueKey,
    startDate: remote.startDate,
    dueDate: remote.dueDate,
  });
}

function fromParsed(node: ParsedTaskNode, parent: MutableTask | null): MutableTask {
  const mutable: MutableTask = {
    lineIndex: node.lineIndex,
    endLineIndex: node.endLineIndex,
    indent: node.indent,
    listMarker: node.listMarker,
    checkboxChar: node.checkboxChar,
    status: node.status,
    title: node.title,
    descriptionLines: [...node.descriptionLines],
    issueKey: node.issueKey ? node.issueKey.toUpperCase() : null,
    startDate: node.startDate,
    dueDate: node.dueDate,
    assignee: node.assignee,
    timeSpentSeconds: node.timeSpentSeconds,
    children: [],
    parent,
    isNew: false,
    dirty: false,
  };
  mutable.children = node.children.map((child) => fromParsed(child, mutable));
  return mutable;
}

function createLocalNode(remote: RemoteIssueView): MutableTask {
  return {
    lineIndex: null,
    endLineIndex: null,
    indent: '',
    listMarker: '-',
    checkboxChar: checkboxCharForStatus(remote.status),
    status: remote.status,
    title: remote.title,
    descriptionLines: descriptionToLines(remote.description),
    issueKey: remote.key,
    startDate: remote.startDate,
    dueDate: remote.dueDate,
    assignee: null,
    timeSpentSeconds: null,
    children: [],
    parent: null,
    isNew: true,
    dirty: true,
  };
}

function walkMutable(roots: MutableTask[], visit: (task: MutableTask) => void): void {
  const walk = (task: MutableTask): void => {
    visit(task);
    for (const child of task.children) {
      walk(child);
    }
  };
  for (const root of roots) {
    walk(root);
  }
}

function markRootDirty(task: MutableTask): void {
  let cursor: MutableTask | null = task;
  while (cursor.parent) {
    cursor = cursor.parent;
  }
  cursor.dirty = true;
}

function toRenderable(task: MutableTask): RenderableTask {
  return {
    indent: task.indent,
    listMarker: task.listMarker,
    checkboxChar: task.checkboxChar,
    title: task.title,
    issueKey: task.issueKey,
    startDate: task.startDate,
    dueDate: task.dueDate,
    assignee: task.assignee,
    timeSpentSeconds: task.timeSpentSeconds,
    descriptionLines: task.descriptionLines,
    children: task.children.map(toRenderable),
  };
}

function writeMarkdown(markdown: string, roots: MutableTask[], baseUrl: string): string {
  const replacements: Array<{
    lineIndex: number | null;
    endLineIndex: number | null;
    rendered: string;
  }> = [];

  for (const root of roots) {
    if (root.isNew) {
      replacements.push({
        lineIndex: null,
        endLineIndex: null,
        rendered: renderTask(toRenderable(root), baseUrl),
      });
      continue;
    }
    if (root.dirty || root.children.some(isDirtyTree)) {
      replacements.push({
        lineIndex: root.lineIndex,
        endLineIndex: root.endLineIndex,
        rendered: renderTask(toRenderable(root), baseUrl),
      });
    }
  }

  if (replacements.length === 0) {
    return markdown;
  }
  return applyRootReplacements(markdown, replacements);
}

function isDirtyTree(task: MutableTask): boolean {
  if (task.dirty || task.isNew) {
    return true;
  }
  return task.children.some(isDirtyTree);
}

function buildStartCustomFields(
  startDateFieldId: string,
  startDate: string | null,
): Record<string, unknown> | undefined {
  if (!startDateFieldId || !startDate) {
    return undefined;
  }
  const payload = toJiraDueDatePayload(startDate);
  if (!payload) {
    return undefined;
  }
  return { [startDateFieldId]: payload };
}

function startDateConfigError(local: MutableTask, startDateFieldId: string): string | undefined {
  if (local.startDate && !startDateFieldId.trim()) {
    return `Task "${local.title}" has a start date (🛫) but Start date field is not configured in settings`;
  }
  return undefined;
}

export function normalizeNotePath(path: string): string {
  return path.trim().replace(/^\/+/, '');
}

function emptyCounts(): MappingSyncCounts {
  return {
    createdRemote: 0,
    createdLocal: 0,
    pushed: 0,
    pulled: 0,
    conflictsResolved: 0,
    unchanged: 0,
    unresolvedRemovals: 0,
    recoveredPendingLinks: 0,
    labelReconciliations: 0,
    assigneeReconciliations: 0,
    timeSpentReconciliations: 0,
  };
}

function addCounts(a: MappingSyncCounts, b: MappingSyncCounts): MappingSyncCounts {
  return {
    createdRemote: a.createdRemote + b.createdRemote,
    createdLocal: a.createdLocal + b.createdLocal,
    pushed: a.pushed + b.pushed,
    pulled: a.pulled + b.pulled,
    conflictsResolved: a.conflictsResolved + b.conflictsResolved,
    unchanged: a.unchanged + b.unchanged,
    unresolvedRemovals: a.unresolvedRemovals + b.unresolvedRemovals,
    recoveredPendingLinks: a.recoveredPendingLinks + b.recoveredPendingLinks,
    labelReconciliations: a.labelReconciliations + b.labelReconciliations,
    assigneeReconciliations: a.assigneeReconciliations + b.assigneeReconciliations,
    timeSpentReconciliations: a.timeSpentReconciliations + b.timeSpentReconciliations,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function summarizeRun(
  totals: MappingSyncCounts,
  errorCount: number,
  mappingCount: number,
  dryRun: boolean,
  actions: SyncActionDetail[],
): string {
  const prefix = dryRun ? 'Jira Sync dry-run' : 'Jira Sync';
  const parts = [`${mappingCount} mapping${mappingCount === 1 ? '' : 's'}`];

  const createRemote = countKind(actions, 'create-remote');
  const createLocal = countKind(actions, 'create-local');
  const push = countKind(actions, 'push');
  const pull = countKind(actions, 'pull');
  const conflicts =
    countKind(actions, 'conflict-push') + countKind(actions, 'conflict-pull');
  const unresolved =
    countKind(actions, 'unresolved-missing-remote') +
    countKind(actions, 'unresolved-missing-local');
  const recovered = countKind(actions, 'recovered-pending');
  const labelFixes = countKind(actions, 'reconcile-labels');
  const assigneeFixes = countKind(actions, 'reconcile-assignee');
  const timeSpentFixes = countKind(actions, 'reconcile-timespent');
  const derivedStarts = countKind(actions, 'derive-start');

  if (createRemote > 0) {
    parts.push(
      dryRun
        ? `${createRemote} would create in Jira`
        : `${createRemote} created in Jira`,
    );
  }
  if (createLocal > 0) {
    parts.push(
      dryRun
        ? `${createLocal} would import into Obsidian`
        : `${createLocal} imported into Obsidian`,
    );
  }
  if (push > 0) {
    parts.push(dryRun ? `${push} would push` : `${push} pushed`);
  }
  if (pull > 0) {
    parts.push(dryRun ? `${pull} would pull` : `${pull} pulled`);
  }
  if (conflicts > 0) {
    parts.push(
      dryRun ? `${conflicts} would resolve conflict` : `${conflicts} conflict resolved`,
    );
  }
  if (recovered > 0) {
    parts.push(dryRun ? `${recovered} would relink` : `${recovered} relinked`);
  }
  if (labelFixes > 0) {
    parts.push(
      dryRun
        ? `${labelFixes} would reconcile labels`
        : `${labelFixes} label reconciliation${labelFixes === 1 ? '' : 's'}`,
    );
  }
  if (assigneeFixes > 0) {
    parts.push(
      dryRun
        ? `${assigneeFixes} would sync assignee`
        : `${assigneeFixes} assignee sync${assigneeFixes === 1 ? '' : 's'}`,
    );
  }
  if (timeSpentFixes > 0) {
    parts.push(
      dryRun
        ? `${timeSpentFixes} would sync time spent from Jira`
        : `${timeSpentFixes} time spent sync${timeSpentFixes === 1 ? '' : 's'} from Jira`,
    );
  }
  if (derivedStarts > 0) {
    parts.push(
      dryRun
        ? `${derivedStarts} would set start from actual end − time tracking`
        : `${derivedStarts} set start from actual end − time tracking`,
    );
  }
  if (unresolved > 0) {
    parts.push(`${unresolved} unresolved`);
  }
  if (errorCount > 0) {
    parts.push(`${errorCount} error${errorCount === 1 ? '' : 's'}`);
  }

  if (parts.length === 1 && totals.unchanged > 0) {
    parts.push(`${totals.unchanged} unchanged`);
  } else if (parts.length === 1) {
    parts.push('nothing to do');
  }

  return `${prefix}: ${parts.join(', ')}`;
}

function countKind(actions: SyncActionDetail[], kind: SyncActionDetail['kind']): number {
  return actions.reduce((sum, action) => sum + (action.kind === kind ? 1 : 0), 0);
}
