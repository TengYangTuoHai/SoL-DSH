/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 *
 * Adapted for DeepSeek Harness: the reducer call goes through the harness
 * `ctx.llm` seam, which owns provider routing and credential resolution, so
 * this module never handles a credential. The Pi-specific compatibility
 * fallback for a registry without `complete()` is gone, because the harness
 * exposes exactly one supported path into provider adapters.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SourceDigest } from '../shared/digest.js'
import type { Config } from './config.js'
import { reducerInput, reducerInstructions } from './receipt.js'

/** The exact provider route one reducer call is dispatched to. */
export interface ReducerRoute {
  readonly provider: string
  readonly model: string
}

/** Normalized outcome of one reducer model call. */
export interface ReducerCallResult {
  readonly ok: boolean
  /** Concatenated assistant text, empty when the call produced none. */
  readonly outputText: string
  readonly totalTokens: number
  readonly stopReason: string
  readonly errorMessage: string | undefined
}

/**
 * Resolve the reducer route: an explicit configuration wins, otherwise the
 * session's own routed model reduces the log.
 * @param config - effective plugin configuration.
 * @param agent - the agent whose session owns the logged request route.
 * @returns the route to call, or `undefined` when neither source provides one.
 */
export function resolveRoute(config: Config, agent: Agent): ReducerRoute | undefined {
  if (config.reducerProvider !== '' && config.reducerModel !== '') {
    return { provider: config.reducerProvider, model: config.reducerModel }
  }
  const header = agent.session.requestHeader()
  if (header === undefined) return undefined
  const { provider, model } = header.config
  if (provider === '' || model === '') return undefined
  return { provider, model }
}

/**
 * Combine the caller's cancellation with a wall-clock deadline, so one slow
 * reducer call can never hold a tool result open past its budget.
 */
function operationSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): { readonly signal: AbortSignal; readonly cleanup: () => void } {
  const controller = new AbortController()
  const relay = (): void => controller.abort(parent?.reason)
  if (parent?.aborted === true) relay()
  else parent?.addEventListener('abort', relay, { once: true })
  const timer = setTimeout(
    () => controller.abort(new DOMException('Reducer model call timed out', 'AbortError')),
    timeoutMs,
  )
  if (typeof timer === 'object' && 'unref' in timer) timer.unref()
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer)
      parent?.removeEventListener('abort', relay)
    },
  }
}

/**
 * Delegate one log to the reducer model and collect its single text response.
 *
 * Credentials and adapter selection stay inside the harness: this call names a
 * provider route and a model, nothing else. The failure is returned rather than
 * thrown so the caller can keep the original tool result.
 * @param ctx - plugin context providing the `llm` seam.
 * @param config - effective plugin configuration.
 * @param route - the resolved reducer route.
 * @param command - the shell command that produced the log.
 * @param isError - whether the command itself reported failure.
 * @param digest - the source identity the receipt must echo.
 * @param body - the complete log text.
 * @param sessionId - owning session, stamped on the request for routing.
 * @param parentSignal - the tool call's cancellation signal, when one exists.
 * @returns the normalized call outcome.
 */
export async function callReducer(
  ctx: Context,
  config: Config,
  route: ReducerRoute,
  command: string,
  isError: boolean,
  digest: SourceDigest,
  body: string,
  sessionId: Agent['session']['id'],
  parentSignal: AbortSignal | undefined,
): Promise<ReducerCallResult> {
  const operation = operationSignal(parentSignal, config.timeoutMs)
  let outputText = ''
  let totalTokens = 0
  let stopReason = 'unknown'
  let errorMessage: string | undefined
  try {
    const stream = ctx.llm.stream({
      provider: route.provider,
      model: route.model,
      system: reducerInstructions(),
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: reducerInput(command, isError, digest, body) }],
        },
      ],
      maxTokens: config.maxOutputTokens,
      signal: operation.signal,
      sessionId,
    })
    for await (const chunk of stream) {
      switch (chunk.type) {
        case 'text-delta':
          outputText += chunk.text
          break
        case 'usage':
          // The adapter omits `totalTokens` when its provider reports no
          // consistent aggregate, so fall back to the two authoritative halves.
          totalTokens = chunk.usage.totalTokens
            ?? chunk.usage.inputTokens + chunk.usage.outputTokens
          break
        case 'finish':
          stopReason = chunk.reason.kind
          break
        default:
          break
      }
    }
  } catch (error: unknown) {
    errorMessage = error instanceof Error ? error.message : String(error)
    stopReason = error instanceof Error && error.name === 'AbortError' ? 'aborted' : 'exception'
  } finally {
    operation.cleanup()
  }

  if (errorMessage !== undefined) return { ok: false, outputText, totalTokens, stopReason, errorMessage }
  if (stopReason === 'max-tokens' || stopReason === 'length') {
    return { ok: false, outputText, totalTokens, stopReason, errorMessage: 'reducer response was truncated' }
  }
  return { ok: true, outputText, totalTokens, stopReason, errorMessage: undefined }
}
