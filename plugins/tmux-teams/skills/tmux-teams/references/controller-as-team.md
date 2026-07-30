# Design — the controller is a team, and work enters through it

**Status: DESIGNED, NOT BUILT (2026-07-31).** No code implements any of this.
The contract's §4.6 still describes what the runtime does today: an operator
writes `opened` straight at a delivery team. This document is the design that
replaces it, written to be complete enough to build from and to be argued with
before anyone builds it.

The decisions here were made by Master on 2026-07-31. Where a choice was made,
the reason sits next to it — a decision whose reason is lost gets re-litigated
by whoever inherits it.

---

## 1. What is wrong today

An operator admits work with one command:

```json
{"event":"opened", "workflow":"default",
 "agent_id":"requirement_dispatcher", "to_team":"requirement",
 "reason":"work admitted by operator"}
```

Two defects, both structural:

**The auditor never saw the request.** §9 makes the outer controller the only
role that can ask whether what came out of the end is what was asked for. It is
handed that question at the end of a route it had no part in admitting. In
Master's words: *"PM เป็นคนตรวจงานคนสุดท้าย แต่จะไม่รู้ว่างานนี้มาจากไหนได้อย่างไร"* — the last
reviewer cannot know where the work came from.

**Nobody accountable chose the route.** Whether a token takes `hotfix` or the
long way round is the most consequential decision made about it, and it is made
by whoever typed the command, with no evidence of why.

There is a third, quieter one: nothing interrogates the request. A vague ask
becomes four teams' worth of legs before anyone notices it was vague.

---

## 2. The shape of the fix

The controller stops being an exception and becomes **an ordinary team**,
declared in `graph.json` like any other, with **one worker, so WIP 1**.

Everything the board already has then applies to it with no new mechanism:
occupancy (§6), the pull (§7), the WIP limit (§3.1), the placement rule. The
question "where does an admitted token sit before the first team takes it?" —
which had no answer while the controller was not a team — answers itself: it
sits with the controller, exactly as work sits with any team.

### 2.1 Its three jobs are the three roles

Master split the controller's work into three jobs. They are not three new
mechanisms; they are the three roles this model already defines, pointed at the
route instead of at one leg.

