import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  downProjectPulseV1,
  downProjectPulseV2,
  downProjectPulseV3,
  projectPulseV4,
} from '../plugins/tmux-teams/skills/tmux-teams/scripts/pulse-data.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PULSE = join(ROOT, 'plugins', 'tmux-teams', 'skills', 'tmux-teams', 'scripts', 'pulse.mjs')
const SCHEMA_DIR = join(ROOT, 'plugins', 'tmux-teams', 'skills', 'tmux-teams', 'references')
const SCHEMA_PATHS = Object.freeze({
  v1: join(SCHEMA_DIR, 'pulse-v1.schema.json'),
  v2: join(SCHEMA_DIR, 'pulse-v2.schema.json'),
  v3: join(SCHEMA_DIR, 'pulse-v3.schema.json'),
  v4: join(SCHEMA_DIR, 'pulse-v4.schema.json'),
})
const SCHEMAS = new Map([...Object.values(SCHEMA_PATHS), join(SCHEMA_DIR, 'team-runtime-v1.schema.json')].map(path => [
  basename(path), JSON.parse(readFileSync(path, 'utf8')),
]))
const HAS_PYTHON_JSONSCHEMA = spawnSync('python3', ['-c', 'import jsonschema'], {
  encoding: 'utf8',
}).status === 0
const TEMP_REPOS = new Set()

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-json-'))
  TEMP_REPOS.add(dir)
  mkdirSync(join(dir, '.tmux-teams', 'dispatch'), { recursive: true })
  mkdirSync(join(dir, '.tmux-teams', 'kms', 'events'), { recursive: true })
  mkdirSync(join(dir, '.mailbox-out'), { recursive: true })
  return dir
}

test.afterEach(() => {
  for (const dir of TEMP_REPOS) rmSync(dir, { recursive: true, force: true })
  TEMP_REPOS.clear()
})

function runJson(dir, extraArgs = []) {
  const result = spawnSync(process.execPath, [PULSE, 'json', dir, ...extraArgs], {
    encoding: 'utf8', timeout: 10_000,
  })
  assert.equal(result.status, 0, result.stderr)
  let snapshot
  assert.doesNotThrow(() => { snapshot = JSON.parse(result.stdout) },
    'pulse json stdout must be one parseable document')
  return { snapshot, stdout: result.stdout }
}

function publishedV4WithDeliveryLoop() {
  const dir = repo()
  return runJson(dir, ['--delivery-loop', join(dir, 'delivery-loop.json')]).snapshot
}

function producerStates() {
  const now = Date.parse('2026-07-29T00:00:00.000Z')
  return Object.keys(projectPulseV4({
    active: [],
    history: [],
    historyTotal: 0,
    rec: [],
    unclaimed: [],
    diagnostics: [],
    sourceHealth: { liveness: 'ok', tmux: 'ok', dispatch: 'ok', outbox: 'ok', events: 'ok' },
  }, {
    streamId: '00000000-0000-4000-8000-000000000000',
    sequence: 1,
    startedAt: now,
    finishedAt: now,
    intervalSec: 30,
    repoName: 'pulse-producer-state-vocabulary',
    teamGraphSourceDigest: null,
  }).summary.by_state)
}

const STATES = Object.freeze(producerStates())

function validDateTime(value) {
  const match = typeof value === 'string' && value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
  )
  if (!match) return false
  const [, year, month, day, hour, minute, second, zone] = match
  const values = [year, month, day, hour, minute, second].map(Number)
  const [yearNumber, monthNumber, dayNumber, hourNumber, minuteNumber, secondNumber] = values
  if (monthNumber < 1 || monthNumber > 12 || dayNumber < 1 || dayNumber > 31 ||
      hourNumber > 23 || minuteNumber > 59 || secondNumber > 59) return false
  if (zone !== 'Z') {
    const [offsetHour, offsetMinute] = zone.slice(1).split(':').map(Number)
    if (offsetHour > 23 || offsetMinute > 59) return false
  }
  const calendar = new Date(0)
  calendar.setUTCFullYear(yearNumber, monthNumber - 1, dayNumber)
  calendar.setUTCHours(hourNumber, minuteNumber, secondNumber, 0)
  return calendar.getUTCFullYear() === yearNumber && calendar.getUTCMonth() === monthNumber - 1 &&
    calendar.getUTCDate() === dayNumber && calendar.getUTCHours() === hourNumber &&
    calendar.getUTCMinutes() === minuteNumber && calendar.getUTCSeconds() === secondNumber &&
    Number.isFinite(Date.parse(value))
}

