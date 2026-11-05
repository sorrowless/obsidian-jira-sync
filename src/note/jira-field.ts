import {
  extractIssueKeyFromUrl,
  isIssueKey,
  issueBrowseUrl,
  parseMarkdownLinkAtStart,
} from '../jira/urls';

/** Dataview inline field key for the Jira issue identity (dual-link mode). */
export const JIRA_FIELD_KEY = 'jira';

/**
 * Match `[jira:: …]` including nested `[KEY](url)` values.
 * Closing `]` is found by scanning so values may contain brackets.
 */
const JIRA_FIELD_PREFIX_RE = /\[jira::\s*/giu;

/**
 * Extract `[jira:: value]` from task-line text.
 * Value may be a markdown link `[PROJ-1](url)` or a bare issue key.
 */
export function parseJiraField(
  text: string,
  jiraBaseUrl: string,
): {
  jiraIssueKey: string | null;
  remainder: string;
} {
  const re = new RegExp(JIRA_FIELD_PREFIX_RE.source, 'giu');
  const match = re.exec(text);
  if (!match) {
    return { jiraIssueKey: null, remainder: text };
  }
  const start = match.index;
  const valueStart = start + match[0].length;
  const valueEnd = findClosingBracket(text, valueStart);
  if (valueEnd < 0) {
    return { jiraIssueKey: null, remainder: text };
  }
  const rawValue = text.slice(valueStart, valueEnd).trim();
  const jiraIssueKey = resolveJiraValue(rawValue, jiraBaseUrl);
  const remainder = `${text.slice(0, start)} ${text.slice(valueEnd + 1)}`
    .replace(/\s+/g, ' ')
    .trim();
  return { jiraIssueKey, remainder };
}

function findClosingBracket(text: string, from: number): number {
  let depth = 1;
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '[') {
      depth += 1;
    } else if (ch === ']') {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

function resolveJiraValue(raw: string, jiraBaseUrl: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const link = parseMarkdownLinkAtStart(trimmed);
  if (link && link.rest.trim() === '') {
    return (
      extractIssueKeyFromUrl(link.url, jiraBaseUrl) ??
      (isIssueKey(link.title) ? link.title.trim().toUpperCase() : null)
    );
  }
  if (isIssueKey(trimmed)) {
    return trimmed.trim().toUpperCase();
  }
  return null;
}

/** Trailing Dataview field for dual-link Jira identity. */
export function formatJiraSuffix(
  issueKey: string | null | undefined,
  jiraBaseUrl: string,
): string {
  const key = typeof issueKey === 'string' ? issueKey.trim().toUpperCase() : '';
  if (!key || !isIssueKey(key)) {
    return '';
  }
  const url = issueBrowseUrl(jiraBaseUrl, key);
  return ` [${JIRA_FIELD_KEY}:: [${key}](${url})]`;
}
