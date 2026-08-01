# The loop graph page — SSOT

What `.tmux-teams/graph.html` may draw, and why. Decided with Master across
2026-07-31 / 08-01; every rule here was written after the picture proved it,
usually by being wrong first. When this file and the code disagree, one of them
is a defect — say which.

Code: `scripts/graph-tour.mjs` (layout, edges, scenes — no I/O) and
`scripts/graph.mjs` (evidence → one card per seat, then the page shell).
Tests: `tests/graph-tour.test.mjs`, `tests/graph.test.mjs`.

## 1. What the page is

**Scene 1 reports the live state. Every other scene explains how work is meant
to travel and updates nothing.** That split decides every question below: if a
thing is evidence it belongs on scene 1, and if it is explanation it does not.

## 2. Nodes

| Node | Rule |
|---|---|
| Delivery team | one node, plus its dispatcher, its workers side by side, its evaluator |
| **Control team** | **ONE node.** Its three seats — grill, unstick, audit — are three jobs at three moments, not three stations. Drawn as peer cards it read as a fourth delivery team. |
| Controller (`outer_controller_id`) | drawn exactly ONCE, as the control node. Never also a band. Its evidence — status, lane, verified model, clock — lives on that node: dropping a card must never drop a fact. |
| Delivered | a real surface, room around the text, and a count. It is a destination, not a footnote. Dashed border, because it is still not a team: nothing is dispatched there and it holds no WIP. |
| Request | **does not exist.** No evidence, no WIP, no seat — a label, not a fact. Every route starting at control already says work enters there, and that can be enforced. |

Control sits **above** the delivery row. It is not a station work passes once and
leaves behind; it is the door in and the seat every team interrupts. In the row,
every escalation ran backwards across the whole board through the cards between.

The Delivered count is **`audited` and nothing else**. `completed` is half
closed — the controller still has to read the delivery as a whole — and
`abandoned` is work that left rather than work that arrived.

## 3. Edges

Two layers that behave differently, and the difference is the rule:

**Structure** — true on every scene, because it does not depend on which route
is being explained.

| Edge | Meaning | Count |
|---|---|---|
| `owns` | the team owns its dispatcher | one per delivery team |
| `assign` | dispatcher gives work to a worker | one per worker |
| `judge` | worker hands artifact + evidence to the team's evaluator | one per worker |
| `reject` | evaluator returns work **to the dispatcher's queue** | one per team |
| `escalate` | this team cannot move this work | one per delivery team |

`reject` goes to the **dispatcher, never the worker**. Back to the queue means
the token is dispatched again, possibly to someone else, and only once the team
is under its WIP limit. Back to the worker would pin rejected work to whoever
produced it — push, not pull.

`escalate` exists for **every** team whether or not any route ends there,
because any team can get stuck at any moment.

**Handover** — filtered to the route on screen, because it answers "how does
THIS work travel", which is exactly what a route changes.

| Edge | Meaning |
|---|---|
| `pull` | a handover. The RECEIVING side takes the token when it has room — including the first leg, where the controller hands to the route's first team |
| `passed` | the controller has read the finished delivery and accepted it |

There is **one kind of handover**, because the ledger records one: `pulled`,
with a `from_team`, for the first leg exactly as for every later hop. A separate
`send` kind claimed the door works differently than the runtime does.

`pull` exists from the controller to **every** team. Holding the front door
means work can go straight to any of them; a route only decides which it uses.

There is **no `audit` edge and no return leg**. Custody ends where the ledger
ends it: the last team writes `completed`, and the controller's audit is a
RELEASING event — it reads the delivery, it never takes the token back. An
earlier version ran a token home to the controller and on to the sink, animating
two handovers no record exists for; worse, the "home" hop reused the outbound
wire without reversing it, so the dot ran controller → team a second time and
then jumped back, and the test guarding it only checked the key was reused.

`passed` is drawn on every scene and **carries no token**, for the same reason.

