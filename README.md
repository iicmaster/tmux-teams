# tmux-teams — Claude Code plugin

PM orchestration suite in one plugin: dispatch interactive CLI agents (codex)
over tmux, plan the dispatch with `sqthink`, gate completion with `party-mode`
verification.

## Skills

| Skill | Purpose |
|---|---|
| `tmux-teams:tmux-teams` | PM-via-tmux protocol: dispatch, completion detection, capture, mailbox pattern |
| `tmux-teams:codex-tmux-driver` | Codex TUI calibration (flags, markers, dialogs) for the codex worker lane |
| `tmux-teams:party-mode` | Multi-agent execution/advisory workflow with 3-model review + grill gate |
| `tmux-teams:party-auto` | Execution lane of party-mode |
| `tmux-teams:party-advise` | Read-only advisory lane of party-mode |
| `tmux-teams:sqthink` | Sequential-thinking analysis/planning |

Commands: `/tmux-teams:mailbox-run` — run the mailbox PM workflow end to end.

## Install (this machine)

```bash
claude plugin marketplace add /home/iicmaster/projects/tmux-teams
claude plugin install tmux-teams@tmux-teams
```

For a second machine, push this repo to a remote first, then `claude plugin marketplace add <url>`.

## Prerequisites (soft dependencies)

- `tmux`, and the `codex` CLI for the worker lane.
- party-mode's 3-model review lanes need the `oc` (opencode) and `agy`
  (antigravity) plugins plus Codex MCP — without them party-mode falls back
  per its own review-fallback rules.

## Update lifecycle (source of truth = agent-skills)

Skill content is canonical in `~/agent-skills` (`skills/shared/*`,
`skills/claude/codex-tmux-driver`). This repo mirrors it:

1. Edit the skill in `~/agent-skills` and commit there.
2. `scripts/sync-skills.sh` (here) to refresh `plugins/tmux-teams/skills/`.
3. Bump the version in BOTH `plugins/tmux-teams/.claude-plugin/plugin.json`
   and `.claude-plugin/marketplace.json` (the test asserts they match).
4. `claude plugin update tmux-teams` (the install cache is version-keyed).

`scripts/sync-skills.sh --check` reports drift; `node --test tests/` runs the
structure + drift + semantic checks.

Note: `~/.claude/skills` no longer carries these six skills (they are
plugin-delivered; `agent-skills/scripts/sync.sh` skips them for the claude
root). The other tool roots (`~/.agents`, `~/.codex`, `~/.openclaw`) keep
their copies via the normal fan-out.
