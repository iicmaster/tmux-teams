import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  KANIT_FONT_BYTES,
  KANIT_FONT_CSS,
  KANIT_FONT_FACE_COUNT,
  KANIT_LICENSE,
} from '../plugins/tmux-teams/skills/tmux-teams/assets/kanit/kanit-embedded.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OFL = join(ROOT, 'plugins/tmux-teams/skills/tmux-teams/assets/kanit/OFL.txt')

test('Kanit is truly embedded for Thai and Latin at every used weight', () => {
  const payloads = [...KANIT_FONT_CSS.matchAll(/data:font\/woff2;base64,([A-Za-z0-9+/=]+)"/g)]

  assert.equal(KANIT_FONT_FACE_COUNT, 6)
  assert.equal(payloads.length, KANIT_FONT_FACE_COUNT)
  assert.equal(KANIT_FONT_BYTES, 98_556)
  assert.equal(payloads.reduce((sum, match) => sum + Buffer.from(match[1], 'base64').length, 0), KANIT_FONT_BYTES)

  for (const [, payload] of payloads) {
    assert.equal(Buffer.from(payload, 'base64').subarray(0, 4).toString('ascii'), 'wOF2')
  }
  for (const weight of [400, 500, 600]) {
    assert.equal((KANIT_FONT_CSS.match(new RegExp(`font-weight:${weight}`, 'g')) || []).length, 2)
  }
})

test('the self-contained font carries its license and has no network URL', () => {
  assert.equal(readFileSync(OFL, 'utf8').trim(), KANIT_LICENSE.trim())
  assert.match(KANIT_FONT_CSS, /Copyright 2020 The Kanit Project Authors/)
  assert.match(KANIT_FONT_CSS, /SIL OPEN FONT LICENSE Version 1\.1/)
  assert.doesNotMatch(KANIT_FONT_CSS, /src:url\((?!"data:font\/woff2;base64,)/)
})
