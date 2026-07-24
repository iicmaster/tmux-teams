---
name: party-mode
description: "Umbrella workflow for Party Mode with two subskills: party-auto for executing moderately complex/high-risk work with planning, multi-agent critique, grill-gate decision interview, file ownership, verification, and 3-model review; party-advise for read-only advice, plan critique, architecture/tradeoff review, risk analysis, or recommendations without implementation. Use when the user explicitly invokes $party-mode, $party-auto, $party-advise, asks for Party Mode, or asks to choose between executing and advising."
---

# Party Mode Workflow

Use `party-mode` as a deliberate orchestration umbrella, not as the default answer style.
Route each request to one of its subskills:

- `party-auto`: execute work when multi-agent planning, critique, file ownership, and verification materially reduce risk.
- `party-advise`: advise, critique, or recommend without editing files or taking implementation actions.

If invoked through a subskill wrapper, read this `party-mode` skill and follow the matching lane.

## Language Contract

- Use Thai for all user-facing progress and final reports.
- Keep code identifiers, command names, file paths, and tool names unchanged.
- Write short, structured status updates: phase, result, blocker, or decision needed.
- Prefer stable labels and checklists over narrative prose.
- Avoid vague claims. Tie every completion claim to evidence.

## Canonical Terms

- `external review` is the mandatory `3-model review` at Phase 2 and Phase 6. It is a **bundled JavaScript ACP-only workflow**, never a tmux/TUI review and never a raw review CLI invocation.
- Run it only through `node <party-mode>/scripts/review-gate.mjs <static-packet.json> <absolute-target-repository> > <review-report.json>`. Capture the trusted target path before reading the packet; never derive it from packet data. The gate builds a deterministic route, sends the same redacted static packet from a fresh temporary workspace, starts each reviewer in ACP plan mode, denies ACP permission requests, verifies the pinned model/config acknowledgement, and enforces its timeout. Do not substitute `oc`, AGY/Codex review plugins, MCP review tools, or a host-agent review command.
- Linux review execution requires `/usr/bin/bwrap`. The sandbox omits the target repository and masks host user-data roots, gives each adapter an ephemeral provider HOME, requests no MCP/built-in tools, and uses a new PID namespace. Before launch, the gate resolves the profile-owned executable, rejects target/PATH-shadowed binaries, and requires a trusted runtime root. Runtime, scratch, and target-mask scaffolding live outside the reviewer cwd; AGY sees only one runner-owned read-only guide stating that review input exists solely in the prompt. Packet redaction covers sensitive keys plus bounded assignment, header, and query-string values. Network remains shared for provider APIs; the adapter can read the minimum copied auth in its own ephemeral HOME and the provider may persist remote state. Treat same-process auth and local/LAN network reachability as residual boundaries, not proof of zero live-service access. If AGY ignores the built-in-tool-off request, the gate tolerates only a completed read confined to canonical copied provider-runtime documentation inside its isolated `builtin/` tree, an exact canonical listing of the fresh neutral workspace root, or that exact canonical guide file. The workspace contains no packet file, target content, or other runner scaffolding. Missing paths, all other workspace descendants, relative escapes, symlinks (including `link/..`), mixed scopes, target/arbitrary reads, and every search/fetch/edit/execute call block the lane.
- The packet must carry `primary` (or `primaryProfile` / `primary_model`). Standard output is exactly one JSON result; diagnostics go to standard error. Exit `0` means the transport/policy gate completed, while `2`, `3`, `4`, and `5` respectively mean invalid input, transport/lane failure, malformed review, and policy/synthesis failure. A successful process still needs PM semantic review of the JSON result.
- A valid panel has **exactly three** structurally valid ACP reports, each with an explicit acknowledged identity/model/profile and a distinct model from the primary. AGY is mandatory. A missing, malformed, timed-out, colliding, or unacknowledged AGY report blocks the review; fewer than three valid reports also blocks it.
- The route is deterministic and family-distinct from the primary:

