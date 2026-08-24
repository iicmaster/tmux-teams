// plugin-structure.test.mjs — structure and semantic checks for the
// tmux-teams plugin (canonical source of its skills). Run: node --test
// Harness pattern borrowed from antigravity-plugins/tests/plugin-structure.test.mjs,
// with semantic anchors instead of brittle prose regexes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync, lstatSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN = join(ROOT, 'plugins/tmux-teams')
const SKILLS = ['tmux-teams', 'party-mode', 'party-auto', 'party-advise', 'sqthink',
  'graph-setup', 'claude-advisor', 'codex-advisor', 'agy-advisor', 'handoff',
  'pm-delegation']
const RELEASE_VERSION = '0.35.0'
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
  // ROADMAP.md carries the number too, and nothing checked it. A lane copied
  // this checkout, bumped exactly the five files README.md names, and this
  // suite passed 21/21 with ROADMAP.md still on the previous version — the
  // seventh place, found by grepping in the first place and then left
  // unguarded. It also has its own publication gate, so a missed bump here
  // makes the published page stale on top of being wrong.
  const roadmapVersion = readFileSync(join(ROOT, 'ROADMAP.md'), 'utf8')
    .match(/^Current release: \*\*([0-9]+\.[0-9]+\.[0-9]+)\*\*/m)
  assert.ok(roadmapVersion, 'ROADMAP.md has no `Current release: **X.Y.Z**` line for the bump to update')
  assert.equal(roadmapVersion[1], RELEASE_VERSION, 'ROADMAP.md states a different release than the manifests')

  // The FIFTH FILE and the SIXTH version occurrence — the counts differ because
  // marketplace.json carries it twice, and this comment said "the FIFTH place"
  // while the release instructions were being corrected for that exact
  // conflation. Added 2026-08-08 with the vendor-neutral manifest. Every
  // time a place was added it was found by a reader rather than by the flow,
  // so this one arrives WITH its guard instead of waiting for the next release
  // to notice. The Agent Plugins spec sets `additionalProperties: false` and
  // requires `$schema` and `name`, so this checks the shape too — a manifest
  // that quietly stops validating is the same silent wrongness as a stale
  // version number.
  const portable = readJson(join(PLUGIN, 'plugin.json'))
  assert.equal(portable.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json')
  assert.equal(portable.name, plugin.name, 'the two manifests disagree about the plugin name')
  assert.equal(portable.version, RELEASE_VERSION, 'plugins/tmux-teams/plugin.json states a different release')
  const allowed = new Set(['$schema', 'name', 'version', 'description', 'author',
    'homepage', 'repository', 'license', 'keywords', 'extensions'])
  for (const key of Object.keys(portable)) {
    assert.ok(allowed.has(key), `${key} is not in the agent-plugins 1.0.0 schema, which forbids extras`)
  }
  assert.match(portable.name, /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/, 'name fails the spec pattern')

  // Types, not just names. This file is the only gate that reads this manifest
  // at all, so a field of the wrong shape ships unless it is checked here.
  const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
  for (const key of ['description', 'homepage', 'repository', 'license']) {
    if (key in portable) assert.equal(typeof portable[key], 'string', `${key} must be a string`)
  }
  // Read off the published schema on 2026-08-08, after a release reviewer said
  // this accepted `author: "IIC Master"` while the spec does not: `author` is an
  // OBJECT — never a string — with `additionalProperties: false` over exactly
  // name, email and url. The looser check here was written from memory of how
  // npm spells it, and a manifest this gate passes and a schema-validating
  // client rejects is the same silent wrongness the guard exists to stop.
  if ('author' in portable) {
    assert.ok(isPlainObject(portable.author), 'author must be an object — the schema does not accept a string')
    for (const key of Object.keys(portable.author)) {
      assert.ok(['name', 'email', 'url'].includes(key), `author.${key} is not in the schema, which closes its keys`)
      assert.equal(typeof portable.author[key], 'string', `author.${key} must be a string`)
    }
  }
  if ('keywords' in portable) {
    assert.ok(Array.isArray(portable.keywords), 'keywords must be an array')
    for (const keyword of portable.keywords) assert.equal(typeof keyword, 'string', 'every keyword is a string')
  }
  // `additionalProperties: {type: 'object'}` — the container AND every value.
  // Checking only the container let `extensions: { 'org.example': [] }` pass.
  if ('extensions' in portable) {
    assert.ok(isPlainObject(portable.extensions), 'extensions must be an object')
    for (const [namespace, value] of Object.entries(portable.extensions)) {
      assert.ok(isPlainObject(value), `extensions["${namespace}"] must be an object`)
    }
  }
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
  assert.ok(tmux.includes('## 7. PM workflow integration'), 'wire-in section (ข้อ 7) missing')
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
  for (const tracked of ['`.github/`', '`.claude-plugin/`', '`.gitignore`', '`plugins/`', '`tests/`', '`README.md`', '`CLAUDE.md`', '`ROADMAP.md`']) {
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

// `shippedModules()` is for the checks that IMPORT a file, and it stops at
// `.mjs` because the one shipped `.js` — `workflows/mailbox-run.js` — is a
// runnable driver with no `process.argv` guard, so importing it would run it.
// Everything that only READS bytes must see the whole shipped tree instead: a
// walk that names one extension and a claim that says "the shipped tree" was
// the round-7 blocker, and the same test file already knew that file existed.
const shippedExecutables = () => {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.mjs') || entry.name.endsWith('.js')) out.push(path)
    }
  }
  walk(join(PLUGIN, 'skills'))
  return out.sort()
}

