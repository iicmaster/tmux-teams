# HANDOFF — tmux-teams · v0.14.6 ออกแล้ว, main เดินหน้าเป็น v0.15.0 (2026-08-05)

> เขียนให้ **agent** อ่านแล้วลงมือต่อได้ทันที ไม่ใช่ให้คนอ่านเอาเรื่อง
> อ่านสามหัวข้อแรกแล้วรู้ว่าต้องทำอะไรต่อ — เชื่อคำสั่งในไฟล์นี้เท่ากับคำสั่งที่ตรวจแล้ว

## อ่านก่อนอื่น

- **branch `main` = `origin/main` = `068b149`** — push ครบ ต้นไม้สะอาด
- **v0.14.6 ออกครบทุกช่องทาง** (tag, GitHub release, marketplace, plugin cache
  0.14.6 ติดตั้งบนเครื่องนี้แล้ว) · การ bump submodule pin ใน `~/agent-skills`
  **ยังไม่ได้ทำและห้ามทำเอง** — คนละโปรเจกต์ ต้องขอ Master ก่อน
- **`main` เดินหน้าเกิน v0.14.6 แล้ว** — ยังไม่ bump เลขสี่ที่ ยังไม่ tag
  ยังไม่ release · **นี่คือ v0.15.0 ที่กำลังทำ**
- **suite ที่วัดจริงล่าสุดที่ `068b149`+: 745 tests, fail 0** ·
  `git diff --check` สะอาด · `claude plugin validate --strict .` ผ่าน
- **ทุกอิชชูปิดหมด · 0 PR เปิด** — #39 #40 #42 #43 #44 #45 #46 #47 ·
  **โค้ดของ v0.15.0 เสร็จแล้ว เหลือแค่ gate กับการ bump**
- **#47 ลงครบสามส่วน**: เฟส 1 `6301f4d` (รูปทรงประกาศ) → แก้ `afc1f89` ·
  เฟส 2 `a822de7` (dispatch อ่านจริง) · เฟส 2b `85232d6` (`assigned` พกโมเดล)
- **release gate จบครบห้ารอบแล้ว** — r1–r4 บน diff ถึง `85232d6` และ r5 บน
  ส่วนที่ landed หลังจากนั้น · เจอ defect จริงรวม **13 ข้อ แก้หมดแล้ว** ·
  ดูหัวข้อ "รีวิวรอบปล่อย" ข้างล่าง
- **ยิ่งแก้ตามรีวิว ยิ่งมี bytes ใหม่ที่ยังไม่ถูกรีวิว** — นั่นคือรูปร่างของ
  กระบวนการ ไม่ใช่ข้อบกพร่อง · หยุดเมื่อ Master บอกหยุด ไม่ใช่เมื่อคิวว่าง

### คำตัดสินของ Master ที่บังคับอยู่ ห้ามรื้อ

- **ขอบเขต v0.15.0: จบ #47 ทั้งสองเฟสก่อนปล่อย** — ทำครบแล้ว
- **จังหวะรีวิว: ตรวจทีเดียวตอนจบ** ไม่ส่งทีละโมดูล
- **รูปแบบรีวิว (ตัดสิน 2026-08-05): 4 รอบแยกตามเรื่อง · reviewer เดียวคือ
  `claude-zai` · ใช้กรอบ bmad-party-mode `anti-consensus-club`**
  ไม่ใช่ panel สามโมเดล — และนั่น**ตรงกับกฎ release ที่เขียนไว้จริง**:
  CLAUDE.md §Release flow ข้อ 2 ระบุ reviewer เดียว (`codex-advisor`)
  ส่วน panel สามโมเดลคือกฎของ **worker dispatch** คนละเรื่องกัน
  อย่าสับสนสองกฎนี้เข้าด้วยกันเหมือนที่ HANDOFF ฉบับก่อนทำ

## วิธีตรวจสอบ

```bash
node scripts/run-fast.mjs fast     # ~2s · ใช้ระหว่างทำงาน
node --test                        # ~120s · กิน 8 คอร์ · ครั้งเดียวก่อน commit
git diff --check                   # whitespace gate
claude plugin validate --strict .  # manifest validation
```

`grep` เหนือผลเทสต์ **ไม่ใช่ gate** — คืน 0 ตอน*เจอ* `✖` ไม่ใช่ตอนไม่เจอ ·
gate ที่ถูกต้อง:

```bash
node --test > /tmp/suite.log 2>&1
grep -q '^ℹ fail 0$' /tmp/suite.log || { grep '^✖' /tmp/suite.log | head; false; }
```

**ตัวเลขที่วัดได้ล่าสุด (จาก log การปิด #43, commit `42dfe7a`, 2026-08-05
11:37 +07): suite 676, fail 0.** HEAD ปัจจุบัน (`f75597f`) มี commit
`774e179` เพิ่มมาทีหลัง ซึ่งเติม `tests/loop-runner-decisions.test.mjs`
(AC90–AC92) — **ตัวเลขนี้ยังไม่รวมไฟล์นั้น และ session นี้ไม่ได้รัน
`node --test` เปล่าเพื่อวัดใหม่** (กฎประจำ repo: subagent ห้ามรัน suite
เปล่า) ต้องรันเองก่อนเชื่อว่า suite ยังเขียวที่ HEAD