| Primary family | Final reviewers | Eligible non-AGY reserve |
|---|---|---|
| OpenAI / Codex / `gpt-*` | AGY + Kimi `kimi/k3` + Zai `zai/glm-5.2` | none while direct Claude is limited; `claude-zai` would duplicate/retry Zai, so block |
| Claude | AGY + Codex + Kimi `kimi/k3` | Zai `zai/glm-5.2` |
| Kimi | AGY + Codex + Zai `zai/glm-5.2` | none while direct Claude is limited; `claude-zai` would duplicate/retry Zai, so block |
| Zai | AGY + Codex + Kimi `kimi/k3` | none while direct Claude is limited; `claude-zai` matches the primary family, so block |
| Gemini / AGY / unknown | fail closed | none |

  Codex is prohibited from an OpenAI/Codex/`gpt-*` primary panel. Gemini, AGY, and unknown primaries fail closed rather than guessing a reviewer set.
- A non-AGY lane may be replaced only by an eligible reserve selected by the gate after failure. The final accepted panel must still contain exactly three valid, distinct reviewers and retain AGY. A reserve never turns a degraded two-reviewer panel into a pass.
- Direct Claude is currently provider-limited and is never launched by the gate. Its deterministic availability alias is `claude-zai`, which launches the pinned Zai GLM-5.2 ACP profile only if the resulting final panel has AGY plus three distinct non-primary families and configured models; otherwise the gate fails closed.
- The `claude-zai` profile pins a 4096-token thinking budget in its allowlisted ACP environment. This bounds adaptive-thinking output without raising the gate's stdout or timeout ceilings.
- The gate records transport, runner-owned profile/provider labels, configured-and-acknowledged ACP model, route, packet hash, enforced isolation controls, and report structure. It does not cryptographically attest the remote serving model. The PM still reads the findings, checks the cited evidence, and decides semantic correctness. A finding independently raised by at least two of the final three reviewers is must-fix; other findings require recorded PM judgment.
- Use `blocked` for every gate failure. Do not call a partial panel, a process exit, or a schema-valid report semantic approval.
- **`grill gate`** = decision interview adapted from mattpocock/skills `grilling` (Master directive 2026-07-07): after analysis (Phase 2 plan + Phase 3 critique) and before any execution, interview Master about every unresolved decision — **one question at a time**, each with a recommended answer and its reason — until every decision branch is resolved **and Master confirms shared understanding**. Facts discoverable from the repo, docs, or runtime MUST be looked up, never asked. A **genuine decision** = anything whose correct answer depends on Master's priorities, risk tolerance, scope preference, or a tradeoff between valid alternatives — the agent MUST defer these to the gate even with a confident recommendation; model consensus (3-model review, persona critique) never substitutes for Master's answer on such calls. Execution (Phase 4+) starts only after all decisions are answered and confirmed, or Master explicitly waives the gate.
- **`domain hook`** = conditional add-on to the grill gate adapted from mattpocock/skills `domain-modeling` (Master directive 2026-07-07). Active only when the plan's changes touch, conflict with, or are missing from an existing `CONTEXT.md` / `docs/adr/` entry, or the plan introduces new domain terms, boundaries, or architecture decisions. The mere existence of those files does not activate it — no glossary work for changes with no domain signal (pure bug fixes, formatting, dependency bumps). A term is **new** only if it is not already defined in `CONTEXT.md` and a future engineer would need its definition to reuse it unambiguously; a decision is **architectural** only if it changes a module/service/data boundary or a public contract, or is hard to reverse — not a routine local implementation choice. Record the activation call in the grill ledger (`domain_hook`) either way. During the gate it is read-only: challenge terms that conflict with the existing glossary, propose precise canonical terms for fuzzy ones, cross-reference Master's claims with the code, and record candidates in the grill ledger. Files are written only in Phase 7 (party-auto lane) — never in Phases 3.5-6, even when candidates are already known: `CONTEXT.md` stays a pure glossary (no implementation details), and an ADR is written only when all three hold — hard to reverse, surprising without context, the result of a real tradeoff. In `party-advise`, candidates are reported in the advisory output, never written.

## Non-Negotiables (Contract with Master)

1. MUST NOT claim "เสร็จ" without task-appropriate verification.
2. MUST NOT ask Master to run commands the agent can run.
3. MUST NOT auto-push to git remotes.
4. MUST protect user changes: inspect dirty worktree state before edits and never revert unrelated changes.
5. MUST keep human-facing output in Thai.
6. MUST hard-stop the verify loop at 16 iterations and report the blocker.
7. MUST run the simpler-path gate before expanding into full multi-agent execution.
8. MUST run the bundled ACP-only **3-model review** with `node <party-mode>/scripts/review-gate.mjs <packet> <runner-owned-absolute-target>` for **plan review (Phase 2)** and **completion review (Phase 6)**. Require AGY plus exactly two other valid, distinct gate-selected reviewers; a gate error, AGY failure, identity collision, timeout, or fewer than three valid reports is `blocked`. Apply two-or-more matching findings before proceeding.
9. MUST preserve installed target changes before sync: diff target copies, integrate intentional target-only changes, verify the repo source, then sync.
10. SHOULD report only milestones, blockers, risks, decisions, and evidence. Do not narrate keystrokes.
11. MUST run the `grill gate` (Phase 3.5) after analysis and before execution: no Phase 4/5 work while an unresolved Master decision remains or the closing shared-understanding confirmation is missing, unless Master explicitly waived questions.

