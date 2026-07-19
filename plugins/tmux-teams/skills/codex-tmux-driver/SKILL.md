---
name: codex-tmux-driver
description: "Drive an OpenAI Codex CLI interactive session via tmux — launch codex with the right approval/sandbox flags, submit prompts reliably, detect working/idle/approval states, catch turn completion reliably (outbox contract first, notify hook, stability polling), capture results, and resume sessions. Use when delegating coding work to a live Codex TUI inside tmux, babysitting a long Codex run, or handling Codex approval prompts. ใช้เมื่อต้องขับ/สั่งงาน Codex CLI แบบ interactive ผ่าน tmux จาก Claude Code. For one-shot headless runs prefer codex exec (see references). NOT for orchestrating many mixed agents as PM (use tmux-teams)."
metadata:
  author: ngs
  scope: claude
---

# Codex tmux driver

Drive a live Codex CLI TUI from Claude Code through tmux. Codex-specific knowledge
lives here; the generic tmux mechanics (send/verify/retry, PM discipline) live in
`tmux-teams` and `interactive-agent-driver` — don't re-derive them.

Facts below marked "field-verified" were measured on codex-cli 0.144.1
(2026-07-14, macOS, tmux 3.6a) — including a Codex self-audit run. Re-verify after
any upgrade.

## Decision gate: tmux TUI vs `codex exec`

| Situation | Use |
|---|---|
| One-shot task, scriptable, no human handoff | `codex exec` — headless; `--json` emits JSONL lifecycle events (watch `turn.completed` / `turn.failed`), `--output-last-message FILE` captures the final answer; `codex exec resume --last` continues a prior non-interactive session (references §5) |
| Human may take over the pane, interactive pickers/approvals, live mid-run steering | tmux TUI — this skill |

If you only need an answer or a diff out of Codex, `codex exec` is structurally
more observable than screen-scraping (events, not pixels) — though not
infallible: it can still wait on stdin, fail on network/auth, or end in
`turn.failed`. Session continuity alone no longer requires the TUI
(`codex exec resume` exists); reach for tmux when a human needs eyes or hands on
the session.

## 1. Launch

```bash
codex --version   # command surface churns across 2026 releases — check before scripting keystrokes
tmux new-session -d -s auto--myapp--codex -c /path/to/project -x 220 -y 50
tmux send-keys -t auto--myapp--codex 'codex -a on-request -s workspace-write' Enter
sleep 8; tmux capture-pane -t auto--myapp--codex -p    # confirm boot; answer trust dialog before dispatching
```

Field-verified boot gotchas:

- A launch command sent right after `new-session` can be lost to a generic
  shell/tmux startup race (not a Codex behavior) — if the pane still shows a bare
  shell prompt after the wait, check `pane_current_command` and resend.
- **Boot dialogs are keystroke traps.** The trust-directory dialog accepted a bare
  digit with no Enter in this build; other dialogs (update prompt, MCP/auth) may
  differ. Capture the dialog, follow ITS displayed hints, send the minimum keys —
  a stray Enter risks landing in the composer as a junk prompt (observed once,
  not reliably reproducible; treat as a risk, not a law).
- After boot, run `/status` and read `Permissions:` — CLI flags override
  config.toml defaults (field-verified: `-a never -s workspace-write` won over a
  config set to `danger-full-access`), but verify per session; don't trust flag
  precedence blind.

Approval/sandbox flags (decide BEFORE launch — keystroke-driving approval dialogs
is the most fragile part of the whole loop):

| Flag | Values | Note |
|---|---|---|
| `-a, --ask-for-approval` | `untrusted` \| `on-request` \| `never` | `never` + `workspace-write` = no command-approval prompts, writes constrained to the effective workspace permission set (cwd need not be a git repo; `--add-dir` widens it) |
| `-s, --sandbox` | `read-only` \| `workspace-write` \| `danger-full-access` | `workspace-write` blocks network by default (config `[sandbox_workspace_write] network_access`) |
| `--dangerously-bypass-approvals-and-sandbox` (`--yolo`) | — | only in disposable/isolated environments |
| `--model NAME` / `--config key='value'` | e.g. `gpt-5.5` | per-run config.toml override |
| `codex resume --last` / `codex resume SESSION_ID` | — | `--last` is scoped to the **current cwd** and skips non-interactive sessions; use `--all`, `--include-non-interactive`, or an explicit id otherwise |

