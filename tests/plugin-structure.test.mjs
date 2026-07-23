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
const RELEASE_VERSION = '0.7.0'
const STAGE1_SCRIPTS = [
  'delivery-loop-pilot-core.mjs',
  'delivery-loop-store.mjs',
  'delivery-loop-pilot.mjs',
  'delivery-loop-capture.mjs',
  'delivery-loop-export.mjs',
]
const STAGE1_REFERENCES = [
  'delivery-loop-pilot-manifest-v1.schema.json',
  'delivery-loop-event-v1.schema.json',
  'delivery-loop-evidence-pack-v1.schema.json',
  'pulse-v2.schema.json',
  'stage-1-pilot-runbook.md',
]
const CLAUDE_VERSION = spawnSync('claude', ['--version'], { encoding: 'utf8' })
const CLAUDE_AVAILABLE = !CLAUDE_VERSION.error && CLAUDE_VERSION.status === 0

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
  assert.match(plugin.version, /^\d+\.\d+\.\d+$/, 'plugin version must be semver')
  assert.ok(existsSync(join(ROOT, mkt.plugins[0].source)), 'plugins[0].source must exist')
})

test('Stage 1 field-evidence files and documentation links are wired', () => {
  const skillRoot = join(PLUGIN, 'skills/tmux-teams')
  const readme = readText(join(ROOT, 'README.md'))
  const skill = readText(join(skillRoot, 'SKILL.md'))

  for (const file of STAGE1_SCRIPTS) {
    assert.ok(existsSync(join(skillRoot, 'scripts', file)), `Stage 1 script missing: ${file}`)
  }
  for (const file of STAGE1_REFERENCES) {
    assert.ok(existsSync(join(skillRoot, 'references', file)), `Stage 1 reference missing: ${file}`)
    assert.ok(
      readme.includes(`(plugins/tmux-teams/skills/tmux-teams/references/${file})`),
      `README.md does not link ${file}`,
    )
    assert.ok(skill.includes(`(references/${file})`), `SKILL.md does not link ${file}`)
  }

  for (const file of STAGE1_REFERENCES.filter(name => name.endsWith('.schema.json'))) {
    const schema = readJson(join(skillRoot, 'references', file))
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema',
      `${file}: wrong JSON Schema draft`)
    assert.equal(schema.type, 'object', `${file}: top level must be an object`)
    assert.equal(schema.additionalProperties, false, `${file}: top level must be closed`)
  }

  const commandAnchors = [
    'delivery-loop-pilot.mjs freeze',
    'delivery-loop-pilot.mjs assign',
    'delivery-loop-capture.mjs capture',
    'delivery-loop-pilot.mjs replay',
    'delivery-loop-pilot.mjs rehearse',
    'delivery-loop-export.mjs export',
    'delivery-loop-export.mjs verify-pack',
    'pulse.mjs compat-v1',
  ]
  for (const anchor of commandAnchors) {
    assert.ok(readme.includes(anchor), `README.md command missing: ${anchor}`)
    assert.ok(skill.includes(anchor), `SKILL.md command missing: ${anchor}`)
  }
  for (const doc of [['README.md', readme], ['SKILL.md', skill]]) {
    assert.match(doc[1], /v0\.7 Stage 1/, `${doc[0]}: Stage 1 section missing`)
    assert.match(doc[1], /EXTERNAL_REQUIRED/, `${doc[0]}: external-decision boundary missing`)
    assert.match(doc[1], /NOT_CERTIFIED/, `${doc[0]}: certification boundary missing`)
    assert.match(doc[1], /never routes|does \*\*not\*\* route/i,
      `${doc[0]}: no-routing boundary missing`)
  }
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

test('claude plugin validation uses strict mode when the installed CLI supports it', {
  skip: CLAUDE_AVAILABLE ? false : 'claude CLI not on PATH',
}, () => {
  const help = spawnSync('claude', ['plugin', 'validate', '--help'], { encoding: 'utf8' })
  assert.equal(help.status, 0, `could not inspect installed validator:\n${help.stdout}${help.stderr}`)
  const supportsStrict = /(?:^|\s)--strict(?:\s|$)/m.test(`${help.stdout}${help.stderr}`)
  for (const target of [ROOT, PLUGIN]) {
    const args = ['plugin', 'validate', ...(supportsStrict ? ['--strict'] : []), target]
    const r = spawnSync('claude', args, { encoding: 'utf8' })
    const mode = supportsStrict ? 'validate --strict' : 'normal validate fallback'
    assert.equal(r.status, 0, `${mode} failed for ${target}:\n${r.stdout}${r.stderr}`)
    if (!supportsStrict) {
      assert.equal(args.includes('--strict'), false,
        'normal fallback must not pass an unsupported --strict option')
      assert.match(`${r.stdout}${r.stderr}`, /validat(?:ion|ing).*(?:passed|valid)|\bvalid\b/is,
        'normal fallback must explicitly report successful validation')
    }
  }
})
