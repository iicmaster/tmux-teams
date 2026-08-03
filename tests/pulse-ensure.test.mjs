import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PULSE = join(ROOT, 'plugins', 'tmux-teams', 'skills', 'tmux-teams', 'scripts', 'pulse.mjs')

const TEMP_REPOS = new Set()
const repo = () => {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-ensure-'))
  TEMP_REPOS.add(dir)
  return dir
}
const pidfile = (dir) => join(dir, '.tmux-teams', 'pulse-watch.pid')
const configFile = (dir) => join(dir, '.tmux-teams', 'pulse-watch.config.json')
const run = (dir, { interval = 60, timeZone = null, teamGraph = null, teamRuntime = null, extraEnv = {} } = {}) => {
  const args = [PULSE, 'ensure', dir, '--interval', String(interval)]
  if (timeZone) args.push('--time-zone', timeZone)
  if (teamGraph) args.push('--team-graph', teamGraph)
  if (teamRuntime) args.push('--team-runtime', teamRuntime)
  return spawnSync(process.execPath, args, {
  encoding: 'utf8', timeout: 10000,
    env: { ...process.env, PULSE_TIME_ZONE: '', ...extraEnv },
  })
}
const alive = (pid) => {
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))

test.afterEach(async () => {
  for (const dir of [...TEMP_REPOS]) {
    TEMP_REPOS.delete(dir)
    const file = pidfile(dir)
    try {
      const pid = Number(readFileSync(file, 'utf8').trim())
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 'SIGTERM') } catch { /* already stopped */ }
        for (let i = 0; i < 40 && alive(pid); i++) await delay(25)
      }
    } catch { /* repository may already be cleaned by the test */ }
    rmSync(dir, { recursive: true, force: true })
  }
})

async function stop(pid, file) {
  try { process.kill(pid, 'SIGTERM') } catch { /* already stopped */ }
  for (let i = 0; i < 40 && alive(pid); i++) await delay(25)
  assert.equal(alive(pid), false, `watcher ${pid} did not stop`)
  for (let i = 0; i < 20 && existsSync(file); i++) await delay(25)
  assert.equal(existsSync(file), false, 'watcher did not clean its pidfile')
}

test('ensure renders now and reuses one detached watcher for the repo', async () => {
  const dir = repo()
  const file = pidfile(dir)
  let pid
  try {
    const first = run(dir)
    assert.equal(first.status, 0, first.stderr)
    assert.match(first.stdout, /pulse\.html/)
    assert.match(first.stdout, /watcher started pid/)
    pid = Number(readFileSync(file, 'utf8').trim())
    assert.ok(alive(pid), `watcher ${pid} is not alive`)
    assert.equal(JSON.parse(readFileSync(configFile(dir), 'utf8')).time_zone, 'Asia/Bangkok')

    const second = run(dir)
    assert.equal(second.status, 0, second.stderr)
    assert.match(second.stdout, /watcher already running/)
    assert.equal(Number(readFileSync(file, 'utf8').trim()), pid)
  } finally {
    if (pid) await stop(pid, file)
  }
})

