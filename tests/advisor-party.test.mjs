// advisor-party.mjs — seating a saved bmad-party-mode roster in an advisor brief.
//
// Every `*-advisor` skill shells to this one script, so this is the only place
// the three can be held to the same rendering. The resolver is injected: none
// of these tests needs uv, a real bmad-party-mode install, or a subprocess —
// except the last one, which boots the file the way an operator does.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(ROOT, 'plugins', 'tmux-teams', 'skills', 'tmux-teams', 'scripts', 'advisor-party.mjs')
const { resolveParty, renderPartyMandate, main, PARTY_PROBLEMS } = await import(pathToFileURL(SCRIPT).href)

// The shape bmad-party-mode's resolve_party.py returns, copied from a real run
// of `--party code-review-crew` on 2026-08-30 and cut to two members.
const PARTY = {
  active: 'code-review-crew',
  name: 'Code Review Crew',
  members: [
    { code: 'adversary', name: 'Grumbal', icon: '😤', title: 'The Adversary', persona: 'Assumes the code is broken.' },
    { code: 'shipper', name: 'Dana', icon: '🚢', title: 'The Pragmatist', persona: 'Ship the 80%.', capabilities: 'Ranks what is real.' },
  ],
  scene: 'Adversarial code review.',
}

// A fake install: a root that holds scripts/resolve_party.py, so `existsSync`
// passes and the injected runner is what answers.
const fakeInstall = () => {
  const root = mkdtempSync(join(tmpdir(), 'bmad-party-'))
  mkdirSync(join(root, 'scripts'), { recursive: true })
  writeFileSync(join(root, 'scripts', 'resolve_party.py'), '# stand-in\n')
  return root
}

test('a resolved party is rendered with its real names, titles and scene — nothing invented', () => {
  const text = renderPartyMandate(PARTY)
  for (const must of ['Code Review Crew', 'code-review-crew', '😤 Grumbal — The Adversary', '🚢 Dana — The Pragmatist',
    'Assumes the code is broken.', 'Ship the 80%. Ranks what is real.', 'Scene: Adversarial code review.']) {
    assert.ok(text.includes(must), `the mandate lost "${must}"`)
  }
  // The line the default mandate uses must NOT survive here: a brief carrying
  // both "use exactly this cast" and "cast 3-5 named voices" contradicts itself.
  assert.ok(!/Cast 3-5 named voices/.test(text), 'the rendered mandate still invites an invented cast')
  assert.match(text, /add no one and rename no one/, 'the mandate does not forbid renaming a saved voice')
  assert.match(text, /could not verify/, 'the mandate dropped the uncertainty instruction the default carries')
})

test('an unknown party is refused with the ids that do exist, and nothing is rendered', () => {
  const root = fakeInstall()
  try {
    const run = () => ({ stdout: JSON.stringify({ error: 'unknown_group', requested: 'nope', available: [{ id: 'a' }, { id: 'b' }] }) })
    const result = resolveParty('nope', { env: { BMAD_PARTY_MODE_ROOT: root }, run })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'unknown_party')
    assert.deepEqual(result.available, ['a', 'b'], 'the operator is not told which parties exist')

    const err = []
    const code = main(['nope'], { env: { BMAD_PARTY_MODE_ROOT: root }, run, out: () => assert.fail('rendered a mandate for an unknown party'), err: m => err.push(m) })
    assert.equal(code, 2)
    assert.match(err.join('\n'), /unknown_party/)
    assert.match(err.join('\n'), /available: a, b/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a missing install and a missing uv are told apart, and both refuse rather than improvise', () => {
  const nowhere = resolveParty('x', { env: { BMAD_PARTY_MODE_ROOT: '/definitely/nonexistent' }, run: () => assert.fail('ran uv with no install') })
  assert.equal(nowhere.code, 'not_installed')
  assert.match(PARTY_PROBLEMS.not_installed, /separate|not installed/i)

  const root = fakeInstall()
  try {
    const noUv = resolveParty('x', { env: { BMAD_PARTY_MODE_ROOT: root }, run: () => ({ error: { code: 'ENOENT' }, stdout: '' }) })
    assert.equal(noUv.code, 'uv_missing')
    const garbage = resolveParty('x', { env: { BMAD_PARTY_MODE_ROOT: root }, run: () => ({ stdout: 'not json' }) })
    assert.equal(garbage.code, 'resolver_failed')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the happy path prints exactly the rendered mandate and exits 0', () => {
  const root = fakeInstall()
  try {
    const out = []
    const code = main(['code-review-crew', '--project-root', '/somewhere'], {
      env: { BMAD_PARTY_MODE_ROOT: root },
      run: (cmd, args) => {
        assert.equal(cmd, 'uv')
        assert.ok(args.includes('--party') && args.includes('code-review-crew'), 'the party id never reached the resolver')
        assert.ok(args.includes('/somewhere'), 'the project root never reached the resolver')
        return { stdout: JSON.stringify(PARTY) }
      },
      out: m => out.push(m), err: m => assert.fail(`wrote to stderr on success: ${m}`),
    })
    assert.equal(code, 0)
    assert.equal(out.join('\n'), renderPartyMandate(PARTY))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// A boot path is tested only by booting it, from a directory with a space.
test('invoked directly, the script refuses a missing id with usage and exit 1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'advisor party '))
  try {
    const r = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8' })
    assert.equal(r.status, 1, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`)
    assert.match(r.stderr, /usage: node advisor-party\.mjs <party-id>/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