## Mode Routing Contract

Activate `party-mode` when one of these is true:

1. The user explicitly invokes `$party-mode`, `$party-auto`, or `$party-advise`.
2. The user asks for Party Mode.
3. The user asks for a task shape that clearly matches one subskill below.

Choose the lane before acting:

- Use `party-auto` for execution: `ทำ`, `implement`, `สร้าง`, `fix`, `build`, `ship`, `execute`, `ดำเนินการ`, `apply the plan`, or explicit `$party-auto`, plus at least one complexity signal: multi-file change, high risk, production impact, unclear architecture boundary, need for parallel agents, or explicit user request for this workflow.
- Use `party-advise` for read-only advisory work: `แนะนำ`, `ช่วยคิด`, `คิดยังไง`, `review plan`, `advise`, `critique`, `architecture review`, `tradeoff`, `risk analysis`, `recommend`, explicit `$party-advise`, or explicit `$party-mode advise`.

Do not activate for:

- Simple factual questions or one-step answers that do not need Party Mode.
- Trivial one-step edits that do not benefit from multi-agent flow

If the message is mixed, classify the current intent:

- If the user asks to analyze before doing and then execute, use `party-advise` until the execution target is clear, then switch to `party-auto`.
- If the user asks only for analysis/review, use `party-advise` and do not edit files.
- If the request is too small for either lane and `$party-mode` was not explicit, exit this skill and respond normally.

## Party Auto Activation

Simpler-path gate:

1. State the user's actual objective in one sentence.
2. Check whether a direct single-agent edit, answer, or no-op would satisfy the objective.
3. Continue with full `party-auto` only when the complexity signal still justifies it or Master explicitly asked for it.
4. If the simpler path is sufficient and `$party-auto` was not explicit, exit this skill and explain the lighter path in Thai.

Too-big ceiling (wayfinder gate): the gate above guards only the too-small side; party-auto is single-run and assumes the objective fits one session with a known destination. If instead the work is **too big for one session AND the destination/route is still foggy**, party-auto is the wrong size — do not charge at the destination. Chart a lightweight map (a durable `PLAN.md` or one pinned issue listing the open decisions) and resolve **one decision per session**: use `party-advise` to chart (its Options/Recommendation/Open-questions IS the map) and the grill gate for each decision. Idea-level adoption of mattpocock/skills `wayfinder` (Master directive 2026-07-10); the full tracker-backed skill is deferred until a genuinely multi-session foggy effort arrives. No fog (route fits one run) → skip this.

## Party Advise Mode

Use `party-advise` for read-only advice, plan critique, architectural review, risk analysis, strategy, or recommendations.

Rules:

1. MUST NOT edit files, sync targets, create commits, or run implementation commands.
2. MAY inspect repo files, diffs, logs, docs, or non-destructive command output when evidence improves the advice.
3. SHOULD run the 3-model review when the advice is high-risk, cross-cutting, architectural, production-impacting, or explicitly asks for adversarial critique.
4. MAY skip the 3-model review for simple advice; report the lighter path and evidence used.
5. MUST separate facts, assumptions, options, recommendation, risks, and open questions.
6. MUST hand off to `party-auto` only when the user asks to execute or the advisory result becomes an implementation request.
7. SHOULD apply the `domain hook` read-only when its activation condition holds — no interactive interview in this lane; report term/ADR candidates in the advisory output and never write `CONTEXT.md` or ADR files.

Advisory output schema:

```text
Party Advise:
- Objective: <what the user is deciding or evaluating>
- Evidence: <files, commands, docs, or user-provided facts used>
- Options: <viable paths and tradeoffs>
- Recommendation: <preferred path and why>
- Risks: <material risks or unknowns>
- Domain candidates: <term/ADR candidates from the domain hook, or "none — hook off">
- 3-model review: <per-lane verdict or "not run: lighter path">
- Next: <stay advisory | switch to party-auto when execution is requested>
```

