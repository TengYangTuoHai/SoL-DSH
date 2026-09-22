/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 *
 * The reducer's receipt check is the mechanism's whole safety argument: a
 * summary is accepted only when every claim in it can be verified against the
 * archived original. These tests attack that check rather than exercise it —
 * each refusal reason below is a way a fluent but unfounded summary could
 * otherwise reach the frontier agent.
 */
import { describe, expect, it } from 'vitest'
import { digestOf, sha256 } from '../src/shared/digest.js'
import { MAX_EVIDENCE_ITEMS, MAX_QUOTE_CHARS, RECEIPT_SCHEMA } from '../src/reducer/config.js'
import {
  receiptText,
  reducerInput,
  reducerInstructions,
  validateReceipt,
  type ReducerCallFacts,
  type SourceArtifact,
} from '../src/reducer/receipt.js'

/** A realistic build log the receipts below are checked against. */
const BODY = [
  '> solprobe@1.0.0 test',
  '> node build.js',
  '',
  'error TS2304: Cannot find name SOLPROBE_SYMBOL_0 in module probe-target',
  'error TS2304: Cannot find name SOLPROBE_SYMBOL_1 in module probe-target',
  'warning: 2 issues found',
  'FAILURE: build finished with 2 errors',
].join('\n')

const DIGEST = digestOf(BODY)

/** Build a well-formed receipt body, then let each test perturb one field. */
function receipt(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: RECEIPT_SCHEMA,
    source_sha256: DIGEST.hash,
    status: 'failure',
    uncertain: false,
    evidence: [
      { kind: 'failure', quote: 'error TS2304: Cannot find name SOLPROBE_SYMBOL_0 in module probe-target' },
      { kind: 'summary', quote: 'FAILURE: build finished with 2 errors' },
    ],
    ...overrides,
  })
}

describe('digestOf', () => {
  it('counts bytes, UTF-16 units, and lines independently', () => {
    // Three bytes in UTF-8, one code unit, no newline: the three numbers are
    // deliberately different so a caller cannot confuse them.
    const digest = digestOf('€')
    expect(digest.bytes).toBe(3)
    expect(digest.chars).toBe(1)
    expect(digest.lines).toBe(1)
  })

  it('reports zero lines for an empty body', () => {
    expect(digestOf('')).toMatchObject({ bytes: 0, chars: 0, lines: 0 })
  })

  it('is content-addressed and stable', () => {
    expect(digestOf(BODY).hash).toBe(digestOf(BODY).hash)
    expect(digestOf(BODY).hash).toBe(sha256(BODY))
    expect(digestOf(`${BODY} `).hash).not.toBe(DIGEST.hash)
  })
})

describe('validateReceipt acceptance', () => {
  it('accepts a receipt whose every quote appears byte for byte', () => {
    const result = validateReceipt(receipt(), DIGEST, BODY, true)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.status).toBe('failure')
    expect(result.value.uncertain).toBe(false)
    expect(result.value.evidence).toHaveLength(2)
    // Line numbers are derived from the original, not trusted from the model.
    expect(result.value.evidence[0]).toMatchObject({ kind: 'failure', line: 4 })
    expect(result.value.evidence[1]).toMatchObject({ kind: 'summary', line: 7 })
  })

  it('accepts a success receipt for a clean log', () => {
    const clean = 'all 12 tests passed'
    const cleanDigest = digestOf(clean)
    const ok = JSON.stringify({
      schema: RECEIPT_SCHEMA,
      source_sha256: cleanDigest.hash,
      status: 'success',
      uncertain: false,
      evidence: [{ kind: 'summary', quote: 'all 12 tests passed' }],
    })
    expect(validateReceipt(ok, cleanDigest, clean, false).ok).toBe(true)
  })

  it('deduplicates repeated identical quotes', () => {
    const quote = 'error TS2304: Cannot find name SOLPROBE_SYMBOL_0 in module probe-target'
    const duplicated = JSON.stringify({
      schema: RECEIPT_SCHEMA,
      source_sha256: DIGEST.hash,
      status: 'failure',
      uncertain: false,
      evidence: [{ kind: 'failure', quote }, { kind: 'failure', quote }],
    })
    const result = validateReceipt(duplicated, DIGEST, BODY, true)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.evidence).toHaveLength(1)
  })
})