test('the byte-reading walk sees more than the importing one', () => {
  // The gap itself, pinned: if `mailbox-run.js` is renamed or the extension
  // list drifts back, this says so instead of a guard quietly narrowing.
  const extra = shippedExecutables().filter((file) => !shippedModules().includes(file))
  assert.ok(extra.some((file) => file.endsWith('mailbox-run.js')),
    `the .js walk lost the shipped driver it exists for:\n${extra.join('\n')}`)
})

test('every shipped module parses', () => {
  const files = shippedExecutables()
  // A floor, so a walk that finds nothing cannot pass as a clean sweep.
  assert.ok(files.length >= 20, `only ${files.length} shipped modules found — the walk is not walking`)
  for (const file of files) {
    const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
    assert.equal(checked.status, 0, `${file.slice(PLUGIN.length + 1)} does not parse:\n${checked.stderr}`)
  }
})

// The companion prints `[terminal] <verdict>` to stdout, and the runner spawns
// it with `stdio: ['ignore', logFd, logFd]` — that stream is a log file under
// `.tmux-teams/runner-logs/`, read by people. The verdict a machine acts on is
// the outbox FILE, hash-checked against the `outbox_digest` recorded at
// `delivered`. A comment in the companion once appointed the log line "the only
// line stating a verdict". It was false, and six release-review rounds were
// spent hardening a stream against forgery because of it. Deleting the sentence
// is half the fix; this is the half that holds. A writer emits the token inside
// a template literal, so a reader is what these two patterns describe: the
// token as a regex, or as a quoted string to search for.
// A guard about CODE must not read PROSE. Every comment in the companion
// naming the log line writes it as `` `[terminal]` `` in markdown, which is a
// template literal to a regex and nothing at all to a runtime — the third
// pattern below went red on the very comments that explain why it exists.
// Blunt on purpose: block comments go, and a `//` that is not part of `://`
// takes the rest of its line. It can therefore drop code that shares a line
// with a trailing comment, which loses a reader rather than inventing one —
// the safe direction for a tripwire, and stated here rather than discovered.
const withoutComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1')

