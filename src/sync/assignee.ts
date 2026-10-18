import type { JiraAssigneeRef } from '../jira/types';
import { normalizeAssigneeValue } from '../note/assignee';

/** One Jira user (seen on a board) mapped to a Dataview `[assignee:: …]` value. */
export interface AssigneeMapping {
  /**
   * Stable Jira identity: Cloud `accountId`, or Server/DC `name` / `key`.
   * Used when writing `assignee` back to Jira.
   */
  jiraAccountId: string;
  /** Display label in settings / dropdowns. */
  jiraDisplayName: string;
  /** Optional Server/DC username (sent as `{ name }` when accountId looks like a username). */
  jiraName?: string;
  /** Obsidian Dataview value, e.g. `Аряпов` for `[assignee:: Аряпов]`. */
  obsidianValue: string;
}

/** Cached assignee option loaded from board issues for the settings dropdown. */
export interface KnownJiraAssignee {
  accountId: string;
  displayName: string;
  name?: string;
}

/** Trim fields in place; keeps incomplete draft rows for the settings UI. */
export function prepareAssigneeMappingsForSave(mappings: AssigneeMapping[]): void {
  for (const mapping of mappings) {
    mapping.jiraAccountId = String(mapping.jiraAccountId ?? '').trim();
    mapping.jiraDisplayName = String(mapping.jiraDisplayName ?? '').trim();
    mapping.obsidianValue = String(mapping.obsidianValue ?? '').trim();
    const name = String(mapping.jiraName ?? '').trim();
    mapping.jiraName = name || undefined;
  }
}

/** Complete mappings only (both Jira id and Obsidian value). Used by sync. */
export function normalizeAssigneeMappings(
  mappings: readonly AssigneeMapping[] | null | undefined,
): AssigneeMapping[] {
  if (!mappings?.length) {
    return [];
  }
  const byId = new Map<string, AssigneeMapping>();
  for (const raw of mappings) {
    const jiraAccountId = String(raw?.jiraAccountId ?? '').trim();
    const obsidianValue = normalizeAssigneeValue(raw?.obsidianValue) ?? '';
    if (!jiraAccountId || !obsidianValue) {
      continue;
    }
    const jiraDisplayName =
      String(raw?.jiraDisplayName ?? '').trim() || jiraAccountId;
    const jiraName = String(raw?.jiraName ?? '').trim() || undefined;
    byId.set(jiraAccountId.toLowerCase(), {
      jiraAccountId,
      jiraDisplayName,
      jiraName,
      obsidianValue,
    });
  }
  return [...byId.values()].sort((a, b) =>
    a.jiraDisplayName.localeCompare(b.jiraDisplayName, undefined, {
      sensitivity: 'base',
    }),
  );
}

export function jiraAssigneeIdentity(user: JiraAssigneeRef | null | undefined): string | null {
  if (!user) {
    return null;
  }
  const accountId = String(user.accountId ?? '').trim();
  if (accountId) {
    return accountId;
  }
  const name = String(user.name ?? '').trim();
  if (name) {
    return name;
  }
  const key = String(user.key ?? '').trim();
  return key || null;
}

export function jiraAssigneeDisplayName(user: JiraAssigneeRef | null | undefined): string {
  if (!user) {
    return '';
  }
  const display = String(user.displayName ?? '').trim();
  if (display) {
    return display;
  }
  return jiraAssigneeIdentity(user) ?? '';
}

export function findMappingByJiraId(
  mappings: readonly AssigneeMapping[],
  jiraAccountId: string | null | undefined,
): AssigneeMapping | null {
  const id = String(jiraAccountId ?? '').trim().toLowerCase();
  if (!id) {
    return null;
  }
  return (
    mappings.find((mapping) => mapping.jiraAccountId.toLowerCase() === id) ?? null
  );
}

export function findMappingByObsidianValue(
  mappings: readonly AssigneeMapping[],
  obsidianValue: string | null | undefined,
): AssigneeMapping | null {
  const value = normalizeAssigneeValue(obsidianValue);
  if (!value) {
    return null;
  }
  const wanted = value.toLowerCase();
  return (
    mappings.find((mapping) => mapping.obsidianValue.toLowerCase() === wanted) ?? null
  );
}

