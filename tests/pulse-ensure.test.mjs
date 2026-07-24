import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PULSE = join(ROOT, 'plugins', 'tmux-teams', 'skills', 'tmux-teams', 'scripts', 'pulse.mjs')

const repo = () => mkdtempSync(join(tmpdir(), 'pulse-ensure-'))
const pidfile = (dir) => join(dir, '.tmux-teams', 'pulse-watch.pid')
const configFile = (dir) => join(dir, '.tmux-teams', 'pulse-watch.config.json')
const sourceId = (path) => `sha256:${createHash('sha256').update(path).digest('hex')}`
const run = (dir, { timeZone = null, deliveryRuntime = null, extraEnv = {} } = {}) => {
  const args = [PULSE, 'ensure', dir, '--interval', '60']
  if (timeZone) args.push('--time-zone', timeZone)
  if (deliveryRuntime) args.push('--delivery-runtime', deliveryRuntime)
  return spawnSync(process.execPath, args, {
  encoding: 'utf8', timeout: 10000,
    env: { ...process.env, PULSE_TIME_ZONE: '', ...extraEnv },
  })
}
const alive = (pid) => {
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))
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
      delivery_loop_source: null,
      delivery_runtime_source: null,
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
    assert.match(changed.stderr, /--delivery-loop, --delivery-runtime, or --time-zone/)
    assert.equal(Number(readFileSync(file, 'utf8').trim()), pid)
    assert.ok(alive(pid), 'mismatch must not replace or stop the existing watcher')
  } finally {
    if (pid) await stop(pid, file)
  }
})

test('ensure forwards delivery runtime input while watcher config stores only its source identity', async () => {
  const dir = repo()
  const file = pidfile(dir)
  const runtimePath = join(dir, 'private-runtime.json')
  writeFileSync(runtimePath, '{}\n')
  let pid
  try {
    const first = run(dir, { deliveryRuntime: runtimePath })
    assert.equal(first.status, 0, first.stderr)
    pid = Number(readFileSync(file, 'utf8').trim())
    assert.ok(alive(pid))
    const configText = readFileSync(configFile(dir), 'utf8')
    const config = JSON.parse(configText)
    assert.equal(config.schema_version, 4)
    assert.equal(config.delivery_runtime_source, sourceId(runtimePath))
    assert.equal(config.delivery_loop_source, null)
    assert.equal(configText.includes(runtimePath), false)

    const same = run(dir, { deliveryRuntime: runtimePath })
    assert.equal(same.status, 0, same.stderr)
    assert.match(same.stdout, /watcher already running/)
  } finally {
    if (pid) await stop(pid, file)
  }
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
