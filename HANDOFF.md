# HANDOFF — tmux-teams · หลังปล่อย v0.14.0 (2026-08-03)

## อ่านสิบวินาทีแรก

- **v0.14.0 ปล่อยครบทุกช่องทางแล้ว** — GitHub `454cb1a..a6aad20` (21 commit),
  marketplace อัปเดต, plugin 0.13.1 → 0.14.0, submodule ใน `~/agent-skills`
  pin ที่ `5099146`
- ⚠️ **ต้อง restart** ให้ปลั๊กอิน 0.14.0 มีผล
- `main` สะอาด · **484/484** · `git diff --check` clean · `validate --strict` ผ่าน
- **ปาร์ตี้โหมดถูกบังคับด้วย hook** — `.claude/hooks/party-gate.mjs` บล็อกคำตอบที่
  ไม่มีเสียงจากคณะจริง และบังคับให้มี **John (PM)** กับ **Sally (UX)** ทุกคำตอบ
  · คณะมาจาก `resolve_party.py` ห้ามกุชื่อ

## v0.14.0 คืออะไร

รีลีสที่ **ลบ** — net **−12,331 บรรทัด** (+1,960 / −14,291)

| | |
|---|---|
| ลบระบบเฟสสี่ขั้นทั้งก้อน | 9 สคริปต์ ~5,666 บรรทัด + เทสต์ + 5 schema + runbook + แถบบนหน้า Pulse |
| ถอนคำสั่งที่เคยประกาศ | `delivery-loop-export.mjs export` / `verify-pack` · แฟล็ก `--delivery-loop` / `--delivery-runtime` |
| แก้ ACP trust boundary 7 ข้อ | ทุกข้อมี negative control พิสูจน์ด้วย mutation |
| เขียนคู่มือ + ผังงานใหม่ | `README.md`, `references/how-it-works.md` (6 mermaid) |
| แก้หน้ากราฟตามที่ Master สั่ง | แถบเดียว 33px · canvas 78vh · ปุ่ม `full` · เส้นภายในทีมเป็นประ · reject อ้อม worker |

**ข้อที่กระทบผู้ใช้จริงที่สุด:** เดิม `modelEnv()` ส่งแค่ `ACP_EXPECT_MODEL` ซึ่งเป็น
*ข้อเรียกร้อง* ไม่ใช่ *คำขอ* — **ทุกที่นั่งวิ่งบน account default มาตลอด** ทั้งที่กราฟ
ประกาศโมเดลไว้ และที่นั่งที่ประกาศอย่างอื่นจะ fail · ตอนนี้ส่ง `ACP_MODEL` ด้วย และ
ที่นั่งเลือก lane เองได้ (`adapters` ต่อทีม, `outer_controller_adapter`)

## งานค้าง — เรียงตามที่ผมจะทำก่อน

1. ~~**สอง SSOT**~~ — **ปิดแล้ว 2026-08-03** · `loop-graph-page.md` เลิกประกาศตัวเป็น
   SSOT และประกาศว่าเป็น **บทขยายของสัญญา §12** พร้อมกติกาว่า**สัญญาชนะเมื่อขัดกัน** ·
   สัญญามีสารบัญ `Where to look` §0–§15 ที่หัวไฟล์แล้ว และ §12 ชี้ลงไปที่ไฟล์รอง ·
   คำอ้าง SSOT ก้อนที่สามที่ `graph-tour.mjs:3` ถูกแก้ด้วย และ `CLAUDE.md` เลิกย้าย
   คำอ้างเข้ามาไว้ในไฟล์ที่ทุกเซสชันโหลด · **ยังชี้ §9 เหมือนเดิม ห้ามเปลี่ยนเลข §**
2. ~~**`pulse.mjs` ไม่ปฏิเสธแฟล็กที่ไม่รู้จัก**~~ — **ปิดแล้ว 2026-08-03** · ทุก argument
   ต้องเป็นตัวที่**คำสั่งนั้นอ่านจริง** ไม่งั้น exit 2 พร้อมบอกชื่อ argument ·
   `--interval`/`--managed` ถูกปฏิเสธบน `once`/`json` ที่ไม่เคย watch ·
   `--interval abc|0|-5` ถูกปฏิเสธแทนที่จะตกไปใช้ค่า 20 เงียบ ๆ ·
   เทสต์ 2 ตัวใน `pulse.test.mjs` ผ่าน mutation แล้ว (ถอด guard → แดงทั้งคู่)
