# tmux-teams plugin repo — agent instructions

This repo is a **Claude Code directory marketplace** delivering one plugin
(`tmux-teams`, see `plugins/tmux-teams/`). It is a MIRROR, not a source:
skill content is canonical in `~/agent-skills` (`skills/shared/*` and
`skills/claude/codex-tmux-driver`). Never hand-edit files under
`plugins/tmux-teams/skills/` — edit in agent-skills, then sync.

## Commands

```bash
scripts/sync-skills.sh           # mirror the 6 skills from ~/agent-skills
scripts/sync-skills.sh --check   # drift check (exit 1 on drift)
node --test tests/plugin-structure.test.mjs   # structure + drift + semantic checks
claude plugin validate --strict .             # manifest validation
```

## Release flow (after canonical skill edits in agent-skills)

1. `scripts/sync-skills.sh`
2. Bump the version in BOTH `.claude-plugin/marketplace.json` and
   `plugins/tmux-teams/.claude-plugin/plugin.json` (test asserts they match).
3. `claude plugin update tmux-teams@tmux-teams` (install cache is version-keyed).
4. After the release push: bump the `plugins/tmux-teams` submodule pointer in
   `~/agent-skills` to the new sha and push it (this repo is vendored there as
   an install-manifest submodule — inventory only, nothing reads it at runtime).

## Rules

- Only plugin files are tracked: `.claude-plugin/`, `plugins/`, `scripts/`,
  `tests/`, `README.md`. BMAD scaffold dirs are gitignored — keep it that way.
- The marketplace on this machine is registered from GitHub
  (`iicmaster/tmux-teams`) — a release is NOT live until pushed; after
  pushing run `claude plugin marketplace update tmux-teams` then
  `claude plugin update tmux-teams@tmux-teams`. Confirm with Master before
  the push that ships a release.
- `~/.claude/skills` must NOT contain the six bundled skills (they were
  deduplicated 2026-07-19; `agent-skills/scripts/sync.sh` skips them for the
  claude root). Restoring them by hand recreates double-triggering.
- `acp-companion.mjs` honors `ACP_CMD="node <stub>.mjs"` — point it at a stub
  ACP agent (answers initialize/session/new/session/prompt) for fast,
  model-free tests of the outbox/timeout logic.
