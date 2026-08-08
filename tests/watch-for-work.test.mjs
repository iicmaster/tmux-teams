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
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
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
  const stop = watchForWork(repo, { onChange: () => {}, debounceMs: 30, log: (line) => said.push(line) })
  try {
    // The assertion is that the ATTACH succeeded, which is precisely what was
    // broken: `.mailbox-out` did not exist, `watch` threw ENOENT, the note made
    // it look handled, and nothing ever retried. A note here means the watcher
    // is not attached at all.
    assert.deepEqual(said, [], `a fresh repo should need no excuses: ${said.join(' | ')}`)
    assert.ok(existsSync(join(repo, '.mailbox-out')), 'the outbox directory was not created before watching')
    assert.ok(existsSync(join(repo, '.tmux-teams', 'work-items')), 'the ledger directory was not created before watching')

    // Event DELIVERY is asserted by the real-write test below, on directories
    // that already exist. It is deliberately not asserted here: this test
    // failed on Linux CI while that one passed, and the difference is a
    // directory created microseconds before being watched — kernel and
    // filesystem behaviour this module does not own and cannot promise. What it
    // owns is that the attach happens; a delivery that never comes costs
    // latency, which is exactly what the interval backstop is for.
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

// Does `fs.watch` deliver at all here? On this repository's CI it does not —
// a container filesystem, 200 writes over five seconds, no event. That is not a
// defect in `watchForWork` and not something it can promise: the interval
// backstop exists precisely because delivery is a platform property, and a
// missed event costs latency rather than correctness.
//
// So the delivery test is skipped LOUDLY where delivery is impossible, instead
// of being deleted (it is the only proof the real patterns work) or left to
// fail (which is how a suite teaches people to ignore it). The probe is a
// measurement, not an assumption about the platform name.
const deliversFsEvents = async (pattern) => {
  const probe = mkdtempSync(join(tmpdir(), 'probe-'))
  const target = join(probe, 'existing.jsonl')
  writeFileSync(target, 'first\n')
  let fired = false
  const { watch, appendFileSync } = await import('node:fs')
  let watcher
  try { watcher = watch(probe, { persistent: false }, () => { fired = true }) } catch { return false }
  const perform = pattern === 'append'
    ? (n) => appendFileSync(target, `line-${n}\n`)
    : (n) => writeFileSync(join(probe, `new-${n}.jsonl`), 'x\n')
  try {
    // An IN-PLACE APPEND to a file that already exists — the weakest of the
    // three patterns and the one the ledger actually uses
    // (`ledger-writer.mjs`). The first version of this probe created NEW files
    // and answered "yes" on a CI where creation is reported and appending is
    // not, so the probe passed and the test it guards still failed. A probe
    // that does not perform the operation it is vouching for proves nothing.
    // Same shape as `wokeAgain` below: write a few, then let it settle. There is
    // no debounce in this probe, but a probe whose timing differs from the test
    // it guards can answer a question the test is not asking.
    for (let round = 0; round < 8 && !fired; round += 1) {
      for (let attempt = 0; attempt < 3; attempt += 1) perform(`${round}-${attempt}`)
      for (let waited = 0; waited < 250 && !fired; waited += 25) {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    }
  } finally { try { watcher.close() } catch { /* already gone */ } }
  return fired
}

test('the REAL write patterns this system uses wake it', async (t) => {
  // Each pattern is probed on its OWN terms. The first version probed only an
  // in-place append and skipped the WHOLE test when that failed — including the
  // rename and new-file assertions, which the very same change had recorded as
  // WORKING on that CI. It also announced "fs.watch delivers no events", which
  // was false there. A release reviewer caught both: a skip that hides a
  // capability the author already measured, behind a message that misstates the
  // platform.
  const canAppend = await deliversFsEvents('append')
  const canCreate = await deliversFsEvents('create')
  if (!canAppend && !canCreate) {
    t.skip('fs.watch delivered nothing for either an append or a new file here'
      + ' — the interval backstop is what covers this environment')
    return
  }
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
  // Retries the WRITE, not just the wait. `fs.watch` is armed asynchronously —
  // FSEvents on macOS — so under full-suite load a write can land before the
  // watcher is listening, and polling alone then waits five seconds for an event
  // that was never going to come. Both this and the cold-start test above learned
  // that the same way: green alone, red inside the suite.
  // Writes a few times, then STOPS and lets the debounce settle. Both halves are
  // load-bearing and each was learned from a red run:
  //
  // - retrying the write covers `fs.watch` being armed asynchronously, which is
  //   why a single write can land before anyone is listening;
  // - stopping covers the debounce. The first version wrote every 25ms against a
  //   30ms debounce, so every write RESET the timer and it could never fire —
  //   a test that starved the thing it was measuring. It passed on macOS, where
  //   FSEvents batches with gaps wide enough to slip through, and failed on
  //   Linux CI. Two commits blamed the CI filesystem before the arithmetic was
  //   read.
  const wokeAgain = async (from, what, write) => {
    for (let round = 0; round < 20; round += 1) {
      for (let attempt = 0; attempt < 3; attempt += 1) write(round * 3 + attempt)
      for (let waited = 0; waited < 250; waited += 25) {
        await new Promise((resolve) => setTimeout(resolve, 25))
        if (woke.length > from) return
      }
    }
    assert.fail(`${what} never woke the loop`)
  }

  try {
    const { appendFileSync, renameSync } = await import('node:fs')

    // The ledger append — `ledger-writer.mjs:415`, every operator door. Only
    // asserted where an in-place append is deliverable at all; on a filesystem
    // that reports creation but not appends the interval is what covers this,
    // and the contract says so.
    if (canAppend) {
      await wokeAgain(woke.length, 'an in-place ledger append',
        () => appendFileSync(join(items, 'tok.jsonl'), '{"event":"answered"}\n'))
    }

    // Rename and new-file both count as creation in a watched directory, so
    // they stand or fall with `canCreate` — and they are NOT skipped just
    // because appends are unreported, which was the defect in the first probe.
    if (canCreate) {
      await wokeAgain(woke.length, 'an atomic rename into the ledger directory', (n) => {
        writeFileSync(join(items, `.next-${n}.tmp`), '{"event":"withdrawn"}\n')
        renameSync(join(items, `.next-${n}.tmp`), join(items, `next-${n}.jsonl`))
      })

      await wokeAgain(woke.length, 'a worker writing its outbox',
        (n) => writeFileSync(join(repo, '.mailbox-out', `task-${n}`), 'TEAM_DONE\n'))
    }

    assert.ok(woke.length, 'no pattern woke the loop despite the probe saying one would')
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
