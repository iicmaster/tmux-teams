---
name: claude-advisor
description: "Consult a Claude-protocol advisor over ACP and get the answer back as a bmad-party-mode round-table, never as a single voice. Defaults to the top Claude model (fable at the session's effort); optionally takes a routing pair — $claude-advisor <bin> <model> — to reach k3, qwen3.8-max, deepseek, glm or the operator's local 9Router gateway (claude-9r) through a routed profile. Use when the user invokes $claude-advisor, asks for a second opinion, names a specific advisor seat, or adds --party <id> to seat a saved bmad-party-mode roster. Read-only by brief and by this skill issuing no write instruction; unlike the Codex lane there is no mode switch to enforce it."
---

# Claude Advisor

A consultation lane. It asks a Claude-protocol seat a question and returns a
round-table.

**On the default seat it can prove which model answered; on a routed seat it
cannot, and this line used to promise both.** A panel lane read the headline —
"can prove which model answered" — against this file's own paragraph fifty lines
down, which says a receipt recording `effective_identity: opus` has told you
nothing about who answered, because `opus` on three different bins reaches three
different vendors. Both cannot be true.

What holds: the default seat asks for `claude-fable-5` and the receipt binds
that exact string, so the identity IS the model. A ROUTED seat asks a gateway
for an alias, and the receipt records the alias — the `<bin>` and the endpoint
are the facts, the alias is a slot. Prove a routed seat's family from its
endpoint, never from its identity.

## What this skill actually guarantees

Not "the most expensive model". **Provable identity.** The default seat is the
top Claude model; a caller may name a different one, and the receipt still has
to say who answered. A silent downgrade is the failure this lane exists to stop
— a *declared* choice of seat is not one.

## Why it is an ACP lane and not a subagent

A skill cannot pin a model: skill frontmatter is `name` and `description`. An
agent can (`model:` frontmatter), but nothing then verifies the request was
honoured, and per-agent reasoning effort is not expressible at all.

The ACP companion does both. `ACP_EXPECT_MODEL` makes the adapter
**acknowledge** its identity, and a mismatch fails the dispatch instead of
quietly answering from a cheaper seat. That is this plugin's
evidence-not-attestation rule turned on the advisor: *asking* for a model is not
the same fact as that model answering, and only one of the two is worth paying
for.

## Arguments

```
$claude-advisor                      # default seat: claude-fable-5
$claude-advisor <bin> <model>        # a routed seat
```

`<bin>` names the routed Claude wrapper; `<model>` is the Anthropic-protocol
alias the wrapper maps onto a vendor model. Both are required together — a bin
with no model, or a model with no bin, is a usage error, because the alias only
means something inside a profile.

### `--party <id>` — seat a saved bmad-party-mode roster

Any seat above also takes `--party <id>`, the same flag `bmad-party-mode` takes.
Instead of the lane inventing 3-5 voices, it answers as the operator's own saved
party — real names, titles and scene. One script renders the roster so all three
`*-advisor` skills seat it the same way:

```bash
node <plugin-root>/skills/tmux-teams/scripts/advisor-party.mjs <id>
```

`<plugin-root>` — the same spelling every dispatch command in this file uses,
expanded to `$CLAUDE_PLUGIN_ROOT` when you run it. NOT a repository-relative
path: an advisor is invoked from the operator's own project, where
`plugins/tmux-teams/...` resolves under THAT tree and exits `MODULE_NOT_FOUND`,
so `--party` would never reach the resolver. An openai review lane caught the
relative form in all three skills at once.

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

### The seats, read off each profile's `settings.json` on 2026-08-09

| `<bin>` | `<model>` | answers as | endpoint |
|---|---|---|---|
| *(omitted)* | *(omitted)* | `claude-fable-5` | Anthropic |
| `claude-kimi` | `opus` | `k3` | `api.kimi.com` |
| `claude-kimi` | `sonnet` | `kimi-for-coding` | `api.kimi.com` |
| `claude-qwen` | `opus` | `qwen3.8-max` | Alibaba MaaS |
| `claude-qwen` | `sonnet` | `deepseek-v4-flash-0731` | Alibaba MaaS |
| `claude-zai` | `opus` | `glm-5.2[1m]` | `api.z.ai` |
| `claude-zai` | `sonnet` | `glm-5-turbo` | `api.z.ai` |

