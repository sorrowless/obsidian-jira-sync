import { describe, expect, it } from 'vitest';
import { boardProjectJql, escapeJqlString, labelsInJql, recencyJql } from './jql';

describe('jql helpers', () => {
  it('escapes quotes in JQL strings', () => {
    expect(escapeJqlString('a"b')).toBe('a\\"b');
  });

  it('builds labels in (...) clauses', () => {
    expect(labelsInJql([])).toBeNull();
    expect(labelsInJql(['unitpay'])).toBe('labels in ("unitpay")');
    expect(labelsInJql(['a', 'b'])).toBe('labels in ("a", "b")');
  });

  it('builds project clauses from board location', () => {
    expect(boardProjectJql({ projectKey: 'ops' })).toBe('project = "ops"');
    expect(boardProjectJql({ projectId: 10001 })).toBe('project = 10001');
    expect(boardProjectJql({})).toBeNull();
  });

  it('builds relative recency clauses', () => {
    expect(recencyJql(null)).toBeNull();
    expect(recencyJql({ field: 'updated', value: 0, unit: 'days' })).toBeNull();
    expect(recencyJql({ field: 'updated', value: 30, unit: 'days' })).toBe(
      'updated >= -30d',
    );
    expect(recencyJql({ field: 'created', value: 3, unit: 'months' })).toBe(
      'created >= -3M',
    );
  });
});
