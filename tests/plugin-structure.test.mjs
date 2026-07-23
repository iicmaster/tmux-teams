// plugin-structure.test.mjs — structure and semantic checks for the
// tmux-teams plugin (canonical source of its skills). Run: node --test
// Harness pattern borrowed from antigravity-plugins/tests/plugin-structure.test.mjs,
// with semantic anchors instead of brittle prose regexes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN = join(ROOT, 'plugins/tmux-teams')
const SKILLS = ['tmux-teams', 'party-mode', 'party-auto', 'party-advise', 'sqthink', 'codex-tmux-driver']
const RELEASE_VERSION = '0.6.1'

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))
const readText = (p) => readFileSync(p, 'utf8')

test('marketplace and plugin manifests agree', () => {
  const mkt = readJson(join(ROOT, '.claude-plugin/marketplace.json'))
  const plugin = readJson(join(PLUGIN, '.claude-plugin/plugin.json'))
  assert.equal(mkt.name, 'tmux-teams')
  assert.equal(mkt.plugins.length, 1)
  assert.equal(mkt.plugins[0].name, plugin.name)
  assert.equal(mkt.plugins[0].version, plugin.version)
  assert.equal(mkt.metadata.version, RELEASE_VERSION)
  assert.equal(mkt.plugins[0].version, RELEASE_VERSION)
  assert.equal(plugin.version, RELEASE_VERSION)
  assert.ok(existsSync(join(ROOT, mkt.plugins[0].source)), 'plugins[0].source must exist')
})

test('CI runs the no-secret Node 20 and 24 matrix with event-aware repository hygiene checks', () => {
  const path = join(ROOT, '.github/workflows/ci.yml')
  assert.ok(existsSync(path), '.github/workflows/ci.yml missing')
  const ci = readText(path)
  const versions = ci.match(/node-version:\s*\[([^\]]+)\]/)?.[1]
    .split(',')
    .map(value => Number(value.trim()))

  assert.deepEqual(versions, [20, 24])
  assert.match(ci, /actions\/checkout@v4/)
  assert.match(ci, /persist-credentials:\s*false/)
  assert.match(ci, /fetch-depth:\s*0/)
  assert.match(ci, /actions\/setup-node@v4/)
  assert.match(ci, /(?:^|\n)\s*permissions:\s*\n\s*contents:\s*read(?:\n|$)/)
  assert.match(ci, /run:\s*node --test/)
  assert.match(ci, /EVENT_NAME:\s*\$\{\{\s*github\.event_name\s*\}\}/)
  assert.match(ci, /PR_BASE_SHA:\s*\$\{\{\s*github\.event\.pull_request\.base\.sha\s*\}\}/)
  assert.match(ci, /PUSH_BEFORE_SHA:\s*\$\{\{\s*github\.event\.before\s*\}\}/)
  assert.match(ci, /DEFAULT_BRANCH:\s*\$\{\{\s*github\.event\.repository\.default_branch\s*\}\}/)
  assert.match(ci, /git diff --check "\$PR_BASE_SHA\.\.\.HEAD"/)
  assert.match(ci, /git diff --check "\$PUSH_BEFORE_SHA\.\.HEAD"/)
  assert.match(ci, /git diff --check "origin\/\$\{DEFAULT_BRANCH\}\.\.\.HEAD"/)
  assert.doesNotMatch(ci, /git diff --check HEAD\^\.\.HEAD/,
    'HEAD^ checks only the last commit of a multi-commit push')
  assert.doesNotMatch(ci, /run:\s*git diff --check\s*(?:\n|$)/,
    'plain git diff --check is a no-op on a clean checkout')
  assert.doesNotMatch(ci, /\bsecrets\s*[:.]|GITHUB_TOKEN|claude plugin validate/,
    'CI must need no secrets; strict plugin validation remains a local release gate')
})

test('the event before..HEAD range catches whitespace hidden before the final pushed commit', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'tmux-teams-ci-range-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  const git = (args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
  assert.equal(git(['init', '-q']).status, 0)
  assert.equal(git(['config', 'user.name', 'CI Range Test']).status, 0)
  assert.equal(git(['config', 'user.email', 'ci-range@example.invalid']).status, 0)

  writeFileSync(join(repo, 'base.txt'), 'base\n')
  assert.equal(git(['add', 'base.txt']).status, 0)
  assert.equal(git(['commit', '-qm', 'base']).status, 0)
  const before = git(['rev-parse', 'HEAD']).stdout.trim()

  writeFileSync(join(repo, 'bad.txt'), 'trailing whitespace \n')
  assert.equal(git(['add', 'bad.txt']).status, 0)
  assert.equal(git(['commit', '-qm', 'bad first pushed commit']).status, 0)
  writeFileSync(join(repo, 'last.txt'), 'clean final commit\n')
  assert.equal(git(['add', 'last.txt']).status, 0)
  assert.equal(git(['commit', '-qm', 'clean final pushed commit']).status, 0)

  const headOnly = git(['diff', '--check', 'HEAD^..HEAD'])
  assert.equal(headOnly.status, 0, 'counterexample requires the old HEAD^ range to miss the defect')
  const pushedRange = git(['diff', '--check', `${before}..HEAD`])
  assert.notEqual(pushedRange.status, 0, 'the full pushed range must reject earlier whitespace')
  assert.match(`${pushedRange.stdout}${pushedRange.stderr}`, /trailing whitespace/)
})