/**
 * Build the Jira `assignee` field payload for update/create.
 * Cloud prefers `{ accountId }`; Server/DC often needs `{ name }`.
 */
export function toJiraAssigneePayload(
  mapping: AssigneeMapping,
): { accountId: string } | { name: string } {
  const name = mapping.jiraName?.trim();
  if (name) {
    return { name };
  }
  // Heuristic: Cloud accountIds are long opaque strings; short ids are often usernames.
  if (mapping.jiraAccountId.includes(':') || mapping.jiraAccountId.length > 20) {
    return { accountId: mapping.jiraAccountId };
  }
  return { name: mapping.jiraAccountId };
}

export type AssigneeReconcileDecision =
  | { action: 'none' }
  | { action: 'set-local'; obsidianValue: string; detail: string }
  | { action: 'set-remote'; mapping: AssigneeMapping; detail: string };

/**
 * Decide assignee sync for an open task (caller must skip when both sides are done).
 *
 * - Obsidian empty, Jira mapped → set Obsidian
 * - Obsidian set (mapped), Jira empty → set Jira
 * - Both set and differ → Obsidian wins (set Jira when local value is mapped)
 * - Unmapped side → no-op for that direction
 */
export function decideAssigneeReconcile(input: {
  localAssignee: string | null | undefined;
  remoteAssigneeId: string | null | undefined;
  mappings: readonly AssigneeMapping[];
}): AssigneeReconcileDecision {
  const mappings = normalizeAssigneeMappings(input.mappings);
  if (mappings.length === 0) {
    return { action: 'none' };
  }

  const localValue = normalizeAssigneeValue(input.localAssignee);
  const remoteMapping = findMappingByJiraId(mappings, input.remoteAssigneeId);
  const localMapping = findMappingByObsidianValue(mappings, localValue);

  if (!localValue && remoteMapping) {
    return {
      action: 'set-local',
      obsidianValue: remoteMapping.obsidianValue,
      detail: `set [assignee:: ${remoteMapping.obsidianValue}] from Jira (${remoteMapping.jiraDisplayName})`,
    };
  }

  if (localValue && !input.remoteAssigneeId) {
    if (!localMapping) {
      return { action: 'none' };
    }
    return {
      action: 'set-remote',
      mapping: localMapping,
      detail: `set Jira assignee to ${localMapping.jiraDisplayName} from [assignee:: ${localValue}]`,
    };
  }

  if (localValue && input.remoteAssigneeId) {
    const remoteObsidian = remoteMapping?.obsidianValue ?? null;
    const same =
      remoteObsidian !== null &&
      remoteObsidian.toLowerCase() === localValue.toLowerCase();
    if (same) {
      return { action: 'none' };
    }
    // Differ — Obsidian wins when the local value is mapped.
    if (!localMapping) {
      return { action: 'none' };
    }
    return {
      action: 'set-remote',
      mapping: localMapping,
      detail: `Obsidian wins: set Jira assignee to ${localMapping.jiraDisplayName} from [assignee:: ${localValue}]`,
    };
  }

  return { action: 'none' };
}

export function collectAssigneesFromIssues(
  issues: ReadonlyArray<{ fields?: { assignee?: JiraAssigneeRef | null } }>,
): KnownJiraAssignee[] {
  const byId = new Map<string, KnownJiraAssignee>();
  for (const issue of issues) {
    const user = issue.fields?.assignee;
    const accountId = jiraAssigneeIdentity(user);
    if (!accountId || !user) {
      continue;
    }
    const key = accountId.toLowerCase();
    if (byId.has(key)) {
      continue;
    }
    byId.set(key, {
      accountId,
      displayName: jiraAssigneeDisplayName(user),
      name: String(user.name ?? '').trim() || undefined,
    });
  }
  return [...byId.values()].sort((a, b) =>
    a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' }),
  );
}
