# Architecture

This document describes the architecture for the Obsidian ↔ Jira sync plugin.

## Goals

- Bidirectional sync of tasks between mapped Obsidian notes and Jira boards.
- Preserve Obsidian Tasks-compatible checklist syntax.
- Detect local vs remote changes without embedding sync metadata in note bodies.
- Support manual, interval, startup, and debounce-on-edit triggers.
- Work with both Jira Cloud and self-hosted (Server / Data Center) instances.

## Non-goals (v1)

- Syncing priority, assignees, components, reminders, or recurrence.
- Automatic deletion on either side when a previously synced task disappears.
- Mapping one note to multiple boards, or one board to multiple notes.
- Preserving rich Jira description formatting (ADF / wiki markup) round-trip.
- Creating arbitrary board columns from Obsidian (only To Do / In Progress / Done).

## High-level components

```text
┌─────────────────────────────────────────────────────────────┐
│                     Obsidian Plugin                          │
│                                                              │
│  Settings UI ──► PluginSettings                               │
│       │                                                       │
│  Commands / Scheduler ──► SyncEngine                          │
│                              │                                │
│              ┌───────────────┼───────────────┐                │
│              ▼               ▼               ▼                │
│        NoteParser      JiraClient        SyncLedger           │
│        NoteWriter           │                 │               │
│              │              ▼                 │               │
│              │      Jira REST + Agile API     │               │
│              ▼                                ▼               │
│         Vault files                    Plugin data store      │
└─────────────────────────────────────────────────────────────┘
```

### Settings

Stores connection and behaviour configuration:

| Field | Purpose |
| --- | --- |
| `jiraBaseUrl` | Instance root URL, e.g. `https://jira.example` or `https://your.atlassian.net` |
| `authMode` | `cloud` (email + API token, Basic) or `pat` (Bearer PAT for self-hosted) |
| `jiraEmail` | Account email (Cloud only) |
| `jiraApiToken` | API token (Cloud) or Personal Access Token (self-hosted) |
| `mappings` | Array of `{ notePath, boardId, boardName?, labels[], recencyValue, recencyUnit, recencyField }` — `boardName` is display-only; `labels` empty means all board issues (OR-filter when set); recency `0` = no time window, else `updated|created >= -Nd|-NM` |
| `startDateFieldId` | Optional custom field id for Start date (e.g. `customfield_10015`) |
| `actualEndFieldId` | Optional Actual end field; wins for Obsidian due; used with time tracking to derive start |
| `targetEndFieldId` | Target end / due field (default `duedate`); Obsidian due writes here |
| `timeSpentFieldId` | Jira field for pull-only `[timespent:: seconds]` (default `timetracking`) |
| `assigneeMappings` | `{ jiraAccountId, jiraDisplayName, jiraName?, obsidianValue }[]` for Dataview `[assignee:: …]` |
| `knownAssignees` | Cached board assignees for settings dropdowns |
| `conflictPolicy` | `prefer-obsidian` (default) or `prefer-jira` |
| `syncOnStartup` | Boolean |
| `syncIntervalEnabled` | Boolean |
| `syncIntervalValue` | Number ≥ 1 |
| `syncIntervalUnit` | `minutes` or `hours` |
| `syncOnFileChange` | Boolean; debounce is fixed at 10 seconds |
| `dryRunDefault` | When true, Sync now previews without writing |

### Jira client

Thin HTTP client over Jira REST APIs. HTTP calls use Obsidian’s `requestUrl` (not browser `fetch`) so instances are not blocked by CORS.

| Operation | Endpoint family |
| --- | --- |
| List boards | `GET /rest/agile/1.0/board` |
| Board configuration (columns) | `GET /rest/agile/1.0/board/{id}/configuration` |
| Board issues | `GET /rest/agile/1.0/board/{id}/issue` (paginated) |
| Get issue | `GET /rest/api/2/issue/{key}` (and `/rest/api/3` when Cloud needs ADF) |
| Create issue | `POST /rest/api/2/issue` |
| Update issue | `PUT /rest/api/2/issue/{key}` |
| Transitions | `GET/POST /rest/api/2/issue/{key}/transitions` |
| Labels | via issue `labels` field updates |
| Search fields | `GET /rest/api/2/field` |
| Myself (connection test) | `GET /rest/api/2/myself` |

Authentication:

- Cloud: `Authorization: Basic base64(email:apiToken)`
- Self-hosted PAT: `Authorization: Bearer <token>`

Task identity in notes uses the browse URL pattern `{baseUrl}/browse/{ISSUE-KEY}`.

API version strategy: prefer `/rest/api/2` for fields that accept plain strings (summary, due date, labels). Description may be plain text (API v2) or ADF (API v3 on Cloud); the client normalizes inbound description to plain text and writes simple text back.

### Note parser / writer

