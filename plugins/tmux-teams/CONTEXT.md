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
