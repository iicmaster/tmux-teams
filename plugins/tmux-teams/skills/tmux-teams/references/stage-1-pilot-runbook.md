# คู่มือเดิน Pilot Stage 1 — Two-Level Delivery Loop

> **สถานะ:** สัญญาการปฏิบัติงานที่ implement แล้วสำหรับ Stage 1 field pilot
> **ขอบเขต:** append-only, event-sourced **observational sidecar** เท่านั้น
> **สำคัญ:** คำสั่งในเอกสารนี้คือ CLI contract ของ Stage 1 scripts ที่อยู่ใน
> plugin นี้ ผลจากเครื่องมือเป็นหลักฐานสำหรับ external review ไม่ใช่ผล pilot
> จริงจนกว่าจะเดินงานกับ field slices ตาม protocol ที่ freeze ไว้

## 1. ขอบเขตคำกล่าวอ้าง

Stage 1 มีหน้าที่เก็บข้อสังเกตของ pilot แบบ prospective, ทำ assignment ตาม
แผนที่ freeze ไว้, replay เหตุการณ์อย่างกำหนดได้ซ้ำ, และ export หลักฐานให้
ผู้ตรวจอิสระเท่านั้น เครื่องมือภายใน repo **ไม่มีอำนาจ**:

- เลือก worker, route งาน, dispatch งาน, prompt agent, หรือสั่ง tmux/ACP
- เขียนหรือแก้ mailbox, outbox, KMS, Pulse หรือสถานะ delivery ของระบบต้นทาง
- แปล `TEAM_DONE`, worker terminal, หรือ PM verdict เป็นการรับมอบงาน
- ยืนยันตัวบุคคลที่อ้างในไฟล์ซึ่งเขียนได้ด้วย OS UID เดียวกัน
- certify หลักฐาน, approve release, คำนวณ realized ROI เป็นข้อยุติ หรือออก
  `GO`, `ITERATE`, `NO_GO`
- นำผลวิเคราะห์ไป actuation อัตโนมัติ

ทุก manifest ต้องมี `automatic_routing: false` และทุก evidence pack ต้องคงค่า:

```json
{
  "trust_level": "advisory_same_uid",
  "certification_status": "NOT_CERTIFIED",
  "business_decision": "EXTERNAL_REQUIRED",
  "actuation": "NONE"
}
```

`READY` หมายถึงข้อมูลพร้อมวิเคราะห์ตามสัญญา ไม่ได้หมายถึง delivery สำเร็จ,
หลักฐาน certified, หรือได้รับอนุมัติทางธุรกิจ

## 2. สัญญาและหน่วยข้อมูล

ใช้ schema สามไฟล์นี้เป็น normative contract:

- `delivery-loop-pilot-manifest-v1.schema.json` — แผน pilot ที่ freeze แล้ว
- `delivery-loop-event-v1.schema.json` — เหตุการณ์ observational แบบ append-only
- `delivery-loop-evidence-pack-v1.schema.json` — packet สำหรับส่งออกไปตรวจภายนอก

หน่วย intention-to-treat คือ `DeliverySlice` ตั้งแต่วินาทีที่ assign แล้ว
slice ทุกตัวต้องอยู่ใน arm เดิมตลอด แม้ไม่ mature, ยกเลิก, abandon, ข้อมูลขาด,
หรือพบ contamination ห้ามคัดออกหลังเห็น outcome

pilot หนึ่ง manifest เลือก boundary เดียวจากรายการต่อไปนี้:

| Sender | Receiver | Exit artifact |
|---|---|---|
| `Requirement` | `Prototype` | `requirements_baseline` |
| `Prototype` | `Development` | `prototype_evaluation` |
| `Development` | `QA` | `development_delivery` |
| `QA` | `ProjectDelivery` | `qa_release_evidence` |

accept/reject ของ artifact เป็นอำนาจของ receiver ที่ประกาศไว้ การ review
evidence เป็นอำนาจอีกชุดหนึ่ง และ business ratification เป็นอำนาจอีกชุดหนึ่ง
ห้ามรวมสามความหมายนี้เป็น success flag เดียว

## 3. การแยกบทบาทขั้นต่ำ

