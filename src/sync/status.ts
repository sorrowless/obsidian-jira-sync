/**
 * Obsidian ↔ Jira coarse status via board columns and status labels.
 *
 * Coarse checkbox:
 *   `[ ]` ↔ todo
 *   `[/]` ↔ in_progress family (any non-todo/done column, e.g. Review)
 *   `[x]` ↔ done family
 */

export type TaskStatus = 'todo' | 'in_progress' | 'done';

export function isTaskStatus(value: unknown): value is TaskStatus {
  return value === 'todo' || value === 'in_progress' || value === 'done';
}

/** Map an Obsidian checkbox character to a synced status. */
export function statusFromCheckbox(checkboxChar: string): TaskStatus | null {
  if (checkboxChar === ' ') {
    return 'todo';
  }
  if (checkboxChar === 'x' || checkboxChar === 'X') {
    return 'done';
  }
  if (checkboxChar === '/') {
    return 'in_progress';
  }
  return null;
}

/** Checkbox character written back into Obsidian for a status. */
export function checkboxFromStatus(status: TaskStatus): string {
  switch (status) {
    case 'todo':
      return ' ';
    case 'in_progress':
      return '/';
    case 'done':
      return 'x';
    default: {
      const _exhaustive: never = status;
      return String(_exhaustive);
    }
  }
}

export function doneFlagFromStatus(status: TaskStatus): boolean {
  return status === 'done';
}

export function statusFromDoneFlag(done: boolean): TaskStatus {
  return done ? 'done' : 'todo';
}

/** Status label title from a board column name: lower-case, spaces → hyphens. */
export function statusLabelFromColumnName(columnName: string): string {
  return columnName
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

const TODO_NAMES = new Set(['to do', 'todo', 'to-do']);
const DONE_NAMES = new Set([
  'done',
  'trashed',
  'canceled',
  'cancelled',
  'closed',
  'resolved',
]);

/**
 * Derive coarse TaskStatus from a Jira status name and optional category key
 * (`new` | `indeterminate` | `done` | …).
 */
export function statusFromJiraStatus(
  statusName: string,
  categoryKey?: string | null,
): TaskStatus {
  const name = statusName.trim().toLowerCase();
  const category = (categoryKey ?? '').trim().toLowerCase();

  if (DONE_NAMES.has(name) || category === 'done') {
    return 'done';
  }
  if (TODO_NAMES.has(name) || category === 'new') {
    return 'todo';
  }
  return 'in_progress';
}

export interface BoardColumnView {
  name: string;
  statusIds: string[];
}

/**
 * Resolve which board column an issue status belongs to.
 */
export function columnForStatusId(
  columns: ReadonlyArray<BoardColumnView>,
  statusId: string,
): BoardColumnView | null {
  for (const column of columns) {
    if (column.statusIds.includes(statusId)) {
      return column;
    }
  }
  return null;
}

/**
 * Pick a target column for a coarse Obsidian status when creating/transitioning.
 * Review (etc.) is never chosen from Obsidian — only To Do / In Progress / Done.
 */
export function pickColumnForCoarseStatus(
  columns: ReadonlyArray<BoardColumnView>,
  status: TaskStatus,
  statusMeta?: ReadonlyMap<string, { name: string; categoryKey?: string }>,
): BoardColumnView | null {
  if (columns.length === 0) {
    return null;
  }

  const scored = columns.map((column) => {
    const columnStatus = inferColumnCoarseStatus(column, statusMeta);
    return { column, columnStatus };
  });

  if (status === 'todo') {
    return (
      scored.find((item) => TODO_NAMES.has(item.column.name.trim().toLowerCase()))?.column ??
      scored.find((item) => item.columnStatus === 'todo')?.column ??
      columns[0] ??
      null
    );
  }

  if (status === 'done') {
    return (
      scored.find((item) => DONE_NAMES.has(item.column.name.trim().toLowerCase()))?.column ??
      scored.find((item) => item.columnStatus === 'done')?.column ??
      columns[columns.length - 1] ??
      null
    );
  }

  // in_progress → prefer exact "In Progress", else first non-todo/done column
  return (
    scored.find((item) => item.column.name.trim().toLowerCase() === 'in progress')?.column ??
    scored.find((item) => item.columnStatus === 'in_progress')?.column ??
    scored.find((item) => item.columnStatus !== 'todo' && item.columnStatus !== 'done')
      ?.column ??
    columns[0] ??
    null
  );
}

function inferColumnCoarseStatus(
  column: BoardColumnView,
  statusMeta?: ReadonlyMap<string, { name: string; categoryKey?: string }>,
): TaskStatus {
  if (TODO_NAMES.has(column.name.trim().toLowerCase())) {
    return 'todo';
  }
  if (DONE_NAMES.has(column.name.trim().toLowerCase())) {
    return 'done';
  }
  if (statusMeta) {
    for (const statusId of column.statusIds) {
      const meta = statusMeta.get(statusId);
      if (!meta) {
        continue;
      }
      return statusFromJiraStatus(meta.name, meta.categoryKey);
    }
  }
  return statusFromJiraStatus(column.name);
}

/** Set of status-label titles belonging to this board's columns. */
export function boardStatusLabelSet(columns: ReadonlyArray<BoardColumnView>): Set<string> {
  return new Set(
    columns
      .map((column) => statusLabelFromColumnName(column.name))
      .filter((label) => label.length > 0),
  );
}
