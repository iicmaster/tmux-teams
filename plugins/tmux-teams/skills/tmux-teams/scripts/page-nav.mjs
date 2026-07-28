// page-nav.mjs — the one bar that says which of the three pages you are on.
//
// Pulse, the loop graph and the kanban board answer three different questions
// about the same run: what is happening now, who exists and how they are wired,
// and where each work item is stuck. They are published as siblings in
// `.tmux-teams/`, so until now moving between them meant knowing all three
// filenames and editing the address bar.
//
// It lives in its own module rather than inside one of the three because
// `pulse.mjs` already imports `kanban.mjs`; putting the shared bar in either of
// those would make the other pages import a page renderer just to get a link
// list, and the third import would close a cycle.
//
// The current page is a link to nothing. A nav that lets you click the page you
// are already on is a nav that can be used without ever telling you where you
// are — `aria-current` says it to a screen reader and the styling says it to
// everyone else, both from the same single source.

// Deliberately not imported from graph.mjs: this module stays free of the three
// pages so none of them can create a cycle by using it.
const esc = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;')

// `id` is what a caller passes to `renderNav`; `file` is the sibling it links
// to. Writing a page's filename down once is the point — the last rename left a
// stale key in two readers and printed `undefined` to anyone using the CLI.
export const NAV_PAGES = [
  { id: 'pulse', file: 'pulse.html', label: 'Pulse', hint: 'what is happening right now' },
  { id: 'graph', file: 'graph.html', label: 'Loop graph', hint: 'who exists and how they are wired' },
  { id: 'kanban', file: 'kanban.html', label: 'Kanban', hint: 'where each work item is stuck' },
]

// Falls back to the host page's own colours (`currentColor`, `var(--line, …)`)
// so one rule set works on all three without first forcing their palettes into
// agreement. Every page here is offline and network-free, so nothing external
// is referenced.
export const NAV_CSS = `
.page-nav{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;padding:.5rem 0;margin:0 0 .25rem}
.page-nav a,.page-nav strong{font:inherit;font-size:.85rem;line-height:1;padding:.4rem .7rem;border-radius:999px;
border:1px solid var(--line,currentColor);text-decoration:none;color:inherit;white-space:nowrap}
.page-nav a{opacity:.72}
.page-nav a:hover,.page-nav a:focus-visible{opacity:1}
.page-nav a:focus-visible{outline:2px solid currentColor;outline-offset:2px}
.page-nav strong{font-weight:600;opacity:1;border-color:currentColor;background:color-mix(in srgb,currentColor 12%,transparent)}
@media(prefers-reduced-motion:no-preference){.page-nav a{transition:opacity .12s ease-out}}
`.trim()

// `current` is a page id from NAV_PAGES. An unknown id renders every entry as a
// link rather than throwing: a nav bar is not worth failing a published page
// over, and "no page marked" is visibly wrong in a way a missing bar is not.
export function renderNav(current) {
  const items = NAV_PAGES.map((page) => (page.id === current
    ? `<strong aria-current="page" title="${esc(page.hint)}">${esc(page.label)}</strong>`
    : `<a href="${esc(page.file)}" title="${esc(page.hint)}">${esc(page.label)}</a>`))
  return `<nav class="page-nav" aria-label="Delivery loop pages">${items.join('')}</nav>`
}
