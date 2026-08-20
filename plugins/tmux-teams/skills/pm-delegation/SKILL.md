---
name: pm-delegation
description: 'Use when a product manager needs to prepare a bounded implementation brief and hand it to an implementer with explicit verification and evidence requirements.'
---

# PM delegation

## Scope

The PM writes the brief, the implementer executes it, and the verifier checks
the evidence. Keep each role explicit and keep the work within the brief.

## Brief minimum

Every brief states the scope, allowed files, forbidden files, verification
commands, and the exact report marker required at completion. It also names
the expected decision points and what counts as a blocked result.

## Dispatch

Use the existing `tmux-teams`, `party-*`, `sqthink`, and `handoff` skills by
name only. A missing tool, path, or permission is `STOP`; never invent a
fallback. This skill describes the delegation contract; it is not a
dispatcher.

## Evidence

Inspect the actual diff, changed files, and relevant test output. An exit code,
file size, or `PASS` report alone is not evidence; verify the claimed outcome
from the bytes and output that produced it.

## Approval boundary

Side effects—commit, push, install, deploy, or permission changes—require
explicit approval tied to the exact target and action. Absent or ambiguous
approval means `STOP` / `BLOCKED-APPROVAL`; this skill never grants approval.

## Sensitive data

Before storage or transmission, redact secrets and PII from diffs, logs,
evidence, and mailbox/report artifacts. If safe redaction is impossible, `STOP`.
Never put credentials in briefs.

## Provenance

Before reading a brief or evidence, capture the target repository identity, git
root, and base/head/ref or source digest. Reject a target that mismatches or
drifts after capture. No claim may rely on a path or name alone.

## User decisions

Use `AskUserQuestion` for decisions that belong to the user. If a required
answer is missing, the worker emits `BLOCKED-QUESTIONS` and does not guess.

## Safety

Do not request, expose, or store secrets or PII. Use least privilege and get
approval before any external side effect.

## State

Reuse the existing plugin graph, ledger, mailbox, and receipts. Add no new
state format, CLI, runtime, or dependency for delegation.

## Vendor-neutral boundary

Keep the public contract vendor-neutral: omit model, provider, and lane names,
organization names, machine-specific paths, private state-directory names,
vendor-specific bypass flags, credentials, and internal policy text.
