# Regression Checks for party-mode

Use these cases when testing or revising `party-mode` and its subskills:

- `TC-PA-01`: execution command with two files and a schema dependency.
- `TC-PA-02`: analysis-only prompt exits the skill cleanly.
- `TC-PA-03`: verification fails twice and passes on the third loop.
- `TC-PA-04`: durable project learning revises `AGENTS.md` or `CLAUDE.md` and includes the diff.
- `TC-PA-05`: multiple concerns touching one file merge into one owner task.
- `TC-PA-06`: runtime lacks a named tool and uses a safe equivalent with evidence.
- `TC-PA-07`: Phase 2 invokes the bundled `node <party-mode>/scripts/review-gate.mjs <packet> <runner-owned-absolute-target>` ACP-only workflow with a static packet before critique agents; no review plugin, MCP review tool, tmux/TUI review, or raw CLI review is used.
- `TC-PA-08`: Phase 6 local tests pass but the ACP 3-model gate finds a must-fix issue, causing a fix loop and re-review.
- `TC-PA-09`: ALL Codex subagents — thinking-heavy and execution-heavy alike — route to the current Codex frontier model (`gpt-5.6-sol` at `ultra` reasoning effort; Frontier always, 2026-07-14) with no Spark or inherited-default downgrade; non-Codex runtimes report equivalent routing or model-selection limits.
- `TC-PA-10`: simpler-path gate records objective, cheaper path, and full-workflow justification before Phase 2.
- `TC-PA-11`: skill sync preserves target-local changes, verifies the repo source first, and syncs only the changed skill.
- `TC-PA-12`: post-sync verification proves repo, `~/.agents`, and `~/.codex` target copies match when those targets are in scope.
- `TC-PA-13`: a review report missing verdict, blockers, evidence references, residual risks, runner-owned profile identity, configured-model acknowledgement, or schema validity is blocked rather than synthesized.
- `TC-PA-14`: verification ledger has one entry per verification iteration.
- `TC-PA-15`: debugging tasks record reproduce/fail-path/falsifier before fix execution, or explicitly record why reproduction is unavailable.
- `TC-PA-16`: postmortem/status hooks stay optional and are not added to the default report unless the task qualifies.
- `TC-PA-17`: Phase 3 leaves two unresolved decisions; the grill gate asks them one at a time (upstream first) with a recommendation each, and Phase 4 starts only after both answers plus a closing shared-understanding confirmation (or an explicit waiver) are recorded in `grill_ledger`.
- `TC-PA-18`: Phases 2-3 leave zero unresolved decisions; the grill gate records `grill_ledger: []` with `grill_ledger_reason` and continues without inventing questions.
- `TC-PA-19`: a fact answerable from the repo is looked up by the agent instead of being asked in the grill gate.
- `TC-PA-20`: a tradeoff/scope objection in Phase 3 is deferred into the grill ledger instead of being self-resolved by the agent, even though the agent has a confident recommendation.
- `TC-PA-21`: a repo with `CONTEXT.md` plus a plan introducing a new term activates the domain hook; the gate challenges the term read-only, records `term_candidates`, and Phase 7 merges the glossary entry.
- `TC-PA-22`: a bug fix with no domain signal keeps the domain hook off — even in a repo that already has `CONTEXT.md` — with the `domain_hook: active no` call recorded in the ledger; no `CONTEXT.md` edit and no glossary questions.
- `TC-PA-23`: an `adr_candidates` entry failing the three-part test is dropped in Phase 7 and the one-line reason is reported in Phase 8; the ADR file is not written.
- `TC-PA-24`: in `party-advise`, a plan meeting the domain-hook activation condition surfaces term/ADR candidates in the advisory output's `Domain candidates` field, with no `CONTEXT.md` or ADR file written.
- `TC-PA-25`: an execution batch attempting to write `CONTEXT.md` or an ADR during Phases 4-6 is deferred to Phase 7.
- `TC-PA-26`: a primary `codex`/`gpt` run routes exactly to AGY, Kimi K3, and Zai GLM-5.2; Codex is absent from the final panel.
- `TC-PA-27`: AGY timeout, startup failure, malformed acknowledgement, or invalid report blocks both plan and completion review; it cannot be replaced.
- `TC-PA-28`: a failed Kimi K3 or Zai GLM-5.2 lane may use only a gate-approved eligible reserve, and the final panel still has exactly three valid distinct reviewers including AGY.
- `TC-PA-29`: fewer than three valid reports, duplicate reviewer identity/model/profile, or a reviewer equal to the primary blocks synthesis; a two-reviewer agreement never passes.
- `TC-PA-30`: Claude routes to AGY + Codex + Kimi with a valid Zai reserve. Kimi routes to AGY + Codex + Zai, and Zai routes to AGY + Codex + Kimi, but neither has a usable reserve while direct Claude is limited because `claude-zai` would duplicate/retry Zai or match the primary; Gemini, AGY, and unknown primaries fail closed rather than being inferred by the PM.
- `TC-PA-31`: each lane receives the same static packet in a fresh temporary workspace, starts in ACP plan mode with ACP permission denial, and explicitly acknowledges its routed model/config; runner-owned evidence labels Kimi as `kimi/k3` and Zai as `zai/glm-5.2`.
- `TC-PA-32`: a lane timeout is recorded as a gate failure or triggers only an eligible non-AGY reserve; no raw CLI, tmux, review plugin, or MCP review fallback is attempted.
- `TC-PA-33`: the gate's executable workflow is invoked for both Phase 2 and Phase 6, and its schema validates transport, routing, identity, acknowledgement, packet, isolation, timeout, and report structure while PM review evaluates semantics.
- `TC-PA-34`: a packet-supplied decoy `target_repo` cannot change the runner-owned canonical target; bubblewrap hides the real target and host user-data roots, uses an ephemeral provider HOME and new PID namespace, and denies target reads/writes.
- `TC-PA-35`: mixed-family primary text such as `gpt-5.6 claude-opus` fails closed; the sanctioned `claude-kimi` and `claude-zai` ACP aliases retain their routed families.
- `TC-PA-36`: Zai accepts only the explicit HTTPS `api.z.ai/api/anthropic` endpoint without URL credentials/query overrides; other endpoints fail closed before launch.
- `TC-PA-37`: pre-prompt/effectful tool calls, credential-like output (including JSON Unicode escapes), nonzero post-response exits, malformed reports, and more than the bounded packet size all fail closed.
- `TC-PA-38`: sandbox evidence states the network and same-process auth residuals; it never claims cryptographic remote-model proof or zero live-service reachability.
- `TC-PA-39`: AGY may emit only a completed `read` whose every canonical location is inside the copied isolated provider `builtin/` tree, is exactly the canonical fresh neutral workspace root, or is the one runner-owned read-only static-review guide; missing paths, all other descendants, relative escapes, workspace symlinks including `link/..`, mixed scopes, target/arbitrary reads, and search/fetch/edit/execute calls fail closed, and the runtime/workspace scopes have separate counters.
- `TC-PA-40`: an objection synthesis still writes its structured attempts/reviews/must-fix report to stdout while returning exit 5; unrelated single-reviewer findings remain residual PM judgments rather than consensus blockers.
- `TC-PA-41`: sensitive assignments, HTTP authorization/API-key headers, and credential query parameters embedded in diff/log strings are redacted without consuming the following line; the decoded reviewer output receives the same screening.
- `TC-PA-42`: a target-owned executable that shadows `npx`, `kimi`, `bunx`, or AGY through `PATH` or a symlink is rejected before launch; the resolved executable must match the routed profile and a trusted runtime root.
- `TC-PA-43`: direct Claude is never launched while provider-limited; a `claude-zai` availability fallback launches only when AGY and three distinct non-primary families/models remain, otherwise the gate blocks.
- `TC-PA-44`: the Zai/claude-zai profile pins `MAX_THINKING_TOKENS=4096` through the runner-owned allowlisted environment; adaptive thinking may not bypass stdout or timeout bounds.

## Success Metrics

Use these when assessing whether a party-mode run met the contract:

- Execution command classified correctly in Phase 1.
- Simpler-path gate justifies full workflow or exits cleanly.
- Model routing evidence records the selected model or runtime limitation for both thinking-heavy and execution-heavy subagents.
- Phase 2 plan includes steps, file targets, dependencies, risks, and verification targets.
- Phase 2 includes ACP-gate evidence (route, static packet, isolation, acknowledgement, and exactly three valid reports including AGY) or an explicit review blocker.
- Phase 3 receives substantive critique from distinct personas.
- Phase 3.5 resolves or explicitly waives every open decision before Phase 4, with a grill ledger entry per decision and a closing shared-understanding confirmation.
- Domain hook records its activation call in the ledger, activates only on a real plan-level domain signal, and Phase 7 materializes only qualifying candidates; in `party-advise` candidates are reported, never written.
- Phase 4 has zero same-batch file ownership conflicts.
- Phase 6 passes local verification and the ACP-only exact-three 3-model review within 16 iterations or reports a blocker.
- Verification ledger explains what each check proved and what changed next.
- Phase 7 revises project instructions only when there is durable guidance to normalize.
- Phase 8 cites evidence, not intent.