ก่อน freeze ให้ business owner และผู้ตรวจภายนอกยืนยัน roster ที่อยู่นอก
worker-writable repository แล้วตรวจว่า:

| บทบาท | หน้าที่ | ต้องไม่ทับซ้อนกับ |
|---|---|---|
| Business owner | ตั้งโจทย์, ยอมรับ guardrails, ratify ภายนอก | metric producer |
| PM | ประสาน outer loop และ exception | routine receiver |
| Sender | สร้าง exit artifact | external reviewer |
| Receiver phase lead | รับ/reject routine handoff | PM, external reviewer |
| Experiment owner | ดูแล protocol | external reviewer |
| Assignment custodian | เก็บ seed และทำ assignment | metric producer |
| Metric producer | วัด cost/outcome ตามวิธีที่ freeze | assignment custodian, business owner, external reviewer |
| Guardrail producer | วัด guardrail ตามวิธีที่ freeze | external reviewer |
| External reviewer | ตรวจ custody, identity, digest, protocol | ทุก operational role และ OS UID เดียวกัน |

JSON Schema บังคับให้ manifest ระบุ role arrays และ assertion การแยกบทบาทได้
แต่พิสูจน์ตัวตนหรือความไม่ทับซ้อนจริงไม่ได้ validator ต้องตรวจค่าระหว่าง
arrays และ external reviewer ต้อง authenticate คน/บัญชีอีกครั้งจากระบบ
ภายนอก

frozen manifest ต้องมี `actors` registry ที่ compatible กับ Stage 0 ด้วย:
`senders`, `pms`, `phase_leads` สำหรับ `Requirement`, `Prototype`,
`Development`, `QA`, `ProjectDelivery`, และ `certifiers`,
`experiment_owners`, `metric_producers`, `business_owners` ทุก object ปิดและ
ทุก array ต้องไม่ว่าง ค่าใน `actors` ต้องสอดคล้องกับ governance `roles`;
runtime เป็นผู้ตรวจ cross-field equality/separation เพราะ JSON Schema เทียบ
สมาชิกข้าม arrays โดยตรงไม่ได้

## 4. Gate ก่อนเปิด pilot

ห้าม freeze จนกว่าจะผ่านทุกข้อ:

1. Stage 0 fixtures และ validation ผ่าน และไม่มีการอ้างว่า synthetic result
   เป็น causal evidence
2. เลือก boundary เดียวที่มี exit artifact ตรวจได้ซ้ำ และมี future slices
   เพียงพอสำหรับทั้งสอง arm
3. eligibility, exclusion, stable slice ID, strata, assignment window,
   sample plan, maturity, thresholds และ stopping rule เขียนก่อนเห็น outcome
4. มีวิธีวัดและ owner สำหรับ cost ทั้ง 12 หมวด:

   ```text
   pm_routing_minutes              pm_exception_minutes
   pm_evidence_minutes             receiver_review_minutes
   governance_minutes              instrumentation_minutes
   queue_wait_minutes              rework_minutes
   rejected_work_minutes           abandoned_work_minutes
   cancelled_work_minutes          sender_coordination_minutes
   ```

5. มีวิธีวัดและ owner สำหรับ time-to-usable, value, maturity และ guardrails
   ทั้ง `security`, `performance`, `integration`, `uat`, `escaped_defects`
6. กติกา missing data ระบุว่า `null` คือ unknown ไม่ใช่ศูนย์ และเก็บ ITT
   ทุก slice
7. กติกา contamination ระบุวิธีตรวจ, owner, tolerance และคง assigned arm
8. assignment seed อยู่ในการดูแลของ assignment custodian นอก repo; manifest
   มีเพียง `sha256:<64-lowercase-hex>` seed commitment
9. digest ของ frozen manifest ถูก anchor โดย principal ภายนอก worker-writable
   repository พร้อมเวลาและ custody reference
10. `automatic_routing` และ automatic safety actuation เป็น `false`

หากข้อใดไม่ผ่าน ให้ instrument หรือ narrow boundary ก่อน อย่าใช้ field pilot
เพื่อซ่อม measurability พื้นฐาน

## 5. พื้นที่เก็บข้อมูลและ trust boundary

