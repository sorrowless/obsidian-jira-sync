# Roadmap

Phased plan for building the plugin against the design docs.

## Phase 0 — Design contract (done)

Deliverables:

- [docs/dev/architecture.md](architecture.md)
- [docs/dev/sync-rules.md](sync-rules.md)
- [docs/user/](../user/) user guides (planned behaviour)
- [README.md](../../README.md)
- Minimal CI that validates documentation presence and, later, build/test

Outcome: a repository that can be developed against without ambiguity on v1 behaviour.

## Phase 1 — Plugin skeleton (done)

- Obsidian plugin manifest (`manifest.json`), `package.json`, TypeScript build (esbuild)
- Plugin entry that loads settings and registers a placeholder **Sync now** command
- Settings tab UI for base URL, auth mode, credentials, note↔board mappings, conflict policy, sync triggers, and Start date field id
- CI runs `npm ci`, `npm run build`, and `npm test` via `scripts/ci-check.sh`

## Phase 2 — Read path and Jira client (done)

- Jira REST client (Cloud Basic + self-hosted Bearer; Agile boards/columns; issue search/create/update; transitions; labels; fields)
- Note parser for checklist trees, browse links, descriptions, done state, start/due dates
- Connection test and Start date field lookup action in settings
- Unit tests for parser, URL helpers, and client request shaping

## Phase 3 — Sync engine (v1 scope) (done)

- Sync ledger in plugin data (including Jira status id / column name)
- Classification and mutation pipeline per [sync-rules.md](sync-rules.md)
- Column-wins label reconciliation; checkbox → To Do / In Progress / Done transitions
- Note writer for canonical linked blocks
- Manual sync + interval + startup + 10s file-change debounce
- Sync report / notices
- Unit tests for classification, conflict policy, nesting, and Review vs `in-progress` labels

## Phase 4 — Hardening (done)

- Safer concurrent-run coalescing (single-flight + one follow-up; real sync wins over dry-run)
- Better error recovery when a create succeeds but note write fails (`pendingLinks`)
- Optional dry-run / preview mode (command + settings default)
- Suppress file-change sync while the plugin writes notes
- Documentation updates reflecting actual UI labels and commands

## Phase 5 — Extended fields (post-v1)

Candidates, in likely order:

1. Priority
2. Assignees
3. Non-status labels / components (bidirectional)
4. Explicit delete policy
5. Epic / parent link types beyond sub-task
6. Rich description round-trip (ADF)

Each of these should land as a proposal under `docs/dev/` before implementation.

## Proposal process

When changing architecture or sync behaviour:

1. Add a short proposal Markdown file under `docs/dev/` (for example `docs/dev/proposal-delete-policy.md`).
2. Update [architecture.md](architecture.md) and/or [sync-rules.md](sync-rules.md) once accepted.
3. Update user docs under `docs/user/` when behaviour becomes user-visible.
4. Keep the README scope section aligned with what is actually implemented.
