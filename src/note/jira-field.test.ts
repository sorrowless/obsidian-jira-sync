import { describe, expect, it } from 'vitest';
import { formatJiraSuffix, parseJiraField } from './jira-field';

const BASE = 'https://jira.example';

describe('jira field', () => {
  it('parses markdown-link values', () => {
    const parsed = parseJiraField(
      ' [jira:: [PROJ-42](https://jira.example/browse/PROJ-42)] 📅 2026-01-01',
      BASE,
    );
    expect(parsed.jiraIssueKey).toBe('PROJ-42');
    expect(parsed.remainder).toBe('📅 2026-01-01');
  });

  it('parses bare issue keys', () => {
    const parsed = parseJiraField('[jira:: PROJ-1]', BASE);
    expect(parsed.jiraIssueKey).toBe('PROJ-1');
    expect(parsed.remainder).toBe('');
  });

  it('formats the canonical suffix', () => {
    expect(formatJiraSuffix('proj-42', BASE)).toBe(
      ' [jira:: [PROJ-42](https://jira.example/browse/PROJ-42)]',
    );
  });
});
