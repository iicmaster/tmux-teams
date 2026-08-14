#!/usr/bin/env node
// ROADMAP.md -> one self-contained HTML page.
//
// WHY THIS EXISTS. `roadmap-gate.mjs` can tell you the published page is behind
// ROADMAP.md. It cannot make republishing cheap, and that was the actual reason
// the page rotted: every version of it was HTML somebody wrote by hand, so
// keeping it current meant dispatching an agent at it and hoping. A gate that
// raises the alarm without lowering the cost just produces a louder version of
// the same neglect.
//
// The output is DETERMINISTIC — no timestamps, no randomness, nothing derived
// from the machine. The same source always renders the same bytes, which is
// what lets `--record` pin a digest and mean it.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ESCAPES[c])

// Only schemes a reader can follow safely. The source is ours, but a published
// page is a published page.
const SAFE_HREF = /^(https?:\/\/|mailto:|#|\/|\.\/)/i

export function renderInline(text) {
  const codes = []
  let s = text.replace(/`([^`]+)`/g, (_, code) => `\u0000${codes.push(code) - 1}\u0000`)
  s = escapeHtml(s)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, label, href) =>
    SAFE_HREF.test(href) ? `<a href="${href}">${label}</a>` : whole)
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${escapeHtml(codes[Number(i)])}</code>`)
}

const cells = (row) => row.replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
const isDelimiter = (line) => /^\|[\s:|-]+\|$/.test(line.trim())

/** Markdown subset -> HTML body. Blocks this project's roadmap actually uses. */
export function renderBody(markdown) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const out = []
  let paragraph = []
  let list = null // { tag, items: [string[]] }

  const flushParagraph = () => {
    if (!paragraph.length) return
    out.push(`<p>${renderInline(paragraph.join(' '))}</p>`)
    paragraph = []
  }
  const flushList = () => {
    if (!list) return
    const items = list.items.map((item) => `  <li>${renderInline(item.join(' '))}</li>`)
    out.push(`<${list.tag}>\n${items.join('\n')}\n</${list.tag}>`)
    list = null
  }
  const flushAll = () => { flushParagraph(); flushList() }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]

    if (!line.trim()) { flushAll(); continue }

    const fence = line.match(/^```/)
    if (fence) {
      flushAll()
      const body = []
      i += 1
      while (i < lines.length && !/^```/.test(lines[i])) { body.push(lines[i]); i += 1 }
      out.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`)
      continue
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/)
    if (heading) {
      flushAll()
      const level = heading[1].length
      out.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`)
      continue
    }

    if (line.trimStart().startsWith('|') && isDelimiter(lines[i + 1] ?? '')) {
      flushAll()
      const head = cells(line.trim())
      i += 2
      const rows = []
      while (i < lines.length && lines[i].trimStart().startsWith('|')) {
        rows.push(cells(lines[i].trim())); i += 1
      }
      i -= 1
      const th = head.map((c) => `<th>${renderInline(c)}</th>`).join('')
      const tr = rows.map((r) => `  <tr>${r.map((c) => `<td>${renderInline(c)}</td>`).join('')}</tr>`)
      out.push(`<div class="tw"><table>\n  <tr>${th}</tr>\n${tr.join('\n')}\n</table></div>`)
      continue
    }

    const quote = line.match(/^>\s?(.*)$/)
    if (quote) {
      flushAll()
      const body = [quote[1]]
      while (i + 1 < lines.length && /^>/.test(lines[i + 1])) {
        body.push(lines[i + 1].replace(/^>\s?/, '')); i += 1
      }
      out.push(`<blockquote>${renderInline(body.join(' ').trim())}</blockquote>`)
      continue
    }

    const bullet = line.match(/^([-*])\s+(.*)$/)
    const numbered = line.match(/^\d+\.\s+(.*)$/)
    if (bullet || numbered) {
      flushParagraph()
      const tag = bullet ? 'ul' : 'ol'
      if (list && list.tag !== tag) flushList()
      if (!list) list = { tag, items: [] }
      list.items.push([(bullet ? bullet[2] : numbered[1]).trim()])
      continue
    }

    // An indented line continues whatever is open; the roadmap wraps its list
    // items at two spaces.
    if (list && /^\s+\S/.test(line)) { list.items.at(-1).push(line.trim()); continue }

    flushList()
    paragraph.push(line.trim())
  }
  flushAll()
  return out.join('\n')
}

