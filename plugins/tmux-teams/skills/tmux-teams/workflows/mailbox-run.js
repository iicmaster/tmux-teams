// mailbox-run.js — runnable Claude Code Workflow for a tmux-teams mailbox PM run.
//
// WHAT IT IS: a deterministic driver that dispatches one bounded task to each
// foreign CLI worker (codex / opencode) over the file-mailbox, enforces the
// outbox self-check contract, then PM-side adversarially verifies every result
// by re-running the worker's own evidence command. Structure borrowed from BMAD
// step-file workflows (quick-dev: execute -> self-check -> adversarial-review);
// mechanics from tmux-teams (SKILL.md §1/§2/§6 + scripts/deliver.sh).
//
// HOW TO RUN:
//   Workflow({ scriptPath: "<...>/tmux-teams/workflows/mailbox-run.js", args: {
//     repo: "/abs/path/to/target/repo",           // where workers cd/run (default: cwd)
//     ctlBase: "~/.tmux-teams/mailbox-run",        // control root; per-worker = ctlBase/<id>
//     deliverSh: "<...>/tmux-teams/scripts/deliver.sh",  // optional; agents locate it if omitted
//     kmsPath: "<...>/tmux-teams/scripts/kms.mjs",       // optional; same — Team KMS distill (§9)
//     timeoutSec: 1200,                            // per-worker wait for a terminal marker
//     runId: "r1",                                 // optional; suffixes the shared session name
//     workers: [
//       { id: "task-1", brief: "…the actual task…", verify_cmd: "php artisan test --filter=X", stakes: "high" }
//     ]
//   }})
//
// DESIGN NOTES (honest):
// - The Workflow tool's agent() spawns CLAUDE subagents; each worker's agent uses
//   its own Bash to drive the foreign tmux TUI. The pane id stays inside that one
//   agent's shell, so no fragile cross-agent state threading.
// - deliver.sh is launched DETACHED (setsid/nohup + disown) so it survives the
//   agent that starts it — it is an OS process, not tied to the agent context.
// - Model routing: the codex TUI is launched plainly and inherits its own frontier
//   default (gpt-5.6-sol ultra per ~/.codex/config.toml). The Workflow's OWN agents
//   are Claude (Opus, inherited) — the verify lane runs at high effort.
// - Control/sandbox split (load-bearing, per references/teammates-messaging.md): the
//   delivery control dir (inboxes, deliver.sh, pidfile, stop flag) lives OUTSIDE the
//   repo at ctlBase/<id> where the worker can't tamper; the outbox lives INSIDE the
//   repo at <repo>/.mailbox-out/<id> — the worker's writable sandbox. Raw outboxes are
//   LEFT in place after the run so a failed verify can be inspected; gitignore that dir.
// - ponytail: NO auto-resolve loop. A failed verify is reported for the human PM to
//   re-dispatch, not silently retried. Add a bounded resolve stage when a real run
//   shows it's needed.

export const meta = {
  name: 'mailbox-run',
  description: 'Drive foreign CLI workers over the tmux-teams file-mailbox: dispatch each with the outbox self-check contract, wait for a typed terminal marker (DONE/BLOCKED/FAILED), then PM-side adversarially verify each TEAM_DONE result by re-running the worker evidence command',
  phases: [
    { title: 'Lifecycle', detail: 'per worker: setup tmux + codex, dispatch via deliver.sh, wait for a terminal marker (DONE/BLOCKED/FAILED), collect outbox' },
    { title: 'Verify', detail: 'PM re-runs each worker evidence command to render pass/fail' },
    { title: 'Report', detail: 'distill each verdict into the Team KMS (best-effort), synthesize, then cleanup sessions' },
  ],
}

