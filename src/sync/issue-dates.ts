import {
  normalizeJiraDate,
  parseFlexibleDate,
  toJiraDueDatePayload,
} from '../note/dates';

/** Field ids used when reading/writing issue dates from Jira. */
export interface DateFieldConfig {
  /** Custom Start date field (🛫). Empty = do not sync start to Jira. */
  startDateFieldId?: string;
  /**
   * Actual end field. When set and filled, wins over target end for Obsidian 📅.
   * Never written from Obsidian.
   */
  actualEndFieldId?: string;
  /**
   * Target end / due field. Defaults to standard `duedate`.
   * Obsidian due date pushes here.
   */
  targetEndFieldId?: string;
}

export type DueDateSource = 'actual-end' | 'target-end' | null;
export type StartDateSource = 'field' | 'derived' | null;

export interface ResolvedIssueDates {
  startDate: string | null;
  dueDate: string | null;
  dueDateSource: DueDateSource;
  startDateSource: StartDateSource;
  /** Raw Start date field value (before derivation). */
  jiraStartDate: string | null;
  actualEnd: string | null;
  targetEnd: string | null;
  timeSpentSeconds: number | null;
  /** Set when startDateSource === 'derived'. */
  startDateDerivedDetail: string | null;
}

const DEFAULT_TARGET_END_FIELD = 'duedate';

export function resolveTargetEndFieldId(config?: DateFieldConfig | null): string {
  const trimmed = config?.targetEndFieldId?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_TARGET_END_FIELD;
}

/**
 * Resolve Obsidian start/due from Jira fields:
 * - due: actual end if set, else target end, else null (time tracking never invents due)
 * - start: Start field if set; else actual end − time spent when both exist
 */
export function resolveIssueDates(
  fields: Record<string, unknown> | null | undefined,
  config: DateFieldConfig = {},
): ResolvedIssueDates {
  const raw = fields ?? {};
  const startFieldId = config.startDateFieldId?.trim() || '';
  const actualEndFieldId = config.actualEndFieldId?.trim() || '';
  const targetEndFieldId = resolveTargetEndFieldId(config);

  const jiraStartDate = startFieldId ? normalizeJiraDate(raw[startFieldId]) : null;
  const actualEnd = actualEndFieldId
    ? normalizeActualEndDate(raw[actualEndFieldId])
    : null;
  const targetEnd = normalizeJiraDate(raw[targetEndFieldId]);
  const timeSpentSeconds = extractTimeSpentSeconds(raw);

  let dueDate: string | null = null;
  let dueDateSource: DueDateSource = null;
  if (actualEnd) {
    dueDate = actualEnd;
    dueDateSource = 'actual-end';
  } else if (targetEnd) {
    dueDate = targetEnd;
    dueDateSource = 'target-end';
  }

  let startDate: string | null = jiraStartDate;
  let startDateSource: StartDateSource = jiraStartDate ? 'field' : null;
  let startDateDerivedDetail: string | null = null;

  if (!startDate && actualEnd && timeSpentSeconds != null && timeSpentSeconds > 0) {
    const derived = subtractSecondsFromIso(actualEnd, timeSpentSeconds);
    if (derived) {
      startDate = derived;
      startDateSource = 'derived';
      startDateDerivedDetail = `set start date from actual end − time tracking (${formatDurationSeconds(timeSpentSeconds)})`;
    }
  }

  return {
    startDate,
    dueDate,
    dueDateSource,
    startDateSource,
    jiraStartDate,
    actualEnd,
    targetEnd,
    timeSpentSeconds,
    startDateDerivedDetail,
  };
}

/** Build create/update payload that writes Obsidian due → target end (never actual end). */
export function buildTargetEndWritePayload(
  config: DateFieldConfig,
  dueDate: string | null | undefined,
): { duedate?: string | null; customFields?: Record<string, unknown> } {
  const fieldId = resolveTargetEndFieldId(config);
  const payload = toJiraDueDatePayload(dueDate ?? null);
  if (fieldId === 'duedate') {
    return { duedate: payload };
  }
  return { customFields: { [fieldId]: payload } };
}

/** Seconds logged on the issue (`timetracking.timeSpentSeconds` or `timespent`). */
export function extractTimeSpentSeconds(fields: Record<string, unknown>): number | null {
  const direct = fields.timespent;
  if (typeof direct === 'number' && Number.isFinite(direct) && direct > 0) {
    return Math.floor(direct);
  }

  const tracking = fields.timetracking;
  if (tracking && typeof tracking === 'object') {
    const spent = (tracking as { timeSpentSeconds?: unknown }).timeSpentSeconds;
    if (typeof spent === 'number' && Number.isFinite(spent) && spent > 0) {
      return Math.floor(spent);
    }
    const estimate = (tracking as { originalEstimateSeconds?: unknown }).originalEstimateSeconds;
    if (typeof estimate === 'number' && Number.isFinite(estimate) && estimate > 0) {
      return Math.floor(estimate);
    }
  }
  return null;
}

/**
 * Actual end: date-only values are treated as end of that local day so that
 * subtracting a short duration keeps the same calendar day when possible.
 */
export function normalizeActualEndDate(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return parseFlexibleDate(`${trimmed} 23:59:59`);
  }
  return normalizeJiraDate(trimmed);
}

export function subtractSecondsFromIso(iso: string, seconds: number): string | null {
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime()) || !Number.isFinite(seconds) || seconds < 0) {
    return null;
  }
  return new Date(dt.getTime() - Math.floor(seconds) * 1000).toISOString();
}

/** Compact duration for notices: `1h`, `1h 30m`, `2d 3h`. */
export function formatDurationSeconds(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds === 0) {
    return '0m';
  }
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) {
    parts.push(`${days}d`);
  }
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0 && days === 0) {
    parts.push(`${minutes}m`);
  }
  if (parts.length === 0) {
    parts.push(`${seconds}s`);
  }
  return parts.join(' ');
}

/** Issue field names to request for date resolution. */
export function dateIssueFieldIds(config: DateFieldConfig): string[] {
  const fields = new Set<string>(['timetracking', 'timespent']);
  const target = resolveTargetEndFieldId(config);
  fields.add(target);
  const start = config.startDateFieldId?.trim();
  if (start) {
    fields.add(start);
  }
  const actual = config.actualEndFieldId?.trim();
  if (actual) {
    fields.add(actual);
  }
  return [...fields];
}
