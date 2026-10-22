/**
 * Obsidian nesting ↔ Jira Blocks links (child blocks parent).
 *
 * Umbrella parents wait on children: the indented child "blocks" the parent,
 * and the parent "is blocked by" the child. Hierarchy `parent` / Sub-task is
 * not used for this nesting.
 */

export interface IssueLinkTypeRef {
  id?: string;
  name?: string;
  inward?: string;
  outward?: string;
}

export interface IssueLinkRef {
  id?: string;
  type?: IssueLinkTypeRef;
  /** On GET issue, only the *other* end is present. */
  inwardIssue?: { key?: string; fields?: { project?: { key?: string }; parent?: { key?: string } } };
  outwardIssue?: { key?: string; fields?: { project?: { key?: string }; parent?: { key?: string } } };
}

/** Context for one issue when resolving Blocks → Obsidian parent. */
export interface BlocksNestingIssueContext {
  key: string;
  projectKey: string;
  /** Hierarchy parent key if the issue is nested under Epic/Story/etc. */
  hierarchyParentKey: string | null;
  /** Keys of other issues in the current sync set (same mapping). */
  syncKeys: ReadonlySet<string>;
}

export function isBlocksLinkType(type: IssueLinkTypeRef | undefined): boolean {
  if (!type) {
    return false;
  }
  const blob = `${type.name ?? ''} ${type.inward ?? ''} ${type.outward ?? ''}`.toLowerCase();
  if (/relat|duplicate|clone|split|mention|parent|child|дочер|родит|hierarchy|иерарх/.test(blob)) {
    // Allow "blocks" even if name is odd; reject clear non-blocks types.
    if (!/block|блокир/.test(blob)) {
      return false;
    }
  }
  return /block|блокир/.test(blob);
}

export function scoreBlocksLinkType(type: IssueLinkTypeRef): number {
  if (!isBlocksLinkType(type)) {
    return 0;
  }
  const name = (type.name ?? '').trim().toLowerCase();
  const outward = (type.outward ?? '').toLowerCase();
  const inward = (type.inward ?? '').toLowerCase();
  let score = 1;
  if (name === 'blocks' || name === 'block') {
    score += 10;
  }
  if (/^blocks$|^block$|блокиру/.test(outward) || outward.includes('blocks')) {
    score += 8;
  }
  if (/blocked by|блокир/.test(inward)) {
    score += 6;
  }
  return score;
}

