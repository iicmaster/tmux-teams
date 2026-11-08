// oc-advisor-policy.test.mjs — the OpenCode advisor's own guard, in the shape
// advisor-sol-max-policy.test.mjs guards the codex seats. The lane is a
// custom worker over ACP_CMD with an execution profile, so what is pinned
// here is the pair of facts its read-only posture and its identity rest on:
// the deny policy on every lane-launching block, and the model id in BOTH
// the request and the expectation.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const skill = readFileSync(join(ROOT, 'plugins/tmux-teams/skills/oc-advisor/SKILL.md'), 'utf8')

const commandBlocks = skill.split('```bash').slice(1).map((b) => b.split('```')[0])
const dispatchBlocks = commandBlocks.filter((b) => /acp-dispatch\.mjs[\s\\]+\n?\s*opencode </.test(b))

test('oc-advisor documents the producer before any dispatch that consumes its output', () => {
  assert.match(skill, /opencode-execution-profile\.mjs/,
    'the skill never names the producer that writes the profile the dispatch requires')
  assert.match(skill, /NOT an upstream integrity\s+verification/,
    'the skill must not oversell a local snapshot as a package integrity proof')
})

test('every oc-advisor lane-launching block carries the full dispatch contract', () => {
  assert.ok(dispatchBlocks.length >= 2, `expected dispatch and recovery blocks, got ${dispatchBlocks.length}`)
  for (const block of dispatchBlocks) {
    assert.match(block, /ACP_SESSION_RECEIPT_REQUIRED=1/,
      `a block whose receipt may silently not exist:\n${block.slice(0, 400)}`)
    assert.match(block, /ACP_PERMISSIONS="deny"/,
      `a block without the read-only policy:\n${block.slice(0, 400)}`)
    assert.match(block, /ACP_CMD=/,
      `a custom-worker block that never names its executable:\n${block.slice(0, 400)}`)
    assert.match(block, /ACP_EXECUTION_PROFILE=/,
      `a receipt-required custom dispatch without its closed profile:\n${block.slice(0, 400)}`)
    assert.match(block, /ACP_MODEL="opencode\/deepseek-v4\.1-flash-free"/)
    assert.match(block, /ACP_EXPECT_MODEL="opencode\/deepseek-v4\.1-flash-free"/)
  }
})

test('the oc-advisor lane neither sends nor claims an unmeasured mode or effort', () => {
  // OpenCode is not measured to honor INITIAL_AGENT_MODE or
  // ACP_REASONING_EFFORT, so the lane clears both instead of inheriting a
  // shell's leftovers — and the skill must not promise the enforcement the
  // codex/agy lanes have.
  for (const block of dispatchBlocks) {
    assert.match(block, /env -u ACP_REASONING_EFFORT -u ACP_EXPECT_REASONING_EFFORT -u INITIAL_AGENT_MODE/,
      `a block that inherits the caller shell's reasoning/mode leftovers:\n${block.slice(0, 400)}`)
  }
  assert.doesNotMatch(skill, /INITIAL_AGENT_MODE="read-only"/,
    'the skill claims a mode switch OpenCode is not measured to honor')
  assert.doesNotMatch(skill, /Read-only: it advises, it never edits/,
    'the skill claims a sandbox-grade guarantee the lane does not hold')
  assert.match(skill, /does NOT claim "it never edits"/,
    'the skill must state the boundary of its own read-only claim')
})

test('the recovery block restores the routing the dispatch used', () => {
  const recovery = commandBlocks.filter((b) => b.includes('ACP_RESUME'))
  assert.equal(recovery.length, 1, `documented ${recovery.length} recovery commands`)
  for (const need of ['ACP_SESSION_RECEIPT_REQUIRED=1', 'ACP_SESSION_OPERATION="load"',
    'ACP_PRIOR_DISPATCH_ID', 'ACP_PRIOR_RECEIPT_DIGEST', 'ACP_CMD', 'ACP_EXECUTION_PROFILE',
    'ACP_PERMISSIONS="deny"']) {
    assert.ok(recovery[0].includes(need),
      `the recovery drops ${need}, so the resumed turn is not the dispatch that failed`)
  }
  assert.match(skill, /SAME task id/,
    'the skill must pin resume to the same task id — a fresh id moves the outbox path')
})

test('the credential residual is stated as measured fact, never as a route', () => {
  // Measured 2026-11-08: keyless = the free seat runs; an expired stored key
  // actively blocks. The skill must carry both halves — a reader hitting
  // "API key has expired" should remove/renew, never add blindly.
  assert.match(skill, /WITHOUT any stored opencode credential/,
    'the skill must state the seat runs keyless')
  assert.match(skill, /EXPIRED key stored there actively blocks/,
    'the skill must state an expired key is an active block, not an absence')
  assert.match(skill, /remove or renew the stored key, never to add one blindly/)
  assert.match(skill, /never routed to another family/,
    'an unmeasured family swap changes the answer\'s provenance and must be forbidden')
})
