import type { JiraAuthMode } from '../settings';
import { descriptionToPlainText, plainTextToAdf } from './description';
import type { HttpTransport } from './http';
import { createFetchTransport } from './http';
import {
  buildAgileExtraJql,
  buildSyncJql,
  describeIssueSyncFilter,
  type IssueSyncFilter,
} from './issue-filter';
import { boardProjectJql } from './jql';
import {
  JiraApiError,
  type CreateIssueInput,
  type JiraBoard,
  type JiraBoardConfiguration,
  type JiraField,
  type JiraIssue,
  type JiraTransition,
  type JiraUser,
  type UpdateIssueInput,
} from './types';
import { agileRoot, apiV2Root, apiV3Root, normalizeBaseUrl } from './urls';

export interface JiraClientOptions {
  baseUrl: string;
  authMode: JiraAuthMode;
  email?: string;
  token: string;
  transport?: HttpTransport;
  /** Prefer API v3 description (ADF). Auto-detected for *.atlassian.net when unset. */
  useAdfDescription?: boolean;
}

export class JiraClient {
  readonly baseUrl: string;
  private readonly authMode: JiraAuthMode;
  private readonly email: string;
  private readonly token: string;
  private readonly transport: HttpTransport;
  private readonly useAdfDescription: boolean;

  constructor(options: JiraClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    if (!this.baseUrl) {
      throw new Error('Jira base URL is required');
    }
    this.authMode = options.authMode;
    this.email = (options.email ?? '').trim();
    this.token = options.token.trim();
    if (!this.token) {
      throw new Error('Jira API token is required');
    }
    if (this.authMode === 'cloud' && !this.email) {
      throw new Error('Jira email is required for Cloud auth');
    }
    this.transport = options.transport ?? createFetchTransport();
    this.useAdfDescription =
      options.useAdfDescription ??
      /\.atlassian\.net$/i.test(new URL(this.baseUrl).hostname);
  }

  async testConnection(): Promise<{ displayName: string; boardCount: number }> {
    const me = await this.requestJson<JiraUser>('GET', `${apiV2Root(this.baseUrl)}/myself`);
    const boards = await this.listBoards();
    return {
      displayName: me.displayName ?? me.emailAddress ?? me.name ?? 'ok',
      boardCount: boards.length,
    };
  }

  async listBoards(): Promise<JiraBoard[]> {
    const results: JiraBoard[] = [];
    let startAt = 0;
    const maxResults = 50;
    for (;;) {
      const page = await this.requestJson<{
        values?: JiraBoard[];
        isLast?: boolean;
        startAt?: number;
        maxResults?: number;
        total?: number;
      }>(
        'GET',
        `${agileRoot(this.baseUrl)}/board?startAt=${startAt}&maxResults=${maxResults}`,
      );
      const values = page.values ?? [];
      results.push(...values);
      if (page.isLast === true || values.length === 0) {
        break;
      }
      startAt += values.length;
      if (page.total !== undefined && startAt >= page.total) {
        break;
      }
    }
    return results;
  }

  async getBoardConfiguration(boardId: number): Promise<JiraBoardConfiguration> {
    return this.requestJson<JiraBoardConfiguration>(
      'GET',
      `${agileRoot(this.baseUrl)}/board/${boardId}/configuration`,
    );
  }

  async getBoard(boardId: number): Promise<JiraBoard> {
    return this.requestJson<JiraBoard>('GET', `${agileRoot(this.baseUrl)}/board/${boardId}`);
  }

