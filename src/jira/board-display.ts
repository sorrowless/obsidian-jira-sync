import type { JiraBoard } from './types';

export interface BoardProjectGroup {
  /** Stable key for grouping (`PROJ`, or `__other__` when location is missing). */
  key: string;
  /** Human label shown in the project picker. */
  label: string;
  boards: JiraBoard[];
}

/** Project key / name from board location, with fallbacks for orphan boards. */
export function boardProjectKey(board: JiraBoard): string {
  const key = board.location?.projectKey?.trim();
  if (key) {
    return key.toUpperCase();
  }
  return '__other__';
}

export function boardProjectLabel(board: JiraBoard): string {
  const key = board.location?.projectKey?.trim();
  const name =
    board.location?.projectName?.trim() ||
    board.location?.displayName?.trim() ||
    '';
  if (key && name && name.toLowerCase() !== key.toLowerCase()) {
    return `${key.toUpperCase()} — ${name}`;
  }
  if (key) {
    return key.toUpperCase();
  }
  if (name) {
    return name;
  }
  return 'Other (no project)';
}

/** One-line label for a board in pickers and settings. */
export function formatBoardOption(board: JiraBoard): string {
  const project = board.location?.projectKey?.trim().toUpperCase();
  const type = board.type ? ` · ${board.type}` : '';
  if (project) {
    return `${project} / ${board.name} (#${board.id}${type})`;
  }
  return `${board.name} (#${board.id}${type})`;
}

/** Short label stored/shown after a board is chosen. */
export function formatBoardSummary(board: JiraBoard): string {
  const project = board.location?.projectKey?.trim().toUpperCase();
  if (project) {
    return `${project} / ${board.name}`;
  }
  return board.name;
}

/** Group boards by project for the two-step picker. */
export function groupBoardsByProject(boards: readonly JiraBoard[]): BoardProjectGroup[] {
  const map = new Map<string, BoardProjectGroup>();
  for (const board of boards) {
    const key = boardProjectKey(board);
    let group = map.get(key);
    if (!group) {
      group = { key, label: boardProjectLabel(board), boards: [] };
      map.set(key, group);
    }
    group.boards.push(board);
  }
  for (const group of map.values()) {
    group.boards.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }
  return [...map.values()].sort((a, b) => {
    if (a.key === '__other__') {
      return 1;
    }
    if (b.key === '__other__') {
      return -1;
    }
    return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
  });
}
