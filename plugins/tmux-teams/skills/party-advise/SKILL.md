---
name: party-advise
description: "Subskill of party-mode for read-only advice, plan critique, architecture or tradeoff review, risk analysis, recommendations, and adversarial review without implementation. Use when the user explicitly invokes $party-advise, asks for Party Mode advice, asks 'คิดยังไง', 'ช่วยคิด', 'แนะนำ', 'review plan', 'advise', 'critique', 'tradeoff', or wants a recommendation before deciding whether to execute. Do not edit files; hand off to party-auto only when execution is requested."
---

# Party Advise Subskill

Use this as the read-only advisory lane of `party-mode`.

## Source Of Truth

Before acting, read the sibling `party-mode/SKILL.md` from the same skill root and follow its `party-advise` lane.

Common locations (try in order):

- Sibling: `../party-mode/SKILL.md` relative to this skill's own directory — works in every layout, including plugin installs (e.g. the `tmux-teams` plugin's `skills/` dir)
- Repo source: `skills/shared/party-mode/SKILL.md`
- Installed roots: `$HOME/.agents/skills/party-mode/SKILL.md`, `$HOME/.codex/skills/party-mode/SKILL.md`, `$HOME/.openclaw/skills/party-mode/SKILL.md` (`$HOME/.claude/skills/` may have no copy — Claude Code gets these skills via the `tmux-teams` plugin)

If `party-mode` is unavailable, report the missing umbrella skill and stop instead of reconstructing the workflow from memory.

## Routing

- Keep the task read-only: inspect, compare, critique, and recommend; do not modify files, sync targets, commit, push, or deploy.
- Apply the `domain hook` read-only when its activation condition holds (no interactive grill interview in this lane): report term/ADR candidates in the advisory output's `Domain candidates` field — never write `CONTEXT.md` or ADR files here.
- Use the 3-model review when the advice is high-risk, architectural, cross-cutting, production-impacting, or explicitly adversarial.
- Skip the 3-model review for simple advice and report the lighter path.
- If the user asks to implement the recommendation, switch to `party-auto` and feed the advisory open questions into its grill gate (Phase 3.5) so they are resolved before execution.
