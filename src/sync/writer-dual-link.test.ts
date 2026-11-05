import { describe, expect, it } from 'vitest';
import { renderTask } from './writer';

const BASE = 'https://jira.example';

describe('dual-link writer', () => {
  it('keeps external title URL and appends jira field', () => {
    const line = renderTask(
      {
        indent: '',
        listMarker: '-',
        checkboxChar: '/',
        title: 'Tracker title',
        issueKey: 'PROJ-42',
        titleLinkUrl: 'https://tracker.example/CL-1',
        jiraIssueKey: 'PROJ-42',
        unknownInlineFields: ['[ytracker:: keep]'],
        descriptionLines: [],
        children: [],
      },
      BASE,
    );
    expect(line).toBe(
      '- [/] [Tracker title](https://tracker.example/CL-1) [jira:: [PROJ-42](https://jira.example/browse/PROJ-42)] [ytracker:: keep]',
    );
  });

  it('omits jira field for classic Jira title links', () => {
    const line = renderTask(
      {
        indent: '',
        listMarker: '-',
        checkboxChar: ' ',
        title: 'Native',
        issueKey: 'PROJ-1',
        titleLinkUrl: 'https://jira.example/browse/PROJ-1',
        jiraIssueKey: 'PROJ-1',
        descriptionLines: [],
        children: [],
      },
      BASE,
    );
    expect(line).toBe('- [ ] [Native](https://jira.example/browse/PROJ-1)');
    expect(line).not.toContain('[jira::');
  });
});