**ห้าม fan out subagent ที่รัน `node --test` พร้อมกัน** — 2026-08-03 เคยทำให้
load แตะ 28 บน 8 คอร์ 42 นาทีไม่มีใครเสร็จ · แตกงาน*อ่าน*ได้ แต่การ*วัด*ต้อง
ผ่านคนเดียว

## STATE — สิ่งที่ v0.15.0 (bytes เหนือ v0.14.6) เปลี่ยนไปแล้ว

อ่าน `git log --oneline v0.14.6..HEAD` เพื่อดู commit ทั้งหมด ตารางนี้เป็น
ดัชนีเข้า source ไม่ใช่ตัว source เอง

| เรื่อง | อยู่ที่ | อิชชู | อ่านเพิ่มที่ |
|---|---|---|---|
| leg ที่ไม่เคยได้เทิร์นไม่หักงบ worker attempt | `loop-runner.mjs:944,953` (`legNeverStarted`), `acp-companion.mjs:2251` (`work_observed`) | #45 ส่วนที่ 2, `0a0200a` | contract §4.10, `delivered` แถวใน §4 (`loop-system-contract.md:509`) — `MAX_LEGS` **ไม่ครอบคลุม**, §4.10 บอกตรงๆ |
| planner ข้าม route hop ที่ token ถืออยู่แล้ว | `ledger-validate.mjs:236,467,481,566,573` (`heldTeams`), `pull-controller.mjs:142,146,153,177` | #42, #44, `f7b3903` | contract §7; ปิด tick loop ค้างถาวร; นิยาม "held" อยู่ที่เดียวคือ `ledger-validate.mjs` §1 |
| runner บันทึกเหตุผลที่ข้าม token ในรอบนั้น | `.tmux-teams/decisions/latest.json`, เขียนใน `loop-runner.mjs` | — | contract §11.3 (`loop-system-contract.md:1480`); overwrite ทั้งไฟล์ทุก tick — ตอบ "ทำไมตอนนี้" ไม่ตอบ "นานแค่ไหน" |
| panel diversity จาก 9 ฟังก์ชันเหลือค่าเดียว | `laneIdentity()` — `review-profiles.mjs:345`, ใช้ที่ `review-gate.mjs:322` | #43, `42dfe7a` | คืนสามสถานะ: `{signature,family,routing}` (identified), `{undeclared:true}`, `{unreadable:true,reason}` — `provenFamilyKey` (`review-profiles.mjs:298`) เหลือไว้แค่ทำ report export ของไฟล์ลด 17→15 |
| MCP seam ถูกปิดโดยเจตนา ไม่ใช่อุบัติเหตุ | contract §13 (`loop-system-contract.md:1702-1709`) + ADR 0003 | — | `plugins/tmux-teams/docs/adr/0003-mcp-server-containment-seam.md` — เอกสารล้วน **ไม่มีไฟล์ `.mjs` เปลี่ยน**; `mcpServers: []` เป็น literal เดิม; เปิดได้เฉพาะ human maintainer แก้ §13 เท่านั้น |
| ratchet กันคนอ่าน ledger เพิ่มโดยไม่รีวิว | `scripts/ledger-reader-ratchet.mjs`, baseline `scripts/ledger-readers.baseline.json` | — | `b1e9932`+`b62c317` — **9 ไฟล์อ่าน ledger วันนี้** (ตัวเลขที่ถูก แก้จาก 11 ที่มาจาก `grep -l` ซึ่งนับ "พูดถึง" เป็น "อ่าน" — ดู DO NOT); ไฟล์ที่ 10 ทำให้ ratchet fail |
| seat ประกาศ `display_model` ได้ | `workflow-graph.mjs:350,351,378-379,422-424`, `graph.mjs:367,683` | PR #41 (2/3 commit) | board โชว์ชื่อโมเดลจริง ขณะที่ dispatch ยังส่ง alias ที่ adapter รับได้ (`opus`/`sonnet`/`haiku`) — optional field, ไม่ใส่ก็ fallback เป็น `model` เดิม |
| run ที่ตายจะ "age out" จาก `dead` เป็น `other` | `graph.mjs:323,331` (`deadIsStale`) | PR #41 (2/3 commit) | เกิน 3× stall budget ของตัวเอง (อย่างน้อย 900s) → `other` (มีหลักฐานบันทึกไว้) แทนที่จะค้างแดงตลอดไป |
| `/handoff` มีไฟล์ command แล้ว | `plugins/tmux-teams/commands/handoff.md` | — | `fa950fd` — ก่อนหน้านี้ skill พูดถึง `/handoff` แต่ไม่มี command ให้ resolve เลย |

