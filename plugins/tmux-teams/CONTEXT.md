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

**Phase Gate Controller** — The opt-in governed runtime boundary that replays
one Delivery Slice ledger before it reserves or starts an ACP receiver. It
enforces the fixed phase order and exact artifact/acceptance bindings; Pulse
only observes its projection and never actuates it.

**Dispatch Reservation** — The durable pre-spawn intent that binds one dispatch
UUID to the current ledger head, phase run, accepted artifact, receiver, task,
agent, brief digest, timeout, and `advisory_same_uid` trust level. It prevents
blind duplicate dispatch but does not claim process-level exactly-once.

**Child Registration** — The first governed companion mutation after a
reservation. It binds the actual companion process identity to the exact
reservation before any legacy dispatch footprint, ACP session, outbox, or KMS
surface is created.

**Indeterminate Dispatch** — A reserved or partially observed dispatch whose
outcome cannot be proven after a crash or conflicting evidence. It blocks blind
retry until an authorized, append-only manual resolution records either
abandonment or exact terminal evidence.

**Delivery Runtime Projection** — A bounded, path-free, observe-only Pulse input
derived from strict Phase Gate replay. It exposes four phase runs, handoff
states, receiver consumption, replay head, and bottleneck age/owner role while
retaining `advisory_same_uid` and zero actuation authority.

**Governed Marker** — The strict, non-symlink
`.tmux-teams/phase-gate.json` opt-in boundary. Its immutable store binding must
match the controller-provided environment before the ACP companion reads a
brief or creates any dispatch/session/outbox/KMS side effect.

**Pulse v4** — The default Pulse snapshot. It preserves Pulse v3 run, verdict,
phase, and phase-source definitions and adds an optional closed
`delivery_runtime` projection. Both runtime data and the vendored D3
operational graph are observe-only and have no controller authority.

**Retired Gemini Lane** — Gemini is not a supported tmux-teams worker. The raw
ACP companion rejects that normalized public agent name before honoring a
custom ACP command, so an override cannot silently restore the removed lane.