  /**
   * Collect label suggestions for a board mapping filter.
   *
   * Strategy (in order, merged):
   * 1. Labels on board issues (Agile board query — often only the active sprint)
   * 2. Labels on the board backlog (Scrum; ignored if the endpoint 404s)
   * 3. Labels on recent issues in the board’s project (JQL)
   * 4. Global label catalog (`GET /rest/api/2/label`) when still empty
   */
  async listBoardLabels(boardId: number): Promise<string[]> {
    const collector = createLabelCollector();

    const boardIssues = await this.listBoardIssues(boardId, ['labels', 'summary']);
    for (const issue of boardIssues) {
      collector.addAll(issue.fields.labels);
    }

    try {
      const backlog = await this.listBoardBacklogIssues(boardId, ['labels', 'summary']);
      for (const issue of backlog) {
        collector.addAll(issue.fields.labels);
      }
    } catch {
      // Kanban / some boards have no backlog endpoint.
    }

    try {
      const board = await this.getBoard(boardId);
      const projectJql = boardProjectJql(board.location);
      if (projectJql) {
        const projectIssues = await this.searchIssues(
          `${projectJql} ORDER BY updated DESC`,
          ['labels'],
          200,
        );
        for (const issue of projectIssues) {
          collector.addAll(issue.fields.labels);
        }
      }
    } catch {
      // Project search is best-effort.
    }

    if (collector.size === 0) {
      try {
        for (const label of await this.listAllLabels()) {
          collector.add(label);
        }
      } catch {
        // Older Server/DC builds may not expose /label.
      }
    }

    return collector.values();
  }

  /** Paginated global label catalog (Cloud + modern Server/DC). */
  async listAllLabels(): Promise<string[]> {
    const collector = createLabelCollector();
    let startAt = 0;
    const maxResults = 1000;
    for (;;) {
      const qs = new URLSearchParams({
        startAt: String(startAt),
        maxResults: String(maxResults),
      });
      const page = await this.requestJson<{
        values?: string[];
        isLast?: boolean;
        startAt?: number;
        maxResults?: number;
        total?: number;
      }>('GET', `${apiV2Root(this.baseUrl)}/label?${qs.toString()}`);
      const values = page.values ?? [];
      collector.addAll(values);
      startAt += values.length;
      if (values.length === 0 || page.isLast === true) {
        break;
      }
      if (page.total !== undefined && startAt >= page.total) {
        break;
      }
    }
    return collector.values();
  }

  async listBoardIssues(
    boardId: number,
    fields?: string[],
    jql?: string,
  ): Promise<JiraIssue[]> {
    return this.listAgileIssues(
      `${agileRoot(this.baseUrl)}/board/${boardId}/issue`,
      fields,
      jql,
    );
  }

  async listBoardBacklogIssues(
    boardId: number,
    fields?: string[],
    jql?: string,
  ): Promise<JiraIssue[]> {
    return this.listAgileIssues(
      `${agileRoot(this.baseUrl)}/board/${boardId}/backlog`,
      fields,
      jql,
    );
  }