**ไม่มี breaking change ที่ยืนยันได้จากการตรวจ** — ทุก field ใหม่เป็น
optional/additive (`heldTeams`, `work_observed`, `display_model`),
`decisions/latest.json` เป็นไฟล์ใหม่ที่ไม่มีใครอ่านมาก่อน, และ export ที่
หายไปจาก `review-profiles.mjs` (`routingDeclaration`,
`launchDeclaredButUnreadable`, `provenFamilyKeysCollide`) ไม่มีตัวเรียกนอก
`review-profiles.mjs`/`review-gate.mjs` เอง (`grep -rn` ยืนยันแล้ว) — แต่
**ถ้าเจออะไรที่ break จริง นั่นคือบรรทัดที่สำคัญที่สุดที่ต้องเขียนกลับมาที่นี่**

### หกอิชชูที่ปิดวันนี้ — สรุปสั้น

- **#39** — แก้แล้วจริงตั้งแต่ v0.14.6 (ก่อน tag) issue เพิ่งถูกปิดวันนี้
  (administrative close หลัง release ยืนยันแล้ว) ไม่ใช่งานของ v0.15.0
- **#42 / #44** — `heldTeams`, ดูตาราง
- **#43** — `laneIdentity()`, ดูตาราง
- **#45** — สองส่วน: **ส่วน 1 ถูกปฏิเสธ** (ให้ `graph.mjs check` warn เรื่อง
  ชื่อโมเดลนอก whitelist — contract §3.2 ห้ามเทียบชื่อโมเดลกับ list ใดๆ
  โดยเด็ดขาด, AC42 pin ไว้, `workflow-graph.mjs:24-27,44-49` พูดซ้ำสามที่ —
  ไม่ใช่บั๊ก เป็นการตัดสินใจอ่านโค้ดแล้วปฏิเสธ) · **ส่วน 2 ชิปแล้ว** =
  `work_observed`/§4.10 ในตาราง
- **#46** — **ปิดแบบ "หักล้าง" ไม่ใช่ "แก้"**: อ่าน `tick()`/`planPulls()` ทั้งฟังก์ชันแล้วพบว่ากลไก restart-desync ที่อิชชูอ้างไม่มีอยู่จริง —
  `planPulls` เป็น pure function ไม่มี state ข้าม tick, ทุก phase อ่านสดจาก
  disk ก่อนใช้เสมอ อาการที่รายงานคือ #42/#44 ซึ่งแก้แล้วใน `f7b3903`

### PR #41 — ปิดโดยเอาแค่ 2 ใน 3 commit

`display_model` + died-run aging cherry-pick ไปขึ้น `main` แล้ว (`f106677`,
`333b814`) หลังตรวจว่า `loop-runner.mjs` ไม่ถูกแตะ · commit ที่สาม
(`04abaf3`, auto-admit rework token ตอน audit concern) **ไม่ถูกเอา** — ดู
เหตุผลใน DECIDED

## สิ่งที่ Wave D เพิ่ม — facade มีตัวตนแล้ว

| โมดูล | ให้อะไร | หมายเหตุ |
|---|---|---|
| `scripts/agent-seat-reads.mjs` | `listDeliveries` · `fetchDelivery` · `legOutcomes` | สาม read tool ที่ agent seat ต้องการจริง · **ไม่มี write tool และห้ามเพิ่ม** — mutation ต้องรอ serialization authority ข้าม process (§14.2 ข้อ 5) · contract §16 |
| `scripts/token-projection.mjs` | `projectToken` | projection เดียวที่คนอ่านควรใช้ · ย้าย `kanban.mjs` มาใช้แล้วหนึ่งราย เทสเดิมของมันผ่าน**โดยไม่ถูกแก้** · contract §6.1 |

**ไม่ใช่ MCP server และไม่ได้ลงทะเบียนเป็น MCP** — `mcpServers: []` ยังเป็น
literal และ §13 ห้ามส่งค่าอื่น · นี่คือของที่ MCP adapter จะห่อทีหลัง

### เรื่อง ratchet ที่ต้องรู้ ไม่งั้นจะงงกับเลข

`agent-seat-reads.mjs` เข้าถึง ledger ผ่าน alias
`export const loadWorkItemLedgers = readWorkItems` ที่ถูกเพิ่มใน
`dispatch-facts.mjs` **โดยเจตนาเพื่อให้ ratchet มองไม่เห็นตัวมัน** — ซึ่งเป็น
ช่องที่หัวไฟล์ ratchet เขียนเตือนไว้เองตั้งแต่เช้าวันเดียวกัน

ตอนนี้ ratchet **ตามหา alias เอง** (`export const X = <signal>` กลายเป็น
signal ต่อ) จึงเห็น **10 ไฟล์** ไม่ใช่ 9 · `agent-seat-reads.mjs` อยู่ใน
baseline แล้วพร้อมเหตุผล · การใช้ reader ที่รับรองแล้วคือรูปทรงที่ ratchet
**ต้องการ** — สิ่งที่ผิดคือการมองไม่เห็นมัน ไม่ใช่การที่มันมีอยู่

