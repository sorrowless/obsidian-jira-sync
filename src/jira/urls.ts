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

/** Parse a line body that is exactly `[title](url)`. */
export function parseMarkdownLink(body: string): { title: string; url: string } | null {
  const match = body.trim().match(/^\[([^\]]*)\]\(([^)\s]+)\)$/u);
  if (!match) {
    return null;
  }
  return { title: match[1] ?? '', url: match[2] ?? '' };
}
