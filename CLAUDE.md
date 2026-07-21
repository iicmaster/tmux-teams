# tmux-teams plugin repo — agent instructions

This repo is a **Claude Code directory marketplace** delivering one plugin
(`tmux-teams`, see `plugins/tmux-teams/`) — and it is the **canonical source**
of the six bundled skills. Edit them directly under
`plugins/tmux-teams/skills/`. (Flipped 2026-07-21: agent-skills commit
`dd43dc1` vendored this repo as the authoritative submodule and deleted its
own `skills/shared/tmux-teams`; the old mirror/sync flow is gone.)

## Commands

```bash
node --test                        # whole suite — structure, semantics, KMS
claude plugin validate --strict .  # manifest validation
```

`node --test tests/` (a bare directory) fails on Node 24 with MODULE_NOT_FOUND —
pass no path at all, or a glob like `tests/*.test.mjs`.

## Release flow

1. Edit skills under `plugins/tmux-teams/skills/` (this repo IS canonical).
2. Bump the version in BOTH `.claude-plugin/marketplace.json` and
   `plugins/tmux-teams/.claude-plugin/plugin.json` (test asserts they match).
3. Push (confirm with Master first — see Rules), then
   `claude plugin marketplace update tmux-teams` and
   `claude plugin update tmux-teams@tmux-teams` (install cache is version-keyed).
4. Bump the `plugins/tmux-teams` submodule pointer in `~/agent-skills` to the
   new sha and push it (this repo is vendored there as an install-manifest
   submodule — inventory only, nothing reads it at runtime).

## Rules

- Only plugin files are tracked: `.claude-plugin/`, `plugins/`, `tests/`,
  `README.md`. BMAD scaffold dirs are gitignored — keep it that way.
- The marketplace on this machine is registered from GitHub
  (`iicmaster/tmux-teams`) — a release is NOT live until pushed; after
  pushing run `claude plugin marketplace update tmux-teams` then
  `claude plugin update tmux-teams@tmux-teams`. Confirm with Master before
  the push that ships a release.
- `~/agent-skills` still carries duplicate copies of five of the six skills
  (`party-*`, `sqthink`, `codex-tmux-driver`) — treat THIS repo as
  authoritative; never copy from agent-skills into here.
- `~/.claude/skills` must NOT contain the six bundled skills (they were
  deduplicated 2026-07-19; `agent-skills/scripts/sync.sh` purges them for the
  tool roots). Restoring them by hand recreates double-triggering.
- `acp-companion.mjs` honors `ACP_CMD="node <stub>.mjs"` — point it at a stub
  ACP agent (answers initialize/session/new/session/prompt) for fast,
  model-free tests of the outbox/timeout logic.