## OPEN TENSIONS — ห้องเถียงค้างไว้ ไม่ได้สรุป

- **จังหวะรีวิว** — ฝ่ายหนึ่ง: ส่งโมดูลใหม่ทีละชิ้น ประตูควรเป็นที่*ยืนยัน*
  ไม่ใช่ที่*ค้นพบ* ถ้ามันเจอของทุกครั้งแปลว่าเราส่งของยังไม่พร้อมเข้าไปเจ็ดครั้ง ·
  อีกฝ่าย: รูที่แพงที่สุดของรอบ 6–7 คือ**ปฏิสัมพันธ์ระหว่างไฟล์** ซึ่งเห็นได้
  เมื่ออ่านทั้งก้อนเท่านั้น · **Master ตัดสินว่ารอตรวจทีเดียว**
- **"ปิดทุก issue" หมายถึงอะไร** — ห้าในเจ็ดปิดโดยหักล้างหรือปฏิเสธ ไม่ใช่แก้ ·
  ฝ่ายหนึ่งว่าการปฏิเสธที่มีหลักฐานคือผลงาน อีกฝ่ายว่ามันไม่ใช่สิ่งที่ผู้ขอคาดหวัง

## DO NOT — ทำไปแล้วผิด อย่าทำซ้ำ

### 1. อย่าเชื่อ `grep -l` ว่า "อ่าน" = "พูดถึง"

ตอนทำ ratchet ของคนอ่าน ledger (`b1e9932`) ตัวเลขแรกที่รายงานคือ **11** จาก
`grep -l` ซึ่งนับไฟล์ที่*พูดถึง*คำว่า ledger เป็นไฟล์ที่*อ่าน*มันจริง ตัวเลข
ที่ถูกคือ **9** (`dispatch-facts`, `graph`, `admit`, `intake-stats`,
`kanban`, `pull-controller`, `loop-runner`, บวกสองตัวที่ได้รับอนุญาต —
`ledger-writer.mjs`, `ledger-validate.mjs`) — แก้บน issue #43 comment
สุดท้าย ตรวจนับใหม่จริงก่อนเชื่อ อย่า grep ผิวๆ

### 2. เทสที่เขียวเพราะไม่เคยไปถึงโค้ดที่มันอ้างว่าเทส

`tests/ledger-reader-ratchet.test.mjs` รุ่นแรก (7 เทส) เขียวทั้งหมดแม้ปิด
branch `if (!result.ok)` ในตัว CLI ทิ้ง — เพราะทุกเทสยิงเข้าฟังก์ชัน
วิเคราะห์โดยตรง ไม่มีเทสไหนสปอน CLI จริงเลย แก้ด้วย `b62c317`: เพิ่มเทสที่
spawn CLI จริงและเช็ค exit code (0 บนต้นไม้สะอาด, non-zero เมื่อมีคนอ่าน
ledger คนใหม่, ชื่อไฟล์ต้องโผล่ในข้อความ) — **ยืนยันด้วย mutation: ปิด
branch แล้วแดง, คืนด้วยการก็อปปี้ไฟล์เทียบ checksum ไม่ใช่ str.replace ย้อน
ทาง**

### 3. subagent ที่เขียนต้องมี worktree ของตัวเองเสมอ (บทเรียนของ wave นี้)

ห้า agent เคยแชร์ checkout เดียวกัน (2026-08-05) แข่งกันเอง — agent หนึ่ง
cherry-pick ลงบน branch ที่อีก agent เพิ่งสร้าง, อีกตัวแก้ contract อยู่
ขณะที่ HEAD ขยับใต้มัน, ตัวที่เห็นปัญหา force-reset branch ที่เปื้อนแล้ว
แต่ **reset นั้นไม่ยึด** เพราะ directory กำลังถูก checkout โดยอีก process
พร้อมกัน — รายละเอียดเต็มอยู่ใน `CLAUDE.md` (repo นี้) ส่วน "Every subagent
that WRITES gets its own git worktree" **กฎที่ตามมา: การเขียน git ใน
directory ที่แชร์กันถือว่า "ยังไม่ยืนยัน" จนกว่าจะอ่านกลับมาเช็ค** —
force-reset/branch delete/checkout ถูก process อื่นย้อนได้เงียบๆ กลาง
คำสั่งสองคำสั่ง โดย exit code เป็น 0 เหมือนสำเร็จ

### 4. เปลี่ยนกฎความปลอดภัยต้องเทียบกับพฤติกรรมจริงของเครื่องมือ ไม่ใช่สัญชาตญาณ

