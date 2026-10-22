# Task Format

> **Status:** Implemented — this page describes the Markdown shape the plugin reads and writes for synced tasks.

Tasks live in ordinary Markdown notes as checklist items, compatible with Obsidian Tasks.

## Basic task

```markdown
- [ ] Buy milk
```

After the first sync that creates the issue in Jira, the line becomes a link:

```markdown
- [ ] [Buy milk](https://jira.example/browse/PROJ-42)
```

The link text is the title. The URL points at the Jira issue browse page.

## Start and due dates

Start and due dates live **after** the title link (not inside the `[...]` brackets):

```markdown
- [ ] [Team standup](https://jira.example/browse/PROJ-42) 🛫 2026-10-02 📅 2026-10-05
```

| Marker | Meaning | Jira field |
| --- | --- | --- |
| `🛫` | Start | Configured custom Start date field (settings) |
| `📅` | Due | Actual end when set, otherwise Target end (`duedate` by default). Obsidian edits write Target end only |
| `[assignee:: …]` | Assignee | Dataview inline field; mapped to a Jira user in settings |
| `[timespent:: …]` | Time spent | Seconds from Jira Time Tracking (pull-only; edit time in Jira) |

Accepted date values: `YYYY-MM-DD` or `YYYY-MM-DD HH:mm` (local time). After sync the plugin rewrites the line in this canonical form; the link text stays the title only. Due dates sent to Jira use the calendar date only.

Example with assignee and time spent:

```markdown
- [ ] [Team standup](https://jira.example/browse/PROJ-42) 🛫 2026-10-02 📅 2026-10-05 [assignee:: Аряпов] [timespent:: 3600]
```

Unlinked tasks may use the same markers:

```markdown
- [ ] Draft proposal 🛫 2026-10-05 📅 2026-10-06
```

If Start date field id is empty, `🛫` stays in the note but is not written to Jira (reported in the sync report).

## Description

Description lines are indented bullets **without** checkboxes, directly under the task:

```markdown
- [ ] [Write release notes](https://jira.example/browse/PROJ-7)
    - Mention breaking changes
    - Link to the changelog
```

Those bullets sync to the Jira issue description (joined with newlines). Descriptions coming from Jira may be ADF or wiki markup; the plugin converts them to plain text before writing into the note. Rich formatting is not preserved on write-back.

## Nested tasks (Blocks links)

Indented checklist items are child tasks. In Obsidian, nesting is **only** indentation — no extra Dataview fields. In Jira, nesting is a **Blocks** issue link: the child **blocks** the parent (the parent **is blocked by** the child). That matches an umbrella parent that should stay open until children are done. The plugin does **not** create classic Sub-tasks or set hierarchy `parent` for this.

```markdown
- [ ] [Ship plugin](https://jira.example/browse/PROJ-10)
    - Outline README
    - [ ] [Write docs](https://jira.example/browse/PROJ-11)
        - Cover settings
    - [ ] [Add CI](https://jira.example/browse/PROJ-12)
```

In this example:

- `Outline README` is description text for `PROJ-10`.
- `Write docs` and `Add CI` are normal Jira issues that **block** `PROJ-10`.

### When Jira Blocks become Obsidian children

On pull, a Blocks link `A blocks B` nests A under B in Obsidian only if **all** of these hold:

1. A and B are in the **same project** as the mapped board.
2. Both issues are in the current sync set for that mapping (board + label/recency filters).
3. A has **no** hierarchy parent in Jira (`parent` empty — not under an Epic/Story/etc.).
4. If A already has a hierarchy parent (Epic, Story, …) → the Blocks link is left alone and **not** shown as Obsidian indent.
5. If the blocked issue is in another project → ignore for nesting.

If A would nest under several eligible parents, the plugin picks the lexicographically smallest parent key. Mutual Blocks cycles (`A blocks B` and `B blocks A`) are skipped and reported as a sync error.

Unrelated Blocks links (other boards/projects, or blockers that already sit under an Epic/Story) are not removed and do not change Obsidian indent.

After a rewrite, description bullets are ordered before child tasks.

## Done state and columns

| Checkbox | Meaning | Typical Jira column |
| --- | --- | --- |
| `[ ]` | To-Do | To Do |
| `[/]` | In progress family | In Progress, Review, … |
| `[x]` or `[X]` | Done family | Done, Trashed, Canceled |

Exact column names come from the mapped board. The board column is authoritative for status labels: if the ticket is in Review but still has an `in-progress` label, sync removes `in-progress`, adds `review`, and keeps `[/]` in Obsidian.

New tasks created from Obsidian only target To Do, In Progress, or Done. Other checkbox characters (for example `[-]`) are left alone and are not treated as status sync.

## List markers and indentation

- Existing tasks may use `-`, `*`, or numbered list markers; the plugin preserves the marker when rewriting a block.
- New blocks created by sync use `-` and four spaces per nesting level.

## What to avoid

- Putting important sync metadata only in frontmatter; identity is the Jira browse URL in the task line.
- Mixing multiple boards’ issues in one mapped note; each mapped note belongs to one board.
- Expecting plain indented bullets (no checkbox) to become nested Jira issues — they are description lines.
