// plugin-structure.test.mjs — structure and semantic checks for the
// tmux-teams plugin (canonical source of its skills). Run: node --test
// Harness pattern borrowed from antigravity-plugins/tests/plugin-structure.test.mjs,
// with semantic anchors instead of brittle prose regexes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN = join(ROOT, 'plugins/tmux-teams')
const SKILLS = ['tmux-teams', 'party-mode', 'party-auto', 'party-advise', 'sqthink', 'codex-tmux-driver',
  'graph-setup', 'claude-advisor', 'codex-advisor', 'handoff']
const RELEASE_VERSION = '0.17.0'
// The Stage 1 CLI entry points went on 2026-07-29 and the rest of the phase
// subsystem — nine scripts, its gate, its store and its exporter — went on
// 2026-08-02. The note that used to stand here said deleting the remainder
// "broke Pulse's own tests, which under the standing rule — delete it, and if
// it breaks then it belongs — is the answer", and an existence assertion was
// written to hold them in place.
//
// That reading was wrong, and this is the correction. Pulse broke because
// `pulse.mjs` imported two frozen literals from `delivery-loop-core.mjs` and
// evaluated them at module load. Thirteen lines relocated first, and the rest
// deleted cleanly. What "it breaks" meant was one import, not belonging.
const PULSE_GRAPH_FILES = [
]
const STAGE1_REFERENCES = [
  'pulse-v3.schema.json',
]
const PULSE_RUNTIME_REFERENCES = ['pulse-v4.schema.json']
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
  // The FOURTH place the version is written, and the one no test guarded until
  // the v0.15.0 documentation review found it. README.md states the release in
  // prose; the release flow named three files and this was not among them, so
  // it would have shipped saying 0.14.6 forever. The same shape as the third
  // place, which reached the v0.12.0 bump still on 0.11.1 until a test caught it.
  const readmeVersion = readText(join(ROOT, 'README.md')).match(/Current release: \*\*([^*]+)\*\*/)
  assert.ok(readmeVersion, 'README.md must state "Current release: **<version>**"')
  assert.equal(readmeVersion[1], RELEASE_VERSION, 'README.md states a different release than the manifests')
})

