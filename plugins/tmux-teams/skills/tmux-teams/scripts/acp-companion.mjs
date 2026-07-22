// acp-companion.mjs — ACP transport lane for the tmux-teams mailbox contract.
// Drives an ACP-speaking agent (gemini, claude) with the same brief+contract
// the tmux lane uses; the worker writes the same .mailbox-out/<id> outbox, so
// every verification layer above (typed markers, tamper-check, PM verify) is
// shared between transports.
//
// usage: node acp-companion.mjs <agent> <cwd> <task-id> <brief-file> [timeout-sec]
//   agent: gemini | claude | codex | agy   (or set ACP_CMD="custom command" to override)
//   env ACP_RESUME=<sessionId>: continue an earlier turn instead of starting a
//     new session — carries full context across the otherwise one-shot mailbox
//     brief (needs the agent to advertise loadSession; falls back to a fresh
//     session with a warning if it does not). The session id is printed as
//     `[session] <id>` and stored per task-id under .tmux-teams/sessions/.
//
// Lanes (2026-07-21):
//   gemini -> `gemini --acp`                       (native; product-gated, see SKILL.md §8)
//   claude -> `npx -y @agentclientprotocol/claude-agent-acp` (official adapter,
//             successor to the zed-industries build — Task-tool subagents
//             allowed, effort via MAX_THINKING_TOKENS env)
//   codex  -> `npx -y @agentclientprotocol/codex-acp` — the NEW official
//             adapter (Codex App Server-based): it drives the INSTALLED codex
//             CLI, so the frontier model + ultra effort work as-is
//             (e2e-verified 2026-07-19 on gpt-5.6-sol). The old
//             zed-industries binary embedded a stale core; codexGuard below
//             still maps its failure signatures to a clear message in case a
//             legacy build is forced via ACP_CMD.
//   agy    -> `bunx antigravity-acp@1.0.0` — COMMUNITY adapter (shubzkothekar),
//             version-pinned to the source-audited release (audit 2026-07-21:
//             no credential handling, single network call = official Google
//             release download with SHA-256 pin; e2e-verified same day).
//             Requires bun on PATH. AGY_SKIP_DOWNLOAD=1 is set below so the
//             installed `agy` on PATH is always used (the adapter's pinned
//             auto-download 404s upstream). ToS note: third-party tools
//             driving an OAuth-authed agy breach Google's Antigravity terms —
//             same pattern-level risk as the tmux lane; see SKILL.md §8.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const [agentName, cwd, taskId, briefFile, timeoutArg] = process.argv.slice(2)
if (!agentName || !cwd || !taskId || !briefFile) {
  console.error('usage: node acp-companion.mjs <gemini|claude|codex|agy> <cwd> <task-id> <brief-file> [timeout-sec]')
  process.exit(2)
}
const ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/
if (!ID_RE.test(taskId)) {
  console.error(`invalid task id "${taskId}" — 1-64 chars, alphanumeric/_/-, starts alphanumeric or _`)
  process.exit(2)
}
const TIMEOUT_MS = (Number(timeoutArg) > 0 ? Number(timeoutArg) : 600) * 1000
const brief = readFileSync(briefFile, 'utf8')
// Deterministic preamble: the contract is self-carrying even if the brief has
// a placeholder id or omits the outbox rules (issue #2).
const preamble =
  `Your task-id is ${taskId}. Write your outbox to .mailbox-out/${taskId} — ` +
  `a single flat FILE (do NOT create it as a directory). Its last line must be exactly: ` +
  `TEAM_DONE ${taskId} (or TEAM_BLOCKED ${taskId} / TEAM_FAILED ${taskId}).\n\n---\n\n`

const CMDS = {
  gemini: ['gemini', ['--acp']],
  claude: ['npx', ['-y', '@agentclientprotocol/claude-agent-acp']],
  codex: ['npx', ['-y', '@agentclientprotocol/codex-acp']],
  agy: ['bunx', ['antigravity-acp@1.0.0']],
}
let cmd
if (process.env.ACP_CMD) {
  const parts = process.env.ACP_CMD.split(/\s+/)
  cmd = [parts[0], parts.slice(1)]
} else if (CMDS[agentName]) {
  cmd = CMDS[agentName]
} else {
  console.error(`unknown agent "${agentName}" — use gemini|claude|codex|agy or set ACP_CMD`)
  process.exit(2)
}
// agy: always drive the installed `agy` (PATH/$AGY_BIN); the adapter's pinned
// auto-download 404s upstream, so skip it unless the user overrides.
const spawnEnv = agentName === 'agy'
  ? { ...process.env, AGY_SKIP_DOWNLOAD: process.env.AGY_SKIP_DOWNLOAD ?? '1' }
  : process.env