export function pickBlocksLinkType<T extends IssueLinkTypeRef>(types: readonly T[]): T | null {
  let best: T | null = null;
  let bestScore = 0;
  for (const type of types) {
    const score = scoreBlocksLinkType(type);
    if (score > bestScore) {
      best = type;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : null;
}

/** Outward/inward label means "this end blocks the other" (blocker). */
function labelMeansBlocks(label: string): boolean {
  const value = label.trim().toLowerCase();
  if (!value) {
    return false;
  }
  // Avoid matching "is blocked by" / "блокируется" via a short prefix.
  if (labelMeansIsBlockedBy(value)) {
    return false;
  }
  return (
    value === 'blocks' ||
    value === 'block' ||
    value === 'блокирует' ||
    /^blocks\b/.test(value) ||
    value.startsWith('блокирует')
  );
}

/** Outward/inward label means "this end is blocked by the other". */
function labelMeansIsBlockedBy(label: string): boolean {
  const value = label.trim().toLowerCase();
  if (!value) {
    return false;
  }
  return (
    value.includes('blocked by') ||
    value.includes('блокируется') ||
    value.includes('блокирована') ||
    value.includes('блокирован')
  );
}

/**
 * For standard Blocks, outward = "blocks", inward = "is blocked by".
 * Child (blocker) is the outward issue; parent (blocked) is the inward issue.
 */
export function blockerIsOutwardIssue(type: IssueLinkTypeRef): boolean {
  const outward = type.outward ?? '';
  const inward = type.inward ?? '';
  if (labelMeansBlocks(outward)) {
    return true;
  }
  if (labelMeansIsBlockedBy(outward) || labelMeansBlocks(inward)) {
    // Outward is the blocked end (or inward is the blocker) → blocker is inward.
    return false;
  }
  // Default Jira Blocks: outward blocks, inward is blocked by.
  return true;
}

/**
 * Place the child on the link end whose label means "blocks", and the parent
 * on the end whose label means "is blocked by".
 *
 * Standard Cloud: outward="blocks", inward="is blocked by"
 *   → outwardIssue=child, inwardIssue=parent
 * Some sites swap those strings; blockerIsOutwardIssue handles that.
 *
 * On GET issue, the other end appears as `outwardIssue` when the current issue
 * is the outward end, and as `inwardIssue` when it is the inward end.
 */
export function buildBlocksLinkBody(
  type: IssueLinkTypeRef,
  childKey: string,
  parentKey: string,
): {
  type: { id: string } | { name: string };
  inwardIssue: { key: string };
  outwardIssue: { key: string };
} {
  const typeRef = type.id?.trim()
    ? { id: type.id.trim() }
    : { name: String(type.name ?? 'Blocks').trim() };
  if (blockerIsOutwardIssue(type)) {
    return {
      type: typeRef,
      outwardIssue: { key: childKey },
      inwardIssue: { key: parentKey },
    };
  }
  return {
    type: typeRef,
    outwardIssue: { key: parentKey },
    inwardIssue: { key: childKey },
  };
}

/**
 * True when `selfKey`'s Blocks link to `otherKey` means self **blocks** other
 * (correct nesting: child blocks parent).
 */
export function selfBlocksOther(
  links: readonly IssueLinkRef[] | undefined,
  selfKey: string,
  otherKey: string,
): boolean {
  if (!links?.length) {
    return false;
  }
  const self = selfKey.trim().toUpperCase();
  const other = otherKey.trim().toUpperCase();
  for (const link of links) {
    if (!isBlocksLinkType(link.type)) {
      continue;
    }
    const type = link.type!;
    const inward = link.inwardIssue?.key?.trim().toUpperCase() ?? null;
    const outward = link.outwardIssue?.key?.trim().toUpperCase() ?? null;
    if (blockerIsOutwardIssue(type)) {
      if (outward === other) {
        return true;
      }
    } else if (inward === other) {
      return true;
    }
  }
  return false;
}

/**
 * On the child (blocker) issue, find the Blocks link id toward `parentKey`.
 */
export function findBlocksLinkIdBetween(
  links: readonly IssueLinkRef[] | undefined,
  selfKey: string,
  otherKey: string,
): string | null {
  if (!links?.length) {
    return null;
  }
  const self = selfKey.trim().toUpperCase();
  const other = otherKey.trim().toUpperCase();
  for (const link of links) {
    if (!isBlocksLinkType(link.type) || !link.id) {
      continue;
    }
    const inward = link.inwardIssue?.key?.trim().toUpperCase() ?? null;
    const outward = link.outwardIssue?.key?.trim().toUpperCase() ?? null;
    const otherEnd = inward && inward !== self ? inward : outward && outward !== self ? outward : null;
    if (otherEnd === other) {
      return String(link.id);
    }
  }
  return null;
}

export interface ParentFromBlocksResult {
  parentIssueKey: string | null;
  /** True when A blocks B and B blocks A for an eligible pair. */
  cycleDetected: boolean;
  cycleWithKey?: string;
}

/**
 * Resolve Obsidian parent for `self` from Blocks links on that issue.
 *
 * Heuristics (self = blocker / child candidate):
 * - Only Blocks links where self blocks other (self is blocker).
 * - Other must be in sync set and same projectKey as mapping.
 * - Self must have no hierarchy parent (fields.parent).
 * - Multiple parents → lexicographically smallest key.
 */
export function parentKeyFromBlocksLinks(
  links: readonly IssueLinkRef[] | undefined,
  self: BlocksNestingIssueContext,
  mappingProjectKey: string,
  /** Map of key → whether that issue is blocked by self (for cycle check we need reverse). */
  blockedBySelfParents?: ReadonlyMap<string, readonly string[]>,
): ParentFromBlocksResult {
  const project = mappingProjectKey.trim().toUpperCase();
  const selfKey = self.key.trim().toUpperCase();
  if (!project || self.hierarchyParentKey) {
    return { parentIssueKey: null, cycleDetected: false };
  }
  if (self.projectKey.trim().toUpperCase() !== project) {
    return { parentIssueKey: null, cycleDetected: false };
  }

  const candidates: string[] = [];
  for (const link of links ?? []) {
    if (!isBlocksLinkType(link.type)) {
      continue;
    }
    const type = link.type!;
    const inward = link.inwardIssue?.key?.trim().toUpperCase() ?? null;
    const outward = link.outwardIssue?.key?.trim().toUpperCase() ?? null;

    // Self is blocker only when the field present matches the "blocks" end:
    // - outward end + outwardIssue → self blocks that issue
    // - inward end + inwardIssue → self blocks that issue (swapped label config)
    let blockedKey: string | null = null;
    if (blockerIsOutwardIssue(type)) {
      if (outward && outward !== selfKey) {
        blockedKey = outward;
      }
    } else if (inward && inward !== selfKey) {
      blockedKey = inward;
    }
    if (!blockedKey) {
      continue;
    }
    if (!self.syncKeys.has(blockedKey)) {
      continue;
    }
    candidates.push(blockedKey);
  }

  if (candidates.length === 0) {
    return { parentIssueKey: null, cycleDetected: false };
  }

  candidates.sort((a, b) => a.localeCompare(b));
  const parentKey = candidates[0]!;

  // Cycle: parent also lists self as its Obsidian parent via blocks.
  if (blockedBySelfParents?.get(parentKey)?.includes(selfKey)) {
    return {
      parentIssueKey: null,
      cycleDetected: true,
      cycleWithKey: parentKey,
    };
  }

  return { parentIssueKey: parentKey, cycleDetected: false };
}

/**
 * Build parentIssueKey for every issue in a sync set from raw Jira issues.
 * Pass hierarchy parent and project from each issue; apply heuristics + cycle skip.
 */
export function resolveBlocksParentsForSyncSet(
  issues: ReadonlyArray<{
    key: string;
    projectKey: string;
    hierarchyParentKey: string | null;
    issuelinks?: readonly IssueLinkRef[];
  }>,
  mappingProjectKey: string,
): {
  parents: Map<string, string | null>;
  cycleErrors: string[];
} {
  const project = mappingProjectKey.trim().toUpperCase();
  const syncKeys = new Set(
    issues.map((issue) => issue.key.trim().toUpperCase()).filter(Boolean),
  );

  // First pass: raw candidates (no cycle check).
  const rawParents = new Map<string, string | null>();
  for (const issue of issues) {
    const key = issue.key.trim().toUpperCase();
    const result = parentKeyFromBlocksLinks(
      issue.issuelinks,
      {
        key,
        projectKey: issue.projectKey,
        hierarchyParentKey: issue.hierarchyParentKey,
        syncKeys,
      },
      project,
    );
    rawParents.set(key, result.parentIssueKey);
  }

  // Cycle: A→B and B→A in raw map.
  const parents = new Map<string, string | null>();
  const cycleErrors: string[] = [];
  const reported = new Set<string>();
  for (const [key, parent] of rawParents) {
    if (!parent) {
      parents.set(key, null);
      continue;
    }
    if (rawParents.get(parent) === key) {
      parents.set(key, null);
      const pair = [key, parent].sort().join('|');
      if (!reported.has(pair)) {
        reported.add(pair);
        cycleErrors.push(
          `Blocks cycle between ${key} and ${parent}; neither nested in Obsidian`,
        );
      }
      continue;
    }
    // Parent must be same project (already enforced) and in sync set.
    const parentIssue = issues.find((row) => row.key.trim().toUpperCase() === parent);
    if (!parentIssue || parentIssue.projectKey.trim().toUpperCase() !== project) {
      parents.set(key, null);
      continue;
    }
    parents.set(key, parent);
  }

  return { parents, cycleErrors };
}
