---
name: agy-advisor
description: "Consult an Antigravity/Gemini advisor over ACP and get the answer back as a bmad-party-mode round-table, never as a single voice. Use when the user invokes $agy-advisor, wants an opinion from outside both the Claude and the OpenAI families, names the AGY seat, or adds --party <id> to seat a saved bmad-party-mode roster. Read-only: it advises, it never edits."
---

# AGY Advisor

The third sibling of `codex-advisor` and `claude-advisor`. Those two cover the
OpenAI and Anthropic families; this one reaches Gemini through Antigravity, so a
disagreement between all three is worth something a two-family split is not.

**Read `codex-advisor/SKILL.md` for the parts that are the same** — why an
advisor is an ACP lane rather than an agent, how the round-table is assembled
from the answer, and what a consultation with no receipt means. This file
carries only what is DIFFERENT about the AGY seat.

## The command

```bash
# The binary first. `buildProfileEnv` derives this for a REVIEW lane; a lane
# dispatched by hand is not that lane and gets nothing, so the command has to
# do it. The candidates, in order, are the ones `agyBinaryCandidates` builds in
# the party-mode review profiles.
AGY_BIN="$(for c in "$HOME/.local/bin/agy" /usr/local/bin/agy /usr/bin/agy; do
  [ -x "$c" ] && { echo "$c"; break; }; done)"
[ -n "$AGY_BIN" ] || { echo 'no agy binary on this machine — stop, do not let the adapter fetch one'; exit 1; }

env -u ACP_REASONING_EFFORT -u ACP_EXPECT_REASONING_EFFORT \
INITIAL_AGENT_MODE="read-only" \
ACP_SESSION_RECEIPT_REQUIRED=1 \
ACP_SESSION_OPERATION="new" \
ACP_MODEL="<model>" \
ACP_EXPECT_MODEL="<model>" \
AGY_BIN="$AGY_BIN" \
AGY_SKIP_DOWNLOAD=1 \
node <plugin-root>/skills/tmux-teams/scripts/acp-dispatch.mjs \
  agy <cwd> <task-id> <brief-file> [stall-sec]
```

`<model>` is the expanded id of the seat the caller named (see Arguments
below). With no seat named, it is what this prints — the Neon orchestrator, or,
only when `agy models` was read and lacks it, the thinker fallback with the
reason on stderr:

```bash
node <plugin-root>/skills/tmux-teams/scripts/agy-seat-fallback.mjs default thinker
```

A seat the caller NAMED is used as written and never resolved over. It goes in
BOTH assignments: the request
without a matching expectation is a dispatch nobody verified. This command
hardcoded `high` in both places while the Arguments table promised `medium` and
`low`, so `$agy-advisor medium` ran high and produced a high receipt that
MATCHED — a silently ignored seat is worse than a refused one.

Measured 2026-11-15 against `agy` 1.5.9 and `antigravity-acp@1.2.0` rather than
assumed: `session/new` advertises `currentValue: "gemini-4-carbon-medium"` and
22 model options (`gemini-4-carbon-{medium,high,low}`,
`gemini-4-argon-{medium,high,low}`, `gemini-4-hydrogen-{high,xhigh,medium,low}`,
`gemini-pro-orchestrator`, `gemini-pro-orchestrator-argon`,
`gemini-3.8-flash-{high,medium,low}`, six `claude-{opus,sonnet}-5-5-{low,medium,high}`,
and `gpt-oss-120b-medium`), and `session/set_config_option` binds bare ids
verbatim (`gemini-4-carbon-high`, `gemini-4-hydrogen-xhigh`,
`gemini-pro-orchestrator`, `gemini-4-argon-high`). Because `session/new` starts
on `gemini-4-carbon-medium`, setting BOTH `ACP_MODEL` and `ACP_EXPECT_MODEL`
explicitly is load-bearing; the lane accepts all three contract variables,
writes a receipt, and reports `effective_identity: gemini-4-carbon-high (matched)`.

Re-measured 2026-11-19 against `agy` 1.5.12, same adapter: `session/new` now
advertises 27 options and starts on `currentValue: "gemini-4-neon-high"`; the
five new ones are `gemini-4-neon-{high,xhigh,medium,low}` and
`gemini-pro-orchestrator-neon`, the default seat. `agy models` prints the same
27 ids, which is the list `default thinker` reads.

Measured 2026-11-23 against `agy` 1.5.14 and `antigravity-acp@1.2.0`: the
adapter loads `~/.agy-acp/models.json` synchronously at startup and spawns
`agy models` asynchronously (~5s), pushing fresh options in a `session/update`
(`config_option_update`) notification. When a requested seat (such as
`gemini-4-carbon-high`) is missing from a stale or cold cache on `session/new`,
`acp-companion.mjs` waits up to 12s for `config_option_update` to advertise it
before running `session/set_config_option`, and still fails closed at
`config-option-invalid` if the refreshed catalog does not carry it.
Antigravity's advertised model list is also per-account, so if
`config-option-invalid` still fires after the 12s refresh wait, run `agy models`
to verify the active account provisions that seat.

