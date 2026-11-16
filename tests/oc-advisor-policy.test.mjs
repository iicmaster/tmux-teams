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
    // The id is a placeholder now that the seat has a fallback: a block that
    // hardcodes ONE id cannot express "dispatch the seat you chose" and would
    // send a resumed session to a different model than the one holding it.
    assert.match(block, /ACP_MODEL="<model>"/,
      `a block that does not take the seat from the chosen one:\n${block.slice(0, 400)}`)
    assert.match(block, /ACP_EXPECT_MODEL="<model>"/,
      `a request without a matching expectation is a dispatch nobody verified:\n${block.slice(0, 400)}`)
  }
})

test('the default seat and its one-hop fallback are both pinned, and the ladder is explicit', () => {
  // Measured 2026-11-09 against opencode acp 1.18.21: both ids are advertised
  // in configOptions and accepted by session/set_config_option. The DEFAULT is
  // minimax; deepseek is the fallback and must not be described as a
  // preference, or a weak answer becomes a silent seat change.
  assert.match(skill, /default seat is opencode\/minimax-m3\.1-flash-free/,
    'the frontmatter no longer states the default seat')
  assert.match(skill, /opencode\/deepseek-v4\.1-flash-free as its one-hop fallback/,
    'the frontmatter no longer states the fallback seat')
  assert.match(skill, /\| \*\(omitted\)\* \| `opencode\/minimax-m3\.1-flash-free` \|/,
    'the arguments table no longer pins the default seat')
  assert.match(skill, /\| `deepseek` \| `opencode\/deepseek-v4\.1-flash-free` \|/,
    'the arguments table no longer pins the fallback alias')
  assert.match(skill, /`deepseek` is the fallback, not a preference/,
    'the ladder must say the fallback is not a preference')
  assert.match(skill, /\*\*One hop only, inside these two seats\.\*\*/, 'the ladder has no ceiling')
  assert.match(skill, /Label the answer with\s+the seat that produced it/,
    'a consultation that quietly changed seats is the same lie as a wrong identity')
  assert.doesNotMatch(skill, /opencode\/deepseek-v4\.1-flash-free.*default seat/i,
    'deepseek is described as the default seat again')
  assert.doesNotMatch(skill, /reaches the deepseek family/i,
    'intro prose still names deepseek as the default family')
})

// The release round-table (ocseat-review1) found three P1 holes in the first
// ladder wording: a pending identity read as a refusal, a catch-all pre-prompt
// refusal that let profile/config faults move the seat, and a denied outbox
// write that could still trigger entry 3. Each is pinned here — a rule the
// prose states but no test holds is the same unenforced claim in one file
// instead of two.
test('the ladder cannot be entered on stale, pending, or policy-caused evidence', () => {
  assert.match(skill, /never hop on a pending value/i,
    'a pending identity can still be read as a terminal refusal')
  assert.match(skill, /Other\s+pre-prompt refusals \(profile\/config\/receipt-path\/boot failures\) are NOT\s+ladder evidence/,
    'a catch-all pre-prompt refusal still moves the seat')
  assert.match(skill, /A denied outbox\s+write outranks the repeat rule: it is never a ladder entry/,
    'a permission-denied outbox write can still be counted as entry 3')
  assert.match(skill, /failed LOAD[\s\S]{0,120}Not a second `no_outbox`/,
    'a load_failed resume can still be counted as entry 3')
  assert.match(skill, /generic `session\/prompt` error[\s\S]{0,160}Never hop, never call it quota/,
    'a generic provider error can still be called quota and hopped on')
  assert.match(skill, /never change the seat to work around it/,
    'a profile refusal can still be worked around by switching seats')
})

test('the skill does not claim an answer layer it has not measured', () => {
  // The receipt is committed before session/prompt, so `succeeded` describes
  // the session/config layer. Saying "measured end to end" next to a receipt
  // claim is exactly what a reader takes as "the advisor answers".
  assert.doesNotMatch(skill, /fresh-dispatch path is\s+measured end to end/,
    'the skill claims an end-to-end measurement it does not have')
  assert.match(skill, /answer layer\s+is NOT measured/,
    'the skill must state which layer is unmeasured')
  assert.match(skill, /Do not read a matched\s+receipt as a working answer/,
    'the receipt-vs-answer distinction is not stated')
  assert.match(skill, /does not attest\s+`ACP_PERMISSIONS`/,
    'the receipt is described as attesting the deny policy')
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
  assert.match(skill, /changes the answer's provenance and is\s+forbidden/,
    'an unmeasured family swap changes the answer\'s provenance and must be forbidden')
})
