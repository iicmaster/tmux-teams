import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PULSE = join(ROOT, 'plugins', 'tmux-teams', 'skills', 'tmux-teams', 'scripts', 'pulse.mjs')

const repo = () => mkdtempSync(join(tmpdir(), 'pulse-ensure-'))
const pidfile = (dir) => join(dir, '.tmux-teams', 'pulse-watch.pid')
const run = (dir) => spawnSync(process.execPath, [PULSE, 'ensure', dir, '--interval', '60'], {
  encoding: 'utf8', timeout: 10000,
})
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

    const second = run(dir)
    assert.equal(second.status, 0, second.stderr)
    assert.match(second.stdout, /watcher already running/)
    assert.equal(Number(readFileSync(file, 'utf8').trim()), pid)
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