// args may arrive as a real object or, if the caller stringified it, as JSON text.
// Accept both — a stringified payload is a documented footgun of the Workflow tool.
const args_ = (() => {
  const a = typeof args !== 'undefined' ? args : null
  if (!a) return {}
  if (typeof a === 'string') { try { return JSON.parse(a) } catch (e) { return {} } }
  return a
})()
const RAW_WORKERS = Array.isArray(args_.workers) ? args_.workers : []
// Port of thClaws' is_valid_agent_name (their M6.34 TEAM1 fix): worker ids build
// filesystem paths ($CTL/inboxes/codex/001-<id>, .mailbox-out/<id>) and tmux
// window names — reject traversal/exotic ids BEFORE any path is formed. Validate
// the RAW entries (not a filtered view) so a malformed worker fails loudly
// instead of being dropped silently; the typeof check defeats RegExp's
// coercion of non-string ids (a numeric 123 would otherwise pass).
const ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/
const seenIds = new Set()
for (const w of RAW_WORKERS) {
  if (!w || typeof w.id !== 'string' || !ID_RE.test(w.id) || typeof w.brief !== 'string' || !w.brief.trim()) {
    throw new Error(
      `mailbox-run: invalid worker entry (id=${JSON.stringify(w && w.id)}) — id must be a string, 1-64 chars, alphanumeric/_/-, starting alphanumeric or _, no path separators; brief a non-empty string`
    )
  }
  // Duplicate ids would share one outbox path, one inbox dir and one tmux window
  // name — two workers silently overwriting each other's results.
  if (seenIds.has(w.id)) throw new Error(`mailbox-run: duplicate worker id "${w.id}" — ids must be unique within a run`)
  seenIds.add(w.id)
}
const WORKERS = RAW_WORKERS
if (!WORKERS.length) {
  throw new Error(
    'mailbox-run: args.workers must be a non-empty array of { id, brief, verify_cmd?, stakes? }. ' +
    'Example: { workers: [{ id: "task-1", brief: "add validation…", verify_cmd: "php artisan test", stakes: "high" }] }'
  )
}
const REPO = args_.repo || '.'
const CTL_BASE = args_.ctlBase || '~/.tmux-teams/mailbox-run'
const TIMEOUT = Number(args_.timeoutSec) > 0 ? Number(args_.timeoutSec) : 1200
const DELIVER = args_.deliverSh || ''
// One shared session per run (SKILL.md §1, 2026-07-17), one window per worker.
// Optional runId keeps concurrent runs on the same folder in separate sessions.
const RUNID = args_.runId ? '--' + String(args_.runId).toLowerCase().replace(/[^a-z0-9]+/g, '-') : ''

// The outbox self-check contract (tmux-teams option 2). Appended to every brief so
// the foreign worker knows the completion protocol. Evidence, not attestation.
// The outbox path is REPO-RELATIVE (`.mailbox-out/<id>`): the worker's cwd is the
// target repo, which is its writable sandbox (control/sandbox split, load-bearing
// per references/teammates-messaging.md) — so it can write there without an
// absolute path or any $VAR the foreign TUI would not expand.
function contract(id, outboxRel, verifyCmd) {
  return [
    ``,
    `--- COMPLETION CONTRACT (mandatory) ---`,
    `Work alone — do NOT spawn, dispatch, or wait for any agents or subagents.`,
    `When finished, WRITE your result to this file, relative to your current directory: ${outboxRel}`,
    `That file MUST contain, in this order, then stop:`,
    `  ASKED:      <restate this task in one line>`,
    `  DID:        <files/actions>`,
    `  EVIDENCE:   <paste the RAW output of the verification command you ran — not a summary, not a checkmark>`,
    verifyCmd ? `              (run: ${verifyCmd})` : `              (run whatever check fits; if none is possible, say so under UNVERIFIED)`,
    `  UNVERIFIED: <what you could not check and why, or "none">`,
    `  GAPS:       <what you intentionally did not do, or "none">`,
    `  <terminal marker — end with exactly ONE of these three lines:>`,
    `  TEAM_DONE ${id}      <- finished the task; evidence above`,
    `  TEAM_BLOCKED ${id}   <- cannot proceed; say why under UNVERIFIED/GAPS`,
    `  TEAM_FAILED ${id}    <- attempted and failed; paste the failing output under EVIDENCE`,
    `TEAM_DONE means "turn finished + evidence dumped" — NOT "it is correct". The PM decides pass/fail. Use BLOCKED/FAILED honestly — they surface immediately instead of wasting the timeout.`,
    `--- END CONTRACT ---`,
  ].join('\n')
}

