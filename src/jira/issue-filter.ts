import { boardProjectJql, labelsInJql, recencyJql, type RecencyFilter } from './jql';

/** Filters applied when loading issues for a board mapping. */
export interface IssueSyncFilter {
  labels?: readonly string[];
  recency?: RecencyFilter | null;
}

/** Combine project / labels / recency into one JQL (without ORDER BY). */
export function buildSyncJql(
  location: { projectKey?: string; projectId?: number } | null | undefined,
  filter: IssueSyncFilter,
): string | null {
  const parts: string[] = [];
  const project = boardProjectJql(location);
  if (project) {
    parts.push(project);
  }
  const labels = labelsInJql(filter.labels ?? []);
  if (labels) {
    parts.push(labels);
  }
  const recency = recencyJql(filter.recency);
  if (recency) {
    parts.push(recency);
  }
  if (parts.length === 0) {
    return null;
  }
  return parts.join(' AND ');
}

/** JQL fragment for Agile board/backlog `jql=` (labels + recency only). */
export function buildAgileExtraJql(filter: IssueSyncFilter): string | undefined {
  const parts: string[] = [];
  const labels = labelsInJql(filter.labels ?? []);
  if (labels) {
    parts.push(labels);
  }
  const recency = recencyJql(filter.recency);
  if (recency) {
    parts.push(recency);
  }
  return parts.length > 0 ? parts.join(' AND ') : undefined;
}

export function describeIssueSyncFilter(filter: IssueSyncFilter): string {
  const bits: string[] = [];
  const labels = (filter.labels ?? []).map((label) => String(label).trim()).filter(Boolean);
  if (labels.length > 0) {
    bits.push(`labels in (${labels.join(', ')})`);
  }
  const recency = recencyJql(filter.recency);
  if (recency) {
    bits.push(recency);
  }
  return bits.length > 0 ? bits.join(' AND ') : 'no extra filters';
}
