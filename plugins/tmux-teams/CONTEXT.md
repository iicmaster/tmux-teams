# Domain Glossary

**Project Delivery Loop** — The PM-tracked outer coordination loop that advances
delivery across phase boundaries, observes bottlenecks, and handles exceptions
without replacing routine receiver acceptance.

**Phase Team** — One of the four Requirement, Prototype, Development, or QA
teams that owns an inner work loop and produces its receiver-checkable
phase-exit artifact.

**Handoff Attempt** — One immutable, actor-authorized proposal of a phase-exit
artifact across an exact receiver boundary, recorded as an event-replayed
terminal history.

**Delivery Slice** — The globally unique, stable intention-to-treat unit
assigned to one experiment arm and followed through the fixed analysis and
maturity window.

**Evidence Certification Claim** — A structured local claim bound to manifest
and dataset evidence. It remains `advisory_same_uid` and external-review-only;
it cannot authenticate a certifier, certify an outcome, or issue a business
decision.

**ProjectDelivery** — The terminal receiving boundary after QA, not a fifth
Phase Team. Its receiver owns routine acceptance of `qa_release_evidence`; the
PM tracks the outer loop and owns exception coordination.

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
