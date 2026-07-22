import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKFLOW = readFileSync(join(
  HERE, '..', 'plugins', 'tmux-teams', 'skills', 'tmux-teams', 'workflows', 'mailbox-run.js'
), 'utf8')

test('tmux mailbox owns one dispatch UUID outside the lifecycle agent and threads it into footprint and KMS', () => {
  assert.match(WORKFLOW, /import \{ randomUUID \} from 'node:crypto'/)
  assert.match(WORKFLOW, /WORKER_DISPATCH_IDS = new Map\(WORKERS\.map\(w => \[w\.id, randomUUID\(\)\]\)\)/)
  assert.match(WORKFLOW, /Dispatch id \(PM-owned; copy exactly\): \$\{dispatchId\}/)
  assert.match(WORKFLOW, /Set DISPATCH_ID='\$\{dispatchId\}' exactly once/)
  assert.match(WORKFLOW, /printf 'dispatch_id: %s\\\\ntask_id: %s/)
  assert.match(WORKFLOW, /"\$DISPATCH_ID" "\$\{w\.id\}"/)
  assert.doesNotMatch(WORKFLOW, /life\.dispatch_id/)
  assert.match(WORKFLOW, /dispatch_id: dispatchId/)
  assert.match(WORKFLOW, /dispatch_id: WORKER_DISPATCH_IDS\.get\(w\.id\)/)
  assert.match(WORKFLOW, /dispatch_id \/ task_id \/ worker \/ transport/)
  assert.match(WORKFLOW, /dispatch_id=\$\{r\.dispatch_id \|\| '""'\} task_id=\$\{r\.id\}/)
})

test('dispatch correlation is additive to legacy task-id paths and markers', () => {
  assert.match(WORKFLOW, /\.tmux-teams\/dispatch\/\$\{w\.id\}\.md/)
  assert.match(WORKFLOW, /\.mailbox-out\/\$\{w\.id\}/)
  assert.match(WORKFLOW, /TEAM_DONE \$\{id\}/)
  assert.match(WORKFLOW, /TEAM_BLOCKED \$\{id\}/)
  assert.match(WORKFLOW, /TEAM_FAILED \$\{id\}/)
})
