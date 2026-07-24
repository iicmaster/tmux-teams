import { reservePhaseGateDispatch } from '../../plugins/tmux-teams/skills/tmux-teams/scripts/phase-gate-controller.mjs'

const [repo, brief, task] = process.argv.slice(2)
process.send?.({ ready: true })
process.on('message', (message) => {
  if (message !== 'go') return
  try {
    const result = reservePhaseGateDispatch(repo, {
      bootstrap: true, task_id: task, agent_id: 'mock', brief_file: brief, timeout_sec: 30,
    })
    process.send?.({ ok: true, dispatch_uuid: result.dispatch_uuid })
  } catch (cause) {
    process.send?.({ ok: false, code: cause.code, errors: cause.errors })
  } finally {
    process.disconnect?.()
  }
})
