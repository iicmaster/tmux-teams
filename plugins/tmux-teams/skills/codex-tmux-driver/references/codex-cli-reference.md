# Codex CLI reference (researched & fact-checked 2026-07-13)

Deep-research synthesis: 21 sources fetched, 105 claims extracted, top 25 claims
adversarially verified 3-0 each (0 refuted). Primary sources: developers.openai.com
Codex docs (CLI, slash-commands, config-reference, config-advanced, noninteractive,
mcp, changelog — note: these now 308-redirect to learn.chatgpt.com) and the
openai/codex GitHub repo (docs + codex-rs source). Codex CLI iterates fast —
re-verify command names against `codex --version` before scripting.

## 1. Install & authenticate

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh   # macOS/Linux; redirects to latest GitHub release
npm i -g @openai/codex                                  # alternative
brew install codex                                      # alternative
```

Auth options:

```bash
codex login                   # interactive ChatGPT OAuth (recommended)
codex login --device-auth     # headless device-code flow
codex login --with-api-key    # API key via stdin
```

First `codex` run also offers "Sign in with ChatGPT". API-key auth alternatively via
`OPENAI_API_KEY` env var.

## 2. Entrypoints

| Command | Purpose |
|---|---|
| `codex` | interactive TUI session in cwd |
| `codex "prompt"` | TUI with initial prompt |
| `codex resume` / `codex resume --last` / `codex resume SESSION_ID` | reopen a recent conversation from the current repository |
| `codex exec "task"` | non-interactive / headless run (§5) |
| `codex --image img.png` | attach visual context to first prompt |
| `codex --search` | enable live web search |
| `codex cloud` | cloud tasks |
| `codex completion bash\|zsh\|fish` | shell completions |

## 3. Approval & sandbox model

CLI flags:

- `--ask-for-approval, -a`: `untrusted` | `on-request` | `never`
- `--sandbox, -s`: `read-only` | `workspace-write` | `danger-full-access`
- `--dangerously-bypass-approvals-and-sandbox` (alias `--yolo`): disables both
- `--ignore-user-config`: skip `$CODEX_HOME/config.toml` (exec mode)

config.toml equivalents:

```toml
approval_policy = "on-request"     # untrusted | on-request | never
                                   # legacy "on-failure" still parses but is deprecated
# granular form (since ~v0.122):
# approval_policy = { granular = { sandbox_approval = true, rules = true,
#   mcp_elicitations = true, request_permissions = true, skill_approval = true } }

sandbox_mode = "workspace-write"   # read-only | workspace-write | danger-full-access

