import { describe, expect, it } from 'vitest';
import {
  decideAssigneeReconcile,
  normalizeAssigneeMappings,
  toJiraAssigneePayload,
} from './assignee';

const mappings = normalizeAssigneeMappings([
  {
    jiraAccountId: '5b10a0e53c331087c5de6411',
    jiraDisplayName: 'Aryapov',
    obsidianValue: 'Аряпов',
  },
  {
    jiraAccountId: 'acc-razin',
    jiraDisplayName: 'Razin',
    jiraName: 'razin',
    obsidianValue: 'Разин',
  },
]);

describe('assignee reconcile decisions', () => {
  it('sets Obsidian when local empty and Jira is mapped', () => {
    expect(
      decideAssigneeReconcile({
        localAssignee: null,
        remoteAssigneeId: '5b10a0e53c331087c5de6411',
        mappings,
      }),
    ).toMatchObject({
      action: 'set-local',
      obsidianValue: 'Аряпов',
    });
  });

  it('sets Jira when Obsidian has a mapped value and Jira is empty', () => {
    expect(
      decideAssigneeReconcile({
        localAssignee: 'Разин',
        remoteAssigneeId: null,
        mappings,
      }),
    ).toMatchObject({
      action: 'set-remote',
      mapping: { jiraAccountId: 'acc-razin' },
    });
  });

  it('lets Obsidian win when values differ', () => {
    expect(
      decideAssigneeReconcile({
        localAssignee: 'Аряпов',
        remoteAssigneeId: 'acc-razin',
        mappings,
      }),
    ).toMatchObject({
      action: 'set-remote',
      mapping: { jiraAccountId: '5b10a0e53c331087c5de6411' },
    });
  });

  it('no-ops when unmapped or already aligned', () => {
    expect(
      decideAssigneeReconcile({
        localAssignee: null,
        remoteAssigneeId: 'unknown',
        mappings,
      }),
    ).toEqual({ action: 'none' });
    expect(
      decideAssigneeReconcile({
        localAssignee: 'Аряпов',
        remoteAssigneeId: '5b10a0e53c331087c5de6411',
        mappings,
      }),
    ).toEqual({ action: 'none' });
  });

  it('builds Cloud vs Server assignee payloads', () => {
    expect(toJiraAssigneePayload(mappings[0]!)).toEqual({
      accountId: '5b10a0e53c331087c5de6411',
    });
    expect(toJiraAssigneePayload(mappings[1]!)).toEqual({ name: 'razin' });
  });
});