- **Parser**: walk mapped note lines, recognise checklist items, build a tree from indentation, extract Jira browse links, treat non-checkbox indented bullets as description lines, parse `🛫` / `📅` after the link.
- **Writer**: rewrite synced blocks into the canonical shape while preserving existing list marker and indent width; for new blocks use `-` and four spaces.

Canonical block:

```markdown
- [ ] [Task title](https://jira.example/browse/PROJ-123) 🛫 2026-10-02 📅 2026-10-05
    - description line
    - [ ] [Child title](https://jira.example/browse/PROJ-124)
        - child description
```

On rewrite, description lines come first, then child tasks.

### Sync ledger

Persisted in plugin data (not in notes). One entry per Jira issue key that has been successfully synced for a mapping.

```ts
interface LedgerEntry {
  issueKey: string;
  mappingKey: string; // notePath + boardId
  title: string;
  description: string;
  status: 'todo' | 'in_progress' | 'done';
  jiraStatusId: string;
  jiraStatusName: string; // board column / status name
  parentIssueKey: string | null;
  startDate: string | null;
  dueDate: string | null;
  contentHash: string;
  jiraUpdated: string; // ISO from issue fields.updated
  lastSyncedAt: string;
}
```

The ledger distinguishes local-only change, remote-only change, conflict, and unchanged. Storing `jiraStatusId` / `jiraStatusName` detects column moves (e.g. Review → In Progress) even when the Obsidian checkbox stays `[/]`.

### Sync engine

For each mapping:

1. Read and parse the note.
2. Fetch board configuration (columns → status ids) and all issues on the board.
3. Load ledger entries for that mapping.
4. Classify every local task and every remote issue.
5. Apply actions (create remote, create local, push, pull, conflict policy, reconcile status labels, report unresolved removals).
6. Write the note once per mapping (if changed).
7. Persist the updated ledger.
8. Emit a sync report.

See [sync-rules.md](sync-rules.md) for classification and status rules.

### Scheduler

Independent triggers:

- Manual command always available.
- Optional interval timer (minimum 1 minute).
- Optional run on Obsidian load.
- Optional vault `modify` listener for mapped files, debounced 10 seconds after the last change to that file.

Only one sync run may execute at a time; overlapping triggers queue or coalesce into a single follow-up run.

## Data flow

```text
Read mapped note ──┐
Read Jira board   ┼──► Classify against ledger ──► Apply mutations ──► Save note + ledger
Load sync ledger ──┘
```

| Outcome | Action |
| --- | --- |
| Local only (unlinked, never in ledger) | Create in Jira; rewrite note with link |
| Remote only (never in ledger) | Append linked task to note |
| Local changed | Update Jira |
| Remote changed | Update note |
| Both changed | Apply conflict policy |
| Previously synced, missing on one side | Report unresolved; do not delete or recreate |
| Unchanged | No-op (still reconcile status labels if column wins) |

## Mapping model

- One note ↔ one Jira **board**, optionally narrowed by label and/or recency filters.
- Several mappings may share the same board with different label filters (and different notes).
- Empty `labels` → all issues on the board (subject to recency). Non-empty → issue must carry at least one listed label (OR).
- Optional recency narrows fetch with relative JQL (`updated` or `created`); helps stay under Jira’s ~1000-result search cap.
- Issues sync for that board (and filter); column membership comes from the issue’s workflow status mapped through board configuration.
- Settings store `boardId` (numeric Agile board id), `labels` (string array), and recency fields.
- Ledger `mappingKey` is `notePath::boardId` when unfiltered, or `notePath::boardId::label1+label2` when label-filtered (recency is not part of the key).

## Nesting model

Obsidian nested checklist items map to Jira **sub-tasks**:

- Child issue has `parent` set to the parent issue key.
- Parent and child stay in the same Jira project (derived from the board / first create).
- Plain indented bullets without checkboxes are description content, not child tasks.

## Conflict detection

For a paired task (linked in the note and present in Jira):

1. Compute local content hash from note title, description, coarse status, parent, start, due.
2. Compare local hash to ledger `contentHash`.
3. Compare Jira `updated` and/or remote content hash (including status id / column name) to ledger.
4. If only local differs → push.
5. If only remote differs → pull.
6. If both differ → conflict policy.
7. If neither differs → skip content write; still run column→label reconciliation.

## Error handling

- Network / auth failures abort the current mapping and report the error; other mappings may continue.
- Partial write failure within a mapping should leave the ledger unchanged for failed issue keys so the next run can retry.
- The engine must not leave a newly created Jira issue unlinked in the note if the create API call succeeded; rewrite the note before considering that create complete (`pendingLinks` recovery).

## Testing strategy

- Unit tests for parser, writer, hash, status/column/label mapping, and classification (no Obsidian or network).
- Integration tests against a mocked Jira HTTP layer.
- Manual vault fixture for end-to-end checks in Obsidian.
