---
name: release
description: "Default release process for tmux-teams: branch, commit, PR, codex-advisor[luna] review, merge to main, bump every version occurrence, tag and GitHub release, then sync the installed plugin cache. Use when the user asks to publish a new release, ship a version, or bump the plugin version. Read-only review happens through the bundled advisor ACP lane; never auto-push without the user's explicit order."
---

# Release

Default process for shipping a tmux-teams release. Master-approved 2026-11-17.
Run steps in order; stop at any gate that fails and report the blocker.

## 0. Preflight — facts before action

1. `git status --short`, `git branch --show-current`, `git worktree list`, `git tag --sort=-v:refname | head`.
   - Check `git worktree list` before switching branches or creating a release branch: if `main` is already checked out in another worktree, or the current worktree is on a stale/dirty branch, create a clean worktree from `origin/main` (e.g. `git worktree add -b release/<topic> /tmp/<release-worktree> origin/main`) rather than branching from the dirty tree or disturbing the other worktree.
2. Read the current version from all SIX occurrences:
   - `plugins/tmux-teams/plugin.json`
   - `plugins/tmux-teams/.claude-plugin/plugin.json`
   - `.claude-plugin/marketplace.json` (two fields: `version` and `plugins[].version`)
   - `README.md` — `Current release: **<version>**`
   - `ROADMAP.md` — current-release heading/line
   - `tests/plugin-structure.test.mjs` — `RELEASE_VERSION` constant
   Pick the next version from the latest TAG, not from these files — they can
   lag behind (seen at v0.51.0 with files still on 0.49.0). Ask Master when the
   bump type (patch/minor/major) is not obvious.
3. Confirm what the release INCLUDES. When the worktree holds unrelated staged
   or unstaged work, ask Master before bundling it; never sweep the whole tree
   into a release commit by default.

## 1. Branch and commit

- From `main` (or a clean worktree branched from `origin/main` when the current worktree is dirty or on another branch), create `release/<topic>`. Never commit from detached HEAD.
- Stage ONLY the agreed files. Unstage anything already staged that is out of
  scope (`git restore --staged <path>`), then re-check `git diff --cached --name-only`.
- Run the task-appropriate verification before committing. Record the result.
- Commit with a `feat(release)`/`fix(release)` subject and a body naming the
  behavior change and the verification.

## 2. Push and open the PR

- `git push -u origin release/<topic>`
- `gh pr create --base main --head release/<topic> --title "Release vX.Y.Z: <topic>" --body ...`
- The body carries: summary, test plan (actual commands and results), and a
  note that the review is requested from `codex-advisor luna`.

## 3. Review — codex-advisor[luna], mandatory

The review is a read-only ACP round-table through the `codex-advisor` skill,
NOT a host-agent review and NOT a second PR approval by the same model that
wrote the code.

1. `gh pr diff <N> > /tmp/pr<N>.diff`.
2. Write a brief containing: objective, base/head commits, the change summary,
   the verification results, a "no tools — every byte is here" rule, the
   round-table mandate (3-5 named voices, real disagreement, no forced
   consensus), and the closed-schema JSON output contract. INLINE the full
   diff into the brief — the lane has zero tools and cannot open a file path.
3. Dispatch, selecting and verifying the seat in one step:

   ```bash
   CODEX_PATH="$(realpath "$(command -v codex)" 2>/dev/null)"
   [ -n "$CODEX_PATH" ] || { echo 'no codex binary — stop'; exit 1; }
   INITIAL_AGENT_MODE="read-only" CODEX_PATH="$CODEX_PATH" \
   ACP_SESSION_RECEIPT_REQUIRED=1 ACP_SESSION_OPERATION="new" \
   ACP_MODEL="gpt-6-luna" ACP_REASONING_EFFORT="max" \
   ACP_EXPECT_MODEL="gpt-6-luna" ACP_EXPECT_REASONING_EFFORT="max" \
   node <plugin-root>/skills/tmux-teams/scripts/acp-dispatch.mjs \
     codex <cwd> <task-id> <brief-file> [stall-sec]
   ```

   The receipt must read `effective_identity: gpt-6-luna[max]` and
   `identity_status: matched`. Anything else is a failed review — report it,
   do not substitute sol/astra or a host review.
4. Arm `wait <cwd> <task-id> 3600` with `run_in_background: true`. Do not
   merge while the lane is still running.
5. Read the outbox and the correlated receipt. `no_outbox` → try RESUME under
   the SAME task id (see `codex-advisor/SKILL.md`) before re-dispatching; never
   reconstruct the review from terminal output.
6. Post the verdict, per-voice bottom lines, and the acknowledged identity to
   the PR as a comment (`gh pr comment <N> --body-file <outbox>`).
7. Apply must-fix findings (two-or-more matching, or any blocking finding)
   with a new commit on the same branch, then re-run step 3 on the new diff.
   A `BLOCKED` verdict stops the release outright.

## 4. Merge

- Only after luna's verdict is non-blocking and posted:
  `gh pr merge <N> --merge` (or `--squash` if Master asks).
- Never auto-push or auto-merge without Master's explicit order.

## 5. Bump the version and tag

After merge, on `main` (if `main` is checked out in another worktree per `git worktree list`, pull and run the bump/tag in that `main` worktree rather than forcing a duplicate checkout):

1. Set all six occurrences to the new version. Run the version-structure test
   (`node --test tests/plugin-structure.test.mjs`) — it asserts all six agree.
2. Commit the bump: `chore(release): vX.Y.Z`.
3. `git tag -a vX.Y.Z -m "vX.Y.Z"` and `git push origin main --tags`.
4. `gh release create vX.Y.Z --generate-notes --title "vX.Y.Z"` (add `--verify`
   only when tag protection requires it). Master decides whether the generated
   notes need editing before publish.

## 6. Sync installed cache

- Compare target copies first; preserve intentional target-only changes.
- Copy only the changed skill directories from repo to
  `$HOME/.zcode/cli/plugins/cache/tmux-teams/tmux-teams/<version>/skills/`
  (and any other install root Master names).
- Verify with `diff -q` / checksum and `node --check` on changed scripts.

## Failure modes

- Version from stale files instead of the latest tag → wrong release number.
- Sweeping unrelated staged work into the release commit → violates user-change protection.
- Posting "reviewed" without a matched `gpt-6-luna[max]` receipt → attestation, not review.
- Merging before the luna outbox is written → review theater.
- Bumping fewer than six occurrences → structure test catches it; do not ship around the failure.
- Deleting or overwriting the installed cache without comparing target-only changes.
