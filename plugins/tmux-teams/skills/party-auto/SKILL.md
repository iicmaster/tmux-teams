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
- Preserve the `party-mode` contracts: Thai user-facing output, user-change protection, 3-model plan/completion review, grill gate (Phase 3.5 decision interview — ask one question at a time until all decisions are resolved and Master confirms shared understanding before executing), verification ledger, max 16 verify iterations, and no auto-push.
