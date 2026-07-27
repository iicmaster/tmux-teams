// CSP-safe browser controller shared by pulse.html and loop-graph.html.
// Pulse publishes this source as a content-addressed same-origin asset.

export const PULSE_REFRESH_SOURCE = `
(() => {
  const body = document.body
  const marker = document.querySelector('meta[name="tmux-teams-snapshot-id"]')
  const initialSnapshotId = marker?.content || ''
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
      if (next.snapshot_id !== initialSnapshotId) {
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
