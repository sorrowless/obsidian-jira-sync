/**
 * Minimal HTTP abstraction so the Jira client can use Obsidian's
 * `requestUrl` (no CORS) in the plugin and a fetch mock in unit tests.
 */

export interface HttpRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  /** Header names are lower-cased. */
  headers: Record<string, string>;
  text: string;
}

export type HttpTransport = (request: HttpRequest) => Promise<HttpResponse>;

export function createFetchTransport(fetchImpl: typeof fetch = fetch.bind(globalThis)): HttpTransport {
  return async (request) => {
    const response = await fetchImpl(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });
    const text = await response.text();
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    return {
      status: response.status,
      headers,
      text,
    };
  };
}

/**
 * Obsidian `requestUrl` wrapper — bypasses browser CORS that breaks `fetch`
 * against self-hosted Jira instances.
 */
export function createObsidianRequestTransport(
  requestUrlFn: (options: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    throw?: boolean;
  }) => Promise<{
    status: number;
    headers: Record<string, string>;
    text: string;
  }>,
): HttpTransport {
  return async (request) => {
    const response = await requestUrlFn({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: request.body,
      throw: false,
    });
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(response.headers ?? {})) {
      headers[key.toLowerCase()] = value;
    }
    return {
      status: response.status,
      headers,
      text: response.text ?? '',
    };
  };
}
