import { describe, expect, it } from 'vitest';
import {
  checkboxFromStatus,
  pickColumnForCoarseStatus,
  statusFromCheckbox,
  statusFromJiraStatus,
  statusLabelFromColumnName,
} from './status';

describe('status mapping', () => {
  it('maps checkboxes', () => {
    expect(statusFromCheckbox(' ')).toBe('todo');
    expect(statusFromCheckbox('/')).toBe('in_progress');
    expect(statusFromCheckbox('x')).toBe('done');
    expect(checkboxFromStatus('in_progress')).toBe('/');
  });

  it('maps jira status names and categories', () => {
    expect(statusFromJiraStatus('To Do', 'new')).toBe('todo');
    expect(statusFromJiraStatus('Review', 'indeterminate')).toBe('in_progress');
    expect(statusFromJiraStatus('Canceled', 'done')).toBe('done');
    expect(statusFromJiraStatus('Weird', 'done')).toBe('done');
  });

  it('builds status labels from column names', () => {
    expect(statusLabelFromColumnName('In Progress')).toBe('in-progress');
    expect(statusLabelFromColumnName('Review')).toBe('review');
  });

  it('picks unambiguous columns for obsidian statuses', () => {
    const columns = [
      { name: 'To Do', statusIds: ['1'] },
      { name: 'In Progress', statusIds: ['2'] },
      { name: 'Review', statusIds: ['3'] },
      { name: 'Done', statusIds: ['4'] },
    ];
    expect(pickColumnForCoarseStatus(columns, 'todo')?.name).toBe('To Do');
    expect(pickColumnForCoarseStatus(columns, 'in_progress')?.name).toBe('In Progress');
    expect(pickColumnForCoarseStatus(columns, 'done')?.name).toBe('Done');
  });
});
