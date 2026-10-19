import { describe, expect, it, vi } from 'vitest';
import { JiraClient } from './client';
import type { HttpRequest, HttpResponse, HttpTransport } from './http';
import { JiraApiError } from './types';
import { agileRoot, apiV2Root } from './urls';

function encodeBasic(email: string, token: string): string {
  return `Basic ${Buffer.from(`${email}:${token}`, 'utf8').toString('base64')}`;
}

function mockTransport(
  handler: (request: HttpRequest) => HttpResponse | Promise<HttpResponse>,
): HttpTransport {
  return vi.fn(async (request) => handler(request));
}

describe('JiraClient', () => {
  it('sends Basic auth for Cloud', async () => {
    const transport = mockTransport(() => ({
      status: 200,
      headers: {},
      text: JSON.stringify({ values: [], isLast: true }),
    }));

    const client = new JiraClient({
      baseUrl: 'https://example.atlassian.net',
      authMode: 'cloud',
      email: 'user@example.com',
      token: 'secret-token',
      transport,
      useAdfDescription: false,
    });

    await client.listBoards();
    const call = vi.mocked(transport).mock.calls[0]?.[0];
    expect(call?.headers.Authorization).toBe(encodeBasic('user@example.com', 'secret-token'));
    expect(call?.headers['X-Atlassian-Token']).toBe('no-check');
    expect(call?.headers['User-Agent']).toBe('obsidian-jira-sync');
    expect(call?.headers.Origin).toBe('https://example.atlassian.net');
    expect(call?.headers.Referer).toBe('https://example.atlassian.net/');
  });

  it('sends Bearer auth for self-hosted PAT', async () => {
    const transport = mockTransport(() => ({
      status: 200,
      headers: {},
      text: JSON.stringify({ values: [], isLast: true }),
    }));

    const client = new JiraClient({
      baseUrl: 'https://jira.example',
      authMode: 'pat',
      token: 'pat-token',
      transport,
    });

    await client.listBoards();
    const call = vi.mocked(transport).mock.calls[0]?.[0];
    expect(call?.headers.Authorization).toBe('Bearer pat-token');
  });

  it('paginates listBoards until isLast', async () => {
    const baseUrl = 'https://jira.example';
    let boardPage = 0;
    const transport = mockTransport((request) => {
      if (request.url.startsWith(`${agileRoot(baseUrl)}/board?`)) {
        boardPage += 1;
        if (boardPage === 1) {
          return {
            status: 200,
            headers: {},
            text: JSON.stringify({
              values: [{ id: 1, name: 'A' }],
              isLast: false,
              total: 2,
            }),
          };
        }
        return {
          status: 200,
          headers: {},
          text: JSON.stringify({
            values: [{ id: 2, name: 'B' }],
            isLast: true,
            total: 2,
          }),
        };
      }
      return { status: 404, headers: {}, text: 'not found' };
    });

    const client = new JiraClient({
      baseUrl,
      authMode: 'pat',
      token: 'pat',
      transport,
    });

    const boards = await client.listBoards();
    expect(boards).toHaveLength(2);
    expect(boards.map((board) => board.id)).toEqual([1, 2]);
    expect(vi.mocked(transport)).toHaveBeenCalledTimes(2);
  });

  it('POSTs createIssue and follows with GET issue', async () => {
    const baseUrl = 'https://jira.example';
    const transport = mockTransport((request) => {
      if (request.method === 'POST' && request.url.endsWith('/rest/api/2/issue')) {
        expect(request.body).toContain('"summary":"New task"');
        expect(request.body).toContain('"project":{"key":"PROJ"}');
        expect(request.headers['X-Atlassian-Token']).toBe('no-check');
        expect(request.headers['User-Agent']).toBe('obsidian-jira-sync');
        return {
          status: 201,
          headers: {},
          text: JSON.stringify({ id: '100', key: 'PROJ-9' }),
        };
      }
      if (request.method === 'GET' && request.url.includes('/rest/api/2/issue/PROJ-9')) {
        return {
          status: 200,
          headers: {},
          text: JSON.stringify({
            id: '100',
            key: 'PROJ-9',
            fields: {
              summary: 'New task',
              description: 'Details',
              status: { id: '1', name: 'To Do' },
              project: { key: 'PROJ' },
            },
          }),
        };
      }
      return { status: 404, headers: {}, text: 'not found' };
    });

    const client = new JiraClient({
      baseUrl,
      authMode: 'pat',
      token: 'pat',
      transport,
    });

    const created = await client.createIssue({
      projectKey: 'PROJ',
      summary: 'New task',
      description: 'Details',
    });

    expect(created.key).toBe('PROJ-9');
    expect(created.fields.summary).toBe('New task');
    expect(created.fields.description).toBe('Details');
  });

  it('createIssue prefers /api/2 even on Cloud to avoid XSRF on /api/3', async () => {
    const baseUrl = 'https://example.atlassian.net';
    const urls: string[] = [];
    const transport = mockTransport((request) => {
      urls.push(`${request.method} ${request.url}`);
      if (request.method === 'POST' && request.url.endsWith('/rest/api/2/issue')) {
        expect(request.body).toContain('"description":"Details"');
        expect(request.body).not.toContain('"type":"doc"');
        return {
          status: 201,
          headers: {},
          text: JSON.stringify({ id: '100', key: 'PROJ-9' }),
        };
      }
      if (request.method === 'GET' && request.url.includes('/issue/PROJ-9')) {
        return {
          status: 200,
          headers: {},
          text: JSON.stringify({
            id: '100',
            key: 'PROJ-9',
            fields: {
              summary: 'New task',
              description: 'Details',
              status: { id: '1', name: 'To Do' },
              project: { key: 'PROJ' },
            },
          }),
        };
      }
      return { status: 500, headers: {}, text: 'unexpected ' + request.url };
    });

    const client = new JiraClient({
      baseUrl,
      authMode: 'cloud',
      email: 'user@example.com',
      token: 'token',
      transport,
      useAdfDescription: true,
    });

    const created = await client.createIssue({
      projectKey: 'PROJ',
      summary: 'New task',
      description: 'Details',
    });
    expect(created.key).toBe('PROJ-9');
    expect(urls.some((url) => url.includes('POST') && url.includes('/rest/api/3/issue'))).toBe(
      false,
    );
  });

  it('parses Jira error payloads into JiraApiError messages', async () => {
    const transport = mockTransport(() => ({
      status: 400,
      headers: {},
      text: JSON.stringify({
        errorMessages: ['Invalid request', 'Board missing'],
      }),
    }));

    const client = new JiraClient({
      baseUrl: 'https://jira.example',
      authMode: 'pat',
      token: 'pat',
      transport,
    });

    await expect(client.getBoard(99)).rejects.toMatchObject({
      name: 'JiraApiError',
      message: 'Invalid request; Board missing',
      status: 400,
    } satisfies Partial<JiraApiError>);
  });

  it('requests boards from the Agile REST API', async () => {
    const baseUrl = 'https://jira.example';
    const transport = mockTransport((request) => {
      if (request.url === `${agileRoot(baseUrl)}/board/7`) {
        return {
          status: 200,
          headers: {},
          text: JSON.stringify({ id: 7, name: 'Board' }),
        };
      }
      return { status: 404, headers: {}, text: '' };
    });

    const client = new JiraClient({
      baseUrl,
      authMode: 'pat',
      token: 'pat',
      transport,
    });

    const board = await client.getBoard(7);
    expect(board.id).toBe(7);
    expect(vi.mocked(transport).mock.calls[0]?.[0].url).toBe(
      `${agileRoot(baseUrl)}/board/7`,
    );
  });

  it('listBoardLabels finds labels from backlog when the active board query is empty', async () => {
    const baseUrl = 'https://jira.example';
    const transport = mockTransport((request) => {
      if (request.url.startsWith(`${agileRoot(baseUrl)}/board/5/issue`)) {
        return {
          status: 200,
          headers: {},
          text: JSON.stringify({ issues: [], total: 0 }),
        };
      }
      if (request.url.startsWith(`${agileRoot(baseUrl)}/board/5/backlog`)) {
        return {
          status: 200,
          headers: {},
          text: JSON.stringify({
            issues: [
              {
                id: '1',
                key: 'PROJ-1',
                fields: { labels: ['project-a', 'backend'] },
              },
            ],
            total: 1,
          }),
        };
      }
      if (request.url === `${agileRoot(baseUrl)}/board/5`) {
        return {
          status: 200,
          headers: {},
          text: JSON.stringify({
            id: 5,
            name: 'Board',
            location: { projectKey: 'PROJ' },
          }),
        };
      }
      if (request.url.startsWith(`${apiV2Root(baseUrl)}/search`)) {
        return {
          status: 200,
          headers: {},
          text: JSON.stringify({ issues: [], total: 0 }),
        };
      }
      return { status: 404, headers: {}, text: '' };
    });

    const client = new JiraClient({
      baseUrl,
      authMode: 'pat',
      token: 'pat',
      transport,
    });

    await expect(client.listBoardLabels(5)).resolves.toEqual(['backend', 'project-a']);
  });

  it('listBoardIssuesForSync uses enhanced Cloud search (GET) for label filters', async () => {
    const baseUrl = 'https://example.atlassian.net';
    const transport = mockTransport((request) => {
      if (request.url === `${agileRoot(baseUrl)}/board/5`) {
        return {
          status: 200,
          headers: {},
          text: JSON.stringify({
            id: 5,
            name: 'Board',
            location: { projectKey: 'PROJ' },
          }),
        };
      }
      if (
        request.method === 'GET' &&
        request.url.startsWith(`${baseUrl}/rest/api/3/search/jql?`)
      ) {
        expect(request.url).toContain('labels');
        expect(request.url).toContain('PROJ');
        expect(request.headers['X-Atlassian-Token']).toBe('no-check');
        return {
          status: 200,
          headers: {},
          text: JSON.stringify({
            isLast: true,
            issues: [
              {
                id: '1',
                key: 'PROJ-9',
                fields: {
                  summary: 'Pay flow',
                  labels: ['unitpay'],
                  status: { id: '1', name: 'To Do' },
                  project: { key: 'PROJ' },
                },
              },
            ],
          }),
        };
      }
      if (request.url.startsWith(`${agileRoot(baseUrl)}/board/5/issue`)) {
        return { status: 200, headers: {}, text: JSON.stringify({ issues: [], total: 0 }) };
      }
      if (request.url.startsWith(`${agileRoot(baseUrl)}/board/5/backlog`)) {
        return { status: 404, headers: {}, text: 'no backlog' };
      }
      return { status: 404, headers: {}, text: request.url };
    });

    const client = new JiraClient({
      baseUrl,
      authMode: 'cloud',
      email: 'user@example.com',
      token: 'token',
      transport,
      useAdfDescription: true,
    });

    const issues = await client.listBoardIssuesForSync(5, ['labels', 'summary'], {
      labels: ['unitpay'],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.key).toBe('PROJ-9');
  });

  it('listBoardIssuesForSync includes recency in Cloud search JQL', async () => {
    const baseUrl = 'https://example.atlassian.net';
    const transport = mockTransport((request) => {
      if (request.url === `${agileRoot(baseUrl)}/board/5`) {
        return {
          status: 200,
          headers: {},
          text: JSON.stringify({
            id: 5,
            name: 'Board',
            location: { projectKey: 'PROJ' },
          }),
        };
      }
      if (
        request.method === 'GET' &&
        request.url.startsWith(`${baseUrl}/rest/api/3/search/jql?`)
      ) {
        const jql = new URL(request.url).searchParams.get('jql') ?? '';
        expect(jql).toContain('labels in ("unitpay")');
        expect(jql).toContain('updated >= -90d');
        return {
          status: 200,
          headers: {},
          text: JSON.stringify({
            isLast: true,
            issues: [
              {
                id: '1',
                key: 'PROJ-10',
                fields: {
                  summary: 'Recent',
                  labels: ['unitpay'],
                  status: { id: '1', name: 'To Do' },
                  project: { key: 'PROJ' },
                },
              },
            ],
          }),
        };
      }
      if (request.url.startsWith(`${agileRoot(baseUrl)}/board/5/issue`)) {
        return { status: 200, headers: {}, text: JSON.stringify({ issues: [], total: 0 }) };
      }
      if (request.url.startsWith(`${agileRoot(baseUrl)}/board/5/backlog`)) {
        return { status: 404, headers: {}, text: 'no backlog' };
      }
      return { status: 404, headers: {}, text: request.url };
    });

    const client = new JiraClient({
      baseUrl,
      authMode: 'cloud',
      email: 'user@example.com',
      token: 'token',
      transport,
      useAdfDescription: true,
    });

    const issues = await client.listBoardIssuesForSync(5, ['labels', 'summary'], {
      labels: ['unitpay'],
      recency: { field: 'updated', value: 90, unit: 'days' },
    });
    expect(issues.map((issue) => issue.key)).toEqual(['PROJ-10']);
  });

  it('listBoardIssuesForSync merges backlog when the board view is empty', async () => {
    const baseUrl = 'https://jira.example';
    const transport = mockTransport((request) => {
      if (request.url === `${agileRoot(baseUrl)}/board/5`) {
        return {
          status: 200,
          headers: {},
          text: JSON.stringify({
            id: 5,
            name: 'Board',
            location: { projectKey: 'PROJ' },
          }),
        };
      }
      if (request.method === 'POST' && request.url.includes('/search/jql')) {
        return { status: 404, headers: {}, text: 'no enhanced search' };
      }
      if (request.url.startsWith(`${apiV2Root(baseUrl)}/search`)) {
        return { status: 410, headers: {}, text: JSON.stringify({ errorMessages: ['gone'] }) };
      }
      if (request.url.startsWith(`${agileRoot(baseUrl)}/board/5/issue`)) {
        expect(request.url).toContain('jql=labels');
        return { status: 200, headers: {}, text: JSON.stringify({ issues: [], total: 0 }) };
      }
      if (request.url.startsWith(`${agileRoot(baseUrl)}/board/5/backlog`)) {
        return {
          status: 200,
          headers: {},
          text: JSON.stringify({
            issues: [
              {
                id: '1',
                key: 'PROJ-9',
                fields: {
                  summary: 'Backlog item',
                  labels: ['unitpay'],
                  status: { id: '1', name: 'To Do' },
                  project: { key: 'PROJ' },
                },
              },
            ],
            total: 1,
          }),
        };
      }
      return { status: 404, headers: {}, text: '' };
    });

    const client = new JiraClient({
      baseUrl,
      authMode: 'pat',
      token: 'pat',
      transport,
      useAdfDescription: false,
    });

    const issues = await client.listBoardIssuesForSync(5, ['labels', 'summary'], ['unitpay']);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.key).toBe('PROJ-9');
  });

  it('listBoardLabels falls back to the global /label catalog', async () => {
    const baseUrl = 'https://jira.example';
    const transport = mockTransport((request) => {
      if (request.url.startsWith(`${agileRoot(baseUrl)}/board/5/issue`)) {
        return { status: 200, headers: {}, text: JSON.stringify({ issues: [], total: 0 }) };
      }
      if (request.url.startsWith(`${agileRoot(baseUrl)}/board/5/backlog`)) {
        return { status: 404, headers: {}, text: 'no backlog' };
      }
      if (request.url === `${agileRoot(baseUrl)}/board/5`) {
        return {
          status: 200,
          headers: {},
          text: JSON.stringify({ id: 5, name: 'Board', location: { projectKey: 'PROJ' } }),
        };
      }
      if (request.url.startsWith(`${apiV2Root(baseUrl)}/search`)) {
        return { status: 200, headers: {}, text: JSON.stringify({ issues: [], total: 0 }) };
      }
      if (request.url.startsWith(`${apiV2Root(baseUrl)}/label`)) {
        return {
          status: 200,
          headers: {},
          text: JSON.stringify({
            values: ['security', 'performance'],
            isLast: true,
            total: 2,
          }),
        };
      }
      return { status: 404, headers: {}, text: '' };
    });

    const client = new JiraClient({
      baseUrl,
      authMode: 'pat',
      token: 'pat',
      transport,
    });

    await expect(client.listBoardLabels(5)).resolves.toEqual(['performance', 'security']);
  });
});