## Team Size

- **Minimum**: 3 agents
- **Default**: 5 agents
- **Scale up** for cross-cutting or high-risk work
- Draw personas from `_bmad/_config/agent-manifest.csv` when present.
- Otherwise synthesize personas from project instructions: architect, analyst, QA, PM, developer, UX designer, technical writer.
- If runtime limits prevent 3 agents, report the limit, use the maximum safe number, add the 3-model review or inline critique as fallback, and do not claim full parallel critique.

## Subagent Model Routing

Frontier always (Master directive 2026-07-14 — supersedes the earlier thinking/Spark lane split):

- **ALL Codex subagents** — thinking-heavy AND execution-heavy alike — MUST use the current latest Codex frontier model, currently `gpt-5.6-sol` at **ultra** reasoning effort (matches the codex CLI default in `~/.codex/config.toml`: `model = "gpt-5.6-sol"`, `model_reasoning_effort = "ultra"` — do not pass a lower `--effort`). Do not route any Codex work to Spark, inherited defaults, `OMX_DEFAULT_FRONTIER_MODEL`, or older frontier aliases — quota conservation is NOT a reason to downgrade unless Master explicitly says so.
- **ALL Claude subagents** (critique personas, review lanes, execution agents) MUST use Opus at maximum reasoning effort — not sonnet/haiku.
- Non-Codex/non-Claude runtimes map the same intent to their best available frontier model. If the runtime cannot select models, state the limitation and continue with the best available role/tool. Do not pretend the requested routing happened.
- When the latest Codex frontier model changes, update the literal current model in this section; do not silently fall back to stale aliases.
- Role choice still matters: pair thinking work with `architect`, `analyst`, `critic`, or `test-engineer`; pair execution work with `executor`, `build-fixer`, or focused implementation agents.

## Runtime Adapter

Before spawning or editing, map the abstract workflow to the current runtime.

Use the best available equivalent:

| Abstract action | Claude Code | Codex | OpenClaw / other runtimes |
|---|---|---|---|
| Spawn critique agents | `Agent` tool | native subagents when available | runtime dispatch/subagent mechanism |
| Track tasks | `TaskCreate` / `TaskUpdate` | plan/checklist updates | runtime task tracker |
| Edit files | `Edit` / file tools | `apply_patch` or repo tools | runtime-safe file editor |
| Browser verification | Chrome DevTools MCP | Browser/Playwright/tool available in session | equivalent browser or shell verification |
| External review (**3-model**) | `node <party-mode>/scripts/review-gate.mjs <packet> <runner-owned-absolute-target>` (bundled ACP-only gate; exact 3 valid reviewers, AGY required) | same bundled gate | same bundled gate when its ACP prerequisites and primary route are supported; otherwise fail closed |
| Grill gate (one decision question at a time) | `AskUserQuestion` tool | CLI question to the user | equivalent interactive question channel |
| Targeted skill sync | copy only the changed skill after verification | copy only the changed skill after verification | equivalent targeted install path |

If a named execution tool is unavailable, use the closest safe equivalent and state the substitution in the report.
Do not substitute a different review transport or reviewer set: the review gate itself may choose an eligible non-AGY reserve, but any unsupported route or gate failure is blocked.
Do not treat tool unavailability as verification success.

## Phase 1: RECEIVE

Confirm the command in one Thai sentence.
Derive scope from context.
Ask at most one targeted question only when the execution target is genuinely ambiguous; deeper decision questions belong to Phase 3.5 GRILL, not here.

Output:

```text
เริ่ม party-auto: Phase 1 RECEIVE -> <one-sentence scope confirmation>
```

## Phase 2: PLAN (sqthink + ACP-only 3-model review)

Invoke `sqthink` skill for structured planning (or do sqthink-style structured reasoning inline).
First record the simpler-path gate result in the plan.
Then run a mandatory **3-model review** before Phase 3 through the bundled ACP gate. Write a static plan-review packet containing `primary`, capture the trusted repository path independently, then invoke `node <party-mode>/scripts/review-gate.mjs <static-packet.json> <absolute-target-repository> > <review-report.json>`. The gate, not the PM, performs deterministic routing, temporary-workspace isolation, ACP plan-mode launch, permission denial, acknowledgement verification, and timeouts. Do not put `target_repo` in the packet. The packet must include:

