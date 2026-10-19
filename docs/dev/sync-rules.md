# Sync Rules

Behavioral contract for bidirectional sync. The plugin implementation must follow these rules.

## Scope (v1)

Synced fields:

- Title (Jira `summary`)
- Description (plain text ↔ indented bullets)
- Coarse workflow status via checkbox + board column + status labels
- Parent / child nesting (Jira sub-tasks)
- Jira browse URL in the Obsidian task line
- Start date (`🛫` ↔ configured custom field)
- Due date (`📅` ← Actual end or Target end; → Target end only)
- Start date (`🛫` ↔ Start field; may be derived from Actual end − time tracking)

Not synced in v1:

- Priority, assignees, components (non-filter labels are not edited except to preserve them)
- Automatic deletion
- Arbitrary column creation from Obsidian beyond To Do / In Progress / Done

## Mapping label filters

Each note↔board mapping may list zero or more Jira **labels** (project tags):

1. Empty list → every issue on the board is in scope (subject to recency below).
2. Non-empty list → an issue is in scope if it has **any** of the listed labels (OR, case-insensitive).
3. New issues created from Obsidian for a filtered mapping receive those filter labels (plus the status label).
4. On sync, missing filter labels are re-applied so issues stay in the mapping’s scope.
5. Status labels derived from board columns are separate and still follow the column-wins rules below.

## Mapping recency filters

Each mapping may also set an optional **recency** window (`recencyValue` / `recencyUnit` / `recencyField`):

1. `recencyValue` ≤ 0 → no recency clause (Jira search still typically caps around 1000 issues).
2. Positive N with unit days/months → JQL `updated|created >= -Nd` / `-NM`.
3. Combined with labels using AND when both are set.
4. Recency is applied server-side in search / Agile `jql=` and is **not** part of the ledger `mappingKey`.

## Task identity

A task is linked when its Obsidian line contains a Markdown link (at the start of the checklist body) whose URL matches:

```text
{jiraBaseUrl}/browse/{ISSUE-KEY}
```

Issue keys are case-insensitive letters/digits with a hyphen (e.g. `PROJ-123`). Trailing slashes and query fragments are ignored. The link text is the Obsidian title. Optional start/due markers after the link do **not** break identity.

Unlinked checklist items are candidates for create-in-Jira.

## Canonical Markdown

After any successful sync write, a synced task block looks like:

```markdown
- [ ] [Task title](https://jira.example/browse/PROJ-123) 🛫 2026-10-02 📅 2026-10-05
    - description line one
    - description line two
    - [ ] [Child title](https://jira.example/browse/PROJ-124)
        - child description
```

Rules:

1. The primary line is a checklist item whose body starts with a link `[title](url)`, optionally followed by start/due date markers.
2. Start (`🛫`) and due (`📅`) times are written after the link; they are not part of the link text.
3. Description is represented as indented bullets **without** checkboxes.
4. Child tasks are indented checklist items (with checkboxes).
5. On rewrite, description lines come first, then child tasks.
6. Existing list marker (`-`, `*`, or numbered) and indent style are preserved for an existing block.
7. Newly created blocks use `-` and four spaces per indent level.
8. New Obsidian tasks created from Jira are appended at the end of the mapped note (or under the parent block when present).

## Dates

| Marker | Meaning | Jira field |
| --- | --- | --- |
| `🛫` | Start | `startDateFieldId` when set; else derived as Actual end − time spent when both exist (then written into Start) |
| `📅` | Due | Actual end (`actualEndFieldId`) if set, else Target end (`targetEndFieldId`, default `duedate`). Obsidian → Target end only |
| `[assignee:: value]` | Assignee | Dataview field ↔ Jira `assignee` via `assigneeMappings` |
| `[timespent:: seconds]` | Time spent | Pull-only from `timeSpentFieldId` (default `timetracking.timeSpentSeconds`) |

Accepted note values: `YYYY-MM-DD` or `YYYY-MM-DD HH:mm` (local time). Due/target writes to Jira use the date portion only. Date-only Actual end is treated as end of that local day before subtracting time spent.

### Assignee sync

1. Only complete mappings (Jira id + Obsidian value) participate.
2. Skip when both local and remote status are `done`.
3. Empty local + mapped remote → write Dataview field in the note.
4. Mapped local + empty remote → set Jira assignee.
5. Both set and differ → Obsidian wins (update Jira when local value is mapped).
6. Unmapped identities → no-op for that direction.

### Time spent sync

1. Source field from settings (`timeSpentFieldId`, default `timetracking`).
2. Skip when both local and remote status are `done`.
3. If Jira has time spent and Obsidian is empty or differs → set `[timespent:: N]` in the note.
4. Never push Obsidian → Jira (worklog limitation).

## Done / workflow status

### Coarse Obsidian checkbox

| Obsidian | Meaning |
| --- | --- |
| `[ ]` | To Do |
| `[/]` | In progress family (any non-todo/done column) |
| `[x]` or `[X]` | Done family |

Mapping from Jira status / column name (case-insensitive):

- To Do / Todo, or status category `new` → `[ ]`
- Done, Trashed, Canceled / Cancelled, or status category `done` → `[x]`
- Everything else (In Progress, Review, …) → `[/]`

Other Obsidian checkbox characters (for example `[-]`) are not mapped.

### Column wins over status labels

