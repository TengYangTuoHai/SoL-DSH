/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 *
 * ObservationPack's eligibility rule and placeholder. The rule carries the
 * mechanism's safety property: a packed result must stay reachable, and a result
 * with any non-text block must be refused whole rather than half-archived.
 */
import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import {
  OBSERVATION_SUFFIX,
  packable,
  placeholderText,
  PLACEHOLDER_HEADER,
  textOnly,
} from '../src/observation-pack/placeholder.js'
import { digestOf } from '../src/shared/digest.js'

const text = (value: string): ContentBlock => ({ type: 'text', text: value })

describe('textOnly', () => {
  it('joins text blocks with newlines', () => {
    expect(textOnly([text('a'), text('b')])).toBe('a\nb')
  })

  it('returns an empty string for an empty content array', () => {
    expect(textOnly([])).toBe('')
  })

  it('refuses content carrying any non-text block', () => {
    const image = { type: 'image', attachment: {} } as unknown as ContentBlock
    expect(textOnly([text('a'), image])).toBeUndefined()
    expect(textOnly([image])).toBeUndefined()
  })

  it('does not insert a leading newline for an empty first block', () => {
    // The join is a fold, not `join('\n')`, so an empty leading block must not
    // add a separator that would shift every derived line number.
    expect(textOnly([text(''), text('b')])).toBe('b')
  })
})

describe('packable', () => {
  it('accepts a large text result and reports its digest', () => {
    const body = 'x'.repeat(9_000)
    const result = packable([text(body)], 8_192)
    expect(result?.body).toBe(body)
    expect(result?.digest.bytes).toBe(9_000)
    expect(result?.digest.hash).toBe(digestOf(body).hash)
  })

  it('refuses a result below the size floor', () => {
    expect(packable([text('x'.repeat(100))], 8_192)).toBeUndefined()
  })

  it('measures the floor in bytes, not characters', () => {
    // 3000 three-byte characters is 9000 bytes: above the floor in bytes and
    // below it in code units, so a char-based check would wrongly refuse it.
    const body = '€'.repeat(3_000)
    expect(body.length).toBeLessThan(8_192)
    expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(8_192)
    expect(packable([text(body)], 8_192)).toBeDefined()
  })

  it('accepts a result exactly at the floor', () => {
    expect(packable([text('x'.repeat(8_192))], 8_192)).toBeDefined()
    expect(packable([text('x'.repeat(8_191))], 8_192)).toBeUndefined()
  })

  it('refuses a large result that carries an image', () => {
    // Packing this would archive only the text and silently drop the image.
    const image = { type: 'image', attachment: {} } as unknown as ContentBlock
    expect(packable([text('x'.repeat(20_000)), image], 8_192)).toBeUndefined()
  })
})

describe('placeholderText', () => {
  const digest = digestOf('x'.repeat(9_000))
  const placeholder = placeholderText(digest, '/tmp/archive.log', 'Read the locator.')

  it('starts with the recognizable header', () => {
    expect(placeholder.split('\n')[0]).toBe(PLACEHOLDER_HEADER)
  })

  it('carries everything needed to reach and recheck the original', () => {
    expect(placeholder).toContain(`bytes=${digest.bytes}`)
    expect(placeholder).toContain(`lines=${digest.lines}`)
    expect(placeholder).toContain(`sha256=${digest.hash}`)
    expect(placeholder).toContain('/tmp/archive.log')
    expect(placeholder).toContain('Read the locator.')
  })

  it('states that the complete result is archived rather than lost', () => {
    // The model must not read the placeholder as the whole observation.
    expect(placeholder).toMatch(/complete result is archived/i)
  })

  it('is far smaller than the body it replaces', () => {
    expect(Buffer.byteLength(placeholder, 'utf8')).toBeLessThan(1_000)
  })

  it('has a stable line count, so a reader can parse it positionally', () => {
    expect(placeholder.split('\n')).toHaveLength(6)
  })
})

describe('OBSERVATION_SUFFIX', () => {
  it('is the extension the archive naming uses', () => {
    // The suffix is how a human distinguishes this mechanism's artifacts from
    // the harness's own spill files.
    expect(OBSERVATION_SUFFIX).toBe('.observation.log')
    expect(`${'a'.repeat(16)}${OBSERVATION_SUFFIX}`).toMatch(/^[0-9a-f]{16}\.observation\.log$/)
  })
})
