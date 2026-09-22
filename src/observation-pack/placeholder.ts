/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 *
 * ObservationPack's pure surface: which results are packable, and what the
 * placeholder says.
 *
 * Kept apart from the plugin entry so the eligibility rule can be tested
 * without a Cordis context. The rule is the mechanism's main safety property —
 * a result that is packed must remain reachable, and one that is not entirely
 * text must be left alone rather than half-archived.
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { digestOf, type SourceDigest } from '../shared/digest.js'

/** First line of every placeholder, so a packed result is recognizable at a glance. */
export const PLACEHOLDER_HEADER = 'sol_dsh_observation_v1' as const

/** Suffix for the archive artifact's suggested name. */
export const OBSERVATION_SUFFIX = '.observation.log' as const

/**
 * Flatten a result that is entirely text, or `undefined` when it carries any
 * non-text block.
 *
 * Images and files cannot be archived as UTF-8 text, so a result containing one
 * is refused whole: packing it would mean either losing the non-text block or
 * claiming an archive that does not hold it.
 * @param content - the result's model-facing blocks.
 * @returns the joined text, or `undefined` when any block is not text.
 */
export function textOnly(content: readonly ContentBlock[]): string | undefined {
  let text = ''
  for (const block of content) {
    if (block.type !== 'text') return undefined
    text += text === '' ? block.text : `\n${block.text}`
  }
  return text
}

/**
 * Render the short stand-in that replaces a packed result.
 * @param digest - identity and size of the archived original.
 * @param locator - backend locator for the archived copy.
 * @param retrievalHint - the backend's guidance for reading the archive back.
 * @returns the placeholder text.
 */
export function placeholderText(digest: SourceDigest, locator: string, retrievalHint: string): string {
  return [
    PLACEHOLDER_HEADER,
    `bytes=${digest.bytes} lines=${digest.lines}`,
    `sha256=${digest.hash}`,
    `locator=${locator}`,
    `readback=${retrievalHint}`,
    'note=the complete result is archived; read the locator when exact context is needed',
  ].join('\n')
}

/**
 * Whether one result is worth packing.
 *
 * @param content - the result's model-facing blocks.
 * @param minBytes - smallest result this deployment considers packable.
 * @returns the archived body and its digest, or `undefined` when ineligible.
 */
export function packable(
  content: readonly ContentBlock[],
  minBytes: number,
): { body: string; digest: SourceDigest } | undefined {
  const body = textOnly(content)
  if (body === undefined) return undefined
  const digest = digestOf(body)
  if (digest.bytes < minBytes) return undefined
  return { body, digest }
}
