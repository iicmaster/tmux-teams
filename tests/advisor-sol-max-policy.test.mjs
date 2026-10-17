import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const skill = readFileSync(new URL('../plugins/tmux-teams/skills/codex-advisor/SKILL.md', import.meta.url), 'utf8');
const agySkill = readFileSync(new URL('../plugins/tmux-teams/skills/agy-advisor/SKILL.md', import.meta.url), 'utf8');

test('codex-advisor documents model effort tiers and derived dispatch', () => {
  assert.match(skill, /\| `sol` \| `gpt-6\.1-sol` \| `ultra` \|/);
  assert.doesNotMatch(skill, /\| `terra` \|/);
  assert.doesNotMatch(skill, /gpt-5/);
  assert.match(skill, /\| `luna` \| `gpt-6-luna` \| `max` \|/);
  assert.doesNotMatch(skill, /gpt-6-luna\[ultra\]/);
  assert.match(skill, /\| `astra` \| `gpt-6-astra` \| `ultra` \|/);
  assert.match(skill, /ACP_MODEL="<model>"[\s\S]*ACP_REASONING_EFFORT="<effort>"[\s\S]*ACP_EXPECT_REASONING_EFFORT="<effort>"/);
  assert.match(skill, /gpt-6\.1-sol\[ultra\]/);
  assert.doesNotMatch(skill, /gpt-6-sol/);
});

test('agy-advisor documents Gemini 4 Argon default and Gemini 4 / 3.8 Flash seats', () => {
  assert.match(agySkill, /\$agy-advisor\s+# default seat: gemini-4-argon-high/);
  assert.match(agySkill, /\$agy-advisor high\s+# gemini-4-argon-high/);
  assert.match(agySkill, /\$agy-advisor medium\s+# gemini-4-argon-medium/);
  assert.match(agySkill, /\$agy-advisor low\s+# gemini-4-argon-low/);
  assert.match(agySkill, /\$agy-advisor flash-high\s+# gemini-3\.8-flash-high/);
  assert.match(agySkill, /\$agy-advisor flash-medium\s+# gemini-3\.8-flash-medium/);
  assert.match(agySkill, /\$agy-advisor flash-low\s+# gemini-3\.8-flash-low/);
  assert.match(agySkill, /effective_identity: gemini-4-argon-high \(matched\)/);
});
