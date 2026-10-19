import { normalizeTimeSpentSeconds } from '../note/timespent';

export const DEFAULT_TIME_SPENT_FIELD_ID = 'timetracking';

/**
 * Read time spent (seconds) from issue fields using the configured field id.
 * - `timetracking` → `timetracking.timeSpentSeconds` (fallback `timespent`)
 * - `timespent` or custom numeric field → integer seconds
 */
export function extractConfiguredTimeSpentSeconds(
  fields: Record<string, unknown> | null | undefined,
  fieldId: string | null | undefined,
): number | null {
  const raw = fields ?? {};
  const id = (fieldId?.trim() || DEFAULT_TIME_SPENT_FIELD_ID).toLowerCase();

  if (id === 'timetracking') {
    const tracking = raw.timetracking;
    if (tracking && typeof tracking === 'object') {
      const spent = (tracking as { timeSpentSeconds?: unknown }).timeSpentSeconds;
      const fromTracking = normalizeTimeSpentSeconds(spent);
      if (fromTracking !== null && fromTracking > 0) {
        return fromTracking;
      }
    }
    const direct = normalizeTimeSpentSeconds(raw.timespent);
    return direct !== null && direct > 0 ? direct : null;
  }

  const value = raw[fieldId?.trim() || id];
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const spent = (value as { timeSpentSeconds?: unknown }).timeSpentSeconds;
    const nested = normalizeTimeSpentSeconds(spent);
    if (nested !== null && nested > 0) {
      return nested;
    }
  }
  const direct = normalizeTimeSpentSeconds(value);
  return direct !== null && direct > 0 ? direct : null;
}

export type TimeSpentReconcileDecision =
  | { action: 'none' }
  | { action: 'set-local'; seconds: number; detail: string };

/**
 * Pull-only: when Jira has time spent and Obsidian is empty or differs, set Obsidian.
 * Caller must skip when both sides are done. Never pushes to Jira.
 */
export function decideTimeSpentReconcile(input: {
  localSeconds: number | null | undefined;
  remoteSeconds: number | null | undefined;
}): TimeSpentReconcileDecision {
  const remote = normalizeTimeSpentSeconds(input.remoteSeconds);
  if (remote === null || remote <= 0) {
    return { action: 'none' };
  }
  const local = normalizeTimeSpentSeconds(input.localSeconds);
  if (local === remote) {
    return { action: 'none' };
  }
  return {
    action: 'set-local',
    seconds: remote,
    detail: `set [timespent:: ${remote}] from Jira (${remote}s)`,
  };
}

/** Issue field ids to request for the configured time-spent source. */
export function timeSpentIssueFieldIds(fieldId: string | null | undefined): string[] {
  const id = fieldId?.trim() || DEFAULT_TIME_SPENT_FIELD_ID;
  if (id.toLowerCase() === 'timetracking') {
    return ['timetracking', 'timespent'];
  }
  return [id];
}