// detached => agent leads its own process group, so killTree reaches
// grandchildren (npx -> adapter -> CLI -> build tools); issue #3.
// Dispatch record (SKILL.md §10) — the same footprint the tmux lane writes, so
// a worker that dies before producing anything is still visible as a run that
// happened. A live test proved this lane was observable ONLY while alive: with
// no footprint, dying mid-run erased it completely, which is precisely the
// failure the live view exists to catch. No pane here, so that field is omitted
// and the view falls back to its time window.
try {
  const dispatchDir = join(cwd, '.tmux-teams', 'dispatch')
  mkdirSync(dispatchDir, { recursive: true })
  const ignore = join(cwd, '.tmux-teams', '.gitignore')
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n')
  writeFileSync(join(dispatchDir, `${taskId}.md`),
    `task_id: ${taskId}\nworker: ${agentName}\ntransport: acp\n` +
    `started_at: ${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}\ntimeout_sec: ${TIMEOUT_MS / 1000}\n`)
} catch (e) {
  // Best-effort, like the memory it feeds: never fail a dispatch over
  // bookkeeping — but say so, because a silent gap here is invisible later.
  console.error(`[warn] could not write dispatch record: ${e.message}`)
}

const agent = spawn(cmd[0], cmd[1], { cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: true, env: spawnEnv })
function killTree(sig = 'SIGTERM') {
  try { process.kill(-agent.pid, sig) } catch { try { agent.kill(sig) } catch {} }
}
let stderrBuf = ''
agent.stderr.on('data', (d) => { stderrBuf += d; process.stderr.write(`[agent-err] ${d}`) })
agent.on('error', (e) => { console.error(`[fatal] cannot spawn ${cmd[0]}: ${e.message}`); process.exit(1) })
agent.on('exit', (code) => {
  if (timedOut) return // let the timeout handler finish the SIGKILL escalation
  if (!finished) {
    codexGuard(stderrBuf)
    console.error(`[fatal] agent exited early (code ${code})`)
    process.exit(1)
  }
})

// Known codex-acp version-lag signatures -> actionable message.
function codexGuard(text) {
  if (/unknown variant `ultra`/.test(text) || /requires a newer version of Codex/.test(text)) {
    console.error(
      '[codex-acp guard] this failure signature means a DEPRECATED zed-industries codex-acp ' +
      'build (stale embedded core) handled the session. Use the official App Server adapter ' +
      'instead — `npx -y @agentclientprotocol/codex-acp` (the default here) — which drives ' +
      'the installed codex CLI and supports the current frontier model.'
    )
  }
}

let nextId = 1
let finished = false
const pending = new Map()
function request(method, params) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    agent.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}
function respond(id, result) {
  agent.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
}

const rl = createInterface({ input: agent.stdout })
rl.on('line', (line) => {
  if (!line.trim()) return
  let msg
  try { msg = JSON.parse(line) } catch { return }

  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
    return
  }
  if (msg.id !== undefined && msg.method) {
    if (msg.method === 'session/request_permission') {
      const opts = msg.params?.options ?? []
      const pick = opts.find(o => o.kind === 'allow_always') ?? opts.find(o => o.kind === 'allow_once') ?? opts[0]
      line(`[permission] ${msg.params?.toolCall?.title ?? '?'} -> ${pick?.name ?? pick?.optionId}`)
      respond(msg.id, { outcome: { outcome: 'selected', optionId: pick.optionId } })
    } else {
      agent.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `not supported: ${msg.method}` } }) + '\n')
    }
    return
  }
  if (msg.method === 'session/update') render(msg.params?.update)
})

// Live view: render the text, tool, and plan updates that explain what the agent
// is doing. `mode` tracks both stream kind and message id so replayed history
// keeps user/agent turns distinct while chunks of one message stay together.
let mode = null
function say(kind, text, messageId) {
  const nextMode = `${kind}:${messageId ?? ''}`
  if (mode !== nextMode) {
    if (mode !== null) process.stdout.write('\n')
    process.stdout.write(`[${kind}] `)
    mode = nextMode
  }
  process.stdout.write(text)
}
function line(s) {
  if (mode !== null) process.stdout.write('\n')
  mode = null
  console.log(s)
}
const planMark = { completed: '✓', in_progress: '▶', pending: '◯' }
function render(u) {
  switch (u?.sessionUpdate) {
    case 'user_message_chunk': if (u.content?.type === 'text') say('user', u.content.text, u.messageId); break
    case 'agent_message_chunk': if (u.content?.type === 'text') say('say', u.content.text, u.messageId); break
    case 'agent_thought_chunk': if (u.content?.type === 'text') say('think', u.content.text, u.messageId); break
    case 'tool_call':
      line(`[tool] ${u.kind ? u.kind + ' · ' : ''}${u.title ?? u.toolCallId ?? ''}${u.status ? ` (${u.status})` : ''}`); break
    case 'tool_call_update':
      if (u.status) line(`[tool] ${u.title ?? u.toolCallId ?? ''} → ${u.status}`); break
    case 'plan':
      line(`[plan] ${(u.entries ?? []).map(e => `${planMark[e.status] ?? '◯'} ${e.content}`).join('  ')}`); break
  }
}