## 2. Submit a prompt

The generic protocol (send-keys `-l` → Enter as a separate call → verify after ~2s →
conditional retry) is owned by `tmux-teams` §2 — follow it verbatim, don't re-derive
it here. Codex specifics on top:

- Observed swallow rate on this TUI: the paste-Enter was swallowed on **every
  dispatch of one field session (4/4)**. A local rate, not a universal law — but
  it makes verification-before-watching mandatory either way.
- Text still sitting in the `›` composer proves NOT submitted → retry Enter. The
  converse is weaker: a fast turn can enter and leave Working between polls, so
  absence of a Working marker is inconclusive — when in doubt, confirm by
  artifact (outbox file / rollout JSONL), not the screen.
- **Long pastes can collapse to a `[Pasted Content N chars]` placeholder**
  (field-bitten 2026-07-17, ~1000 chars; stochastic — the same-length brief
  collapsed in one window and not another). The brief text is then invisible, so
  a text-match check wrongly reads "submitted". Enter on an empty composer is a
  no-op → no Working marker within ~6s = retry Enter unconditionally.
- **If oh-my-codex (or a similar orchestration layer) is installed, open-ended
  verbs like "review" can trigger its multi-agent workflows** — the session
  stalls in a "Waiting for agents" loop. Field-verified hijack. Start briefs with
  "Work alone — do not spawn, dispatch, or wait for any agents or subagents"
  unless you actually want that behavior.
- For repeated/queued dispatch, run the proven mailbox delivery loop
  (`tmux-teams` `scripts/deliver.sh`: pane-id targeting, single owner of the
  retry dance, queueing at turn boundaries) instead of hand-rolling send-keys.

## 3. State detection

```bash
tmux capture-pane -t auto--myapp--codex -p -S -15
```

| Pane shows | State | Action |
|---|---|---|
| `›` with empty composer AND no work marker | IDLE | dispatch next prompt |
| `›` with your text still in composer | PENDING_INPUT | send `Enter` again |
| `Working (Ns • esc to interrupt)` — lowercase `esc` (calibrated v0.144.1) | WORKING | wait (§4) |
| Dialog listing a command/patch with options like `Yes` / `No` / `Always allow` | AWAITING_APPROVAL | §6 |
| Composer gone, shell prompt back | EXITED | verify via `pane_dead` / `pane_current_command` — a `Token usage:` summary MAY print on exit but is not guaranteed; relaunch + `codex resume --last` (same cwd) |

Calibration notes (field-verified): the spinner prefix alternates `◦`/`•`; grep on
the stable substring `esc to interrupt` (case-sensitive — it is NOT capitalized).
The `›` composer hint line stays visible **during** Working, so glyph-present alone
≠ idle; idle = glyph present AND composer empty AND no work marker. Marker text
churns between versions — recheck after any codex upgrade. The robust idle test is
**stability**: N consecutive clean polls, not marker-appears-then-disappears (a
fixed-interval poll can miss the whole working window; `tmux-teams` §3) — and even
that is a heuristic; prefer structured events or the run's explicit artifact.

## 4. Completion detection — outbox file first, notify as diagnostics

**Field finding: a wrapped notify chain produced zero observable turn events for a
whole session.** Root cause not established — wrappers in the chain swallow errors,
and one installed hook deliberately exits silently for cwds it doesn't manage — so
the lesson is narrower but firm: never trust a notify chain you haven't
baseline-tested link by link (minimal append-only sink, check exit status), and
never treat notify as the authoritative completion signal.

Authoritative signal, in order:

1. **Outbox file contract** (when dispatching via the mailbox pattern, `tmux-teams`
   §6): the brief instructs Codex to write its answer to a run-scoped file, with
   the sentinel as the file's LAST line. The only signal that never lied in field
   runs — but validate freshness + content + sentinel, not bare existence: Codex
   can write the file before its final message, write a partial file, or fail
   after writing.
