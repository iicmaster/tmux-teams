# tmux-teams — Claude Code plugin

PM orchestration suite in one plugin: dispatch CLI agents (codex, claude,
gemini, agy) over **two transports — tmux and ACP** — on one mailbox contract
(evidence-not-attestation outbox + typed terminal markers), plan every
dispatch with `sqthink` + task creation, gate completion with `party-mode`
verification.

## Skills

| Skill | Purpose |
|---|---|
| `tmux-teams:tmux-teams` | PM protocol over tmux + ACP: dispatch, completion detection, capture, mailbox pattern, run memory (§9) |
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

## Pulse v1 — agent-readable live state

Pulse has one data path: probes produce
`<repo>/.tmux-teams/pulse.json`, the machine-readable SSOT, and
`<repo>/.tmux-teams/pulse.html` is rendered only from that serialized JSON.
There is no second HTML-side interpretation of the probes.

```bash
node plugins/tmux-teams/skills/tmux-teams/scripts/pulse.mjs json <repo>
```

`json` prints the exact persisted Pulse v1 document. Its contract is
`plugins/tmux-teams/skills/tmux-teams/references/pulse-v1.schema.json` and
includes snapshot identity/freshness, source diagnostics, run state, and
`dispatch_id` correlation. Pulse is read-only and reports
`trust_level: advisory_same_uid`; suggested action codes are advisory and are
never executed automatically. See `skills/tmux-teams/SKILL.md` §10.

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

## Update lifecycle (this repo IS canonical — flipped 2026-07-21)

Skill content lives here, in `plugins/tmux-teams/skills/` — edit it directly.
(`~/agent-skills` vendors this repo as the submodule `plugins/tmux-teams` and
deleted its own copy of the tmux-teams skill; remaining duplicates there are
non-authoritative.)

1. Edit the skill under `plugins/tmux-teams/skills/` and commit here.
2. Bump the version in BOTH `plugins/tmux-teams/.claude-plugin/plugin.json`
   and `.claude-plugin/marketplace.json` (the test asserts they match).
3. Push, then `claude plugin marketplace update tmux-teams` and
   `claude plugin update tmux-teams@tmux-teams` (install cache is version-keyed).
4. Bump the `plugins/tmux-teams` submodule pointer in `~/agent-skills`.

`node --test` runs the whole suite (structure, semantics, KMS). Pass no path:
`node --test tests/` fails on Node 24.

Note: `~/.claude/skills` no longer carries these six skills (they are
plugin-delivered; `agent-skills/scripts/sync.sh` purges them from the tool
skill roots since the 2026-07-21 flip).
