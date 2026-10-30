import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEAT_FALLBACKS, fallbackSeat, isRateLimitEvidence, rateLimitEvidence, USAGE }
  from '../plugins/tmux-teams/skills/tmux-teams/scripts/agy-seat-fallback.mjs';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..',
  'plugins', 'tmux-teams', 'skills', 'tmux-teams', 'scripts');
const SCRIPT = join(SCRIPTS, 'agy-seat-fallback.mjs');
const agySkill = readFileSync(new URL('../plugins/tmux-teams/skills/agy-advisor/SKILL.md', import.meta.url), 'utf8');

// The measured 2026-10-21 lines, pasted rather than paraphrased — a classifier
// tested against a summary of the evidence is a classifier tested against
// nothing. These are the strings the runner log actually carried.
const AGY_ERROR_LINE = 'AGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED (code 429): Individual quota reached...","status":"RESOURCE_EXHAUSTED","error_code":429,"code_kind":"http","retryable":true,...}';
const AGY_STDERR_LINE = '[agent-err] [agy-acp] agy stderr: error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 68h14m11s.';
const FATAL_LINE = '[fatal] {"code":-32603,"message":"Internal error: agy failed: ..."}';

// Temp directories removed when the file ends. Nothing detached is spawned
// here — the CLI runs are `spawnSync` and are gone when the assertion runs —
// so the pid-hunt the dispatch suite needs has no counterpart in this file.
const TEMP_DIRS = [];
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  TEMP_DIRS.push(dir);
  return dir;
}

// A run root shaped the way `acp-dispatch.mjs` builds them, holding whatever
// the caller says for `.tmux-teams/liveness/<id>.json` and
// `.tmux-teams/runner-logs/<id>.log` — the only two leaves the classifier reads.
function fixtureRoot({ taskId, liveness, log }) {
  const dir = tempDir('agy-seat-fallback-');
  mkdirSync(join(dir, '.tmux-teams', 'liveness'), { recursive: true });
  mkdirSync(join(dir, '.tmux-teams', 'runner-logs'), { recursive: true });
  if (liveness !== undefined) {
    writeFileSync(join(dir, '.tmux-teams', 'liveness', `${taskId}.json`),
      typeof liveness === 'string' ? liveness : `${JSON.stringify(liveness, null, 2)}\n`);
  }
  if (log !== undefined) {
    writeFileSync(join(dir, '.tmux-teams', 'runner-logs', `${taskId}.log`), log);
  }
  return dir;
}

after(() => {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
});

test('the seat map is exactly three same-tier pairs and frozen', () => {
  assert.deepEqual(SEAT_FALLBACKS, {
    'gemini-4-argon-high': 'gemini-3.8-flash-high',
    'gemini-4-argon-medium': 'gemini-3.8-flash-medium',
    'gemini-4-argon-low': 'gemini-3.8-flash-low',
  });
  assert.ok(Object.isFrozen(SEAT_FALLBACKS), 'a seat map a lane can edit at runtime is a policy nobody pinned');
});

test('fallbackSeat maps every gemini-4 tier and refuses everything else with null', () => {
  assert.equal(fallbackSeat('gemini-4-argon-high'), 'gemini-3.8-flash-high');
  assert.equal(fallbackSeat('gemini-4-argon-medium'), 'gemini-3.8-flash-medium');
  assert.equal(fallbackSeat('gemini-4-argon-low'), 'gemini-3.8-flash-low');
  // The 3.8 seats are the LAST hop — a second hop is what "one hop only" forbids.
  assert.equal(fallbackSeat('gemini-3.8-flash-high'), null);
  assert.equal(fallbackSeat('gemini-3.8-flash-medium'), null);
  assert.equal(fallbackSeat('gemini-3.8-flash-low'), null);
  // 3.1 is prohibited and must never be reachable through this table.
  assert.equal(fallbackSeat('gemini-3.1-pro-high'), null);
  // Other families are never downgraded to — the siblings keep that rule.
  assert.equal(fallbackSeat('claude-opus-5-5'), null);
  assert.equal(fallbackSeat('gpt-oss-120b'), null);
  // Non-string input, including the inherited-key trap: `SEAT_FALLBACKS['constructor']`
  // would answer a truthy function if the lookup were bare.
  assert.equal(fallbackSeat('constructor'), null);
  assert.equal(fallbackSeat(undefined), null);
  assert.equal(fallbackSeat(null), null);
  assert.equal(fallbackSeat(429), null);
});