กำหนด `--store` เป็น absolute path ของ observation store แยกจาก repo ที่
workers แก้ไขได้ ควรให้สิทธิ์เขียนเฉพาะ experiment operator และเก็บ snapshot
ตามนโยบายองค์กร โครงสร้างภายใน store เป็น append-only; correction ต้องเขียน
`observation_superseded` เพิ่ม ห้ามแก้หรือลบบรรทัดเก่า

การย้าย store ออกนอก repo ลดการแก้โดยไม่ตั้งใจ แต่ถ้ายังเป็น principal/OS UID
เดียวกัน หลักฐานยังเป็น `advisory_same_uid` เสมอ สิ่งที่ยกระดับ custody ได้คือ
external timestamp, detached signature หรือ separate-principal custody ที่
ผู้ตรวจอิสระตรวจเอง ไม่ใช่ permission claim จาก local process

กติกา digest:

- ใช้ SHA-256 lowercase และรูป `sha256:<64-hex>`
- canonical JSON เรียง key ตาม Unicode code-point order
- `manifest_digest` hash manifest โดยตัด `manifest_digest` ออก
- `event_id` hash event โดยตัด `event_id` ออก
- `pack_digest` hash pack index โดยตัด `pack_digest` ออก
- event ทุก aggregate มี sequence ต่อเนื่องและ
  `previous_event_id`; sequence 1 ต้องมีค่า `null`
- raw seed, secret, token, worker pane text และ message body ที่ไม่จำเป็น
  ห้ามเข้า event log หรือ evidence pack

## 6. CLI contract ที่ implement แล้ว

รันจาก repository root ทุกครั้ง Placeholder ในวงเล็บแหลมต้องแทนด้วยค่าจริง
และ `--store`, `--seed-file`, `--out` ต้อง resolve เป็น absolute path ตาม
นโยบายของ command นั้น

### 6.1 Freeze preregistration

```bash
node plugins/tmux-teams/skills/tmux-teams/scripts/delivery-loop-pilot.mjs freeze \
  <pilot-manifest-draft.json> \
  --store <absolute-observation-store> \
  --seed-file <absolute-seed-file-outside-repo> \
  --frozen-at <RFC3339>
```

`freeze` ต้อง validate manifest, คำนวณและเทียบ manifest digest, ตรวจ
`automatic_routing:false`, ตรวจ role separation, เทียบ anchor digest/ref และ
append `preregistration_frozen` เพียงครั้งเดียว ถ้า manifest เดิมถูก freeze
แล้วให้ idempotent เฉพาะเมื่อ bytes/digest ตรงกัน ถ้าต่างกันให้ fail closed
โดยไม่แก้ store

ไฟล์ draft ส่วนตัวที่ส่งเข้า `freeze` อาจมี `assignment_seed` เพื่อให้
freezer คำนวณ `assignment.seed_commitment` แต่ field ลับนี้เป็น
freeze-input-only: schema นี้ validate เฉพาะ frozen output, freezer ต้องลบ
`assignment_seed` ก่อนคำนวณ `manifest_digest`, ก่อนเขียน store และก่อนพิมพ์
stdout/stderr ห้ามเก็บ draft นี้ใน repo หรือ evidence pack

หลัง freeze ห้ามแก้ hypothesis, eligibility, strata, window, seed commitment,
sample/maturity/stopping, thresholds, instrumentation, missing-data policy,
contamination policy, roles หรือ external anchor การเปลี่ยนต้องใช้
`experiment_id`/`manifest_id` ใหม่

### 6.2 Assign eligible slices

```bash
node plugins/tmux-teams/skills/tmux-teams/scripts/delivery-loop-pilot.mjs assign \
  <eligible-slice.json> \
  --store <absolute-observation-store> \
  --seed-file <absolute-seed-file-outside-repo> \
  --assigned-at <RFC3339> \
  --actor <assignment-custodian-id>
```

`assign` ต้อง:

- ตรวจ seed ว่าตรง commitment แต่ไม่ copy seed เข้า store หรือ stdout/stderr
- ตรวจ eligibility, boundary, strata และ half-open assignment window
- สร้าง stable slice ID ก่อนคำนวณ arm
- ใช้ `hmac_sha256_stratified_v1` เท่านั้น แล้ว append `slice_eligible` และ
  `slice_assigned`
