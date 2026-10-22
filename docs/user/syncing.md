# Syncing

> **Status:** Implemented for v1 fields (title, description, dates, status/labels, nesting).

## Overview

For each mapped note, the plugin will:

1. Read checklist tasks from the note
2. Fetch issues and columns from the mapped Jira board (optionally filtered by the mapping’s Labels and/or Recent-only window)
3. Compare both sides to a private sync ledger (stored in plugin data, not in the note)
4. Create, update, or report issues according to the rules below
5. Reconcile status labels so they match the board column (column wins)
6. Rewrite linked task lines into the [canonical format](task-format.md)

## Create rules

**Obsidian only (new, unlinked task)**  
Create a Jira issue (To Do / In Progress / Done from the checkbox), then rewrite the note line as a link to that issue.

**Jira only (never synced before)**  
Append a linked task block to the note (under its parent when the parent already exists).

## Update rules

**Changed only in Obsidian**  
Update summary, description, dates, parent, and transition if the checkbox coarse status changed.

**Changed only in Jira**  
Update the corresponding lines in the Obsidian note.

**Changed on both sides**  
Apply your [conflict policy](settings.md#conflict-policy).

## Status, columns, and labels

- `[ ]` / `[/]` / `[x]` map to To Do / in-progress family / Done family.
- Board column is the source of truth for which status label the issue should have.
- Example: column Review with leftover label `in-progress` → remove `in-progress`, add `review`, keep `[/]` in Obsidian.
- Non-status labels are left alone.

## Nesting

- Indenting a checklist item under another creates a Jira **Blocks** link: child **blocks** parent (parent **is blocked by** child). Both remain normal issues (not Sub-tasks).
- Un-indenting removes that Blocks link between the pair; other Blocks links are left alone.
- On pull, Blocks nesting follows the heuristics in [task format](task-format.md#when-jira-blocks-become-obsidian-children) (same project/sync set; blocker must not already have a hierarchy parent).
- Indented bullets without checkboxes are description text, not children.

## Deletions (v1)

If a task was synced before and then disappears on only one side, the plugin will **not**:

- delete it on the other side, or
- recreate the missing copy.

The remaining side is left alone, and the sync report lists the case as unresolved.

To start over after wiping synced lines from a note: open settings → **Clear sync state**, then run **Sync now**. Jira issues will be imported again as new local tasks.

## When sync runs

- **Manual:** command palette → **Jira Sync: Sync now**, or the ribbon sync icon
- **Preview:** command palette → **Jira Sync: Preview sync (dry run)**
- **Startup:** optional
- **Interval:** optional, at least every 1 minute
- **After editing a mapped file:** optional, 10 seconds after the last change to that file

Only one sync runs at a time; overlapping triggers coalesce into a single follow-up run. Writes performed by the plugin do not re-trigger file-change sync.

## After a sync

You should see:

- New or updated Jira browse links in the mapped note
- Matching issues on the Jira board
- Status labels aligned with columns
- A short notice or detailed report (created / updated / unresolved / errors)
