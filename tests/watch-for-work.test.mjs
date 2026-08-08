// watch-for-work.test.mjs — what wakes the loop, never who decides.
//
// A tick re-derives the whole board from the ledger, so polling cannot LOSE
// work. What it costs is three full ledger reads per interval whether or not
// anything moved, and up to a full interval of silence between a worker
// finishing and the board noticing.
//
// Two of the three ways work arrives are a file changing under one of two
// directories (a worker's outbox, and a person's ledger append through one of
// the three operator doors). The third is a clock, which no watcher can see —
// which is exactly why the interval stays and this is additive. A missed event
// must cost latency, never correctness, and every test here exists to keep that
// true.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { watchForWork } from '../plugins/tmux-teams/skills/tmux-teams/scripts/loop-runner.mjs'

// A stand-in for `fs.watch` — the real one is not deterministic enough to test
// debouncing with, and driving the callback directly is what makes the timing
// assertions below mean something.
const fakeWatch = () => {
  const opened = []
  const watch = (dir, options, handler) => {
    const entry = { dir, options, handler, closed: false, handlers: {} }
    opened.push(entry)
    // `on` is part of the contract now, not decoration: the real FSWatcher is
    // an EventEmitter and the code attaches an `error` listener to it. A fake
    // without it would pass while the shipped path threw.
    return { on: (name, fn) => { entry.handlers[name] = fn }, close: () => { entry.closed = true } }
  }
  return { watch, opened, fire: (index = 0) => opened[index].handler('change', 'x') }
}

const repoWith = () => {
  const repo = mkdtempSync(join(tmpdir(), 'watch-'))
  mkdirSync(join(repo, '.mailbox-out'), { recursive: true })
  mkdirSync(join(repo, '.tmux-teams', 'work-items'), { recursive: true })
  return repo
}

test('it watches the two directories work actually arrives in', () => {
  const repo = repoWith()
  const fake = fakeWatch()
  const stop = watchForWork(repo, { onChange: () => {}, watch: fake.watch })

  const dirs = fake.opened.map((entry) => entry.dir)
  assert.equal(dirs.length, 2)
  assert.ok(dirs.includes(join(repo, '.mailbox-out')), `outbox not watched: ${dirs.join(', ')}`)
  assert.ok(dirs.includes(join(repo, '.tmux-teams', 'work-items')), `ledger not watched: ${dirs.join(', ')}`)

  // Not persistent, deliberately: the interval is what holds the process open.
  // A watcher that kept it alive on its own would turn a one-shot run into a
  // process that never exits.
  for (const entry of fake.opened) assert.equal(entry.options.persistent, false)
  stop()
})

test('a burst of writes wakes the loop once, not once per file', async () => {
  // A worker writing its outbox, the companion recording liveness and a ledger
  // append land within milliseconds of each other. Three ticks would re-derive
  // the same board three times and pay for it three times.
  const fake = fakeWatch()
  let woke = 0
  const stop = watchForWork(repoWith(), { onChange: () => { woke += 1 }, watch: fake.watch, debounceMs: 20 })

  fake.fire(0); fake.fire(0); fake.fire(1); fake.fire(0)
  assert.equal(woke, 0, 'it must not wake before the burst has settled')

  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(woke, 1, `a four-event burst woke the loop ${woke} times`)
  stop()
})

