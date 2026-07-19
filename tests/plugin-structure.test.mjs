// plugin-structure.test.mjs — structure, drift, and semantic checks for the
// tmux-teams plugin. Run: node --test tests/
// Harness pattern borrowed from antigravity-plugins/tests/plugin-structure.test.mjs,
// with semantic anchors instead of brittle prose regexes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN = join(ROOT, 'plugins/tmux-teams')
const SKILLS = ['tmux-teams', 'party-mode', 'party-auto', 'party-advise', 'sqthink', 'codex-tmux-driver']
const AGENT_SKILLS = process.env.AGENT_SKILLS_REPO || join(homedir(), 'agent-skills')

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))
const readText = (p) => readFileSync(p, 'utf8')

test('marketplace and plugin manifests agree', () => {
  const mkt = readJson(join(ROOT, '.claude-plugin/marketplace.json'))
  const plugin = readJson(join(PLUGIN, '.claude-plugin/plugin.json'))
  assert.equal(mkt.name, 'tmux-teams')
  assert.equal(mkt.plugins.length, 1)
  assert.equal(mkt.plugins[0].name, plugin.name)
  assert.equal(mkt.plugins[0].version, plugin.version)
  assert.ok(existsSync(join(ROOT, mkt.plugins[0].source)), 'plugins[0].source must exist')
})

test('all six skills are present with matching frontmatter names', () => {
  for (const name of SKILLS) {
    const skillMd = join(PLUGIN, 'skills', name, 'SKILL.md')
    assert.ok(existsSync(skillMd), `${name}/SKILL.md missing — run scripts/sync-skills.sh`)
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

test('no hardcoded home paths in manifests or commands', () => {
  for (const p of ['.claude-plugin/marketplace.json', 'plugins/tmux-teams/.claude-plugin/plugin.json', 'plugins/tmux-teams/commands/mailbox-run.md']) {
    assert.ok(!/\/home\/iicmaster/.test(readText(join(ROOT, p))), `${p}: hardcoded home path`)
  }
})

test('plugin skills are byte-identical to canonical agent-skills', { skip: !existsSync(AGENT_SKILLS) && 'agent-skills checkout not present' }, () => {
  const r = spawnSync('bash', [join(ROOT, 'scripts/sync-skills.sh'), '--check'], { encoding: 'utf8' })
  assert.equal(r.status, 0, `drift vs canonical:\n${r.stdout}${r.stderr}`)
})

test('claude plugin validate --strict passes', { skip: spawnSync('claude', ['--version'], { encoding: 'utf8' }).error && 'claude CLI not on PATH' }, () => {
  for (const target of [ROOT, PLUGIN]) {
    const r = spawnSync('claude', ['plugin', 'validate', '--strict', target], { encoding: 'utf8' })
    assert.equal(r.status, 0, `validate --strict failed for ${target}:\n${r.stdout}${r.stderr}`)
  }
})