test('ensure reuses only a watcher with the same canonical timezone', async () => {
  const dir = repo()
  const file = pidfile(dir)
  let pid
  try {
    const first = run(dir, { timeZone: 'US/Eastern' })
    assert.equal(first.status, 0, first.stderr)
    pid = Number(readFileSync(file, 'utf8').trim())
    assert.ok(alive(pid))
    assert.deepEqual(JSON.parse(readFileSync(configFile(dir), 'utf8')), {
      pid,
      schema_version: 4,
      team_graph_source: null,
      team_runtime_source: null,
      time_zone: 'America/New_York',
    })
    const same = run(dir, { extraEnv: { PULSE_TIME_ZONE: 'America/New_York' } })
    assert.equal(same.status, 0, same.stderr)
    assert.match(same.stdout, /watcher already running/)
    assert.equal(Number(readFileSync(file, 'utf8').trim()), pid)
    const configBefore = readFileSync(configFile(dir), 'utf8')
    const htmlFile = join(dir, '.tmux-teams', 'pulse.html')
    const htmlBefore = readFileSync(htmlFile, 'utf8')

    const invalid = run(dir, { timeZone: 'Invalid/Zone' })
    assert.equal(invalid.status, 2)
    assert.match(invalid.stderr, /invalid time zone/)
    assert.equal(Number(readFileSync(file, 'utf8').trim()), pid)
    assert.equal(readFileSync(configFile(dir), 'utf8'), configBefore)
    assert.equal(readFileSync(htmlFile, 'utf8'), htmlBefore)
    assert.ok(alive(pid), 'invalid input must not replace or stop the existing watcher')

    const changed = run(dir, { timeZone: 'UTC' })
    assert.equal(changed.status, 1)
    assert.match(changed.stderr, /watcher mode\/input mismatch/)
    assert.match(changed.stderr, /--team-graph, --team-runtime, or --time-zone/)
    assert.equal(Number(readFileSync(file, 'utf8').trim()), pid)
    assert.ok(alive(pid), 'mismatch must not replace or stop the existing watcher')
  } finally {
    if (pid) await stop(pid, file)
  }
})

// The `--delivery-runtime` ensure test lived here. It asserted that an opt-in
// projection path is forwarded to the detached watcher while the config records
// only a digest of the path, never the path itself. The flag is gone, and the
// claim survives unchanged one test down: `--team-runtime` makes the same
// forwarding-and-privacy assertion, and the timezone test above still proves an
// unconfigured source is recorded as null.
test('ensure identity includes the team runtime content digest and forwards its path privately', async () => {
  const dir = repo()
  const file = pidfile(dir)
  const runtimePath = join(dir, 'private-team-runtime.json')
  writeFileSync(runtimePath, '{"controller":"evidence"}\n')
  let pid
  try {
    const first = run(dir, { teamRuntime: runtimePath })
    assert.equal(first.status, 0, first.stderr)
    pid = Number(readFileSync(file, 'utf8').trim())
    assert.ok(alive(pid))
    const configText = readFileSync(configFile(dir), 'utf8')
    const config = JSON.parse(configText)
    assert.equal(config.team_runtime_source,
      `sha256:${createHash('sha256').update(readFileSync(runtimePath)).digest('hex')}`)
    assert.equal(configText.includes(runtimePath), false)
    const same = run(dir, { teamRuntime: runtimePath })
    assert.equal(same.status, 0, same.stderr)
    assert.match(same.stdout, /watcher already running/)
  } finally {
    if (pid) await stop(pid, file)
  }
})

test('ensure identity includes the team graph content digest', async () => {
  const dir = repo()
  const file = pidfile(dir)
  const graphPath = join(dir, 'graph.json')
  writeFileSync(graphPath, JSON.stringify({
    graph: {
      project_id: 'ensure-graph',
      teams: [{
        team_id: 'alpha',
        dispatcher_id: 'dispatcher-a',
        worker_ids: ['worker-a'],
        evaluator_id: 'evaluator-a',
        downstream_team_id: null,
      }],
    },
  }))
  let pid
  try {
    const first = run(dir, { teamGraph: graphPath })
    assert.equal(first.status, 0, first.stderr)
    pid = Number(readFileSync(file, 'utf8').trim())
    const config = JSON.parse(readFileSync(configFile(dir), 'utf8'))
    assert.equal(config.team_graph_source,
      `sha256:${createHash('sha256').update(readFileSync(graphPath)).digest('hex')}`)
    assert.equal(JSON.stringify(config).includes(graphPath), false)

    const same = run(dir, { teamGraph: graphPath })
    assert.equal(same.status, 0, same.stderr)
    assert.match(same.stdout, /watcher already running/)
  } finally {
    if (pid) await stop(pid, file)
  }
})