## What differs from the Codex seat

**No reasoning-effort knob.** `codex-advisor` locks `ACP_REASONING_EFFORT=ultra`
and verifies it, so its identity reads
`gpt-6.2-sol[ultra]`. The Antigravity
adapter has no such dimension — the AGY identity is the bare model id, and
sending `ACP_REASONING_EFFORT` here asks for a config option the adapter does not
advertise, which fails the dispatch before the prompt.

**So the command CLEARS both variables rather than merely not setting them.** A
shell that has just dispatched a codex lane still carries
`ACP_REASONING_EFFORT` and `ACP_EXPECT_REASONING_EFFORT`, and
`acp-dispatch.mjs` forwards the whole caller environment. Measured: dispatched
from such a shell, the lane's `dispatch-routing/<task-id>.json` records both —
and `ROUTING_ENV_KEYS` is what a `resume` command is rebuilt from, so the
inherited effort outlives the dispatch that inherited it. Not setting a
variable is not the same as clearing it.

**The adapter advertises `<id>\t<display label>` — with a TAB.** The pre-check
accepts either the full advertised string or the bare id, and the bare id is what
the adapter reports back as applied. Send the bare id. A value copied out of a
rendered log has a SPACE where the real string has a tab, and a tab rendered as
whitespace is how this seat spent months carrying an identity exemption it did
not need.

**It needs its executable, not a package manager.** `AGY_BIN` names the binary
and `AGY_SKIP_DOWNLOAD=1` stops the adapter fetching its own. `buildProfileEnv`
sets both for a REVIEW lane; a lane dispatched by hand is not that lane and gets
neither — which is why the command above derives them rather than assuming.
This paragraph described that gap accurately while the command printed directly
above it walked straight into it, for the whole of v0.33.0's review cycle.

## Model policy — this is the part that fails closed

The default seat is `gemini-pro-orchestrator-neon` (Master, 2026-11-19), for
this advisor and for every other AGY role. The orchestrator thinks with Neon and
sends its subagents to work on Hydrogen, so it is faster and cheaper than pure
Neon. Measured that day: live `antigravity-acp@1.2.0` on `agy` 1.5.12 advertises
it in `session/new` configOptions. (Before: `gemini-4-carbon-high` from
2026-11-15, `gemini-4-argon-high` from 2026-10-17.)

**Fallback is about this MACHINE, never about quota.** Run
`agy-seat-fallback.mjs default thinker` first. It reads `agy models` (10s
timeout, cached per process):

- the list carries `gemini-pro-orchestrator-neon` → it prints that id, nothing on stderr;
- the list was read and LACKS it → it prints `gemini-4-hydrogen-xhigh` (thinker;
  `default worker` prints `gemini-4-hydrogen-medium`) and states requested,
  used and why on stderr — carry that line into the report, never switch silently;
- the list could not be read (no binary, timeout, exit ≠ 0) → it keeps Neon, and
  the companion's set-and-acknowledge pre-check fails closed if Neon is really absent.

A seat the caller named (`$agy-advisor hydrogen-high`, a full id) or a
`lanes.json` model override is used as written — never resolved over. A 429 is
NOT a reason to fall back: see the rate-limit section.

**Gemini 3.1 variants are PROHIBITED for planning, review and delivery work.**
If a configured or acknowledged model is a 3.1 variant, fail the dispatch — do
not fall back to it, and do not proceed on the grounds that a lane answered.

Verify the ACKNOWLEDGED identity, never the requested one. The adapter's own
default has moved underneath a pin before: a release panel recorded the adapter
advertising 3.7 while this repository still pinned 3.6, and the set-and-
acknowledge succeeded, so the lane really did run what it was told — but nothing
would have noticed if it had not. On `agy` 1.5.9 an unrequested `session/new`
defaults to `gemini-4-carbon-medium`, so leaving `ACP_MODEL` /
`ACP_EXPECT_MODEL` unset would silently run the medium tier.

## Rate-limit diagnosis — no automatic fallback (shared quota pool)

Measured 2026-10-21: a real dispatch (`pmd-review-agy`,
`ACP_MODEL=gemini-4-argon-high`) died on the Antigravity individual quota. The
runner log carried
`AGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED (code 429): Individual quota reached...","status":"RESOURCE_EXHAUSTED","error_code":429,"retryable":true,...}`
— and the liveness record ended `liveness_state: "failed"` with
`termination_reason: "protocol_error"`. **The termination_reason is a red
herring**: it names the protocol frame the companion died on, not the provider
condition underneath it, so the ONLY evidence is in the runner log. A
classifier that read the liveness record alone would miss every one of these.

