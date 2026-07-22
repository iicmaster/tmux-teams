import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseLsofCwd,
  parsePgrep,
  parsePsCandidates,
} from '../plugins/tmux-teams/skills/tmux-teams/scripts/pulse-platform.mjs'

test('parseLsofCwd extracts the cwd name field from real lsof shape', () => {
  assert.equal(parseLsofCwd('p123\nfcwd\nn/Users/me/repo\n'), '/Users/me/repo')
  assert.equal(parseLsofCwd('p123\r\nfcwd\r\nn/Users/me/repo\r\n'), '/Users/me/repo')
  assert.equal(parseLsofCwd('p123\nfcwd\n'), null)
  assert.equal(parseLsofCwd('n\n'), null)
})

test('parsePgrep distinguishes child pid output from an empty result', () => {
  assert.equal(parsePgrep('4312\n4313\n'), true)
  assert.equal(parsePgrep('\n  \n'), false)
  assert.equal(parsePgrep(''), false)
})

test('parsePsCandidates keeps only ACP companion command lines', () => {
  const out = [
    '  101 /usr/bin/node pulse.mjs once /repo',
    '  202 node /plugin/acp-companion.mjs codex /repo task-a /tmp/brief',
    '303 /usr/bin/node /plugin/acp-companion.mjs claude /repo task-b /tmp/brief',
    '  404 grep acp-companion',
    '',
  ].join('\n')
  assert.deepEqual(parsePsCandidates(out), [
    { pid: '202', cmdline: 'node /plugin/acp-companion.mjs codex /repo task-a /tmp/brief' },
    { pid: '303', cmdline: '/usr/bin/node /plugin/acp-companion.mjs claude /repo task-b /tmp/brief' },
  ])
})