let timedOut = false
const deadline = setTimeout(() => {
  timedOut = true
  console.error(`\n[timeout ${TIMEOUT_MS / 1000}s] — worker did not finish; no auto-retry (PM decides)`)
  killTree('SIGTERM')
  setTimeout(() => { killTree('SIGKILL'); process.exit(1) }, 5000)
}, TIMEOUT_MS)

// Resume target: an explicit ACP_RESUME wins; otherwise a session id stored for
// THIS task-id (a retry, or a deliberate re-dispatch of the same id) is resumed.
// A follow-up under a NEW id continues an earlier turn by passing that turn's
// printed session id as ACP_RESUME — the mailbox brief is otherwise one-shot,
// so cross-turn context is opt-in, never implicit.
const sessionsDir = join(cwd, '.tmux-teams', 'sessions')
const sessionFile = join(sessionsDir, taskId)
let resumeId = process.env.ACP_RESUME?.trim() ?? ''
if (!resumeId && existsSync(sessionFile)) {
  try { resumeId = readFileSync(sessionFile, 'utf8').trim() }
  catch (e) { console.error(`[warn] could not read persisted session id: ${e.message}; starting fresh`) }
}

try {
  const init = await request('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  })
  // session/load only exists if the agent advertises loadSession; never assume
  // it (the field is optional and the method is not yet frozen in the spec).
  const canLoad = init?.agentCapabilities?.loadSession === true

  let sessionId
  if (resumeId && canLoad) {
    line(`[resume] loading ${resumeId} — the agent will replay its history below`)
    try {
      await request('session/load', { sessionId: resumeId, cwd, mcpServers: [] })
      sessionId = resumeId
      line(`[resume] history restored — continuing this session`)
    } catch (e) {
      console.error(`[resume] session/load failed (${e.message}); starting a fresh session`)
    }
  } else if (resumeId && !canLoad) {
    console.error(`[resume] ${agentName} does not advertise loadSession — cannot resume ${resumeId}; starting fresh`)
  }
  if (!sessionId) {
    const sess = await request('session/new', { cwd, mcpServers: [] })
    sessionId = sess.sessionId
  }
  line(`[session] ${sessionId}`)
  // Persist so a later same-id dispatch — or a follow-up passing this as
  // ACP_RESUME — can continue. Best-effort: a run must never fail over this.
  try { mkdirSync(sessionsDir, { recursive: true }); writeFileSync(sessionFile, sessionId + '\n') }
  catch (e) { console.error(`[warn] could not persist session id: ${e.message}`) }

  const res = await request('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: preamble + brief }],
  })
  finished = true
  line(`[turn done] stopReason=${res.stopReason}`)
} catch (e) {
  codexGuard(e.message + stderrBuf)
  console.error(`[fatal] ${e.message}`)
  finished = true
  clearTimeout(deadline); killTree(); process.exit(1)
}
clearTimeout(deadline)
killTree()

// Same completion semantics as the tmux lane's WAIT step: the outbox's LAST
// non-empty line must be exactly one terminal marker for this id.
const outboxPath = join(cwd, '.mailbox-out', taskId)
if (!existsSync(outboxPath)) {
  console.error(`[no-outbox] worker finished the turn but wrote no ${outboxPath} — treat as not-done; inspect its final message above`)
  process.exit(3)
}
// Some agents mkdir the outbox path and write a file inside (issue #1):
// tolerate exactly one file; anything else is a clear exit 3, never a crash.
let outboxFile = outboxPath
if (statSync(outboxPath).isDirectory()) {
  const entries = readdirSync(outboxPath).filter(f => statSync(join(outboxPath, f)).isFile())
  if (entries.length !== 1) {
    console.error(`[no-outbox] ${outboxPath} is a directory with ${entries.length} files — expected a single flat file`)
    process.exit(3)
  }
  outboxFile = join(outboxPath, entries[0])
  console.log(`[outbox] warning: worker wrote outbox as a directory; validating ${entries[0]} inside it`)
}
const lines = readFileSync(outboxFile, 'utf8').split('\n').map(s => s.trim()).filter(Boolean)
const last = lines[lines.length - 1] ?? ''
const terminal =
  last === `TEAM_DONE ${taskId}` ? 'done' :
  last === `TEAM_BLOCKED ${taskId}` ? 'blocked' :
  last === `TEAM_FAILED ${taskId}` ? 'failed' : 'invalid'
console.log(`[outbox] ${outboxFile}`)
console.log(`[terminal] ${terminal}${terminal === 'invalid' ? ` (last line: "${last}")` : ''}`)
process.exit(terminal === 'invalid' ? 3 : 0)
