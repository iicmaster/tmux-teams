# HANDOFF — tmux-teams · รอบรีวิวห้าและหก (2026-08-04)

> เขียนให้ **agent** อ่านแล้วลงมือต่อได้ทันที ไม่ใช่ให้คนอ่านเอาเรื่อง
> อ่านสามหัวข้อแรกแล้วรู้ว่าต้องทำอะไรต่อ

## สถานะในสิบวินาที

- **ยังไม่ bump version** — ของทั้งหมดอยู่บน `main` แต่ยังเป็น 0.14.5
  จนกว่าจะแก้เลขสามที่ + tag + `gh release`
- `origin/main` = `6d560db` (รอบห้า, push แล้ว) · **7 commit หลังจากนั้นยังไม่ push**
- **suite 646 · fail 0 · whitespace clean · plugin validate ผ่าน** บนเครื่องนี้
- โต๊ะรีวิวรอบหก: `agy` BLOCKING (จบ), `codex` BLOCKING (จบ), `qwen` ยังไม่จบ
  ตอนเขียน — **ห้าม bump จนกว่าจะครบสาม** (กฎ Master, ไม่มีข้อยกเว้น)

## คำสั่งที่ต้องรู้ก่อนแตะอะไร

```bash
node scripts/run-fast.mjs fast   # ~2 วินาที · ใช้ระหว่างทำงาน
node --test                      # ~120 วินาที · กิน 8 คอร์ · ครั้งเดียวก่อน commit
```

`grep` เหนือผลเทสต์ **ไม่ใช่ gate** — มันคืน 0 ตอน*เจอ* `✖` · gate ที่ถูก:

```bash
node --test > /tmp/suite.log 2>&1; grep -q '^ℹ fail 0$' /tmp/suite.log || { grep '^✖' /tmp/suite.log | head; false; }
```

**ห้าม fan out subagent ที่รัน `node --test` พร้อมกัน** — เคยทำให้ load แตะ 28
บน 8 คอร์ และ 42 นาทีไม่มีใครเสร็จสักตัว · แตกงาน*อ่าน*ได้ แต่การ*วัด*ต้องผ่านคนเดียว

## สิ่งที่ต้องทำต่อ ตามลำดับ

1. **รอ `r6-qwen` ให้จบ** แล้วอ่าน `<scratchpad>/r6-qwen/.mailbox-out/r6-qwen`
   · ถ้ามี BLOCKING ให้แก้ก่อน
2. รอบใหม่ (รอบเจ็ด) ต้องรีวิว **bytes ล่าสุด** — `git diff 96d3196..HEAD`
   ไม่ใช่ช่วงของรอบหก เพราะแก้ไปเยอะหลัง freeze
3. ถ้า PASS ครบสาม: bump `0.14.6` ที่ **สามที่** —
   `.claude-plugin/marketplace.json` (สองจุด: `metadata.version`, `plugins[0].version`),
   `plugins/tmux-teams/.claude-plugin/plugin.json`, และ `RELEASE_VERSION` ใน
   `tests/plugin-structure.test.mjs`
4. `node --test` + `git diff --check` + `claude plugin validate --strict .`
   **บน bytes ที่จะ commit จริง** (ดูบทเรียนของ `90fc4a1` ข้างล่าง)
5. `gh auth switch --user iicmaster` → push → ตรวจ `git status -sb` ว่าเป็น
   `main...origin/main` ไม่มี `ahead` (remote `fork` รับ push จากบัญชีผิดได้เงียบๆ)
6. `git tag v0.14.6 && git push origin v0.14.6` แล้ว `gh release create`
   — ขั้นนี้เพิ่งถูกเพิ่มเข้า Release flow ใน CLAUDE.md เพราะ **30 เวอร์ชันก่อนหน้าไม่มี tag เลย**
7. `claude plugin marketplace update tmux-teams` → `claude plugin update tmux-teams@tmux-teams`
8. bump submodule pin ใน `~/agent-skills` — **โปรเจคแยก ต้องขออนุญาต Master ก่อน**

## 7 commit ที่ยังไม่ push

| sha | เรื่อง | ที่มา |
|---|---|---|
| `1d3a459` | lock ที่ถูกขโมยแล้วเจ้าของเดิมลบทิ้ง · caller ทิ้ง `locked` · panel ปฏิเสธ lane จริง | agy |
| `2324edf` | token ที่ ledger เชื่อไม่ได้ไม่มีทางปิด — `closeUnbelievableHistory` | agy |
| `c3b2bb1` | `record()` ของ runner ทิ้ง `locked` ทั้งห้าจุดเขียน | agy |
| `90fc4a1` | ห้าช่องจาก codex (สองช่องรอบห้าเปิดเอง) | codex |
| `7ba0392` | ปิด mutant ที่ Quinn ชี้ + แก้ doc path ที่ `90fc4a1` ทำพัง | codex |
| `7a4a94c` | issue #39 — สองสาเหตุ พิสูจน์ด้วยการวัด | เอง |
| `25cd7f5` | `pull --apply` exit 0 ทั้งที่ไม่ได้เขียนอะไรเลย | codex |

