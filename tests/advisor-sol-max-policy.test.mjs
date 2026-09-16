import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const skill = readFileSync(new URL('../plugins/tmux-teams/skills/codex-advisor/SKILL.md', import.meta.url), 'utf8');

test('codex-advisor documents Sol max while Luna remains ultra', () => {
  assert.match(skill, /\| `sol` \| `gpt-5\.6-sol` \| `max` \|/);
  assert.match(skill, /\| `luna` \| `gpt-5\.6-luna` \| `ultra` \|/);
  assert.match(skill, /ACP_MODEL="gpt-5\.6-sol"[\s\S]*ACP_REASONING_EFFORT="max"[\s\S]*ACP_EXPECT_REASONING_EFFORT="max"/);
  assert.match(skill, /effective_identity: gpt-5\.6-sol\[max\]/);
});