function jsonTypeMatches(value, type) {
  if (type === 'null') return value === null
  if (type === 'array') return Array.isArray(value)
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value)
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value)
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  return typeof value === type
}

function resolveSchemaRef(ref, rootSchema) {
  const [documentRef, fragment = ''] = String(ref).split('#')
  const document = documentRef ? SCHEMAS.get(basename(documentRef)) : rootSchema
  if (!document) throw new Error(`unresolved schema document ${documentRef}`)
  if (!fragment) return { schema: document, root: document }
  if (!fragment.startsWith('/')) throw new Error(`unsupported schema fragment ${fragment}`)
  let schema = document
  for (const part of fragment.slice(1).split('/')) {
    schema = schema?.[part.replaceAll('~1', '/').replaceAll('~0', '~')]
  }
  if (schema === undefined) throw new Error(`unresolved schema fragment ${ref}`)
  return { schema, root: document }
}

function validateSchema(value, schema, rootSchema, path = '$', errors = []) {
  if (schema === true) return errors
  if (schema === false) {
    errors.push(`${path}: schema is false`)
    return errors
  }
  if (schema.$ref) {
    const resolved = resolveSchemaRef(schema.$ref, rootSchema)
    validateSchema(value, resolved.schema, resolved.root, path, errors)
  }
  if (Object.hasOwn(schema, 'const') && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}`)
  }
  if (schema.enum && !schema.enum.some(candidate => JSON.stringify(candidate) === JSON.stringify(value))) {
    errors.push(`${path}: value is outside enum`)
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.some(type => jsonTypeMatches(value, type))) {
      errors.push(`${path}: expected type ${types.join('|')}`)
      return errors
    }
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter(branch =>
      validateSchema(value, branch, rootSchema, path, []).length === 0)
    if (matches.length !== 1) errors.push(`${path}: oneOf matched ${matches.length} branches`)
  }
  if (schema.allOf) {
    for (const branch of schema.allOf) validateSchema(value, branch, rootSchema, path, errors)
  }
  if (schema.not && validateSchema(value, schema.not, rootSchema, path, []).length === 0) {
    errors.push(`${path}: not schema matched`)
  }
  if (schema.if) {
    const conditionMatches = validateSchema(value, schema.if, rootSchema, path, []).length === 0
    const branch = conditionMatches ? schema.then : schema.else
    if (branch) validateSchema(value, branch, rootSchema, path, errors)
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties || {}
    for (const required of schema.required || []) {
      if (!Object.hasOwn(value, required)) errors.push(`${path}: missing required property ${required}`)
    }
    for (const [key, child] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) validateSchema(value[key], child, rootSchema, `${path}.${key}`, errors)
    }
    const unknown = Object.keys(value).filter(key => !Object.hasOwn(properties, key))
    if (schema.additionalProperties === false) {
      for (const key of unknown) errors.push(`${path}: additionalProperties contains ${key}`)
    } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      for (const key of unknown) validateSchema(value[key], schema.additionalProperties, rootSchema, `${path}.${key}`, errors)
    }
    if (schema.minProperties !== undefined && Object.keys(value).length < schema.minProperties) {
      errors.push(`${path}: fewer than ${schema.minProperties} properties`)
    }
    if (schema.maxProperties !== undefined && Object.keys(value).length > schema.maxProperties) {
      errors.push(`${path}: more than ${schema.maxProperties} properties`)
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: too few items`)
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: too many items`)
    if (schema.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) {
      errors.push(`${path}: uniqueItems violated`)
    }
    if (schema.items) value.forEach((item, index) => validateSchema(item, schema.items, rootSchema, `${path}[${index}]`, errors))
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: too short`)
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: too long`)
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: pattern mismatch`)
    if (schema.format === 'date-time' && !validDateTime(value)) errors.push(`${path}: invalid date-time`)
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below minimum`)
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above maximum`)
  }
  return errors
}