(สืบทอดจากรอบก่อน `v0.14.6`, ยังจริงอยู่) `assertAdapterPackageBoundToCommand`
เคยเปลี่ยนจาก `.includes()` เป็น `.at(-1)` เพราะดูเข้มกว่า แต่ `npx` รัน
positional ตัว**แรก** ไม่ใช่ตัวสุดท้าย — เทสยืนยันผิดตรงกับ gate แต่ทั้งคู่ไม่
ตรงกับพฤติกรรมจริงของ `npx`

## DECIDED — ห้ามรื้อ

- **PR #41 commit ที่สาม (`04abaf3`) ไม่ถูกเอา และเหตุผลปิดถาวร ไม่ใช่รอแก้
  เล็กน้อย** — `AUTO_REWORK_ACTOR = 'human:operator'` เขียน `opened` โดยปลอม
  actor เป็นมนุษย์ ขณะที่ contract §4.6 (`loop-system-contract.md:609,
  641-642`) พูดเรื่อง "reopen mechanism" ไว้ตรงๆ ว่าต้องมี actor word ของ
  ตัวเอง **"not this one forged into looking human"** — คำในโค้ด comment
  เองก็ยอมรับว่า "this impersonates" ทางแก้ที่ถูกคือ event word ใหม่
  (`reopened`) พร้อม amendment §4/§5 ของมันเอง ไม่ใช่ patch commit เดิม ·
  bug ที่สองในคอมมิทเดียวกัน (ไม่ใช่เหตุผลหลักแต่ยืนยันการปฏิเสธ): เขียน
  request `.md` **ก่อน** ledger append ขณะที่ idempotency guard คีย์กับไฟล์
  นั้น — append ถูกปฏิเสธ (เช่น `locked`) ไฟล์ยังอยู่แต่ ledger line ไม่มี
  ทุก tick ถัดไปคืน `null` เงียบๆ ตลอดไป · branch `split-41-graph-display-
  model-and-aging` ยังอยู่ ถ้าจะทำ `reopened` ใหม่เอาจากตรงนั้นเป็นจุดเริ่มได้
