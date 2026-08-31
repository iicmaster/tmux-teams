// A stub ACP agent for exercising `realProbeTransport` without contacting a
// provider. STUB_MODE picks the shape:
//
//   ok       answers initialize, session/new and session/prompt
//   quota    answers the handshake, then refuses the PROMPT the way an
//            exhausted provider does — 429 on stderr and no reply
//   noisy    prints quota-shaped words on stderr and answers anyway, which is
//            REACHABLE: a lane that answered is not a lane that refused
//   silent   never answers anything -- not even `initialize`, so the adapter
//            never proves it started and this is the BOOT budget's shape
//   mute     answers the handshake and then never answers the PROMPT, and does
//            not exit: the adapter is demonstrably up and the endpoint has gone
//            quiet. This is the REPLY budget's shape, and it is the only stub
//            that can tell the two budgets apart -- delete the rearm and this
//            one rides the boot budget instead, which is exactly the bug the
//            split fixes.
import { createInterface } from 'node:readline'
import { appendFileSync } from 'node:fs'

const mode = process.env.STUB_MODE ?? 'ok'
if (mode === 'noisy') process.stderr.write('warn: approaching your rate limit\n')

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  let message
  try { message = JSON.parse(line) } catch { return }
  // STUB_LOG records the METHODS this agent was actually asked, one per line.
  // It is the only way to prove a negative that matters here — that handshake
  // depth sent no `session/prompt` — because a caller cannot see from the
  // outside whether a prompt was skipped or merely answered quickly, and a
  // prompt is the thing a provider bills for.
  if (process.env.STUB_LOG && typeof message.method === 'string') {
    appendFileSync(process.env.STUB_LOG, `${message.method}\n`)
  }
  if (mode === 'silent') return
  const reply = (result) => process.stdout.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`)
  if (message.method === 'initialize') reply({ protocolVersion: 1, agentCapabilities: {} })
  else if (message.method === 'session/new') reply({ sessionId: 'stub-session' })
  else if (message.method === 'session/prompt') {
    if (mode === 'quota') {
      process.stderr.write('Error 429: you have exhausted your quota for today\n')
      process.exit(1)
    }
    if (mode === 'mute') return
    reply({ stopReason: 'end_turn' })
  }
})
