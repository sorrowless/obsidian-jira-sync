import { describe, expect, it } from 'vitest';
import {
  boardProjectKey,
  formatBoardOption,
  formatBoardSummary,
  groupBoardsByProject,
} from './board-display';
import type { JiraBoard } from './types';

function board(
  id: number,
  name: string,
  location?: JiraBoard['location'],
  type = 'scrum',
): JiraBoard {
  return { id, name, type, location };
}

describe('board display helpers', () => {
  it('formats board options with project and id', () => {
    expect(
      formatBoardOption(
        board(12, 'Team board', { projectKey: 'ops', projectName: 'Operations' }),
      ),
    ).toBe('OPS / Team board (#12 · scrum)');
    expect(formatBoardSummary(board(12, 'Team board', { projectKey: 'OPS' }))).toBe(
      'OPS / Team board',
    );
  });

  it('groups boards by project and sorts groups', () => {
    const groups = groupBoardsByProject([
      board(2, 'Beta', { projectKey: 'BBB', projectName: 'Beta Proj' }),
      board(1, 'Alpha', { projectKey: 'AAA', projectName: 'Alpha Proj' }),
      board(3, 'Orphan'),
      board(4, 'Alpha 2', { projectKey: 'AAA', projectName: 'Alpha Proj' }),
    ]);
    expect(groups.map((group) => group.key)).toEqual(['AAA', 'BBB', '__other__']);
    expect(groups[0]?.boards.map((item) => item.name)).toEqual(['Alpha', 'Alpha 2']);
    expect(boardProjectKey(board(3, 'Orphan'))).toBe('__other__');
  });
});