- **`review-profiles.mjs` เป็น immutable โดยเจตนา** — comment เปิดไฟล์เขียนว่า
  "Immutable ACP reviewer definitions" ทุก profile ที่ shipped ผ่าน
  `assertPermittedModel`/`assertAdapterPackageBoundToCommand` และหก endpoint
  pin ที่ shipped ทุกตัวมี human attestation ผ่านรีวิว codex-advisor +
  3-model panel มาก่อน — การเปลี่ยนให้ mutable ไม่ใช่ one-liner (ดู #40)
- **`mcpServers: []` ปิดโดยเจตนา** — ADR 0003 (`plugins/tmux-teams/docs/adr/
  0003-mcp-server-containment-seam.md`): เปิด seam นี้คือการ**ลด**
  containment ไม่ใช่เพิ่ม feature เปิดได้เฉพาะ human maintainer แก้ §13
  ตรงๆ เท่านั้น ห้าม `graph.json` field หรือ env var มาเปิดแทน

## #40 — ปิดแล้ว (wontfix) โดยคำตัดสินของ Master · ห้ามรื้อ

`REVIEW_PROFILES` **คงเป็นตารางที่ freeze ใน source** · operator ประกาศ review
seat เองไม่ได้ และ seat ที่ประกาศเองเข้าคณะสามโต๊ะไม่ได้

เหตุผลที่บันทึกไว้ (ข้อสองสำคัญกว่าข้อแรก):

1. ข้อโต้แย้งด้านความปลอดภัยทุกข้อใน `review-profiles.mjs` ตั้งอยู่บนการที่ไม่มี
   อะไรเข้าถึงได้นอกจาก literal ที่ freeze — loader ของ operator ไม่ได้เพิ่ม
   ฟีเจอร์ มันถอนสมมติฐานที่ดีไซน์ทั้งอันยืนอยู่
2. profile ทุกใบที่ ship ผ่าน**สองอย่าง**: การตรวจเชิงกลไก **และคำยืนยันของ
   มนุษย์**ที่ผ่านรีวิวสามโมเดลก่อน merge · seat ที่ประกาศในเครื่องได้แค่อย่างแรก
   และเจ็ดรอบรีวิว (r2–r7) มีอยู่เพราะ "ต่างกันเชิงกลไก" กลายเป็นไม่พอซ้ำๆ

ทางออกสำหรับคนที่เจอ backend ติดลิมิต: **ส่ง PR เพิ่ม seat** ช้ากว่า config ไฟล์
และนั่นคือสิ่งที่แลกมาโดยตั้งใจ

**#47 ไม่ใช่บรรทัดฐานของเรื่องนี้** — คนละ bounded context คนละ trust model

## #47 — อิชชูเดียวที่เหลือ · แบ่งสองเฟสเพราะไฟล์ชนกัน

**เฟส 1 (กำลังวิ่งตอนเขียน handoff นี้)** — worktree `wf_815da76e-24e-1`
แตกจาก `12f5c54` · ทำเฉพาะ**รูปทรงการประกาศ**: role ประกาศ palette ที่เป็น
array ของ seat spec ทั้งดุ้น (ไม่ใช่ชื่อโมเดล) + `bucket` ที่แยกจาก `lane` ·
แตะ `workflow-graph.mjs` + contract §3 + เทสใหม่เท่านั้น · graph ที่ประกาศ
palette ต้องโหลดผ่าน แต่**ยังไม่มีใครใช้มัน** — นั่นคือขอบเขต ไม่ใช่งานค้าง

**เฟส 2 (ยังไม่เริ่ม)** — dispatch เลือกจาก palette และ `assigned` **ต้องพก
โมเดลที่เลือกจริง** · แตะ `loop-runner.mjs` + `ledger-validate.mjs` + contract §4
· แยกเฟสเพราะทั้งสองเขียน `loop-runner.mjs` และ contract ทับกัน

### สามข้อที่เฟสไหนก็ห้ามลืม

1. **โมเดลไม่ใช่ค่าเดียว** — `(executable, alias) → ชื่อจริง` · `opus` บน
   `claude-qwen` = qwen3.8-max · `opus` บน `claude-kimi` = k3 · `sonnet` บน
   `claude-qwen` = **DeepSeek** คนละเจ้าเลย · array ของ alias ไร้ความหมาย
2. **`assigned` ต้องบันทึกโมเดล** — วันนี้สมุดตอบได้ว่าขาไหนรันอะไรเพราะ
   หนึ่งที่นั่ง = หนึ่งโมเดล · palette ทำให้ตอบไม่ได้ ถ้าไม่บันทึก
3. **`bucket` ไม่ใช่ `lane`** — lane เป็นเซตปิดสามค่าเพราะ `acp-companion.mjs`
   ออกเมื่อเจอค่าที่สี่ · bucket เป็นชื่ออิสระ ตรวจแค่รูปทรงตาม §3.2 ระบบไม่
   ต้องรู้ความหมาย รู้แค่ว่าสองอันเท่ากันไหม · **สองสมาชิกติดกันใน bucket
   เดียวกันไม่ใช่ fallback** — ถังเดียวกัน เผา leg ไปเรียนรู้ศูนย์

### ที่ #45 ส่วนสองแก้ให้แล้ว และที่ยังไม่แก้

transport ที่ตายไม่กิน **worker attempt** แล้ว (`work_observed`) · แต่
`legCeiling`/`MAX_LEGS` (§10) ยังนับทุก `assigned` ไม่มีเงื่อนไข — **palette ที่
ไล่ที่นั่งตายยังเผา leg ceiling เท่าเดิม** · §4.10 เขียนไว้ตรงๆ อย่าคิดว่าครอบแล้ว

## รีวิวรอบปล่อย — กำลังวิ่ง ตอนเขียนนี้

diff ที่ต้องตรวจคือ **312 KB** (33 ไฟล์ +4785/-310 เหนือ v0.14.6, ไม่นับ
`HANDOFF.md` ซึ่งไม่ใช่ของที่ปล่อย) · **ลงซองเดียวไม่ได้**: `review-gate.mjs`
มี `packetBytes: 128 * 1024` เป็นค่าคงที่ เปลี่ยนด้วย env ไม่ได้ (ต่างจาก
lane timeout) จึงแบ่งเป็นสี่รอบตามเรื่อง **ครบ 312/312 KB ไม่มีไบต์ไหนหลุด**

| รอบ | task id | เรื่อง | ขนาด |
|---|---|---|---|
| r1 | `v015-contract` | contract amendment ล้วน — AC ล้มได้จริงไหม | 85 KB |
| r2 | `v015-palette` | #47 ทั้งสามเฟส + เทส | 80 KB |
| r3 | `v015-custody` | facade, projection, ratchet, pull-route | 102 KB |
| r4 | `v015-gate` | #43 laneIdentity, graph, เอกสาร | 68 KB |

รันที่ `<scratch>/reviews/<rN>/` · outbox = `.mailbox-out/<task-id>`

**กลไกที่ต้องรู้ ไม่งั้นเสียรอบฟรี**

- **ไฟล์ outbox ต้องชื่อเดียวกับ task id เป๊ะๆ** ไม่ใช่ชื่ออิสระ · probe แรก
  เขียน `.mailbox-out/probe` แล้ว companion บอก `wrote no .../zprobe1`
- **lane นี้คือ**
  `CLAUDE_CONFIG_DIR=$HOME/.config/claude-profiles/zai ANTHROPIC_MODEL=opus
  ACP_EXPECT_MODEL=opus node acp-companion.mjs claude <cwd> <task> <brief>` ·
  **ห้ามตั้ง `ACP_CMD`** · `opus` บนโปรไฟล์นี้ = `glm-5.2[1m]` (ยืนยันด้วย
  probe จริง ไม่ใช่เดาจากไฟล์ settings)
- **ต้องรันแบบ detached (`nohup ... &`)** · รอบแรกยิงแบบ foreground แล้ว Bash
  tool หมดเวลา 10 นาที ฆ่าทั้ง process group → `[liveness] cancelling` →
  ทั้งสี่เหลือแต่ `started, not finished` 22 ไบต์ · **ไม่ใช่ lane เสีย**
  session id ที่เสียไปเก็บไว้ที่ `<scratch>/session-ids.txt` เผื่อ resume

**ถ้ารอบไหนได้แต่ placeholder** — ลอง `ACP_RESUME=<session-id>` พร้อมคำสั่งสั้นๆ
"เขียนสิ่งที่มีอยู่แล้วออกมา อย่าวิเคราะห์ใหม่" **และต้องมีประโยค "ถ้าไม่เหลือ
อะไรให้บอกตรงๆ ว่าไม่มี"** ก่อนจะยิงรอบใหม่ · ห้าม `rm -rf` ไดเรกทอรีก่อนจด
session id

## หยุดตรงไหน และทำไม — คำสั่ง Master 2026-08-05

**"หยุดเท่านี้ก่อน"** · หยุดที่ `7081342` · suite 745 fail 0 · gate ผ่านหมด ·
**ยังไม่ bump ยังไม่ tag ยังไม่ release**

รอบนี้รีวิวห้ารอบ เจอ defect จริง 13 ข้อ แก้หมด แล้วยังล่า tautology เจออีก 7
แก้ไป 4 · **ทุกครั้งที่ถาม ก็เจอ ไม่มีสักรอบที่ถามแล้วไม่เจอ** — นั่นแปลว่า
ยังไม่รู้ว่าก้นบ่อลึกแค่ไหน ไม่ใช่ว่าใกล้ถึงแล้ว การหยุดตรงนี้เป็นการตัดสินใจ
เรื่องขอบเขต ไม่ใช่ข้อสรุปว่าสะอาดแล้ว

**สองอย่างที่รู้ตัวว่าค้าง ไม่ใช่ของที่ลืม**

- **tautology อีกสองตัว** — `token-projection` "current delegates to
  currentEntry" (เทสคำนวณ `currentEntry(custody)` เองมาเทียบ และ fixture
  จบที่ `assigned` ไม่มี trailing outcome จึงแยก "delegate" จาก
  "reimplement แล้วบังเอิญตรง" ไม่ได้) · `kanban-board` selector test
