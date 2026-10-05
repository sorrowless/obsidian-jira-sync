# Getting Started

> **Status:** Implemented for v1. Configure settings, run **Test connection**, then **Sync now** (or enable automatic triggers).

This plugin syncs checklist tasks between Obsidian notes and boards on Atlassian Jira (Cloud or self-hosted).

## Prerequisites

- Obsidian desktop (community plugins enabled)
- A Jira Cloud site or self-hosted Jira Server / Data Center instance
- Credentials:
  - **Cloud:** account email + [API token](https://id.atlassian.com/manage-profile/security/api-tokens)
  - **Self-hosted:** Personal Access Token (Bearer)
- Optional but recommended: the [Obsidian Tasks](https://github.com/obsidian-tasks-group/obsidian-tasks) plugin
- Optional: a custom **Start date** field on your Jira issues if you want `🛫` markers to sync

## Install steps

1. Install the plugin from Community Plugins (or manually from a release zip).
2. Enable **Jira Sync**.
3. Open plugin settings and enter:
   - Jira base URL (for example `https://your.atlassian.net` or `https://jira.example`)
   - Auth mode (Cloud or Self-hosted PAT)
   - Email (Cloud) and API token / PAT
4. Optionally configure **Date fields** (Start date, Actual end, Target end).
5. Add a mapping: **Browse note**, then **Browse board** (project/space → board). Optionally add Labels and/or a Recent-only window (last N days/months) when the board is large.
6. Choose a conflict policy (default: Prefer Obsidian).
7. Enable the sync triggers you want (startup, interval, file change). Manual sync remains available as a command.
8. Run **Test connection**, then **Sync now**, and confirm tasks appear with Jira browse links.

## What gets synced in v1

- Task title (summary) as a Markdown link to `/browse/KEY`
- Description (plain text bullets)
- Start (`🛫`) and due (`📅`) dates
- Nested subtasks
- Workflow status via checkbox, board column, and status labels (column wins)

Not synced: priority, assignees, components, rich description formatting, automatic deletes.

## Next reading

- [Task format](task-format.md)
- [Settings](settings.md)
- [Syncing](syncing.md)