- The user's objective and constraints
- The proposed plan YAML
- Current repo/runtime assumptions
- Explicit ask: `find blocking plan flaws, missing dependencies, unsafe sequencing, verification gaps, and cheaper equivalent paths`

The report must validate to exactly three distinct reviewers, include AGY, and acknowledge the routed model/profile for every lane. For OpenAI/Codex/`gpt-*`, expect AGY, Kimi K3, and Zai GLM-5.2; Codex is not eligible. For Claude, Kimi, or Zai primary, use the canonical matrix above. Gemini, AGY, or unknown primary identity is blocked.

If two or more final reviewers raise the same objection, revise the Phase 2 plan before spawning persona critique agents. If the AGY lane fails, or the final report has fewer than three valid reports for any reason, mark `blocked`; do not begin persona critique under an unreviewed plan.

Output a plan with this schema:

```yaml
intent_gate:
  objective: <one-sentence actual objective>
  simpler_path: <direct edit|single-agent|no-op|none>
  party_auto_justification: <why full workflow is still warranted>
steps:
  - id: P1
    goal: <short action>
    files: [<path or unknown>]
    domain: <backend|frontend|db|docs|ops|test|security|other>
dependencies:
  - before: P1
    after: P2
parallel_batches:
  - [P1, P3]
risks:
  - <risk and mitigation>
verification_targets:
  - <command, test, screenshot, schema check, or manual evidence>
three_model_plan_review:
  transport: acp
  command: node <party-mode>/scripts/review-gate.mjs <packet> <absolute-target-repository>
  packet: <static packet path or digest>
  target_repository: <runner-owned canonical absolute path>
  primary: <acknowledged primary model/profile>
  workspace: <temporary isolated workspace path or digest>
  reviewers:
    - lane: agy
      model: <acknowledged routed model>
      profile: <acknowledged routed profile>
      verdict: <pass|objections>
    - lane: <kimi-k3|zai-glm-5.2|eligible reserve>
      model: <acknowledged routed model>
      profile: <acknowledged routed profile>
      verdict: <pass|objections>
    - lane: <zai-glm-5.2|kimi-k3|eligible reserve>
      model: <acknowledged routed model>
      profile: <acknowledged routed profile>
      verdict: <pass|objections>
  structural_status: <valid|blocked>
  synthesis: <two-or-more matching findings are must-fix>
  result: <pass|revised|blocked>
  notes:
    - <failure/replacement/PM decision, with the lane(s) that raised it>
evidence_ledger:
  - observation: <fact gathered before execution>
    implication: <what it proves or changes in the plan>
debug_discipline:
  applies: <yes|no>
  reproduce: <command, failing path, or none>
  fail_path: <entry point -> affected files -> side effect>
  falsifier: <what would prove the hypothesis wrong>
```

Debug task add-on:

- Use this only for bug, failure, regression, or incident work.
- Do not propose a fix until the failure is reproduced or the limitation is explicitly recorded.
- Track each hypothesis with the evidence ledger instead of narrating guesses.

## Phase 3: VALIDATE (parallel critique)

Spawn 3-5 critique agents in one concurrent batch when the runtime supports it.
For Codex critique agents, use the current latest Codex frontier model only, currently `gpt-5.6-sol` at `ultra` reasoning effort.
For non-Codex runtimes, use the best available frontier-equivalent thinking model when model selection is available.
Each critique agent MUST receive a self-contained prompt containing:

- The full Phase 2 plan
- One distinct persona
- The explicit ask: `find objections, risks, gaps; be adversarial`
- The expected output: blockers, risks, missing tests, and recommended plan changes

