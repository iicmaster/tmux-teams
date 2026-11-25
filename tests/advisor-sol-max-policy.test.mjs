import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const skill = readFileSync(new URL('../plugins/tmux-teams/skills/codex-advisor/SKILL.md', import.meta.url), 'utf8');
const agySkill = readFileSync(new URL('../plugins/tmux-teams/skills/agy-advisor/SKILL.md', import.meta.url), 'utf8');
const claudeMd = readFileSync(new URL('../CLAUDE.md', import.meta.url), 'utf8');
const tmuxSkill = readFileSync(new URL('../plugins/tmux-teams/skills/tmux-teams/SKILL.md', import.meta.url), 'utf8');

test('codex-advisor documents model effort tiers and derived dispatch', () => {
  assert.match(skill, /\| `sol` \| `gpt-6\.2-sol` \| `ultra` \|/);
  assert.doesNotMatch(skill, /\| `terra` \|/);
  assert.doesNotMatch(skill, /gpt-5/);
  assert.match(skill, /\| `luna` \| `gpt-6-luna` \| `max` \|/);
  assert.doesNotMatch(skill, /gpt-6-luna\[ultra\]/);
  assert.match(skill, /\| `astra` \| `gpt-6\.2-astra` \| `ultra` \|/);
  assert.match(skill, /ACP_MODEL="<model>"[\s\S]*ACP_REASONING_EFFORT="<effort>"[\s\S]*ACP_EXPECT_REASONING_EFFORT="<effort>"/);
  assert.match(skill, /gpt-6\.2-sol\[ultra\]/);
  const lines = skill.split('\n')
  const noteStart = lines.findIndex(line => line.startsWith('**Retired generations'))
  assert.notEqual(noteStart, -1, 'the retired-generations note is missing')
  const noteLines = new Set([noteStart, noteStart + 1, noteStart + 2])
  const oldId = /gpt-6(?:[._-]?[01])?[._-]?(?:sol|astra)/
  for (const [index, line] of lines.entries()) {
    if (oldId.test(line)) assert.ok(noteLines.has(index), `retired id outside the note at line ${index + 1}: ${line}`)
  }
  assert.match(lines[noteStart + 2] ?? '', /gpt-6\.1-astra/, 'the retired note lost its astra entry')
  assert.match(skill, /every pre-6\.2 `sol`\/`astra` id/);
  // Master, 2026-11-19: the lock is a per-family version floor.
  assert.match(skill, /- `sol` \/ `astra`: `6\.2` or newer/);
  assert.match(skill, /- `terra`: `6\.1` or newer/);
  assert.match(skill, /- `luna`: `6` or newer/);
  assert.match(skill, /- `fable` \(Claude routes\): `5\.2` or newer/);
  assert.match(skill, /edit its digits in all three copies together/);
});

test('agy-advisor documents the Neon orchestrator default and Neon / Carbon / Argon / Hydrogen / Orchestrator / 3.8 Flash seats', () => {
  assert.match(agySkill, /\$agy-advisor\s+# default seat: gemini-pro-orchestrator-neon \(via `default thinker`\)/);
  assert.match(agySkill, /node <plugin-root>\/skills\/tmux-teams\/scripts\/agy-seat-fallback\.mjs default thinker/);
  assert.match(agySkill, /A seat the caller NAMED is used as written and never resolved over\./);
  assert.match(agySkill, /\$agy-advisor orchestrator-neon\s+# gemini-pro-orchestrator-neon/);
  for (const tier of ['xhigh', 'high', 'medium', 'low']) {
    assert.match(agySkill, new RegExp(`\\$agy-advisor neon-${tier}\\s+# gemini-4-neon-${tier}`));
  }
  assert.match(agySkill, /prints `gemini-4-hydrogen-xhigh` \(thinker;/);
  assert.match(agySkill, /`default worker` prints `gemini-4-hydrogen-medium`/);
  assert.match(agySkill, /\$agy-advisor high\s+# gemini-4-carbon-high/);
  assert.match(agySkill, /\$agy-advisor medium\s+# gemini-4-carbon-medium/);
  assert.match(agySkill, /\$agy-advisor low\s+# gemini-4-carbon-low/);
  assert.match(agySkill, /\$agy-advisor carbon\s+# gemini-4-carbon-high/);
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

test('CLAUDE.md and tmux-teams SKILL.md document the Neon orchestrator default for every AGY role and its hydrogen fallbacks', () => {
  assert.match(claudeMd, /\*\*Every AGY role defaults to `gemini-pro-orchestrator-neon`\*\*/);
  assert.match(claudeMd, /thinker\/advisor\/review gate fall back to\s+`gemini-4-hydrogen-xhigh` and workers to `gemini-4-hydrogen-medium`/);
  assert.match(claudeMd, /gemini-pro-orchestrator-argon/);
  assert.match(claudeMd, /Floors: fable `5\.2` \(bare `fable` refused\), Codex sol\/astra\s+`6\.2`, terra `6\.1`, luna `6`/);
  assert.match(tmuxSkill, /Default for EVERY role \(worker \/ execution, thinker \/ evaluator, `\$agy-advisor`\):\s+`gemini-pro-orchestrator-neon`/);
  assert.match(tmuxSkill, /worker →\s+`gemini-4-hydrogen-medium`, thinker \/ evaluator \/ advisor \/ review gate →\s+`gemini-4-hydrogen-xhigh`/);
});
