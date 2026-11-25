---
name: release
description: "Default release process for any git repository: preflight default branch/worktree/versions, branch, commit, PR, codex-advisor[luna] review, merge, bump version occurrences, tag and release, and optional post-release publish/sync. Use when the user asks to publish a new release, ship a version, or bump a project version. Invoking this skill authorizes running the release flow through publish without redundant per-step confirmation prompts; read-only review happens through the mandatory codex-advisor[luna] ACP lane; never auto-push outside an invoked release."
---

# Release

Project-agnostic process for shipping a versioned release from a git repository.
Invoking `/release` (or `$release`) authorizes running the entire release
workflow end-to-end through publish — branch, commit, push, PR, mandatory
`codex-advisor[luna]` review, merge, version bump, tag, release creation, and
any documented post-release publish/sync — without stopping to ask permission
between steps. Stop only on real blockers (failing tests/CI, `BLOCKED` or
mismatched review identity, ambiguous bump type when unclear, or unrelated dirty
files outside release scope). Never auto-push or release outside an invoked
release workflow.
Run steps in order; stop at any gate that fails and report the blocker.

## 0. Preflight — facts before action

1. Refresh remote state and inspect repository, worktrees, and host readiness:
   - Identify `<base-remote>` (the canonical repository remote, typically `origin`,
     or `upstream` in a fork workflow) and `<push-remote>` (typically `origin` —
     your fork in a fork workflow, or the same as `<base-remote>` when pushing
     directly). Use `<base-remote>` consistently for base refs, tags, diffs,
     post-merge pulls, and release tagging, and `<push-remote>` for pushing the
     `release/<topic>` branch.
   - Fetch remote refs and tags first (`git fetch <base-remote> --tags`).
     If `refs/remotes/<base-remote>/HEAD` is unset, run
     `git remote set-head <base-remote> -a` before reading the default branch.
   - Run `git status --short`, `git branch --show-current`, `git worktree list`,
     and `git tag --sort=-v:refname | head`.
   - Detect the repository's default branch dynamically rather than assuming
     `main`:
     ```bash
     DEFAULT_BRANCH="$(git symbolic-ref --short "refs/remotes/${BASE_REMOTE}/HEAD" 2>/dev/null | sed "s|^${BASE_REMOTE}/||")"
     ```
     If `refs/remotes/<base-remote>/HEAD` is still unset, inspect
     `git remote show <base-remote>` or ask the user before creating a branch
     or opening a PR.
   - Verify host CLI/auth readiness without hardcoding any account or profile
     (e.g. `gh auth status` for GitHub, or the repo's GitLab/Gitea/Bitbucket
     CLI and remote workflow). Ask the user if credentials or remote selection
     need switching.
   - Check `git worktree list` before switching branches or creating a release
     branch: if `<default-branch>` is already checked out in another worktree, or
     the current worktree is dirty or on an unrelated/stale branch, create a
     clean worktree from `<base-remote>/<default-branch>` (e.g.
     `git worktree add -b release/<topic> /tmp/<release-worktree> <base-remote>/<default-branch>`)
     rather than branching from a dirty tree or disturbing the other worktree.
