import { describe, expect, it } from 'vitest';
import {
  buildTargetEndWritePayload,
  extractTimeSpentSeconds,
  formatDurationSeconds,
  normalizeActualEndDate,
  resolveIssueDates,
  subtractSecondsFromIso,
} from './issue-dates';

describe('issue date resolution', () => {
  it('prefers actual end over target end for due date', () => {
    const resolved = resolveIssueDates(
      {
        duedate: '2026-10-10',
        customfield_actual: '2026-10-03T08:00:00.000+0300',
      },
      {
        actualEndFieldId: 'customfield_actual',
        targetEndFieldId: 'duedate',
      },
    );
    expect(resolved.dueDateSource).toBe('actual-end');
    expect(resolved.dueDate).toBeTruthy();
    expect(resolved.targetEnd).toBeTruthy();
  });

  it('uses target end when actual end is empty', () => {
    const resolved = resolveIssueDates(
      { duedate: '2026-10-10' },
      { actualEndFieldId: 'customfield_actual', targetEndFieldId: 'duedate' },
    );
    expect(resolved.dueDateSource).toBe('target-end');
    expect(resolved.dueDate).toBeTruthy();
  });

  it('leaves due empty when both ends are unset (time tracking alone does not invent due)', () => {
    const resolved = resolveIssueDates(
      {
        timetracking: { timeSpentSeconds: 3600 },
      },
      { actualEndFieldId: 'customfield_actual' },
    );
    expect(resolved.dueDate).toBeNull();
    expect(resolved.dueDateSource).toBeNull();
  });

  it('derives start from actual end minus time spent when start field is empty', () => {
    const actualEnd = '2026-10-03T08:00:00.000+03:00';
    const resolved = resolveIssueDates(
      {
        customfield_actual: actualEnd,
        timetracking: { timeSpentSeconds: 3600 },
      },
      {
        startDateFieldId: 'customfield_start',
        actualEndFieldId: 'customfield_actual',
      },
    );
    expect(resolved.startDateSource).toBe('derived');
    expect(resolved.jiraStartDate).toBeNull();
    expect(resolved.startDate).toBe(subtractSecondsFromIso(new Date(actualEnd).toISOString(), 3600));
    expect(resolved.startDateDerivedDetail).toContain('actual end − time tracking');
    expect(resolved.startDateDerivedDetail).toContain('1h');
  });

  it('keeps explicit start field over derivation', () => {
    const resolved = resolveIssueDates(
      {
        customfield_start: '2026-10-01',
        customfield_actual: '2026-10-03T08:00:00.000+03:00',
        timetracking: { timeSpentSeconds: 3600 },
      },
      {
        startDateFieldId: 'customfield_start',
        actualEndFieldId: 'customfield_actual',
      },
    );
    expect(resolved.startDateSource).toBe('field');
    expect(resolved.startDateDerivedDetail).toBeNull();
  });

  it('writes Obsidian due to target end (duedate by default)', () => {
    expect(buildTargetEndWritePayload({}, '2026-10-05T12:00:00.000Z')).toEqual({
      duedate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
    expect(
      buildTargetEndWritePayload({ targetEndFieldId: 'customfield_target' }, '2026-10-05'),
    ).toEqual({
      customFields: { customfield_target: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) },
    });
  });

  it('formats durations and extracts time spent', () => {
    expect(formatDurationSeconds(3600)).toBe('1h');
    expect(formatDurationSeconds(5400)).toBe('1h 30m');
    expect(extractTimeSpentSeconds({ timetracking: { timeSpentSeconds: 120 } })).toBe(120);
    expect(extractTimeSpentSeconds({ timespent: 90 })).toBe(90);
  });

  it('treats date-only actual end as end of local day', () => {
    const end = normalizeActualEndDate('2026-10-03');
    expect(end).toBeTruthy();
    const derived = subtractSecondsFromIso(end!, 3600);
    expect(derived).toBeTruthy();
    // Still on 2026-10-03 in local calendar for a 1h subtraction from 23:59.
    const local = new Date(derived!);
    expect(local.getFullYear()).toBe(2026);
    expect(local.getMonth()).toBe(9);
    expect(local.getDate()).toBe(3);
  });
});
