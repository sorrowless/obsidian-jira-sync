import { normalizeJiraDate } from '../note/dates';
import type { JiraIssue } from '../jira/types';
import {
  columnForStatusId,
  statusFromJiraStatus,
  type BoardColumnView,
  type TaskStatus,
} from './status';
import { normalizeDescription } from './ledger';

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
  updated: string;
  projectKey: string;
  isSubtask: boolean;
}

export function indexRemoteIssues(
  issues: readonly JiraIssue[],
  columns: ReadonlyArray<BoardColumnView>,
  startDateFieldId?: string,
): Map<string, RemoteIssueView> {
  const map = new Map<string, RemoteIssueView>();
  for (const issue of issues) {
    const view = toRemoteIssueView(issue, columns, startDateFieldId);
    map.set(view.key, view);
  }
  return map;
}

export function toRemoteIssueView(
  issue: JiraIssue,
  columns: ReadonlyArray<BoardColumnView>,
  startDateFieldId?: string,
): RemoteIssueView {
  const fields = issue.fields ?? {};
  const statusId = String(fields.status?.id ?? '');
  const statusName = fields.status?.name ?? '';
  const categoryKey = fields.status?.statusCategory?.key ?? null;
  const column = columnForStatusId(columns, statusId);
  const columnName = column?.name ?? statusName;
  const parentKey = fields.parent?.key ? String(fields.parent.key).toUpperCase() : null;

  let startDate: string | null = null;
  if (startDateFieldId) {
    startDate = normalizeJiraDate(fields[startDateFieldId]);
  }

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
    startDate,
    dueDate: normalizeJiraDate(fields.duedate),
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