**An alias is not a family.** `opus` on three different bins reaches three
different vendors, and a receipt that records `effective_identity: opus` has told
you nothing about who answered — it names the alias the gateway was asked for.
The `<bin>` is the fact; the alias is a slot. When two lanes must be from
different families, prove it from the endpoint, never from the alias.

This table is read from the profiles, and the profiles can change under it. It is
the map, not the territory: `plugins/tmux-teams/skills/party-mode/scripts/review-profiles.mjs` carries
the same mappings for the review lanes, where two were confirmed by asking the
running model for its own identifier rather than trusting the file
(`claude-qwen --model opus` → `qwen3.8-max-preview`, `--model sonnet` →
`deepseek-v4-flash-0731`, measured 2026-08-08 — note the served id is not
character-identical to the requested one). If a seat matters, ask it who it is.

### The 9Router seat, read off `~/.claude-9r/settings.json` on 2026-10-25

`claude-9r` is not one of the `claude-profiles` seats. Its wrapper
(`~/.local/bin/claude-9r`) does exactly one thing — `CLAUDE_CONFIG_DIR="$HOME/.claude-9r"`
— and that directory's `settings.json` points the CLI at the operator's own
loopback gateway and supplies the alias map, so the bin exists but the PROFILE
is the fact:

| `<bin>` | `<model>` | answers as | endpoint |
|---|---|---|---|
| `claude-9r` | `opus` | `thinker[1m]` (gateway id `thinker`) | `http://127.0.0.1:20128/v1` (9Router, loopback) |
| `claude-9r` | `sonnet` | `worker[1m]` (gateway id `worker`) | `http://127.0.0.1:20128/v1` (9Router, loopback) |
| `claude-9r` | `fable` | `advisor` (gateway id `advisor`) | `http://127.0.0.1:20128/v1` (9Router, loopback) |
| `claude-9r` | `haiku` | `flash` (gateway id `flash`) | `http://127.0.0.1:20128/v1` (9Router, loopback) |

The aliases come from `ANTHROPIC_DEFAULT_{OPUS,SONNET,FABLE,HAIKU}_MODEL` in that
settings file, and the gateway behind them can be re-pointed by editing it — same
rule as every row above: the alias is a slot, the endpoint plus the settings file
are the facts. `fable` → `advisor` is the 9Router counterpart of this lane's
default seat (a consultation-grade model, not a worker).

**Naming a router model directly.** The four aliases are the short list. The
adapter under this config also advertises the router's own claude-shaped ids as
settable model values — measured 2026-10-26 from the `session/new` response:
`claude-glm-5.3`, `claude-glm-5.3-flash`, `claude-gemini-3.8-flash`,
`claude-muse-spark-1.3`, `claude-gpt-6-luna`, `claude-deepseek-flash`,
`claude-opus-5.5`, `claude-gpt-6.1-sol`, the `-free` seats
(`claude-cat-jam-free`, `claude-longcat-2.5-preview-free`,
`claude-deepseek-v4.1-flash-free`, `claude-glm-5.3-flash-free`,
`claude-beam-free`), and the namespaced seats `ag/claude-*`, `cc/claude-*`,
`ocg/claude-haiku-5-5`. `$claude-advisor claude-9r claude-glm-5.3` puts that id
in `ACP_MODEL`. What the receipt proves, precisely: the identity fields commit
at session establishment, so `effective_identity: claude-glm-5.3 (matched)`
proves the ADAPTER APPLIED that id. It witnesses adapter selection, not
downstream routing — the gateway remains free to route a native id wherever
its own table sends it, exactly as it maps an alias. The turn itself is
proved separately, by the outbox file and `[turn done] stopReason=end_turn`
in the lane log; `operation_outcome: succeeded` on the receipt is the
session-operation outcome and predates the prompt round-trip. Both legs were
observed on the 2026-10-26 probe of this seat (reported triple:
`requested_model: claude-glm-5.3`, `effective_identity: claude-glm-5.3`,
`identity_status: matched`); that probe's run directory was ephemeral, so the
durable proof is the reproduction — dispatch the block above and read the
receipt and outbox it writes. The loopback
endpoint proves only that the gateway is the local 9Router — which family
served is the gateway's routing that day, and the alias map in
`~/.claude-9r/settings.json` is the fact to cite for it, never the loopback
address.

