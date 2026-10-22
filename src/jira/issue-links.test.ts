import { describe, expect, it } from 'vitest';
import {
  buildBlocksLinkBody,
  findBlocksLinkIdBetween,
  isBlocksLinkType,
  parentKeyFromBlocksLinks,
  pickBlocksLinkType,
  resolveBlocksParentsForSyncSet,
} from './issue-links';

const BLOCKS = {
  id: '10000',
  name: 'Blocks',
  inward: 'is blocked by',
  outward: 'blocks',
};

/** Some Jira sites swap the inward/outward description strings. */
const BLOCKS_SWAPPED = {
  id: '10001',
  name: 'Blocks',
  inward: 'blocks',
  outward: 'is blocked by',
};

describe('issue-links Blocks helpers', () => {
  it('picks Blocks over Relates', () => {
    const picked = pickBlocksLinkType([
      { id: '1', name: 'Relates', inward: 'relates to', outward: 'relates to' },
      BLOCKS,
      { id: '3', name: 'Duplicate', inward: 'is duplicated by', outward: 'duplicates' },
    ]);
    expect(picked?.id).toBe('10000');
    expect(isBlocksLinkType(BLOCKS)).toBe(true);
    expect(isBlocksLinkType({ name: 'Relates', inward: 'relates to', outward: 'relates to' })).toBe(
      false,
    );
  });

  it('builds body with child as outward blocker (standard Blocks labels)', () => {
    expect(buildBlocksLinkBody(BLOCKS, 'PROJ-2', 'PROJ-1')).toEqual({
      type: { id: '10000' },
      outwardIssue: { key: 'PROJ-2' },
      inwardIssue: { key: 'PROJ-1' },
    });
  });

  it('builds body with child as inward blocker when labels are swapped', () => {
    expect(buildBlocksLinkBody(BLOCKS_SWAPPED, 'PROJ-2', 'PROJ-1')).toEqual({
      type: { id: '10001' },
      outwardIssue: { key: 'PROJ-1' },
      inwardIssue: { key: 'PROJ-2' },
    });
  });

  it('does not treat «блокируется» as the blocker direction', () => {
    const reversed = {
      id: '8',
      name: 'Blocks',
      inward: 'блокирует',
      outward: 'блокируется',
    };
    expect(buildBlocksLinkBody(reversed, 'PROJ-2', 'PROJ-1')).toEqual({
      type: { id: '8' },
      outwardIssue: { key: 'PROJ-1' },
      inwardIssue: { key: 'PROJ-2' },
    });
  });

  it('finds link id between child and parent on the child issue', () => {
    const id = findBlocksLinkIdBetween(
      [
        {
          id: '55',
          type: BLOCKS,
          outwardIssue: { key: 'PROJ-1' },
        },
      ],
      'PROJ-2',
      'PROJ-1',
    );
    expect(id).toBe('55');
  });

  it('nests when child GET shows outwardIssue parent (standard blocker end)', () => {
    const result = parentKeyFromBlocksLinks(
      [{ type: BLOCKS, outwardIssue: { key: 'PROJ-10' } }],
      {
        key: 'PROJ-11',
        projectKey: 'PROJ',
        hierarchyParentKey: null,
        syncKeys: new Set(['PROJ-10', 'PROJ-11']),
      },
      'PROJ',
    );
    expect(result).toEqual({ parentIssueKey: 'PROJ-10', cycleDetected: false });
  });

  it('nests when child GET shows inwardIssue parent (swapped labels)', () => {
    const result = parentKeyFromBlocksLinks(
      [{ type: BLOCKS_SWAPPED, inwardIssue: { key: 'PROJ-10' } }],
      {
        key: 'PROJ-11',
        projectKey: 'PROJ',
        hierarchyParentKey: null,
        syncKeys: new Set(['PROJ-10', 'PROJ-11']),
      },
      'PROJ',
    );
    expect(result.parentIssueKey).toBe('PROJ-10');
  });

  it('does not nest when blocker already has hierarchy parent', () => {
    const result = parentKeyFromBlocksLinks(
      [{ type: BLOCKS, outwardIssue: { key: 'PROJ-10' } }],
      {
        key: 'PROJ-11',
        projectKey: 'PROJ',
        hierarchyParentKey: 'PROJ-1',
        syncKeys: new Set(['PROJ-10', 'PROJ-11']),
      },
      'PROJ',
    );
    expect(result.parentIssueKey).toBeNull();
  });

  it('ignores blocks targeting issues outside the sync set', () => {
    const result = parentKeyFromBlocksLinks(
      [{ type: BLOCKS, outwardIssue: { key: 'OTHER-1' } }],
      {
        key: 'PROJ-11',
        projectKey: 'PROJ',
        hierarchyParentKey: null,
        syncKeys: new Set(['PROJ-11']),
      },
      'PROJ',
    );
    expect(result.parentIssueKey).toBeNull();
  });

  it('picks lexicographically smallest parent when multiple', () => {
    const result = parentKeyFromBlocksLinks(
      [
        { type: BLOCKS, outwardIssue: { key: 'PROJ-20' } },
        { type: BLOCKS, outwardIssue: { key: 'PROJ-10' } },
      ],
      {
        key: 'PROJ-11',
        projectKey: 'PROJ',
        hierarchyParentKey: null,
        syncKeys: new Set(['PROJ-10', 'PROJ-11', 'PROJ-20']),
      },
      'PROJ',
    );
    expect(result.parentIssueKey).toBe('PROJ-10');
  });

  it('detects cycles in a sync set', () => {
    const { parents, cycleErrors } = resolveBlocksParentsForSyncSet(
      [
        {
          key: 'PROJ-1',
          projectKey: 'PROJ',
          hierarchyParentKey: null,
          issuelinks: [{ type: BLOCKS, outwardIssue: { key: 'PROJ-2' } }],
        },
        {
          key: 'PROJ-2',
          projectKey: 'PROJ',
          hierarchyParentKey: null,
          issuelinks: [{ type: BLOCKS, outwardIssue: { key: 'PROJ-1' } }],
        },
      ],
      'PROJ',
    );
    expect(parents.get('PROJ-1')).toBeNull();
    expect(parents.get('PROJ-2')).toBeNull();
    expect(cycleErrors.length).toBe(1);
    expect(cycleErrors[0]).toContain('PROJ-1');
    expect(cycleErrors[0]).toContain('PROJ-2');
  });

  it('matches Russian Blocks wording (блокирует = outward blocker)', () => {
    const ru = {
      id: '9',
      name: 'Блокировка',
      inward: 'блокируется',
      outward: 'блокирует',
    };
    expect(pickBlocksLinkType([ru])?.id).toBe('9');
    expect(buildBlocksLinkBody(ru, 'OPS-2', 'OPS-1')).toEqual({
      type: { id: '9' },
      outwardIssue: { key: 'OPS-2' },
      inwardIssue: { key: 'OPS-1' },
    });
    expect(
      parentKeyFromBlocksLinks(
        [{ type: ru, outwardIssue: { key: 'OPS-1' } }],
        {
          key: 'OPS-2',
          projectKey: 'OPS',
          hierarchyParentKey: null,
          syncKeys: new Set(['OPS-1', 'OPS-2']),
        },
        'OPS',
      ).parentIssueKey,
    ).toBe('OPS-1');
  });
});