const LIFECYCLE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['id', 'session', 'pane', 'done', 'terminal', 'timed_out', 'evidence_present', 'outbox'],
  properties: {
    id: { type: 'string' },
    session: { type: 'string', description: 'shared tmux session used, or "" if setup failed' },
    pane: { type: 'string', description: 'tmux pane id (%N) of this worker\'s window, or "" if setup failed — cleanup kills by this' },
    done: { type: 'boolean', description: 'outbox showed TEAM_DONE <id> before timeout' },
    terminal: { type: 'string', enum: ['done', 'blocked', 'failed', 'timeout', 'none'], description: 'which terminal marker ended the wait (timeout = none appeared; none = setup failed)' },
    timed_out: { type: 'boolean' },
    evidence_present: { type: 'boolean', description: 'outbox has a non-empty EVIDENCE block (not just a checkmark)' },
    outbox: { type: 'string', description: 'full captured outbox content (or error note)' },
    verify_cmd: { type: 'string', description: 'the verification command the worker claims to have run, echoed for the verify lane' },
    // Timing is measured HERE, by the agent holding the shell, because this
    // script cannot call a clock. Cheap to record now, impossible to backfill:
    // events are immutable, so a question we cannot answer today ("which task
    // shapes run long?") stays unanswerable for every run already written.
    started_at: { type: 'string', description: 'UTC ISO-8601 from `date -u +%FT%TZ` captured immediately BEFORE dispatch, or "" if setup failed' },
    ended_at: { type: 'string', description: 'UTC ISO-8601 captured the moment the wait ended (marker seen, or timeout), or ""' },
    wait_sec: { type: 'integer', description: 'seconds from dispatch to terminal marker or timeout; -1 when it could not be measured' },
  },
}

const VERIFY_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['id', 'verdict', 'note'],
  properties: {
    id: { type: 'string' },
    verdict: { type: 'string', enum: ['pass', 'fail', 'unverifiable', 'skipped'] },
    note: { type: 'string', description: 'one line: what the PM re-ran and what it showed' },
  },
}

