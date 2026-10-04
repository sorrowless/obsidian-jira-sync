/** Escape a value for use inside a JQL double-quoted string. */
export function escapeJqlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Build `labels in ("a", "b")` for OR-matching mapping filters.
 * Returns null when the filter is empty.
 */
export function labelsInJql(labels: readonly string[]): string | null {
  const normalized = [
    ...new Set(
      labels
        .map((label) => String(label ?? '').trim())
        .filter((label) => label.length > 0),
    ),
  ];
  if (normalized.length === 0) {
    return null;
  }
  const quoted = normalized.map((label) => `"${escapeJqlString(label)}"`).join(', ');
  return `labels in (${quoted})`;
}

/** `project = "KEY"` or `project = 123` from a board location. */
export function boardProjectJql(location?: {
  projectKey?: string;
  projectId?: number;
} | null): string | null {
  const key = location?.projectKey?.trim();
  if (key) {
    return `project = "${escapeJqlString(key)}"`;
  }
  if (location?.projectId != null && Number.isFinite(location.projectId)) {
    return `project = ${Math.floor(location.projectId)}`;
  }
  return null;
}

export type RecencyField = 'updated' | 'created';
export type RecencyUnit = 'days' | 'months';

export interface RecencyFilter {
  field: RecencyField;
  value: number;
  unit: RecencyUnit;
}

/**
 * Build `updated >= -30d` / `created >= -3M` style relative JQL.
 * Returns null when disabled (value ≤ 0) or invalid.
 */
export function recencyJql(filter: RecencyFilter | null | undefined): string | null {
  if (!filter) {
    return null;
  }
  const value = Math.floor(filter.value);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  const field = filter.field === 'created' ? 'created' : 'updated';
  const suffix = filter.unit === 'months' ? 'M' : 'd';
  return `${field} >= -${value}${suffix}`;
}

export function isRecencyField(value: unknown): value is RecencyField {
  return value === 'updated' || value === 'created';
}

export function isRecencyUnit(value: unknown): value is RecencyUnit {
  return value === 'days' || value === 'months';
}