**Nothing joins two delivery teams except `pull`.** A workflow is an ORDER over
this wiring, never wiring of its own. That is what lets a route scene hide teams
and change nothing else.

## 4. Scenes

1. **The board** — every team, drawn once. `still: true`, `motion: null`.
2..n. **One per workflow**, in declared order. No closing repeat scene; the dots
are the way back.

A route scene hides the teams its route does not use, keeps every other node in
its place, and names the skipped teams in the caption. A node that moves between
scenes reads as a different node.

Every id a scene names must exist in `world`, or the camera frames coordinates
that do not exist.

## 5. Motion — one meaning each

| Motion | Means | Where |
|---|---|---|
| token (SMIL comet) | a work item travelling its route | route scenes only |
| `dry` crawl | **nothing recorded here yet** | any scene except 1 |
| `live` crawl + green ring | **happening now** — a dispatch is running on that seat | any scene, from the ledger |
| `raised` red crawl + red ring | **stuck** — the team holds a token whose last event was `escalated` or `questioned` | any scene, from the ledger |
| green token | **the leg that delivered the work a busy team is holding** — read from the `pulled` event's own `from_team`, never guessed from the route, because a team can sit on several routes and only the record knows which one this token travelled | any scene, from the ledger |

**Scene 1 has no token and no dry crawl.** It answers "who exists", and a board
where everything moves cannot say which parts move. It DOES show live and stuck,
because those are evidence, not explanation — a board that cannot show work in
progress is not reporting a state, it is drawing a diagram.

`escalate` carries **no token**: while work is stuck the token is not travelling,
it is waiting where it stopped. A stuck team gets no arriving token either — one
would contradict its own red ring.

Live rings and live tokens follow their NODE, not the route: they report state,
so they appear wherever that node is on screen and vanish with it.

**Motion is never the only carrier.** A running seat and a stuck team each print
their state as TEXT on the card (`● WORKING NOW`, `! STUCK — waiting on a
decision`), because the rings and the crawl live in an `aria-hidden` SVG and
would otherwise reach nobody using a screen reader, nobody printing, and nobody
who cannot separate the colours.

**A stale board goes quiet.** Motion is a client loop and keeps running long
after the producer stops, so a page whose snapshot has expired stops animating
rather than reporting a system that is no longer there. The tour watches
`data-observation-freshness` on `<body>` and adds `quiet`; `prefers-reduced-
motion` is watched with a `change` listener, not read once at load.

**`live` marks the leg that is happening, not every leg touching the seat.** A
running worker means the ASSIGNMENT is live; the handover to the evaluator has
not happened, because still-running is exactly what "not handed over" means.
Crawling both said the work was in progress AND delivered at the same time.

**A node hidden by a scene leaves the accessibility tree with it** — `inert` and
`aria-hidden`, not `opacity: 0` alone, or a screen reader still reads every team
the route skipped.

An edge is **solid once evidence exists** and dashed until then. What is declared
rather than observed (`owns`, `send`, `pull`, `passed`) is solid always;
`assign`, `judge` and `reject` wait for a record.

Techniques taken from `SylphAI-Inc/skills` codegraph (MIT asserted in prose, but
that repo carries no LICENSE file, so these were reimplemented, not copied):

- `animation-delay = hash(id) × −period` — a deterministic negative delay of
  exactly one period drops each dash into mid-cycle at its own point. Without it
  the whole board beats like a metronome.
- the dash offset must be an exact multiple of the dash period (`5 5` → `-20`)
  or the loop has a visible seam.
- a comet rides the wire's **own `d`**, copied not recomputed: two derivations
  of one curve are two curves waiting to disagree.
- halo peak at 40%, not 50% — quick inhale, slow exhale.

## 6. Camera

Pan, wheel zoom about the pointer, `+` `-` `0`, and a fit button. Five teams of
five cards cannot be legible and complete at the same scale, so the reader gets
the choice.

