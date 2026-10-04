import { App, FuzzySuggestModal, Notice } from 'obsidian';
import {
  formatBoardOption,
  groupBoardsByProject,
  type BoardProjectGroup,
} from '../jira/board-display';
import type { JiraBoard } from '../jira/types';

/**
 * Step 1: pick a Jira project/space that has at least one Agile board.
 */
export class BoardProjectSuggestModal extends FuzzySuggestModal<BoardProjectGroup> {
  private readonly groups: BoardProjectGroup[];
  private readonly onChoose: (group: BoardProjectGroup) => void;

  constructor(app: App, boards: JiraBoard[], onChoose: (group: BoardProjectGroup) => void) {
    super(app);
    this.groups = groupBoardsByProject(boards);
    this.onChoose = onChoose;
    this.setPlaceholder('Select a Jira project / space…');
  }

  getItems(): BoardProjectGroup[] {
    return this.groups;
  }

  getItemText(group: BoardProjectGroup): string {
    const count = group.boards.length;
    return `${group.label} (${count} board${count === 1 ? '' : 's'})`;
  }

  onChooseItem(group: BoardProjectGroup): void {
    this.onChoose(group);
  }
}

/**
 * Step 2: pick a board within the chosen project/space.
 */
export class BoardSuggestModal extends FuzzySuggestModal<JiraBoard> {
  private readonly boards: JiraBoard[];
  private readonly onChoose: (board: JiraBoard) => void;

  constructor(app: App, boards: JiraBoard[], onChoose: (board: JiraBoard) => void) {
    super(app);
    this.boards = [...boards].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    );
    this.onChoose = onChoose;
    this.setPlaceholder('Select a Jira board…');
  }

  getItems(): JiraBoard[] {
    return this.boards;
  }

  getItemText(board: JiraBoard): string {
    return formatBoardOption(board);
  }

  onChooseItem(board: JiraBoard): void {
    this.onChoose(board);
  }
}

/**
 * Open project → board pickers. If only one project group exists, skip straight to boards.
 */
export function openBoardPicker(
  app: App,
  boards: JiraBoard[],
  onChoose: (board: JiraBoard) => void,
): void {
  if (boards.length === 0) {
    new Notice('Jira Sync: no Agile boards were returned for this account.');
    return;
  }

  const groups = groupBoardsByProject(boards);
  const openBoardStep = (groupBoards: JiraBoard[]) => {
    if (groupBoards.length === 1) {
      const only = groupBoards[0];
      if (only) {
        onChoose(only);
      }
      return;
    }
    new BoardSuggestModal(app, groupBoards, onChoose).open();
  };

  if (groups.length === 1) {
    openBoardStep(groups[0]?.boards ?? []);
    return;
  }

  new BoardProjectSuggestModal(app, boards, (group) => {
    openBoardStep(group.boards);
  }).open();
}
