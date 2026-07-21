#!/usr/bin/env node
// kms.mjs — Team KMS: run memory for the tmux-teams PM loop (SKILL.md §9).
//
// One finished dispatch = one immutable file under <repo>/.tmux-teams/kms/events/.
// No lock, no index, no cross-repo pages: five independent review lanes agreed
// those were ceremony at this scale (tens of events per repo, one operator), and
// one-file-per-event deletes the append-contention and rewrite-blast-radius
// failure modes outright.
//
// WHAT THIS IS NOT: a gate. Workers run as the same UID with broad permissions,
// so this store is worker-writable wherever it sits — it remembers the PM's
// verdict, it never substitutes for it. Say that out loud rather than letting the
// file layout imply tamper-resistance it does not have. (Living inside the repo
// makes that honest rather than worse: `git status` can at least see meddling
// with the store's own .gitignore, which a $HOME location could never show.)
//
// usage:
//   kms.mjs append <repo-path> <event-file>            # '-' reads stdin
//   kms.mjs recall <repo-path> <terms...> [--worker W] [--limit N]
//
// Both commands are best-effort by contract: a failure here must never fail the
// orchestration run that produced the knowledge. Callers report the warning and
// carry on (see mailbox-run.js Distill stage).
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

// The completion detector reads .mailbox-out/<id> and matches a whole final line.
// It never reads this store — so defanging matters on the way OUT, where recalled
// text lands in the next brief and a worker might echo it into its outbox.
// No \b: `_` is a word character, so `_TEAM_DONE` and `TEAM_DONE_x` would slip a
// boundary-anchored pattern. Substring replacement has no such hole. Every line
// this script prints goes through it — an allowlist of "safe" call sites is the
// shape of fix that misses the next one someone adds.
const defang = (s) => String(s).replace(/TEAM_(DONE|BLOCKED|FAILED)/g, '[TEAM_$1]')
const say = (s) => console.log(defang(s))
const warn = (s) => console.error(defang(s))

const [cmd, repoArg, ...rest] = process.argv.slice(2)
const USAGE = 'usage: kms.mjs append <repo> <event-file|->  |  kms.mjs recall <repo> <terms...> [--worker W] [--limit N]'
if (!cmd || !repoArg) { warn(USAGE); process.exit(2) }

// The store lives IN the repo it remembers — same convention as `.mailbox-out/`
// (worker outboxes) and `.remember/` (the remember plugin's memory). The repo IS
// the key, so two projects sharing a basename can no longer share one memory, and
// the store travels with the project instead of rotting in $HOME after a rename.
let REPO
try { REPO = realpathSync(repoArg) } catch { warn(`[kms] no such repo: ${repoArg}`); process.exit(2) }
const STORE = join(REPO, '.tmux-teams')
const EVENTS = join(STORE, 'kms', 'events')

// Self-ignoring directory: we cannot edit the target repo's .gitignore, and an
// event carries verify output that must never reach a commit. `.remember/` uses
// the same trick.
function ensureStore() {
  mkdirSync(EVENTS, { recursive: true })
  const ignore = join(STORE, '.gitignore')
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n')
}

// EVIDENCE is raw command output by contract, so it carries whatever the command
// printed — env dumps, connection strings, bearer tokens. This store outlives the
// repo and sits outside .gitignore's reach, so scrub on the way IN: once written,
// removing a secret would mean rewriting an immutable event.
const SECRETS = [
  // Provider-shaped tokens — recognisable on their own, whatever surrounds them.
  [/\b(sk|rk|pk)-[A-Za-z0-9_-]{16,}/g, '$1-<redacted>'],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, 'gh<redacted>'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, 'github_pat_<redacted>'],
  [/\bxox[baprse]-[A-Za-z0-9-]{10,}/g, 'xox<redacted>'],
  [/\bAKIA[0-9A-Z]{12,}/g, 'AKIA<redacted>'],
  [/\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '<redacted-jwt>'],
  // Auth credentials. Context is the signal, not length: after an Authorization
  // header even `Basic dTpw` is a credential (it decodes to `u:pw`), while a bare
  // `basic info` in prose is not — a length floor alone either leaks the first or
  // shreds the second.
  // Two shapes: `<scheme> <credential>`, or a bare opaque token long enough that
  // it cannot be a config word — `authorization: true` and `: disabled` survive.
  // Horizontal whitespace only: \s spans newlines, so one header would swallow
  // the start of the next line and mangle everything after it.
  [/((?:proxy-)?authorization[ \t]*[:=][ \t]*)(?:\S+[ \t]+\S{3,}|\S{16,})/gi, '$1<redacted>'],
  [/\b(bearer)[ \t]+[A-Za-z0-9+/=._-]{20,}/gi, '$1 <redacted>'],
  // key/value pairs as `k: v`, `k=v`, `"k": "v"`, `'k': 'v'`. Two rules, because
  // one cannot cover both naming styles without shredding real content:
  // (a) separated names, case-insensitive — api_key, ACCESS-TOKEN, db.password.
  // The prefix repetition is BOUNDED: an unbounded nested quantifier over
  // worker-authored text is a needless backtracking risk, and no real key name
  // has ten dotted segments.
  [/(^|[^A-Za-z0-9_])(["']?)((?:[A-Za-z0-9]{1,64}[_.-]){0,10}(?:api[_.-]?key|key|token|secret|password|passwd|pwd|credentials?))\2([ \t]*[:=][ \t]*)(["']?)[^\s"',;}&]{8,}\5/gi,
    '$1$2$3$2$4$5<redacted>$5'],
  // (b) camelCase, case-SENSITIVE: the secret noun must start with a capital, so
  // `accessToken`/`clientSecret` match while `monkey` and `keyboard` do not.
  [/(^|[^A-Za-z0-9_])(["']?)([a-z][A-Za-z0-9]{0,63}(?:Key|Token|Secret|Password|Passwd|Pwd|Credentials?))\2([ \t]*[:=][ \t]*)(["']?)[^\s"',;}&]{8,}\5/g,
    '$1$2$3$2$4$5<redacted>$5'],
]
const redact = (s) => SECRETS.reduce((acc, [re, to]) => acc.replace(re, to), s)

