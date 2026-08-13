// The `display` subscriber — reads everything, decides nothing.
//
// It is small on purpose. Its column in the subscription table says "redraw" for
// all seventeen words and nothing else, and that emptiness IS the rule: the one
// thing this design must not break is a display that gates work. Today it does —
// the loop reads a published page, so a stale page refuses every dispatch, and
// the dependency runs `display -> scheduler` when it must run `run -> scheduler`.
//
// So this module exposes a version and a count, and deliberately exposes no
// question a scheduler could ask. There is nothing here to read that could
// decide anything, which is the only version of "decides nothing" that a future
// change cannot quietly undo.

import { EVERY_EVENT } from './domain-bus.mjs'

export function displayDomain() {
  return {
    events: EVERY_EVENT,
    init: () => ({ version: 0, lastWord: null }),
    on(state, event) {
      return { version: state.version + 1, lastWord: event.event }
    },
  }
}

/** Has anything changed since the version a renderer last drew? */
export function needsRedraw(state, drawnVersion) {
  return state.version !== drawnVersion
}