const TERMINAL_LINE_READER = [
  { pattern: /\\\[terminal\\\]/, shape: 'a regex matching the log line' },
  { pattern: /['"]\[terminal\]/, shape: 'the log line as a quoted string' },
  // The third shape, and the most ordinary JS of the three: a template literal.
  // Two of three release lanes blocked on its absence, and one of them had said
  // so a round earlier as a non-blocking note that went unactioned. It cannot
  // simply add a backtick to the class above, because the companion WRITES the
  // line with `` `[terminal] ${result.terminal}` `` — so this matches only a
  // template whose whole content is the token and any literal text, with no
  // interpolation: a reader's `` `[terminal]` ``, never the writer's.
  { pattern: /`\[terminal\][^`$]*`/, shape: 'the log line as a template literal' },
]

test('nothing in the shipped tree reads the companion log for a verdict', () => {
  const files = shippedExecutables()
  assert.ok(files.length >= 20, `only ${files.length} shipped modules found — the walk is not walking`)
  const found = []
  for (const file of files) {
    const source = withoutComments(readFileSync(file, 'utf8'))
    for (const { pattern, shape } of TERMINAL_LINE_READER) {
      if (pattern.test(source)) found.push(`${file.slice(PLUGIN.length + 1)}: ${shape}`)
    }
  }
  assert.deepEqual(found, [], `the verdict is the outbox file, not the log:\n${found.join('\n')}`)
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

test('an advisor skill that claims read-only ships the switch that makes it read-only', () => {
  // A release panel read both advisor frontmatters — "Read-only: it advises, it
  // never edits" — against the dispatch commands under them and found nothing
  // enforcing it. Codex children DEFAULT to INITIAL_AGENT_MODE=agent-full-access,
  // so the documented command launched a full-access advisor and the brief was
  // the only thing asking it to behave. `read-only` is one of the three modes
  // the companion accepts, so this was an unenforced claim, not an
  // unenforceable one.
  const codex = readFileSync(join(PLUGIN, 'skills', 'codex-advisor', 'SKILL.md'), 'utf8')
  const claude = readFileSync(join(PLUGIN, 'skills', 'claude-advisor', 'SKILL.md'), 'utf8')
  const agy = readFileSync(join(PLUGIN, 'skills', 'agy-advisor', 'SKILL.md'), 'utf8')

  // every codex dispatch or resume block carries the mode
  // Truncate at the CLOSING fence. `split('```bash')` runs each piece on to the
  // next fenced block, so a piece includes the prose after its own command —
  // and the prose here names the very flag being asserted, which made the check
  // pass on an explanation instead of on a command. A mutation caught it: the
  // flag was deleted from a real command and every test stayed green. Same
  // vacuous-assertion shape a panel lane had just found in the traversal test.
  const commandBlocks = (text) => text.split('```bash').slice(1)
    .map((b) => b.split('```')[0])
    // EVERY worker this dispatcher takes. Naming only the workers that existed
    // when the guard was written means the next advisor skill ships unguarded:
    // its commands match nothing, `blocks.length` is 0, and a full-access
    // command passes silently.
    .filter((b) => /acp-dispatch\.mjs[\s\\]+\n?\s*(codex|claude|agy|mock) </.test(b))

  const codexBlocks = commandBlocks(codex)
  assert.ok(codexBlocks.length >= 2, `expected dispatch and recovery blocks, got ${codexBlocks.length}`)
  for (const block of codexBlocks) {
    assert.match(block, /INITIAL_AGENT_MODE="read-only"/,
      `a codex advisor command runs at the full-access default:\n${block.slice(0, 400)}`)
  }

  // and the identity guarantee is not fail-open: the default mode CONTINUES
  // after a receipt-persistence failure and records `receipt_digest: none`, so
  // an advisor could report an identity resting on a receipt never written.
  for (const [name, text] of [['codex-advisor', codex], ['claude-advisor', claude],
    ['agy-advisor', agy]]) {
    const blocks = commandBlocks(text)
    // The count is pinned too: a block that stops MATCHING is indistinguishable
    // from a block that passes, and `> 0` cannot tell them apart.
    // Pinned per file, and the numbers are what each skill documents: codex has
    // a dispatch and a recovery, claude has a default seat, a routed seat and a
    // recovery. The count is pinned at all because a block that stops MATCHING
    // is indistinguishable from a block that passes, and `> 0` cannot tell them
    // apart — but it is pinned per file so ADDING a documented command is a
    // deliberate edit here rather than a silent one.
    const expected = { 'codex-advisor': 2, 'claude-advisor': 3, 'agy-advisor': 1 }[name]
    assert.equal(blocks.length, expected,
      `${name} documents ${blocks.length} lane-launching commands, not ${expected}`)
    for (const block of blocks) {
      assert.match(block, /ACP_SESSION_RECEIPT_REQUIRED=1/,
        `${name} runs a lane whose receipt may silently not exist:\n${block.slice(0, 400)}`)
    }
  }

  // The AGY lane HAS the mode switch — measured 2026-08-19: it accepts
  // read-only, writes a receipt and reports
  // `effective_identity: gemini-3.7-flash-high (matched)`. Held to the same
  // enforcement as codex rather than excused like claude.
  for (const block of commandBlocks(agy)) {
    assert.match(block, /INITIAL_AGENT_MODE="read-only"/,
      `an agy advisor command runs at the default mode:\n${block.slice(0, 400)}`)
  }

  // The Claude lane has no mode switch, so it must not promise one it lacks.
  assert.doesNotMatch(claude, /Read-only: it advises, it never edits/,
    'the claude advisor promises an enforcement it has no mechanism for')
})

test('the two skills that describe an undeclared graph agree with tick()', () => {
  // Two panel families found `tmux-teams/SKILL.md` and `graph-setup/SKILL.md`
  // saying opposite things about a missing declaration, with the code siding
  // with graph-setup: `tick()` sees `graph.source === 'default'` and writes a
  // heartbeat carrying `dispatching: false` and `no team graph declared`. The
  // bundled template LOADS — the pages need something to draw — and the runner
  // will not dispatch on it.
  const main = readFileSync(join(PLUGIN, 'skills', 'tmux-teams', 'SKILL.md'), 'utf8')
  const setup = readFileSync(join(PLUGIN, 'skills', 'graph-setup', 'SKILL.md'), 'utf8')
  const runner = readFileSync(join(PLUGIN, 'skills', 'tmux-teams', 'scripts', 'loop-runner.mjs'), 'utf8')

  assert.match(runner, /graph\.source === 'default'/, 'the refusal this documents is gone from the runner')
  assert.doesNotMatch(main, /A missing declaration uses the bundled four-team template\./,
    'the skill teaches a fallback the runner refuses')
  for (const [name, text] of [['tmux-teams', main], ['graph-setup', setup]]) {
    assert.match(text, /missing declaration is \*\*?not\*\*? a default|not a default/i,
      `${name} does not say that a missing declaration is not a default`)
  }

  // And the heartbeat example matches the value the refusal path writes: `null`
  // is the absence of a measurement, `0` is a measurement. On a page about
  // telling absent from stale from refusing, that distinction is the subject.
  assert.match(runner, /beat\(\{ dispatching: false, reason, started: 0, held: null \}\)/)
  assert.doesNotMatch(setup, /"started": 0, "held": 0 \}/,
    'the example turns "not measured" into "measured zero"')
})