// ISSUE #25. A pid is not a credential. The pidfile is world-readable and the
// operator is already looking at it, so handing the live pid back in
// PULSE_WATCH_CLAIM_OWNER was accepted as proof of a handoff: the impostor
// overwrote the pidfile and the watcher it named exited at its next tick. The
// claim may now pass only from a parent to the child it spawned, which the
// kernel attests and a reader of the pidfile cannot forge.
test('watch --managed refuses a claim it was not handed', async () => {
  const dir = repo()
  const file = pidfile(dir)
  const claimant = () => {
    try { return Number(readFileSync(file, 'utf8').trim()) } catch { return null }
  }
  let pid
  try {
    const started = run(dir, { interval: 1 })
    assert.equal(started.status, 0, started.stderr)
    pid = claimant()
    assert.ok(alive(pid), `watcher ${pid} is not alive`)

    // The pre-fix exploit input, verbatim, and it has to be inert. The config
    // inputs must match run()'s or the mode/input branch would refuse this for
    // an unrelated reason and the test would prove nothing.
    const impostor = spawnSync(process.execPath,
      [PULSE, 'watch', dir, '--interval', '60', '--managed'], {
        encoding: 'utf8', timeout: 3000,
        env: { ...process.env, PULSE_TIME_ZONE: '', PULSE_WATCH_CLAIM_OWNER: String(pid) },
      })
    assert.equal(claimant(), pid, 'a process that only READ the pid took the claim')
    assert.equal(impostor.status, 1, impostor.stdout)
    assert.match(impostor.stderr, /pulse\.mjs ensure/)

    // The reported harm, not just its cause: the named watcher exits on the
    // next tick that finds the pidfile no longer its own. --interval 1 puts
    // that tick inside this wait.
    await delay(2500)
    assert.ok(alive(pid), `watcher ${pid} was evicted by a bystander`)
    assert.equal(claimant(), pid)
  } finally {
    if (pid) { try { process.kill(pid, 'SIGTERM') } catch { /* already stopped */ } }
  }
})

// ISSUE #25 as filed. The refusal was true and useless: "watcher claim belongs
// to pid none; refusing duplicate" names no way forward. --managed is not a
// command an operator runs.
test('watch --managed run by hand names the command that performs the handoff', () => {
  const dir = repo()
  const result = spawnSync(process.execPath,
    [PULSE, 'watch', dir, '--interval', '60', '--managed'], {
      encoding: 'utf8', timeout: 3000,
      env: { ...process.env, PULSE_TIME_ZONE: '' },
    })
  assert.equal(result.status, 1, result.stdout)
  assert.match(result.stderr, /pulse\.mjs ensure/)
  assert.equal(existsSync(pidfile(dir)), false, 'a refused handoff must not leave a claim')
})

test('ensure reclaims a stale watcher pidfile', async () => {
  const dir = repo()
  const file = pidfile(dir)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, '2147483647\n')
  let pid
  try {
    const result = run(dir)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /watcher started pid/)
    pid = Number(readFileSync(file, 'utf8').trim())
    assert.notEqual(pid, 2147483647)
    assert.ok(alive(pid))
  } finally {
    if (pid) await stop(pid, file)
  }
})

// The hand-run case is covered above. This is its second shape, which a missing
// pidfile does not reach: killing a watcher can leave the file behind EMPTY, and
// `watcherPid()` reads null for both "no file" and "empty file". A claim this
// process was never handed must not be taken on the way out either — the file
// has to still be empty afterwards, not merely absent.
test('an empty pidfile is not a claim a hand-run --managed watch may take', () => {
  const dir = repo()
  const file = pidfile(dir)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, '')

  const result = spawnSync(process.execPath,
    [PULSE, 'watch', dir, '--interval', '20', '--managed'],
    { encoding: 'utf8', timeout: 10000, env: { ...process.env, PULSE_TIME_ZONE: '' } })

  assert.equal(result.status, 1, result.stdout)
  assert.match(result.stderr, /pulse\.mjs ensure/)
  assert.equal(readFileSync(file, 'utf8'), '', 'a refused handoff claimed the pidfile anyway')
})