The acceptance set is the ADAPTER's, not the gateway's. The router's
`/v1/models` also lists bare `thinker`/`worker`/`advisor`/`flash`, `cx/*`,
`glm/*` and `oc/*` — none of those is advertised, none can be named, and the
dispatch refuses an unadvertised id at `config-option-invalid` BEFORE any prompt
is delivered, so a typo costs no quota. The narrowing can bite inside the
claude-shaped subset too: measured the same day, the gateway serves
`cc/claude-fable-5-1` while the adapter does not advertise it — treat the curl
below as the superset, not the settable list. The prohibition guard applies
before all of this: `ag/gemini-3.1-pro-high` sits on the router but is neither
advertised nor permitted (Gemini 3.1 is banned and `gpt-6-sol` retired on every
tmux-teams route), and the companion exits 2 on it whatever the router serves.

```bash
curl -s http://127.0.0.1:20128/v1/models \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
    for (const m of JSON.parse(d).data)
      if (/^(claude-|(ag|cc|ocg)\/claude)/.test(m.id)) console.log(m.id) })'
```

### Two spellings, and which works depends on the machine

A routed seat is selected either by the wrapper binary or by the profile
directory that wrapper loads:

```bash
CLAUDE_CODE_EXECUTABLE="claude-qwen"                      # the wrapper
CLAUDE_CONFIG_DIR="$HOME/.config/claude-profiles/qwen"    # the profile it loads
```

Measured 2026-08-09 on the authoring machine: `~/.local/bin` holds `claude` and
**no `claude-*` wrapper at all**, while every profile directory exists. So the
wrapper form is unusable here and the config-dir form is what has actually been
run — a zai lane dispatched that way returned `identity_status: matched` the same
day. Check which exists before writing a command that assumes one:

```bash
command -v claude-qwen || ls -d "$HOME/.config/claude-profiles/qwen"
```

**The 9Router seat inverts that check, measured 2026-10-25.** Here the wrapper
`claude-9r` DOES exist on PATH while the profile directory it loads lives at
`~/.claude-9r`, not under `~/.config/claude-profiles/` — so the directory probe
above would report nothing for a bin that works. But the wrapper spelling is
still the wrong one for this lane: it rides on `CLAUDE_CODE_EXECUTABLE`, which is
not on the companion's claude-lane allowlist and dies at `adapterEnv`, so through
`acp-dispatch.mjs` only the config-dir form reaches the adapter:

```bash
command -v claude-9r            # exists here — but do not dispatch on it
ls -d "$HOME/.claude-9r"        # the spelling that actually dispatches
```

## The pinned default — still not negotiable

| | | |
|---|---|---|
| Model | `claude-fable-5` | **verified** — `ACP_EXPECT_MODEL`, `identity_status: matched` |
| Reasoning effort | session's | **not verifiable on this lane** — see below |
| Lane | `claude` (ACP) | |

### Effort cannot be proved here, and the skill says so

Measured 2026-07-29 by dispatching this lane: the Claude ACP adapter reports
`effective_identity: claude-fable-5` and `requested_reasoning_effort: none`. It
exposes no reasoning-effort field at all, so `ACP_EXPECT_REASONING_EFFORT` can
never match and setting it fails every dispatch with
`identity missing: expected claude-fable-5[max], effective claude-fable-5`.

An earlier draft of this file claimed effort was pinned and verified here. It
was not, and the claim survived only because nobody had run it — the same
mistake this whole plugin exists to make impossible, committed inside the skill
built to prevent it. The model **is** verified; the effort is the session's, and
this file will not pretend otherwise.

