# คู่มือ Stage 1 — Export และ Verify หลักฐานที่มีอยู่

> **สถานะ:** คู่มือของ CLI ที่ยังอยู่ใน plugin ปัจจุบัน
>
> **ขอบเขต:** อ่าน observation store ที่มีอยู่แล้ว, replay ตามสัญญา, export
> evidence pack ใหม่, และ verify pack แบบ local integrity เท่านั้น
>
> **ข้อจำกัดสำคัญ:** checkout นี้ไม่มีคำสั่งสร้างหรือ populate observation
> store, freeze pilot, assign slice, capture source หรือ append observation

Stage 1 ในรุ่นนี้เป็น **export-only compatibility path** ไม่ใช่ field-pilot
runner หากไม่มี store ที่สร้างไว้แล้วจากกระบวนการที่เชื่อถือได้ภายนอก toolkit
นี้ จะไม่มี workflow ที่รองรับให้สร้าง store ขึ้นมาใหม่

## 1. สิ่งที่ยัง implement อยู่

เส้นทางที่ผู้ใช้เรียกได้มีเพียง:

- `scripts/delivery-loop-export.mjs` — export pack และ verify pack
- `scripts/pulse.mjs` — อ่าน projection จาก pack เมื่อ caller ระบุ
  `--delivery-loop`

โมดูลที่เหลือเป็น dependency ภายใน ไม่ใช่ CLI:

- `scripts/delivery-loop-store.mjs` อ่าน frozen manifest และ event files
- `scripts/delivery-loop-pilot-core.mjs` validate, replay และ materialize
  dataset
- `scripts/delivery-loop-core.mjs` validate/analyze measurement semantics

สัญญาปิดที่ยังใช้จริงคือ:

- [pilot manifest v1](delivery-loop-pilot-manifest-v1.schema.json)
- [append-only event v1](delivery-loop-event-v1.schema.json)
- [exported evidence pack v1](delivery-loop-evidence-pack-v1.schema.json)
- [Pulse data v4](pulse-v4.schema.json)
- [Pulse data v3 compatibility contract](pulse-v3.schema.json)

## 2. ขอบเขตคำกล่าวอ้าง

Local store และ pack ใช้ principal/OS UID เดียวกับ workers ได้ จึงต้องคงค่า:

```json
{
  "trust_level": "advisory_same_uid",
  "certification_status": "NOT_CERTIFIED",
  "business_decision": "EXTERNAL_REQUIRED",
  "actuation": "NONE"
}
```

ความหมายที่ห้ามรวมกัน:

- receiver acceptance บอกว่า artifact ใช้ต่อได้ใน boundary นั้น
- evidence review ตรวจ provenance, role separation, custody และ digest
- business ratification เป็นการตัดสินใจของผู้มีอำนาจภายนอก toolkit

`READY` หมายถึง measurement completeness ตามสัญญา ไม่ได้หมายถึง delivery
สำเร็จหรือได้รับอนุมัติ `scenario_signal` เป็นผลเชิงพรรณนาของข้อมูลที่ replay
ได้ ไม่ใช่ causal effect, release verdict หรือ realized ROI

## 3. Store ที่ exporter ยอมรับ

`--store` ต้องเป็น absolute path ของ directory จริงและต้องไม่เป็น symlink.
Exporter อ่าน:

```text
<absolute-store>/
├── manifest.json
└── events/
    └── <64-lowercase-hex>.json
```

`manifest.json` และ event ทุกไฟล์ต้องเป็น regular non-symlink file ขนาดไม่เกิน
4 MiB. ชื่อ event file ที่ไม่ตรงรูปจะไม่ถูกอ่าน. Frozen manifest, event
schema, digest, aggregate sequence, `previous_event_id`, actor/source fields,
supersession และ replay state ต้อง validate ทั้งหมด

ข้อกำหนดก่อน export:

1. `--out` เป็น absolute path, ยังไม่มีอยู่, อยู่นอก store และ parent มีอยู่แล้ว
2. `--source-revision` เป็น lowercase Git SHA 40 ตัว
3. `--as-of` เป็น RFC3339 และครอบคลุม observation ที่ต้องการวิเคราะห์
4. ทุก assigned slice ยังอยู่ใน intention-to-treat dataset
5. attempt ต้อง replay ถึง terminal state ที่อนุญาต
6. cost, outcome, guardrail และ contamination ต้องมี observation coverage