- บันทึก assignment score/digest และ `arm_override:false`
- rerun ข้อมูลเดิมต้องได้ผลเดิม; conflict ต้อง fail โดยไม่ overwrite
- ไม่ส่งข้อความ, ไม่เรียก mailbox/KMS/tmux/ACP และไม่เปลี่ยนวิธีทำงานของ arm

คำแนะนำของแต่ละ arm ต้องแจกโดยเจ้าของ protocol ผ่านกระบวนการคนที่กำหนดไว้
และใช้เอกสารซึ่ง digest ถูก bind ใน manifest ตัว assigner ไม่มีสิทธิ์ route
งานตาม arm

### 6.3 Replay store

```bash
node plugins/tmux-teams/skills/tmux-teams/scripts/delivery-loop-pilot.mjs replay \
  --store <absolute-observation-store> \
  --as-of <RFC3339>
```

`replay` อ่าน event log ถึง `--as-of`, ตรวจ schema/digest/sequence/chain,
ใช้ supersession แบบ append-only, รักษา ITT และสร้าง state/report แบบ
deterministic เท่านั้น ห้ามเติม attempt ที่ไม่มี observation จริงหรืออนุมาน
accept จาก worker/PM terminal หากพบ gap, conflict หรือ source digest mismatch
ต้อง fail closed พร้อม diagnostic; stdout เป็น replay JSON และคำสั่งนี้ไม่เขียน
report file หรือ source ใด

### 6.4 Rehearse ก่อน live

```bash
node plugins/tmux-teams/skills/tmux-teams/scripts/delivery-loop-pilot.mjs rehearse \
  --store <absolute-throwaway-store> \
  --as-of <RFC3339> \
  --runs 3
```

ใช้ throwaway store ที่มี observation ครบเท่านั้น คำสั่งนี้ rebuild evidence
bundle จาก store เดิมอย่างน้อยสามรอบและต้องได้ digest เดิม พร้อมรายงานว่ามี
assignment ครบสอง arm หรือไม่ ส่วน scenario matrix ได้แก่
correction/supersession, unknown cost, non-mature outcome, guardrail breach,
contamination, sequence gap และ digest mismatch ต้องผ่าน automated test suite
ก่อนเปิด pilot จากนั้นลบ throwaway store ตามนโยบายองค์กรโดยคน ไม่ใช่คำสั่ง
pilot อัตโนมัติ

### 6.5 Capture named sources

capture adapter อ่านเฉพาะไฟล์ source ที่ระบุแบบ positional และ append observation
เข้า sidecar มันไม่มีสิทธิ์เขียนกลับ source

```bash
node plugins/tmux-teams/skills/tmux-teams/scripts/delivery-loop-capture.mjs capture \
  <mailbox-dispatch|mailbox-outbox|kms-event> <named-source-file> \
  --store <absolute-observation-store> \
  --slice <slice-id> \
  --actor <actor-id> \
  --at <RFC3339> \
  [--role pm|metric_producer] \
  [--correlation <dispatch-id>]
```

ความหมายของ source แต่ละชนิด:

| Source | เก็บได้ | ห้ามสรุป |
|---|---|---|
| `mailbox-dispatch` | metadata ของ dispatch ที่เกิดในระบบต้นทางและ digest ของ named record | worker ทำงานจริง, artifact ถูกต้อง, receiver accept |
| `mailbox-outbox` | allowlisted worker terminal signal และ digest ของ named record | `TEAM_DONE` คือ delivery acceptance หรือ evidence certification |
| `kms-event` | event code/ref/digest ที่เกิดใน KMS | KMS เป็น authority, gate, หรือหลักฐาน authenticated |

named-source adapter เขียนได้เฉพาะ `source_observed` ที่มี `slice_id`,
`correlation_id` และ signal ใน allowlist:
`DISPATCH_RECORDED`, `WORKER_TERMINAL_DONE`, `WORKER_TERMINAL_BLOCKED`,
`WORKER_TERMINAL_FAILED`, `PM_VERDICT_PASS`, `PM_VERDICT_REJECT`,
`PM_VERDICT_UNRESOLVED` เท่านั้น event นี้เป็น source signal ไม่ใช่
`attempt_transition_observed` และห้าม materialize receiver acceptance,
outcome, guardrail, certification หรือ business decision

