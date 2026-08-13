// intake-stats.mjs — what the requests that died at the door are worth.
//
// Master's reframe on 2026-07-31, and the reason this file exists: *"ตอนแรกผมคิดว่า
// จะไม่สร้างเลย เพราะเป็นขยะ แต่ลองมองอีกมุมมันคือสถิติ เปลี่ยนจากขยะเป็นของมีค่าทันที"* — the same
// file is litter from one side and data from the other. A system that throws
// away its failures cannot say why it fails.
//
// Three questions, and each one changes something. That was the condition for
// building this at all: a report nobody acts on is a report nobody reads.
//
//   1. which of the six categories requests die in  → the grill's brief is wrong
//      at that point, or is asking at the wrong moment
//   2. how long people actually take to answer      → evidence for or against the
//      ten minutes, which was chosen by judgement
//   3. who is asked to clarify most                 → somebody to help, not
//      somebody to blame
import { readWorkItems } from './dispatch-facts.mjs'
import { GRILL_CATEGORY_IDS } from './role-briefs.mjs'

const RUNNER_ACTOR = 'agent:runner'

/**
 * @returns {{admitted: number, questioned: number, withdrawn: number,
 *            by_category: Record<string, number>, answer_seconds: number[],
 *            median_answer_seconds: number|null, by_requester: Record<string, number>}}
 */
export function intakeStats(repo) {
  const { items } = readWorkItems(repo)
  const byCategory = Object.fromEntries(GRILL_CATEGORY_IDS.map((id) => [id, 0]))
  const byRequester = {}
  const answerSeconds = []
  let admitted = 0
  let questioned = 0
  let withdrawn = 0

  for (const item of items.values()) {
    const custody = item.custody || []
    const opened = custody.find((entry) => entry.event === 'opened')
    if (!opened) continue
    admitted += 1

    let asked = null
    for (const entry of custody) {
      if (entry.event === 'questioned') {
        questioned += 1
        asked = entry
        // Counted per ASKING, not per token: a request questioned twice about
        // security is two data points about security, and collapsing them would
        // hide exactly the repetition worth seeing.
        for (const id of entry.categories || []) {
          if (id in byCategory) byCategory[id] += 1
        }
        const requester = String(opened.actor || 'unknown')
        byRequester[requester] = (byRequester[requester] ?? 0) + 1
      }
      if (entry.event === 'answered' && asked) {
        const seconds = (Date.parse(entry.at || '') - Date.parse(asked.at || '')) / 1000
        // Only real, forward-moving gaps. A backwards one would mean a ledger
        // that failed ข้อ 4.4, and averaging it in would quietly poison the number
        // this measurement exists to defend.
        if (Number.isFinite(seconds) && seconds >= 0) answerSeconds.push(Math.round(seconds))
        asked = null
      }
      // The runner's own close, which is the withdrawal. The controller's
      // `abandon` verdict writes the same word — `actor` is what separates them
      // (ข้อ 9) — and counting a controller's decision as a lapsed request would
      // make the deadline look harsher than it is.
      if (entry.event === 'abandoned' && String(entry.actor || '') === RUNNER_ACTOR) withdrawn += 1
    }
  }

  const sorted = [...answerSeconds].sort((a, b) => a - b)
  const median = sorted.length === 0 ? null
    : sorted.length % 2 === 1 ? sorted[(sorted.length - 1) / 2]
      : Math.round((sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2)

  return {
    admitted,
    questioned,
    withdrawn,
    by_category: byCategory,
    answer_seconds: answerSeconds,
    median_answer_seconds: median,
    by_requester: byRequester,
  }
}

// The controller reads this, so it is written for the controller: short, ranked,
// and saying what each number would change. Numbers with no consequence attached
// are how a dashboard becomes wallpaper.
export function intakeStatsBrief(stats, deadlineSec) {
  if (!stats.admitted) return ''
  const ranked = Object.entries(stats.by_category)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
  const people = Object.entries(stats.by_requester).sort((a, b) => b[1] - a[1]).slice(0, 3)
  const lines = [
    '## What the door has learned so far',
    '',
    `${stats.admitted} request(s) admitted · ${stats.questioned} sent back for detail · ${stats.withdrawn} withdrawn unanswered.`,
    '',
  ]
  if (ranked.length) {
    lines.push('**Where requests stall, most often first:**', '')
    for (const [id, count] of ranked) lines.push(`- ${id} — ${count}`)
    lines.push('',
      'If one category dominates, the brief is asking about it at the wrong moment, or the people'
      + ' sending requests were never told it would be asked. Say which, and say what to change.',
      '')
  }
  if (stats.median_answer_seconds !== null) {
    lines.push(`**Median time to answer:** ${stats.median_answer_seconds}s against a ${deadlineSec}s deadline`
      + ` (${stats.answer_seconds.length} answered).`,
      '',
      'This is the only evidence for or against that deadline. If it disagrees, say so with the number.',
      '')
  }
  if (people.length) {
    lines.push('**Asked to clarify most often:** '
      + people.map(([who, count]) => `${who} (${count})`).join(', '),
      '',
      'That is somebody to help, not somebody to blame — say what would have let them answer up front.',
      '')
  }
  return lines.join('\n')
}