Cards drop to name-and-state below scale 0.86 and restore lane, model, work and
clock above it. Halos are **measured from the rendered card** after the zoom
class settles — a card is sized by its text, so a fixed rectangle fits nothing,
and measuring before `lean` applies leaves the control halo taller than its card.

The camera frames the route's **teams**, not the labels parked outside the board,
or every scene is as wide as the whole board and the zoom never acts.

## 7. Rules that are easy to break silently

- **`.wire.off` must come after `.wire.dry`.** Equal specificity, so line order
  decides: with `dry` last, an edge told to leave the scene is painted back in.
- **A published board must not reload to advance its own clock.** The
  publisher stamps a new snapshot id every tick, so keying the reload off it
  threw the reader out of whatever they were reading several times a minute.
  Reload when the tour's own JSON changes; a new marker with unchanged data
  means the producer is alive, so extend freshness in place instead. Scene and
  camera are kept in `sessionStorage` so a real reload lands where the reader
  was.
- **No regex literal in `pulse-refresh.mjs`, and no backtick in any shipped
  client string.** The assembly into a published asset eats backslashes and
  ends on a backtick: a regex arrives with its escapes stripped and will not
  parse, and a backtick in a comment closes the template. Use `indexOf`.
- **`TOUR_SCRIPT` may contain no backtick.** It is a template literal; one in a
  comment closes it early and the module stops parsing far from the cause.
- **Strokes need `vector-effect: non-scaling-stroke`.** The camera is a CSS
  transform, so without it every line and dash grows with the zoom.
- **`prefers-reduced-motion` must also call `pauseAnimations()`, and must keep
  listening.** A CSS media query cannot reach SMIL, so honouring it in CSS alone
  is a claim rather than a fact — and reading it once at load ignores every
  reader who turns it on while the page is open.
- **A dash belongs to the `.dry` state, never to a colour rule.** `.w-reject`
  carried `stroke-dasharray` itself, so a rejection with a recorded verdict
  could never render solid however correct the data was.
- **`.wire.off` is `!important`.** Ordering alone held only until the next state
  class was written below it — `.w-escalate.raised` restored opacity and kept
  animating wires already told to leave.
- **Absent is `ENOENT` and nothing else.** `readWorkflowGraph` treated every
  read error as "no graph here", so a directory where the file should be drew
  the bundled template while `check` exited 0.
- **The data goes out as `application/json`, escaped for `<`, U+2028 and
  U+2029.** HTML-entity escaping does nothing inside a `<script>`; what ends the
  block is a literal `</script>` in free text a human typed.
- **Wires are keyed by `from>to>kind`.** Two routes can share a hop, so a
  `from>to` key keeps only whichever was built last and a token rides the wrong
  line.
- **Motion is built once per ROUTE, not per scene.** Two scenes animating the
  same workflow otherwise put two tokens on every hop.

## 8. Known gap

The board draws the controller's **authority** over the order. `pull-controller`
hands a token from team to team without the controller in the middle of every
step, which is why `pull` is drawn team-to-team — but `send` used in both
directions still says more about who decides than about where the token
physically goes. Stated here rather than left for someone to find from a diagram
that disagrees with a tick.

## 9. How to check this page

Not by looking at a screenshot. A still image cannot show whether anything is
moving, and four "fixed" reports were made against one before this was written
down. Measure it:

```js
getComputedStyle(wire).animationName !== 'none'        // is it actually crawling
[...document.querySelectorAll('animateMotion')]        // how many tokens, and on which wires
  .filter(m => m.parentElement.style.display !== 'none')
halo.getBoundingClientRect() vs card.getBoundingClientRect()   // does the ring fit
[...document.querySelectorAll('.wire')]                // count by kind, per scene
```

Every wire carries `data-from` and `data-to`, so a check never has to
reverse-engineer geometry to answer which edge it is looking at.

And a demo or study page must **import** the shipping engine, never copy it. A
pasted copy drifted within an hour, and it was the page being read.
