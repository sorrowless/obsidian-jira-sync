import { describe, expect, it } from 'vitest';
import { parseNoteTasks } from './parser';

const BASE = 'https://jira.example';

describe('parseNoteTasks', () => {
  it('parses linked and unlinked tasks with nesting and dates', () => {
    const md = [
      '- [ ] [Parent](https://jira.example/browse/PROJ-1) 🛫 2026-10-02 📅 2026-10-05',
      '    - desc line',
      '    - [ ] Child idea',
      '- [/] In progress local',
    ].join('\n');

    const roots = parseNoteTasks(md, { jiraBaseUrl: BASE });
    expect(roots).toHaveLength(2);
    expect(roots[0]?.issueKey).toBe('PROJ-1');
    expect(roots[0]?.title).toBe('Parent');
    expect(roots[0]?.descriptionLines).toEqual(['desc line']);
    expect(roots[0]?.children).toHaveLength(1);
    expect(roots[0]?.children[0]?.issueKey).toBeNull();
    expect(roots[0]?.children[0]?.title).toBe('Child idea');
    expect(roots[1]?.status).toBe('in_progress');
  });

  it('ignores foreign browse links', () => {
    const roots = parseNoteTasks(
      '- [ ] [X](https://other.example/browse/PROJ-1)',
      { jiraBaseUrl: BASE },
    );
    expect(roots[0]?.issueKey).toBeNull();
    expect(roots[0]?.title).toBe('X');
  });

  it('parses Dataview assignee fields', () => {
    const roots = parseNoteTasks(
      '- [ ] [Parent](https://jira.example/browse/PROJ-1) 📅 2026-10-05 [assignee:: Аряпов]',
      { jiraBaseUrl: BASE },
    );
    expect(roots[0]?.assignee).toBe('Аряпов');
    expect(roots[0]?.title).toBe('Parent');
    expect(roots[0]?.dueDate).toBeTruthy();
  });
});