| Job | Role on the controller team | The same rule as every other team |
| --- | --- | --- |
| take a request, interrogate it, make it a token, queue it | **dispatcher** | the receiving side decides whether to accept |
| unstick what the loop cannot decide (§9's triggers) | **worker** | one worker, one leg, WIP 1 |
| read the finished delivery as a whole | **evaluator** | the gate that can send work back |

An ordinary team's dispatcher admits work to that TEAM; the controller's admits
work to the SYSTEM. An ordinary team's evaluator judges that team's LEG; the
controller's judges the whole ROUTE. Same shape, wider scope. That symmetry is
the strongest evidence available that this is the right model and not a special
case wearing a team's clothes.

### 2.2 What it fixes that nobody planned

The head-of-route intake refusal — the wedge closed on 2026-07-29 by
discriminating on `agent_id` — exists only because the first team on a route has
no sender to return work to. Once every route begins at the controller, every
team has a sender, and that special case stops existing rather than being
handled.

---

## 3. Declaration

```jsonc
{
  "project_id": "…",
  "outer_controller_id": "pm_outer_loop",   // unchanged: names the seat
  "teams": [
    {
      "team_id": "control",
      "name": "Control",
      "dispatcher_id": "pm_intake",         // job 1 — the grill
      "worker_ids": ["pm_outer_loop"],      // job 2 — WIP 1
      "evaluator_id": "pm_audit",           // job 3 — the route-level gate
      "models": { "dispatcher": "…", "worker": "…", "evaluator": "…" }
    }
    // … the delivery teams, unchanged
  ],
  "workflows": [
    { "workflow_id": "default", "route": ["control", "requirement", "prototype", "development", "qa"] },
    { "workflow_id": "hotfix",  "route": ["control", "development", "qa"] }
  ]
}
```

**Every route names the controller at its head, explicitly.** Decided
2026-07-31, against my own recommendation, and the argument that changed it is
worth keeping.

I had argued for leaving it implicit — `["requirement", …]`, with the system
knowing control always comes first — because writing it out "invites one route
to forget it". Master's answer: *"ถ้าแบบ ข ควบคุมได้ว่าต้องผ่าน control เสมอ แล้วทำไมแบบ ก ถึงจะควบคุม
ให้เขียน control ก่อนเสมอไม่ได้"* — if the implicit form can be enforced, so can the
explicit one. That is simply true, and it exposed an inconsistency in my own
proposal: the implicit design ALSO needed a validation rule (routes must NOT
contain the controller). Both forms rest on the validator equally, so the
forgetting argument was never a difference between them.

With that gone, Master's first point decides it: leaving it implicit **moves the
knowledge out of the declaration and into code or prose**. Someone reading
`graph.json` would not see the path a token actually takes; they would have to
know a rule that is not in the file. This project has already made that choice
once, in the opposite direction — §4.6 exists because a `pulled` at the head of
a route would have to omit `from_team` or name a sender that does not exist, and
the fix was to make the FILE say the true thing rather than teach every reader a
special case.

### 3.1 `controller_team` is derived, never declared

An earlier draft of this design added a `controller_team` field. With the
controller written at the head of every route, that field would state a fact the
routes already state — and §3.1 of the contract settled what to do about that
when it ruled on `wip_limit`: *a second number allowed to disagree with the first
is a defect waiting to happen*. So there is no field. The controller team is
`route[0]`, and the graph must contain at least one workflow (§3 bounds
guarantee it), so the derivation always has a source.

Validation rules the graph checker would gain:

- **Every** workflow's `route[0]` names the same team. A graph whose routes
  disagree about where work enters is refused, naming both heads.
- That team appears in no route beyond position 0 — the controller is the head
  of every route, not a stop on any of them (and §1 already forbids revisiting).
- That team's `worker_ids` holds exactly one entry, and it equals
  `outer_controller_id` — the seat that answers §9's questions is the seat the
  contract already names.

`graph.mjs check` prints the full path it derived, so the tool shows what the
file means:

```
[graph] ok (graph.json) — 5 teams, 2 workflows
[graph]   default: control → requirement → prototype → development → qa
[graph]   hotfix: control → development → qa
```

---

## 4. Admission, step by step

```
human ──opened──▶ [control] ──grill──▶ ⟨waiting on the human⟩ ──▶ intake ──pulled──▶ [first team]
```

| # | Event | Actor | Meaning |
| --- | --- | --- | --- |
| 1 | `opened` | `human:<operator>` | a request arrived. `to_team` is the controller team — always, for every token |
| 2 | `assigned` | `agent:pm_intake` | the grill dispatcher was dispatched to interrogate the request |
| 3 | `delivered` | `agent:pm_intake` | it produced either a verdict or a list of questions |
| 4a | `questioned` (NEW) | `agent:pm_intake` | the grill is not satisfied; the token is parked ON A HUMAN |
| 4b | `answered` (NEW) | `human:<operator>` | the human answered; the token is live again and the grill re-runs |
| 5 | `intake` `accept` | `agent:pm_intake` | the request is clear, the workflow is chosen, both are on the record |
| 6 | `pulled` | the receiving team | the first delivery team takes it when it has room (§7, unchanged) |

What step 1 does to §4.6: `opened` keeps its shape but narrows to a single legal
destination. That is checkable, and it turns `opened` from a general-purpose door
into one specific fact.

What step 6 does: **the first delivery leg becomes an ordinary `pulled`** with a
real `from_team`. Nothing about the pull system changes.

### 4.1 The operator's hand-off is `opened`

A human bringing a request is a custody event like any other, and today it has
no line. It does now: `opened` is written by the human, with
`actor: human:<name>`. `ACTOR_RE` already keeps `human:` and `agent:`
distinguishable forever, so "a person put this into the system, and here is
which person" becomes a permanent fact rather than an assumption.

---

## 5. The grill gate

Master's requirement: *"PM ต้องเป็น grill gate ที่แข็งแรง ถามจนชัดเจนทุกอย่าง ไม่ต้องมาเดาอะไรเลย"* —
interrogate until nothing is left to guess.

### 5.1 The two evidences

The danger with a gate like this is that "the model judged the request clear" is
an **attestation**, and §2 accepts attestations from no other role in this
system. So the gate carries two independent pieces of evidence, and Master chose
both rather than either.

**Evidence 1 — every category was faced.** Six categories, below. The `intake`
event records what was addressed, and the token's request file holds the
questions and answers verbatim.

Note the word: **faced**, not *answered*. Master was explicit that completeness
is a judgement, not a count — *"PM ตัดสินใจได้เลยว่าข้อมูลเพียงพอต่อการทำงานโดยไม่เดารึยัง เพราะบางงานก็ไม่ได้
มีข้อมูลครบทั้งหกด้านอยู่แล้ว เนื้องานมันไม่ได้กว้างขนาดนั้น"*. A three-line copy fix has no
Integration story and demanding one would turn the gate into paperwork.

So the controller decides whether it can work without guessing. What it may
NOT do is skip a category silently: each one is either answered, or recorded
not-applicable **with the reason it does not apply**. That is the difference
between a judgement and an omission — a judgement leaves a line someone can
disagree with later, and an omission leaves nothing at all.

**Evidence 2 — a human confirmed.** The last line before `intake` must be an
`answered` event whose actor is `human:<name>`. A model cannot write that line —
the actor vocabulary is closed and the writer stamps it. Same principle as every
other gate here (the outbox file, not the agent's claim), applied to the one gate
whose subject is a person.

Neither alone is enough. The checklist without a human is a model marking its own
homework; the human without the checklist is a rubber stamp with no record of
what was actually asked.

### 5.2 The six categories

Master's taxonomy, recorded verbatim because the wording is the specification.
The rule Master stated first: **คำถามที่ "ถูก" สำคัญกว่าคำถามที่ "เยอะ"** — the right questions
matter more than many questions.

**1 · Business / Functional**
- ลูกค้ากลุ่มเป้าหมายคือใคร?
- เป้าหมายของ Feature นี้คืออะไร?
- Flow การใช้งานครบถ้วนแล้วหรือยัง?
- กรณีใช้งานหลักและกรณีพิเศษมีอะไรบ้าง?
- มี Business Rule หรือเงื่อนไขอะไรที่ต้องปฏิบัติ?
- ค่าที่แสดงผลคำนวณจากอะไร?
- สถานะต่าง ๆ มีอะไรบ้าง?
- ต้องแจ้งเตือนหรือแสดงผลเมื่อไร?

**2 · Validation**
- ข้อมูลที่ต้องกรอกมีอะไรบ้าง?
- ข้อมูลประเภทใดบ้างที่อนุญาตให้กรอก?
- ความยาวขั้นต่ำและสูงสุดเท่าไร?
- รูปแบบข้อมูล (Format) เป็นอย่างไร?
- ข้อมูลใดบ้างที่บังคับกรอก (Mandatory)?
- ข้อความ Error ควรแสดงแบบไหน เมื่อใด?

**3 · Exception**
- ถ้าข้อมูลไม่ถูกต้อง ระบบต้องทำอย่างไร?
- ถ้าเชื่อมต่อระบบอื่นไม่สำเร็จ ต้องทำอย่างไร?
- ถ้า Timeout ควรมีการจัดการอย่างไร?
- สามารถ Retry ได้หรือไม่? เงื่อนไขคืออะไร?
- ถ้าเกิด Error ระบบต้อง Rollback หรือไม่?
- มีกรณีที่ระบบล่ม หรือ Offline ต้องทำอย่างไร?

**4 · Security**
- ใครสามารถใช้งาน Feature นี้ได้บ้าง?
- ต้อง Login หรือยืนยันตัวตนก่อนใช้งานหรือไม่?
- มีการกำหนดสิทธิ์การเข้าถึงข้อมูลอย่างไร?
- ข้อมูลอะไรบ้างที่เป็นความลับ?
- มีการเข้ารหัสข้อมูล (Encryption) หรือไม่?
- มีการ Audit หรือบันทึก Log การใช้งานหรือไม่?

**5 · Performance**
- ระบบต้องรองรับผู้ใช้งานปริมาณเท่าไร?
- ต้องตอบสนองภายในเวลากี่วินาที?
- มี Peak Time หรือช่วงเวลาที่ใช้งานหนาแน่นหรือไม่?
- ต้องรองรับข้อมูลปริมาณเท่าไร?
- มีข้อกำหนดด้าน Performance อื่น ๆ หรือไม่?
- ต้องรองรับการใช้งานผ่าน Mobile / อุปกรณ์ใดบ้าง?

**6 · Integration**
- ต้องเชื่อมต่อกับระบบใดบ้าง?
- ข้อมูลที่ส่งและรับมีอะไรบ้าง?
- รูปแบบข้อมูล (API / File / Message) คืออะไร?
- การเชื่อมต่อเป็นแบบ Real-time หรือ Batch?
- ถ้าเชื่อมต่อไม่สำเร็จ ควรมีการจัดการอย่างไร?
- มีความถี่ในการ Sync / Update อย่างไร?

These are categories, not a script. The controller asks what the request actually
leaves open; the list is what it is not allowed to skip.

### 5.3 The grill objects; it does not veto

The controller may conclude that a request should not be built at all. **That is
a recommendation, not a refusal.** Master: *"งานที่ grill ว่าไม่ควรทำและแจ้งไปแล้ว แต่คนยืนยันให้ทำ
ก็ต้องทำ"* — if the grill says it should not be done, says so, and the person
confirms anyway, it gets done.

Mechanically this needs no new path. The objection is a `questioned` carrying
the concern; the human's `answered` either withdraws the request or confirms it;
`intake` then accepts, recording that it proceeded over a stated objection. The
audit at the end can read both — what the controller warned about at admission,
and who decided to proceed anyway.

The principle underneath, and it is worth stating plainly because it decides
dozens of smaller questions: **the system advises, the person decides, and both
are on the record.** A gate that could refuse a human would be a system that
outranks its owner. A human decision with no record of the warning would be a
system that cannot learn. This is neither.

This also answers a question this design opened earlier: there is no
reject-at-intake path, because the grill has no power to reject. `abandoned`
keeps its single meaning — a token that cannot be finished — and never acquires
a second one about work that should not have started.

### 5.4 Choosing the workflow is part of the grill

The `intake` event records `workflow` and the reason for it. This is the fact
that has no author today. After the grill the controller knows the shape of the
work, which is exactly when the route can be chosen with evidence behind it —
and the choice is then on the record for the audit at the end to read.

---

## 6. Waiting on a human — the one genuinely new state

The grill implies a state this system has never had: **a token blocked on a
person, not on an agent and not on the loop.**

Today the only refusals are `returned` (back to the sending team) and `escalated`
(to the controller). Neither fits: the sender is a human, and the controller is
the one holding it. Without a state of its own, the runner would see a token
sitting at a dispatcher and re-dispatch that dispatcher every tick — paying,
repeatedly, to ask a question of someone who has not answered yet.

So the design adds one event pair and one rule:

```jsonc
// §4 table addition
"questioned": { "required": ["agent_id", "questions", "reason"] }
"answered":   { "required": ["reason"], "actor_kind": "human" }
```

- `questioned` parks the token. **The runner must never dispatch on it.** It is
  the first state in this system whose only legal continuation is a human
  writing a line.
- `answered` releases it. Its actor must be a `human:` — this is Evidence 2 from
  §5.1, and making the writer's KIND part of the event's validity is what stops a
  model from unblocking itself.
- The board must draw a `questioned` token distinctly. "Waiting on a person" and
  "waiting on an agent" look identical on today's page and mean opposite things
  about who has to act next.

### 6.1 A questioned token holds WIP, and silence expires it

**Decided 2026-07-31.** `questioned` consumes the controller's WIP exactly as
`escalated` does. An unanswered request is unfinished work, and the same rule
governs it: *stop starting, start finishing*.

The obvious objection — one unanswered question halts admission until a human
comes back, which may be hours — is answered by a deadline rather than by an
exception. Master: *"ถ้าไม่ตอบภายในเวลาที่กำหนดให้ตัดทิ้งเลย ปล่อยคิวให้ว่าง เมื่อไหร่คนพร้อมค่อยส่งคำขอเข้ามาใหม่"*
— if the answer does not come in time, drop it, free the queue, and let the
person send the request again when they are ready.

This is the first time in this system that a **clock discards work**. Everything
that follows from that has to be deliberate:

**What "discard" means, precisely.** The token stops occupying the queue. It
does not mean the request is destroyed: the ledger is append-only, so the whole
grill — the questions asked, the silence — stays readable forever, and the
request file stays on disk. What ends is the token's claim on a WIP slot.

**Who writes it, and the clause it breaks.** §9 says today that `abandon` is the
controller's verdict and that the controller is *the only mechanised writer of*
`abandoned`. A deadline expiry is written by the RUNNER, on a timer, with no
controller leg — the second mechanised writer that clause forbids. Either §9 is
amended to name this second writer explicitly, or the expiry gets its own event.
**Recommendation: amend §9 and reuse `abandoned`**, with a reason that names the
deadline, because a reader asking "why did this token stop" wants one word to
look for, not two.

**Ten minutes, and it is a config value, not a constant.** Master's value, with
the reason attached: *"ถ้าไม่สามารถตอบได้ภายในเวลา
เท่านั้นแสดงว่าเตรียมตัวมาไม่ดี เขียน requirement มาไม่ละเอียด"* — needing longer than ten minutes
to answer questions about your own request means the request was not thought
through. The deadline is not a scheduling convenience; it is part of the gate.

**No countdown on the board, and the reason matters more than the decision.**
I argued that a person could submit a request, go to lunch, and come back to
find it gone. Master rejected the premise: **a request is not admitted until the
controller confirms it.** Typing an ask and walking away does not put work into
this system — the person is expected to still be there. *"ต้องได้รับการยืนยันจาก PM ว่า
รับงานแล้วคำสั่งถึงจะสมบูรณ์ ไม่ใช่ว่ามาพิมพ์ทิ้งไว้แล้วไปได้ อันนั้นเป็นความผิดคนสั่ง."*

That reframes admission from an asynchronous submission into a **conversation
that has to be completed**, and it removes the whole class of problem the
countdown existed to solve.

**The deadline is stated as a wall-clock time, in the question itself.** Not
"you have ten minutes" and not a widget somewhere else — the controller's
question ends with the actual moment it lapses:

> ต้องตอบกลับมาภายใน 23:30 ไม่งั้นจะยกเลิกคำขอนี้และไม่บันทึกลงคิวงาน

An absolute time needs no page to render it, survives being read late, and
cannot drift the way "ten minutes from when you read this" does.

### 6.2 The deadline is declared, so it can be tested

Murat's objection to a clock-driven rule: `tick` reads the wall clock directly,
so a ten-minute threshold is unreachable by any test that finishes in seconds —
the same reason `ZOMBIE_SEC` (180s), `PM_COOLDOWN_SEC` (900s) and `STALL_SEC`
(1800s) sit in §14.1 today as rules with no test.

Master's answer avoids the whole problem: *"ก็แค่ทำเวลารอเป็นตัวแปรใน config เวลาทดสอบก็เปลี่ยน
เป็นรอ 10 วิแทนก็ได้แล้วนี่"* — do not fake the clock, shrink the threshold. A test sets
the deadline to seconds and lets real time cross it.

That is smaller than injecting a clock and it generalises: **all four time
thresholds become declared config**, and the three that have sat untested since
this contract was written come with it. §14.1 gets shorter by three rows for the
price of one change.

**The limit, stated so nobody mistakes it for more than it is.** A test that
runs with the deadline set to ten seconds proves the RULE fires. It does not
prove the VALUE shipped to production is ten minutes. Those are two different
claims, and the second one is answered by reading the deployed config, not by
any test in this repo.

### 6.3 The controller always says the last word

Mary's objection: a conversation that ends in silence is unreadable. The person
answered two minutes late, and nothing came back — did the request lapse, or is
the controller still thinking? Master: **PM ต้องพูดปิดท้ายเสมอ** — the controller
always closes.

So an expiry is not just a ledger line. The controller writes a closing message
to the person, and Quinn's condition on it holds: **a closing message that is
only spoken is an attestation.** It is evidence the same way every other gate
here is — an outbox file, plus the `abandoned` line that names the deadline. Two
artifacts, neither of which can be produced by claiming.

The message says three things, not one:

1. the request lapsed, and at what time;
2. **which questions went unanswered** — so the person knows what to prepare;
3. that it can be sent again whenever they are ready.

"Timed out" alone would satisfy the rule and teach the person nothing.

**A token is always created, and a dead one is not waste.** The token exists
from `opened`. When the deadline lapses it closes and **never enters the delivery
queue** — no `intake`, no `pulled`, no team ever holds it — but its ledger stays
on disk.

Master's first instinct was not to create it at all, on the grounds that a
request that dies at the door is garbage. The reframe that changed it is worth
keeping as a principle rather than a decision: *"ลองมองอีกมุมมันคือสถิติ เปลี่ยนจากขยะเป็นของ
มีค่าทันที"* — looked at from one side it is litter; from the other it is data,
and the same file becomes valuable without changing at all.

What that data answers, once there is a month of it:

- **Which of the six categories go unanswered most often.** If most requests die
  in Integration, the requesters are not careless — the system is asking at the
  wrong moment, and that answer belongs in front of them before they start.
- **How long people actually take to answer**, against a ten-minute deadline
  chosen by judgement. Either the evidence supports the number or it does not.
- **Who is asked to clarify most**, which is a training signal, not a scolding
  one.

None of that is reachable if the request leaves no trace. A system that throws
away its failures cannot tell you why it fails.

---

## 6.4 The human interface does not exist yet

Raised by Sally (UX) on 2026-07-31, the first time this design was read by
someone asking what the PERSON does rather than what the system knows. Four
rounds of design by four system-side roles had not surfaced any of it.

**1. There is no channel.** The design says the controller "asks questions" and
"writes a closing message". It never says through what. `.mailbox-out/<task>` is
a file the runner reads; no human is watching a directory. Every human-facing
sentence in this document currently ends nowhere.

**2. The strongest gate in the system is gated by a CLI.** `answered` must carry
a `human:` actor, and the only sanctioned writer is
`ledger-writer.mjs --repo … --actor human:x --stdin` fed contract-shaped JSON.
As written, a business stakeholder answers *"who is the target customer?"* by
opening a terminal, composing a §4-valid event, and piping it into a Node script
— inside ten minutes, or the request is discarded. That is not a gate, it is a
moat.

The custody rule is right and is not up for negotiation: the answer must land in
the ledger with a human actor. What is missing is everything between the person
and that line.

**3. A wall-clock deadline with no timezone is a defect.** "ตอบกลับภายใน 23:30"
read by someone in a different zone from the machine is off by hours, and they
find out by losing the request. Whatever channel is chosen, the deadline has to
be stated in the reader's own frame or as a duration from receipt.

None of this changes a decision already made. It says the design is not
buildable until the human half of it is designed too, and that half has not been
started.

---

## 7. Consequences that come with this design, and must be accepted with it

1. **One stuck token stops admission.** Master's choice. It is visible on the
   board (the controller reads WIP 1/1) rather than being a mystery.
2. **The controller costs a dispatch per admitted token.** This was the original
   objection to routing work through it. It falls because the controller does not
   push: it holds admitted work and the receiving team pulls when it has room, so
   admission never blocks a delivery team, and the dispatch is paid once per
   token rather than per tick.
3. **`opened` narrows.** One legal destination, one class of writer. Every reader
   that treats `opened` and `pulled` alike (§5) keeps working, because the first
   delivery leg becomes an ordinary `pulled`.
4. **The audit gains a referent.** The controller's evaluator at the end can read
   the grill's own record from the beginning. "Is this what was asked for?"
   becomes answerable against something written down, by the same team, at
   admission time.

---

## 8. What must be built, and what would prove each piece

Nothing below exists yet.

| Change | Where | What proves it |
| --- | --- | --- |
| every route names the controller at `route[0]`, and it is derived from there | `workflow-graph.mjs` | a graph whose two routes start at different teams is refused, naming both heads; one whose head team has two workers is refused |
| `opened` must target the controller team | `ledger-validate.mjs` | an `opened` at a delivery team is refused |
| `questioned` / `answered` in the §4 table, with the human-actor rule | `ledger-validate.mjs` | an `answered` written by `agent:*` is refused |
| the runner never dispatches on `questioned` | `loop-runner.mjs` | a replay whose token is `questioned` records no new `assigned` for it, and the runner says why |
| the grill brief and its six categories | `role-briefs.mjs` | an `intake` whose categories are incomplete is refused |
| the first delivery leg is a `pulled` from the controller team | `pull-controller.mjs` | a route's first event after `intake` is `pulled` with `from_team` = the controller team |
| the board distinguishes waiting-on-human | `kanban.mjs`, `graph.mjs` | `stateOf` returns a distinct state for `questioned` |
| §4.6, §6, §7, §9 amended | the contract | the amendment lands in the same commit as the behaviour (§15) |

Every one of those is a test that fails today, which is the only kind worth
writing down in advance.

---

## 9. Settled, and still open

**Settled 2026-07-31, after the first draft of this document:**

| Question | Decision |
| --- | --- |
| Does `questioned` hold the controller's WIP? | **Yes**, and unanswered questions expire on a deadline (§6.1) |
| Must all six categories be answered? | **No** — the controller judges sufficiency; every category is faced, none is skipped silently (§5.1) |
| Can a human answer partially? | Yes, by consequence of the above: enough is what the controller can work from without guessing |
| What happens to a request the grill says should not be built? | It is an objection, not a veto. The person may confirm and it proceeds, with both on the record (§5.3) |

**Settled 2026-07-31, second round:**

| Question | Decision |
| --- | --- |
| The deadline | **10 minutes.** Longer means the requirement was not thought through |
| A countdown on the board | **No.** A request is not admitted until the controller confirms; nobody may type and walk away |
| How the deadline is communicated | **An absolute wall-clock time inside the question** — "ตอบกลับภายใน 23:30 ไม่งั้นจะยกเลิก" |
| How a clock-driven rule gets tested | **The threshold is config, not a constant** — tests set it to seconds (§6.2) |
| What happens when it lapses | **The controller always closes the conversation** — outbox message + `abandoned`, naming the unanswered questions (§6.3) |
| Who writes the expiry | **The runner**, using `abandoned`. `actor` already separates it from a controller's verdict, so §9 is amended to name the second writer rather than minting a second word |

**Still open — and all of it is the human half (§6.4):**

1. **The channel.** How a person receives the controller's questions and sends
   answers back. Nothing in this design touches it, and nothing works without
   it.
2. **How a human writes a `human:`-actored line without a terminal.** The
   custody rule stands; the path to it has to be built.
3. **How the deadline is expressed** so a reader in another timezone cannot
   misread it.
4. **What the intake statistics are for.** The data exists the moment tokens are
   always created; who reads it, how often, and what changes as a result is not
   designed.
