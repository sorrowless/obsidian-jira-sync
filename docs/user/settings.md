# Settings

> **Status:** Settings fields and **Test connection** are implemented in the v1 UI.

## Connection

| Setting | Description |
| --- | --- |
| Jira base URL | Root URL of your site, without a trailing `/rest` path. Examples: `https://your.atlassian.net`, `https://jira.example` |
| Auth mode | **Cloud** (email + API token, Basic auth) or **Self-hosted PAT** (Bearer token) |
| Email | Required for Cloud auth |
| API token | Cloud API token, or Personal Access Token for self-hosted |

A **Test connection** button verifies that the saved URL and credentials can call `/rest/api/2/myself`.

## Date fields

| Setting | Purpose |
| --- | --- |
| **Start date field id** | Custom field for 🛫. **Find** looks up a field named “Start date”. Empty = do not push start to Jira |
| **Actual end field id** | When filled on an issue, wins for Obsidian 📅. With time tracking and an empty Start field, start is derived as Actual end − time spent. Never written from Obsidian. **Find** looks up “Actual end” |
| **Target end field id** | Used when Actual end is empty; Obsidian 📅 writes here. Default `duedate` (Jira Due date). **Find** looks up “Target end” |

Due date resolution from Jira: **Actual end** if set, else **Target end**, else no 📅 (time tracking alone never invents a due date).

Start resolution from Jira: Start field if set; otherwise, when Actual end and time tracking (time spent) are both present, start = Actual end − time spent. Sync then writes that value into the Start field and reports **set start date from actual end − time tracking** in the notice/report.

## Note ↔ board mappings

Each mapping pairs one Obsidian note with one Jira **board**.

| Control | Purpose |
| --- | --- |
| **Browse note** | Pick a vault markdown file (stores Obsidian’s exact path — important for spaces / Cyrillic names) |
| **Browse board** | Load Agile boards from Jira, pick a **project/space**, then the **board**. Fills the numeric board id for you |
| Board id field | Still editable manually if you already know the id |
| **Labels** | Optional label filter (see below) |
| **Recent only** | Optional recency window (see below) |

You do **not** need to dig the board id out of a Cloud URL. Use **Browse board** after **Test connection** succeeds.

Optional **Labels** filter which issues from that board participate in the mapping:

| Labels field | Behaviour |
| --- | --- |
| Empty | Sync **all** issues on the board (subject to recency, if set) |
| One or more labels | Sync issues that have **any** of those labels (OR). Comparison is case-insensitive |

Use this to split one board across several notes (for example board `12` + `project-a` → note A, board `12` + `project-b` → note B).

Type labels as a comma-separated list (including labels that do not exist in Jira yet). **Add from board** loads labels currently present on issues of that board and lets you pick one.

New tasks created from the note receive the mapping’s filter labels (in addition to the status label). Status labels (`to-do`, `in-progress`, `review`, …) are managed separately and are not used as the filter.

Optional **Recent only** narrows the fetch further (useful when a label matches more than ~1000 issues — Jira search typically cannot return more than that in one query):

| Control | Behaviour |
| --- | --- |
| Number | `0` = no recency limit. Positive N keeps issues with `updated` or `created` in the last N days/months |
| Days / Months | Unit for N (`updated >= -30d` or `created >= -3M` in JQL) |
| Updated / Created | Which timestamp field to compare |

Labels and recency combine with AND (an issue must match the label filter **and** fall inside the window).

Column names for status labels still come from the board configuration.

## Conflict policy

When the same linked task changed both in Obsidian and in Jira since the last successful sync:

| Option | Behaviour |
| --- | --- |
| Prefer Obsidian (default) | Push Obsidian title, description, dates, status, and nesting to Jira |
| Prefer Jira | Pull Jira fields into the note |

## Sync triggers

These options are independent. The manual **Sync now** command is always available.

| Setting | Description |
| --- | --- |
| Sync on startup | Run once after Obsidian finishes loading the plugin |
| Sync on interval | Run periodically |
| Interval value | Number ≥ 1 |
| Interval unit | Minutes or hours |
| Sync on file change | After you edit a mapped note, wait 10 seconds from the last change, then sync |
| Dry-run by default | When enabled, **Sync now** / ribbon only preview. Automatic triggers still perform a real sync. |

Minimum interval is one minute.

Commands:

- **Sync now** — run sync (or dry-run if the setting above is on)
- **Preview sync (dry run)** — always preview without writing

## Maintenance

| Setting | Description |
| --- | --- |
| Clear sync state | Deletes the local sync ledger and pending links. Settings and mappings are kept. After clearing, the next sync imports Jira issues into empty notes again instead of listing them as unresolved removals. |
