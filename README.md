# tmux-teams — a multi-team delivery loop for agent work

tmux-teams is a Claude Code plugin that runs delivery as a loop between
declared teams: a person admits a unit of work, the teams pull it forward over
ACP, and every published page is drawn from an append-only custody ledger
rather than from what an agent said about itself. The founding rule is
**evidence over attestation**: a worker that finishes without writing its
outbox has produced nothing, a team at its WIP limit is left visibly blocked,
and a declaration that cannot be read fails the page closed with the reason.
It is for operators running agent teams who want the board to report what
actually happened.

Current release: **0.49.0** (`.claude-plugin/marketplace.json` and
`plugins/tmux-teams/.claude-plugin/plugin.json`). Upgrading from an earlier
release: [plugins/tmux-teams/docs/UPGRADING.md](plugins/tmux-teams/docs/UPGRADING.md).

## 1. Quick start

1. Install the plugin:

   ```bash
   claude plugin marketplace add iicmaster/tmux-teams
   claude plugin install tmux-teams@tmux-teams
   ```

   You should see the marketplace registered and the plugin installed at version 0.49.0.

2. Declare the loop by invoking the bundled `tmux-teams:graph-setup` skill —
   an interview that runs until `.tmux-teams/graph.json` is complete, then validates it.

3. Run one tick and look at the board:

   ```bash
   node plugins/tmux-teams/skills/tmux-teams/scripts/loop-runner.mjs <repo>
   node plugins/tmux-teams/skills/tmux-teams/scripts/pulse.mjs once <repo>
   ```

   You should see the runner state what the tick moved (on a fresh loop:
   `[loop] nothing to move`) and `pulse.mjs` print the path of the published
   `pulse.html`. The admit, `--dry-run`, and `--watch=20` variants are in the [operating manual](plugins/tmux-teams/docs/manual.md).

## 2. What you get

- **A delivery loop** — dispatcher/worker/evaluator seats, WIP limits that cannot be pushed past, handover by pull, one ordered tick.
- **Published pages drawn from evidence** — `pulse.html`, `graph.html`, `kanban.html`, written from the custody ledger, never from attestation.
- **Four ACP advisor seats** — Claude, Codex, AGY (Gemini via Antigravity), and OpenCode, verified down to the model that actually answers.
- **A party verification gate** — a three-model adversarial review panel, read-only, isolated from the work it reviews.

## 3. Requirements

| Need | For |
|---|---|
| Node 20+ with `npx` | the ACP adapters (CI exercises Node 20 and Node 24) |
| `tmux` and the `codex` CLI | the tmux worker lane |
| `bun` | the `agy` ACP adapter (`bunx antigravity-acp@1.2.0`) |

The review gate declares no OS sandbox; why, and what it checks instead, is
[ADR 0006](plugins/tmux-teams/docs/adr/0006-the-review-gate-stops-declaring-bwrap.md).

## 4. The fifteen skills

**Entry and orchestration**

- `tmux-teams:tmux-teams` — you are the PM: dispatch, completion detection, capture, the mailbox contract, the delivery loop.

**Advisors**

- `tmux-teams:claude-advisor` — Claude's strongest model, pinned and verified.
- `tmux-teams:codex-advisor` — a read from outside the Claude family.
- `tmux-teams:agy-advisor` — a third family: Gemini through Antigravity.
- `tmux-teams:oc-advisor` — a fourth family: OpenCode's own ACP server.

**Planning and quality**

- `tmux-teams:sqthink` — structured step-by-step analysis, comparison, or planning before deciding.
- `tmux-teams:test-quality` — a test-adequacy evidence contract for agent-authored code.
- `tmux-teams:requirement-audit` — audit a requirement or story before it is estimated or dispatched.

**Delegation**

- `tmux-teams:pm-delegation` — act as PM over other agents: the brief contract, tickets as a dependency graph, audited worktrees.
- `tmux-teams:handoff` — end a session by writing `HANDOFF.md` for the next reader, which is another agent.
- `tmux-teams:lane-setup` — get a review lane callable on this machine, reporting what is missing per lane.

