import { describe, expect, it, vi } from 'vitest';
import { createObsidianRequestTransport } from './http';

describe('createObsidianRequestTransport', () => {
  it('calls Obsidian requestUrl with throw:false and normalizes headers', async () => {
    const requestUrlFn = vi.fn(async (options: {
      url: string;
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      throw?: boolean;
    }) => ({
      status: 418,
      headers: { 'Content-Type': 'application/json', 'X-Test': 'yes' },
      text: '{"ok":true}',
    }));

    const transport = createObsidianRequestTransport(requestUrlFn);
    const response = await transport({
      url: 'https://jira.example/rest/api/2/myself',
      method: 'GET',
      headers: { Accept: 'application/json' },
    });

    expect(requestUrlFn).toHaveBeenCalledWith({
      url: 'https://jira.example/rest/api/2/myself',
      method: 'GET',
      headers: { Accept: 'application/json' },
      body: undefined,
      throw: false,
    });
    expect(response.status).toBe(418);
    expect(response.text).toBe('{"ok":true}');
    expect(response.headers['content-type']).toBe('application/json');
    expect(response.headers['x-test']).toBe('yes');
  });

  it('forwards request bodies for POST/PUT', async () => {
    const requestUrlFn = vi.fn(async () => ({
      status: 204,
      headers: {},
      text: '',
    }));

    const transport = createObsidianRequestTransport(requestUrlFn);
    await transport({
      url: 'https://jira.example/rest/api/2/issue',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"fields":{}}',
    });

    expect(requestUrlFn).toHaveBeenCalledWith(
      expect.objectContaining({
        body: '{"fields":{}}',
        throw: false,
      }),
    );
  });
});