`TEAM_DONE` แปลว่า turn จบและ worker อ้างว่าวาง evidence แล้วเท่านั้น PM verdict
ก็เป็น repo-local observation ไม่ใช่ routine receiver acceptance Routine
`accept`/`reject` ต้องมาจาก actor และ transition ที่สัญญาระบุอย่างชัดเจน

### 6.6 Capture explicit observations

ข้อมูลที่ไม่มี named source adapter ต้องสร้าง event JSON ที่ validate ตาม
event schema แล้ว capture ด้วยคำสั่งนี้:

```bash
node plugins/tmux-teams/skills/tmux-teams/scripts/delivery-loop-capture.mjs observation \
  <delivery-loop-event.json> \
  --store <absolute-observation-store>
```

ใช้สำหรับ artifact, authorized attempt transition, cost, outcome, guardrail,
contamination หรือ correction ที่มี method/owner/source ชัดเจน ไม่อนุญาต event
ประเภท business decision, approval, certification, route หรือ dispatch
ถ้า source แก้ข้อมูล ให้ append observation ใหม่และ
`observation_superseded`; ห้ามแก้ event เดิม Correction นี้ใช้ได้กับ
measurement/source observations ที่ schema อนุญาตเท่านั้น ไม่ใช้ย้อนแก้
assignment, artifact หรือ handoff transition Payload ต้องใช้
`target_event_id`, `replacement_event_id`, `reason_code`, `superseded_at`
ตรงตาม schema โดย replacement ต้องเป็น observation ชนิดเดียวกัน ของ slice
และ measurement dimension เดียวกัน เกิดหลัง target อย่างเคร่งครัด และมีอยู่ใน
ledger ก่อน correction Replay ยังคง target ใน ledger/trace แต่ตัดออกจาก
materialized dataset

### 6.7 Export evidence pack

หลัง assignment window ปิดและถึง `analysis_as_of` ให้ replay ก่อน แล้ว export:

```bash
node plugins/tmux-teams/skills/tmux-teams/scripts/delivery-loop-export.mjs export \
  --store <absolute-observation-store> \
  --as-of <RFC3339> \
  --out <absolute-evidence-pack-directory> \
  --source-revision <40-hex-git-sha>
```

export ต้อง pin manifest/event-log/dataset digests, เขียน named files,
trace index, replay report, descriptive analysis และ review instructions
แบบ deterministic ห้ามอ่าน unnamed source ห้ามแนบ secrets และห้ามเขียน
certification หรือ business verdict แม้ scenario signal เป็น favorable
Cost ที่สังเกตแล้วแต่ยังไม่ทราบต้อง export เป็น `null`; pack คำนวณ
`unknown_cost_fraction` และ `missing_mature_outcome_fraction` จาก dataset จริง
และ analyzer ต้องคง `INCONCLUSIVE` แทนการแปลง missingness เป็นศูนย์หรือปฏิเสธ
การสร้าง evidence pack

ผลจาก pure core ที่ materialize manifest/ledger/dataset/analysis/replay เป็น
**internal bundle** สำหรับให้ exporter ประกอบไฟล์ ไม่ใช่ serialized
evidence-pack contract และห้ามส่งให้ reviewer โดยอ้างว่าเป็น pack สำเร็จ
contract ภายนอกคือ `<absolute-evidence-pack-directory>/pack-index.json` ที่
validate ตาม `delivery-loop-evidence-pack-v1.schema.json` เท่านั้น
`contents` ใน index ต้อง digest-bind named files ครบ: manifest,
`assignments.json`, event log, dataset, replay report, analysis report,
trace index, external-review instructions และ `pulse_projection` ซึ่งเป็น
operator projection แบบ bounded ที่ส่งเข้า Pulse v4 เมื่อ caller ระบุ
`--delivery-loop`; projection นี้เป็น optional advisory input และไม่ทำให้
Pulse หรือ UI เป็น authority ส่วน
`.tmux-teams/pulse.json` ยังคงเป็น Pulse snapshot SSOT เพียงไฟล์เดียว ห้ามสร้าง
versioned Pulse snapshot หรือ persisted compat-v1 snapshot เพิ่ม

