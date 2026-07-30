// docs-paths.test.mjs — every JavaScript module path taught by shipped
// documentation must resolve to a real file.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN_ROOT = join(REPO_ROOT, 'plugins/tmux-teams')
const SKILLS_ROOT = join(PLUGIN_ROOT, 'skills')
const TMUX_TEAMS_SCRIPTS = join(SKILLS_ROOT, 'tmux-teams/scripts')

const MJS_PATH = /(?:(?:<[^>\s/]+>|\$\{[^}\s/]+\}|[A-Za-z0-9_@.~*-]+)\/)*(?:<[^>\s/]+>|[A-Za-z0-9_@.~*${}-]+)\.mjs\b/g

// These are exact non-file examples, not broad patterns:
// - the two test globs teach how Node discovers a set of tests, not one file;
// - <stub>.mjs is a caller-provided ACP test double, not a bundled script.
const EXACT_EXEMPTIONS = new Set([
  'tests/*.test.mjs',
  'tests/**/*.test.mjs',
  '<stub>.mjs',
])

// Bare names normally mean the tmux-teams scripts directory. These two are
// explicitly taught from different homes, so keep the exceptions by name.
const BARE_PATHS = new Map([
  ['run-fast.mjs', 'scripts/run-fast.mjs'],
  ['review-gate.mjs', 'plugins/tmux-teams/skills/party-mode/scripts/review-gate.mjs'],
])

function markdownFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return markdownFiles(path)
    return entry.isFile() && entry.name.endsWith('.md') ? [path] : []
  })
}

function repoPath(path) {
  return relative(REPO_ROOT, path).split('\\').join('/')
}

function containingSkillRoot(document) {
  const match = document.match(/^plugins\/tmux-teams\/skills\/([^/]+)(?:\/|$)/)
  return match ? join(SKILLS_ROOT, match[1]) : null
}

function resolveDocumentedPath(document, documentedPath) {
  const skillRoot = containingSkillRoot(document)

  if (documentedPath.startsWith('<skill-root>/') && skillRoot) {
    return join(skillRoot, documentedPath.slice('<skill-root>/'.length))
  }
  if (documentedPath.startsWith('<party-mode>/')) {
    return join(SKILLS_ROOT, 'party-mode', documentedPath.slice('<party-mode>/'.length))
  }
  if (documentedPath.startsWith('<plugin-root>/')) {
    return join(PLUGIN_ROOT, documentedPath.slice('<plugin-root>/'.length))
  }
  if (documentedPath.startsWith('<plugin>/')) {
    return join(PLUGIN_ROOT, documentedPath.slice('<plugin>/'.length))
  }

  // A reader treats an explicit path as repo-relative. Skill documents also
  // use their conventional `scripts/` shorthand, which is relative to that
  // skill's root rather than the repository root.
  if (documentedPath.startsWith('scripts/') && skillRoot) {
    return join(skillRoot, documentedPath)
  }
  if (documentedPath.startsWith('skills/')) {
    return join(PLUGIN_ROOT, documentedPath)
  }
  if (documentedPath.includes('/')) {
    return join(REPO_ROOT, documentedPath)
  }

  if (documentedPath.endsWith('.test.mjs')) {
    return join(REPO_ROOT, 'tests', documentedPath)
  }
  const barePath = BARE_PATHS.get(documentedPath)
  return barePath ? join(REPO_ROOT, barePath) : join(TMUX_TEAMS_SCRIPTS, documentedPath)
}

function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

test('every documented .mjs path names an existing file', () => {
  const documents = [
    join(REPO_ROOT, 'README.md'),
    join(REPO_ROOT, 'CLAUDE.md'),
    ...markdownFiles(SKILLS_ROOT),
  ].sort()
  const violations = documents.flatMap((path) => {
    const document = repoPath(path)
    const lines = readFileSync(path, 'utf8').split(/\r?\n/)
    return lines.flatMap((line, index) => {
      return [...line.matchAll(MJS_PATH)].flatMap((match) => {
        const documentedPath = match[0]
        if (EXACT_EXEMPTIONS.has(documentedPath)) return []

        const resolvedPath = resolveDocumentedPath(document, documentedPath)
        if (!isFile(resolvedPath)) {
          return [{
            document,
            line: index + 1,
            documentedPath,
            resolvedPath: repoPath(resolvedPath),
          }]
        }
        return []
      })
    })
  })

  const details = violations.map(({ document, line, documentedPath, resolvedPath }) => {
    const expansion = documentedPath === resolvedPath ? '' : ` (documented as ${documentedPath})`
    return `${document}:${line}: missing ${resolvedPath}${expansion}`
  })
  assert.equal(
    violations.length,
    0,
    ['documented .mjs paths must be files:', ...details].join('\n'),
  )
})