Synthesize the results in Thai.
Resolve objections by accepting, rejecting, or deferring each one with a reason.
Objections that are genuine decisions (Master's priorities, risk tolerance, scope preference, or a tradeoff between valid alternatives) MUST be deferred to Phase 3.5 — the agent may not accept or reject them itself, even with a confident recommendation.
If no real objections appear from at least two distinct personas, do one more targeted critique pass or explain why the plan is low-risk.

## Phase 3.5: GRILL (decision interview — ask until answers are complete)

Run the `grill gate` after Phase 2-3 analysis and before any Phase 4/5 work.

1. Collect every unresolved decision from the Phase 2 plan, Phase 3 critique objections, and 3-model review notes (deferred objections, open options, assumptions the plan leans on). The 3-model review and persona critique never substitute for this gate: Phase 2 auto-revision closes only purely technical/correctness objections; tradeoff or preference calls still enter the grill ledger.
2. Resolve facts yourself first: anything answerable from the repo, docs, logs, or runtime is looked up, never asked.
3. Order the remaining decisions so upstream/foundational choices are asked before decisions that depend on them, then ask Master **one at a time** (use `AskUserQuestion` when the runtime has it; otherwise a plain chat question). Each question MUST state a recommended answer and why. Never dump a list of questions in one message.
4. Wait for the answer before asking the next question; if an answer changes, narrows, or moots a later question, update or drop that question and note the change in the grill ledger.
5. Apply each answer to the plan (intent_gate, steps, risks, verification_targets) and record it in the grill ledger.
6. Close the gate with one short message summarizing the resolved decisions and asking Master to confirm shared understanding; start Phase 4 only after that confirmation. Waiver rules: an explicit no-questions instruction from Master ("ไม่ต้องถาม", "อย่าถาม", a pre-authorized unattended run) waives the gate whenever given — adopt the recommended answers as recorded assumptions. A generic go-ahead ("ทำเลย", "just do it") only approves what was disclosed at that point and does not pre-waive decisions surfaced later. A runtime without `AskUserQuestion` is NOT a waiver — use the chat/CLI question fallback from the Runtime Adapter table.

Domain hook (conditional — see Canonical Terms): when active, apply it during the interview read-only — challenge conflicting or fuzzy terms, cross-reference claims with code, and record `term_candidates` / `adr_candidates` below. Never write `CONTEXT.md` or ADR files inside the gate; Phase 7 materializes them.

Grill ledger schema:

```yaml
grill_ledger:
  - decision: <what had to be decided>
    recommended: <the recommendation given and why>
    answer: <Master's answer | "assumed: recommendation" when waived>
    impact: <plan change caused, or none>
grill_ledger_reason: <required only when grill_ledger is empty — why no decisions were open>
domain_hook:
  active: <yes|no>
  reason: <the plan-level domain signal found, or why there is none>
term_candidates:   # domain hook only — glossary entries to merge into CONTEXT.md in Phase 7
  - term: <canonical term>
    definition: <one-line glossary definition, no implementation details>
adr_candidates:    # domain hook only — written in Phase 7 iff hard-to-reverse + surprising + real tradeoff
  - decision: <what was decided, the alternatives, and why>
```

Skip condition: if Phases 2-3 leave zero unresolved decisions, record `grill_ledger: []` with `grill_ledger_reason` and continue — do not invent questions to appear thorough. This applies only when the Phase 3 deferral rule was honored; a pool emptied by self-resolving tradeoff calls is a gate bypass, not a skip.

## Phase 4: DIVIDE (file ownership)

Core rule: one writer per file per execution batch.

- If two concerns touch the same file, merge them into one owner brief.
- If one concern touches many independent files, split by file.
- If a change is atomic across files, assign one owner for the atomic file set or run those files sequentially.
- If imports, schema, generated files, or public contracts depend on each other, encode the dependency order explicitly.
- Do not create worktrees by default. File ownership is the primary lock.

Create task entries using the current runtime's task tracker.
Each task title should include owner, file or file set, and dependency batch.

## Phase 5: EXECUTE (parallel)

Dispatch execution agents in concurrent batches only when their write scopes do not conflict.
For Codex coding/refactoring/file-edit/implementation subagents, use the current latest Codex frontier model — currently `gpt-5.6-sol` at `ultra` reasoning effort, the same as thinking work (Frontier always; see Subagent Model Routing). Do not route execution to Codex Spark.
For non-Codex runtimes, use the closest fast execution model when model selection is available.

Each execution brief MUST contain:

- Exact file path or atomic file set
- Exact change spec
- Relevant project instructions (`AGENTS.md`, `CLAUDE.md`, `.Codex.local.md`, BMAD notes when present)
- Verification hint
- Reminder: do not revert unrelated user or agent changes

After each batch:

1. Inspect returned changes.
2. Integrate or resolve conflicts.
3. Update task status.
4. Run the next dependency batch.

## Phase 6: VERIFY (max 16 iterations + ACP-only 3-model review)

First discover verification surfaces from the repo:

- `package.json`
- `composer.json`
- `Makefile`
- CI config
- README / project docs
- Existing test or lint scripts

Then choose verification by task type:

| Task type | Verification method |
|-----------|---------------------|
| UI / Livewire / Blade | Browser navigation + screenshot + console check using available runtime tool |
| CSS / Tailwind change | `npm run build`, then refresh browser and capture a screenshot |
| Config / env / cleanup | `git ls-files`, `rg`, schema or config inspection |
| Python worker | run script + assert exit 0 + inspect output shape |
| Laravel command | `php artisan <cmd>` and inspect output |
| Docs | grep consistency + markdown/render sanity check when available |
| DB migration | migration status + schema inspection |
| Tests | project test runner and parse result |
| Unknown task type | derive a smoke test from changed files and report the limitation |

Loop body:
1. Run verification and collect evidence.
2. Add a verification ledger entry: check, result, ruled-in fact, ruled-out hypothesis, and next action.
3. Write a static completion-review packet containing `primary`, changed files, relevant diffs or summaries, verification output, known risks, and exact acceptance criteria. Capture the trusted target independently and invoke `node <party-mode>/scripts/review-gate.mjs <static-packet.json> <absolute-target-repository> > <review-report.json>`. The bundled ACP gate must return exactly three structurally valid, acknowledged reports, including AGY; otherwise record `blocked`.
4. Require substantive review output: verdict, blocking issues, evidence references, and residual risks. The schema validates the lane structure; the PM reads the findings and records accepted/rejected objections. Two-or-more matching findings are must-fix.
5. If local verification and the external review both pass, proceed to Phase 7.
6. If either local verification or the external review fails, diagnose the failure.
7. Spawn bounded fix agents or patch locally.
8. Re-run local verification and the external review.
9. Increment iteration count.
10. If iteration count reaches 16, hard-stop and report the blocker with full diagnosis.

External review rules:

- Use only the bundled `review-gate.mjs` ACP workflow. The review packet is static and redacted for sensitive structured fields, bounded assignments/headers, and credential query parameters; the target repository and host user-data roots are not mounted, target/PATH-shadowed ACP executables fail closed, MCP/built-in tools are requested off, ACP permission requests are denied, and only the bounded AGY provider-runtime or neutral-workspace read above is tolerated. Provider network access remains available and ephemeral same-process provider auth is a documented residual boundary.
- AGY is non-negotiable. When a non-AGY lane fails, the gate may launch an eligible reserve; accept it only if the final report remains exactly three valid, distinct, acknowledged reviewers. No reserve exists for AGY.
- A timeout, acknowledgement mismatch, duplicate identity/model, unsupported primary, invalid schema, or irrelevant/empty report blocks the gate. Do not fall back to a review plugin, MCP tool, raw CLI review, tmux worker, or two-reviewer vote.
- Do not treat a process exit/status check as a substantive review. Read and apply the actual reports; schema validity is not semantic correctness.

Verification ledger schema:

```yaml
verification_ledger:
  - check: <command, browser action, schema inspection, or review>
    result: <pass|fail|blocked>
    ruled_in: <what this proves>
    ruled_out: <what this disproves>
    next_action: <continue|fix|retry|block>
```

Targeted skill sync contract:

- Use only when the task changes a skill and asks to install/sync it.
- Before syncing, compare target copies and preserve intentional target-only changes.
- Verify the repo `SKILL.md` first; do not deploy an unverified source file.
- Sync only the changed skill directory unless Master asked for broad sync.
- If Codex is in scope, include `~/.codex/skills/<skill-name>/` as an explicit target; otherwise report it as out of scope.
- After syncing, compare repo and target copies with `diff -q` or checksum.

## Phase 7: REVISE PROJECT INSTRUCTIONS

Standing directive from Master (set 2026-04-18): auto-apply project instruction revisions without an approval gate. Include the diff in Phase 8 for transparency.

Revise project instruction files as living guidance.
Update, merge, replace, or delete stale guidance so `AGENTS.md`, `CLAUDE.md`, and `.Codex.local.md` reflect the current project reality.
Do not append one-off notes.

Process:

1. Reflect: identify durable context that would help future sessions.
2. Scan: find project-scoped instruction files (`AGENTS.md`, `CLAUDE.md`, `.Codex.local.md`).
3. Revise: normalize existing guidance; merge duplicates; remove stale statements; add only reusable rules.
4. Scope: revise project files only. Global instructions and memory updates require explicit Master request.
5. Safety: if instruction files conflict or the update would change policy broadly, report the conflict and ask Master.
6. Evidence: include the instruction diff in Phase 8.
7. Domain docs (only when the grill ledger has candidates): merge `term_candidates` into `CONTEXT.md` (create it lazily on the first resolved term; glossary only — no implementation details) and write `docs/adr/NNNN-<slug>.md` for each `adr_candidates` entry that passes the three-part test (hard to reverse, surprising without context, real tradeoff). Candidates that fail the test are dropped with a one-line reason in Phase 8. No candidates = no domain files touched. This step is the sole materialization point — do not touch these files in Phases 4-6.

## Phase 8: REPORT

Use this Thai report structure:

```text
Shipped:
- <file path + line ref>: <what changed>

Evidence:
- <command/test/screenshot/schema check>: <result>
- <3-model ACP gate (`review-gate.mjs`)>: <route, packet/isolation evidence, acknowledged identities, per-lane verdict, matching-finding synthesis, or blocker>
- <verification ledger>: <key checks and decisions>

Instruction Diff:
<AGENTS.md / CLAUDE.md / .Codex.local.md diff or "ไม่มี durable instruction change">

Blockers:
- <none or blocker with impact>

Risks:
- <material residual risk only>

Decisions Needed:
- <none or options>
```

Do not narrate agent chatter or cleanup steps.

Optional closeout hooks:

- If a debugging or incident task reached a validated root cause, offer or produce a concise `post-mortem` handoff only when enough evidence exists: repro, cause, fix, validation.
- If Master asks for stakeholder-facing language, hand the engineering truth to `management-talk`; do not mix leadership reframing into the default engineering report.

## Regression Checks for This Skill

Test cases `TC-PA-01`..`TC-PA-33` live in `references/regression-checks.md` — use them when testing or revising `party-mode` and its subskills.

## Failure Modes

- Silent scope creep: Phase 1 confirmation is too broad.
- Mis-trigger: analysis-only prompt enters execution workflow.
- Agent persona drift: critique prompt lacks a distinct persona.
- Verification skipped: Phase 6 is bypassed before Phase 8.
- Over-claim: final report says done without evidence.
- Infinite loop: verify loop exceeds 16 iterations.
- Write conflict: two agents write the same file in one batch.
- Delegated command back to Master: agent asks Master to run a command it can run.
- Append-only instruction drift: Phase 7 adds one-off notes instead of revising durable guidance.
- Runtime mismatch: skill names a tool but does not use an available equivalent.
- Review theater: workflow records that the ACP gate ran but does not read or act on the plan/review output.
- Degraded-panel acceptance: treating two valid reports, a failed AGY lane, or an unacknowledged reserve as a 3-model review.
- Identity collision: primary/reviewer or reviewer/reviewer model/profile overlap reaches synthesis instead of blocking.
- Transport escape: a review plugin, MCP tool, tmux/TUI worker, or raw CLI review replaces the bundled ACP gate.
- Isolation leak: the review packet is not static, the trusted target path came from packet data, the target or host data roots are mounted, the temporary workspace is shared with the target, ACP plan mode is absent, MCP/built-in tools are enabled, or ACP permission requests are not denied.
- Schema theater: a structurally valid report is treated as semantic approval without PM review of the actual findings.
- Model-routing drift: any Codex subagent — thinking or execution — uses anything other than `gpt-5.6-sol` at `ultra` reasoning effort, any Claude subagent uses anything other than Opus at maximum reasoning effort, or non-Codex routing silently misreports unavailable model selection.
- Simpler-path bypass: workflow expands to multi-agent execution without proving the complexity signal still warrants it.
- Ledger theater: evidence or verification ledger exists but does not change decisions or rule anything in/out.
- Sync drift: repo source, installed target, and Codex target disagree after a targeted sync.
- Question dump: grill gate asks multiple questions in one message, or asks a fact findable in the repo.
- Gate bypass: Phase 4/5 starts while a Master decision is still unresolved, the closing confirmation is missing, or the decision pool was emptied by self-resolving tradeoff calls in Phase 3.
- Gate theater: grill answers are collected but never change the plan or the grill ledger.
- Doc spam: the domain hook runs on work with no domain signal, or an ADR is written without passing the three-part test.
- Premature domain writes: `CONTEXT.md` or ADR files are written anywhere before Phase 7 (Phases 3.5-6), or written at all in `party-advise`.

## Success Metrics

Evaluation criteria live in `references/regression-checks.md` — use them when assessing whether a party-mode run met the contract.