Pulse v4 คง field ของ Pulse v3 สำหรับ run, verdict, `phase` และ
`phase_source` โดยอ้าง definition จาก `pulse-v3.schema.json` และเพิ่ม
`delivery_runtime` แบบ optional/closed เท่านั้น เอกสาร v3 เดิมยังตรวจตาม
schema v3 ได้ แต่ snapshot ที่ publisher เขียนเป็นค่าเริ่มต้นคือ v4

### 6.8 Governed Phase Gate runtime และ POC

runtime นี้เป็น operational namespace แบบ opt-in แยกจาก pilot sidecar
observe-only ข้างต้น ผู้เขียน ledger ที่รองรับคือ
`phase-gate-controller.mjs` เท่านั้น คำสั่ง `init` จะ freeze manifest/store
และสร้าง marker `.tmux-teams/phase-gate.json` แบบ strict/non-symlink
เมื่อมี marker แล้ว ห้ามเรียก `acp-companion.mjs` ตรง ๆ: หาก env reservation
ไม่ตรง store/head/dispatch UUID/task/agent/brief digest/timeout/phase จะต้อง
fail ก่อนอ่าน brief หรือสร้าง directory, footprint, ACP session, outbox และ KMS

ลำดับมี Phase Team เพียง 4 ทีม: Requirement → Prototype → Development → QA
การจบเฟสปกติต้องมี receiver acceptance และ dispatch แรกของเฟสผู้รับ consume
artifact digest เดียวกัน exactly once ส่วน `QA -> ProjectDelivery` จบด้วย
ProjectDelivery receiver acceptance โดยไม่มี ACP dispatch เฟสที่ 5
ProjectDelivery เป็น terminal receiver ไม่ใช่ Phase 5 และ acceptance นี้ไม่ใช่
release/UAT/business approval

controller ต้อง reserve ก่อน spawn; companion บันทึก child registration เป็น
mutation แรก แล้วจึง consumption (ยกเว้น bootstrap), footprint, prompt และ
terminal observation หากหลัง spawn พิสูจน์ผลไม่ได้ ให้บันทึก
`indeterminate` และห้าม auto-retry จน PM ทำ manual reconciliation/resolution
แบบ append-only ทุก claim ยังคงเป็น `advisory_same_uid`

รัน POC เดิมซ้ำได้ด้วย mock ACP ที่ bundle ไว้ โดยใช้ output directory ใหม่หรือ
ว่าง:

```bash
POC_OUT="$(mktemp -d)/run"
POC_MOCK="$(realpath tests/fixtures/mock-acp-agent.mjs)"
node plugins/tmux-teams/skills/tmux-teams/scripts/phase-gate-poc.mjs \
  --out "$POC_OUT" \
  --acp-cmd "node $POC_MOCK" \
  --time-zone Asia/Bangkok --timeout 15
```

ต้องรันจาก checkout root; `mktemp` ทำให้ output ใหม่ทุกครั้ง และ `realpath`
ทำให้ mock fixture ยังหาเจอหลัง companion เปลี่ยน cwd เข้า repo ที่ POC สร้าง

ผล `measurement.status: scenario_signal` แปลว่า scenario เดียวเดินตาม
governed path และมีหลักฐานครบสำหรับการวัด ไม่ใช่ causal signal หรือ business
verdict ส่วน `roi.status: ROI_NOT_ESTABLISHED` เป็นผลที่ถูกต้อง เพราะ POC
หนึ่งรอบไม่มี production baseline/counterfactual การประเมิน ROI ต้องใช้
matched production slices และต้นทุน PM routing, queue wait, rework และ escaped
defects ที่วัดจริง Delivery runtime ที่ส่งให้ Pulse v4 เป็น observe-only;
D3 operational graph และ Pulse ไม่มีสิทธิ์สั่ง controller