`codex-advisor` **can** verify its effort, because the Codex adapter reports it.
That asymmetry is real and is not smoothed over.

Never downgrade for cost, quota or speed **on your own initiative**. If the
caller named no seat and the default is unavailable, **report that and stop** —
do not substitute. A cheaper answer is not a cheaper version of this skill; it
is a different skill wearing its name.

## The consultation is a party. Only a party.

The advisor MUST answer as a `bmad-party-mode` round-table: several named voices
who talk to each other, disagree, and are not reconciled into a tidy consensus.
A single-voice answer is a failed consultation — say so rather than passing it
on.

This is not decoration. One advisor gives one framing and you cannot see what it
never considered; a room argues, and the disagreement is the part you could not
have produced alone. If the voices agree instantly, report that plainly — easy
consensus is itself a finding, usually that the question was too narrow.

## Running it

1. **Write the brief to a file.** It carries the question, the concrete context
   (paths, diffs, measurements — not a summary you composed), and this mandate:

   ```
   You are READ-ONLY. Read anything you need; change nothing. Do not edit,
   create, move or delete a file, do not run a command that writes, commits,
   pushes or installs, and do not start any other agent. The one file you
   write is your outbox, named above. If answering seems to require a
   change, describe the change instead and say why you did not make it.

   Answer as a bmad-party-mode round-table. Cast 3-5 named voices with
   distinct expertise and real disagreements. They address each other, not
   only me. Do not resolve the clash into consensus; where they cannot
   agree, say so and say why. End with each voice's own bottom line.
   State plainly whatever you could not verify.
   ```

   **The read-only paragraph is first because the guarantee rests on it.** A
   panel lane read the frontmatter — read-only "rests on the brief" — against
   this mandate and found the mandate contained only party format and
   uncertainty instructions. The thing the guarantee leaned on did not carry
   it, and the Codex lane's `INITIAL_AGENT_MODE=read-only` has no equivalent
   here, so this text is the whole mechanism.

