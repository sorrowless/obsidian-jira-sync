export class JiraApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'JiraApiError';
  }
}

export interface JiraUser {
  accountId?: string;
  name?: string;
  displayName?: string;
  emailAddress?: string;
}

export interface JiraStatusCategory {
  id?: number;
  key?: string;
  name?: string;
}

export interface JiraStatus {
  id: string;
  name: string;
  statusCategory?: JiraStatusCategory;
}

export interface JiraIssueType {
  id: string;
  name: string;
  subtask?: boolean;
}

export interface JiraProjectRef {
  id: string;
  key: string;
  name?: string;
}

export interface JiraIssueFields {
  summary?: string;
  description?: unknown;
  status?: JiraStatus;
  issuetype?: JiraIssueType;
  project?: JiraProjectRef;
  parent?: { key?: string; id?: string };
  labels?: string[];
  duedate?: string | null;
  updated?: string;
  created?: string;
  [customField: string]: unknown;
}

export interface JiraIssue {
  id: string;
  key: string;
  self?: string;
  fields: JiraIssueFields;
}

export interface JiraBoard {
  id: number;
  name: string;
  type?: string;
  location?: {
    projectId?: number;
    projectKey?: string;
    projectName?: string;
    displayName?: string;
  };
}

export interface JiraBoardColumnStatus {
  id: string;
  name?: string;
}

export interface JiraBoardColumn {
  name: string;
  statuses: JiraBoardColumnStatus[];
}

export interface JiraBoardConfiguration {
  id: number;
  name: string;
  columnConfig: {
    columns: JiraBoardColumn[];
  };
}

export interface JiraField {
  id: string;
  name: string;
  custom?: boolean;
  schema?: { type?: string; custom?: string };
}

export interface JiraTransition {
  id: string;
  name: string;
  to: JiraStatus;
}

export interface CreateIssueInput {
  projectKey: string;
  summary: string;
  description?: string;
  issueTypeName?: string;
  parentKey?: string | null;
  labels?: string[];
  duedate?: string | null;
  /** Map of custom field id → value (e.g. start date). */
  customFields?: Record<string, unknown>;
}

export interface UpdateIssueInput {
  summary?: string;
  description?: string;
  labels?: string[];
  duedate?: string | null;
  parentKey?: string | null;
  customFields?: Record<string, unknown>;
}