POC จะบันทึก inner-loop worker verdict 4 รายการ (หนึ่งรายการต่อ Phase Team)
เพื่อให้ Pulse graph ออกจากสถานะรอตรวจ `ต้องตรวจ` โดยทุกรายการระบุ
`verifier_role: phase_team` แม้ KMS ยังใช้ชื่อ field เดิมว่า `pm_verdict`
เพื่อ compatibility กับ reader เก่า ชื่อ field นี้ไม่ได้แปลว่า PM เข้าตรวจ
มีส่วนร่วม อนุมัติ หรือให้ business verdict

ตรวจ pack ที่ export แล้วแบบ read-only:

```bash
node plugins/tmux-teams/skills/tmux-teams/scripts/delivery-loop-export.mjs verify-pack \
  <absolute-evidence-pack-directory>
```

`verify-pack` ตรวจ relative paths, file digests, pack digest และ internal
cross-references เท่านั้น ผลผ่านหมายถึง local integrity check ผ่าน ไม่ได้
authenticate identity/custody และต้องไม่เปลี่ยน
`certification_status:NOT_CERTIFIED`

## 7. ลำดับการปฏิบัติงาน pilot

### ระยะ A — เตรียมและ freeze

1. Experiment owner ร่าง manifest พร้อมวิธีและ owner ครบทุก metric
2. Business owner ยืนยัน hypothesis/guardrails/thresholds โดยยังไม่เห็น outcome
3. Assignment custodian สร้าง seed นอก repo และส่งเฉพาะ commitment
4. External custody principal anchor manifest digest และเวลา
5. Operator รัน `freeze` แล้วส่ง freeze receipt digest กลับไปยัง custodian
6. External reviewer เทียบ receipt กับ anchor จากช่องทางแยก

หาก digest ไม่ตรง, anchor ขาด, role ทับซ้อน หรือ freeze หลังเห็น outcome ให้
ยกเลิก experiment ID นั้นและเริ่ม manifest ใหม่ ห้ามแก้ย้อนหลัง

### ระยะ B — Assignment และ arm instructions

1. Eligibility owner สร้าง named eligibility snapshot ตามเวลา cut-off
2. Operator รัน `assign` โดยมี assignment custodian ควบคุม seed
3. ตรวจว่าทุก eligible slice ได้ arm เดียว, stable ID เดียว และ event chain
4. Protocol owner แจก frozen arm instruction ให้คนที่เกี่ยวข้อง
5. เก็บ contamination observation ทุกครั้งที่การทำงานข้าม arm

PM ยังทำหน้าที่ outer coordination และ exception ตาม protocol แต่ pilot
sidecar ไม่สั่ง PM/receiver และไม่แก้ operational workflow

### ระยะ C — Capture ระหว่าง pilot

1. Capture named mailbox/KMS records ที่ protocol ระบุเท่านั้น
2. Metric/guardrail producer บันทึก explicit observation ตาม method ของตน
3. ค่าไม่ทราบต้องเป็น `null` พร้อม `measurement_status:"unknown"` ไม่เดาเป็น 0
4. บันทึก slice ที่ pending/censored/cancelled/abandoned ต่อไปใน ITT
5. Replay ตาม cadence ที่ preregister เพื่อจับ gap/conflict แต่ห้ามเปลี่ยน arm
6. Guardrail breach ทำได้เพียงแสดง
   `safety_hold_recommended:true`; คนที่มีอำนาจภายนอกตัดสินใจหยุด

### ระยะ D — Close, export และ local verify

1. เมื่อถึง stopping rule ให้ operator หยุดรับ assignment ใหม่ตามคำสั่งของ
   manual stop owner; toolkit ไม่หยุดระบบงานเอง
2. Append `analysis_window_closed` พร้อม event-log/dataset digest
3. รัน `replay`, `export`, และ `verify`
4. หาก replay invalid หรือ digest mismatch ให้ส่ง pack พร้อม diagnostic
   หรือแก้ด้วย append-only correction ตาม protocol; ห้าม rewrite history
5. บันทึก hash ของ pack กับ external custody principal ก่อนส่ง review

## 8. External custody และ independent review — อยู่นอก toolkit