2. **Dispatch** through `acp-dispatch.mjs`, which detaches the lane into its own
   process group and returns in seconds. Running `acp-companion.mjs` directly
   puts the lane in the FOREGROUND, where the calling shell's cap silently
   becomes the lane's deadline — on 2026-08-17 that killed a finished review at
   ten minutes with 461 protocol events recorded. `tests/acp-dispatch.test.mjs`
   refuses this file if it teaches the killable form. Default seat:

   ```bash
   ACP_SESSION_RECEIPT_REQUIRED=1 \
   ACP_SESSION_OPERATION="new" \
   ANTHROPIC_MODEL="claude-fable-5" \
   ACP_EXPECT_MODEL="claude-fable-5" \
   node <plugin-root>/skills/tmux-teams/scripts/acp-dispatch.mjs \
     claude <cwd> <task-id> <brief-file> [stall-sec]
   ```

   Routed seat — the config-dir form, which is the one verified on this machine:

   ```bash
   ACP_SESSION_RECEIPT_REQUIRED=1 \
   ACP_SESSION_OPERATION="new" \
   CLAUDE_CONFIG_DIR="$HOME/.config/claude-profiles/<profile>" \
   ACP_MODEL="<model>" \
   node <plugin-root>/skills/tmux-teams/scripts/acp-dispatch.mjs \
     claude <cwd> <task-id> <brief-file> [stall-sec]
   ```

   9Router seat — the config-dir form again, because `~/.claude-9r` IS what the
   `claude-9r` wrapper exports (dispatched in the v0.46.0 release session:
   receipt `44656a0b-65d6-4480-afbc-e94298540ad7`, `fable (matched)`, outbox
   delivered; reproduce with this block):

   ```bash
   ACP_SESSION_RECEIPT_REQUIRED=1 \
   ACP_SESSION_OPERATION="new" \
   CLAUDE_CONFIG_DIR="$HOME/.claude-9r" \
   ACP_MODEL="fable" \
   node <plugin-root>/skills/tmux-teams/scripts/acp-dispatch.mjs \
     claude <cwd> <task-id> <brief-file> [stall-sec]
   ```

   `fable` names the consultation-grade seat through that gateway's alias map
   (`opus`/`sonnet`/`haiku` reach the others — see the 9Router table above).
   Any advertised router id substitutes for it — `ACP_MODEL="claude-glm-5.3"`
   dispatches that seat directly, and the receipt shows the id itself. In both
   forms `ACP_EXPECT_MODEL` defaults to `ACP_MODEL`, so the receipt must show
   `effective_identity: fable (matched)` (or the id you named). That proves
   the adapter APPLIED what you asked — nothing more: what the gateway routed
   to beyond itself is the gateway's business, and on this seat every endpoint
   row is the same loopback address, which proves only that the gateway is the
   local 9Router. When a FAMILY matters (two lanes that must differ), the
   evidence is the gateway's own routing table that day — its model list and
   alias map — never a matched identity string.

   **`ACP_SESSION_RECEIPT_REQUIRED=1` on every dispatch block above and the
   recovery block below — and it was once missing from all of them.**
   The default mode CONTINUES after a receipt-persistence failure and records
   `receipt_digest: none`, so the identity this skill reports could rest on a
   receipt that was never written — a release panel called the guarantee
   fail-open and it was right. **A consultation with no receipt is a failed
   consultation.** Report it as one; do not report an identity the run did not
   prove.

   There is no `INITIAL_AGENT_MODE` here — that is Codex's control, and this
   lane has no equivalent switch. So the read-only property of a Claude advisor
   rests on the brief and on this skill never issuing a write instruction, which
   is weaker than the Codex lane and is stated rather than implied.

   Do **not** set `ACP_CMD` — it bypasses the companion's own launch path. Do
   **not** set `ACP_EXPECT_REASONING_EFFORT`; it cannot be satisfied on this lane
   and fails every dispatch.

   `ACP_EXPECT_MODEL` on a routed seat can only expect the ALIAS, because that is
   what the adapter reports back. It proves the alias was honoured. It does not
   prove which vendor served it — the endpoint does that, and it is the caller's
   job to say so.

3. **Arm a watcher, because the dispatch RETURNS while the lane runs.** That is
   the point of it, and it is also how a finished answer sits unread. Run this in
   the BACKGROUND — killing the waiter does not touch the lane:

   ```bash
   node <plugin-root>/skills/tmux-teams/scripts/acp-dispatch.mjs \
     wait <cwd> <task-id> 3600
   ```

   `0` = the outbox is written · `2` = there is no outbox, either because the
   turn ended without writing one or because the lane stopped reporting without
   reaching a terminal state (measured: `terminated:false, notReporting:true,
   livenessState:"active"` also exits 2, so read the liveness before deciding
   between a re-dispatch and a resume) · `1` = the
   wait budget ran out while the lane is still going. It ends on BOTH terminal
   outcomes on purpose: a watcher that looked only for an outbox would stay
   silent through a turn that wrote nothing, and silence reads exactly like
   still-running.

4. **Read the outbox.** No outbox file means no advice. A run that printed to
   the terminal and wrote nothing has produced no consultation, however good the
   text looked scrolling past — this has happened with a real model, whose
   answer was correct and landed nowhere a reader could find it.

5. **Report identity with the advice** — the acknowledged alias, the bin or
   profile, AND the endpoint it routes to. On a routed seat the alias alone is
   not provenance; that is the whole point of the table above.

## Read-only

This lane advises. It does not edit files, commit, push, or run anything that
changes state. If the consultation ends in work to be done, hand that to
`party-auto`; the advisor's job stops at the recommendation.

## Failure modes

- **Identity refused.** The adapter did not acknowledge the requested model.
  Report and stop — a rerun cannot change a declaration, and answering from
  whatever seat was free is the exact failure this skill was built against.
- **Bin named but absent.** `claude-qwen` does not exist on every machine. Fall
  back to the profile directory if it exists, and say which form you used; do
  not silently dispatch the default seat under the routed seat's name.
