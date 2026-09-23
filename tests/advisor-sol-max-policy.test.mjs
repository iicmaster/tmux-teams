import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const skill = readFileSync(new URL('../plugins/tmux-teams/skills/codex-advisor/SKILL.md', import.meta.url), 'utf8');

test('codex-advisor documents model effort tiers and derived dispatch', () => {
  assert.match(skill, /\| `sol` \| `gpt-6-sol` \| `max` \|/);
  assert.match(skill, /\| `terra` \| `gpt-5\.6-terra` \| `max` \|/);
  assert.match(skill, /\| `luna` \| `gpt-6-luna` \| `ultra` \|/);
  assert.match(skill, /\| `astra` \| `gpt-6-astra` \| `ultra` \|/);
  assert.match(skill, /ACP_MODEL="<model>"[\s\S]*ACP_REASONING_EFFORT="<effort>"[\s\S]*ACP_EXPECT_REASONING_EFFORT="<effort>"/);
  assert.match(skill, /gpt-6-sol\[max\]/);
});