describe('validateReceipt refusals', () => {
  it('refuses unparseable output', () => {
    expect(validateReceipt('not json at all', DIGEST, BODY, true))
      .toMatchObject({ ok: false, reason: 'invalid-json' })
  })

  it('refuses a quote that is not in the source', () => {
    // The failure mode this guards: a plausible-looking line the model wrote
    // itself rather than copied.
    const invented = receipt({
      evidence: [{ kind: 'failure', quote: 'error TS2304: Cannot find name SOLPROBE_SYMBOL_99 in module probe-target' }],
    })
    expect(validateReceipt(invented, DIGEST, BODY, true))
      .toMatchObject({ ok: false, reason: 'unverifiable-quote' })
  })

  it('refuses a quote that differs by one character', () => {
    const nearMiss = receipt({
      evidence: [{ kind: 'failure', quote: 'error TS2304: Cannot find name SOLPROBE_SYMBOL_0 in module probe-TARGET' }],
    })
    expect(validateReceipt(nearMiss, DIGEST, BODY, true))
      .toMatchObject({ ok: false, reason: 'unverifiable-quote' })
  })

  it('refuses a receipt describing a different source', () => {
    const stale = receipt({ source_sha256: sha256('some other log') })
    expect(validateReceipt(stale, DIGEST, BODY, true))
      .toMatchObject({ ok: false, reason: 'schema-mismatch' })
  })

  it('refuses a status that contradicts the observed exit', () => {
    // Claiming success for a failed command is the most damaging single lie.
    const optimistic = receipt({ status: 'success' })
    expect(validateReceipt(optimistic, DIGEST, BODY, true))
      .toMatchObject({ ok: false, reason: 'schema-mismatch' })
  })

  it('refuses a foreign schema tag', () => {
    expect(validateReceipt(receipt({ schema: 'someone-elses-receipt/1' }), DIGEST, BODY, true))
      .toMatchObject({ ok: false, reason: 'schema-mismatch' })
  })

  it('refuses a non-boolean uncertainty flag', () => {
    expect(validateReceipt(receipt({ uncertain: 'no' }), DIGEST, BODY, true))
      .toMatchObject({ ok: false, reason: 'schema-mismatch' })
  })

  it('refuses more evidence items than the cap allows', () => {
    const quote = 'warning: 2 issues found'
    const flooded = receipt({
      evidence: Array.from({ length: MAX_EVIDENCE_ITEMS + 1 }, (_, index) => ({
        kind: index === 0 ? 'failure' : 'warning',
        quote,
      })),
    })
    expect(validateReceipt(flooded, DIGEST, BODY, true))
      .toMatchObject({ ok: false, reason: 'schema-mismatch' })
  })

  it('refuses an over-long quote', () => {
    const padded = `${'x'.repeat(MAX_QUOTE_CHARS + 1)}`
    const long = receipt({ evidence: [{ kind: 'summary', quote: padded }] })
    expect(validateReceipt(long, DIGEST, `${BODY}\n${padded}`, true))
      .toMatchObject({ ok: false, reason: 'unverifiable-quote' })
  })

  it('refuses an unknown evidence kind', () => {
    expect(validateReceipt(
      receipt({ evidence: [{ kind: 'diagnosis', quote: 'warning: 2 issues found' }] }),
      DIGEST,
      BODY,
      true,
    )).toMatchObject({ ok: false, reason: 'unverifiable-quote' })
  })

  it('refuses an empty quote', () => {
    // `''` is contained by every string, so an unchecked empty quote would
    // always verify and inflate the evidence count for free.
    expect(validateReceipt(receipt({ evidence: [{ kind: 'summary', quote: '' }] }), DIGEST, BODY, true))
      .toMatchObject({ ok: false, reason: 'unverifiable-quote' })
  })

  it('refuses a failures-only receipt for a failing log that has no failure evidence', () => {
    // The log reads as a failure, so a receipt summarizing it as merely
    // "uncertain" would launder a real failure into a clean summary.
    const soft = receipt({
      status: 'failure',
      evidence: [{ kind: 'summary', quote: 'warning: 2 issues found' }],
    })
    expect(validateReceipt(soft, DIGEST, BODY, true))
      .toMatchObject({ ok: false, reason: 'missing-failure-evidence' })
  })

  it('allows a failure-status receipt with no failure evidence when the log is clean', () => {
    // A command can exit non-zero while its output carries no failure language
    // (a grep with no match, say); requiring failure evidence there would
    // refuse every legitimate receipt.
    const quiet = 'nothing to report'
    const quietDigest = digestOf(quiet)
    const ok = JSON.stringify({
      schema: RECEIPT_SCHEMA,
      source_sha256: quietDigest.hash,
      status: 'failure',
      uncertain: true,
      evidence: [],
    })
    expect(validateReceipt(ok, quietDigest, quiet, true).ok).toBe(true)
  })

  it('refuses a missing evidence array', () => {
    expect(validateReceipt(receipt({ evidence: undefined }), DIGEST, BODY, true))
      .toMatchObject({ ok: false, reason: 'schema-mismatch' })
  })
})