- **1 commit ที่ยังไม่มีโมเดลนอกอ่าน** (`7081342`) — และมันจะเป็นแบบนี้เสมอ
  ทุกครั้งที่แก้ตามรีวิว นั่นคือรูปร่างของกระบวนการ ไม่ใช่ข้อบกพร่อง

**GitHub #48 เปิดแล้ว** — ไม่มี `graph.json` แล้ว dispatch เงียบกับ template
สี่ทีม · Master ตัดสินว่า**เป็นบั๊ก** · เอกสารแก้ให้พูดความจริงแล้ว
(`032b902`) แต่**พฤติกรรมยังเหมือนเดิมโดยตั้งใจ** — เป็น product decision
ไม่ใช่งานเก็บกวาดเอกสาร

## ถัดไป ตามลำดับ

1. **อ่านผลรีวิวสี่รอบ** — finding ที่ผูกกับความล้มเหลวรูปธรรมได้เท่านั้นถึงนับ
   · ห้องนี้**ไม่ลงมติ** ตาม scene ของมัน คนตัดสินคือ Master
2. **แก้ทุก finding ที่บล็อก** แล้ววนกลับไปรีวิวเฉพาะ bytes ใหม่
3. ถ้าผ่าน: bump `0.15.0` **สี่ที่** (`.claude-plugin/marketplace.json` สองจุด,
   `plugins/tmux-teams/.claude-plugin/plugin.json`, `RELEASE_VERSION` ใน
   `tests/plugin-structure.test.mjs`) → gate เต็มบน bytes ที่จะ commit →
   `gh auth switch --user iicmaster` → push → tag → `gh release create` →
   `claude plugin marketplace update` + `plugin update`
4. bump submodule pin ใน `~/agent-skills` — **โปรเจกต์อื่น ต้องขอ Master ก่อน**

## หนี้ที่รู้ตัว ไม่ได้ทำ

- **29 worktree ค้าง** จากเวฟเก่าใน `.claude/worktrees/` ทุกตัว `commits=0`
  แต่ยังมีไฟล์ค้าง · ไม่ลบเพราะเป็นหนี้พื้นที่ ไม่ใช่หนี้ความถูกต้อง และการลบ
  ของ dirty กลางรีลีสไม่คุ้มเสี่ยง · `git worktree prune` ไม่พอ ต้องลบไดเรกทอรี