**เก้าการ์ดใหม่ผ่าน mutation test ทุกใบ** (ถอดการ์ด → เทสแดง → คืนด้วยการ copy ไฟล์
แล้วเทียบ checksum) · **ห้าม revert ด้วย `str.replace` กลับทาง** — anchor ซ้ำได้และเคยทำให้
สองการวัดเป็นโมฆะมาแล้ว

## บทเรียนของรอบนี้ — อย่าทำซ้ำ

### 1. "เสริมความเข้ม" ที่เปิดช่องใหม่

`assertAdapterPackageBoundToCommand` เปลี่ยนจาก `.includes()` → `.at(-1)`
เพราะดูเข้มกว่า · **แต่ npx รัน positional ตัวแรก** ไม่ใช่ตัวสุดท้าย ·
`npx <pkgA> -y <pkgB>` จึงผ่านในนาม pkgB ทั้งที่รัน pkgA · **และเทสยืนยันว่าถูก**
→ gate กับเทสเห็นตรงกันเอง แต่ไม่ตรงกับ npx

**กฎ:** เปลี่ยนกฎความปลอดภัยต้องเทียบกับ *help ของเครื่องมือจริง* ไม่ใช่สัญชาตญาณ

### 2. gate ต้องรันบน bytes ที่จะ commit

`90fc4a1` ผ่าน suite แล้วผมเติม amendment ทีหลัง → path ผิดหลุดไปกับ commit ·
`docs-paths` จับได้ในรอบถัดมา

### 3. comment ที่ไม่เคยถูกเทียบกับการรัน

- `acp-companion.mjs` เขียนว่า agy lane "ตายมาตั้งแต่ 2026-07-21" และ "ไม่เคยรัน" —
  วันนี้มันรันสำเร็จสองรอบผ่าน allowlist นั้นเป๊ะๆ
- `ledger-writer.mjs` เขียนว่า steal ให้ "at most one new holder" — เท็จ ·
  `wx` กันแค่ *create* ไม่ได้กันการตัดสินใจที่อยู่ข้างหน้า
- contract §14.5 เขียนว่า `appendEvent` ไม่มี lock — มีตั้งแต่รอบห้า

### 4. issue #39 — จับข้อความจริงเท่านั้น

หนึ่งสัปดาห์ที่โทษ "load" · ความจริงคือ `waitForFile` รอแค่ *path* ขณะที่
`writeFileSync` เปิดไฟล์ (`O_CREAT|O_TRUNC`) ก่อนเขียน ·
**วัดได้: อ่านเจอไฟล์ว่าง 1161/7058 ครั้ง (16%) กับ `writeFileSync` และ 0/4895 กับ rename**
· เข้ากันพอดีกับแดง 1 ใน 6

เจอสาเหตุที่สองระหว่างยืนยัน: เทสหนึ่งให้งบ stall 0.2 วินาที ซึ่งสั้นกว่าเวลา spawn node
+ handshake ACP ตอนไฟล์รัน case แบบ concurrent ข้างๆ · เขียว 8/8 เมื่อรันเดี่ยวที่ load 21
แดงเมื่ออยู่ในไฟล์ = งบวัด harness ไม่ได้วัดพฤติกรรม

**หลังแก้ทั้งสอง: 10/10 เขียว**

## เรื่องที่ตัดสินไปแล้ว — อย่ารื้อ

- **`reviewed` ที่ไม่มี id เลย ไม่ใช่รูปแบบที่ระบบเขียน** — writer ประทับ
  `dispatch_id` เสมอ (`loop-runner.mjs:784`) · รอบห้าเรียกมันว่า "genuine shorthand"
  และนั่นผิด · ตอนนี้รับเฉพาะเมื่อ leg ของผู้รีวิว**ยังไม่เคยรายงาน**
- **stale takeover ทำให้ปลอดภัยไม่ได้ด้วย file primitive** — steal ผ่าน marker ของตัวเอง
  และลบเฉพาะ lock ที่ token ยังตรงกับที่ตัดสิน · แต่ holder ที่ยังมีชีวิตแต่ช้ายังถูกขโมยได้ ·
  §14.5 พูดตรงแล้ว ไม่อ้างว่าปิด · ถ้าจะปิดจริงต้องใช้ fencing token
- **#40 (executable ที่ swap ได้) ไม่เข้า 0.14.6** — มันทำให้ endpoint pin กลายเป็น
  คำโกหกที่ gate เชื่อ · วิธีทำที่ถูกบันทึกไว้ใน issue comment แล้ว
- **PR #41 (`display_model`) ยังไม่ merge** — merge สะอาด, เทสเจาะจงผ่าน 85/85
  แต่มาหลัง freeze · ต้องผ่านรอบรีวิวด้วย

## ยังเปิดอยู่

1. **#40** — kimi seat transport-dead + executable swap (ดูข้างบน)
2. **`locked` retry ทั้งสองที่ยังไม่มีเทส** — ต้องถือ lock ครบสาม `LOCK_MAX_WAIT_MS`
   = เทส 15 วินาที · บันทึกไว้ตรงๆ ไม่ได้ซ่อน
3. **`buildTaskId` ชนได้ถ้า tuple เดิมในมิลลิวินาทีเดิม** — 16 hex = 64 bit ไม่ใช่ unique
   · comment แก้ให้ตรงแล้ว
4. หน้ากราฟเลื่อนแนวนอนที่ 400px (มีมาก่อนแล้ว)
