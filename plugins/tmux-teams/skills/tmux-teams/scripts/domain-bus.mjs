// One publisher, N subscribers — the mechanism, with no domain knowledge in it.
//
// The publisher is the ledger. It already is one: `appendEvent` is the single
// write door and nothing writes `work-items/` around it. So this module does not
// invent a queue, a store, a daemon or a second vocabulary; it takes the events
// the ledger already records, in the order it already records them, and hands
// each one only to the domains that declared an interest.
//
// Subscribers are REDUCERS, not listeners. A reducer returns the next state and
// touches nothing else, which is what makes the whole projection replayable from
// a durable log: feed the same events in the same order and you get the same
// answer, on any machine, after any crash. A listener that mutates the world
// would give that up for nothing.
//
// The one rule this must not break: `display` may subscribe to everything and
// decide nothing. The bus cannot enforce what a caller does with a projection,
// but it CAN enforce the half that is mechanical — a domain never sees an event
// it did not declare — and `subscriptionOf` makes the declaration inspectable so
// a test can hold a domain to its column in the table.

const ALL = '*'

const frozenCopy = (value) => (typeof value === 'object' && value !== null ? Object.freeze(value) : value)

/**
 * @param {Record<string, {events: string[]|'*', init: () => any, on: (state, event) => any}>} domains
 */
export function createProjection(domains) {
  const names = Object.keys(domains)
  if (names.length === 0) throw new Error('a projection with no subscriber is not a projection')

  const wanted = new Map()
  const state = new Map()
  const seen = new Map(names.map((name) => [name, 0]))

  for (const name of names) {
    const domain = domains[name]
    if (typeof domain?.on !== 'function') throw new Error(`${name}: a subscriber needs an \`on\` reducer`)
    if (typeof domain?.init !== 'function') throw new Error(`${name}: a subscriber needs an \`init\``)
    if (domain.events !== ALL && !Array.isArray(domain.events)) {
      throw new Error(`${name}: \`events\` must be an array of ledger words, or '*'`)
    }
    wanted.set(name, domain.events === ALL ? ALL : new Set(domain.events))
    state.set(name, domain.init())
  }

  const listens = (name, event) => {
    const set = wanted.get(name)
    return set === ALL || set.has(event)
  }

  return {
    /** Publish one ledger event. Fan-out order is declaration order, always. */
    publish(event) {
      const word = event?.event
      if (typeof word !== 'string' || word === '') {
        throw new Error('an event without a ledger word cannot be published')
      }
      const frozen = frozenCopy(event)
      for (const name of names) {
        if (!listens(name, word)) continue
        state.set(name, domains[name].on(state.get(name), frozen))
        seen.set(name, seen.get(name) + 1)
      }
      return this
    },

    /** Replay a whole log. Same result as publishing each in turn. */
    replay(events) {
      for (const event of events) this.publish(event)
      return this
    },

    stateOf(name) {
      if (!state.has(name)) throw new Error(`no subscriber named ${name}`)
      return state.get(name)
    },

    /** What this domain declared. A test can hold it to its column in the table. */
    subscriptionOf(name) {
      const set = wanted.get(name)
      if (set === undefined) throw new Error(`no subscriber named ${name}`)
      return set === ALL ? ALL : [...set].sort()
    },

    /** How many events each domain actually received — evidence, not a guess. */
    deliveryCounts() {
      return Object.fromEntries(seen)
    },

    subscribers() {
      return [...names]
    },
  }
}

export const EVERY_EVENT = ALL