test('all six skills are present with matching frontmatter names', () => {
  for (const name of SKILLS) {
    const skillMd = join(PLUGIN, 'skills', name, 'SKILL.md')
    assert.ok(existsSync(skillMd), `${name}/SKILL.md missing`)
    const fm = readText(skillMd).match(/^---\n[\s\S]*?\bname:\s*(\S+)/)
    assert.ok(fm, `${name}: no frontmatter name`)
    assert.equal(fm[1], name, `${name}: frontmatter name mismatch`)
  }
})

test('deliver.sh keeps its executable bit', () => {
  const p = join(PLUGIN, 'skills/tmux-teams/scripts/deliver.sh')
  assert.ok(existsSync(p), 'deliver.sh missing')
  assert.ok(statSync(p).mode & 0o111, 'deliver.sh lost its exec bit (sync must preserve modes)')
})

test('semantic anchors: canonical fixes actually shipped', () => {
  const checks = readText(join(PLUGIN, 'skills/party-mode/references/regression-checks.md'))
  assert.ok(!/Codex Spark only/.test(checks), 'stale TC-PA-09 Spark routing fossilized into the plugin')
  assert.ok(/Frontier always/.test(checks), 'TC-PA-09 must assert frontier-always routing')
  for (const wrapper of ['party-auto', 'party-advise']) {
    const txt = readText(join(PLUGIN, 'skills', wrapper, 'SKILL.md'))
    assert.ok(txt.includes('../party-mode/SKILL.md'), `${wrapper}: sibling lookup missing`)
  }
  const tmux = readText(join(PLUGIN, 'skills/tmux-teams/SKILL.md'))
  assert.ok(tmux.includes('## 7. PM workflow integration'), 'wire-in section (§7) missing')
  const wf = readText(join(PLUGIN, 'skills/tmux-teams/workflows/mailbox-run.js'))
  assert.ok(wf.includes('CLAUDE_PLUGIN_ROOT'), 'mailbox-run.js: no plugin-root deliver.sh candidate')
  assert.ok(wf.includes('TEAM_BLOCKED') && wf.includes('TEAM_FAILED'), 'mailbox-run.js: typed terminal markers missing')
  assert.ok(wf.includes('ID_RE'), 'mailbox-run.js: worker-id validation missing')
  assert.ok(tmux.includes('TEAM_BLOCKED'), 'SKILL.md: typed terminal markers missing from outbox contract')
  assert.ok(tmux.includes('## 8. ACP transport lane'), 'SKILL.md: ACP transport section missing')
  const acp = readText(join(PLUGIN, 'skills/tmux-teams/scripts/acp-companion.mjs'))
  assert.ok(acp.includes('session/prompt') && acp.includes('TEAM_BLOCKED'), 'acp-companion.mjs: missing protocol or terminal-marker handling')
})

test('party-auto/party-advise sibling path resolves inside the plugin', () => {
  const resolved = join(PLUGIN, 'skills/party-auto', '../party-mode/SKILL.md')
  assert.ok(existsSync(resolved), 'sibling ../party-mode/SKILL.md does not resolve')
  const partyMode = readText(resolved)
  assert.ok(/party-auto/.test(partyMode) && /Frontier always/.test(partyMode),
    'resolved party-mode/SKILL.md lacks load-bearing anchors')
})

test('mailbox-run command uses plugin-root paths', () => {
  const cmd = readText(join(PLUGIN, 'commands/mailbox-run.md'))
  assert.ok(cmd.includes('${CLAUDE_PLUGIN_ROOT}/skills/tmux-teams/workflows/mailbox-run.js'), 'scriptPath must use ${CLAUDE_PLUGIN_ROOT}')
  assert.ok(cmd.includes('${CLAUDE_PLUGIN_ROOT}/skills/tmux-teams/scripts/deliver.sh'), 'deliverSh must use ${CLAUDE_PLUGIN_ROOT}')
})

test('no hardcoded home paths in release-facing files', () => {
  for (const p of [
    '.claude-plugin/marketplace.json',
    'plugins/tmux-teams/.claude-plugin/plugin.json',
    'plugins/tmux-teams/commands/mailbox-run.md',
    'README.md',
    'CLAUDE.md',
  ]) {
    assert.doesNotMatch(readText(join(ROOT, p)), /\/(?:home|Users)\/[^/\s]+/,
      `${p}: hardcoded absolute home path`)
  }
})

test('tracked-files policy includes release CI and repository instructions', () => {
  const policy = readText(join(ROOT, 'CLAUDE.md'))
  for (const tracked of ['`.github/`', '`.claude-plugin/`', '`.gitignore`', '`plugins/`', '`tests/`', '`README.md`', '`CLAUDE.md`']) {
    assert.ok(policy.includes(tracked), `tracked-files policy missing ${tracked}`)
  }
})

test('release docs describe the canonical submodule topology without stale install claims', () => {
  const readme = readText(join(ROOT, 'README.md'))
  const policy = readText(join(ROOT, 'CLAUDE.md'))
  assert.doesNotMatch(readme, /\bprivate repository\b/i,
    'installation docs must not fossilize repository visibility')
  assert.doesNotMatch(policy, /inventory only|nothing reads it at runtime|still carries duplicate copies/i,
    'agent-skills uses the submodule for its OpenClaw bridge and purges standalone duplicates')
  assert.match(`${readme}\n${policy}`, /OpenClaw/,
    'canonical topology must name the remaining submodule consumer')
})

test('claude plugin validate --strict passes', { skip: spawnSync('claude', ['--version'], { encoding: 'utf8' }).error && 'claude CLI not on PATH' }, () => {
  for (const target of [ROOT, PLUGIN]) {
    const r = spawnSync('claude', ['plugin', 'validate', '--strict', target], { encoding: 'utf8' })
    assert.equal(r.status, 0, `validate --strict failed for ${target}:\n${r.stdout}${r.stderr}`)
  }
})
