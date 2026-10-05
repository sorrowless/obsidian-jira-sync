import type { JiraIssue } from '../jira/types';
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

export interface RemoteIssueView {
  key: string;
  title: string;
  description: string;
  status: TaskStatus;
  jiraStatusId: string;
  jiraStatusName: string;
  columnName: string;
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
  updated: string;
  projectKey: string;
  isSubtask: boolean;
}

export function indexRemoteIssues(
  issues: readonly JiraIssue[],
  columns: ReadonlyArray<BoardColumnView>,
  dateFields?: DateFieldConfig | string,
): Map<string, RemoteIssueView> {
  const map = new Map<string, RemoteIssueView>();
  for (const issue of issues) {
    const view = toRemoteIssueView(issue, columns, dateFields);
    map.set(view.key, view);
  }
  return map;
}

export function toRemoteIssueView(
  issue: JiraIssue,
  columns: ReadonlyArray<BoardColumnView>,
  dateFields?: DateFieldConfig | string,
): RemoteIssueView {
  const fields = issue.fields ?? {};
  const statusId = String(fields.status?.id ?? '');
  const statusName = fields.status?.name ?? '';
  const categoryKey = fields.status?.statusCategory?.key ?? null;
  const column = columnForStatusId(columns, statusId);
  const columnName = column?.name ?? statusName;
  const parentKey = fields.parent?.key ? String(fields.parent.key).toUpperCase() : null;

  const config: DateFieldConfig =
    typeof dateFields === 'string'
      ? { startDateFieldId: dateFields }
      : (dateFields ?? {});
  const dates = resolveIssueDates(fields as Record<string, unknown>, config);

  return {
    key: String(issue.key).toUpperCase(),
    title: String(fields.summary ?? ''),
    description: normalizeDescription(String(fields.description ?? '')),
    status: statusFromJiraStatus(statusName, categoryKey),
    jiraStatusId: statusId,
    jiraStatusName: statusName,
    columnName,
    parentIssueKey: parentKey,
    labels: Array.isArray(fields.labels) ? fields.labels.map(String) : [],
    startDate: dates.startDate,
    dueDate: dates.dueDate,
    startDateSource: dates.startDateSource,
    dueDateSource: dates.dueDateSource,
    jiraStartDate: dates.jiraStartDate,
    startDateDerivedDetail: dates.startDateDerivedDetail,
    updated: String(fields.updated ?? ''),
    projectKey: String(fields.project?.key ?? ''),
    isSubtask: Boolean(fields.issuetype?.subtask),
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
