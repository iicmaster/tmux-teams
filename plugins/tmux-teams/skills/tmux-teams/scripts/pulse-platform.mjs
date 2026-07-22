// Pure parsers for the command output used by pulse.mjs on macOS. Keeping
// these separate from process.platform and child-process calls makes the
// Darwin liveness rules testable on every CI host.

export function parseLsofCwd(out) {
  const line = String(out).split(/\r?\n/).find(l => l.startsWith('n') && l.length > 1)
  return line ? line.slice(1) : null
}

export function parsePgrep(out) {
  return String(out).trim().length > 0
}

export function parsePsCandidates(out) {
  const candidates = []
  for (const line of String(out).split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(.*)$/)
    if (match && match[2].includes('acp-companion.mjs')) {
      candidates.push({ pid: match[1], cmdline: match[2] })
    }
  }
  return candidates
}
