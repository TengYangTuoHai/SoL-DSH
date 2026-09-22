/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 *
 * Evidence-Preserving Reducer for DeepSeek Harness.
 *
 * A long build or test log usually changes the next decision through only a few
 * lines. This plugin archives the complete log, delegates the first reading of
 * it to a reducer model, and accepts the resulting receipt only when every
 * quoted line is found byte for byte in the archive. A receipt that cannot be
 * checked is discarded and the original output reaches the frontier agent
 * untouched, so delegation never requires trusting a fluent summary.
 *
 * The mechanism is one `tools/post-execute` waterfall listener: it replaces the
 * model-facing content of an eligible result, leaving the canonical value and
 * the durable session log intact.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
// Type-only: loads the `ctx.spillStore` declaration-merged Context member.
import type {} from '@deepseek-ai/dsh-spill'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { compileCommandPatterns, Config as ConfigSchema, type Config } from './reducer/config.js'
import { callReducer, resolveRoute } from './reducer/provider.js'
import { receiptText, validateReceipt } from './reducer/receipt.js'
import { probeReducerSource } from './reducer/source.js'
import { digestOf, errorMessage } from './shared/digest.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'sol-dsh-evidence-preserving-reducer'

/** Services this plugin needs before it may load. */
export const inject = ['tools', 'llm', 'spillStore'] as const

/**
 * Cordis reads this schema to validate the bundle layer and fill defaults.
 * Every field the shipped `cordis.patch.yml` sets is declared here.
 */
export { ConfigSchema as Config }

/** UTF-8 byte length of one model-facing content array. */
function contentBytes(content: readonly ContentBlock[]): number {
  let bytes = 0
  for (const block of content) {
    if (block.type === 'text') bytes += Buffer.byteLength(block.text, 'utf8')
  }
  return bytes
}

/**
 * Reduce one settled tool result, or return the decision unchanged.
 *
 * Every step below is fail-open: a refused receipt, an unavailable reducer
 * route, a model error, or an internal fault leaves the frontier agent with the
 * original observation. That is the point of the mechanism — reduction is an
 * optimization, never a precondition for correctness.
 */
async function reduceDecision(
  ctx: Context,
  config: Config,
  patterns: readonly RegExp[],
  exec: ToolExecution,
  result: Readonly<ToolExecutionResult>,
  decision: PostToolDecision,
): Promise<PostToolDecision> {
  if (decision.kind !== 'accept') return decision
  const agent: Agent | undefined = exec.agent
  if (agent === undefined) return decision

  const probe = await probeReducerSource(exec, result, decision, patterns)
  if (probe.kind === 'refuse') {
    ctx.logger.info(`sol-dsh: reducer refused a candidate (${probe.reason})`)
    return decision
  }
  if (probe.kind === 'skip') return decision
  const { source } = probe

  if (Buffer.byteLength(source.body, 'utf8') < config.minBytes) return decision
  if (source.body.length > config.maxChars) {
    ctx.logger.info(
      `sol-dsh: reducer skipped an oversized source (${source.body.length} chars > maxChars ${config.maxChars})`,
    )
    return decision
  }

  const route = resolveRoute(config, agent)
  if (route === undefined) {
    ctx.logger.warn('sol-dsh: no reducer route is available; keeping the original tool result')
    return decision
  }

  const digest = digestOf(source.body)
  const call = await callReducer(
    ctx,
    config,
    route,
    source.command,
    source.isError,
    digest,
    source.body,
    agent.session.id,
    exec.signal,
  )
  if (!call.ok) {
    ctx.logger.info(`sol-dsh: reducer fell back (${call.stopReason}): ${call.errorMessage ?? 'no output'}`)
    return decision
  }

  const checked = validateReceipt(call.outputText, digest, source.body, source.isError)
  if (!checked.ok) {
    ctx.logger.info(`sol-dsh: reducer receipt refused (${checked.reason}); keeping the original tool result`)
    return decision
  }

  // The source is persisted only once a receipt has survived every check, so a
  // refused reduction leaves no orphan artifact behind.
  const artifact = await ctx.spillStore.saveText({
    owner: { sessionId: agent.session.id },
    source: {
      kind: 'tool',
      toolName: exec.name,
      callId: exec.callId,
      label: 'evidence-preserving-reducer-source',
    },
    suggestedName: `${digest.hash.slice(0, 16)}.log`,
    content: source.body,
  })

  const receipt = receiptText(
    source.command,
    digest,
    { locator: artifact.locator, retrievalHint: artifact.retrievalHint },
    checked.value,
    { provider: route.provider, model: route.model, totalTokens: call.totalTokens },
  )
  const content = source.projectReceipt(receipt)
  const receiptBytes = contentBytes(content)
  if (receiptBytes >= digest.bytes) {
    ctx.logger.info(
      `sol-dsh: reducer receipt (${receiptBytes} B) was not smaller than the source (${digest.bytes} B); keeping the original`,
    )
    return decision
  }

  ctx.logger.info(
    `sol-dsh: reducer replaced ${digest.bytes} source bytes with a verified receipt `
    + `(${checked.value.evidence.length} evidence items, ${route.provider}/${route.model})`,
  )
  return { kind: 'accept', content }
}

/**
 * Register the reducer's single interception point.
 * @param ctx - the plugin context; `ctx.on` registers an effect that unloads with the plugin.
 * @param config - validated bundle configuration.
 */
export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) {
    ctx.logger.info('sol-dsh: evidence-preserving reducer is disabled by configuration')
    return
  }
  const patterns = compileCommandPatterns(config.commandPatterns)
  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    // `next()` runs the rest of the chain first, so this listener enriches the
    // settled decision rather than competing for it.
    const decision = await next()
    try {
      return await reduceDecision(ctx, config, patterns, exec, result, decision)
    } catch (error: unknown) {
      ctx.logger.warn(`sol-dsh: reducer failed open on ${exec.name}: ${errorMessage(error)}`)
      return decision
    }
  })
  ctx.logger.info(`sol-dsh: evidence-preserving reducer active (${config.commandPatterns.length} command patterns)`)
}