test('a fresh repo works — the first outbox is exactly what this exists to catch', async () => {
  // The failure an adversarial reviewer found after this shipped, and the one
  // the author had already PROVEN and misread as success. `.mailbox-out` does
  // not exist until the first worker writes an outbox, and this runner is what
  // dispatches that worker — so on every fresh repo the attach failed with
  // ENOENT, was never retried, and the single event source this function exists
  // for was dead for the life of the process. The note made it look handled.
  const repo = mkdtempSync(join(tmpdir(), 'cold-'))   // neither directory exists
  const said = []
  const woke = []
  const stop = watchForWork(repo, { onChange: () => woke.push(1), debounceMs: 30, log: (line) => said.push(line) })
  try {
    assert.deepEqual(said, [], `a fresh repo should need no excuses: ${said.join(' | ')}`)

    // Written repeatedly, not once. `fs.watch` is armed ASYNCHRONOUSLY — on
    // macOS through FSEvents — so a write landing microseconds after the call
    // can be missed, and under full-suite load it was: this test passed alone
    // and went red inside the suite until the retry was added. The property
    // being pinned is that a FRESH repo's outbox directory is watched at all,
    // not that the very first byte is caught. Missing an early event is
    // precisely what the interval backstop exists to cover, so demanding it
    // here would assert something the design does not promise.
    for (let attempt = 0; attempt < 200 && !woke.length; attempt += 1) {
      writeFileSync(join(repo, '.mailbox-out', `task-${attempt}`), 'TEAM_DONE\n')
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    assert.ok(woke.length, "a fresh repo's outbox directory was never watched")
  } finally { stop() }
})

test('a watcher that fails mid-run must not take the process with it', () => {
  // An FSWatcher is an EventEmitter, and an `error` event with NO listener
  // throws — killing the runner and the interval backstop together. That makes
  // a watcher failure worse than having no watcher, which inverts this
  // function's whole safety argument. The try/catch covers only the attach.
  const said = []
  const emitters = []
  const watch = () => {
    const handlers = {}
    const watcher = { on: (name, fn) => { handlers[name] = fn }, close: () => {}, handlers }
    emitters.push(watcher)
    return watcher
  }
  const stop = watchForWork(mkdtempSync(join(tmpdir(), 'err-')), {
    onChange: () => {}, watch, log: (line) => said.push(line),
  })

  assert.equal(emitters.length, 2)
  for (const watcher of emitters) {
    assert.equal(typeof watcher.handlers.error, 'function', 'a watcher shipped with no error listener')
  }
  const error = new Error('gone'); error.code = 'EPERM'
  emitters[0].handlers.error(error)   // would throw and kill the process if unhandled
  assert.equal(said.length, 1, said.join(' | '))
  assert.match(said[0], /stopped watching/)
  assert.match(said[0], /EPERM/)
  assert.match(said[0], /interval still sweeps/)
  stop()
})

test('a directory it cannot watch is a note, never a crash', () => {
  // The reason this test survives the cold-start fix above: creating the
  // directory removes ENOENT, it does not remove every refusal. A platform can
  // still say no — EPERM on a mount that forbids watches, EMFILE when the
  // descriptor table is full. Either way the interval still sweeps, so the
  // honest outcome is a degraded wake-up rather than a dead runner.
  const said = []
  const half = {
    watch: (dir, options, handler) => {
      if (dir.endsWith('.mailbox-out')) { const error = new Error('nope'); error.code = 'EPERM'; throw error }
      return { on: () => {}, close: () => {}, dir, options, handler }
    },
  }
  const stop = watchForWork(repoWith(), { onChange: () => {}, watch: half.watch, log: (line) => said.push(line) })

  assert.equal(said.length, 1, said.join(' | '))
  assert.match(said[0], /not watching/)
  assert.match(said[0], /EPERM/, 'the note has to say WHY, or nobody can fix it')
  assert.match(said[0], /interval still sweeps/, 'and that the loop is degraded, not broken')
  stop()
})

test('stopping closes every watcher and cancels a pending wake', async () => {
  const fake = fakeWatch()
  let woke = 0
  const stop = watchForWork(repoWith(), { onChange: () => { woke += 1 }, watch: fake.watch, debounceMs: 20 })

  fake.fire(0)
  stop()
  await new Promise((resolve) => setTimeout(resolve, 60))

  assert.equal(woke, 0, 'a wake queued before stop() still fired after it')
  for (const entry of fake.opened) assert.equal(entry.closed, true, `${entry.dir} was left open`)
})

test('the two REAL write patterns this system uses both wake it', async () => {
  // The stub above proves the debounce and the degradation; it cannot prove
  // that `fs.watch` fires for the writes this system actually performs. Two
  // patterns matter and neither is a plain overwrite: `ledger-writer.mjs:415`
  // appends in place with `appendFileSync`, and the same module writes some
  // files by rename. A watcher that missed either would leave one of the three
  // event sources silently dead — the interval would still sweep, so nothing
  // would break, and nobody would ever notice the latency had not improved.
  const repo = repoWith()
  const items = join(repo, '.tmux-teams', 'work-items')
  writeFileSync(join(items, 'tok.jsonl'), '{"event":"opened"}\n')

  const woke = []
  const stop = watchForWork(repo, { onChange: () => woke.push(Date.now()), debounceMs: 30 })

  // Waits for the CONDITION, never for a duration. A fixed sleep passed alone
  // and went red inside the full suite the first time this was written — the
  // machine is loaded there and `fs.watch` delivery is not on a clock. A sleep
  // long enough to be safe under load is a slow test; a sleep short enough to
  // be quick is a flake, and this repository has already lost real failures to
  // one dismissed as "a timing thing".
  const wokeAgain = async (from, what) => {
    for (let waited = 0; waited < 5000; waited += 25) {
      if (woke.length > from) return
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    assert.fail(`${what} did not wake the loop within 5s`)
  }

  try {
    const { appendFileSync, renameSync } = await import('node:fs')
    appendFileSync(join(items, 'tok.jsonl'), '{"event":"answered"}\n')
    await wokeAgain(0, 'an in-place ledger append')

    const before = woke.length
    writeFileSync(join(items, '.next.tmp'), '{"event":"withdrawn"}\n')
    renameSync(join(items, '.next.tmp'), join(items, 'next.jsonl'))
    await wokeAgain(before, 'an atomic rename into the ledger directory')

    const beforeOutbox = woke.length
    writeFileSync(join(repo, '.mailbox-out', 'task-1'), 'TEAM_DONE\n')
    await wokeAgain(beforeOutbox, 'a worker writing its outbox')
  } finally { stop() }
})

test('watching is additive — it decides nothing', () => {
  // The whole safety argument in one assertion. `watchForWork` is handed an
  // `onChange` and hands back a closer; it never reads the ledger, never reads
  // the graph, and cannot reach a dispatch decision. If this signature ever
  // grows a way to influence WHAT happens, a missed event stops being a latency
  // problem and starts being a correctness one.
  const repo = repoWith()
  writeFileSync(join(repo, '.tmux-teams', 'work-items', 'tok.jsonl'), '{"broken\n')
  const fake = fakeWatch()

  // A ledger this malformed would fail any reader. Watching it is still fine,
  // because watching reads nothing.
  const stop = watchForWork(repo, { onChange: () => {}, watch: fake.watch })
  assert.equal(fake.opened.length, 2)
  stop()
})