- **Single voice returned.** Not a consultation. Say so rather than presenting
  one opinion as a room.
- **Empty outbox (`no_outbox`). TRY RESUME first, and never reconstruct.**
  Reconstructing from terminal output is attestation and this plugin does not
  accept attestation. Resume is cheap and is the only path that could still hold
  the analysis. Two attempts are on record: 2026-08-04 loaded without its prior
  lineage and answered `I have nothing`; 2026-08-18 recovered a complete
  4,823-byte review with six findings from a lane that had run 343 progress
  events and written nothing. The difference was the lineage.

  **A resume under required receipts needs the same inputs a fresh dispatch
  needs, plus its lineage** — a panel lane found this block supplying only
  `ACP_RESUME`, while the fresh commands above declare a receiptless
  consultation FAILED. Dropping receipt mode exactly when the first delivery is
  missing is the moment it matters most.

  ```bash
  ACP_SESSION_RECEIPT_REQUIRED=1 \
  ACP_SESSION_OPERATION="load" \
  ACP_PRIOR_DISPATCH_ID="<dispatch_id from the failed run's receipt>" \
  ACP_PRIOR_RECEIPT_DIGEST="<receipt_digest from that run>" \
  ACP_RESUME="<session-id>" \
  ANTHROPIC_MODEL="<the model the failed run used>" \
  ACP_EXPECT_MODEL="<the same model>" \
  node <plugin-root>/skills/tmux-teams/scripts/acp-dispatch.mjs \
    claude <cwd> <same-task-id> <recovery-prompt-file> [stall-sec]
  ```

  The recovery prompt is short: "you already read it, write what you have to
  `<path>`, do not redo the analysis" — a few hundred tokens instead of the
  whole consultation. Ask it to answer "I have nothing" plainly if the
  context really is gone; a short honest refusal is worth more than a
  reconstruction.

  The id lives in the run cwd's `.tmux-teams/` (the companion's persisted
  session file), so **never `rm -rf` the run directory before recording it** —
  on 2026-08-04 three fresh runs were paid for on the sibling codex lane while
  a session holding the finished analysis sat on disk.
- **What produces an empty outbox is unexplained on the sibling codex lane**,
  where it recurred across 203KB, 203KB and 7KB briefs on one afternoon after a
  52KB brief had worked that morning. Size is not the variable. Putting large
  diffs on disk is worth doing anyway; do not expect it to prevent this.
- **Zero protocol events at boot.** `status` showing `awaiting_agent` with
  `meaningful_progress: 0` means exactly one thing: the lane never completed
  `initialize`. It cannot tell you WHY. On this machine, in the v0.46.0 release
  session (2026-10-25), the why was npm — observed then: the adapter binary
  answered `initialize` in well under a second when spawned directly, while
  `npx -y @agentclientprotocol/claude-agent-acp` re-extracted its dependency
  tree on every boot because `~/.npm` symlinks to an external volume, with
  boots running minutes and one interrupted boot spending most of that on a
  single tarball fetch; a boot killed mid-reify leaves
  `_npx/<hash>/concurrency.lock` behind. Those run directories were ephemeral;
  the durable form of the observation is the reproduction — spawn the cached
  adapter binary directly and compare its time-to-initialize against the same
  spec through npx. It is one machine's account, not a law about npm. Before
  concluding "npm installing", look: a `ps` of the lane's children showing
  `npm exec` with no adapter child is that diagnosis; an adapter child that
  stays silent is a different fault. The default stall budget (600s) covered
  the 5-6 minute boots here; a shorter caller-supplied `[stall-sec]` kills
  mid-install, and killing at the boot window is how this lane earned its
  "SIGKILL" reputation on this machine. Expect `acp-dispatch.mjs` itself to
  report "identity not acknowledged after 120s — the lane is RUNNING" while
  this goes on: that is its fixed boot window expiring, not a verdict on the
  lane.
- **Frictionless consensus.** Report it as a finding about the question, not as
  a strong answer.
