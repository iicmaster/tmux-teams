---
name: lane-setup
description: 'Use as the mandatory setup whenever a review lane cannot start on this machine — when `acp_lanes` reports `setupRequired`, when a lane comes back `available: false`, or when `acp_lane_probe` refuses a lane with `executable_absent`, `executable_not_file` or `launcher_absent`. It reports what this machine is missing per lane, writes the per-machine override file, and re-checks that the lane became callable. Triggers: "lane setup", "ตั้งค่าเลน", "เลนใช้ไม่ได้", "executable_absent", a lane refused before it started, a fresh machine that has never run a review lane.'
---

# lane-setup — make this machine able to call a lane, then prove it

The plugin declares its lanes in a shipped file. Whether *this* machine can run
one is a different question, and until v0.36 nothing asked it: a lane whose
wrapper was not installed looked exactly like a working lane, right up until a
dispatch failed with a timeout that named the symptom instead of the cause.

Now the listing refuses such a lane before spawning anything and points here.
**This skill is what it points at.**

## The three commands

```bash
node plugins/tmux-teams/skills/party-mode/scripts/lane-setup.mjs check
node plugins/tmux-teams/skills/party-mode/scripts/lane-setup.mjs set <lane> <key> <value>
node plugins/tmux-teams/skills/party-mode/scripts/lane-setup.mjs show
```

`check` reports what is missing and what would fix it; `set` writes one override
and then RE-CHECKS; `show` prints the current per-machine file. From an
installed plugin the same script sits under `$CLAUDE_PLUGIN_ROOT`.

`check` exits `2` when setup is required and `0` when nothing blocks a dispatch.

## How to run it

1. **`check` first, always.** It names each lane, what it needs, and the closed
   code for whatever is missing. Read the code, not the lane name — the repair
   for `executable_absent` and `launcher_absent` are different repairs.
2. **Decide with the operator, do not guess for them.** A missing wrapper has
   two honest answers: install it, or point the lane at one they already have.
   This skill never installs anything and never edits `PATH`.
3. **`set` writes and re-checks in one step.** The re-check is the outcome —
   the write is not. If the lane is still not callable it says so and why.
4. **Read the re-check out loud.** "It is now callable" and "the file was
   written" are different claims, and only the first one is the job.

## The overridable fields

`command` · `claudeExecutable` · `adapterPackage` · `model` · `env`

`command` and `env` take JSON; the rest take a plain string.

```bash
node plugins/tmux-teams/skills/party-mode/scripts/lane-setup.mjs set codex env '{"NPM_CONFIG_CACHE":"/path/to/a/cache"}'
node plugins/tmux-teams/skills/party-mode/scripts/lane-setup.mjs set ninerouter claudeExecutable claude-9r-alt
```

## Rules

- **The file lives at `~/.config/tmux-teams/lanes.json`, never beside the
  plugin.** A plugin install is version-keyed, so anything written into its
  cache is destroyed by the next `claude plugin update` — the exact moment an
  operator most needs their machine's settings to survive.
- **A broken file is refused whole, and setup says so.** Nothing in it applies
  until it parses. An operator who wrote an override is saying the shipped
  default does not work here; running the default anyway reproduces their
  original failure while the fix appears to be applied.
- **The real environment beats the file.** `FOO=bar` in front of a command wins
  over a value edited last week, which is how every lane failure in v0.35.0 was
  actually diagnosed.
- **This skill writes; the MCP server does not.** ADR 0007 draws its line at
  "answering questions is a different thing from a surface that can act on an
  operator's behalf". Reading readiness answers, writing a bin path acts. MCP
  consumes this file.
- **Never put a credential in this file.** It holds names and paths. Provider
  tokens live where each wrapper already keeps them, and nothing here reads or
  writes one.
- **Setup cannot SEE a bill, let alone fix one.** A `402` membership or a
  missing payment method is a fact about an account, and it only becomes visible
  when a completion is attempted. `check` contacts nothing — it resolves PATH and
  reads files — so a lane with every binary in place and no credit reports as
  callable here and fails at dispatch. That is not a bug in `check`; it is the
  boundary of a free check, and this line said "reports those honestly" until an
  openai review lane pointed out that it cannot. To see a billing failure, probe
  the lane at prompt depth: `acp_lane_probe` with `depth: "prompt"`, which spends
  real quota and is the only thing that can.