export const PAGE_CSS = `
:root{--bg:#f7f7f6;--fg:#1b1d21;--dim:#5c6068;--line:#dcdcd8;--card:#fff;
      --accent:#2f5d50;--hi:#eef2f0}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --bg:#15171a;--fg:#e8e9ea;--dim:#9aa0a6;--line:#2c3036;--card:#1c1f23;
  --accent:#6fbfa4;--hi:#1e2723}}
:root[data-theme="dark"]{--bg:#15171a;--fg:#e8e9ea;--dim:#9aa0a6;--line:#2c3036;
  --card:#1c1f23;--accent:#6fbfa4;--hi:#1e2723}
*{box-sizing:border-box}
body{background:var(--bg);color:var(--fg);margin:0;padding:0 5vw 6rem;
  font-family:"IBM Plex Sans Thai","Sarabun","Noto Sans Thai",system-ui,-apple-system,sans-serif;
  font-size:18px;line-height:1.75;-webkit-text-size-adjust:100%}
main{max-width:44rem;margin:0 auto}
h1{font-size:2.2rem;line-height:1.25;margin:3rem 0 .4rem;letter-spacing:-.015em;text-wrap:balance}
h2{font-size:1.45rem;margin:3rem 0 .6rem;padding-top:1.5rem;
  border-top:1px solid var(--line);letter-spacing:-.01em;text-wrap:balance}
h3{font-size:1.1rem;margin:2rem 0 .3rem;text-wrap:balance}
p,li{max-width:38em}
a{color:var(--accent)}
strong{font-weight:650}
code{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace;font-size:.88em;
  background:var(--hi);padding:.1em .35em;border-radius:3px}
pre{background:var(--card);border:1px solid var(--line);border-radius:6px;
  padding:1rem 1.1rem;overflow-x:auto}
pre code{background:none;padding:0;font-size:.85rem;line-height:1.6}
blockquote{margin:1.6rem 0;padding:.2rem 0 .2rem 1.2rem;border-left:3px solid var(--accent);
  color:var(--dim)}
.tw{overflow-x:auto;margin:1.6rem 0}
table{border-collapse:collapse;width:100%;min-width:34rem;font-size:.95rem;
  font-variant-numeric:tabular-nums}
th,td{border:1px solid var(--line);padding:.55rem .75rem;text-align:left;vertical-align:top}
th{background:var(--hi);font-weight:600}
ul,ol{padding-left:1.3rem}
li{margin:.4rem 0}
`.trim()

export function renderRoadmap(markdown, { title = 'ROADMAP — tmux-teams' } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
${PAGE_CSS}
</style>
</head>
<body>
<main>
${renderBody(markdown)}
</main>
</body>
</html>
`
}

// Every published page in this repository has a tracked source, and this is the
// list. It exists because two of the three pages did NOT: they were HTML written
// by hand, went stale by a week, and nothing could notice. The roadmap got a
// source first; the other two joined on 2026-08-14.
export const PAGES = Object.freeze([
  { source: 'ROADMAP.md', out: 'docs/roadmap.html', slug: 'tmux-teams-next-plan' },
  {
    source: 'plugins/tmux-teams/skills/tmux-teams/references/event-subscriptions.md',
    out: 'docs/event-subscriptions.html',
    slug: 'tmux-teams-ddd-reading',
  },
  { source: 'RELEASE-PLAN.md', out: 'docs/release-plan.html', slug: 'tmux-teams-release-plan' },
])

export function runRenderCli(argv = [], { root = process.cwd(), stdout = process.stdout } = {}) {
  const outIndex = argv.indexOf('--out')
  const positional = argv.filter((arg, i) => !arg.startsWith('--') && argv[i - 1] !== '--out')
  const source = positional[0] ?? 'ROADMAP.md'
  const known = PAGES.find((page) => page.source === source)
  const outPath = outIndex >= 0
    ? argv[outIndex + 1]
    : join(root, known?.out ?? 'docs/roadmap.html')
  if (outIndex >= 0 && !outPath) {
    stdout.write('roadmap-render: --out needs a path\n')
    return 1
  }
  let markdown
  try { markdown = readFileSync(join(root, source), 'utf8') } catch (error) {
    stdout.write(`roadmap-render: cannot read ${source === 'ROADMAP.md' ? 'ROADMAP.md' : source}: ${error.message}\n`)
    return 1
  }
  // The output directory may not exist — `docs/` is machine-local and ignored,
  // so a fresh clone has none until something writes one.
  mkdirSync(dirname(outPath), { recursive: true })
  const title = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim()
  writeFileSync(outPath, renderRoadmap(markdown, title ? { title } : {}), 'utf8')
  stdout.write(`roadmap-render: wrote ${outPath}\n`)
  return 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const here = dirname(fileURLToPath(import.meta.url))
  process.exitCode = runRenderCli(process.argv.slice(2), { root: join(here, '..') })
}
