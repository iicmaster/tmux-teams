---
description: Run a tmux-teams mailbox PM run — dispatch bounded tasks to codex workers via tmux and adversarially verify their outboxes
argument-hint: "<target repo + worker briefs, or a description of the run>"
allowed-tools: Workflow, Bash, Read, AskUserQuestion, TaskCreate, TaskUpdate
---

Run the tmux-teams mailbox orchestration Workflow.

Raw slash-command arguments:
`$ARGUMENTS`

Core rules:

- Workers are **codex-only** today (`mailbox-run.js` launches `codex` in each tmux window).
- MANDATORY before any dispatch (tmux-teams SKILL.md §7, Master directive 2026-07-19): (1) plan with the `tmux-teams:sqthink` skill — worker split, per-worker brief + `verify_cmd`, dependency order, stakes; (2) create one task per worker with TaskCreate (brief summary, verify_cmd, `addBlockedBy` for dependency order). Do NOT invoke the Workflow until both the sqthink plan and the tasks exist; update each task's status as its outbox lands.
- Always invoke the workflow with explicit plugin paths — never rely on `~/.claude/skills` copies (they may not exist):

```
Workflow({
  scriptPath: "${CLAUDE_PLUGIN_ROOT}/skills/tmux-teams/workflows/mailbox-run.js",
  args: {
    repo: "<abs path to target repo>",
    deliverSh: "${CLAUDE_PLUGIN_ROOT}/skills/tmux-teams/scripts/deliver.sh",
    workers: [
      { "id": "task-1", "brief": "<bounded task>", "verify_cmd": "<command>", "stakes": "normal" }
    ]
  }
})
```

- Derive `repo` and `workers` from the arguments; use AskUserQuestion only when the target repo is genuinely ambiguous.
- Gate completion per tmux-teams SKILL.md §7: PM adversarial verify for normal runs; for high stakes hand the evidence to party-mode's 3-model review via the review plugins (never through tmux workers).
- Report with quoted worker outboxes, not paraphrase.
