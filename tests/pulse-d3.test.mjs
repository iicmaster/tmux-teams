import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const D3 = join(
  ROOT,
  'plugins',
  'tmux-teams',
  'skills',
  'tmux-teams',
  'assets',
  'd3',
)
const sha256 = value => createHash('sha256').update(value).digest('hex')

test('vendored D3 7.9.0 and its ISC license match the reviewed upstream bytes', () => {
  const js = readFileSync(join(D3, 'd3.v7.9.0.min.js'))
  const license = readFileSync(join(D3, 'LICENSE'))
  const provenance = readFileSync(join(D3, 'README.md'), 'utf8')

  assert.equal(sha256(js),
    'f2094bbf6141b359722c4fe454eb6c4b0f0e42cc10cc7af921fc158fceb86539')
  assert.equal(sha256(license),
    '3e6849627f74ff73c257a3ae1efb574015d94fc1035c05ec3c15805165efcbc4')
  assert.match(js.toString('utf8', 0, 100), /d3js\.org v7\.9\.0/)
  assert.match(license.toString('utf8'), /Permission to use, copy, modify, and\/or distribute/)
  assert.match(provenance, /d3@7\.9\.0/)
  assert.match(provenance,
    /sha512-e1U46jVP\+w7Iut8Jt8ri1YsPOvFpg46k\+K8TpCb0P\+zjCkjkPnV7WzfDJzMHy1LnA\+wj5pLT1wjO901gLXeEhA==/)
})
