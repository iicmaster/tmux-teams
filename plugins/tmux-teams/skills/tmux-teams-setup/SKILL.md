---
name: tmux-teams-setup
description: "Check and bootstrap the free prerequisites for tmux-teams — bmad-method@6.12.4, OpenCode v2 (@opencode/cli@2.3.2 with 11 free models including 3+ verified models for zero-cost party-auto review), bmad-party-mode, uv / python3 >= 3.11, and local plugin cache status. Use when setting up a fresh machine, missing bmad or opencode, updating tmux-teams caches, or when user says setup tmux-teams, install bmad, install opencode, ติดตั้ง bmad, ติดตั้ง opencode, อัพเดท plugin."
---

# tmux-teams Setup

Prerequisite verifier and bootstrapper for machines that do not yet have
`bmad-method` and `opencode` installed.

Because OpenCode (`@opencode/cli@2.3.2`) ships more than three distinct free
models (`deepseek-v4.1-flash-free`, `inkling-2-small-free`,
`mimo-v2.6-flash-free`, `hy4-flash-free`, `longcat-2.5-free`, and others — with
the first three live-verified keyless via `opencode acp` `session/prompt` and
`REVIEW_GATE_MODE=opencode-free` `review-gate.mjs` under an ephemeral keyless
`$HOME` whose `$HOME/.local/bin/npx` launches `@opencode/cli@2.3.2`), a fresh
machine with only **BMAD** + **OpenCode** can run `party-auto` right away
using opt-in `REVIEW_GATE_MODE=opencode-free`.

## Commands

Run the bundled CLI directly with `scripts/tmux-teams-setup.mjs` (resolved under
`<skill-root>/scripts/tmux-teams-setup.mjs`):

```bash
# 1. Inspect prerequisites, auth.json state (metadata-only), and plugin caches
node <skill-root>/scripts/tmux-teams-setup.mjs check --project-root <repo>
node <skill-root>/scripts/tmux-teams-setup.mjs check --project-root <repo> --json

# 2. Preview install plan without executing install steps or modifying the target project
#    (dry-run is default; cache discovery uses a temporary cwd and calls `npm config get cache`,
#    which may perform npm's own housekeeping in the user's npm cache/log directory)
node <skill-root>/scripts/tmux-teams-setup.mjs install --dry-run --project-root <repo>

# 3. Execute pinned bootstrap (`bmad-method@6.12.4` + `@opencode/cli@2.3.2` cache warm
#    + copies global bmad-party-mode only from a fresh `install-bmad` run or with
#      explicit `--allow-project-party` opt-in when ~/.claude/skills/bmad-party-mode is absent)
node <skill-root>/scripts/tmux-teams-setup.mjs install --yes --project-root <repo>

# Opt-in: explicitly trust/promote an existing project checkout's bmad-party-mode scripts
node <skill-root>/scripts/tmux-teams-setup.mjs install --yes --allow-project-party --project-root <repo>

# Optional: also write a closed ACP execution profile for receipt-required $oc-advisor
node <skill-root>/scripts/tmux-teams-setup.mjs install --yes --with-profile --project-root <repo>

# 4. Inspect bundled version vs ~/.claude, ~/.codex, ~/.zcode, ~/.gemini caches
node <skill-root>/scripts/tmux-teams-setup.mjs plugin-status --json
```

If `--dry-run` and `--yes` are passed together, `--dry-run` always wins.

## Out-of-the-Box Free `party-auto`

Default `review-gate.mjs` (`strict` mode) requires AGY plus two distinct
reviewers (prefers three families; after fallback may seat AGY plus two distinct
OpenCode models). When a fresh host has only free OpenCode models, opt in
explicitly without weakening the default strict gate:

```bash
REVIEW_GATE_MODE=opencode-free \
node <plugin-root>/skills/party-mode/scripts/review-gate.mjs <packet.json> <abs-repo>
```

`opencode-free` seats three distinct live-verified free OpenCode models
(`deepseek-v4.1-flash-free`, `inkling-2-small-free`, `mimo-v2.6-flash-free`),
skips any model matching the primary, walks the nine v2.3.2-present OpenCode
rungs before the absent `glm-5.3-flash-free` compatibility rung on quota failure,
and labels `singleProviderQuorum: true` on the gate report. Note that
`review-gate.mjs` requires `npx` inside a trusted runtime root (such as
`$HOME/.local/bin`, `$HOME/.nvm/versions/node`, or `/usr`); standalone Homebrew
`/opt/homebrew/...` paths outside those roots require a symlink or `nvm` install.

## Safety & Manual Prerequisites

- **No unsafe project root**: `--project-root` refuses `/`, `$HOME`, and paths
  inside the `plugins/tmux-teams` plugin directory.
- **Closed `--with-profile` output**: `--with-profile` writes atomically with mode
  `0600`, replacing an existing regular profile file at the output path while
  refusing symlinks and directories along the path.
- **No `curl | bash` automation**: `install` runs only npm-pinned packages via
  `npx -y bmad-method@6.12.4` and `npx -y @opencode/cli@2.3.2`.
- **Python runtime for `bmad-party-mode`**: `<plugin-root>/skills/tmux-teams/scripts/advisor-party.mjs`
  prefers `uv` and automatically falls back to `python3 >= 3.11` with secret
  environment variables scrubbed if `uv` is absent. Install `uv` manually via
  your OS package manager (e.g., `brew install uv` on macOS) if desired.
- **OpenCode `auth.json` safety**: Free OpenCode seats run keyless. `check` inspects
  `~/.local/share/opencode/auth.json` for metadata only (never echoes contents or
  raw parse errors). If you see an expired credential warning, renew or remove
  stored `opencode` keys manually (`opencode auth logout` / edit the file
  yourself).
- **Updating plugin caches**: `plugin-status` never overwrites local caches. Run
  `claude plugin update tmux-teams` manually when caches lag, or ask an operator
  before touching target-specific cache patches (for example ZCode local repairs).
