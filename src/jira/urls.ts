/** Normalized Jira instance root without trailing slash. */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

/** REST API v2 root. */
export function apiV2Root(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/rest/api/2`;
}

/** REST API v3 root (Cloud ADF descriptions). */
export function apiV3Root(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/rest/api/3`;
}

/** Agile REST root. */
export function agileRoot(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/rest/agile/1.0`;
}

/** Frontend browse URL written into Obsidian notes. */
export function issueBrowseUrl(baseUrl: string, issueKey: string): string {
  return `${normalizeBaseUrl(baseUrl)}/browse/${issueKey.toUpperCase()}`;
}

const ISSUE_KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/i;

export function isIssueKey(value: string): boolean {
  return ISSUE_KEY_RE.test(value.trim());
}

/**
 * Extract a Jira issue key from a URL if it belongs to this instance.
 * Ignores trailing slashes and query/hash fragments.
 */
export function extractIssueKeyFromUrl(url: string, baseUrl: string): string | null {
  const normalizedBase = normalizeBaseUrl(baseUrl);
  if (!normalizedBase || !url.trim()) {
    return null;
  }

  let parsed: URL;
  let expected: URL;
  try {
    parsed = new URL(url.trim());
    expected = new URL(normalizedBase);
  } catch {
    return null;
  }

  if (parsed.origin !== expected.origin) {
    return null;
  }

  const basePath = expected.pathname.replace(/\/+$/, '');
  const path = parsed.pathname.replace(/\/+$/, '');
  const prefix = `${basePath}/browse/`;

  let keyPart: string | null = null;
  if (path.startsWith(prefix)) {
    keyPart = path.slice(prefix.length);
  } else if (basePath === '' || basePath === '/') {
    const match = path.match(/^\/browse\/([^/]+)$/i);
    keyPart = match?.[1] ?? null;
  }

  if (!keyPart || keyPart.includes('/')) {
    return null;
  }
  if (!isIssueKey(keyPart)) {
    return null;
  }
  return keyPart.toUpperCase();
}

/**
 * Parse a Markdown link at the start of `body`: `[title](url)` with optional rest.
 * Title may contain nested brackets (e.g. Obsidian `[[wikilink]]` as link text).
 * Uses balanced-bracket matching so the first `]` inside the title does not truncate.
 */
export function parseMarkdownLinkAtStart(
  body: string,
): { title: string; url: string; rest: string } | null {
  const input = body;
  if (!input.startsWith('[')) {
    return null;
  }
  let depth = 0;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === '[') {
      depth += 1;
      continue;
    }
    if (ch !== ']') {
      continue;
    }
    depth -= 1;
    if (depth !== 0) {
      continue;
    }
    if (input[i + 1] !== '(') {
      return null;
    }
    const urlStart = i + 2;
    let urlEnd = -1;
    for (let j = urlStart; j < input.length; j += 1) {
      if (input[j] === ')') {
        urlEnd = j;
        break;
      }
      // URLs in our notes are single tokens (no spaces).
      if (/\s/u.test(input[j] ?? '')) {
        return null;
      }
    }
    if (urlEnd < 0) {
      return null;
    }
    const title = input.slice(1, i);
    const url = input.slice(urlStart, urlEnd);
    if (!url) {
      return null;
    }
    const after = input.slice(urlEnd + 1);
    const rest = after.replace(/^\s+/u, '');
    return { title, url, rest };
  }
  return null;
}

/** Parse a line body that is exactly `[title](url)`. */
export function parseMarkdownLink(body: string): { title: string; url: string } | null {
  const parsed = parseMarkdownLinkAtStart(body.trim());
  if (!parsed || parsed.rest !== '') {
    return null;
  }
  return { title: parsed.title, url: parsed.url };
}
