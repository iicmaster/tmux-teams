# tmux-teams plugin repo — agent instructions

<!-- bmad:context -->
<!-- Verified 2026-11-25 against a532b82. Managed by bmad-project-context;
     edits inside this block are replaced on refresh. Keep anything you want
     preserved outside the markers. -->

## tmux-teams

A Claude Code directory marketplace shipping one plugin (`tmux-teams`, under
`plugins/tmux-teams/`) and the canonical source of its bundled skills. Node
with zero runtime dependencies; `node --test` is the whole test story (CI runs
Node 20 and 24). **`ROADMAP.md` is the standing goal** — read it before
choosing work. Detailed dated incident logs and historical measurements live in
`CASEBOOK.md`.

## Policy

- **Owner approval gates:** Never `git push`, open a PR, merge, tag, or publish
  without Master's explicit order for that action.
- **Release flow (Master-approved, 2026-11-17 / reaffirmed 2026-11-25):** Branch,
  commit only scoped files, open a PR, and run a mandatory read-only
  `codex-advisor[luna]` (`gpt-6-luna[max]`, `identity_status: matched`) review
  on the local diff (`git diff origin/main...HEAD`). Merge on CI green plus a
  non-blocking luna verdict (`chatgpt-codex-connector` bot is advisory, not a
  merge blocker). After merge, bump the version and tag on `main` (see
  `plugins/tmux-teams/skills/release/SKILL.md`).
- **GitHub account & remotes:** Push as `iicmaster` (`gh auth switch --user
  iicmaster` first). The active account is often `ngs-th`, which has read-only
  access on `origin` while `fork` accepts its push silently. Verify
  `git status -sb` shows `main...origin/main` with no `ahead`.
- **No leaks:** Commit no secret, token, customer data, email, or machine-only
  home path.
- **Tracked files:** Only `.github/`, `.claude-plugin/`, `.gitignore`,
  `agent-plugins/`, `plugins/`, `tests/`, `scripts/`, `README.md`, `CLAUDE.md`,
  `AGENTS.md` (relative symlink to `CLAUDE.md`), `CASEBOOK.md`, `ROADMAP.md`,
  `RELEASE-PLAN.md`, `HANDOFF.md`, and `.published-*.json` /
  `.roadmap-published.json` markers are tracked. BMAD scaffold dirs, `.claude/`,
  `.zcode/`, and `/docs/` stay gitignored.
- **Separate parent repo:** `~/agent-skills` is a separate repository on a
  different account whose submodule pin feeds its OpenClaw bridge (and purges
  duplicate copies via `PLUGIN_DELIVERED`). Routine releases no longer touch
  `~/agent-skills`; never commit there unless explicitly ordered.

## Model policy (ACP routes)

- **Every AGY role defaults to `gemini-pro-orchestrator-neon`** (orchestrator,
  thinker, reviewer, advisor, worker/execution). Only when `agy models` succeeds
  and omits it do thinker/advisor/review gate fall back to
  `gemini-4-hydrogen-xhigh` and workers to `gemini-4-hydrogen-medium` (unreadable
  list keeps Neon and fails closed; named seats and `lanes.json` overrides are
  never resolved over). Supported Gemini families include
  `gemini-4-{neon,carbon,argon,hydrogen}-*`, `gemini-pro-orchestrator`,
  `gemini-pro-orchestrator-argon`, and `gemini-3.8-flash-*`.
- **Always pin AGY explicitly:** Pass both `ACP_MODEL` and `ACP_EXPECT_MODEL`,
  and verify `identity_status: matched` in the receipt.
- **Version floors (fail closed):**
  Floors: fable `5.2` (bare `fable` refused), Codex sol/astra `6.2`, terra `6.1`, luna `6`;
  Gemini 3.1 stays banned. Raising a floor requires editing all three copies together
  (`plugins/tmux-teams/skills/party-mode/scripts/review-profiles.mjs`,
  `plugins/tmux-teams/skills/tmux-teams/scripts/acp-dispatch.mjs`,
  `plugins/tmux-teams/skills/tmux-teams/scripts/acp-companion.mjs`).
- **No automatic quota fallback:** On 429/rate-limit, stop and ask Master
  instead of silently switching seats.

## Where things are

- Standing goal: `ROADMAP.md`; session state: `HANDOFF.md`; release checklist:
  `plugins/tmux-teams/skills/release/SKILL.md`.
- Shipped skills & scripts: `plugins/tmux-teams/skills/` (list of record:
  `SKILLS` in `tests/plugin-structure.test.mjs`).
- Settled architecture decisions: `plugins/tmux-teams/docs/adr/`.
- Historical incident casebook (open when modifying `scripts/gate-required.mjs`,
  `acp-companion.mjs`, `review-gate.mjs`, or verifying published HTML pages):
  `CASEBOOK.md`.
- Published pages render via `scripts/roadmap-render.mjs` and are gated by
  `scripts/roadmap-gate.mjs` (version-line-only bumps in `ROADMAP.md` do not
  mark the page stale; publish when roadmap content changes).

## Running and verifying

- Run bare `node --test` (never `node --test tests/` — fails on Node 24 with
  `MODULE_NOT_FOUND`). Gate on `grep -q '^ℹ fail 0$'`, never `grep '✖'`.
- Read the skipped count as unexecuted work: baseline on `main` is 6
  unconditional skips (retired kimi/zai/qwen profiles); investigate any new
  skip.
- Run full `node --test` only on a quiet machine, serialized through one caller
  (never in parallel across subagents or beside live ACP lanes).
- `node scripts/run-fast.mjs fast` is an inner tier (no ACP, CLI, publisher, or
  schema tests); run bare `node --test`, `git diff --check`, and
  `claude plugin validate --strict .` before committing.
- `node scripts/gate-required.mjs` reads committed `<last-tag>..HEAD` only —
  commit first or it falsely reports `EXEMPT`.

## Conventions & known pitfalls

- **Worktree & git hygiene:** Give every writing subagent its own git worktree
  outside `$TMPDIR`; keep the primary checkout off limits. Stage only scoped
  files and inspect `git diff --cached --name-only`. Update published/stale
  branches with `git merge`, never `git push --force`.
- **Edit canonical `CLAUDE.md`, not `AGENTS.md`:** `AGENTS.md` is a relative
  symlink (`CLAUDE.md`); atomic-rename edits on `AGENTS.md` replace the symlink
  with a plain file.
- **Version bumps:** Bump all 6 files / 7 guarded places (`.claude-plugin/marketplace.json`
  has `metadata.version` + `plugins[0].version`), then run `rg -F '<old-version>'`
  across the repo to catch prose copies such as `README.md`.
- **ACP `no_outbox`:** Record the session id before cleaning any run directory;
  try `ACP_RESUME=<session-id>` with an explicit "say I have nothing plainly if
  context is gone" instruction before paying for a fresh run.
- **Published pages:** Measure AND look at a screenshot; report measured
  outcomes, never constants you edited.
- **Scripted edits & tests:** Assert `old in s` before writing; test boot paths
  by spawning from a path with spaces (`realpathSync(fileURLToPath(...))`);
  assert the exact diagnostic sentence, not merely non-empty output.

<!-- /bmad:context -->