if (cmd === 'append') {
  const src = rest[0]
  if (!src) { warn(USAGE); process.exit(2) }
  let body
  try { body = src === '-' ? readFileSync(0, 'utf8') : readFileSync(src, 'utf8') } catch (e) {
    warn(`[kms] cannot read event: ${e.message}`); process.exit(1)
  }
  const field = (k) => (body.match(new RegExp(`^${k}:[ \\t]*(.+)$`, 'm')) || [, ''])[1].trim()
  const task = field('task_id'), worker = field('worker')
  if (!task || !worker) { warn('[kms] event needs task_id: and worker: lines'); process.exit(2) }
  const safe = (s) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 40)
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '-').slice(0, 15)

  // Uncaught here would print an undefanged stack straight to stderr, bypassing
  // every guard below.
  try { ensureStore() } catch (e) {
    warn(`[kms] cannot create store: ${e.message}`); process.exit(1)
  }
  // wx + a suffix on collision: two workers finishing in the same minute must not
  // silently overwrite each other, and one bad write can only ever cost one event.
  // The suffix uses `~` (sorts AFTER `.`) and is zero-padded, so the filename order
  // recall relies on stays chronological — `-1` sorts before the base name, and an
  // unpadded `~9` sorts after `~10`.
  const base = `${stamp}_${safe(task)}_${safe(worker)}`
  for (let n = 0; ; n++) {
    const path = join(EVENTS, n ? `${base}~${String(n).padStart(2, '0')}.md` : `${base}.md`)
    try {
      writeFileSync(path, redact(body.endsWith('\n') ? body : body + '\n'), { flag: 'wx' })
      say(path)
      break
    } catch (e) {
      if (e.code !== 'EEXIST') { warn(`[kms] write failed: ${e.message}`); process.exit(1) }
      if (n > 50) { warn('[kms] too many id collisions'); process.exit(1) }
    }
  }
  process.exit(0)
}

if (cmd === 'recall') {
  const terms = [], flags = {}
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--worker' || rest[i] === '--limit') flags[rest[i].slice(2)] = rest[++i]
    else terms.push(rest[i])
  }
  const n = Number(flags.limit)
  const limit = Number.isInteger(n) && n > 0 ? n : 5
  let files = []
  try {
    files = readdirSync(EVENTS).filter(f => f.endsWith('.md')).sort().reverse()
  } catch (e) {
    // Only "no store yet" is normal. A permission or I/O error reported as
    // "no memory" is how a store silently stops existing without anyone noticing.
    if (e.code !== 'ENOENT') { warn(`[kms] cannot read store: ${e.message}`); process.exit(1) }
  }
  if (!files.length) { say('[kms] no events recorded for this repo yet'); process.exit(0) }

  const needles = terms.map(t => t.toLowerCase()).filter(Boolean)
  const want = flags.worker ? flags.worker.trim().toLowerCase() : ''
  const hits = []
  for (const f of files) {
    let text
    try { text = readFileSync(join(EVENTS, f), 'utf8') } catch (e) { warn(`[kms] skipped ${f}: ${e.message}`); continue }
    // Exact field compare, not an interpolated regex: `--worker codex` must not
    // match `codex-extra`, and `--worker [` must not crash recall.
    if (want && (text.match(/^worker:[ \t]*(.+)$/m) || [, ''])[1].trim().toLowerCase() !== want) continue
    // No terms = "show me the recent history"; terms = every one must appear, so
    // a narrow question does not drown in loosely-related events.
    const hay = (f + '\n' + text).toLowerCase()
    if (needles.length && !needles.every(t => hay.includes(t))) continue
    hits.push([f, text])
    if (hits.length >= limit) break
  }
  if (!hits.length) { say(`[kms] ${files.length} event(s) on file, none match`); process.exit(0) }

  // Verdict rides on every hit: a failed run is the most useful memory there is
  // ("what went wrong last time"), so recall surfaces it rather than filtering to
  // passes — but the reader must never mistake it for a verified fact.
  say(`[kms] ${hits.length} of ${files.length} event(s) — PAST RUNS, reference only; verify before relying on any of it`)
  for (const [f, text] of hits) {
    const get = (k) => (text.match(new RegExp(`^${k}:[ \\t]*(.+)$`, 'm')) || [, '—'])[1].trim()
    say(`\n--- ${f}`)
    say(`    verdict=${get('pm_verdict')} terminal=${get('terminal')} rev=${get('repo_rev')} worker=${get('worker')}`)
    const lesson = get('lesson')
    if (lesson !== '—') say(`    lesson: ${lesson}`)
    const verify = get('verify_cmd')
    if (verify !== '—') say(`    verify_cmd (do NOT re-run blindly — re-derive it from the plan): ${verify}`)
  }
  process.exit(0)
}

warn(USAGE)
process.exit(2)
