export type SyncActionKind =
  | 'create-remote'
  | 'create-local'
  | 'push'
  | 'pull'
  | 'conflict-push'
  | 'conflict-pull'
  | 'unchanged'
  | 'unresolved-missing-remote'
  | 'unresolved-missing-local'
  | 'recovered-pending'
  | 'reconcile-labels';

export interface SyncActionDetail {
  kind: SyncActionKind;
  /** Human-readable task title. */
  title: string;
  issueKey?: string | null;
  /** Extra context shown in the report. */
  detail?: string;
}

export function emptyActions(): SyncActionDetail[] {
  return [];
}

export function formatActionLabel(kind: SyncActionKind, dryRun: boolean): string {
  const prefix = dryRun ? 'Would ' : '';
  switch (kind) {
    case 'create-remote':
      return `${prefix}create in Jira`;
    case 'create-local':
      return `${prefix}import into Obsidian`;
    case 'push':
      return `${prefix}update Jira from Obsidian`;
    case 'pull':
      return `${prefix}update Obsidian from Jira`;
    case 'conflict-push':
      return `${prefix}resolve conflict → Obsidian wins (push)`;
    case 'conflict-pull':
      return `${prefix}resolve conflict → Jira wins (pull)`;
    case 'unchanged':
      return 'Unchanged';
    case 'unresolved-missing-remote':
      return 'Unresolved — linked in note, missing in Jira';
    case 'unresolved-missing-local':
      return 'Unresolved — known from ledger, missing in note';
    case 'recovered-pending':
      return `${prefix}relink pending Jira issue`;
    case 'reconcile-labels':
      return `${prefix}align status labels with board column`;
    default: {
      const _exhaustive: never = kind;
      return String(_exhaustive);
    }
  }
}

/** Ordered sections for the user-facing report. */
export const ACTION_REPORT_ORDER: SyncActionKind[] = [
  'create-remote',
  'create-local',
  'push',
  'pull',
  'conflict-push',
  'conflict-pull',
  'recovered-pending',
  'reconcile-labels',
  'unresolved-missing-remote',
  'unresolved-missing-local',
];
