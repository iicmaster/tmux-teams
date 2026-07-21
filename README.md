# tmux-teams — Claude Code plugin

PM orchestration suite in one plugin: dispatch CLI agents (codex, claude,
gemini, agy) over **two transports — tmux and ACP** — on one mailbox contract
(evidence-not-attestation outbox + typed terminal markers), plan every
dispatch with `sqthink` + task creation, gate completion with `party-mode`
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

## Transports (v0.2.x)

The mailbox contract (brief in → `.mailbox-out/<id>` outbox +
`TEAM_DONE`/`TEAM_BLOCKED`/`TEAM_FAILED` out → PM adversarial verify) is
transport-independent:

| worker | primary | fallback |
|---|---|---|
| codex | ACP — `@agentclientprotocol/codex-acp` (drives the installed CLI; frontier model verified) | tmux |
| claude | ACP — `@agentclientprotocol/claude-agent-acp` (pass `ANTHROPIC_MODEL=claude-opus-4-8`) | tmux |
| gemini | ACP — native `--acp` (dead for individuals 2026-07-21; needs a valid `GEMINI_API_KEY`) | — |
| agy | ACP — `antigravity-acp@1.0.0` (community adapter, source-audited 2026-07-21; needs `bun`; ToS risk — SKILL.md §8) | tmux |

One worker over ACP:

```bash
node plugins/tmux-teams/skills/tmux-teams/scripts/acp-companion.mjs \
  codex <repo> <task-id> <brief-file> [timeout-sec]
```

See `skills/tmux-teams/SKILL.md` §6-§8 for the contract, tmux lane, and ACP lane.

## Install (this machine)

```bash
claude plugin marketplace add /home/iicmaster/projects/tmux-teams
claude plugin install tmux-teams@tmux-teams
```

For a second machine: `claude plugin marketplace add iicmaster/tmux-teams`
(private repo — authenticate `gh`/git first), then the same `plugin install`.

## Prerequisites (soft dependencies)

- `tmux`, and the `codex` CLI for the worker lane; Node 18+ with `npx` for
  the ACP adapters.
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