3. ~~**กฎ flow ทางเดียวยังไม่มีอะไรบังคับ**~~ — **บังคับแล้ว 2026-08-03** ·
   `validateLedger` ปฏิเสธ `pulled` ที่ `to_team` เป็นทีมซึ่ง**รับเข้า** token นี้ไปแล้ว
   (code `route_went_backwards`) และเพราะ writer ตรวจทั้งก่อนและหลังทุก append
   บรรทัดนั้นจึงไม่เคยลง · **นับตอน `intake` ไม่ใช่ตอน `pulled`** — ทีมที่ปฏิเสธที่ประตู
   ไม่เคยรับเข้า จึงยังดึงงานเดิมได้อีกหลังแก้ · `loop-replay.test.mjs` seed 1 เป็นตัวพิสูจน์
   ข้อนี้ตอนที่เขียนผิดรอบแรก · negative control 2 แบบใน `ledger.test.mjs`
   · **ยังเหลือ:** `pull-controller.mjs` ทิ้งค่า refusal ลง stderr — การปฏิเสธของ writer
   จึงมองไม่เห็นจาก plan (นี่คือสิ่งที่ทำให้ token ค้างเงียบตอนดีบัก)
4. **เทสต์ที่เขียวแต่ไร้ความหมาย** — `pulse-json.test.mjs` เคยตรวจ degraded path ด้วย
   `--delivery-loop <ไฟล์ที่ไม่มี>` · Gate 1 (เทียบชื่อเทสต์) **จับแบบนี้ไม่ได้**
5. **`title` ของการ์ดเข้าถึงได้เฉพาะเมาส์** — ข้อมูลที่ย้ายไปซ่อนใน tooltip
   (path ของ graph, `snapshot_id`, จำนวนทีม) คนใช้คีย์บอร์ด/แตะจอไม่เห็น (Winston ค้าน)
6. **guard backtick เป็น allowlist สามก้อน** — ไม่ discover สตริงฝั่งไคลเอนต์ใหม่เอง

## มติที่ตัดสินไปแล้ว — อย่ารื้อ

- **worker ต่อทีมไม่เกิน 5** — เหตุผลของ Master: `1, 2, 3, 5, 8, 13` — 3 น้อยไป 8 มากไป
  · **fail closed** ที่ `workflow-graph.mjs` ตัวที่ 6 ถูกปฏิเสธ
- **flow ไม่ย้อนข้ามทีม** · แต่ **evaluator วนงานกลับให้ worker ในทีมเดียวกันได้**
  และ **dispatcher ปฏิเสธที่ประตูได้** (ตรวจก่อนรับเข้า ไม่ใช่รับเข้ามาแล้วส่งกลับ)
  · ตัวอย่างของ Master: QA evaluator เจอ checklist ไม่ครบ → ส่งกลับ worker ตัวเอง ·
  เจอบั๊กจริง → **QA แก้เอง ไม่ส่งกลับ Dev**
- **หน้าแรกของกราฟ = สถานะ ไม่ใช่ประวัติ** — เส้นภายในทีม (`assign`/`judge`/`reject`/
  `owns`) เป็นเส้นประเสมอ ไม่แข็งตัวตามหลักฐาน · **เส้นทึบอื่นคงไว้** (`pull`,
  `passed`, route)
- **guard ของ phase-gate ถูกลบพร้อมระบบ** (codex-advisor ตัดสิน) เก็บแค่ tombstone:
  repo ที่ยังมี `.tmux-teams/phase-gate.json` **ถูกปฏิเสธ** ไม่ใช่ลดชั้นเงียบ

## วิธีตรวจที่พิสูจน์แล้วว่าใช้ได้ — ใช้ซ้ำ

**เทสต์เขียวไม่ใช่หลักฐาน** เมื่อของที่ถูกลบพาเทสต์ของตัวเองไปด้วย

