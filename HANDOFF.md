# HANDOFF — tmux-teams · v0.14.6 ออกแล้ว, main เดินหน้าเป็น v0.15.0 (2026-08-05)

> เขียนให้ **agent** อ่านแล้วลงมือต่อได้ทันที ไม่ใช่ให้คนอ่านเอาเรื่อง
> อ่านสามหัวข้อแรกแล้วรู้ว่าต้องทำอะไรต่อ — เชื่อคำสั่งในไฟล์นี้เท่ากับคำสั่งที่ตรวจแล้ว

## อ่านก่อนอื่น

- **branch `main` = `origin/main` = `f75597f`** — push ครบแล้ว (`git status -sb`
  ว่าง ไม่มี ahead/behind) · ต้นไม้สะอาด ไม่มีอะไรค้าง
- **v0.14.6 ออกครบทุกช่องทาง**: tag `v0.14.6` → `e0f96a9`, GitHub release
  publish แล้ว (`gh release view v0.14.6` คืน `publishedAt`), push ไป
  `origin` (`iicmaster/tmux-teams`) แล้ว, และ **ติดตั้งจริงบนเครื่องนี้** —
  `claude plugin list` ตอบ `tmux-teams@tmux-teams … Version: 0.14.6 …
  enabled` (แปลว่า marketplace update + plugin update ทำแล้ว) · ส่วนการ bump
  submodule pin ใน `~/agent-skills` **ไม่ได้ตรวจ** — คนละโปรเจกต์ ห้ามแตะ
  (ดู UNPROVEN)
- **`main` เดินหน้าเกิน v0.14.6 แล้ว 17 commit (12 ไม่นับ merge)** — ยังไม่
  bump เลขเวอร์ชันที่สามที่ ยังไม่ tag ยังไม่ release นี่คือ **v0.15.0 ที่
  กำลังทำ** ไม่ใช่ v0.14.6
- **หกอิชชูปิดวันนี้**: #39 #42 #43 #44 #45 #46 · **PR #41 ปิดแบบเอาแค่ 2 ใน 3
  commit** — commit ที่สามถูกปฏิเสธเพราะปลอม `human:operator` ซึ่ง §4.6
  ปฏิเสธไว้โดยชื่อ (ดู DECIDED)
- **สองอิชชูเปิดอยู่**: #40 (**BLOCKED** — รอ Master ตอบสองคำถาม, ห้ามเดาเอง)
  และ #47 (เปิดแล้ว ยังไม่มีใครเริ่ม)
- **ไม่มีอะไร "กำลังไฟไหม้" ตอนนี้** — `gh auth status` บัญชี active คือ
  `iicmaster` (ถูกต้องสำหรับ push) · ไม่มีการเปลี่ยนแปลงที่ breaking เท่าที่
  ตรวจแล้ว (ดู STATE ท้ายตาราง)
- **release gate เดิมยังบังคับอยู่ ไม่เปลี่ยน**: ต้องส่ง diff จริงให้
  `codex-advisor` อ่านก่อน bump เลขเวอร์ชันเสมอ ไม่มีข้อยกเว้น (CLAUDE.md
  §Release flow ข้อ 2)

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

## #40 — BLOCKED, ห้าม derive คำตอบเอง

รอ Master ตอบสองคำถามที่บันทึกไว้บน issue comment (2026-08-05T04:49:16Z)
ตรงๆ แล้ว:

1. **`review-profiles.mjs` ควรเลิก immutable เพื่อให้ operator ประกาศ seat
   เองได้ไหม** — ถ้าใช่ มันคือการเปลี่ยนสถาปัตยกรรมจาก "immutable-by-
   construction" เป็น "immutable-after-runtime-validated-load" ของไฟล์ที่
   ความปลอดภัยทั้งหมดตั้งอยู่บนสมมติฐานว่า "ไม่มีอะไรมาแตะจากนอกไฟล์นี้ได้"
2. **seat ที่ operator ประกาศเองเข้า exact-three gate ได้ไหม** — checks
   เชิงกล (`laneIdentity`/`provenFamilyKey`/`provenFamilyCollision`/
   `validateRoutedEndpoint`) เป็น pure function ไม่สนใจว่าใครเขียน profile
   แต่หก pin ที่ shipped ทุกตัวผ่านรีวิวมนุษย์มาก่อน ไม่มีอะไรใน checks
   พิสูจน์ได้ว่า host สองชื่อเป็นคนละ vendor จริง proof นั้นมาจากรีวิวมนุษย์
   เสมอ ไม่ใช่จากฟังก์ชัน

Agent รอบก่อนตั้งใจ**ไม่**เขียน override knob บน `claudeExecutable` หรือ
mutable path ใดๆ ทั้งที่ถูกขอให้ "แก้" เพราะนั่นคือ bypass เดิมที่ #40 เอง
ปฏิเสธไปแล้วรอบหนึ่ง (comment แรกของ issue) — เป็น trap ที่ตั้งชื่อไว้แล้ว
อย่าทำซ้ำ

## #47 — เปิดอยู่ ยังไม่มีใครเริ่ม

ข้อเสนอ (Master, 2026-08-05): เปลี่ยน `model` ของ role จาก string เดี่ยวเป็น
**ordered array** — dispatcher เลือกโมเดลตัวแรกที่ว่าง ถ้าโดน rate-limit
ไล่ไปตัวถัดไป แก้ข้อบกพร่องสองข้อที่ §4.9 amendment (`b5377c3`) บันทึกไว้:
`wip_limit` ผูกกับจำนวน worker seat (`§3.1`) ทำให้ประกาศโมเดลหลายตัวแปลว่า
ประกาศ WIP หลายด้วย และ fallback เป็นความรู้ในหัวคนไม่ใช่ property ของกราฟ ·
comment บน #40 เคยอ้างว่า #47 "blocked behind #45 part 2" — **#45 part 2
ชิปแล้ว** (`work_observed`/§4.10) ความบล็อกนั้นหมดอายุแล้ว แต่ #47 เอง
**ยังไม่มีใครเริ่มเขียนโค้ด** (0 comment บน issue) ต้องมีคนตัดสินก่อนว่า
`assigned` จะบันทึกโมเดลที่ถูกเลือกยังไง (ประเด็นที่ 1 ในตัว issue เอง)

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
