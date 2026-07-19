# Regression Checks for party-mode

Use these cases when testing or revising `party-mode` and its subskills:

- `TC-PA-01`: execution command with two files and a schema dependency.
- `TC-PA-02`: analysis-only prompt exits the skill cleanly.
- `TC-PA-03`: verification fails twice and passes on the third loop.
- `TC-PA-04`: durable project learning revises `AGENTS.md` or `CLAUDE.md` and includes the diff.
- `TC-PA-05`: multiple concerns touching one file merge into one owner task.
- `TC-PA-06`: runtime lacks a named tool and uses a safe equivalent with evidence.
- `TC-PA-07`: Phase 2 includes the 3-model review and revises the plan before critique agents.
- `TC-PA-08`: Phase 6 local tests pass but the 3-model review fails, causing a fix loop and re-review.
- `TC-PA-09`: ALL Codex subagents — thinking-heavy and execution-heavy alike — route to the current Codex frontier model (`gpt-5.6-sol` at `ultra` reasoning effort; Frontier always, 2026-07-14) with no Spark or inherited-default downgrade; non-Codex runtimes report equivalent routing or model-selection limits.
- `TC-PA-10`: simpler-path gate records objective, cheaper path, and full-workflow justification before Phase 2.
- `TC-PA-11`: skill sync preserves target-local changes, verifies the repo source first, and syncs only the changed skill.
- `TC-PA-12`: post-sync verification proves repo, `~/.agents`, and `~/.codex` target copies match when those targets are in scope.
- `TC-PA-13`: 3-model review output without verdict, blockers, evidence references, and residual risks is retried or marked blocked.
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

## Success Metrics

Use these when assessing whether a party-mode run met the contract:

- Execution command classified correctly in Phase 1.
- Simpler-path gate justifies full workflow or exits cleanly.
- Model routing evidence records the selected model or runtime limitation for both thinking-heavy and execution-heavy subagents.
- Phase 2 plan includes steps, file targets, dependencies, risks, and verification targets.
- Phase 2 includes 3-model review evidence or an explicit review blocker.
- Phase 3 receives substantive critique from distinct personas.
- Phase 3.5 resolves or explicitly waives every open decision before Phase 4, with a grill ledger entry per decision and a closing shared-understanding confirmation.
- Domain hook records its activation call in the ledger, activates only on a real plan-level domain signal, and Phase 7 materializes only qualifying candidates; in `party-advise` candidates are reported, never written.
- Phase 4 has zero same-batch file ownership conflicts.
- Phase 6 passes local verification and the 3-model review within 16 iterations or reports a blocker.
- Verification ledger explains what each check proved and what changed next.
- Phase 7 revises project instructions only when there is durable guidance to normalize.
- Phase 8 cites evidence, not intent.