test('isRateLimitEvidence matches the measured markers and nothing that must fail closed', () => {
  for (const line of [
    AGY_ERROR_LINE,
    AGY_STDERR_LINE,
    '"error_code":429',
    'RESOURCE_EXHAUSTED (code 429): Individual quota reached',
    'RESOURCE EXHAUSTED',           // the spaced form a rendered copy carries
    'rate limit exceeded',
    'rate_limit exceeded',
    'ratelimit exceeded',
    'HTTP 429: too many requests',
  ]) {
    assert.ok(isRateLimitEvidence(line), `a measured rate-limit marker read as clean: ${line}`);
  }
  // A 429 embedded in a longer number is NOT a 429 — `4291` and `1429` are the
  // false positives the lookarounds exist to refuse.
  assert.ok(!isRateLimitEvidence('error_code\":4291'));
  assert.ok(!isRateLimitEvidence('exit 1429'));
  // The red herring itself, and every refusal that keeps failing closed.
  for (const line of ['protocol_error', 'model not found', 'identity mismatch', 'EACCES', '']) {
    assert.ok(!isRateLimitEvidence(line), `a non-rate-limit string read as quota evidence: "${line}"`);
  }
  assert.ok(!isRateLimitEvidence(undefined));
  assert.ok(!isRateLimitEvidence(null));
  assert.ok(!isRateLimitEvidence(429));
});

test('rateLimitEvidence: the measured shape — protocol_error liveness, evidence in the log', () => {
  const dir = fixtureRoot({
    taskId: 'pmd-review-agy',
    liveness: { liveness_state: 'failed', termination_reason: 'protocol_error' },
    log: `${AGY_STDERR_LINE}\n${AGY_ERROR_LINE}\n${FATAL_LINE}\n`,
  });
  const verdict = rateLimitEvidence(dir, 'pmd-review-agy');
  assert.equal(verdict.rateLimited, true);
  assert.equal(verdict.where, 'log', 'the only source that matched in the real event');
  // The FIRST matching line in the measured order: the stderr line names the
  // quota two lines before AGY_ERROR does.
  assert.match(verdict.excerpt, /\[agent-err\] \[agy-acp\] agy stderr: error: Individual quota reached/);
  assert.ok(verdict.excerpt.length <= 240, 'the excerpt is capped, not a blob');
});

test('rateLimitEvidence: a liveness error field carrying the 429 is honoured without a log', () => {
  const dir = fixtureRoot({
    taskId: 'quota-in-liveness',
    liveness: {
      liveness_state: 'failed',
      termination_reason: 'protocol_error',
      error: 'RESOURCE_EXHAUSTED (code 429): Individual quota reached',
    },
    log: undefined,
  });
  const verdict = rateLimitEvidence(dir, 'quota-in-liveness');
  assert.equal(verdict.rateLimited, true);
  assert.equal(verdict.where, 'liveness');
  assert.match(verdict.excerpt, /RESOURCE_EXHAUSTED/);
});

test('rateLimitEvidence: no evidence in either source is a clean no, not a guess', () => {
  const dir = fixtureRoot({
    taskId: 'ordinary-death',
    liveness: { liveness_state: 'failed', termination_reason: 'protocol_error' },
    log: `${FATAL_LINE}\n`,
  });
  const verdict = rateLimitEvidence(dir, 'ordinary-death');
  assert.equal(verdict.rateLimited, false);
  assert.equal(verdict.where, null);
  assert.equal(verdict.excerpt, '');
});

test('rateLimitEvidence refuses a task id before it builds any path', () => {
  assert.throws(() => rateLimitEvidence(tempDir('agy-seat-fallback-'), '../evil'),
    { code: 'invalid_task_id' });
});

