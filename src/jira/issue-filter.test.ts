import { describe, expect, it } from 'vitest';
import {
  buildAgileExtraJql,
  buildSyncJql,
  describeIssueSyncFilter,
} from './issue-filter';

describe('issue sync filter JQL', () => {
  it('combines project, labels, and recency', () => {
    expect(
      buildSyncJql(
        { projectKey: 'PROJ' },
        {
          labels: ['unitpay'],
          recency: { field: 'updated', value: 90, unit: 'days' },
        },
      ),
    ).toBe('project = "PROJ" AND labels in ("unitpay") AND updated >= -90d');
  });

  it('builds agile extra JQL without project', () => {
    expect(
      buildAgileExtraJql({
        labels: ['a'],
        recency: { field: 'created', value: 2, unit: 'months' },
      }),
    ).toBe('labels in ("a") AND created >= -2M');
    expect(buildAgileExtraJql({})).toBeUndefined();
  });

  it('describes active filters for errors/reports', () => {
    expect(describeIssueSyncFilter({})).toBe('no extra filters');
    expect(
      describeIssueSyncFilter({
        labels: ['unitpay'],
        recency: { field: 'updated', value: 30, unit: 'days' },
      }),
    ).toBe('labels in (unitpay) AND updated >= -30d');
  });
});
