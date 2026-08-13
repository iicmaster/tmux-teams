# ROADMAP — tmux-teams

> **This file is the source of the published roadmap page.** Edit it here; the
> page is a rendering. `node scripts/roadmap-gate.mjs` answers whether the
> published page still matches these bytes, and the release flow runs it.
>
> It lives at the repository root, tracked, for the same reason `HANDOFF.md`
> does: a roadmap only one machine can read is a roadmap to nobody. Before
> 2026-08-13 this document existed **only** as HTML on a private host, with no
> source, no publish script and nothing that could notice it had gone stale —
> so it went stale, repeatedly, and nobody could tell without opening it.

Current release: **0.20.0**

## Where the phases stand

| Phase | State | What it is |
|---|---|---|
| **A** | done | ACP transport for review lanes — spawn, initialize, session, prompt, terminal settlement |
| **B** | done | The exact-three review gate: three distinct model families, endpoint pins, zero-tool isolation (ADR 0001) |
| **C** | **closed by changing the question, 2026-08-13** | Was "run the three-family panel through bwrap on Linux". The panel now runs without bwrap on macOS and Linux alike (ADR 0006), and passed 3/3 on three packets for v0.20.0. |
| **D** | not started | — |
| **E** | not started | — |
| **F** | proposed, not started | Per-seat pre-LLM / post-LLM scripts (Master's proposal). Three questions must be answered before any code. |

## What is actually open

Nothing is blocking a release. These are real but unforced:

- **If bwrap is ever re-enabled**, the sandbox still does not carry a routed
  wrapper's own profile files into the ephemeral home. The gate knows where to
  READ them (`TMUX_TEAMS_REVIEW_<ID>_SETTINGS` / `_ENV_FILE`) and never places
  them where the wrapper looks. The layout-agnostic fix is to mirror the
  operator-named paths relative to `HOME`, not to hardcode a second layout.
- **Credential-shaped JSON key names** are no longer redacted in outbound
  reviews — a deliberate consequence of `keyNames: false`, which stopped a field
  called `sawRawSecret` from having its value erased. Narrow, but real.
- **`cleanRemoteText` collapses only CR/LF/TAB**, so ESC/ANSI and NUL from a
  provider error can still reach an operator's log. Low severity, log-injection
  shaped.
- **Phase F** needs its three questions answered before it becomes work.

## Decisions that are not up for re-litigation

Each of these has a document; go and argue with the document, not from a blank
slate.

- **ADR 0001** — the exact-three ACP review gate, and why plan mode was never
  what made a lane read-only.
- **ADR 0003** — a dispatched agent receives no MCP server. Enforced at runtime
  (AC135), not merely stated.
- **ADR 0004** — the runner reserves a SEAT and a TOKEN, and releases a claim on
  evidence, never on elapsed time.
- **ADR 0005** — MCP's Tasks extension converged on this companion's design
  independently; we stay divergent, and the conditions that would reverse that
  are written down.
- **ADR 0006** — shipped review profiles no longer declare bwrap. What that
  costs is stated, along with the strongest argument against the decision.

## How this page stays true

1. Edit `ROADMAP.md`.
2. `node scripts/roadmap-render.mjs` — writes `docs/roadmap.html`, deterministic,
   no dependencies. Nothing about the page is written by hand any more.
3. Publish that file, then `node scripts/roadmap-gate.mjs --record <url>`.
4. `node scripts/roadmap-gate.mjs` — exits 2 while the published page is behind.

The gate never records for you. A gate that writes its own answer passes
forever, which is the same shape as a test asserting a value it just computed —
this project has been bitten by that seven times and counting.

The renderer exists because the gate alone was not enough. A gate raises the
alarm; it does not lower the cost, and the cost was the whole problem — every
published version of this page was HTML somebody wrote by hand, so staying
current meant remembering to dispatch an agent at it. That is not a process.