test('the read-only guarantee is carried by the thing it says it rests on', () => {
  // `claude-advisor`'s frontmatter says read-only "rests on the brief" because
  // the lane has no mode switch. A panel lane read that against the mandatory
  // brief and found only party format and uncertainty instructions — the thing
  // the guarantee leaned on did not carry it. The Codex lane has
  // INITIAL_AGENT_MODE=read-only; here the text IS the mechanism.
  const claude = readFileSync(join(PLUGIN, 'skills', 'claude-advisor', 'SKILL.md'), 'utf8')
  const agy = readFileSync(join(PLUGIN, 'skills', 'agy-advisor', 'SKILL.md'), 'utf8')
  // `Cast 3-5 named voices`, not the round-table phrase — the frontmatter
  // description contains that phrase too, so the first match was the YAML
  // header and the assertion was about the wrong bytes.
  const mandate = claude.split('```').find((b) => b.includes('Cast 3-5 named voices'))
  assert.ok(mandate, 'the mandatory brief is gone')
  assert.match(mandate, /READ-ONLY/, 'the brief the guarantee rests on carries no read-only instruction')
  for (const forbidden of [/do not edit/i, /change nothing/i]) {
    assert.match(mandate, forbidden, `the brief does not say ${forbidden}`)
  }

  // And the recovery path keeps the receipt contract the fresh commands
  // declare: dropping receipt mode exactly when the first delivery is missing
  // is the moment it matters most.
  for (const skill of ['codex-advisor', 'claude-advisor']) {
    const text = readFileSync(join(PLUGIN, 'skills', skill, 'SKILL.md'), 'utf8')
    const recovery = text.split('```bash').slice(1).map((b) => b.split('```')[0])
      .filter((b) => b.includes('ACP_RESUME'))
    assert.equal(recovery.length, 1, `${skill} documents ${recovery.length} recovery commands`)
    for (const need of ['ACP_SESSION_RECEIPT_REQUIRED=1', 'ACP_SESSION_OPERATION="load"',
      'ACP_PRIOR_DISPATCH_ID', 'ACP_PRIOR_RECEIPT_DIGEST']) {
      assert.ok(recovery[0].includes(need),
        `${skill}'s recovery drops ${need}, so the resumed turn is not receipt-backed`)
    }
  }
})

