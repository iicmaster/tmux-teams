# Domain Glossary

**Pulse v4** — The default Pulse snapshot. It preserves Pulse v3 run, verdict,
phase, and phase-source definitions. The `delivery_runtime` projection it also
declares no longer has a producer: the phase subsystem that wrote it was
removed. Pulse is observe-only and has no controller authority.

**Retired Gemini Lane** — Gemini is not a supported tmux-teams worker. The raw
ACP companion rejects that normalized public agent name before honoring a
custom ACP command, so an override cannot silently restore the removed lane.

**ACP Review Gate** — The fail-closed external-review boundary that accepts
only an exact-three, family-distinct ACP panel selected by deterministic policy,
with AGY present in every valid panel.

**Review Profile** — A runner-owned reviewer identity that pins one provider,
model label, ACP command, safety mode, and required configuration
acknowledgements; model output cannot redefine it.

**Model Family** — The normalized provider lineage used to prevent a primary
model from reviewing itself and to select the canonical reviewer/reserve route.
Ambiguous or mixed-family declarations have no valid family.

**Availability Alias** — A policy-owned temporary substitution for an
unavailable profile. `claude-zai` is always the canonical Zai/GLM-5.2 profile,
never a second Claude identity; it is rejected whenever it would duplicate a
final family/model or match the primary family.

**Valid Review** — One strict, bounded review document whose runner evidence,
configured model, isolation controls, provenance, and closed schema all pass
the gate. Transport success or model self-attestation alone is not a valid
review.

**Team** — A reusable resource pool: one dispatcher that owns intake, one or
more workers that run in parallel, and one evaluator that judges the team's own
output. A team carries no routing; the same team serves as many workflows as
need it.

**Workflow** — A route composed from existing teams, owning the order in which
work visits them. A route never revisits a team it has already passed.

**Work Item Token** — The unit of work that travels a route. It carries its own
request, accumulates its own history, and is what a delivery is finally made
against.

**Custody Ledger** — The append-only record of one token's journey, one event
per line. Corrections are appended; nothing is ever rewritten.

**Leg** — One agent's single turn with a token: assigned, then delivered. Legs
are the unit a token's budget is counted in.

**Intake** — The receiving dispatcher's decision on whether its team can start
on what it was handed. Accepting nothing is how a route runs while a team
produces nothing.

**Return** — A refused handoff going back to the team that sent it. It is the
only way work moves backwards; routing never does.

**Occupancy** — Which team is holding a token right now. A team holds it from
the moment it pulls it until the route closes, so a worker exiting does not
empty the queue it was working from.

**Escalation** — Parking a token with the outer controller because the loop
cannot decide it. The controller answers `resume` (with a fresh, bounded
attempt budget) or `abandon`; parking it silently is not an available answer.

**Lost Leg** — An assignment whose process is gone and which recorded nothing.
Recording that is not the same as inventing a delivery.

> The four-phase governed runtime that this glossary used to define alongside
> the loop graph was removed on 2026-08-02, with its commands and its
> documentation. There is one delivery model now: teams are a pool and
> workflows are routes composed from them.
