---
name: party-auto
description: "Subskill of party-mode for executing moderately complex, high-risk, multi-file, or production-impacting work. Use when the user explicitly invokes $party-auto or asks to implement, fix, build, ship, execute, apply a plan, or do the work, and multi-agent planning, critique, file ownership, verification, and 3-model review reduce risk. Do not use for pure advice, analysis-only review, brainstorming, or trivial one-step edits; use party-advise instead."
---

# Party Auto Subskill

Use this as the execution lane of `party-mode`.

## Source Of Truth

Before acting, read the sibling `party-mode/SKILL.md` from the same skill root and follow its `party-auto` lane.

Common locations (try in order):

- Sibling: `../party-mode/SKILL.md` relative to this skill's own directory — works in every layout, including plugin installs (e.g. the `tmux-teams` plugin's `skills/` dir)
- Repo source: `skills/shared/party-mode/SKILL.md`
- Installed roots: `$HOME/.agents/skills/party-mode/SKILL.md`, `$HOME/.codex/skills/party-mode/SKILL.md`, `$HOME/.openclaw/skills/party-mode/SKILL.md` (`$HOME/.claude/skills/` may have no copy — Claude Code gets these skills via the `tmux-teams` plugin)

If `party-mode` is unavailable, report the missing umbrella skill and stop instead of reconstructing the workflow from memory.

## Routing

- Continue only when the request is an execution task and the simpler-path gate still justifies Party Mode.
- If the request is advisory, analysis-only, or review-only, switch to `party-advise`.
- Preserve the `party-mode` contracts: Thai user-facing output, user-change protection, bundled ACP-only 3-model plan/completion review through `node <party-mode>/scripts/review-gate.mjs <packet> <runner-owned-absolute-target>`, exact-three validation (AGY-required in default `strict` mode, or three distinct verified OpenCode free models under explicit runner/CLI `REVIEW_GATE_MODE=opencode-free`), grill gate (Phase 3.5 decision interview — ask one question at a time until all decisions are resolved and Master confirms shared understanding before executing), verification ledger, max 16 verify iterations, and no auto-push. Do not replace the review gate with plugins, MCP review tools, tmux/TUI review, raw CLI review, or a two-reviewer fallback.
- **Reviewer seats (Master 2026-11-17; seat/ladder changed Master 2026-11-18):** each of the three gate lanes is PROMPTED to hold a `bmad-party-mode` round-table with the persona/seat of its `*-advisor` skill — `agy-advisor[hydrogen]` (`gemini-4-hydrogen-high`), `codex-advisor[luna]` (`gpt-6-luna[max]`), and `oc-advisor` free seat `deepseek-v4.1-flash-free` — while the gate keeps its own transport, isolation, acknowledgement, and closed-schema JSON checks. `qwen` and `zai` are gone; `kimi` is retired permanently. The three seats must be distinct by acknowledged MODEL, not declared family. In `strict` mode AGY failure blocks after primaries settle, without substitution; when any eligible non-AGY lane fails (quota, timeout, schema, or transport) the gate walks the opencode ladder in strength order `deepseek -> inkling -> glm -> mimo -> hy4 -> longcat -> flint -> beam -> nemotron-super-vl -> nemotron-lightning` (via `planFallback`), replacing each failed seat until three distinct models answer or eligible reserves are exhausted, at which point the gate blocks and the PM reports the failure cause and asks Master how to proceed (e.g., retry, wait for the daily quota reset when quota-limited, or skip the review). Never step OUT of the strength order to avoid asking; the order IS the strength ranking.
- **Free-only opt-in mode (`REVIEW_GATE_MODE=opencode-free`):** for fresh machines bootstrapped with `tmux-teams:tmux-teams-setup` (`bmad-method` + OpenCode v2 only, no AGY/Codex/Claude), opt in with `REVIEW_GATE_MODE=opencode-free` to seat three distinct verified free OpenCode models (`deepseek-v4.1-flash-free`, `inkling-2-small-free`, `mimo-v2.6-flash-free`) and label `singleProviderQuorum: true` on the report. Strict AGY-required mode remains the default.