Observation ที่บันทึกค่าต้นทุนเป็น `null` ยังนับว่า observed แต่ unknown;
ห้ามแปลงเป็นศูนย์. ค่า unknown ทำให้ผลเปรียบเทียบที่เกี่ยวข้องเป็น
`INCONCLUSIVE` โดยไม่ตัด slice ออกจาก ITT. หาก observation ทั้งช่องหายไป
materialization จะ fail แทนการเดา

## 4. Export pack

รันจาก repository root:

```bash
node plugins/tmux-teams/skills/tmux-teams/scripts/delivery-loop-export.mjs export \
  --store <absolute-store> \
  --out <new-absolute-pack-directory> \
  --as-of <RFC3339> \
  --source-revision <40-hex-git-sha>
```

คำสั่งนี้อ่าน store, replay events, materialize dataset, วิเคราะห์ผล และเขียน
pack ใหม่แบบ exclusive. คำสั่งไม่แก้ store และไม่อ่าน source ที่ไม่ได้อยู่ใน
store

Pack ที่สำเร็จมีไฟล์:

```text
pack-index.json
manifest.json
assignments.json
events.jsonl
dataset.json
replay.json
analysis.json
trace-index.json
external-review.md
pulse-projection.json
```

`pack-index.json` bind path, media type, byte count และ SHA-256 ของทุกไฟล์
รวมทั้ง manifest/event/dataset digests, source revision และ pack digest.
Output ยังคง `observed_unverified`, `NOT_CERTIFIED`, `EXTERNAL_REQUIRED` และ
`NONE` เสมอ

## 5. Verify pack

```bash
node plugins/tmux-teams/skills/tmux-teams/scripts/delivery-loop-export.mjs verify-pack \
  <absolute-pack-directory>
```

`verify-pack` ตรวจ:

- pack digest และ trust constants
- ไม่มี extra file และไม่มี named file หาย
- ทุก entry เป็น regular non-symlink file ใน pack root
- byte count และ file digest ตรง index
- manifest, event log และ dataset digests ตรง
- replay จาก manifest + events ให้ผลเดิม

ผล `{"valid":true,"verified":true,"errors":[]}` หมายถึง local integrity และ
replay ผ่านเท่านั้น คำว่า `verified` ใน JSON นี้ไม่ authenticate identity,
external custody, role separation จริง หรือ business authority

## 6. ส่ง projection เข้า Pulse

Pulse v4 เป็น persisted default ที่ `<repo>/.tmux-teams/pulse.json`.
Definitions ของ run, verdict, `phase` และ `phase_source` ยังคงอ้าง Pulse v3;
attribution ที่ไม่มีหลักฐานหรือไม่น่าเชื่อถือต้องเป็น unassigned ห้าม infer
จากชื่อ task, worker, provider หรือ timestamp

ใช้ projection ที่ exporter เขียนเมื่อ caller ต้องการ:

```bash
node plugins/tmux-teams/skills/tmux-teams/scripts/pulse.mjs json \
  <repo> --delivery-loop <absolute-pack-directory>/pulse-projection.json
node plugins/tmux-teams/skills/tmux-teams/scripts/pulse.mjs compat-v1 <repo>
```

`compat-v1` พิมพ์ down-projection ไป stdout เท่านั้น ไม่สร้าง persisted v1
snapshot. Pulse อ่าน projection แบบ advisory; มันไม่ route, dispatch, retry,
stop หรือ apply recommendation

## 7. Measurement semantics ที่ยังผูก exporter

ข้อมูลเปรียบเทียบใช้สอง arm คือ `pm_routed` และ `receiver_owned`, โดย
per-slice mean เป็น estimand หลัก ส่วน totals เป็น descriptive เท่านั้น

Cost categories ต้องมีครบ 12 ช่อง:

```text
pm_routing_minutes              pm_exception_minutes
pm_evidence_minutes             receiver_review_minutes
governance_minutes              instrumentation_minutes
queue_wait_minutes              rework_minutes
rejected_work_minutes           abandoned_work_minutes
cancelled_work_minutes          sender_coordination_minutes
```

