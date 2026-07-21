// kms.test.mjs — behaviour checks for the Team KMS store (SKILL.md §9).
// Every case runs kms.mjs as a subprocess with HOME pointed at a temp dir, so
// the real store is never touched — each case gets its own temp repo.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const KMS = join(ROOT, 'plugins/tmux-teams/skills/tmux-teams/scripts/kms.mjs')

/** Fresh repo dir per test: the store lives inside the repo, so a new repo IS a
 *  new store. `home` is kept only so a stray $HOME write would be visible. */
function sandbox() {
  const home = mkdtempSync(join(tmpdir(), 'kms-home-'))
  const repo = mkdtempSync(join(tmpdir(), 'kms-repo-'))
  return { home, repo }
}
const run = (home, args, input) =>
  spawnSync('node', [KMS, ...args], { encoding: 'utf8', input, env: { ...process.env, HOME: home } })

const EVENT = [
  'task_id: t1',
  'worker: codex',
  'repo_rev: abc1234',
  'terminal: TEAM_DONE',
  'pm_verdict: pass',
  'verify_cmd: node --test tests/',
  'lesson: bound review briefs or codex burns 15 minutes',
].join('\n')

// Credential-shaped fixtures are BUILT AT RUNTIME, never written as literals:
// a secret scanner cannot tell a test fixture from a leak, and it is right not
// to try. Concatenation keeps the scanned file clean and the values exact.
const FAKE = {
  openai: 'sk-' + 'abcdefghijklmnop0123456789',
  githubPat: 'github_pat_' + '11ABCDEFG0abcdefghijklmnopqrstuv',
  githubClassic: 'gh' + 'p_' + '0123456789abcdefghij',
  aws: 'AKIA' + 'IOSFODNN7EXAMPLE',
  slack: 'xox' + 'b-1234567890-abcdefghij',
}

const eventsDir = (repo) => join(repo, '.tmux-teams', 'kms', 'events')

test('append writes one file per event and echoes its path', () => {
  const { home, repo } = sandbox()
  const r = run(home, ['append', repo, '-'], EVENT)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout.trim(), /_t1_codex\.md$/)
  assert.equal(readdirSync(eventsDir(repo)).length, 1)
})

test('append rejects an event missing task_id or worker', () => {
  const { home, repo } = sandbox()
  const r = run(home, ['append', repo, '-'], 'pm_verdict: pass\n')
  assert.equal(r.status, 2)
  assert.match(r.stderr, /task_id/)
})

test('secrets are redacted on the way in — the file is immutable afterwards', () => {
  const { home, repo } = sandbox()
  const body = [
    EVENT,
    'evidence: |',
    `  OPENAI_API_KEY=${FAKE.openai}`,
    '  authorization: Bearer aaaaaaaaaaaaaaaaaaaaaaaa',
    `  token=${FAKE.githubClassic}`,
    `  AWS: ${FAKE.aws}`,
  ].join('\n')
  const r = run(home, ['append', repo, '-'], body)
  assert.equal(r.status, 0, r.stderr)
  const written = readFileSync(r.stdout.trim(), 'utf8')
  assert.ok(!written.includes(FAKE.openai))
  assert.ok(!written.includes(FAKE.githubClassic))
  assert.ok(!written.includes(FAKE.aws))
  assert.doesNotMatch(written, /Bearer aaaaaaaa/)
  assert.match(written, /redacted/)
  // Non-secret content must survive the scrub, or the store becomes useless.
  assert.match(written, /bound review briefs/)
})

test('two events in the same minute both survive — no silent overwrite', () => {
  const { home, repo } = sandbox()
  const a = run(home, ['append', repo, '-'], EVENT)
  const b = run(home, ['append', repo, '-'], EVENT)
  assert.equal(a.status, 0, a.stderr)
  assert.equal(b.status, 0, b.stderr)
  assert.notEqual(a.stdout.trim(), b.stdout.trim())
  assert.equal(readdirSync(eventsDir(repo)).length, 2)
})