  /**
   * Issues for sync.
   *
   * When labels and/or recency filters are set (Cloud-critical path):
   * 1. Enhanced/classic JQL search: `project = X AND labels in (...) AND updated >= -Nd`
   * 2. Agile board + backlog with the same extra JQL
   *
   * Without filters: Agile board + backlog, then project search fallback.
   *
   * Note: Jira Cloud removed `/rest/api/2/search` (HTTP 410). `searchIssues`
   * uses `/rest/api/3/search/jql` first. Search still caps around 1000 issues.
   *
   * The third argument accepts `IssueSyncFilter` or a legacy label string array.
   */
  async listBoardIssuesForSync(
    boardId: number,
    fields?: string[],
    filter: IssueSyncFilter | readonly string[] = {},
  ): Promise<JiraIssue[]> {
    const syncFilter: IssueSyncFilter = normalizeIssueSyncFilter(filter);
    const extraJql = buildAgileExtraJql(syncFilter);
    const hasExtraFilter = Boolean(extraJql);
    const byKey = new Map<string, JiraIssue>();
    const searchErrors: string[] = [];

    const merge = (issues: readonly JiraIssue[]) => {
      for (const issue of issues) {
        byKey.set(issue.key.toUpperCase(), issue);
      }
    };

    let board: JiraBoard | null = null;
    try {
      board = await this.getBoard(boardId);
    } catch (error) {
      searchErrors.push(`getBoard: ${error instanceof Error ? error.message : String(error)}`);
    }

    const syncJql = buildSyncJql(board?.location, syncFilter);

    // Filtered sync: prefer JQL search (sees backlog + closed sprints).
    if (hasExtraFilter && syncJql) {
      try {
        merge(await this.searchIssues(`${syncJql} ORDER BY updated DESC`, fields, 1000));
      } catch (error) {
        searchErrors.push(
          `searchIssues: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    try {
      merge(await this.listBoardIssues(boardId, fields, extraJql));
    } catch (error) {
      searchErrors.push(
        `board issues: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    try {
      merge(await this.listBoardBacklogIssues(boardId, fields, extraJql));
    } catch {
      // Kanban / some boards have no backlog endpoint.
    }

    // Unfiltered sync fallback when Agile returned nothing.
    if (byKey.size === 0 && !hasExtraFilter) {
      const projectOnly = boardProjectJql(board?.location);
      if (projectOnly) {
        try {
          merge(await this.searchIssues(`${projectOnly} ORDER BY updated DESC`, fields, 1000));
        } catch (error) {
          searchErrors.push(
            `searchIssues: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    // Last resort: filter JQL without project (board location missing).
    if (byKey.size === 0 && hasExtraFilter && extraJql) {
      try {
        merge(await this.searchIssues(`${extraJql} ORDER BY updated DESC`, fields, 1000));
      } catch (error) {
        searchErrors.push(
          `searchIssues(filter): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (byKey.size === 0 && searchErrors.length > 0 && hasExtraFilter) {
      throw new JiraApiError(
        `No issues found for board ${boardId} with ${describeIssueSyncFilter(syncFilter)}. Attempts: ${searchErrors.join('; ')}`,
        404,
      );
    }

    return [...byKey.values()];
  }

  /**
   * JQL issue search. Prefers Cloud enhanced search (`POST /rest/api/3/search/jql`),
   * then falls back to classic `GET /rest/api/2/search` for Server/DC.
   */
  async searchIssues(
    jql: string,
    fields: string[] = ['labels'],
    maxTotal = 200,
  ): Promise<JiraIssue[]> {
    try {
      return await this.searchIssuesEnhanced(jql, fields, maxTotal);
    } catch (enhancedError) {
      try {
        return await this.searchIssuesClassic(jql, fields, maxTotal);
      } catch (classicError) {
        if (enhancedError instanceof JiraApiError) {
          throw enhancedError;
        }
        throw classicError;
      }
    }
  }

  /**
   * Cloud enhanced search — token pagination, no startAt.
   * Prefer GET to avoid XSRF issues with Obsidian `requestUrl` POST;
   * fall back to POST (with X-Atlassian-Token: no-check) if GET is unavailable.
   */
  private async searchIssuesEnhanced(
    jql: string,
    fields: string[],
    maxTotal: number,
  ): Promise<JiraIssue[]> {
    try {
      return await this.searchIssuesEnhancedGet(jql, fields, maxTotal);
    } catch (getError) {
      if (getError instanceof JiraApiError && (getError.status === 404 || getError.status === 405)) {
        return this.searchIssuesEnhancedPost(jql, fields, maxTotal);
      }
      // XSRF on GET is unusual; still try POST with no-check header as last enhanced attempt.
      if (isXsrfError(getError)) {
        return this.searchIssuesEnhancedPost(jql, fields, maxTotal);
      }
      try {
        return await this.searchIssuesEnhancedPost(jql, fields, maxTotal);
      } catch {
        throw getError;
      }
    }
  }

  private async searchIssuesEnhancedGet(
    jql: string,
    fields: string[],
    maxTotal: number,
  ): Promise<JiraIssue[]> {
    const fieldList = fields.length > 0 ? fields : ['summary', 'labels', 'status', 'updated'];
    const results: JiraIssue[] = [];
    let nextPageToken: string | undefined;

    while (results.length < maxTotal) {
      const qs = new URLSearchParams({
        jql,
        maxResults: String(Math.min(100, maxTotal - results.length)),
      });
      for (const field of fieldList) {
        qs.append('fields', field);
      }
      if (nextPageToken) {
        qs.set('nextPageToken', nextPageToken);
      }

      const page = await this.requestJson<{
        issues?: JiraIssue[];
        nextPageToken?: string;
        isLast?: boolean;
      }>('GET', `${apiV3Root(this.baseUrl)}/search/jql?${qs.toString()}`);

      const issues = page.issues ?? [];
      results.push(...issues.map((issue) => this.normalizeIssue(issue)));

      if (issues.length === 0 || page.isLast === true || !page.nextPageToken) {
        break;
      }
      nextPageToken = page.nextPageToken;
    }

    return results;
  }

  private async searchIssuesEnhancedPost(
    jql: string,
    fields: string[],
    maxTotal: number,
  ): Promise<JiraIssue[]> {
    const fieldList = fields.length > 0 ? fields : ['summary', 'labels', 'status', 'updated'];
    const results: JiraIssue[] = [];
    let nextPageToken: string | undefined;

    while (results.length < maxTotal) {
      const body: Record<string, unknown> = {
        jql,
        maxResults: Math.min(100, maxTotal - results.length),
        fields: fieldList,
      };
      if (nextPageToken) {
        body.nextPageToken = nextPageToken;
      }

      const page = await this.requestJson<{
        issues?: JiraIssue[];
        nextPageToken?: string;
        isLast?: boolean;
      }>('POST', `${apiV3Root(this.baseUrl)}/search/jql`, body);

      const issues = page.issues ?? [];
      results.push(...issues.map((issue) => this.normalizeIssue(issue)));

      if (issues.length === 0 || page.isLast === true || !page.nextPageToken) {
        break;
      }
      nextPageToken = page.nextPageToken;
    }

    return results;
  }

  /** Classic search for Jira Server / Data Center. */
  private async searchIssuesClassic(
    jql: string,
    fields: string[],
    maxTotal: number,
  ): Promise<JiraIssue[]> {
    const results: JiraIssue[] = [];
    let startAt = 0;
    const maxResults = 50;
    while (results.length < maxTotal) {
      const pageSize = Math.min(maxResults, maxTotal - results.length);
      const qs = new URLSearchParams({
        jql,
        startAt: String(startAt),
        maxResults: String(pageSize),
        fields: fields.join(','),
      });
      const page = await this.requestJson<{
        issues?: JiraIssue[];
        startAt?: number;
        maxResults?: number;
        total?: number;
      }>('GET', `${apiV2Root(this.baseUrl)}/search?${qs.toString()}`);
      const issues = page.issues ?? [];
      results.push(...issues.map((issue) => this.normalizeIssue(issue)));
      startAt += issues.length;
      if (issues.length === 0) {
        break;
      }
      if (page.total !== undefined && startAt >= page.total) {
        break;
      }
    }
    return results;
  }

  private async listAgileIssues(
    urlBase: string,
    fields?: string[],
    jql?: string,
  ): Promise<JiraIssue[]> {
    const fieldList =
      fields ??
      [
        'summary',
        'description',
        'status',
        'issuetype',
        'project',
        'parent',
        'labels',
        'duedate',
        'updated',
        'created',
      ];
    const results: JiraIssue[] = [];
    let startAt = 0;
    const maxResults = 50;
    for (;;) {
      const qs = new URLSearchParams({
        startAt: String(startAt),
        maxResults: String(maxResults),
        fields: fieldList.join(','),
      });
      if (jql) {
        qs.set('jql', jql);
      }
      const separator = urlBase.includes('?') ? '&' : '?';
      const page = await this.requestJson<{
        issues?: JiraIssue[];
        startAt?: number;
        maxResults?: number;
        total?: number;
        isLast?: boolean;
      }>('GET', `${urlBase}${separator}${qs.toString()}`);
      const issues = page.issues ?? [];
      results.push(...issues.map((issue) => this.normalizeIssue(issue)));
      startAt += issues.length;
      if (issues.length === 0 || page.isLast === true) {
        break;
      }
      if (page.total !== undefined && startAt >= page.total) {
        break;
      }
      // Guard against APIs that omit total/isLast but keep returning a full page.
      if (issues.length < maxResults) {
        break;
      }
    }
    return results;
  }

  async getIssue(issueKey: string, fields?: string[]): Promise<JiraIssue> {
    const qs = fields?.length ? `?fields=${encodeURIComponent(fields.join(','))}` : '';
    const issue = await this.requestJson<JiraIssue>(
      'GET',
      `${apiV2Root(this.baseUrl)}/issue/${encodeURIComponent(issueKey)}${qs}`,
    );
    return this.normalizeIssue(issue);
  }

  async createIssue(input: CreateIssueInput): Promise<JiraIssue> {
    const fields: Record<string, unknown> = {
      project: { key: input.projectKey },
      summary: input.summary,
      issuetype: { name: input.issueTypeName ?? (input.parentKey ? 'Sub-task' : 'Task') },
    };
    if (input.description !== undefined) {
      fields.description = this.encodeDescription(input.description);
    }
    if (input.parentKey) {
      fields.parent = { key: input.parentKey };
    }
    if (input.labels) {
      fields.labels = input.labels;
    }
    if (input.duedate !== undefined) {
      fields.duedate = input.duedate;
    }
    if (input.customFields) {
      Object.assign(fields, input.customFields);
    }

    const created = await this.requestJson<{ id: string; key: string }>(
      'POST',
      `${this.issueWriteRoot()}/issue`,
      { fields },
    );
    return this.getIssue(created.key);
  }

  async updateIssue(issueKey: string, input: UpdateIssueInput): Promise<void> {
    const fields: Record<string, unknown> = {};
    if (input.summary !== undefined) {
      fields.summary = input.summary;
    }
    if (input.description !== undefined) {
      fields.description = this.encodeDescription(input.description);
    }
    if (input.labels !== undefined) {
      fields.labels = input.labels;
    }
    if (input.duedate !== undefined) {
      fields.duedate = input.duedate;
    }
    if (input.parentKey !== undefined) {
      fields.parent = input.parentKey ? { key: input.parentKey } : null;
    }
    if (input.customFields) {
      Object.assign(fields, input.customFields);
    }
    await this.requestJson('PUT', `${this.issueWriteRoot()}/issue/${encodeURIComponent(issueKey)}`, {
      fields,
    });
  }

  async listTransitions(issueKey: string): Promise<JiraTransition[]> {
    const body = await this.requestJson<{ transitions?: JiraTransition[] }>(
      'GET',
      `${apiV2Root(this.baseUrl)}/issue/${encodeURIComponent(issueKey)}/transitions`,
    );
    return body.transitions ?? [];
  }

  async transitionIssue(issueKey: string, transitionId: string): Promise<void> {
    await this.requestJson(
      'POST',
      `${apiV2Root(this.baseUrl)}/issue/${encodeURIComponent(issueKey)}/transitions`,
      { transition: { id: transitionId } },
    );
  }

  async listFields(): Promise<JiraField[]> {
    return this.requestJson<JiraField[]>('GET', `${apiV2Root(this.baseUrl)}/field`);
  }

  async findStartDateField(): Promise<JiraField | null> {
    return this.findFieldByName('Start date');
  }

  /** Case-insensitive exact match on field name (e.g. “Actual end”, “Target end”). */
  async findFieldByName(name: string): Promise<JiraField | null> {
    const wanted = name.trim().toLowerCase();
    if (!wanted) {
      return null;
    }
    const fields = await this.listFields();
    return fields.find((field) => field.name.trim().toLowerCase() === wanted) ?? null;
  }

  buildUrl(path: string): string {
    if (path.startsWith('http')) {
      return path;
    }
    return `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  }

  private issueWriteRoot(): string {
    return this.useAdfDescription ? apiV3Root(this.baseUrl) : apiV2Root(this.baseUrl);
  }

  private encodeDescription(text: string): unknown {
    if (this.useAdfDescription) {
      return plainTextToAdf(text);
    }
    return text;
  }

  private normalizeIssue(issue: JiraIssue): JiraIssue {
    const fields = { ...(issue.fields ?? {}) };
    if (fields.description !== undefined) {
      fields.description = descriptionToPlainText(fields.description);
    }
    return {
      ...issue,
      key: String(issue.key ?? '').toUpperCase(),
      fields,
    };
  }

  private authHeader(): string {
    if (this.authMode === 'cloud') {
      const raw = `${this.email}:${this.token}`;
      const encoded =
        typeof btoa === 'function'
          ? btoa(raw)
          : Buffer.from(raw, 'utf8').toString('base64');
      return `Basic ${encoded}`;
    }
    return `Bearer ${this.token}`;
  }

  private async requestJson<T>(
    method: string,
    url: string,
    body?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: this.authHeader(),
      Accept: 'application/json',
      // Required for many Jira Server/DC (and some Cloud) mutating calls when
      // the request is not a browser form post with an atl.xsrf.token cookie.
      'X-Atlassian-Token': 'no-check',
    };
    let payload: string | undefined;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const response = await this.transport({
      url,
      method,
      headers,
      body: payload,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new JiraApiError(
        extractErrorMessage(response.text) || `Jira API ${method} ${url} failed`,
        response.status,
        response.text,
      );
    }
    if (response.status === 204 || !response.text.trim()) {
      return undefined as T;
    }
    try {
      return JSON.parse(response.text) as T;
    } catch {
      throw new JiraApiError('Jira API returned invalid JSON', response.status, response.text);
    }
  }
}

function normalizeIssueSyncFilter(
  filter: IssueSyncFilter | readonly string[] | undefined,
): IssueSyncFilter {
  if (filter == null) {
    return {};
  }
  if (Array.isArray(filter)) {
    return { labels: (filter as readonly string[]).map(String) };
  }
  const objectFilter = filter as IssueSyncFilter;
  return {
    labels: objectFilter.labels,
    recency: objectFilter.recency,
  };
}

function isXsrfError(error: unknown): boolean {
  if (!(error instanceof JiraApiError)) {
    return false;
  }
  const message = `${error.message} ${error.body ?? ''}`.toLowerCase();
  return message.includes('xsrf');
}

function createLabelCollector(): {
  size: number;
  add: (raw: unknown) => void;
  addAll: (raw: unknown) => void;
  values: () => string[];
} {
  const seen = new Set<string>();
  const labels: string[] = [];
  const add = (raw: unknown) => {
    const label = String(raw ?? '').trim();
    if (!label) {
      return;
    }
    const key = label.toLowerCase();
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    labels.push(label);
  };
  return {
    get size() {
      return labels.length;
    },
    add,
    addAll(raw: unknown) {
      if (!Array.isArray(raw)) {
        return;
      }
      for (const item of raw) {
        add(item);
      }
    },
    values() {
      return [...labels].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    },
  };
}

function extractErrorMessage(text: string): string {
  if (!text.trim()) {
    return '';
  }
  try {
    const parsed = JSON.parse(text) as {
      errorMessages?: string[];
      errors?: Record<string, string>;
      message?: string;
    };
    if (parsed.errorMessages?.length) {
      return parsed.errorMessages.join('; ');
    }
    if (parsed.errors && Object.keys(parsed.errors).length > 0) {
      return Object.entries(parsed.errors)
        .map(([key, value]) => `${key}: ${value}`)
        .join('; ');
    }
    if (parsed.message) {
      return parsed.message;
    }
  } catch {
    // fall through
  }
  return text.slice(0, 300);
}