- **`/handoff` — ยังไม่รู้สาเหตุจริง** · skill อยู่ใน cache 0.14.6 แล้ว และ
  `commands/handoff.md` เพิ่มแล้ว · แต่ยังแยกไม่ออกว่าปัญหาเดิมคือ session ถือ
  index 0.14.5 หรือว่า plugin skill ไม่กลายเป็น slash เองโดยไม่มีไฟล์ command ·
  **การทดลองที่แยกสองข้อนี้ได้ฟรี: ให้ Master พิมพ์ `/sqthink`** (skill ที่ไม่มี
  ไฟล์ command เหมือนกัน มีมาตั้งแต่ 0.2.4) · เจอ = ปัญหาคือ cache · ไม่เจอ =
  ต้องมีไฟล์ command
- **`legCeiling` ยังนับ transport leg** (§4.10 บอกไว้) — เกี่ยวกับ #47 โดยตรง

## UNPROVEN — ทุกอย่างที่รู้จากการอ่าน ไม่ใช่จากการรัน

- **การ bump submodule pin ใน `~/agent-skills`** — ไม่ได้ตรวจ เพราะ
  `~/agent-skills` เป็นคนละโปรเจกต์ (memory: "tmux-teams repo is the
  boundary") ห้ามแตะแม้แต่ submodule pin จาก session นี้ ต้องขอ Master ก่อน
  ถ้าจะรู้สถานะจริง
- **suite ที่ HEAD จริง (`f75597f`) ยังไม่ถูกวัดในรอบนี้** — เลข 676/0
  fail มาจาก commit `42dfe7a` เท่านั้น (อ่านจาก issue comment ไม่ได้รันเอง)
  commit `774e179` ที่ตามมาเติมเทสใหม่ที่ยังไม่ถูกนับ ต้องรัน
  `node --test` เต็มก่อนเชื่อว่า suite เขียวที่ HEAD
- **`docs-paths.test.mjs` ของไฟล์นี้เอง** — path ทุกอันในตารางนี้อ่านจาก
  `grep`/`git show` จริง แต่ยังไม่ได้รัน `node --test tests/docs-paths.
  test.mjs` เพื่อยืนยันอัตโนมัติ — รันก่อนเชื่อ 100%
- **"ไม่มี breaking change" เป็นการอ่านโค้ดเทียบ diff เท่านั้น** ไม่ใช่การ
  รัน integration test ข้ามเวอร์ชันจริงกับ deployment ของใคร — ถ้าพบว่า
  breaking อะไร นั่นคือสิ่งสำคัญที่สุดที่ต้องแก้ไฟล์นี้กลับมา
- **`buildTaskId` (`loop-runner.mjs:1599-1605`) ยังไม่ unique แบบเข้ม** —
  digest 16 hex = 64 bit ของ tuple `(workItem, team, role, ms)` ชนกันได้ถ้า
  tuple เดิมในมิลลิวินาทีเดิม comment ในโค้ดยอมรับตรงๆ ว่าเป็น "bounded
  collision-resistance, not uniqueness" — นี่คือการตัดสินใจที่บันทึกแล้ว
  ไม่ใช่บั๊กที่ต้องรีบแก้ แต่ยังไม่มีใครวัดว่าชนจริงหรือยัง
- **`locked` retry ทั้งสองจุด (`LOCK_MAX_WAIT_MS`) ไม่มีเทสตรงๆ** —
  `grep -rl LOCK_MAX_WAIT_MS tests` ไม่เจอไฟล์เทสไหนอ้างชื่อนี้เลย ต้องถือ
  lock ครบ `LOCK_MAX_WAIT_MS` (เทสจะกิน ~15 วินาที) ถึงจะพิสูจน์ — carried
  forward จาก handoff รอบก่อน ยังไม่ได้แตะในรอบนี้

## WHERE THINGS LIVE

- SSOT: `plugins/tmux-teams/skills/tmux-teams/references/loop-system-
  contract.md` — ที่ contract กับโค้ดขัดกัน contract ชนะ โค้ดคือบั๊ก
- ADR: `plugins/tmux-teams/docs/adr/0001-acp-only-exact-three-review-gate.md`,
  `plugins/tmux-teams/docs/adr/0003-mcp-server-containment-seam.md`
- Ledger/loop core: `plugins/tmux-teams/skills/tmux-teams/scripts/loop-
  runner.mjs`, `ledger-validate.mjs`, `ledger-writer.mjs`, `pull-
  controller.mjs`, `acp-companion.mjs`
- Graph/board: `plugins/tmux-teams/skills/tmux-teams/scripts/graph.mjs`,
  `workflow-graph.mjs`
- Review gate: `plugins/tmux-teams/skills/party-mode/scripts/review-
  gate.mjs`, `review-profiles.mjs`, `review-policy.mjs`
- Ratchet (dev-only, repo root ไม่ใช่ skills): `scripts/ledger-reader-
  ratchet.mjs`, `scripts/ledger-readers.baseline.json`
- Handoff skill: `plugins/tmux-teams/skills/handoff/SKILL.md`, command:
  `plugins/tmux-teams/commands/handoff.md`
- Release flow, worktree rule, push-account gotcha: `CLAUDE.md` (repo root)
  — ไม่ซ้ำเนื้อหาที่นี่ อ่านตรงนั้น