The rule (Master, 2026-11-15, superseding the 2026-10-30 3.8 Flash fallback):
Antigravity shares one quota pool across ALL Gemini seats
(`gemini-4-carbon-*`, `gemini-4-argon-*`, `gemini-4-hydrogen-*`,
`gemini-pro-orchestrator*`, and `gemini-3.8-flash-*` share the same remaining
percentage and reset timestamp). Never downgrade or re-dispatch on another Gemini
seat for cost or quota — aligned with `codex-advisor` ("Never downgrade for
cost or quota") and `claude-advisor` ("Never downgrade for cost, quota or speed
on your own initiative"). Automatic seat fallback is retired, and
`agy-seat-fallback.mjs seat <model>` now exits `2` unconditionally.

Use the classifier to separate quota deaths from protocol failures:

```bash
# Classify the failure. Exit 0 = rate-limited, the excerpt names the line
# and where it came from; exit 1 = no rate-limit evidence; exit 2 = usage
# or an invalid task id.
node <plugin-root>/skills/tmux-teams/scripts/agy-seat-fallback.mjs rate-limited <cwd> <task-id>
```

When `rate-limited` exits `0`, STOP and report the quota excerpt and reset
window to the operator. Never hop automatically to another Gemini seat, another
family, or Gemini 3.1. Identity refusals, prohibited models, a missing binary,
and an unreadable brief keep failing closed as before.

## Arguments

```
$agy-advisor                     # default seat: gemini-pro-orchestrator-neon (via `default thinker`)
$agy-advisor orchestrator-neon   # gemini-pro-orchestrator-neon (Orchestrator Neon)
$agy-advisor neon-xhigh          # gemini-4-neon-xhigh
$agy-advisor neon-high           # gemini-4-neon-high
$agy-advisor neon-medium         # gemini-4-neon-medium
$agy-advisor neon-low            # gemini-4-neon-low
$agy-advisor high                # gemini-4-carbon-high
$agy-advisor medium              # gemini-4-carbon-medium
$agy-advisor low                 # gemini-4-carbon-low
$agy-advisor carbon              # gemini-4-carbon-high
$agy-advisor carbon-high         # gemini-4-carbon-high
$agy-advisor carbon-medium       # gemini-4-carbon-medium
$agy-advisor carbon-low          # gemini-4-carbon-low
$agy-advisor argon-high          # gemini-4-argon-high
$agy-advisor argon-medium        # gemini-4-argon-medium
$agy-advisor argon-low           # gemini-4-argon-low
$agy-advisor hydrogen-xhigh      # gemini-4-hydrogen-xhigh
$agy-advisor hydrogen-high       # gemini-4-hydrogen-high
$agy-advisor hydrogen-medium     # gemini-4-hydrogen-medium
$agy-advisor hydrogen-low        # gemini-4-hydrogen-low
$agy-advisor orchestrator        # gemini-pro-orchestrator (Orchestrator Carbon)
$agy-advisor orchestrator-argon  # gemini-pro-orchestrator-argon (Orchestrator Argon)
$agy-advisor flash-high          # gemini-3.8-flash-high
$agy-advisor flash-medium        # gemini-3.8-flash-medium
$agy-advisor flash-low           # gemini-3.8-flash-low
```

A bare alias is expanded, or any of the 20 full Gemini ids above
(`gemini-4-neon-*`, `gemini-4-carbon-*`, `gemini-4-argon-*`, `gemini-4-hydrogen-*`,
`gemini-pro-orchestrator`, `gemini-pro-orchestrator-argon`,
`gemini-pro-orchestrator-neon`, `gemini-3.8-flash-*`) may be passed verbatim into BOTH `ACP_MODEL` and
`ACP_EXPECT_MODEL`, and the receipt must show that exact id. Any other name is
a usage error — do not pass a model through unrecognised, because an unknown
value either fails the dispatch or silently seats something nobody chose.
`claude-*`, `gpt-oss-*`, and `gemini-3.1*` remain refused.

### `--party <id>` — seat a saved bmad-party-mode roster

Any seat above also takes `--party <id>`, the same flag `bmad-party-mode` takes.
Instead of the lane inventing 3-5 voices, it answers as the operator's own saved
party — real names, titles and scene. One script renders the roster so all four
`*-advisor` skills seat it the same way:

```bash
node <plugin-root>/skills/tmux-teams/scripts/advisor-party.mjs <id>
```

`<plugin-root>` — the same spelling every dispatch command in this file uses,
expanded to `$CLAUDE_PLUGIN_ROOT` when you run it. NOT a repository-relative
path: an advisor is invoked from the operator's own project, where
`plugins/tmux-teams/...` resolves under THAT tree and exits `MODULE_NOT_FOUND`,
so `--party` would never reach the resolver. An openai review lane caught the
relative form in all four skills at once.

### Automatic party selection

If the operator names no room, or names `auto`, the script chooses a saved room
from the assigned work instead of inventing a cast. Pass the brief as a file:

```bash
node <plugin-root>/skills/tmux-teams/scripts/advisor-party.mjs auto --task-file <brief>
```

Leaving the id off entirely (`--task-file <brief>` alone) does the same thing.
Selection is a deterministic keyword count over the brief against the
`SELECTION_CATALOG` constant in `advisor-party.mjs` (documented for maintainers at
`_bmad-output/specs/spec-advisor-party-type/selection-catalog.md`); it makes no
network or model call.
A named id still wins and takes the resolve-or-refuse path unchanged.

On a hit, stdout is byte-identical to the mandate for that id seated explicitly,
so paste it into the brief exactly as above. One `selected-party: <name> (<id>)`
line goes to **stderr** — that is where the operator reads which room was chosen;
it is never part of the brief. Exit `0` means a room was selected.

Exit `3` means auto selection found no room (no catalog keyword hit, or a tie at
the top score): stdout is empty. **On `3`, emit the original "Cast 3-5 named
voices" paragraph and tell the operator that no saved room matched.** Auto never
fails open to a guessed room. Exit `2` here means `task_file_unreadable` (no
readable `--task-file`) or a resolver refusal — stop and tell the operator, as
with any `2`. Exit `1` is a command-usage error.

Paste what it prints into the brief **in place of** the invented-cast paragraph
(the one that asks for three to five named voices); leave the READ-ONLY paragraph
exactly as it is. Exit `0` is the only
success. Exit `2` names why it refused — `unknown_party` (with the ids that do
exist), `not_installed` (bmad-party-mode is a separate install, not shipped
here), `uv_missing`, `resolver_failed`, or `party_substituted` (the resolver
answered with a different party than the one asked for) — and on `2` **stop and
tell the operator, then ask whether to run with the invented cast instead.**
Exit `1` is a USAGE error in the command you typed — a missing id, a flag with
no value, an extra argument — and it prints the usage line and nothing else; fix
the command and run it again. A zai review lane found this section naming only
`0` and `2`, which left a lane that branches on those two with no rule for `1`
and free to proceed with the invented cast. Never substitute silently: someone
who typed `--party` asked for a specific room.

**This said "One seat" until 2026-08-19, and it was false the day it was
written.** Probed against `agy` 1.5.9 (2026-11-15), the adapter advertises
TWENTY-TWO values: the ten Gemini 4 Carbon, Argon, and Hydrogen seats (Carbon
and Argon at low/medium/high; Hydrogen at low/medium/high/xhigh), two
Orchestrator seats (`gemini-pro-orchestrator` and `gemini-pro-orchestrator-argon`),
three Gemini 3.8 Flash seats at low/medium/high, six Anthropic 5.5 seats (Opus
and Sonnet at low/medium/high), and a GPT-OSS one (`agy` 1.3.5 on 2026-10-17
advertised thirteen; earlier adapter versions advertised fourteen, including
3.7/3.6/3.5 Flash and both Gemini 3.1 Pro seats). The sentence came from an
assumption instead of a measurement.

## Two refusals, and they are not style

**Gemini 3.1 is PROHIBITED** and older adapter versions advertised
`gemini-3.1-pro-high` and `gemini-3.1-pro-low`, so it remains guarded in case
an older binary or cached model list is present. The companion refuses both the
request and the expectation and exits 2 before a session exists — measured, not
assumed. Never route around it.

**Never send a `claude-*` or `gpt-oss-*` value through this lane.** The adapter
will take them, and the moment it does, this seat stops being the Gemini family:
a three-family panel would be one lane wearing three names. The point of this
advisor is the family, not the endpoint.

## The consultation is a party. Only a party.

The advisor MUST answer as a `bmad-party-mode` round-table: several named voices
who argue with each other and are not reconciled into consensus. A single-voice
answer is a failed consultation — say so rather than passing it on.

Put the mandate in the brief, in these words:

```
Answer as a bmad-party-mode round-table. Cast 3-5 named voices with
distinct expertise and real disagreements. They address each other, not
me. Do not reconcile them into one recommendation.
```

John (PM), Sally (UX) and Grumbal (The Adversary) are mandatory; others as the
topic needs. An advisor that reports as one voice has thrown away the reason it
was asked.