1. **เก็บชื่อเทสต์ก่อน + ประกาศ allowlist ล่วงหน้า** ว่าชื่อไหนอนุญาตให้หาย ·
   หลังลบ `before − after` ต้องเท่ากับ allowlist เป๊ะ (ผลจริง: หาย 67 นอกรายการ 0)
2. **canonical witness** — `baseline-probe.mjs` รัน loop จริงบน fixture สองทีม
   `Build → Verify` แล้วคายภาพ ledger/board/activity/outbox/pulse ·
   **map `task_id`/`dispatch_id` แบบ bijection ห้ามลบทิ้ง** — ความสัมพันธ์ของ ID
   คือหลักฐานว่าพูดถึง leg เดียวกัน · เสถียร 3 รอบก่อน ไบต์เหมือนเดิมหลังลบ
3. **mutation test ทุก guard** — ถอด guard แล้วเทสต์ต้องแดง · วันนี้ทำ 11 ครั้ง
4. **หน้าเว็บวัดใน browser เท่านั้น** — `getComputedStyle`, `getBoundingClientRect`,
   นับ `animateMotion` · **ห้ามรายงานจากภาพนิ่ง** (`loop-graph-page.md` §9)

## กับดักที่เสียเวลาไปจริงวันนี้

- **backtick ในคอมเมนต์ปิด template literal** — `TOUR_CSS`/`TOUR_SCRIPT` ·
  เกิดครั้งที่ 8, 9, 10 ของโปรเจกต์ วันนี้วันเดียว · `node --check` จับได้ทุกครั้ง
  **รันมันก่อนรันเทสต์**
- **python `str.replace` ที่ไม่ assert ก่อนเขียน** — เขียนไฟล์เหมือนเดิมแล้วเงียบ ·
  ใช้ `assert old in s` ทุกครั้ง
- **ขยายกฎที่กู้มาโดยไม่รัน** — ขยาย schema invariant 3 ครั้ง ผิดทั้ง 3 ครั้ง
  เพราะ v3/v4 ตั้งใจให้ต่างจาก v2 · **การ scope แคบของต้นฉบับมักถูกแล้ว**
- **process ที่ pin โค้ดเก่า** — `pulse watch`, `loop-runner`, plugin cache
- **`git status` ที่ดูสะอาดหลอก** — `.tmux-teams/` ignore ตัวเองด้วย `.gitignore`
  ข้างใน (เขียนอธิบายไว้ในไฟล์รากแล้ว)

## ความเห็นที่วงยังไม่ตรงกัน — อย่ากลบ

- **สอง SSOT vs แฟล็กเงียบ** ข้อไหนแพงกว่า — Winston: สร้างของผิดแพงกว่า ·
  Murat: สคริปต์ที่พังเงียบกระทบคนวันนี้
- **สเปกยาว 1,209 บรรทัด** — Winston: ระบบเงื่อนไขเยอะต้องยาว · Sally: ยาวจนไม่มี
  ใครอ่านจบ ต้องมีหน้าเดียวที่ชี้ทาง
- **page fingerprint เป็น release blocker ไหม** — Murat: ใช่ หน้าคือของที่ ship ·
  John: เกิน minimum ถ้า semantic snapshot ผ่าน

## ที่อยู่ของของสำคัญ

```
แผนที่อนุมัติแล้ว     ~/.claude/plans/jiggly-spinning-anchor.md
สัญญาระบบ             plugins/tmux-teams/skills/tmux-teams/references/loop-system-contract.md
ผังงาน 6 ภาพ          plugins/tmux-teams/skills/tmux-teams/references/how-it-works.md
กฎหน้ากราฟ + วิธีตรวจ  plugins/tmux-teams/skills/tmux-teams/references/loop-graph-page.md §9
hook บังคับปาร์ตี้      .claude/hooks/party-gate.mjs  (gitignored, machine-local)
probe เก็บพยาน        scratchpad ของเซสชันเก่า — เขียนใหม่ได้จากสูตรในแผน P5
```

## GitHub

- **issue #21** เปิดโดย `ngs-th` — ตอบไว้แล้วว่าสองในสามข้อแก้แล้ว ข้อสามแย้งพร้อม
  เหตุผล · **ยังไม่ปิด** เพราะตอนนั้นยังไม่ push · **ตอนนี้ push แล้ว ปิดได้**