test('same basename in different paths cannot share a store', () => {
  const { home } = sandbox()
  const parentA = mkdtempSync(join(tmpdir(), 'kms-a-'))
  const parentB = mkdtempSync(join(tmpdir(), 'kms-b-'))
  const repoA = join(parentA, 'api'), repoB = join(parentB, 'api')
  mkdirSync(repoA); mkdirSync(repoB)
  run(home, ['append', repoA, '-'], EVENT)
  run(home, ['append', repoB, '-'], EVENT.replace('task_id: t1', 'task_id: t2'))
  // The repo IS the key, so cross-project bleed is structurally impossible.
  assert.deepEqual(readdirSync(eventsDir(repoA)).map(f => f.includes('_t1_')), [true])
  assert.deepEqual(readdirSync(eventsDir(repoB)).map(f => f.includes('_t2_')), [true])
  assert.ok(!existsSync(join(home, '.tmux-teams')), 'nothing may be written to $HOME')
})

test('the store ignores itself so events never reach a commit', () => {
  const { home, repo } = sandbox()
  run(home, ['append', repo, '-'], EVENT)
  assert.equal(readFileSync(join(repo, '.tmux-teams', '.gitignore'), 'utf8').trim(), '*')
})

test('recall surfaces the event with its verdict, and defangs terminal markers', () => {
  const { home, repo } = sandbox()
  run(home, ['append', repo, '-'], EVENT.replace(/^lesson: .*$/m, 'lesson: emit TEAM_DONE only after evidence'))
  const r = run(home, ['recall', repo])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /verdict=pass/)
  assert.match(r.stdout, /\[TEAM_DONE\]/)
  assert.doesNotMatch(r.stdout, /(^|[^[])TEAM_DONE/m)
  // Recalled material must announce itself as unverified history.
  assert.match(r.stdout, /reference only/)
})

test('recall filters by term and by worker', () => {
  const { home, repo } = sandbox()
  run(home, ['append', repo, '-'], EVENT)
  run(home, ['append', repo, '-'], EVENT.replace('worker: codex', 'worker: claude').replace('task_id: t1', 'task_id: t2'))
  assert.match(run(home, ['recall', repo, '--worker', 'claude']).stdout, /_t2_claude\.md/)
  assert.doesNotMatch(run(home, ['recall', repo, '--worker', 'claude']).stdout, /_t1_codex\.md/)
  assert.match(run(home, ['recall', repo, 'nonexistent-term']).stdout, /none match/)
})

test('markers are defanged even when glued to word characters', () => {
  const { home, repo } = sandbox()
  run(home, ['append', repo, '-'], EVENT.replace(/^lesson: .*$/m, 'lesson: saw _TEAM_DONE and TEAM_FAILED_retry inline'))
  const out = run(home, ['recall', repo]).stdout
  assert.match(out, /_\[TEAM_DONE\]/)
  assert.match(out, /\[TEAM_FAILED\]_retry/)
})

test('redaction leaves ordinary prose alone', () => {
  const { home, repo } = sandbox()
  const r = run(home, ['append', repo, '-'], [
    EVENT,
    'note: monkey=legitimatecontent and keyboard=mechanical',
    'query: api_key=abcdefgh&next=keep',
    'lesson2: ran the basic info check and the bearer token docs page',
  ].join('\n'))
  const written = readFileSync(r.stdout.trim(), 'utf8')
  assert.match(written, /monkey=legitimatecontent/)
  assert.match(written, /keyboard=mechanical/)
  // A query string must lose only its secret: `&` ends the value.
  assert.match(written, /api_key=<redacted>&next=keep/)
  // "basic"/"bearer" as English words must survive; only real credentials go.
  assert.match(written, /the basic info check/)
  assert.match(written, /the bearer token docs page/)
})

