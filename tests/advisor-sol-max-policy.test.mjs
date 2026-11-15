import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const skill = readFileSync(new URL('../plugins/tmux-teams/skills/codex-advisor/SKILL.md', import.meta.url), 'utf8');
const agySkill = readFileSync(new URL('../plugins/tmux-teams/skills/agy-advisor/SKILL.md', import.meta.url), 'utf8');
const claudeMd = readFileSync(new URL('../CLAUDE.md', import.meta.url), 'utf8');
const tmuxSkill = readFileSync(new URL('../plugins/tmux-teams/skills/tmux-teams/SKILL.md', import.meta.url), 'utf8');

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

test('agy-advisor documents Gemini 4 Carbon default and Carbon / Argon / Hydrogen / Orchestrator / 3.8 Flash seats', () => {
  assert.match(agySkill, /\$agy-advisor\s+# default seat: gemini-4-carbon-high/);
  assert.match(agySkill, /\$agy-advisor high\s+# gemini-4-carbon-high/);
  assert.match(agySkill, /\$agy-advisor medium\s+# gemini-4-carbon-medium/);
  assert.match(agySkill, /\$agy-advisor low\s+# gemini-4-carbon-low/);
  assert.match(agySkill, /\$agy-advisor carbon-high\s+# gemini-4-carbon-high/);
  assert.match(agySkill, /\$agy-advisor carbon-medium\s+# gemini-4-carbon-medium/);
  assert.match(agySkill, /\$agy-advisor carbon-low\s+# gemini-4-carbon-low/);
  assert.match(agySkill, /\$agy-advisor argon-high\s+# gemini-4-argon-high/);
  assert.match(agySkill, /\$agy-advisor argon-medium\s+# gemini-4-argon-medium/);
  assert.match(agySkill, /\$agy-advisor argon-low\s+# gemini-4-argon-low/);
  assert.match(agySkill, /\$agy-advisor hydrogen-xhigh\s+# gemini-4-hydrogen-xhigh/);
  assert.match(agySkill, /\$agy-advisor hydrogen-high\s+# gemini-4-hydrogen-high/);
  assert.match(agySkill, /\$agy-advisor hydrogen-medium\s+# gemini-4-hydrogen-medium/);
  assert.match(agySkill, /\$agy-advisor hydrogen-low\s+# gemini-4-hydrogen-low/);
  assert.match(agySkill, /\$agy-advisor orchestrator\s+# gemini-pro-orchestrator/);
  assert.match(agySkill, /\$agy-advisor orchestrator-argon\s+# gemini-pro-orchestrator-argon/);
  assert.match(agySkill, /\$agy-advisor flash-high\s+# gemini-3\.8-flash-high/);
  assert.match(agySkill, /\$agy-advisor flash-medium\s+# gemini-3\.8-flash-medium/);
  assert.match(agySkill, /\$agy-advisor flash-low\s+# gemini-3\.8-flash-low/);
  assert.match(agySkill, /effective_identity: gemini-4-carbon-high \(matched\)/);
});

test('CLAUDE.md and tmux-teams SKILL.md document gemini-4-hydrogen-high worker and gemini-4-carbon-high thinker defaults', () => {
  assert.match(claudeMd, /gemini-4-carbon-high/);
  assert.match(claudeMd, /gemini-4-hydrogen-high/);
  assert.match(claudeMd, /gemini-pro-orchestrator-argon/);
  assert.match(tmuxSkill, /Worker \/ execution default: `gemini-4-hydrogen-high`/);
  assert.match(tmuxSkill, /Thinker \/ evaluator \/ `\$agy-advisor` recommended default: `gemini-4-carbon-high`/);
});
