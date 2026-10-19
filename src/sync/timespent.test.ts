import { describe, expect, it } from 'vitest';
import {
  decideTimeSpentReconcile,
  extractConfiguredTimeSpentSeconds,
} from './timespent';

describe('timespent pull-only reconcile', () => {
  it('sets Obsidian when empty or different from Jira', () => {
    expect(
      decideTimeSpentReconcile({ localSeconds: null, remoteSeconds: 3600 }),
    ).toEqual({
      action: 'set-local',
      seconds: 3600,
      detail: 'set [timespent:: 3600] from Jira (3600s)',
    });
    expect(
      decideTimeSpentReconcile({ localSeconds: 120, remoteSeconds: 3600 }),
    ).toMatchObject({ action: 'set-local', seconds: 3600 });
  });

  it('no-ops when aligned or remote empty', () => {
    expect(
      decideTimeSpentReconcile({ localSeconds: 3600, remoteSeconds: 3600 }),
    ).toEqual({ action: 'none' });
    expect(
      decideTimeSpentReconcile({ localSeconds: 100, remoteSeconds: null }),
    ).toEqual({ action: 'none' });
  });

  it('reads timetracking and timespent fields', () => {
    expect(
      extractConfiguredTimeSpentSeconds(
        { timetracking: { timeSpentSeconds: 90 } },
        'timetracking',
      ),
    ).toBe(90);
    expect(
      extractConfiguredTimeSpentSeconds({ timespent: 120 }, 'timespent'),
    ).toBe(120);
    expect(
      extractConfiguredTimeSpentSeconds(
        { customfield_1: 45 },
        'customfield_1',
      ),
    ).toBe(45);
  });
});
