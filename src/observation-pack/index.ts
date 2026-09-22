/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 *
 * ObservationPack for DeepSeek Harness.
 *
 * A large tool result is usually read once and then replayed into every later
 * provider request. This mechanism sends such a result in full for its first
 * few requests, then replaces it with a short placeholder that names an
 * archived copy, so recall stays possible without replay.
 *
 * Mechanism note — why this is not a message projection.
 *
 * SoL-Pi implements ObservationPack as a `context` projection: it rewrites the
 * message list per request without touching stored history. The comparable
 * harness seam is `ctx.sessions.registerMessageProjection`, but that seam needs
 * a plugin-owned session event to describe the change, and an out-of-tree
 * plugin cannot write one: `Session.append` offers no way to mark an event
 * `ignorable`, while the persistence read path refuses a log containing an
 * unknown event type that is not so marked. A plugin taking that route would
 * produce a session log that cannot be resumed.
 *
 * The supported path is the surface replacement protocol the harness already
 * ships for exactly this purpose: append a `compaction/prune` shadow-price
 * event, then append the replacement `tool/result` with a `replace` surface
 * operation citing the shadowed node. Both types are known to the harness, the
 * replacement is log-only with respect to the canonical value, and the
 * original event stays in the log for replay and inspection. The compaction
 * invariant validates `compaction/prune` on its own, so a bare prune outside a
 * compaction transaction is legal.
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: loads the `ctx.tokenMeter` and `compaction/prune` declarations.
import type {} from '@deepseek-ai/dsh-compaction'
import type {} from '@deepseek-ai/dsh-token-meter'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, ToolResultMessage } from '@deepseek-ai/dsh-llm'
import { freezeMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import { digestOf, errorMessage, type SourceDigest } from '../shared/digest.js'
import { Config as ConfigSchema, type Config as ObservationPackConfig } from './config.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'sol-dsh-observation-pack'

/** Services this plugin needs before it may load. */
export const inject = ['tokenMeter', 'spillStore'] as const

/** Cordis reads this schema to validate the bundle layer and fill defaults. */
export const Config = ConfigSchema

/** First line of every placeholder, so a packed result is recognizable at a glance. */
export const PLACEHOLDER_HEADER = 'sol_dsh_observation_v1' as const

/**
 * Flatten a result that is entirely text, or `undefined` when it carries any
 * non-text block. Images and files cannot be archived as UTF-8 text, so those
 * results are left alone rather than half-packed.
 */
function textOnly(content: readonly ContentBlock[]): string | undefined {
  let text = ''
  for (const block of content) {
    if (block.type !== 'text') return undefined
    text += text === '' ? block.text : `\n${block.text}`
  }
  return text
}

/** The short stand-in that replaces a packed result. */
function placeholderText(toolName: string, digest: SourceDigest, locator: string, readback: string): string {
  return [
    PLACEHOLDER_HEADER,
    `tool=${toolName}`,
    `bytes=${digest.bytes} lines=${digest.lines}`,
    `sha256=${digest.hash}`,
    `locator=${locator}`,
    `readback=${readback}`,
    'note=the complete result is archived; read the locator when exact context is needed',
  ].join('\n')
}

/** One current-surface tool result, with its position in model-visible order. */
interface Candidate {
  readonly seq: SessionSeq
  readonly position: number
  readonly event: SessionEvent<'tool/result'>
}

/**
 * Pack every eligible result of one agent's current surface.
 *
 * Eligibility is deliberately conservative: the result must be a current
 * surface node (so a previously packed node, whose original seq is now
 * shadowed, is never revisited), must be entirely text, must exceed
 * `minBytes`, and must already have `fullSends` assistant messages after it.
 * @param ctx - plugin context providing the token meter and spill store.
 * @param config - validated bundle configuration.
 * @param agent - the agent whose session surface is rewritten.
 * @returns the number of landed replacements.
 */
async function packAgent(ctx: Context, config: ObservationPackConfig, agent: Agent): Promise<number> {
  const session: Session = agent.session
  const nodes = [...session.surface.nodes]
  if (nodes.length === 0) return 0

  // Assistant messages after each surface position: a result is sent in full
  // for the requests it accompanies, so this count is exactly how many times
  // the frontier agent has already had the original in context.
  const assistantAfter = new Array<number>(nodes.length).fill(0)
  let seen = 0
  const events = new Map<SessionSeq, SessionEvent>()
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const seq = nodes[index] as SessionSeq
    // oxlint-disable-next-line typescript/no-deprecated -- Existing session history read, as the shipped pruner also does.
    const event = session.eventAt(seq)
    if (event === undefined) continue
    events.set(seq, event)
    assistantAfter[index] = seen
    if (event.type === 'assistant/message') seen += 1
  }

  const candidates: Candidate[] = []
  for (let index = 0; index < nodes.length; index += 1) {
    const seq = nodes[index] as SessionSeq
    const event = events.get(seq)
    if (event?.type !== 'tool/result') continue
    if ((assistantAfter[index] ?? 0) < config.fullSends) continue
    candidates.push({ seq, position: index, event })
  }
  if (candidates.length === 0) return 0

  let replaced = 0
  for (const candidate of candidates) {
    if (replaced >= config.maxPerPass) break
    const original = candidate.event.data.message as ToolResultMessage
    const body = textOnly(original.content)
    if (body === undefined) continue
    const digest = digestOf(body)
    if (digest.bytes < config.minBytes) continue

    // Archive first: a replacement whose original is unreachable would destroy
    // the observation instead of deferring it.
    const artifact = await ctx.spillStore.saveText({
      owner: { sessionId: session.id },
      source: {
        kind: 'tool',
        toolName: 'tool/result',
        callId: original.source.callId,
        label: 'observation-pack',
      },
      suggestedName: `${digest.hash.slice(0, 16)}.observation.log`,
      content: body,
    })

    const placeholder = placeholderText(
      'tool/result',
      digest,
      artifact.locator,
      artifact.retrievalHint,
    )
    const message = freezeMessage<ToolResultMessage>({
      ...original,
      content: [{ type: 'text', text: placeholder }],
    })

    // Shadow-price protocol: the metering event is appended immediately before
    // its replacement, so a pure consumer can subtract the shadowed node's
    // price without retaining per-node state.
    session.append('compaction/prune', {
      shadowedRange: { start: candidate.seq, end: candidate.seq },
      shadowedSeqs: [candidate.seq],
      shadowedTokenCount: ctx.tokenMeter.estimateMessage(original),
    })
    session.append('tool/result', { ...candidate.event.data, message }, {
      surfaceOp: { op: 'replace', startSeq: candidate.seq, endSeq: candidate.seq },
      sourceEventSeqs: [candidate.seq],
    })
    replaced += 1
    ctx.logger.info(
      `sol-dsh: packed a ${digest.bytes}-byte tool result after ${config.fullSends} sends `
      + `(${digest.lines} lines -> locator ${artifact.locator})`,
    )
  }
  return replaced
}

/**
 * Register the packer's interception point.
 *
 * `agent/pre-step` is a serial waterfall that runs before request derivation, so
 * a replacement committed here is visible to the request the same step issues.
 * The shipped compaction backend appends session events from the same seam,
 * which makes this a supported time to mutate the surface.
 * @param ctx - the plugin context; `ctx.on` registers an effect that unloads with the plugin.
 * @param config - validated bundle configuration.
 */
export function apply(ctx: Context, config: ObservationPackConfig): void {
  if (!config.enabled) {
    ctx.logger.info('sol-dsh: observation pack is disabled by configuration')
    return
  }
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    if (!signal.aborted) {
      try {
        await packAgent(ctx, config, agent)
      } catch (error: unknown) {
        // Fail open: packing is an optimization, and a failure must never cost
        // the agent the turn it is about to take.
        ctx.logger.warn(`sol-dsh: observation pack failed open: ${errorMessage(error)}`)
      }
    }
    return next()
  })
  ctx.logger.info(
    `sol-dsh: observation pack active (minBytes ${config.minBytes}, fullSends ${config.fullSends})`,
  )
}