Board columns define the set of **status labels**. A status label title is the column name lowercased with spaces replaced by hyphens (`In Progress` → `in-progress`, `Review` → `review`).

On every sync for a linked issue:

1. Determine the issue’s current board column from its workflow status.
2. Compute the desired status label from that column name.
3. Among labels that belong to the board’s status-label set, remove any that are not the desired one and ensure the desired label is present.
4. Never remove non-status labels (e.g. `bug`, `backend`).

Example: issue is in column **Review** but still has label `in-progress` → remove `in-progress`, add `review`, keep Obsidian checkbox as `[/]`.

### Checkbox changes from Obsidian

When the user changes the checkbox on an already-linked task:

| New checkbox | Target column on the board |
| --- | --- |
| `[ ]` | To Do (or first `new` category column) |
| `[/]` | In Progress (name match, else first non-todo/done column) |
| `[x]` | Done (or first `done` category column) |

The plugin transitions the issue toward that column and then reconciles status labels to match. Review cannot be selected from Obsidian; leaving `[/]` alone preserves Review.

### New tasks from Obsidian

Unlinked checklist items create issues only in unambiguous columns: To Do, In Progress, or Done according to the checkbox. After create, attach the matching status label.

## Nesting

- Indentation of checklist items defines parent/child trees in the note.
- Nested checklist items become Jira sub-tasks (`parent` = parent issue key) in the same project.
- Changing indentation of an already-linked task updates the Jira parent when the API allows.
- Description bullets must not be treated as children.

## Classification

For each mapping, build three sets:

1. **Local tasks** — checklist items in the note (tree).
2. **Remote issues** — issues on the Jira board.
3. **Ledger entries** — last successful sync snapshot for that mapping.

### Create remote (Obsidian → Jira)

Condition: local checklist item has no Jira link **and** is not already represented by a ledger entry.

Action:

1. Create a Jira issue with summary = local title, description = joined description bullets, parent if nested, due/start when set, initial status from checkbox.
2. Rewrite the Obsidian line to the canonical linked form.
3. Attach the status label for the target column.
4. Write a ledger entry.

### Create local (Jira → Obsidian)

Condition: remote issue exists on the board, has no matching linked line in the note, and has **no** ledger entry (never synced).

Action:

1. Append a canonical block to the end of the note (or under the parent block if the parent is already present).
2. Title and URL from Jira; description split into bullets by newlines.
3. Reconcile status labels to the column.
4. Write a ledger entry.

### Push (Obsidian wins for this change)

Condition: linked local task exists; remote exists; local content differs from ledger; remote matches ledger.

Action: update Jira summary, description, dates, parent, and transition if checkbox coarse status changed; reconcile labels; update ledger.

### Pull (Jira wins for this change)

Condition: linked local task exists; remote exists; remote differs from ledger; local matches ledger.

Action: rewrite the Obsidian block from Jira; reconcile labels; update ledger.

### Conflict

Condition: both local and remote differ from the ledger.

Action:

- If `conflictPolicy === prefer-obsidian`: same as Push.
- If `conflictPolicy === prefer-jira`: same as Pull.

Default policy: `prefer-obsidian`.

### Unchanged

Condition: local and remote both match the ledger for content.

Action: no content mutation; still run column→label reconciliation when labels disagree with the column.

### Unresolved removal

Condition: a ledger entry exists, but the task is missing on exactly one side.

Action:

- Do **not** delete the remaining side.
- Do **not** recreate the missing side.
- Leave the remaining side as-is.
- Mark the ledger entry unresolved and include it in the sync report.

## Sync triggers

| Trigger | Behaviour |
| --- | --- |
| Manual | Always available via command |
| Interval | Optional; value ≥ 1; unit minutes or hours |
| Startup | Optional; run after plugin load when settings allow |
| File change | Optional; 10 seconds after the last modification of a mapped file |

Triggers are independent. Concurrent runs coalesce. Plugin note writes do not re-trigger file-change sync.

## Worked examples

### Example A — new Obsidian task

Before:

```markdown
- [ ] Buy milk
```

After sync:

```markdown
- [ ] [Buy milk](https://jira.example/browse/PROJ-42)
```

Jira has a new issue in To Do with status label `to-do`.

### Example B — column wins over label

Issue `PROJ-7` is in column Review, labels `in-progress` + `bug`.

After sync: labels `review` + `bug`; note checkbox stays `[/]` if already so.

### Example C — nested child

Note:

```markdown
- [ ] [Parent](https://jira.example/browse/PROJ-1)
    - [ ] Child idea
```

After sync, child becomes a Jira sub-task of `PROJ-1`, and the note becomes:

```markdown
- [ ] [Parent](https://jira.example/browse/PROJ-1)
    - [ ] [Child idea](https://jira.example/browse/PROJ-2)
```

### Example D — unresolved deletion

Ledger knows `PROJ-7`. Note still has the linked line. Jira no longer returns `PROJ-7` on the board.

Result: note unchanged; sync report lists `PROJ-7` as unresolved removal; no recreate.

## Sync report

Each run should report at least:

- Mapping identity (note path, board id)
- Counts: created remote, created local, pushed, pulled, conflicts resolved, unchanged, unresolved removals, label reconciliations
- Errors (including missing Start date field when `🛫` is present)

Presentation can be an Obsidian Notice for short summaries and a more detailed modal/log for debugging.