phase('Lifecycle')
const results = await pipeline(
  WORKERS,

  // STAGE 1 — full mailbox lifecycle for one worker, in one bash-driven agent context.
  (w) => agent(
    [
      `You are the PM driving ONE foreign CLI worker over the tmux-teams file-mailbox. Do everything with Bash. Follow tmux-teams SKILL.md §1/§2/§6 exactly.`,
      ``,
      `Worker id: ${w.id}`,
      `Target repo (cd here): ${REPO}`,
      `Control dir for THIS worker: CTL=${CTL_BASE}/${w.id}   (expand ~ yourself)`,
      `deliver.sh: ${DELIVER || 'locate it in this order: the tmux-teams plugin (<plugin root>/skills/tmux-teams/scripts/deliver.sh — $CLAUDE_PLUGIN_ROOT when invoked from the plugin), ~/.agents/skills/tmux-teams/scripts, or the repo skills/shared/tmux-teams/scripts'}`,
      ``,
      `STEPS:`,
      `0. PRECONDITION — HARD FAIL, NEVER FABRICATE: test -d "${REPO}" || STOP NOW and return id="${w.id}", pane="", done=false, terminal="none", timed_out=false, session="", evidence_present=false, outbox="FATAL: target repo ${REPO} does not exist". You MUST NOT create, scaffold, or invent the target repo, its files, or the task's subject matter — not even to "make the run work". If the repo is missing or does not contain what the brief describes, that is a real failure to report, not a gap to fill. (Field-bitten 2026-07-16: an agent silently recreated a missing repo, planted the very bug it then dispatched a worker to fix, and reported pass.)`,
      `1. SETUP (ONE shared session per run, one window per worker): FOLDER=$(basename "${REPO}" | tr 'A-Z.:_ ' 'a-z----' | tr -s -). S="auto--$FOLDER${RUNID}".`,
      `   tmux new-session -d -s "$S" -c "${REPO}" -x 220 -y 50 2>/dev/null || true   ("duplicate session" from a concurrent worker is EXPECTED — NEVER kill-session here: other workers' windows live in it. Window 0 stays an idle PM shell.)`,
      `   PANE=$(tmux new-window -t "=$S" -n "${w.id}" -c "${REPO}" -P -F '#{pane_id}'); tmux set-option -t "$PANE" -w automatic-rename off. Launch: tmux send-keys -t "$PANE" 'codex' Enter (codex inherits its own frontier default — do NOT pass a model flag).`,
      `   Wait ~8s, capture-pane -t "$PANE", handle any trust dialog with a SINGLE keypress (no Enter). Window names are cosmetic — every later command targets "$PANE".`,
      `2. MAILBOX DIRS (control/sandbox split — load-bearing): control lives OUTSIDE the repo where the worker cannot tamper: mkdir -p "$CTL/inboxes/codex". The OUTBOX lives INSIDE the repo (the worker's writable sandbox): REPO_ABS=$(cd "${REPO}" && pwd); mkdir -p "$REPO_ABS/.mailbox-out"; OUTBOX_FILE="$REPO_ABS/.mailbox-out/${w.id}". Then CLEAR STALE STATE from any earlier run that reused this id — a leftover stop flag kills the new delivery loop instantly and a leftover outbox gets accepted as a fresh result (stale-replay): rm -f "$CTL/stop" "$OUTBOX_FILE" "$CTL/inboxes/codex"/* 2>/dev/null.`,
      `3. DISPATCH: record START=$(date -u +%FT%TZ) and T0=$(date +%s) FIRST — these become started_at and the basis for wait_sec, and they cannot be reconstructed later.`,
      `   The outbox dir must ignore itself — an outbox holds RAW command output, and the target repo's .gitignore is not ours to edit: printf '*\\n' > "$REPO_ABS/.mailbox-out/.gitignore" 2>/dev/null || true   (a real run leaked one into a commit before this existed).`,
      `   Then write a DISPATCH RECORD inside the repo, before anything else can fail:`,
      `     mkdir -p "$REPO_ABS/.tmux-teams/dispatch" && printf 'task_id: %s\\nworker: codex\\ntransport: tmux\\nstarted_at: %s\\ntimeout_sec: %s\\npane: %s\\n' "${w.id}" "$START" "${TIMEOUT}" "$PANE" > "$REPO_ABS/.tmux-teams/dispatch/${w.id}.md"`,
      `   This is the PM stating what IT did — not the worker claiming anything — and it is the only durable, repo-scoped proof the dispatch happened. Step 2 deletes the outbox, so a worker that dies before writing one would otherwise leave no trace in this repo at all and its death would be invisible.`,
      `   Then write the brief below to "$CTL/inboxes/codex/001-${w.id}" (one file), and start the delivery loop DETACHED so it survives you:`,
      `   TMUX_TEAMS_CTL="$CTL" TMUX_TEAMS_SESSION="$S" nohup bash <deliver.sh> "$PANE" >/dev/null 2>&1 & disown   (macOS has no setsid — nohup + disown is the portable form; verify the pid is alive before moving on).`,
      `   deliver.sh owns the Enter-swallow verify-retry dance — do NOT send the brief to the pane yourself.`,
      `4. WAIT: poll every 15s for up to ${TIMEOUT}s. The wait ends when "$OUTBOX_FILE" exists AND its LAST non-empty line is EXACTLY one of: "TEAM_DONE ${w.id}" (terminal=done), "TEAM_BLOCKED ${w.id}" (terminal=blocked), "TEAM_FAILED ${w.id}" (terminal=failed) — whole-line match on the final line only; a marker mentioned inside EVIDENCE text or a prefixed id does NOT count, and if the last line matches none keep waiting. blocked/failed end the wait IMMEDIATELY — do not keep waiting for DONE. On timeout, touch "$CTL/stop" to halt the loop and report timed_out=true, terminal=timeout.`,
      `5. COLLECT: the INSTANT the wait ends (marker seen or timeout), record END=$(date -u +%FT%TZ) and wait_sec=$(( $(date +%s) - T0 )) — before reading anything, so the number measures the worker and not your own bookkeeping. Then read "$OUTBOX_FILE". evidence_present = the EVIDENCE block exists and holds real command output (NOT an empty line and NOT just "ok"/"✓"). done=true ONLY when the marker was TEAM_DONE; blocked/failed keep done=false with the matching terminal value. Touch "$CTL/stop" to end the loop. Return the fields, including started_at=$START, ended_at=$END and wait_sec (use "" / -1 only if a step genuinely failed before you could measure — never guess a number).`,
      ``,
      `THE BRIEF (write this verbatim to the inbox file):`,
      `<<<BRIEF`,
      w.brief,
      contract(w.id, `.mailbox-out/${w.id}`, w.verify_cmd || ''),
      `BRIEF`,
      ``,
      `Return the structured result. verify_cmd = ${JSON.stringify(w.verify_cmd || '')}.`,
    ].join('\n'),
    { label: `lifecycle:${w.id}`, phase: 'Lifecycle', schema: LIFECYCLE_SCHEMA }
  ),

  // STAGE 2 — PM-side adversarial verify: re-run the worker's evidence command yourself.
  // Returns the verify verdict MERGED with the lifecycle summary, because pipeline()
  // only surfaces the final stage's result and the report wants both.
  (life, w) => {
    // `terminal` is authoritative; `done` is DERIVED from it rather than
    // trusted separately, so a confused lifecycle agent returning the
    // schema-valid-but-contradictory {done:true, terminal:"blocked"} can
    // never sneak into the verify lane.
    const finished = !!(life && life.terminal === 'done')
    const carry = {
      done: finished,
      terminal: (life && life.terminal) || 'none',
      timed_out: !!(life && life.timed_out),
      evidence_present: !!(life && life.evidence_present),
      pane: (life && life.pane) || '',   // threaded through to cleanup — it kills by pane, not by session
      started_at: (life && life.started_at) || '',
      wait_sec: Number.isInteger(life && life.wait_sec) ? life.wait_sec : -1,
    }
    if (!finished) {
      // Typed give-up states (TEAM_BLOCKED/TEAM_FAILED) skip the verify lane:
      // there is no claimed success to falsify — the outbox already says what
      // stopped the worker; the PM decides re-dispatch vs unblock.
      return {
        id: w.id, verdict: 'skipped',
        note: !life ? 'lifecycle agent returned nothing'
          : life.terminal === 'blocked' ? 'worker reported TEAM_BLOCKED — read UNVERIFIED/GAPS in its outbox, unblock, re-dispatch'
          : life.terminal === 'failed' ? 'worker reported TEAM_FAILED — read the failing output under EVIDENCE in its outbox'
          : life.timed_out ? 'timed out — no result to verify' : 'worker did not finish',
        ...carry,
      }
    }
    return agent(
      [
        `You are the PM's adversarial verify lane for worker "${w.id}". The worker CLAIMS it finished. Do NOT trust its self-report — verify by re-running its evidence yourself. Read-only judgement; do not edit the worker's files.`,
        ``,
        `Target repo: ${REPO}`,
        `Verification command the worker claims to have run: ${w.verify_cmd || '(none provided)'}`,
        `The worker's outbox:`,
        `<<<OUTBOX`,
        life.outbox || '(empty)',
        `OUTBOX`,
        ``,
        `DO: cd ${REPO}.`,
        `1. TAMPER CHECK FIRST — a gate the worker can rewrite is not a gate. Confirm the worker did not modify the verification itself (git status --porcelain / git diff on the test or check files; or compare against a pristine copy). If the worker changed its own checker or test, the evidence is void: verdict=fail, and say what it rewrote. Do this BEFORE trusting any output.`,
        `2. If a verify command exists, RUN IT yourself and compare its real output to what the outbox pasted. If they disagree, verdict=fail.`,
        `3. If the command can't run or none exists, verdict=unverifiable (say why). Otherwise verdict=pass.`,
        `Keep note to one line: what you ran, whether the checker was untampered, and what it showed.`,
      ].join('\n'),
      { label: `verify:${w.id}`, phase: 'Verify', effort: 'high', schema: VERIFY_SCHEMA }
    ).then(v => ({ ...v, ...carry }))
  }
)