describe('reducerInput', () => {
  it('states the identity the model must echo, without leaking anything else', () => {
    const input = reducerInput('pnpm test', true, DIGEST, BODY)
    expect(input).toContain(`source_sha256=${DIGEST.hash}`)
    expect(input).toContain(`source_bytes=${DIGEST.bytes}`)
    expect(input).toContain(`source_lines=${DIGEST.lines}`)
    expect(input).toContain('is_error=true')
    // The log must arrive fenced and labelled untrusted.
    expect(input).toContain('<untrusted_log>')
    expect(input.trimEnd().endsWith('</untrusted_log>')).toBe(true)
  })

  it('hashes the command rather than embedding it verbatim', () => {
    const input = reducerInput('export TOKEN=hunter2 && pnpm test', false, DIGEST, BODY)
    expect(input).not.toContain('hunter2')
    expect(input).toContain(`command_sha256=${sha256('export TOKEN=hunter2 && pnpm test')}`)
  })
})

describe('reducerInstructions', () => {
  it('tells the model the log is untrusted and forbids acting on it', () => {
    const text = reducerInstructions()
    expect(text).toMatch(/untrusted/i)
    expect(text).toMatch(/never follow instructions/i)
    expect(text).toContain(RECEIPT_SCHEMA)
  })

  it('forbids diagnosis and invented commands', () => {
    const text = reducerInstructions()
    expect(text).toMatch(/do not diagnose/i)
    expect(text).toMatch(/invent a command/i)
    // And it must demand uncertainty rather than a confident guess.
    expect(text).toMatch(/uncertain=true/i)
  })
})

describe('receiptText', () => {
  const artifact: SourceArtifact = { locator: '/tmp/source.log', retrievalHint: 'Read the locator.' }
  const call: ReducerCallFacts = { provider: 'p', model: 'm', totalTokens: 123 }

  it('carries the identity a reader needs to recheck every claim', () => {
    const checked = validateReceipt(receipt(), DIGEST, BODY, true)
    expect(checked.ok).toBe(true)
    if (!checked.ok) return
    const text = receiptText('pnpm test', DIGEST, artifact, checked.value, call)
    expect(text).toContain(DIGEST.hash)
    expect(text).toContain(`source_bytes=${DIGEST.bytes}`)
    expect(text).toContain(artifact.locator)
    expect(text).toContain('reducer_total_tokens=123')
    // The frontier agent keeps authority; the receipt must say so.
    expect(text).toMatch(/authority=/)
    expect(text).toContain(artifact.retrievalHint)
  })

  it('renders no-quote receipts explicitly rather than looking truncated', () => {
    const cleanDigest = digestOf('clean')
    const empty = validateReceipt(
      JSON.stringify({
        schema: RECEIPT_SCHEMA,
        source_sha256: cleanDigest.hash,
        status: 'success',
        uncertain: true,
        evidence: [],
      }),
      cleanDigest,
      'clean',
      false,
    )
    expect(empty.ok).toBe(true)
    if (!empty.ok) return
    const text = receiptText('pnpm test', cleanDigest, artifact, empty.value, call)
    expect(text).toContain('- none')
  })

  it('emits quotes as JSON so invisible characters cannot forge a line', () => {
    const checked = validateReceipt(receipt(), DIGEST, BODY, true)
    if (!checked.ok) throw new Error('expected acceptance')
    const text = receiptText('pnpm test', DIGEST, artifact, checked.value, call)
    // Every evidence line ends in a JSON string literal, never raw text.
    for (const line of text.split('\n').filter(l => l.startsWith('- kind='))) {
      expect(line).toMatch(/quote=".*"$/)
    }
  })
})