test('the claude advisor does not promise an identity proof its routed seat cannot give', () => {
  // A panel lane read the headline — "can prove which model answered" — against
  // this file's own paragraph fifty lines down: a receipt recording
  // `effective_identity: opus` has told you nothing about who answered, because
  // `opus` on three different bins reaches three different vendors. Both cannot
  // be true, and the headline is the one a reader sees first.
  const claude = readFileSync(join(PLUGIN, 'skills', 'claude-advisor', 'SKILL.md'), 'utf8')
  const agy = readFileSync(join(PLUGIN, 'skills', 'agy-advisor', 'SKILL.md'), 'utf8')
  const body = claude.split('---').slice(2).join('---')   // past the frontmatter

  assert.ok(body.includes('has told\nyou nothing about who answered')
    || body.includes('has told you nothing about who answered'),
    'the alias-is-not-a-family paragraph is gone, so the contradiction may have been "fixed" by deletion')

  // an unqualified promise must not stand next to it
  const unqualified = /returns a\s+round-table, and \*\*can prove which model answered\*\*/
  assert.doesNotMatch(body, unqualified,
    'the headline promises an identity proof the routed seat cannot give')
  // and the qualification names WHICH seat can
  assert.match(body, /default seat.{0,80}can prove/s,
    'the file does not say which seat the proof holds for')
})

// Master, 2026-08-19: the advisors must be the same thing three times — every
// one forces a bmad-party-mode round-table, every one takes a model.
//
// Measured before this test existed, they were three different shapes: the
// party-mode obligation was PROSE in all three and enforced by nothing, and
// `agy-advisor` took no model at all and said "One seat" while its adapter
// advertises fourteen. A uniform contract that nothing checks is the same
// unenforced claim in three files instead of one.
//
// UNIFORM MEANS THE CONTRACT, NOT THE CAPABILITIES. `claude-advisor` has no
// read-only switch because that lane has none, and the test above asserts it
// must not promise one. Pretending three lanes are identical is the failure this
// avoids, not the goal.
test('every advisor carries the same contract: a party, and a model', () => {
  // Named literally as well as iterated. A loop over a list is a test of the
  // list: drop an entry and it simply stops checking that one.
  const NAMES = ['codex-advisor', 'claude-advisor', 'agy-advisor']
  assert.deepEqual(
    SKILLS.filter((s) => s.endsWith('-advisor')).sort(), [...NAMES].sort(),
    'an advisor skill exists that this contract does not cover')

  for (const name of NAMES) {
    const text = readFileSync(join(PLUGIN, 'skills', name, 'SKILL.md'), 'utf8')
    const front = text.split('---')[1] ?? ''

    assert.match(front, /bmad-party-mode round-table/,
      `${name}: the frontmatter does not promise a round-table, so a reader never sees the obligation`)
    assert.match(text, /## The consultation is a party\. Only a party\./,
      `${name}: no party mandate section`)
    assert.match(text, /MUST answer as a `bmad-party-mode` round-table/,
      `${name}: the mandate is described but never stated as a requirement`)
    // The words that go INTO the brief, not a paraphrase about them — this is
    // the only part the advisor ever sees.
    assert.match(text, /Answer as a bmad-party-mode round-table\. Cast 3-5 named voices/,
      `${name}: the brief mandate an advisor is actually given is missing`)
    assert.match(text, /single-voice\s+answer is a failed consultation/,
      `${name}: does not say what to do when the answer comes back as one voice`)

    // A model can be named. The grammars differ because the seats differ — codex
    // has three named seats, claude needs a bin AND a model, agy has three
    // efforts of one family — so what is pinned is that a default and at least
    // one alternative are BOTH documented.
    const args = text.split('## Arguments')[1]
    assert.ok(args, `${name}: no Arguments section, so no way to name a model`)
    const lines = args.split('```')[1]?.split('\n').filter((l) => l.trim().startsWith('$')) ?? []
    assert.ok(lines.length >= 2,
      `${name}: documents ${lines.length} invocation(s) — a default and at least one named seat are required`)
    assert.ok(lines.some((l) => /default seat/.test(l)),
      `${name}: no invocation is marked as the default seat`)
  }
})