// STAGE 3 — synthesize + cleanup. pipeline() returns the final (verify) stage per worker,
// already merged with its lifecycle summary above.
phase('Report')
const report = WORKERS.map((w, i) => {
  const v = results[i] || { id: w.id, verdict: 'skipped', note: 'no result', done: false, terminal: 'none', timed_out: false, evidence_present: false }
  return {
    id: w.id, stakes: w.stakes || 'normal',
    verdict: v.verdict, done: v.done, terminal: v.terminal || 'none', timed_out: v.timed_out,
    evidence_present: v.evidence_present, note: v.note,
    // Measured, not guessed. brief_bytes is the one dimension of "was the brief
    // too open?" that can be counted rather than argued about.
    started_at: v.started_at || '', wait_sec: Number.isInteger(v.wait_sec) ? v.wait_sec : -1,
    timeout_sec: TIMEOUT, brief_bytes: w.brief.length,
  }
})

// CLEANUP FIRST, then distill. Order is load-bearing: tearing down tmux is the
// step that must always happen, and the KMS write is best-effort by design
// (SKILL.md §9). Sharing one agent would let a failed memory write skip cleanup
// entirely — memory that can break a run is worse than no memory.
const panes = WORKERS.map((w, i) => ({ id: w.id, pane: (results[i] && results[i].pane) || '' }))
let cleanupNote = 'ok'
try {
await agent(
  [
    `Cleanup for a tmux-teams mailbox run: ONE shared automation session, one window per worker — possibly shared with ANOTHER concurrent run, so kill only this run's own windows.`,
    `FOLDER=$(basename "${REPO}" | tr 'A-Z.:_ ' 'a-z----' | tr -s -); S="auto--$FOLDER${RUNID}".`,
    `1. Kill this run's windows by pane id (a worker with pane "" had no window — skip it):`,
    panes.map(p => `   - ${p.id}: ${p.pane ? `tmux kill-window -t "${p.pane}" 2>/dev/null` : '(setup failed — nothing to kill)'}`).join('\n'),
    `2. Kill the session ONLY if just the idle PM shell remains: [ "$(tmux list-windows -t "=$S" 2>/dev/null | wc -l)" -le 1 ] && tmux kill-session -t "=$S" 2>/dev/null. If other windows remain, another run is live — leave the session alone and say so. Never touch any other session (human/manual especially).`,
    `3. Stop every delivery loop — for each worker id: touch "${CTL_BASE}/<id>/stop" 2>/dev/null (expand ~ in that path yourself — a quoted tilde does not expand): ${WORKERS.map(w => w.id).join(', ')}`,
    `Report what you killed.`,
  ].join('\n'),
  { label: 'cleanup', phase: 'Report' }
)
} catch (e) {
  // A failed teardown leaves stray tmux windows — worth reporting, never worth
  // losing the run's verdicts over. The report below is the whole point of the run.
  cleanupNote = `cleanup failed (tmux may need manual teardown): ${e && e.message ? e.message : e}`
}

