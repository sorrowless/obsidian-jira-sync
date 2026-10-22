import { resolveBlocksParentsForSyncSet } from '../jira/issue-links';
import type { JiraIssue } from '../jira/types';
import {
  jiraAssigneeDisplayName,
  jiraAssigneeIdentity,
} from './assignee';
import {
  resolveIssueDates,
  type DateFieldConfig,
  type DueDateSource,
  type StartDateSource,
} from './issue-dates';
import { normalizeDescription } from './ledger';
import {
  columnForStatusId,
  statusFromJiraStatus,
  type BoardColumnView,
  type TaskStatus,
} from './status';
import {
  DEFAULT_TIME_SPENT_FIELD_ID,
  extractConfiguredTimeSpentSeconds,
} from './timespent';

export interface RemoteIssueView {
  key: string;
  title: string;
  description: string;
  status: TaskStatus;
  jiraStatusId: string;
  jiraStatusName: string;
  columnName: string;
  /** Obsidian nest parent from Blocks heuristics (not hierarchy parent). */
  parentIssueKey: string | null;
  labels: string[];
  startDate: string | null;
  dueDate: string | null;
  /** How startDate was obtained (field vs actual end − time tracking). */
  startDateSource: StartDateSource;
  dueDateSource: DueDateSource;
  /** Raw Start date custom field before derivation. */
  jiraStartDate: string | null;
  /** Human detail when startDateSource === 'derived'. */
  startDateDerivedDetail: string | null;
  /** Stable Jira assignee id (accountId / name / key), or null. */
  assigneeAccountId: string | null;
  assigneeDisplayName: string | null;
  /** Logged time spent in seconds (from configured field), or null. */
  timeSpentSeconds: number | null;
  updated: string;
  projectKey: string;
  isSubtask: boolean;
}

export interface RemoteIssueViewOptions {
  dateFields?: DateFieldConfig | string;
  timeSpentFieldId?: string;
  /**
   * Board project key. When set, `parentIssueKey` is derived from Blocks links
   * (child blocks parent) with same-project / no-hierarchy-parent heuristics.
   */
  mappingProjectKey?: string;
}

export interface IndexedRemoteIssues {
  remoteMap: Map<string, RemoteIssueView>;
  /** Blocks A↔B cycles that were skipped for nesting. */
  cycleErrors: string[];
}

export function indexRemoteIssues(
  issues: readonly JiraIssue[],
  columns: ReadonlyArray<BoardColumnView>,
  dateFieldsOrOptions?: DateFieldConfig | string | RemoteIssueViewOptions,
): IndexedRemoteIssues {
  const options = normalizeRemoteOptions(dateFieldsOrOptions);
  const views: RemoteIssueView[] = [];
  for (const issue of issues) {
    views.push(toRemoteIssueView(issue, columns, options));
  }

  const cycleErrors: string[] = [];
  const projectKey = options.mappingProjectKey?.trim() ?? '';
  if (projectKey) {
    const { parents, cycleErrors: cycles } = resolveBlocksParentsForSyncSet(
      issues.map((issue) => {
        const key = String(issue.key ?? '').toUpperCase();
        const fields = issue.fields ?? {};
        return {
          key,
          projectKey: String(fields.project?.key ?? ''),
          hierarchyParentKey: fields.parent?.key
            ? String(fields.parent.key).toUpperCase()
            : null,
          issuelinks: fields.issuelinks,
        };
      }),
      projectKey,
    );
    cycleErrors.push(...cycles);
    for (const view of views) {
      view.parentIssueKey = parents.get(view.key) ?? null;
    }
  }

  const remoteMap = new Map<string, RemoteIssueView>();
  for (const view of views) {
    remoteMap.set(view.key, view);
  }
  return { remoteMap, cycleErrors };
}

export function toRemoteIssueView(
  issue: JiraIssue,
  columns: ReadonlyArray<BoardColumnView>,
  dateFieldsOrOptions?: DateFieldConfig | string | RemoteIssueViewOptions,
): RemoteIssueView {
  const options = normalizeRemoteOptions(dateFieldsOrOptions);
  const fields = issue.fields ?? {};
  const statusId = String(fields.status?.id ?? '');
  const statusName = fields.status?.name ?? '';
  const categoryKey = fields.status?.statusCategory?.key ?? null;
  const column = columnForStatusId(columns, statusId);
  const columnName = column?.name ?? statusName;

  const dates = resolveIssueDates(fields as Record<string, unknown>, options.dateFields);
  const assignee = fields.assignee ?? null;
  const timeSpentSeconds = extractConfiguredTimeSpentSeconds(
    fields as Record<string, unknown>,
    options.timeSpentFieldId,
  );

  return {
    key: String(issue.key).toUpperCase(),
    title: String(fields.summary ?? ''),
    description: normalizeDescription(String(fields.description ?? '')),
    status: statusFromJiraStatus(statusName, categoryKey),
    jiraStatusId: statusId,
    jiraStatusName: statusName,
    columnName,
    // Filled by indexRemoteIssues via Blocks heuristics when mappingProjectKey is set.
    parentIssueKey: null,
    labels: Array.isArray(fields.labels) ? fields.labels.map(String) : [],
    startDate: dates.startDate,
    dueDate: dates.dueDate,
    startDateSource: dates.startDateSource,
    dueDateSource: dates.dueDateSource,
    jiraStartDate: dates.jiraStartDate,
    startDateDerivedDetail: dates.startDateDerivedDetail,
    assigneeAccountId: jiraAssigneeIdentity(assignee),
    assigneeDisplayName: jiraAssigneeDisplayName(assignee) || null,
    timeSpentSeconds,
    updated: String(fields.updated ?? ''),
    projectKey: String(fields.project?.key ?? ''),
    isSubtask: Boolean(fields.issuetype?.subtask),
  };
}

function normalizeRemoteOptions(
  dateFieldsOrOptions?: DateFieldConfig | string | RemoteIssueViewOptions,
): {
  dateFields: DateFieldConfig;
  timeSpentFieldId: string;
  mappingProjectKey?: string;
} {
  if (typeof dateFieldsOrOptions === 'string') {
    return {
      dateFields: { startDateFieldId: dateFieldsOrOptions },
      timeSpentFieldId: DEFAULT_TIME_SPENT_FIELD_ID,
    };
  }
  if (
    dateFieldsOrOptions &&
    ('dateFields' in dateFieldsOrOptions ||
      'timeSpentFieldId' in dateFieldsOrOptions ||
      'mappingProjectKey' in dateFieldsOrOptions)
  ) {
    const opts = dateFieldsOrOptions as RemoteIssueViewOptions;
    const dateFields =
      typeof opts.dateFields === 'string'
        ? { startDateFieldId: opts.dateFields }
        : (opts.dateFields ?? {});
    return {
      dateFields,
      timeSpentFieldId: opts.timeSpentFieldId?.trim() || DEFAULT_TIME_SPENT_FIELD_ID,
      mappingProjectKey: opts.mappingProjectKey?.trim() || undefined,
    };
  }
  return {
    dateFields: (dateFieldsOrOptions as DateFieldConfig | undefined) ?? {},
    timeSpentFieldId: DEFAULT_TIME_SPENT_FIELD_ID,
  };
}

export function columnsFromBoardConfig(config: {
  columnConfig?: { columns?: Array<{ name: string; statuses?: Array<{ id: string }> }> };
}): BoardColumnView[] {
  const columns = config.columnConfig?.columns ?? [];
  return columns.map((column) => ({
    name: column.name,
    statusIds: (column.statuses ?? []).map((status) => String(status.id)),
  }));
}
