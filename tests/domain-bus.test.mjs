import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createProjection, EVERY_EVENT } from '../plugins/tmux-teams/skills/tmux-teams/scripts/domain-bus.mjs'
import { displayDomain } from '../plugins/tmux-teams/skills/tmux-teams/scripts/domain-display.mjs'

const recorder = (events) => ({
  events,
  init: () => ({ seen: [] }),
  on: (state, event) => ({ seen: [...state.seen, event.event] }),
})

const ev = (event, over = {}) => ({ event, work_item: 'w1', ...over })

test('a subscriber never sees an event it did not declare', () => {
  // The load-bearing invariant of "N subscribers". Without it every domain is
  // handed the whole log and "who reacts to what" becomes a comment rather than
  // a mechanism — which is the state the rebuild is undoing.
  const bus = createProjection({
    team: recorder(['pulled', 'completed']),
    workflow: recorder(['opened', 'completed']),
  })
  bus.replay([ev('opened'), ev('pulled'), ev('assigned'), ev('completed')])
  assert.deepEqual(bus.stateOf('team').seen, ['pulled', 'completed'])
  assert.deepEqual(bus.stateOf('workflow').seen, ['opened', 'completed'])
})

test('the declared subscription is inspectable, so a test can hold a domain to it', () => {
  const bus = createProjection({ team: recorder(['pulled', 'intake']), display: displayDomain() })
  assert.deepEqual(bus.subscriptionOf('team'), ['intake', 'pulled'])
  assert.equal(bus.subscriptionOf('display'), EVERY_EVENT)
})

test('fan-out follows declaration order, every time', () => {
  const order = []
  const spy = (name) => ({ events: EVERY_EVENT, init: () => null, on: () => { order.push(name); return null } })
  createProjection({ first: spy('first'), second: spy('second'), third: spy('third') })
    .publish(ev('pulled')).publish(ev('delivered'))
  assert.deepEqual(order, ['first', 'second', 'third', 'first', 'second', 'third'])
})

test('replaying the same log twice gives the same state', () => {
  // The whole reason the ledger can stay the only store: state is a projection,
  // so a crash costs nothing that a replay cannot rebuild.
  const log = [ev('opened'), ev('pulled'), ev('delivered'), ev('completed')]
  const build = () => createProjection({ team: recorder(EVERY_EVENT) }).replay(log).stateOf('team')
  assert.deepEqual(build(), build())
})

test('an event with no ledger word is refused, not silently dropped', () => {
  const bus = createProjection({ team: recorder(EVERY_EVENT) })
  assert.throws(() => bus.publish({ work_item: 'w1' }), /without a ledger word/)
  assert.throws(() => bus.publish({ event: '', work_item: 'w1' }), /without a ledger word/)
  assert.deepEqual(bus.stateOf('team').seen, [])
})

test('a malformed subscriber is refused at construction, not at the first event', () => {
  assert.throws(() => createProjection({}), /no subscriber/)
  assert.throws(() => createProjection({ x: { events: ['pulled'], init: () => null } }), /needs an `on`/)
  assert.throws(() => createProjection({ x: { events: ['pulled'], on: () => null } }), /needs an `init`/)
  assert.throws(() => createProjection({ x: { events: 'pulled', init: () => null, on: () => null } }),
    /must be an array/)
})

test('delivery counts are evidence, not a guess', () => {
  const bus = createProjection({ team: recorder(['pulled']), display: displayDomain() })
  bus.replay([ev('opened'), ev('pulled'), ev('assigned')])
  assert.deepEqual(bus.deliveryCounts(), { team: 1, display: 3 })
})

test('display reacts to everything and offers nothing a scheduler could branch on', () => {
  // "Decides nothing" is enforced by having nothing to read. A version and the
  // last word cannot answer "may this dispatch proceed", which is the question
  // that made the published page a dependency of the loop.
  const bus = createProjection({ display: displayDomain() })
  bus.replay([ev('opened'), ev('pulled'), ev('audited')])
  const state = bus.stateOf('display')
  assert.deepEqual(Object.keys(state).sort(), ['lastWord', 'version'])
  assert.equal(state.version, 3)
  assert.equal(state.lastWord, 'audited')
})

test('a reducer cannot mutate the event it was handed', () => {
  const vandal = {
    events: EVERY_EVENT,
    init: () => ({ tried: false }),
    on: (state, event) => {
      assert.throws(() => { event.work_item = 'stolen' }, TypeError)
      return { tried: true }
    },
  }
  const bus = createProjection({ vandal })
  const event = ev('pulled')
  bus.publish(event)
  assert.equal(bus.stateOf('vandal').tried, true)
  assert.equal(event.work_item, 'w1')
})