**Parties**

- `tmux-teams:party-mode` — the umbrella: routes a request to execution or advice.
- `tmux-teams:party-auto` — execute multi-file or production-impacting work with verification.
- `tmux-teams:party-advise` — advice, plan critique, tradeoff or risk review; read-only, never edits.

**Graph**

- `tmux-teams:graph-setup` — first run: interviews until the declaration is complete, then validates it.

Each advisor returns a round-table rather than a single voice; ask more than
one on a hard call, because where they disagree is the finding, and two seats
from the same vendor are not two families. This repository's development
environment also carries additional BMAD skills outside the plugin — they are
not shipped here.

## 5. How it works in one paragraph

Two layers that must never be conflated: the **declaration** —
`.tmux-teams/graph.json`, written once by a person, saying who exists and how
the teams are wired — and the **evidence** — the per-token custody ledger,
`pulse.json`, and the runner heartbeat, recording what actually happened and
never assumed. Work moves forward only, a team takes work only when it has
room, and every published page answers from the evidence layer. The diagrams
are in [how-it-works.md](plugins/tmux-teams/skills/tmux-teams/references/how-it-works.md);
the mechanics and the [glossary](plugins/tmux-teams/docs/manual.md#7-glossary)
are in the [operating manual](plugins/tmux-teams/docs/manual.md).

## 6. Documentation map

| Document | What it is |
|---|---|
| [Operating manual](plugins/tmux-teams/docs/manual.md) | the mechanics: the loop, ACP, the pages, full troubleshooting, reference, glossary |
| [how-it-works.md](plugins/tmux-teams/skills/tmux-teams/references/how-it-works.md) | the diagrams |
| [loop-system-contract.md](plugins/tmux-teams/skills/tmux-teams/references/loop-system-contract.md) | the rule book — the SSOT for the loop's clauses |
| [UPGRADING.md](plugins/tmux-teams/docs/UPGRADING.md) | what changed between releases, and what breaks |
| [ADR index](plugins/tmux-teams/docs/adr/) | every recorded decision, with its measurement |
| [ROADMAP.md](ROADMAP.md) | the roadmap (a published page renders it) |
| [RELEASE-PLAN.md](RELEASE-PLAN.md) | the closed release-plan record |
| GitHub Releases | what's new lives in Releases — never in this file's prose |

## 7. Troubleshooting — the top 3

**A board that looks normal while answering teams nobody declared.** With
`.tmux-teams/graph.json` absent, a bundled default is loaded for the pages and
`graph.mjs check` prints `ok (default)`; with it present but invalid,
everything fails closed. Run
`node plugins/tmux-teams/skills/tmux-teams/scripts/graph.mjs check <repo>` and
confirm the source is your file, not `(default)`.

**An installed copy does not have my changes.** The install cache is
version-keyed: run `claude plugin marketplace update tmux-teams` and THEN
`claude plugin update tmux-teams@tmux-teams` — both steps, in that order.

**The Gemini worker lane has been removed.** Retired surfaces are recorded, not
silently dropped — the [manual's transports section](plugins/tmux-teams/docs/manual.md#51-transports)
states what the companion now refuses, and the [ADR index](plugins/tmux-teams/docs/adr/)
records the decisions that shaped the plugin. Everything beyond these three
lives in the [manual's full troubleshooting](plugins/tmux-teams/docs/manual.md#4-troubleshooting-full).

## Reference

- **Topology.** This repository is canonical: `~/agent-skills` vendors it as the `plugins/tmux-teams` submodule, and OpenClaw is the remaining consumer of that submodule bridge; Codex and Claude load their own version-keyed plugin caches.
- **Pulse contracts.** Pulse v4 is the default contract; v3 remains the compatibility path — [v4 schema](plugins/tmux-teams/skills/tmux-teams/references/pulse-v4.schema.json) · [v3 schema](plugins/tmux-teams/skills/tmux-teams/references/pulse-v3.schema.json). The Pulse timezone contract is specified in the manual.
- **License and author.** MIT (declared in `plugins/tmux-teams/plugin.json`); written and maintained by IIC Master.
