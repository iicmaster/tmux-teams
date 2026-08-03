// CSP-safe browser controller shared by pulse.html and graph.html.
// Pulse publishes this source as a content-addressed same-origin asset.

export const PULSE_REFRESH_SOURCE = `
(() => {
  // The browser's own scroll restoration on reload runs on top of the
  // capture()/restore() below rather than instead of it, so a reload could
  // apply both and settle a frame later than the manual one, reading as a
  // second, smaller jump right after the first. This page owns restoring its
  // own position; the browser's guess is not needed.
  try { if (history.scrollRestoration) history.scrollRestoration = 'manual' } catch { /* not fatal */ }
  const body = document.body
  const marker = document.querySelector('meta[name="tmux-teams-snapshot-id"]')
  const initialSnapshotId = marker?.content || ''
  // The hash of the page as it was when this script first saw the marker. Only
  // a change to THIS file is a reason to reload it.
  let pageDigest = null
  // The last marker this page saw. A new one is proof the publisher is alive,
  // whether or not anything on the board moved.
  let lastSeen = initialSnapshotId
  const header = document.querySelector('[data-observation-expires-at]')
  const toggle = document.querySelector('[data-refresh-toggle]')
  const status = document.querySelector('[data-refresh-status]')
  const note = document.querySelector('[data-refresh-note]')
  const intervalMs = Math.max(1000, Number(body?.dataset.refreshInterval || header?.dataset.refreshInterval || 20) * 1000)
  const storageKey = 'tmux-teams:pulse-refresh:' + location.pathname
  const pauseKey = storageKey + ':paused'
  let expiryTimer = 0
  let pollInFlight = false
  let paused = false

  const read = (key) => {
    try { return sessionStorage.getItem(key) } catch { return null }
  }
  const write = (key, value) => {
    try { sessionStorage.setItem(key, value) } catch { /* storage is optional */ }
  }
  const setRefreshStatus = (text, state) => {
    if (status) status.textContent = text
    if (note) {
      note.textContent = state === 'degraded'
        ? 'The local snapshot marker could not be read or verified'
        : state === 'stale'
          ? 'Snapshot expiry has passed'
          : 'Polling the local snapshot marker'
    }
    if (body) body.dataset.refreshState = state
  }
  const updateFreshness = () => {
    if (expiryTimer) clearTimeout(expiryTimer)
    const expiry = Date.parse(header?.dataset.observationExpiresAt || '')
    if (!Number.isFinite(expiry)) {
      if (body) body.dataset.observationFreshness = 'unknown'
      setRefreshStatus('Freshness unknown', 'unknown')
      return
    }
    const stale = Date.now() >= expiry
    if (body) body.dataset.observationFreshness = stale ? 'stale' : 'fresh'
    setRefreshStatus(stale ? 'Snapshot expired' : 'Snapshot fresh', stale ? 'stale' : 'fresh')
    if (!stale) expiryTimer = setTimeout(updateFreshness, Math.min(expiry - Date.now() + 25, 2147000000))
  }
  const detailsKey = (detail, index) => detail.dataset.refreshDetailsKey ||
    detail.dataset.persistKey || detail.id || 'details-' + index
  const selectorValue = (value) => {
    if (globalThis.CSS && typeof CSS.escape === 'function') return CSS.escape(value)
    return String(value).replace(/[^A-Za-z0-9_-]/g, (character) => '\\\\' + character)
  }
  const capture = () => {
    const active = document.activeElement
    const state = {
      page_x: window.scrollX,
      page_y: window.scrollY,
      scroll_regions: [...document.querySelectorAll('[data-refresh-scroll-key]')].map((region) => ({
        key: region.dataset.refreshScrollKey,
        x: region.scrollLeft,
        y: region.scrollTop,
      })),
      details: [...document.querySelectorAll('details')].map((detail, index) => ({
        key: detailsKey(detail, index), open: detail.open,
      })),
      focus: active && active !== document.body ? {
        id: active.id || null,
        focus_key: active.dataset?.refreshFocusKey || null,
        persist_key: active.dataset?.persistKey || null,
        agent_id: active.dataset?.agentId || null,
      } : null,
    }
    write(storageKey, JSON.stringify(state))
  }
  const restore = () => {
    let state = null
    try { state = JSON.parse(read(storageKey) || 'null') } catch { state = null }
    if (!state || typeof state !== 'object') return
    for (const [index, detail] of [...document.querySelectorAll('details')].entries()) {
      const saved = state.details?.find((item) => item.key === detailsKey(detail, index))
      if (saved) detail.open = saved.open === true
    }
    if (Number.isFinite(state.page_x) && Number.isFinite(state.page_y)) window.scrollTo(state.page_x, state.page_y)
    for (const saved of Array.isArray(state.scroll_regions) ? state.scroll_regions : []) {
      if (typeof saved.key !== 'string') continue
      const region = document.querySelector('[data-refresh-scroll-key="' + selectorValue(saved.key) + '"]')
      if (!region) continue
      if (Number.isFinite(saved.x)) region.scrollLeft = saved.x
      if (Number.isFinite(saved.y)) region.scrollTop = saved.y
    }
    const focus = state.focus
    const target = focus?.focus_key
      ? document.querySelector('[data-refresh-focus-key="' + selectorValue(focus.focus_key) + '"]')
      : focus?.id ? document.getElementById(focus.id)
        : focus?.agent_id ? document.querySelector('[data-agent-id="' + selectorValue(focus.agent_id) + '"]')
          : null
    if (target && typeof target.focus === 'function') target.focus({ preventScroll: true })
  }
  const saveDetails = () => {
    for (const [index, detail] of [...document.querySelectorAll('details')].entries()) {
      detail.addEventListener('toggle', () => {
        let state = null
        try { state = JSON.parse(read(storageKey) || '{}') } catch { state = {} }
        state.details = Array.isArray(state.details) ? state.details : []
        const key = detailsKey(detail, index)
        const existing = state.details.find((item) => item.key === key)
        if (existing) existing.open = detail.open
        else state.details.push({ key, open: detail.open })
        write(storageKey, JSON.stringify(state))
      })
    }
  }
  const verifyRefreshAsset = async (next) => {
    const file = next?.files?.refresh_js
    if (!file || typeof file.path !== 'string' || typeof file.sha256 !== 'string' ||
        !/^pulse-refresh-[a-f0-9]{64}\\.js$/.test(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new Error('refresh asset metadata')
    }
    const url = new URL(file.path, location.href)
    if (url.origin !== location.origin || url.pathname.split('/').pop() !== file.path) throw new Error('refresh asset origin')
    const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin' })
    if (!response.ok) throw new Error('refresh asset response')
    const digest = await crypto.subtle.digest('SHA-256', await response.arrayBuffer())
    const actual = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    if (actual !== file.sha256) throw new Error('refresh asset hash')
  }
  const unavailable = () => setRefreshStatus('Updates unavailable', 'degraded')
  const poll = async () => {
    if (paused || document.visibilityState === 'hidden' || pollInFlight) return
    pollInFlight = true
    try {
      const markerUrl = new URL('pulse-current.json', location.href)
      if (markerUrl.origin !== location.origin) throw new Error('marker origin')
      const response = await fetch(markerUrl, { cache: 'no-store', credentials: 'same-origin' })
      if (!response.ok) throw new Error('marker response')
      const next = await response.json()
      if (!next || typeof next.snapshot_id !== 'string') throw new Error('marker shape')
      // Reload when THIS PAGE changed, not when a new snapshot exists. The
      // publisher stamps a fresh snapshot id every tick — every five seconds
      // under a running watcher — so keying off it reloaded a board that had not
      // changed a pixel, throwing the reader out of whatever they were reading
      // several times a minute. The marker already hashes every published
      // file; compare the hash of the page we are actually on.
      // A board is republished every tick because the page carries a clock, so
      // its file hash changes even when nothing on the board did. Where the
      // page can tell us what its MEANINGFUL content is, ask that instead:
      // reloading to advance a timestamp destroys whatever the reader was
      // doing in order to update the one thing they were not looking at.
      // Prefer the digest the page publishes: it hashes everything EXCEPT the
      // clocks, so a tick that only moved a timestamp is not a change.
      const board = document.querySelector('[data-tour][data-tour-digest]')
      const own = document.querySelector('[data-tour-data]')
      if (board) {
        const pageUrl = new URL(location.pathname, location.href)
        const fresh = await fetch(pageUrl, { cache: 'no-store', credentials: 'same-origin' })
        if (fresh.ok) {
          const text = await fresh.text()
          const attr = 'data-tour-digest="'
          const at = text.indexOf(attr)
          const digestNow = at === -1 ? null : text.slice(at + attr.length, text.indexOf('"', at + attr.length))
          if (digestNow !== null) {
            if (digestNow === board.dataset.tourDigest) {
              if (next.snapshot_id !== lastSeen) {
                lastSeen = next.snapshot_id
                if (header) {
                  header.dataset.observationExpiresAt =
                    new Date(Date.now() + intervalMs * 3).toISOString()
                }
              }
              updateFreshness()
              return
            }
            await verifyRefreshAsset(next)
            capture()
            location.reload()
            return
          }
        }
      }
      if (own) {
        const pageUrl = new URL(location.pathname, location.href)
        const fresh = await fetch(pageUrl, { cache: 'no-store', credentials: 'same-origin' })
        if (fresh.ok) {
          const text = await fresh.text()
          // String search, not a regular expression: whatever assembles this
          // file into the published asset strips backslashes, so a regex
          // literal arrives with its escapes gone and the script will not
          // parse. The loop-occupancy suite catches that by parsing the
          // published bytes, which is the only reason it was noticed.
          const openTag = '<script type="application/json" data-tour-data>'
          const start = text.indexOf(openTag)
          const end = start === -1 ? -1 : text.indexOf('</' + 'script>', start)
          const block = start === -1 || end === -1 ? null : text.slice(start + openTag.length, end)
          if (block !== null) {
            if (block === own.textContent) {
              // The board did not change, but a NEW marker means the producer
              // just wrote one — which is exactly what freshness asks. Without
              // this the page went stale while the loop was still running,
              // then went quiet, and reported a dead system that was alive.
              if (next.snapshot_id !== lastSeen) {
                lastSeen = next.snapshot_id
                if (header) {
                  header.dataset.observationExpiresAt =
                    new Date(Date.now() + intervalMs * 3).toISOString()
                }
              }
              updateFreshness()
              return
            }
            await verifyRefreshAsset(next)
            capture()
            location.reload()
            return
          }
        }
      }
      const mine = Object.values(next.files || {})
        .find((file) => file && typeof file.path === 'string'
          && file.path === location.pathname.split('/').pop())
      const digest = mine && typeof mine.sha256 === 'string' ? mine.sha256 : null
      if (digest === null) {
        // No hash for this page: fall back to the snapshot id rather than
        // never reloading, because a board frozen forever is the worse failure.
        if (next.snapshot_id !== initialSnapshotId) {
          await verifyRefreshAsset(next)
          capture()
          location.reload()
          return
        }
      } else if (pageDigest === null) {
        pageDigest = digest
      } else if (digest !== pageDigest) {
        await verifyRefreshAsset(next)
        capture()
        location.reload()
        return
      }
      updateFreshness()
    } catch { unavailable() } finally {
      pollInFlight = false
    }
  }
  const updateButton = () => {
    if (!toggle) return
    toggle.textContent = paused ? 'Resume updates' : 'Pause updates'
    toggle.setAttribute('aria-pressed', paused ? 'true' : 'false')
  }
  try { paused = read(pauseKey) === 'true' } catch { paused = false }
  if (toggle) toggle.addEventListener('click', () => {
    paused = !paused
    write(pauseKey, paused ? 'true' : 'false')
    updateButton()
    if (!paused) void poll()
  })
  updateButton()
  restore()
  saveDetails()
  updateFreshness()
  window.addEventListener('beforeunload', capture)
  document.addEventListener('visibilitychange', () => {
    updateFreshness()
    if (document.visibilityState === 'visible') void poll()
  })
  setInterval(() => { void poll() }, intervalMs)
  void poll()
})()
`

// Keep the old export name for source consumers while pages use the asset.
export const PULSE_REFRESH_SCRIPT = PULSE_REFRESH_SOURCE

export function renderPulseRefreshScript() {
  return PULSE_REFRESH_SOURCE
}