[sandbox_workspace_write]
network_access = false             # network blocked by default in workspace-write
writable_roots = ["/extra/path"]
# also: exclude_tmpdir_env_var, exclude_slash_tmp
```

Newer `default_permissions` profile system offers `:read-only` / `:workspace` /
`:danger-full-access` profiles — do NOT combine with `sandbox_mode`.

Exec mode defaults to a **read-only** sandbox.

## 4. config.toml — locations, precedence, model, notify

- User-level: `$CODEX_HOME/config.toml` (`CODEX_HOME` defaults to `~/.codex`).
- Project-scoped: `.codex/config.toml` files, discovered by walking from the project
  root (nearest `.git`; customizable via `project_root_markers`) down to cwd, closest
  file wins — loaded **only when the project is trusted**.
- Per-run: `codex --config key='value'` (TOML-parsed dot notation) or dedicated flags
  like `--model`.

Model keys:

```toml
model = "gpt-5.5"
model_reasoning_effort = "xhigh"   # minimal | low | medium | high | xhigh
model_verbosity = "medium"         # low | medium | high
model_context_window = 400000      # known bug: sometimes not respected (issue #19185)
```

Mid-session: `/model` (two-step: model, then reasoning effort); Alt+, / Alt+. cycle effort.

Notify hook (the turn-completion signal for orchestration):

```toml
# MUST be in user-level config.toml, and MUST precede any [table]
notify = ["python3", "/path/to/notify.py"]
```

Fires on `agent-turn-complete` (currently the only supported event) with one JSON
argument: `type`, `thread-id`, `turn-id`, `cwd`, `input-messages`,
`last-assistant-message`. Ignored in project-local config files.

Session transcripts (rollouts): `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`.

## 5. Non-interactive mode: `codex exec`

```bash
codex exec "fix the failing test in tests/foo_test.py"       # prompt as arg; stdin also works
codex exec --json "task" > events.jsonl                      # JSONL event stream on stdout
codex exec -o /tmp/last.txt "task"                           # write final message to file
codex exec --sandbox workspace-write "task"
codex exec resume --last "follow-up task"                    # continue latest session
codex exec resume SESSION_ID "follow-up task"
codex exec --ephemeral "task"                                # don't persist rollout files
```

Behavior:

- Progress streams to **stderr**; only the final agent message prints to **stdout**
  (pipe-friendly).
- `--json` event types: `thread.started`, `turn.started`, `turn.completed`,
  `turn.failed`, `item.started`/`item.completed` (`item.*`), `error`.
  Minimal happy path: `thread.started → turn.started → item.completed → turn.completed`.
  Abandoned items can carry wrong status at turn end (issue #14691); no documented
  schema-stability guarantee across releases.
- Gotcha: exec can hang when stdin is a non-TTY pipe with no writer (issue #20919) —
  run with `< /dev/null` from scripts.

For a driving agent, `codex exec --json` + `codex exec resume --last` gives
deterministic completion detection and session continuity without any terminal
scraping, and is the preferred integration unless a live TUI is required.

## 6. Slash commands (TUI)

`/init` (create AGENTS.md), `/status`, `/permissions` (renamed from `/approvals`
~v0.130), `/model`, `/review`, `/mcp` (+ `verbose`), `/new`, `/fork`, `/resume`,
`/quit` (alias `/exit`). Confirmed against both docs and codex-rs TUI source
(slash_command.rs / slash_dispatch.rs / permissions_menu.rs).

## 7. MCP support

```toml
[mcp_servers.my-stdio-server]
command = "npx"
args = ["-y", "@some/mcp-server"]
env = { API_KEY = "..." }          # also env_vars, cwd
startup_timeout_sec = 10           # default
tool_timeout_sec = 60              # default

[mcp_servers.my-http-server]
url = "https://example.com/mcp"
bearer_token_env_var = "MY_TOKEN"
```

`/mcp` in the TUI lists configured tools. MCP tool search is on by default per the
mid-2026 changelog. Open question (not settled by primary sources): behavior of MCP
elicitations under granular approval_policy in headless runs.

## 8. Mid-2026 changelog highlights & churn to watch

- Subagents GA (v0.115.0), Smart Approvals, persisted `/goal` workflows.
- `/approvals` removed in favor of `/permissions` (~v0.130).
- Granular `approval_policy` table form since ~v0.122.
- `default_permissions` profiles partially supersede `sandbox_mode`.
- Docs URLs (developers.openai.com/codex/*) 308-redirect to learn.chatgpt.com.

## 9. What is NOT verified (be honest about this)

The research specifically hunted for primary-source tmux send-keys/capture-pane
patterns for the Codex TUI (exact approval-dialog text, keybindings, reliable idle
regexes). **None survived verification.** Practitioner projects exist (e.g.
codex-yolo: an approver daemon polling `capture-pane` every 0.3s to auto-approve
dialogs; awslabs/cli-agent-orchestrator) but their specifics were not confirmed
against current Codex versions. Everything screen-scrape-related in SKILL.md is
therefore heuristic; the `notify` hook (§4) and `codex exec --json` (§5) are the
documented mechanisms to build on.

## Sources (fetched 2026-07-13)

Primary: developers.openai.com/codex/{cli, cli/slash-commands, cli/reference,
config-reference, config-advanced, noninteractive, mcp, changelog};
github.com/openai/codex (docs/slash_commands.md, docs/exec.md, codex-rs source,
issues #14691 #14736 #19185 #20919 #27019 #2288); chatgpt.com/codex/install.sh.
Secondary/practitioner: codex-yolo, awslabs/cli-agent-orchestrator,
codex.danielvaughan.com, shipyard.build, developertoolkit.ai, blakecrosley.com,
ofox.ai, digitalapplied.com, lugha.substack.com, samwize.com,
gist.github.com/alexfazio (81 exec-flag tests).
