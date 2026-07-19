---
description: Run a tmux-teams mailbox PM run — dispatch bounded tasks to codex workers via tmux and adversarially verify their outboxes
argument-hint: "<target repo + worker briefs, or a description of the run>"
allowed-tools: Workflow, Bash, Read, AskUserQuestion
---

Run the tmux-teams mailbox orchestration Workflow.

Raw slash-command arguments:
`$ARGUMENTS`

Core rules:

- Workers are **codex-only** today (`mailbox-run.js` launches `codex` in each tmux window).
- For multi-worker or high-stakes runs, plan the dispatch with the `tmux-teams:sqthink` skill first (tmux-teams SKILL.md §7): worker split, per-worker brief + `verify_cmd`, dependency order, stakes.
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
