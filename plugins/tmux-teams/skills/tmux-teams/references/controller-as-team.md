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
  "controller_team": "control",             // NEW: names the team it belongs to
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
    { "workflow_id": "default", "route": ["requirement", "prototype", "development", "qa"] }
  ]
}
```

Open for decision: whether `route` should be written with `control` at its head,
or whether the controller is implicitly the head of every route. **Implicit is
recommended** — a route describes the delivery path, and repeating `control` in
every workflow invites one route to forget it, which is exactly the class of
defect this design removes.

Validation rules the graph checker would gain:

- `controller_team` must name a declared team.
- That team's `worker_ids` must hold exactly one entry, and it must equal
  `outer_controller_id` — the seat that answers §9's questions is the seat the
  contract already names.
- No workflow's `route` may contain the controller team: it is the head of all
  of them, not a stop on any of them.

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

**Evidence 1 — the checklist was covered.** Six categories, below. The `intake`
event records which categories were addressed, and the token's request file holds
the questions and answers verbatim. A category with no answer is not one the
controller may quietly decide is irrelevant: it is either answered, or marked
not-applicable **with a reason**.

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

### 5.3 Choosing the workflow is part of the grill

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

### 6.1 Does a `questioned` token hold the controller's WIP?

**This is the one question this design does not settle, and it must be settled
before building.**

Master decided that an escalated token DOES consume the controller's WIP — *stop
starting, start finishing*: while something is stuck, the system does not take on
new work. That is a deliberate choice, recorded as one.

`questioned` is a different case. If it also holds WIP, one unanswered question
halts all admission until a human comes back, which may be hours. The argument
for it: an unanswered request IS unfinished work, and the same principle applies.
The argument against: the controller is not blocked on itself, it is blocked on
someone outside the system, and a queue of requests waiting to be interrogated is
not the same as a queue of work in progress.

**Recommendation: `questioned` does NOT hold WIP; `escalated` does.** The
distinction is who has to act — the loop, or a person. This is a recommendation,
not a decision, and the design is not complete until Master picks one.

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
| `controller_team` in the declaration + its three validation rules | `workflow-graph.mjs` | a graph naming a controller team with two workers is refused |
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

## 9. Still open

1. **Does `questioned` hold the controller's WIP?** (§6.1 — recommendation
   recorded, decision not made.)
2. **Is the controller implicit at the head of every route, or written into
   each?** (§3 — implicit recommended.)
3. **Can a human answer partially?** If three of six categories come back and
   three do not, does the grill re-run and ask again, or does the token stay
   `questioned` until all are in? Re-running is cheaper for the human and more
   expensive in dispatches.
4. **What happens to a request the grill decides should never be built?** There
   is no reject-at-intake path today, and `abandoned` is the controller's word
   for a token that cannot be finished, not for one that should not be started.
