# Obsidian Jira Sync

Bidirectional sync between Obsidian checklist tasks and [Atlassian Jira](https://www.atlassian.com/software/jira) boards (Cloud and self-hosted).

> **Status:** Core bidirectional sync is implemented (Phase 4). See [docs/dev/roadmap.md](docs/dev/roadmap.md) for post-v1 work.

## What it will do

Map selected Obsidian notes to Jira boards (optionally filtered by labels and/or recent activity) and keep tasks in sync in both directions:

- Create missing tasks on either side
- Filter a shared board across notes with per-mapping label lists (OR match; empty = whole board) and optional “last N days/months” windows
- Update title, description, start/due dates, coarse status, and nested subtasks
- Keep status labels aligned with the board column (column wins over conflicting status labels)
- Resolve simultaneous edits with a Prefer Obsidian / Prefer Jira setting
- Run on demand, on a timer, at startup, or shortly after you edit a mapped note

Synced Obsidian lines use a Markdown link to the Jira browse page:

```markdown
- [ ] [Task title](https://jira.example/browse/PROJ-123) 🛫 2026-10-02 📅 2026-10-05
    - description line
    - [ ] [Child title](https://jira.example/browse/PROJ-124)
```

## v1 sync scope

| Included | Not in v1 |
| --- | --- |
| Title, description, nesting | Priority, assignees, components |
| Browse-link identity (`/browse/KEY`) | Automatic delete on either side |
| Start (`🛫`) + due (`📅`) dates | Rich ADF/wiki description round-trip |
| Status via checkbox + board column + labels | Creating Review (etc.) from Obsidian |
| Conflict preference setting | Mapping one note to multiple boards |

## Documentation

**Users**

- [Getting started](docs/user/getting-started.md)
- [Task format](docs/user/task-format.md)
- [Settings](docs/user/settings.md)
- [Syncing](docs/user/syncing.md)

**Developers**

- [Architecture](docs/dev/architecture.md)
- [Sync rules](docs/dev/sync-rules.md)
- [Roadmap](docs/dev/roadmap.md)

## Development

```bash
make install          # npm ci
make build            # typecheck + production bundle → main.js
make test
make ci               # docs check + install + build + test
make release          # build + zip under dist/
make release bump=patch   # bump version, then release zip
make install-vault VAULT="$HOME/path/to/vault"
make clean
```

Watch mode: `make dev`.

### Manual install in Obsidian

```bash
make install-vault VAULT="/path/to/your/vault"
```

Or copy `main.js`, `manifest.json`, and `styles.css` into  
`Vault/.obsidian/plugins/obsidian-jira-sync/` after `make build`.

Then enable **Jira Sync** under Community plugins.

## Commands

| Command | Action |
| --- | --- |
| **Sync now** | Run bidirectional sync for all mappings (respects “Dry-run by default”) |
| **Preview sync (dry run)** | Classify and report what would change without writing notes or Jira |

A ribbon **sync** icon also starts **Sync now**.

Automatic triggers (startup / interval / file change) always perform a real sync.

## Requirements

- Obsidian with community plugins enabled
- Jira Cloud (email + API token) or self-hosted Jira with a Personal Access Token
- Optional: [Obsidian Tasks](https://github.com/obsidian-tasks-group/obsidian-tasks) for richer task workflows in the vault
- Optional: a custom Start date field if you sync `🛫` markers

## CI

`make ci` validates the docs layout, then runs `make install`, `make build`, and `make test` (via [`scripts/ci-check.sh`](scripts/ci-check.sh)).

GitHub Actions: [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

## License

Apache License 2.0. See [LICENSE](LICENSE).