// DISTILL — record what happened, after cleanup and inside a catch. A KMS failure
// is reported into the run's own output (an absent memory must be visible, not
// silent) and never propagates: the work already shipped and was already verified.
let kmsNote = 'skipped'
try {
  kmsNote = await agent(
    [
      `Record this finished tmux-teams run into the Team KMS. This is best-effort bookkeeping AFTER the work is done — never invent or re-run anything.`,
      `kms.mjs: ${args_.kmsPath || 'locate it next to deliver.sh — <plugin root>/skills/tmux-teams/scripts/kms.mjs ($CLAUDE_PLUGIN_ROOT when invoked from the plugin)'}`,
      ``,
      `REV=$(cd "${REPO}" && git rev-parse --short HEAD 2>/dev/null || echo not-a-git-repo)`,
      `TREE=$(cd "${REPO}" && [ -n "$(git status --porcelain 2>/dev/null)" ] && echo dirty || echo clean)`,
      `For EACH worker below: write its event to a temp file, then run`,
      `  node <kms.mjs> append "${REPO}" <that-temp-file>`,
      ``,
      `Event body — one "key: value" per line, exactly these keys:`,
      `  task_id / worker / transport / repo_rev / tree / terminal / pm_verdict / verify_cmd / lesson`,
      `  started_at / wait_sec / timeout_sec / brief_bytes / evidence_present / timed_out / stakes`,
      `Value rules:`,
      `  - The second row is MEASURED data, copied verbatim from the per-worker line below. Never estimate or round it: a wrong number is worse than the -1 that means "not measured", because nobody can tell it apart from a real one later.`,
      `  - pm_verdict comes from the PM verdict listed below, NOT from the worker's self-report. Map: pass -> pass, fail -> reject, unverifiable|skipped -> unresolved.`,
      `  - RECORD EVERY WORKER — blocked, failed, timed out and PM-rejected included. A store that keeps only successes lies about how the work actually goes.`,
      `  - lesson: ONE line, only if this run taught something reusable about the worker, the brief, or this repo; otherwise "none". Prefer naming why it slipped through: ci-gap | latent-code | workload-gap | incomplete-prior-fix | review-miss | brief-too-open | none.`,
      `  - Do NOT paste raw command output into the event. kms.mjs redacts secrets, but the shortest evidence is the safest.`,
      ``,
      `Workers to record:`,
      ...report.map((r, i) => `  - task_id=${r.id} worker=codex transport=tmux terminal=${r.terminal} pm_verdict=${r.verdict}` +
        ` started_at=${r.started_at || '""'} wait_sec=${r.wait_sec} timeout_sec=${r.timeout_sec} brief_bytes=${r.brief_bytes}` +
        ` evidence_present=${r.evidence_present} timed_out=${r.timed_out} stakes=${r.stakes}` +
        ` verify_cmd=${JSON.stringify(WORKERS[i].verify_cmd || '')} note=${JSON.stringify(r.note || '')}`),
      ``,
      `Return ONE line: the written event paths, or the error if the write failed.`,
    ].join('\n'),
    { label: 'distill', phase: 'Report' }
  )
} catch (e) {
  kmsNote = `kms distill failed (run itself is unaffected): ${e && e.message ? e.message : e}`
}

log(`mailbox-run done: ${report.map(r => `${r.id}=${r.verdict}`).join(', ')} | cleanup: ${String(cleanupNote).split('\n')[0]} | kms: ${String(kmsNote).split('\n')[0]}`)
return { workers: report, raw_outboxes: `${REPO}/.mailbox-out/<id>`, cleanup: cleanupNote, kms: kmsNote }