function assertSchema(value, schemaPath, label) {
  const schema = SCHEMAS.get(basename(schemaPath))
  assert.ok(schema, `${label}: schema was not loaded`)
  const errors = validateSchema(value, schema, schema)
  assert.deepEqual(errors, [], `${label}: ${errors.join('; ')}`)
  if (!HAS_PYTHON_JSONSCHEMA) return
  const program = [
    'import json, jsonschema, pathlib, sys',
    'schema_path = pathlib.Path(sys.argv[1]).resolve()',
    'schema = json.loads(schema_path.read_text(encoding="utf-8"))',
    'store = {path.name: json.loads(path.read_text(encoding="utf-8")) for path in schema_path.parent.glob("*.schema.json")}',
    'resolver = jsonschema.RefResolver.from_schema(schema, store=store)',
    'jsonschema.Draft202012Validator(schema, resolver=resolver, format_checker=jsonschema.FormatChecker()).validate(json.load(sys.stdin))',
  ].join('; ')
  const result = spawnSync('python3', ['-c', program, schemaPath], {
    input: JSON.stringify(value), encoding: 'utf8', timeout: 10_000,
  })
  assert.equal(result.status, 0, `${label}: ${result.stderr || result.stdout}`)
}

function vocabularySnapshot() {
  const now = Date.parse('2026-07-29T00:00:00.000Z')
  return projectPulseV4({
    active: STATES.map((state, index) => ({
      id: `state_${index}`,
      dispatchId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      dispatched: true,
      dispatchStatus: 'present',
      state,
      worker: 'worker',
      agentId: 'worker',
      kind: 'acp',
      liveness: 'alive',
      paneStatus: 'held',
      marker: '',
      pmVerdict: '',
      ageSec: 0,
      elapsedSec: null,
      timeoutSec: null,
      phase: null,
      phaseSource: 'unassigned',
      livenessEvidence: null,
      identityConflict: false,
    })),
    history: [],
    historyTotal: 0,
    rec: [],
    unclaimed: [],
    diagnostics: [],
    sourceHealth: { liveness: 'ok', tmux: 'ok', dispatch: 'ok', outbox: 'ok', events: 'ok' },
  }, {
    streamId: '11111111-1111-4111-8111-111111111111',
    sequence: 1,
    startedAt: now,
    finishedAt: now,
    intervalSec: 30,
    repoName: 'pulse-vocabulary',
    teamGraphSourceDigest: null,
  })
}

function assertStateVocabulary(snapshot, label) {
  assert.deepEqual([...snapshot.runs.map(run => run.state)].sort(), [...STATES].sort(), label)
  assert.deepEqual(Object.keys(snapshot.summary.by_state).sort(), [...STATES].sort(), label)
}

test('Pulse v4 output validates against the frozen v4 schema', () => {
  assertSchema(runJson(repo()).snapshot, SCHEMA_PATHS.v4, 'v4 output')
})

test('Pulse v1 compatibility output validates against the frozen v1 schema', () => {
  assertSchema(downProjectPulseV1(publishedV4WithDeliveryLoop()), SCHEMA_PATHS.v1, 'v1 compatibility output')
})

test('Pulse v2 compatibility output validates against the frozen v2 schema', () => {
  assertSchema(downProjectPulseV2(publishedV4WithDeliveryLoop()), SCHEMA_PATHS.v2, 'v2 compatibility output')
})

test('Pulse v3 compatibility output validates against the frozen v3 schema', () => {
  assertSchema(downProjectPulseV3(publishedV4WithDeliveryLoop()), SCHEMA_PATHS.v3, 'v3 compatibility output')
})

test('golden render agrees with its published Pulse snapshot', () => {
  const dir = repo()
  const { snapshot, stdout } = runJson(dir)
  assert.equal(readFileSync(join(dir, '.tmux-teams', 'pulse.json'), 'utf8'), stdout)
  assert.ok(readFileSync(join(dir, '.tmux-teams', 'pulse.html'), 'utf8').includes(snapshot.snapshot_id),
    'the render must identify the snapshot it read')
})

test('every producer state survives every versioned Pulse consumer', () => {
  const v4 = vocabularySnapshot()
  const v2Source = { ...publishedV4WithDeliveryLoop(), runs: v4.runs, summary: v4.summary }
  const consumers = [
    ['v1', downProjectPulseV1(v4), SCHEMA_PATHS.v1],
    ['v2', downProjectPulseV2(v2Source), SCHEMA_PATHS.v2],
    ['v3', downProjectPulseV3(v4), SCHEMA_PATHS.v3],
    ['v4', v4, SCHEMA_PATHS.v4],
  ]
  for (const [version, snapshot, schemaPath] of consumers) {
    assertStateVocabulary(snapshot, `${version} state vocabulary`)
    assertSchema(snapshot, schemaPath, `${version} state vocabulary`)
  }
})