2. **Notify hook** — when it fires, it's the cleanest push signal. Config lives in
   `$CODEX_HOME/config.toml` (`CODEX_HOME` defaults to `~/.codex`), top of file
   before any `[table]` (both constraints hard):

   ```toml
   notify = ["/bin/bash", "/path/to/codex-notify.sh"]   # script: echo "$1" >> turns.jsonl
   ```

   Payload on `agent-turn-complete`: `type`, `thread-id`, `turn-id`, `cwd`,
   `input-messages`, `last-assistant-message`. If a notify chain already exists,
   never overwrite it — chain or fall back to (1)/(3).
3. **Pane-stability loop** — 3 consecutive clean polls (no `esc to interrupt`),
   always paired with a hard timeout (`tmux-teams` §3).

Full session transcript is also on disk at
`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` — a structured event log you can
extract the final assistant message from. `codex exec --ephemeral` persists no
rollout.

## 5. Capture results

Scrollback capture protocol (command, capture-BEFORE-next-dispatch rule) is owned by
`tmux-teams` §4. Codex-specific: prefer the outbox file (mailbox pattern), the notify
payload's `last-assistant-message`, or the rollout JSONL over pane text when you need
the exact final answer — pane capture is the diagnostic, not the data path.

## 6. Approval prompts

Prevention helps but is not absolute: `-a`/`-s` suppress **command-approval prompts
only** — trust, update, MCP-elicitation, and auth dialogs still appear, so a driver
needs a bounded unexpected-dialog state. If a dialog appears: capture the FULL
dialog first, read what is being approved, then follow the keys IT displays —
approval dialog kinds vary within 0.144.1; don't blindly reuse trust-dialog
keystrokes. Never blind-approve escalations to `danger-full-access` or
destructive-looking commands — surface those to the user. Treat observed dialog
wording as version-specific and re-verify after upgrades.

## 7. Slash commands & session lifecycle

Send as ordinary text + Enter, one at a time:

| Command | Effect |
|---|---|
| `/status` | model, directory, permissions, account, limits — token/context usage when available (absent on a fresh session) |
| `/model` | switch model + reasoning effort (two-step picker) |
| `/permissions` | permission-profile picker: sandbox + approvals together (formerly `/approvals` in older builds; rename version unverified) |
| `/new` | fresh task, same TUI |
| `/fork` | branch the current task into a new one |
| `/resume` | interactive picker (arrow keys) — from a script prefer `codex resume --last` at launch (cwd-scoped, see §1) |
| `/review` | review current changes |
| `/mcp` | list configured MCP tools (`/mcp verbose` for servers) |
| `/init` | generate AGENTS.md (see `codex-md-management` for upkeep) |
| `/quit` | exit |

Restart only when exited/crashed or context is truly unusable. At idle: `/quit`,
or a single `C-c` then VERIFY process state — **the first `C-c` already exits an
idle TUI in 0.144.1; a blind second `C-c` reaches whatever owns the terminal
next**. While Working: send `Esc` once (the displayed interrupt), wait for idle,
then exit deliberately. Relaunch with `codex resume --last` from the same cwd.
Accumulated context is valuable — don't recycle sessions casually.

## Pitfalls (verified)

- **Version churn is the #1 risk**: `/permissions` supersedes `/approvals` (rename
  version unverified); `approval_policy` also accepts a granular object on
  0.144.1; `default_permissions` selects a permission profile (`:read-only`,
  `:workspace`, `:danger-full-access`, or a custom profile) and must NOT be
  combined with `sandbox_mode` / `[sandbox_workspace_write]`. Pin and check
  `codex --version` first.
- `codex exec` waits while ANY writer holds its non-TTY stdin open (a writer-less
  pipe EOFs immediately); piped data is appended to the prompt as a `<stdin>`
  block. Append `< /dev/null` whenever no supplemental stdin is intended.
- `notify` is ignored in project-local `.codex/config.toml` and must precede TOML
  tables (verified via app-server `config/read`).
- Orchestration-layer hijack of open-ended briefs — see §2.
- No stable, versioned screen-scraping contract for the Codex TUI was found in the
  sources consulted — the markers above are field calibration, not an API.

Deep reference (install, auth, config.toml, MCP, exec mode, sources):
`references/codex-cli-reference.md`