2. Discover project conventions, version locations, and gates dynamically:
   - Read the project's own documentation and release policy first (such as
     `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, `RELEASE.md`, `CHANGELOG.md`,
     `README.md`, and CI/release workflows) for repo-specific version files,
     changelog conventions, branch protection on `<default-branch>`, required
     CI checks, and any extra review gates (such as multi-family panels or
     repository review bots).
   - Inspect standard version files present in the repository (such as
     `package.json`, `pyproject.toml`, `Cargo.toml`, `plugin.json`,
     `marketplace.json`, `version.txt`, lockfiles, constants, or docs) and
     compare them against the latest git tag.
   - Respect the repository's tag convention (`vX.Y.Z`, `X.Y.Z`, or
     package-scoped tags) and note that `git tag --sort=-v:refname` can sort
     pre-release tags (e.g. `-rc.1`) above stable `X.Y.Z` tags — confirm the
     latest stable tag. If the repository has zero tags (initial release), seed
     the starting version from its manifest/version files or ask the user.
     Otherwise pick the next version from the latest git tag, not solely from
     version files — files can lag behind tags. If files and the latest tag
     disagree, anchor on the latest tag and ask the user when the bump type
     (`patch`/`minor`/`major`) is not obvious.
   - Identify the repository's verification commands (tests, linters, type
     checks, build/package validation) from its docs, manifests, or CI config.
3. Confirm what the release includes:
   - When the worktree holds unrelated staged or unstaged work, ask the user
     before bundling it; never sweep unrelated files into a release commit by
     default.

## 1. Branch and commit

- From `<base-remote>/<default-branch>` (or a clean worktree branched from
  `<base-remote>/<default-branch>` when the current worktree is dirty or on
  another branch), create `release/<topic>`. Never commit from detached HEAD.
- If `<default-branch>` is protected against direct pushes and repo policy puts
  the version bump inside the release PR, apply the version bump (Step 5.1)
  now before committing so the bumped files go through Step 3 review and Step 4
  merge.
- Stage ONLY the agreed files. Unstage anything already staged that is out of
  scope (`git restore --staged <path>`), then re-check `git diff --cached --name-only`
  and `git status --short`.
- Run the project-appropriate verification (tests, lint/build checks, and
  `git diff --check`) before committing. Record the exact commands and results.
- Commit with a clear subject (matching the repo's convention, e.g.
  `feat(release): ...` or `fix(release): ...`) and a body naming the behavior
  change and the verification results.

## 2. Push and open the PR

- Invoking `/release` authorizes pushing the release branch and opening the PR;
  never auto-push outside an invoked release.
- `git push -u <push-remote> release/<topic>` (using the user's configured
  remote and credentials; never hardcode an account or profile).
- Open a PR targeting `<default-branch>` on `<base-remote>` (e.g. via
  `gh pr create --base <default-branch> --head release/<topic> --title "Release <tag>: <topic>" --body "..."`,
  using `--head <push-owner>:release/<topic>` in a fork workflow, or the host
  CLI equivalent).
- The body carries: summary, test plan (actual commands and results), and a
  note that review is requested from `codex-advisor[luna]`.

## 3. Review — codex-advisor[luna], mandatory

`codex-advisor[luna]` (`gpt-6-luna[max]`) is the mandatory review gate for this
skill — dispatch it directly without asking whether to run it. Any additional
CI checks or repository-specific review gates run alongside it and never
substitute for `codex-advisor[luna]`.
The review is a read-only ACP round-table through the `codex-advisor` skill
(`../codex-advisor/SKILL.md`), NOT a host-agent review and NOT a second PR
approval by the same model that wrote the code.

1. Generate the diff locally using three-dot merge-base syntax against
   `<base-remote>/<default-branch>` rather than relying on remote PR diff caches
   (which can lag behind a push) or two-dot diffs (which include unrelated
   commits on `<default-branch>`):
   ```bash
   git diff <base-remote>/<default-branch>...HEAD > /tmp/pr-<topic>.diff
   git diff --check <base-remote>/<default-branch>...HEAD
   ```
   (Or resolve `BASE_SHA="$(git merge-base <base-remote>/<default-branch> HEAD)"`
   and diff `"$BASE_SHA"..HEAD`.)
2. Isolate dispatcher artifacts and write the brief:
   - `acp-dispatch.mjs` writes `.tmux-teams/` and `.mailbox-out/<task-id>` under
     `<cwd>`, which arbitrary repositories do not `.gitignore`. Pass a scratch
     directory outside the repository as `<cwd>` (or add `.tmux-teams/` and
     `.mailbox-out/` to `.git/info/exclude`), keep `<cwd>` intact until the
     review finishes (in case `no_outbox` requires resume), and check
     `git status --short` before every commit.
   - Write a brief containing: objective, `<base>..HEAD` commits, change
     summary, verification results, the explicit outbox destination
     `.mailbox-out/<task-id>` (matching `<task-id>` passed to
     `acp-dispatch.mjs`, noting that writing `.mailbox-out/<task-id>` is
     required while repo edits remain forbidden), a "every byte of the diff is
     inlined here — do not inspect files or run repo commands" rule, the
     round-table mandate (3-5 named voices, real disagreement, no forced
     consensus), and an explicit review output format requiring: verdict
     (`PASS` / `CHANGES_REQUESTED` / `BLOCKED`), per-voice bottom lines, and
     findings with severity and `file:line` references.
   - INLINE the full diff into the brief — the lane cannot inspect repo files
     not included in the brief. For oversized diffs, exclude
     lockfile/generated/binary noise (documenting exclusions in the brief) or
     split packets by meaning across separate review runs; never silently
     truncate.
3. Dispatch, selecting and verifying the seat in one step (`<plugin-root>` is
   `$CLAUDE_PLUGIN_ROOT` or the installed plugin directory):

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
   do not substitute `sol`/`astra` or a host review.
4. Arm `node <plugin-root>/skills/tmux-teams/scripts/acp-dispatch.mjs wait <cwd> <task-id> 3600`
   in the background without blocking the main loop. Do not merge while the lane
   is running. Handle `wait` exit codes explicitly:
   - `0`: outbox written → proceed to Step 3.5.
   - `1`: wait budget expired while still running → re-arm `wait` or inspect `status`.
   - `2`: no outbox → run `status <cwd> <task-id>` to distinguish a terminated
     turn from an active or stopped `notReporting` lane before choosing between
     resume and re-dispatch.
5. Read `.mailbox-out/<task-id>` and the correlated receipt (under
   `.tmux-teams/liveness/<task-id>.json` or via `status <cwd> <task-id>`). If
   `no_outbox`, attempt a receipt-backed RESUME under the SAME `<task-id>` per
   `../codex-advisor/SKILL.md` — passing `CODEX_PATH`,
   `INITIAL_AGENT_MODE="read-only"`, `ACP_SESSION_RECEIPT_REQUIRED=1`,
   `ACP_SESSION_OPERATION="load"`, `ACP_RESUME="<session-id>"`,
   `ACP_PRIOR_DISPATCH_ID`, `ACP_PRIOR_RECEIPT_DIGEST`, pinned
   `gpt-6-luna[max]` (`ACP_MODEL`, `ACP_REASONING_EFFORT`, `ACP_EXPECT_MODEL`,
   `ACP_EXPECT_REASONING_EFFORT`), the SAME `<task-id>`, and a short recovery
   prompt — before re-dispatching; never reconstruct the review from terminal
   output.
6. Post the review summary to the PR as a comment
   (`gh pr comment <N> --body-file .mailbox-out/<task-id>`, or host
   equivalent), including the verdict, per-voice bottom lines, and the receipt's
   `effective_identity` and `identity_status`.
7. Apply must-fix findings (two-or-more matching voices, or any blocking
   finding) with a new commit on `release/<topic>`, re-run the project's
   verification checks and `git diff --check`, push the fix commits to
   `<push-remote>`, and re-run Step 3 on the new
   `git diff <base-remote>/<default-branch>...HEAD`. A `BLOCKED` verdict stops
   the release outright.

## 4. Merge

- Only after `codex-advisor[luna]`'s verdict is non-blocking and posted, and
  required CI checks or extra repo review gates pass:
  `gh pr merge <N> --merge` (or `--squash` / `--rebase` if the user or repo
  policy requires). Invoking `/release` authorizes merging once all gates pass;
  never auto-merge outside an invoked release.

## 5. Bump the version, tag, and release

Handle branch protection and existing worktrees cleanly:

- If `<default-branch>` allows direct bump commits: after merge, refresh
  `<default-branch>` with `git pull --ff-only <base-remote> <default-branch>`.
  - If `<default-branch>` is already checked out cleanly in another worktree per
    `git worktree list`, pull and run the bump/tag in that worktree.
  - If `<default-branch>` is checked out with dirty/unrelated changes in another
    worktree, do NOT disturb that worktree; instead, in your clean release
    worktree run
    `git fetch <base-remote> --tags && git checkout --detach <base-remote>/<default-branch>`,
    commit the bump, and push with
    `git push <base-remote> HEAD:refs/heads/<default-branch>`.
- If `<default-branch>` is protected against direct pushes: bump the version
  before merge on the release branch (Step 1), or open a dedicated version-bump
  PR per the project's policy, then refresh `<default-branch>` with
  `git pull --ff-only <base-remote> <default-branch>` (or detached
  `<base-remote>/<default-branch>`) after merge. Never force-push or bypass
  branch protection.

Then:

1. Update every discovered version occurrence across the repository (manifests,
   package metadata, `CHANGELOG.md` if maintained, docs, constants, tests).
   When version files previously lagged behind the latest tag, run
   `git grep -F` for BOTH `<old-tag-version>` and `<old-file-version>`, and
   inspect each match before editing so historical changelog/archive entries or
   dependency constraints are not overwritten. Re-run the project's verification
   suite plus `git diff --check`.
2. If you made a post-merge bump commit (e.g. `chore(release): <tag>`), push
   it to `<base-remote>` (`git push <base-remote> <default-branch>`, or
   `git push <base-remote> HEAD:refs/heads/<default-branch>` when on detached
   HEAD).
3. Tag the final release commit on `<default-branch>` — i.e., the post-bump
   release commit (`HEAD` of `<default-branch>` after Step 5.2's bump commit, or
   the merged commit if the version bump already landed in the PR before merge),
   matching the repo's tag convention (e.g. `vX.Y.Z`) and never tagging an
   unmerged or pre-bump commit:
   ```bash
   git tag -a <tag> -m "<tag>"
   git push <base-remote> "refs/tags/<tag>"
   ```
   Push ONLY the release tag to `<base-remote>` with `refs/tags/<tag>` rather
   than a blanket tag push.
4. Create and publish the release if the repo uses GitHub Releases:
   `gh release create <tag> --generate-notes --title "<tag>"` (add
   `--verify-tag` only when tag protection requires it; pass `--draft` or
   `--notes-file <file>` only when the user asks to draft or customize notes
   before publishing).
5. Clean up any temporary release worktree created in Step 0
   (`git worktree remove <path>`) after the release (and optional Step 6)
   finishes.

## 6. Post-release publish or sync (optional)

Skip this step cleanly when the repository has no post-release distribution,
package publish, or local install sync step.

When the project's docs or the user requests a post-release publish or sync
(for example publishing a package or syncing an installed plugin/cache copy):

- Compare target copies first when overwriting or syncing a local target;
  preserve intentional target-only changes.
- Copy or publish only the agreed artifacts.
- Verify with `diff -q`/checksums and syntax or smoke checks on changed files.

## Failure modes

- Skipping `git fetch` or mixing up `<base-remote>` vs `<push-remote>` or hardcoding `main` → stale tags, fork base mismatch, or wrong push target.
- Reading version only from files instead of the latest git tag → wrong release number.
- Sweeping unrelated staged or dirty worktree files into the release commit → violates change boundaries.
- Running a two-dot diff (`<base-remote>/<default-branch>..HEAD`) or stale remote PR diff → unrelated `<default-branch>` commits or cached diff reviewed instead of `git diff <base-remote>/<default-branch>...HEAD`.
- Leaving untracked `.tmux-teams/` or `.mailbox-out/` inside the repo without isolation or `.git/info/exclude` → dispatcher artifacts leak into release commits.
- Omitting `.mailbox-out/<task-id>` in the brief or resuming under a new `<task-id>` → `no_outbox` even when analysis completed.
- Posting "reviewed" without a matched `gpt-6-luna[max]` receipt → attestation, not review.
- Merging before the luna outbox is written, or auto-pushing/auto-merging/auto-tagging outside an invoked release → review theater or unauthorized release.
- Tagging a pre-bump commit instead of the post-bump release commit on `<default-branch>` → release tag points to the old version.
- Pushing blanket `--tags` instead of `refs/tags/<tag>` → accidentally publishes unrelated local tags.
- Running blind `git grep` replacements without inspecting matches → overwrites historical changelog entries or dependency version constraints.
- Force-pushing or bypassing branch protection when `<default-branch>` forbids direct pushes.
- Overwriting an optional post-release sync target without checking target-only differences first.