test('Stage 1 field-evidence files and documentation links are wired', () => {
  const skillRoot = join(PLUGIN, 'skills/tmux-teams')
  const readme = readText(join(ROOT, 'README.md'))
  const skill = readText(join(skillRoot, 'SKILL.md'))

  for (const file of PULSE_GRAPH_FILES) {
    assert.ok(existsSync(join(skillRoot, file)), `Pulse graph asset missing: ${file}`)
  }
  for (const file of STAGE1_REFERENCES) {
    assert.ok(existsSync(join(skillRoot, 'references', file)), `Stage 1 reference missing: ${file}`)
    assert.ok(
      readme.includes(`(plugins/tmux-teams/skills/tmux-teams/references/${file})`),
      `README.md does not link ${file}`,
    )
    assert.ok(skill.includes(`(references/${file})`), `SKILL.md does not link ${file}`)
  }
  for (const file of PULSE_RUNTIME_REFERENCES) {
    const path = join(skillRoot, 'references', file)
    assert.ok(existsSync(path), `Pulse runtime reference missing: ${file}`)
    assert.ok(
      readme.includes(`(plugins/tmux-teams/skills/tmux-teams/references/${file})`),
      `README.md does not link ${file}`,
    )
    assert.ok(skill.includes(`(references/${file})`), `SKILL.md does not link ${file}`)
    const schema = readJson(path)
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema')
    assert.equal(schema.type, 'object')
    assert.equal(schema.additionalProperties, false)
  }

  for (const file of STAGE1_REFERENCES.filter(name => name.endsWith('.schema.json'))) {
    const schema = readJson(join(skillRoot, 'references', file))
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema',
      `${file}: wrong JSON Schema draft`)
    assert.equal(schema.type, 'object', `${file}: top level must be an object`)
    assert.equal(schema.additionalProperties, false, `${file}: top level must be closed`)
  }

  // Salvaged from pulse-v2.test.mjs, which dies with the phase subsystem, and
  // widened while moving. The loops above check only the TOP level of each
  // schema; nothing in the suite walked `$defs`, so a nested definition could
  // be open, or declare a property it never required, and no test would say so.
  // The original ran over v2 alone — this runs over every published version.
  for (const version of [1, 2, 3, 4]) {
    const file = `pulse-v${version}.schema.json`
    const schema = readJson(join(skillRoot, 'references', file))
    assert.equal(schema.properties.schema_version.const, version, `${file}: wrong version const`)
    for (const [name, definition] of [['pulse', schema], ...Object.entries(schema.$defs ?? {})]) {
      if (definition.type !== 'object') continue
      assert.equal(definition.additionalProperties, false, `${file}: ${name} must be closed`)
    }
  }

  // Required-completeness is a property of v2 ALONE, not a general rule, and the
  // original was right to scope it there. Widening it to every version failed
  // twice on deliberate design: v3 made `delivery_loop` optional on purpose, and
  // v4's `liveness_tool` declares `content_digest`/`locations_digest` without
  // requiring them. A rule that turns a designed choice into a violation is a
  // rule that gets the schema edited to match it.
  {
    const schema = readJson(join(skillRoot, 'references', 'pulse-v2.schema.json'))
    for (const [name, definition] of [['pulse', schema], ...Object.entries(schema.$defs)]) {
      if (definition.type !== 'object') continue
      assert.deepEqual([...definition.required].sort(), Object.keys(definition.properties).sort(),
        `pulse-v2.schema.json: ${name} must require every declared property`)
    }
  }

  // Phase attribution on a run is written by the TEAM loop, not by the phase
  // subsystem — `tests/pulse-v3-phase.test.mjs` proves the behaviour end to end
  // and survives the deletion. This is the schema half of that pair, and it
  // lived in the dying file.
  // v3 only. v4 defines neither `phase_source` nor `diagnostic_code` in its
  // `$defs` — it inlines them — so the original was right to scope this to the
  // version that declares them. Third time widening a salvaged rule broke on a
  // real difference; the run said so each time.
  {
    const schema = readJson(join(skillRoot, 'references', 'pulse-v3.schema.json'))
    for (const definitionName of ['run', 'recent_verdict']) {
      assert.ok(schema.$defs[definitionName].required.includes('phase'), `v3 ${definitionName}.phase`)
      assert.ok(schema.$defs[definitionName].required.includes('phase_source'), `v3 ${definitionName}.phase_source`)
    }
    assert.deepEqual(schema.$defs.phase_source.enum,
      ['dispatch', 'event', 'dispatch_join', 'unassigned', 'conflict'], 'v3 phase_source vocabulary')
    for (const code of ['PHASE_BINDING_INVALID', 'PHASE_BINDING_CONFLICT']) {
      assert.ok(schema.$defs.diagnostic_code.enum.includes(code), `v3 diagnostic ${code}`)
    }
  }

  // Only commands that still exist. The freeze/assign/capture/replay/rehearse
  // and phase-gate CLIs went with the Stage 1 entry points; docs promising a
  // command nobody can run is the same class of untruth as a page reporting
  // work nobody did.
  const commandAnchors = [
    'pulse.mjs compat-v1',
  ]
  for (const anchor of commandAnchors) {
    assert.ok(readme.includes(anchor), `README.md command missing: ${anchor}`)
    assert.ok(skill.includes(anchor), `SKILL.md command missing: ${anchor}`)
  }
  // Seven anchors went with the phase subsystem on 2026-08-02: the Stage 1
  // section heading, `EXTERNAL_REQUIRED`, `NOT_CERTIFIED`, the no-routing
  // boundary, `ROI_NOT_ESTABLISHED`, `scenario_signal`, and the
  // ProjectDelivery-is-not-a-fifth-phase paragraph. They anchored prose about a
  // system that no longer exists; an anchor that outlives its subject stops
  // being a check and becomes a reason to write the paragraph back.
  //
  // `phase-gate.json` went too, but differently — the marker still MATTERS, it
  // is just no longer a contract the docs teach. `acp-companion.mjs` refuses to
  // run in a repository still carrying one rather than silently downgrading it,
  // and that refusal is asserted where it lives, in the ACP suite.
  for (const doc of [['README.md', readme], ['SKILL.md', skill]]) {
    assert.match(doc[1], /pulse-v3\.schema\.json/, `${doc[0]}: Pulse v3 contract missing`)
    assert.match(doc[1], /pulse-v4\.schema\.json/, `${doc[0]}: Pulse v4 contract missing`)
    assert.match(doc[1], /Pulse v4 is the default/i, `${doc[0]}: Pulse v4 default missing`)
    assert.match(doc[1], /compat-v1/, `${doc[0]}: v1 compatibility contract missing`)
    assert.match(doc[1], /phase_source/, `${doc[0]}: explicit phase source contract missing`)
    assert.match(doc[1], /unassigned/i, `${doc[0]}: unassigned phase behavior missing`)
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

test('every bundled skill is present with matching frontmatter names', () => {
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
  const readme = readText(join(ROOT, 'README.md'))
  assert.match(readme, /Gemini worker lane has been removed/i,
    'README.md must explain that the Gemini lane is retired')
  assert.match(tmux, /Gemini lane has been removed/i,
    'SKILL.md must explain that the Gemini lane is retired')
  assert.doesNotMatch(`${readme}\n${tmux}`, /\|\s*gemini\s*\|/i,
    'release docs still advertise the retired Gemini CLI lane in a transport table')
  assert.doesNotMatch(acp, /\bgemini\s*:\s*\[/,
    'acp-companion.mjs still maps the retired Gemini CLI lane')
  assert.doesNotMatch(acp, /<gemini\|/,
    'acp-companion.mjs usage still advertises the retired Gemini CLI lane')
  assert.match(acp, /trim\(\)\.toLowerCase\(\) === 'gemini'/,
    'acp-companion.mjs must normalize the retired public agent name')
  assert.match(acp, /unsupported agent/,
    'acp-companion.mjs must reject the retired public agent name before ACP_CMD')
  for (const doc of [['README.md', readme], ['SKILL.md', tmux]]) {
    assert.match(doc[1], /PULSE_TIME_ZONE/, `${doc[0]}: Pulse timezone env contract missing`)
    assert.match(doc[1], /--time-zone/, `${doc[0]}: Pulse timezone CLI contract missing`)
    assert.match(doc[1], /RFC 3339 UTC/, `${doc[0]}: Pulse UTC data invariant missing`)
  }
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

// A backtick written inside a template literal — most easily in a comment
// quoting an identifier — closes the literal early and the module stops parsing
// a long way from the cause. Eleven times in this project, the eleventh on
// 2026-08-03 in `graph.mjs`'s stylesheet while fixing something else. Every one
// was caught by `node --check`, which CLAUDE.md asks a person to remember to
// run. This is that check, remembered by the suite instead.
//
// The guard it replaces named three strings by hand and so could not see a
// fourth. This walks the shipped tree.
const shippedModules = () => {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.mjs')) out.push(path)
    }
  }
  walk(join(PLUGIN, 'skills'))
  return out.sort()
}

test('every shipped module parses', () => {
  const files = shippedModules()
  // A floor, so a walk that finds nothing cannot pass as a clean sweep.
  assert.ok(files.length >= 20, `only ${files.length} shipped modules found — the walk is not walking`)
  for (const file of files) {
    const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
    assert.equal(checked.status, 0, `${file.slice(PLUGIN.length + 1)} does not parse:\n${checked.stderr}`)
  }
})

test('no shipped client string carries a backtick, whoever adds the next one', async () => {
  const files = shippedModules().filter((file) => {
    // A CLI entry runs its argument parsing at module load and calls
    // process.exit, so importing it here would end the test run. Named by what
    // they do rather than by a list, so a new one is skipped automatically.
    const source = readFileSync(file, 'utf8')
    return !source.includes('process.argv.slice(2)')
  })
  const found = []
  for (const file of files) {
    let module
    try {
      module = await import(pathToFileURL(file).href)
    } catch (error) {
      // A module that cannot be imported standalone is not a client-string
      // carrier this test can read; parsing is covered by the test above.
      if (error?.code === 'ERR_MODULE_NOT_FOUND') continue
      throw error
    }
    for (const [name, value] of Object.entries(module)) {
      if (typeof value !== 'string' || !/(?:CSS|SCRIPT)$/.test(name)) continue
      found.push(name)
      assert.equal(value.includes('`'), false,
        `${name} in ${file.slice(PLUGIN.length + 1)} contains a backtick — it is assembled into a`
        + ' template literal and will close it')
    }
  }
  // The three the old hand-written guard knew about, plus the ones it did not.
  for (const expected of ['TOUR_CSS', 'TOUR_SCRIPT', 'NAV_CSS', 'KANIT_FONT_CSS']) {
    assert.ok(found.includes(expected), `${expected} was not discovered — the scan is looking in the wrong place`)
  }
})