test('the SKILL.md documents the fallback as the one automatic downgrade, in the file\'s own terms', () => {
  assert.match(agySkill, /## Rate-limit fallback — the one automatic downgrade this seat takes/);
  // The section, isolated so a phrase found elsewhere in the file cannot stand
  // in for the rule.
  const section = agySkill.split('## Rate-limit fallback')[1]?.split('## Arguments')[0] ?? '';
  assert.ok(section, 'the fallback section is not between the model policy and the arguments');
  // The measured event AND the red herring, with the log named as the evidence.
  assert.match(section, /2026-10-21/);
  assert.match(section, /termination_reason: "protocol_error"/);
  assert.match(section, /RESOURCE_EXHAUSTED/);
  // The same-tier mapping, named as such.
  assert.match(section, /`gemini-4-argon-high` seat falls back to `gemini-3\.8-flash-high`/);
  assert.match(section, /SAME\s+effort tier/i);
  // The operator is told — an unannounced downgrade is the failure mode.
  assert.match(section, /operator is TOLD/);
  // One hop only, and never 3.1.
  assert.match(section, /ONE HOP ONLY/);
  assert.match(section, /never 3\.1/);
  // Rate-limit is the only automatic downgrade; the siblings keep their rules.
  assert.match(section, /ONLY (trigger for an )?automatic downgrade/i);
  assert.match(section, /Never downgrade\s+for cost or quota/);
  // The classify command is documented with its exit meanings.
  assert.match(section, /agy-seat-fallback\.mjs rate-limited <cwd> <task-id>/);
  assert.match(section, /agy-seat-fallback\.mjs seat gemini-4-argon-high/);
  // The re-dispatch keeps both model assignments on the fallback seat.
  assert.match(section, /BOTH `ACP_MODEL` and\s+`ACP_EXPECT_MODEL`/);
  assert.match(section, /the new receipt's acknowledged identity IS the 3\.8 seat/);
  // The 3.1 prohibition and its cross-reference survive untouched.
  assert.match(agySkill, /Gemini 3\.1 variants are PROHIBITED for planning, review and delivery work\./);
  assert.match(agySkill, /fallback maps gemini-4 seats to gemini-3\.8 flash seats at the same\s+tier only, so it can never reach a 3\.1 value/);
  // The measured identity line and the Arguments block are not this section's to touch.
  assert.match(agySkill, /effective_identity: gemini-4-argon-high \(matched\)/);
});

test('CLI: seat prints exactly the fallback id, or refuses with exit 2', () => {
  const seat = spawnSync(process.execPath, [SCRIPT, 'seat', 'gemini-4-argon-high'], { encoding: 'utf8' });
  assert.equal(seat.status, 0);
  assert.equal(seat.stdout, 'gemini-3.8-flash-high\n');
  // The 3.8 seats are the last hop — the CLI says so rather than guessing.
  const lastHop = spawnSync(process.execPath, [SCRIPT, 'seat', 'gemini-3.8-flash-high'], { encoding: 'utf8' });
  assert.equal(lastHop.status, 2);
  assert.match(lastHop.stderr, /no fallback exists/);
  // Usage errors are exit 2, not a stack trace.
  const noArgs = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(noArgs.status, 2);
  assert.match(noArgs.stderr, new RegExp(USAGE.split('\n')[0].replaceAll(' ', '\\s+')));
});

test('CLI: rate-limited against the measured shape exits 0 with the excerpt and its source', () => {
  const dir = fixtureRoot({
    taskId: 'pmd-review-agy',
    liveness: { liveness_state: 'failed', termination_reason: 'protocol_error' },
    log: `${AGY_STDERR_LINE}\n${AGY_ERROR_LINE}\n${FATAL_LINE}\n`,
  });
  const run = spawnSync(process.execPath, [SCRIPT, 'rate-limited', dir, 'pmd-review-agy'], { encoding: 'utf8' });
  assert.equal(run.status, 0, `stdout: ${run.stdout}\nstderr: ${run.stderr}`);
  assert.match(run.stdout, /\(log\)/);
  assert.match(run.stdout, /Individual quota reached/);
  // The clean no is exit 1 with the one-line verdict, and an invalid task id
  // is a one-line refusal at exit 2 — both distinguished from the match.
  const clean = fixtureRoot({
    taskId: 'ordinary-death',
    liveness: { liveness_state: 'failed', termination_reason: 'protocol_error' },
    log: `${FATAL_LINE}\n`,
  });
  const no = spawnSync(process.execPath, [SCRIPT, 'rate-limited', clean, 'ordinary-death'], { encoding: 'utf8' });
  assert.equal(no.status, 1);
  assert.equal(no.stdout.trim(), 'no rate-limit evidence in liveness or runner log');
  const evil = spawnSync(process.execPath, [SCRIPT, 'rate-limited', clean, '../evil'], { encoding: 'utf8' });
  assert.equal(evil.status, 2);
  assert.match(evil.stderr, /invalid task id/);
});