// The README named eleven skills while twelve shipped, and the missing one was
// `show-me` — a skill the plugin delivered and its own documentation never
// mentioned. Nothing caught that, because `SKILLS` and the README were two
// hand-kept lists with no relationship. This is the relationship. It was
// proposed in a pull request offering a vendor-neutral delegation guide; the
// guide was declined and this half was kept, which is why it is here and not
// there.
test('every shipped skill is named in the README, and the README names no skill that is not shipped', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
  const named = new Set([...readme.matchAll(/`tmux-teams:([a-z0-9-]+)`/g)].map((m) => m[1]))
  // `tmux-teams:tmux-teams` is the plugin's own entry skill and is named the
  // same as the plugin, so it appears in prose that is not an inventory line.
  // READ THE DIRECTORY, do not trust the list. A review lane blocked v0.34.0
  // partly on this: the word "shipped" here used to mean `new Set(SKILLS)`, so
  // a skill directory that existed and was in NEITHER `SKILLS` nor the README
  // passed every check in this file. The list is still pinned separately — that
  // is what catches a deletion — but "shipped" now means what is on disk.
  const onDisk = readdirSync(join(PLUGIN, 'skills'), { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(PLUGIN, 'skills', e.name, 'SKILL.md')))
    .map((e) => e.name)
  const shipped = new Set(onDisk)
  assert.deepEqual([...shipped].sort(), [...SKILLS].sort(),
    'the skills on disk and the SKILLS list of record disagree — one of them is wrong, '
    + 'and until this test read the directory neither could say which')
  const undocumented = [...shipped].filter((s) => !named.has(s)).sort()
  const phantom = [...named].filter((s) => !shipped.has(s)).sort()
  assert.deepEqual(undocumented, [],
    `these skills ship and the README never names them: ${undocumented.join(', ')}`)
  assert.deepEqual(phantom, [],
    `the README names skills that are not shipped: ${phantom.join(', ')}`)

  // AND THE COUNT IN PROSE, which is what actually shipped wrong. The section
  // heading said "The eleven skills" while the tables below it named twelve —
  // a contradiction inside one document, and nothing was watching a number
  // written as a word.
  const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
    'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
    'seventeen', 'eighteen', 'nineteen', 'twenty']
  const heading = readme.match(/^##\s*\d+\.\s*The\s+(\w+)\s+skills\s*$/m)
  assert.ok(heading, 'the README no longer has a "The <n> skills" heading for this test to check')
  assert.equal(heading[1], WORDS[shipped.size],
    `the README heading says "${heading[1]}" and ${shipped.size} skills ship`)
})

// Agent Plugins 1.0 asks for client-specific material under a reverse-domain
// namespace. Claude Code cannot read one: measured from the installed binary's
// own strings, it recognises plugin content by finding `.claude-plugin/` — or a
// top-level `commands/`, `skills/`, `agents/`, `hooks/`, `themes/`,
// `output-styles/`, `monitors/`, `workflows/`, `SKILL.md`, `.mcp.json` or
// `.lsp.json` — and contains no occurrence of `agent-plugins.org` at all.
//
// So these paths are load-bearing for INSTALLATION, and until this test no
// gate watched them: every existing check reads a known path and asserts its
// CONTENTS, so a move that updated the hard-coded paths would keep the suite
// green while making the plugin uninstallable. Written BEFORE anything moves,
// on purpose — a test written afterwards confirms what was done rather than
// checking whether it was right.
test('the paths Claude Code needs to recognise this plugin are where it looks for them', () => {
  for (const required of ['.claude-plugin/plugin.json', '.mcp.json', 'skills']) {
    assert.ok(existsSync(join(PLUGIN, required)),
      `${required} is missing from the plugin root — Claude Code finds plugin content by these names`)
  }
  // And the vendor-neutral pair, which is how this repository already answers
  // the same conflict for one file: two registrations, deliberately different,
  // side by side.
  assert.ok(existsSync(join(PLUGIN, 'plugin.json')),
    'the vendor-neutral Agent Plugins manifest is missing')
  assert.ok(existsSync(join(PLUGIN, 'mcp.json')),
    'the vendor-neutral MCP registration is missing')
})