test('redaction covers quoted-JSON keys and more token shapes', () => {
  const { home, repo } = sandbox()
  const r = run(home, ['append', repo, '-'], [
    EVENT,
    'note: |',
    '  "client_secret": "abcdefghijklmnop"',
    "  'refresh_token': 'zyxwvutsrqponmlk'",
    '  accessToken=camelcasesecret123',
    '  Authorization: Basic dTpw',
    '  Authorization: opaquetokenwithoutscheme123',
    '  authorization: true',
    `  ${FAKE.githubPat}`,
    `  ${FAKE.slack}`,
    '  Authorization: Basic dXNlcjpwYXNzd29yZA==',
  ].join('\n'))
  const written = readFileSync(r.stdout.trim(), 'utf8')
  assert.doesNotMatch(written, /abcdefghijklmnop"/)
  assert.doesNotMatch(written, /zyxwvutsrqponmlk/)
  assert.doesNotMatch(written, /camelcasesecret123/)
  assert.doesNotMatch(written, /Basic dTpw/)
  assert.doesNotMatch(written, /opaquetokenwithoutscheme123/)
  // A config flag is not a credential.
  assert.match(written, /authorization: true/)
  assert.ok(!written.includes(FAKE.githubPat))
  assert.ok(!written.includes(FAKE.slack))
  assert.doesNotMatch(written, /dXNlcjpwYXNzd29yZA/)
})

test('redaction never spans a line break', () => {
  const { home, repo } = sandbox()
  // A key with no value on its line must not consume the next line: \s spans
  // newlines, so `api_key =` once swallowed the following line's first token.
  const r = run(home, ['append', repo, '-'], [
    EVENT,
    'note: |',
    '  api_key =',
    '  unrelated_setting = foo',
    '  apiKey:',
    '  another_value = bar',
    '  Authorization: opaquetokenwithoutscheme123',
    '  next_line_survives = yes',
  ].join('\n'))
  const written = readFileSync(r.stdout.trim(), 'utf8')
  assert.match(written, /unrelated_setting = foo/)
  assert.match(written, /another_value = bar/)
  assert.match(written, /next_line_survives = yes/)
  assert.doesNotMatch(written, /opaquetokenwithoutscheme123/)
})

test('--worker matches exactly and a regex-shaped value cannot crash recall', () => {
  const { home, repo } = sandbox()
  run(home, ['append', repo, '-'], EVENT.replace('worker: codex', 'worker: codex-extra'))
  const exact = run(home, ['recall', repo, '--worker', 'codex'])
  assert.equal(exact.status, 0, exact.stderr)
  assert.match(exact.stdout, /none match/)
  const weird = run(home, ['recall', repo, '--worker', '['])
  assert.equal(weird.status, 0, weird.stderr)
})

test('filename order matches creation order past nine collisions', () => {
  const { home, repo } = sandbox()
  // recall lists with .sort().reverse() and then applies --limit, so lexical
  // order IS chronological order. An unpadded ~9 sorts after ~10 and would hide
  // the newest event behind the limit.
  const created = []
  for (let i = 0; i < 11; i++) created.push(run(home, ['append', repo, '-'], EVENT).stdout.trim().split('/').pop())
  assert.equal(readdirSync(eventsDir(repo)).length, 11)
  assert.deepEqual([...created].sort(), created, `lexical order diverged from creation order: ${created.join(' ')}`)
})

test('recall on an empty store says so instead of failing', () => {
  const { home, repo } = sandbox()
  const r = run(home, ['recall', repo, 'anything'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /no events recorded/)
})

test('a missing repo path is refused rather than silently slugged', () => {
  const { home } = sandbox()
  const r = run(home, ['append', join(tmpdir(), 'kms-does-not-exist-xyz'), '-'], EVENT)
  assert.equal(r.status, 2)
  assert.match(r.stderr, /no such repo/)
})