Guardrails ปิด vocabulary เป็น `PASS`, `BREACH`, `UNKNOWN` สำหรับ security,
performance, integration, UAT และ escaped defects. `UNKNOWN` ทำให้ readiness
ไม่สรุป; `BREACH` ยังคงมองเห็นและอาจตั้ง
`safety_hold_recommended:true`, แต่ toolkit ไม่มีสิทธิ์หยุดระบบเอง

Measurement topology ที่ core รู้จักยังมี Requirement → Prototype →
Development → QA และ boundary สุดท้าย `QA -> ProjectDelivery`.
ProjectDelivery เป็น receiver ปลายทาง ไม่ใช่ Phase 5. หนึ่ง structural
scenario ของ measurement core อาจให้ `scenario_signal` ได้ แต่ไม่มี production
baseline หรือ counterfactual จึงต้องตีความ ROI เป็น `ROI_NOT_ESTABLISHED`.
ไม่ว่าค่า metric จะ favorable เพียงใด business decision ยังคง
`EXTERNAL_REQUIRED`

Operational Phase Gate เป็น namespace แยก โดย
`scripts/phase-gate-controller.mjs` และ supporting modules เป็น executable
surface ปัจจุบัน ส่วน Phase Gate Runtime v1 design note เก่าใต้ `references/`
มีข้อความ POC และ `scenario_signal` ที่บันทึก generation ก่อนหน้า ไม่ใช่
command หรือ field ที่ Phase Gate modules ปัจจุบันสร้าง จึงไม่ใช่ operational
guide สำหรับ checkout นี้ เมื่อ
`<repo>/.tmux-teams/phase-gate.json` มีอยู่ `acp-companion.mjs` จะบังคับ
reservation ของ controller; อย่านำ vocabulary ของ runtime นี้ไปรวมกับ Team /
Workflow / work-item ของ custody loop

## 8. External review และ business ratification

หลัง local verify:

1. ส่ง pack digest และเวลาไป custody principal ที่ workers เขียนไม่ได้
2. ให้ external reviewer authenticate role holders และ custody จากระบบภายนอก
3. ให้ reviewer คำนวณ file, pack, manifest, event และ dataset digests ใหม่
4. ตรวจ ITT retention, maturity, missing data, contamination, costs,
   guardrails และ source trace
5. บันทึก signed review/finding ใน governance system ภายนอก
6. ให้ business owner อ่าน pack และ review แล้วตัดสินใจนอก toolkit

คำตัดสิน `GO`, `ITERATE`, `NO_GO`, release หรือ UAT approval ห้ามถูกเขียนกลับ
มาเป็นคำสั่ง route/dispatch/stop อัตโนมัติของ exporter หรือ Pulse

## 9. Failure handling

| อาการ | ผลที่ถูกต้อง |
|---|---|
| Store path ไม่ absolute, เป็น symlink หรืออ่านไม่ได้ | fail; ไม่สร้าง pack |
| Manifest/event/schema/digest/sequence invalid | fail พร้อม diagnostic |
| Observation coverage หรือ terminal attempt ไม่ครบ | fail materialization; ไม่เดา |
| Output มีอยู่แล้ว, อยู่ใน store หรือ parent ไม่มี | fail; ไม่ overwrite |
| Source revision ไม่ใช่ lowercase SHA 40 ตัว | fail |
| Pack มี extra/missing/unsafe file หรือ digest ไม่ตรง | `verify-pack` คืน invalid และ exit nonzero |
| External custody หรือ identity ตรวจไม่ได้ | pack คง `NOT_CERTIFIED` |
| Cost observed แต่ unknown | เก็บ `null`; ผลที่เกี่ยวข้อง `INCONCLUSIVE` |

## 10. Exit gate

งานของ CLI จบเมื่อ:

- export เขียน pack ใหม่สำเร็จโดยไม่แก้ store
- `verify-pack` replay และตรวจ byte/digest ทุกไฟล์ผ่าน
- pack ยังคง `advisory_same_uid`, `NOT_CERTIFIED`, `EXTERNAL_REQUIRED`, `NONE`
- projection ถูกใช้แบบ read-only เฉพาะเมื่อ caller ระบุ
- pack ถูกส่งออกไปยัง independent custody/review ตามกระบวนการภายนอก

Toolkit นี้ไม่สามารถประกาศว่า external review เสร็จ, business decision ผ่าน,
delivery สำเร็จ หรือ ROI เกิดจริง
