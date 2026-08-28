---
name: requirement-audit
description: "Audit or author requirements against a 12-point contract: 6 Grill Categories (Business/Functional, Validation, Exception, Security, Performance, Integration) for ANY requirement, plus 6 INVEST letters (Independent, Negotiable, Valuable, Estimable, Small, Testable) for story-shaped requirements. Use when writing stories/requirements in any planning workflow, reviewing one before dispatch or estimation, coaching an author, or when the user says audit/review this requirement or story, ตรวจ/ซัก requirement, does this story pass INVEST, or grill this story. Returns a per-dimension verdict with blockers and fixes — READY only when every applicable dimension passes."
---

# Requirement Audit

A requirement is ready only when every operational dimension is answered explicitly AND its shape is sound. The **6 Grill Categories govern content** (is each dimension stated, concretely, for THIS domain?); **INVEST governs shape** (is it a well-formed unit of work?). A well-shaped story with vague internals ships ambiguity; a detailed but malformed story ships a planning failure. Both must pass.

## Scope dial

- **Any requirement** (feature request, FR, capability statement) → **Grill only** (6 dimensions).
- **Story-shaped requirement** (implementable unit with acceptance criteria) → **Grill + INVEST** (12 points).

## When to use

- **Authoring guardrail** — while writing: answer the Grill inline in the requirement text (a `📋 Grill:` block, one line per category); run INVEST silently before presenting.
- **Audit mode** — given an existing requirement/story (file or pasted text): return the per-dimension verdict, blockers, concrete fixes. Do not rewrite unless asked; report.

## Part 1 — 6 Grill Categories (content — always)

Each category must be answered **domain-honestly**: a solo local CLI tool, an embedded firmware component, and a public web app have different Performance and Security answers. Boilerplate copied from another domain is a fail, not a pass.

1. 💼 **Business / Functional**
   - Who is the target user (specific: "the on-call operator", not "users")?
   - This feature's goal in one sentence?
   - Is the usage flow complete (entry → steps → end states)?
   - Business rules / conditions that apply?
   - Displayed values computed from what? Which states/statuses exist?

2. 🔍 **Validation**
   - Inputs: what data, which allowed types?
   - Length min/max, formats (regex, data type, structure)?
   - Which inputs are mandatory?
   - Error messages: how, when — and actionable (name the failing item + how to fix, never just "invalid")?

3. ⚠️ **Exception (error handling)**
   - Invalid input or unreachable downstream → system does what?
   - Timeout: retry policy? Count, backoff, stop condition?
   - Mid-transaction error → rollback? What stays atomic?
   - Offline / destination down → fallback (queue? fail-closed? explicit operator error — never silent)?

4. 🔒 **Security**
   - Roles & permissions (a solo tool answers honestly: "the Operator, local only").
   - Authentication / identity required? Actor recorded as what?
   - Secrets: kept out of artifacts/logs? Secret-bearing input rejected?
   - Audit trail: which events, which actor, which correlation id?

5. ⚡ **Performance**
   - Concurrency scale (users + background processes) and data volume?
   - Response-time budgets per operation (state the number)?
   - Peak conditions? (An event-driven tool may honestly answer "none".)
   - Runtime surfaces / devices to support?

6. 🔌 **Integration**
   - Systems touched (APIs, DBs, queues, files, CLIs)?
   - Real-time or batch? Trigger / sync frequency?
   - External failure → fallback or dead-letter queue? Recovery path?

## Part 2 — INVEST (shape — story-shaped requirements only)

| Letter | Question | Fail smells |
| --- | --- | --- |
| **I** — Independent | Completable using only what previous stories delivered — no future-story dependency? | "Storage comes later"; "requires Story 1.4 first" |
| **N** — Negotiable | The *what* fixed, the *how* open? | Prescribing internals where any compliant mechanism works |
| **V** — Valuable | Completing it alone delivers visible value to a real user? | Pure setup stories ("create the database") — merge infrastructure into the first story that delivers value with it |
| **E** — Estimable | A competent dev can size it without a research spike? | "handle everything", "support various" |
| **S** — Small | One dev, one session? | Multiple failure domains; more than one coherent deliverable |
| **T** — Testable | Acceptance criteria executable or evidence-comparable — no unrecorded human judgment? | "works correctly", "user-friendly", "fast" without a budget |

## Output format (audit mode)

```text
Requirement: <title / file>
Grill:  💼 ✅ 🔍 ⚠️(partial) ⚠️ ❌ 🔒 ✅ ⚡ ✅ 🔌 ❌ — 2 blockers, 1 warning
INVEST: I ✅ N ✅ V ❌ E ✅ S ✅ T ❌ — 2 blockers   [omit for non-story requirements]

BLOCKERS:
- [⚠️] no timeout/retry policy on the downstream call
- [V] pure provisioning story — merge into the first value-delivering story

WARNINGS:
- [🔍] error names the failing field but not the fix

VERDICT: NOT READY — 4 blockers
```

## Non-goals

- Not a format linter — it judges content and shape, not file/template compliance (leave that to project tooling).
- Never invents answers: a silent dimension is reported missing, never guessed.

## Provenance

Born 2026-08-28 from a controller/PM interrogation list used in production planning (the six Grill questions, kept in spirit verbatim) fused with INVEST after a real correction: a pure-infrastructure story passed review until the Valuable letter caught it. The domain-honesty rule came from applying the Grill to a solo local tool where web-app boilerplate would have been fiction.