// CLAUDE.md states which paths this repository tracks, and a test above asserts
// that the LIST says what it should. Nothing asserted that the tracked files
// MATCH the list — so `.mailbox-out-archive-round1/`, a directory this session
// created to preserve a review transcript, rode into the release on a
// `git add -A`. `.mailbox-out/` was ignored; the archive name was not. Ten
// rounds of the review of record read past it, and `gate-required.mjs` named
// it as a deciding file for the panel without anyone noticing what it was.
//
// The set is pinned literally rather than derived from CLAUDE.md: a test that
// reads its expectation out of the document it is checking agrees with whatever
// the document says, including a document somebody widened to make a test pass.
// The 1.0 portable root, and why it is symlinks rather than a copy.
//
// ADR 0008 recorded that this plugin's layout does NOT conform: section 8 of
// the specification says "Client-specific files MUST be represented under a
// top-level directory named for that namespace", and `.claude-plugin/`,
// `.mcp.json` and `commands/` sit at the plugin root instead. Moving them
// satisfies 1.0 and makes the plugin uninstallable in Claude Code, whose binary
// contains no `agent-plugins.org` string at all.
//
// So there are two roots. `plugins/tmux-teams/` is what Claude Code installs and
// is unchanged. `agent-plugins/tmux-teams/` is what a standard-aware client
// installs, and it is SYMLINKS — measured: git stores them as mode 120000, six
// lines total for 2.4 MB of skills, and they survive both `git clone` and
// `git archive` as real links. A copy would have been 69 files that drift.
//
// THE LINKS ARE ONLY READABLE FROM A FULL CHECKOUT, and this comment claimed
// more than that until an openai review lane checked it on the v0.35.0 diff.
// Every one of the six points outside the root it lives in (`../../plugins/…`),
// so the root is a VIEW of this repository, not a directory you can pick up:
//
//     git archive HEAD agent-plugins | tar -x -C /tmp/ar
//     /tmp/ar/agent-plugins/tmux-teams/plugin.json   -> dangling
//
// which is a problem precisely because the second root exists so that a
// standard-aware installer can be pointed at it. `scripts/portable-root.mjs`
// resolves that: the tree keeps the links, and anyone who needs a directory
// they can carry asks for one. The test below is what makes the copy's
// equivalence a fact rather than an intention.
test('the portable root conforms to Agent Plugins 1.0, and every link in it resolves', () => {
  const PORTABLE = join(ROOT, 'agent-plugins', 'tmux-teams')
  const NS = join(PORTABLE, 'com.anthropic.claude')

  // What the spec fixes by name: the manifest, the MCP path, the skills dir.
  for (const required of ['plugin.json', 'mcp.json', 'skills']) {
    const p = join(PORTABLE, required)
    assert.ok(lstatSync(p).isSymbolicLink(), `${required} in the portable root is not a symlink — a copy drifts`)
    assert.ok(existsSync(p), `${required} in the portable root is a DEAD symlink`)
  }

  // Section 8's MUST is the whole reason this root exists: client-specific
  // files live under the namespace, not at the root.
  for (const clientOwned of ['.claude-plugin', '.mcp.json', 'commands']) {
    assert.equal(existsSync(join(PORTABLE, clientOwned)), false,
      `${clientOwned} is client-specific and sits at the portable root — that is the exact 1.0 `
      + 'violation this root exists to avoid')
  }
  for (const inNamespace of ['plugin.json', 'mcp.json', 'commands']) {
    const p = join(NS, inNamespace)
    assert.ok(lstatSync(p).isSymbolicLink(), `com.anthropic.claude/${inNamespace} is not a symlink`)
    assert.ok(existsSync(p), `com.anthropic.claude/${inNamespace} is a DEAD symlink`)
  }

  // Reading THROUGH the links, not merely stat-ing them. A symlink can resolve
  // to a directory that is empty or to a file that is not what it claims.
  const portableManifest = JSON.parse(readFileSync(join(PORTABLE, 'plugin.json'), 'utf8'))
  assert.equal(portableManifest.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    'the portable manifest lost its 1.0 $schema')
  assert.equal(portableManifest.name, 'tmux-teams')
  assert.equal(portableManifest.version, RELEASE_VERSION,
    'the portable manifest is a different version from the release — the symlink is pointing somewhere stale')

  const claudeManifest = JSON.parse(readFileSync(join(NS, 'plugin.json'), 'utf8'))
  assert.equal('$schema' in claudeManifest, false,
    'the namespaced Claude manifest gained a 1.0 $schema — the two manifests differ on purpose')
  assert.equal(claudeManifest.version, RELEASE_VERSION)

  // The skills link must reach the real inventory, not an empty directory.
  const portableSkills = readdirSync(join(PORTABLE, 'skills'), { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name).sort()
  assert.deepEqual(portableSkills, [...SKILLS].sort(),
    'the portable root sees a different set of skills than ships')
})

test('the tracked top-level entries are exactly the ones this repository declares', () => {
  const listed = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(Boolean)
    .map((p) => p.split('/')[0])
  const actual = [...new Set(listed)].sort()
  const allowed = [
    '.claude-plugin', '.github', '.gitignore', 'agent-plugins',
    '.published-RELEASE-PLAN.json', '.published-event-subscriptions.json',
    '.roadmap-published.json',
    'CLAUDE.md', 'HANDOFF.md', 'README.md', 'RELEASE-PLAN.md', 'ROADMAP.md',
    'plugins', 'scripts', 'tests',
  ].sort()
  const unexpected = actual.filter((e) => !allowed.includes(e))
  const missing = allowed.filter((e) => !actual.includes(e))
  assert.deepEqual(unexpected, [],
    `these are tracked and this repository does not declare them: ${unexpected.join(', ')}`)
  assert.deepEqual(missing, [],
    `these are declared and no longer tracked: ${missing.join(', ')}`)
})

// A copy is only worth having if it is the same thing. `fs.cp` with
// `dereference: true` is the whole mechanism, so the failure worth guarding is
// the one where it silently is not: a link copied AS a link (dangling again), or
// a file whose bytes differ from the source it claims to be.
test('the materialised portable root is self-contained and byte-identical to what it came from', async () => {
  const { materialisePortableRoot } = await import(pathToFileURL(join(ROOT, 'scripts', 'portable-root.mjs')).href)
  const out = mkdtempSync(join(tmpdir(), 'portable-root-'))
  try {
    const written = await materialisePortableRoot(ROOT, out)

    // Every path in the copy, and not one of them may still be a link — that is
    // the entire defect this script exists to answer.
    const walk = (dir, base = '') => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const rel = base ? `${base}/${entry.name}` : entry.name
      const abs = join(dir, entry.name)
      assert.ok(!lstatSync(abs).isSymbolicLink(),
        `${rel} came out of the materialiser as a symlink, so the copy dangles exactly like the source root`)
      return entry.isDirectory() ? walk(abs, rel) : [rel]
    })
    const files = walk(written)
    assert.ok(files.length > 20, `the copy holds only ${files.length} files — the skills tree did not come across`)

    // The four entries the spec fixes by name, plus the namespaced ones.
    for (const required of ['plugin.json', 'mcp.json', 'skills', 'com.anthropic.claude']) {
      assert.ok(existsSync(join(written, required)), `${required} is missing from the materialised root`)
    }

    // Byte equality against the ORIGINAL, read through the link. A copy that is
    // merely present proves nothing; a copy that disagrees is worse than none.
    const pairs = [
      ['plugin.json', join(PLUGIN, 'plugin.json')],
      ['mcp.json', join(PLUGIN, 'mcp.json')],
      ['com.anthropic.claude/plugin.json', join(PLUGIN, '.claude-plugin', 'plugin.json')],
      ['com.anthropic.claude/mcp.json', join(PLUGIN, '.mcp.json')],
    ]
    for (const [rel, source] of pairs) {
      assert.equal(readFileSync(join(written, rel), 'utf8'), readFileSync(source, 'utf8'),
        `${rel} in the materialised root is not the bytes of ${source}`)
    }

    // EVERY file in the skills tree, by path and by bytes — not the directory
    // names. Checking names plus four top-level manifests passes while a nested
    // skill document is dropped or altered, which is a materialised plugin that
    // installs and is quietly incomplete. An openai review lane found that gap
    // in the first version of this test.
    const listAll = (dir, base = '') => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const rel = base ? `${base}/${entry.name}` : entry.name
      return entry.isDirectory() ? listAll(join(dir, entry.name), rel) : [rel]
    })
    const copiedSkills = listAll(join(written, 'skills')).sort()
    const sourceSkills = listAll(join(PLUGIN, 'skills')).sort()
    assert.deepEqual(copiedSkills, sourceSkills, 'the materialised skills tree is not the shipped one')
    for (const rel of sourceSkills) {
      assert.deepEqual(
        readFileSync(join(written, 'skills', rel)),
        readFileSync(join(PLUGIN, 'skills', rel)),
        `skills/${rel} differs from the shipped bytes in the materialised root`)
    }

    // The NAMESPACED tree too, by path and bytes. Four manifests plus the skills
    // directory left `com.anthropic.claude/commands` unchecked entirely, so a
    // materialiser that dropped the client commands passed — an installed
    // portable plugin with no commands. Same openai lane, one round later.
    const copiedCommands = listAll(join(written, 'com.anthropic.claude', 'commands')).sort()
    const sourceCommands = listAll(join(PLUGIN, 'commands')).sort()
    assert.ok(sourceCommands.length > 0, 'the plugin ships no commands, so this guard proves nothing')
    assert.deepEqual(copiedCommands, sourceCommands, 'the materialised commands tree is not the shipped one')
    for (const rel of sourceCommands) {
      assert.deepEqual(
        readFileSync(join(written, 'com.anthropic.claude', 'commands', rel)),
        readFileSync(join(PLUGIN, 'commands', rel)),
        `commands/${rel} differs from the shipped bytes in the materialised root`)
    }

    // It refuses to overwrite rather than deleting a tree somebody typed by
    // mistake — a destructive default is not a convenience.
    await assert.rejects(() => materialisePortableRoot(ROOT, out), /--force/,
      'a second run overwrote an existing directory without being asked to')
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})
