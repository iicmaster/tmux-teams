import { acquirePhaseGateLock } from '../../plugins/tmux-teams/skills/tmux-teams/scripts/phase-gate-store.mjs'

const store = process.argv[2]
const handle = acquirePhaseGateLock(store)
process.stdout.write(`${JSON.stringify({ ready: true, pid: process.pid })}\n`)
const timer = setInterval(() => {}, 1000)
process.once('SIGTERM', () => {
  clearInterval(timer)
  try { handle.release() } finally { process.exit(0) }
})
