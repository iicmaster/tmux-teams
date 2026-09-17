import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const skill=readFileSync(new URL('../plugins/tmux-teams/skills/codex-advisor/SKILL.md',import.meta.url),'utf8');
test('codex-advisor requires nonblocking background collection',()=>{
  assert.match(skill,/wait[\s\S]{0,300}run_in_background/i);
  assert.match(skill,/continue (coordinating|other work|working).*while.*runs/is);
  assert.match(skill,/do not.*foreground.*wait/is);
  assert.match(skill,/notification[\s\S]*read the outbox[\s\S]*receipt/i);
  assert.match(skill,/no_outbox[\s\S]*same task id/i);
});