ขั้นตอนต่อไปนี้ต้องทำในระบบ/บัญชี/ช่องทางที่ workers และ local toolkit เขียน
ไม่ได้:

1. Custody principal รับ pack และบันทึกเวลา/digest ภายนอก
2. External reviewer authenticate ตัวตนของ role holders และตรวจว่าไม่มี
   operational overlap
3. Reviewer คำนวณ manifest, event log, dataset, file และ pack digests ใหม่
4. หลัง assignment window ปิด Assignment custodian ส่ง seed ให้ reviewer ผ่าน
  ช่องทางแยก Reviewer ตรวจ commitment และ recompute assignment โดยไม่เก็บ raw
   seed กลับใน repo/pack
5. Reviewer ตรวจ eligibility chronology, ITT retention, sample/maturity/
   stopping rules, missing data, contamination, cost ทั้ง 12 หมวด, outcome,
   guardrails และ source trace
6. Reviewer ออก signed review report หรือ finding ใน external governance
   system การมี detached signature ในระบบนั้นไม่ได้เปลี่ยน local pack เป็น
   certified โดยอัตโนมัติ

ไม่มีคำสั่ง `certify`, `approve`, `sign-as-reviewer` หรือ `import-decision`
ใน Stage 1 toolkit ถ้าต้องเก็บ reference ของ review ให้ custody system ภายนอก
เป็น source of record

## 9. Business-owner ratification — อยู่นอก toolkit

Business owner อ่าน evidence pack, external review, guardrail findings และ
บริบทธุรกิจ แล้วบันทึก decision ใน governance system ภายนอก การตัดสินใจอาจใช้
คำว่า `GO`, `ITERATE`, `NO_GO` ตามกระบวนการองค์กร แต่คำเหล่านั้น:

- ห้ามอยู่ใน event schema หรือ evidence-pack decision field
- ห้ามถูก local analyzer สร้างหรืออนุมาน
- ห้ามถูก import เพื่อ route/dispatch/stop/release อัตโนมัติ
- ต้องมีผู้มีอำนาจดำเนินการผ่าน operational control ปกติภายนอก toolkit

ดังนั้นจุดสิ้นสุดของ Stage 1 CLI คือ pack ที่
`EXTERNAL_REQUIRED`/`NOT_CERTIFIED`/`NONE`; จุดเริ่มของ business action อยู่
หลัง external review และ human ratification เท่านั้น

## 10. Failure handling และ exit gate

| อาการ | การตอบสนอง |
|---|---|
| Manifest/anchor/seed commitment mismatch | fail closed; ไม่ append assignment |
| Event schema/digest invalid | quarantine named input; ไม่แก้ source |
| Sequence gap หรือ chain conflict | replay `DEGRADED`/`INVALID`; ห้ามสร้าง event ชดเชยเอง |
| Duplicate idempotent event | ยอมรับเฉพาะ bytes/digest เดิม |
| Duplicate ID แต่ข้อมูลต่าง | conflict; ห้าม overwrite |
| Missing cost/outcome | เก็บ `null`/non-mature และคง ITT |
| Contamination | บันทึกเหตุผล คง assigned arm และรายงาน |
| Guardrail breach | แนะนำ safety hold เท่านั้น; external authority ตัดสิน |
| External custody/identity ตรวจไม่ได้ | pack ยังคง `NOT_CERTIFIED` |
| Tool crash ระหว่าง append | ตรวจ atomic record boundary และ replay ก่อน retry |

pilot จบด้านเครื่องมือเมื่อ:

- event log replay ได้ตามรายงานและ diagnostic ถูกเปิดเผย
- assigned slices ทุกตัวอยู่ใน ITT dataset
- cost categories และ guardrails แสดงครบ แม้ค่าบางช่องเป็น unknown
- manifest/event/dataset/pack digests ตรวจซ้ำได้
- pack ถูก anchor ภายนอกและส่งให้ reviewer
- local output ยังคง `advisory_same_uid`, `NOT_CERTIFIED`,
  `EXTERNAL_REQUIRED`, `NONE`

การ review เสร็จหรือ business decision เสร็จไม่ใช่ exit condition ที่ toolkit
สามารถประกาศเองได้
