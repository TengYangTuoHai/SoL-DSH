/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 *
 * Action Fusion for DeepSeek Harness.
 *
 * Rollouts repeatedly show the same pair of turns: edit or write a file, then
 * run a command to test, build, or start it. Action Fusion replaces each
 * configured mutation tool with a variant that also accepts an optional
 * `then_run`, applies the mutation, runs the command, and returns one combined
 * observation. The model decision between the two turns disappears.
 *
 * Mechanism — wrap, do not reimplement.
 *
 * The harness does not export the shipped `write`/`edit` tool definitions, so
 * this plugin wraps whatever is globally registered instead of rebuilding it:
 *
 * 1. `ctx.tools.get(name)` reads the global definition, including its compiled
 *    JSON Schema, its canonical output contract, its renderer, and its
 *    presentation projections.
 * 2. A shadow is registered through `agent.ctx`, which is legal because the
 *    duplicate check is per layer and scoped registrations shadow inherited
 *    ones. Registering globally would throw.
 * 3. The shadow reuses the base `output` object untouched and forwards every
 *    other member, so the sandbox escalation fields, the `fs/write-intent`
 *    read-before-write gate, and the `write`/`edit` UI diff cards all keep
 *    working exactly as shipped.
 *
 * The follow-up command is dispatched through `ctx.tools.execute()`, not by
 * calling the shell executor directly, so it traverses the full pipeline:
 * approval policy, monotonic guards, sandbox resolution, and result
 * post-processing. A fused command is therefore subject to the same policy as
 * one the model issued on its own.
 *
 * The canonical value is never widened. `execute` returns the base mutation's
 * value unchanged, and the command's observation is grafted onto the
 * model-facing content in `finalizeContent`, which is the documented hook for a
 * last-mile content transform. That keeps the value shape the shipped UI cards
 * and programmatic callers already expect.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, ToolCallId } from '@deepseek-ai/dsh-llm'
import { ToolCallId as brandToolCallId } from '@deepseek-ai/dsh-llm'
import type {
  ToolDefinition,
  ToolExecution,
  ToolExecutionResult,
  ToolRunContext,
} from '@deepseek-ai/dsh-tools'
import { errorMessage, isRecord, recordValue } from '../shared/digest.js'
import {
  observationBlocks,
  parseThenRun,
  THEN_RUN_FAILED,
  THEN_RUN_SKIPPED,
  THEN_RUN_SUCCEEDED,
  splitThenRun,
  THEN_RUN_BLURB,
  THEN_RUN_PARAM,
  thenRunArguments,
  withThenRun,
  type ThenRunInput,
} from './params.js'
import { Config as ConfigSchema, type Config as ActionFusionConfig } from './config.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'sol-dsh-action-fusion'

/** Services this plugin needs before it may load. */
export const inject = ['agents', 'tools'] as const

/** Cordis reads this schema to validate the bundle layer and fill defaults. */
export const Config = ConfigSchema


/** Per-call command observations awaiting the finalizeContent hook. */
const pendingObservations = new Map<string, ContentBlock[]>()


/**
 * Dispatch the follow-up command through the normal tool pipeline.
 *
 * Going through `ctx.tools.execute` rather than the shell executor is what keeps
 * the fused command under the same approval, guard, and sandbox policy as a
 * directly issued one.
 * @returns the observation to graft onto the model-facing content.
 */
async function dispatchThenRun(
  ctx: Context,
  config: ActionFusionConfig,
  exec: ToolRunContext,
  toolName: string,
  input: ThenRunInput,
): Promise<ContentBlock[]> {
  const agent = exec.agent
  const outcome: ToolExecutionResult = await ctx.tools.execute({
    callId: brandToolCallId(`${String(exec.callId)}:then-run:1`) as ToolCallId,
    rootCallId: exec.rootCallId,
    name: config.shellTool,
    arguments: thenRunArguments(input, toolName),
    ...agent === undefined ? {} : { agent },
    signal: exec.signal,
  })
  // A non-zero exit is a successful tool call describing a failed command, so
  // it is reported rather than raised: the mutation stands either way.
  if (outcome.isError) {
    ctx.logger.info(`sol-dsh: fused command for ${toolName} did not run: ${outcome.error.message}`)
  } else {
    ctx.logger.info(`sol-dsh: fused ${toolName} with one command (${config.shellTool})`)
  }
  return observationBlocks(outcome)
}

/**
 * Build the shadow definition for one base tool.
 * @param ctx - plugin context owning the tool runtime.
 * @param config - validated bundle configuration.
 * @param toolName - the tool being fused.
 * @param base - the globally registered definition being extended.
 * @returns the definition to register in the agent's scope.
 */
function fuseDefinition(
  ctx: Context,
  config: ActionFusionConfig,
  toolName: string,
  base: ToolDefinition,
): ToolDefinition {
  const fused: ToolDefinition = {
    ...base,
    description: `${base.description}${THEN_RUN_BLURB}`,
    parameters: withThenRun(base.parameters),
    // `output` is borrowed, never rebuilt: its schema, renderer, and
    // presentation projections are exactly the shipped ones.
    output: base.output,
    async execute(args: unknown, exec: ToolRunContext): Promise<unknown> {
      const record = isRecord(args) ? args : {}
      const { then_run: thenRun, ...baseArgs } = record
      // A failing mutation throws here, which skips the command entirely and
      // leaves the base error handling untouched.
      const value = await base.execute(baseArgs, exec)
      if (thenRun === undefined) return value
      const input = parseThenRun(
        thenRun,
        `Run the follow-up command for ${toolName}`,
        config.defaultTimeoutMs,
      )
      if (input === undefined) {
        pendingObservations.set(String(exec.callId), [
          { type: 'text', text: `${THEN_RUN_SKIPPED} then_run did not name a command` },
        ])
        return value
      }
      try {
        pendingObservations.set(
          String(exec.callId),
          await dispatchThenRun(ctx, config, exec, toolName, input),
        )
      } catch (error: unknown) {
        // The mutation succeeded; a broken dispatch must not turn it into a
        // failure, or the model would be told its edit failed when it did not.
        ctx.logger.warn(`sol-dsh: fused command dispatch failed: ${errorMessage(error)}`)
        pendingObservations.set(String(exec.callId), [
          { type: 'text', text: `${THEN_RUN_FAILED} dispatch error: ${errorMessage(error)}` },
        ])
      }
      return value
    },
    finalizeContent(
      exec: Readonly<ToolExecution>,
      result: Readonly<ToolExecutionResult>,
    ): ContentBlock[] | undefined {
      const key = String(exec.callId)
      const observation = pendingObservations.get(key)
      if (observation === undefined) return undefined
      pendingObservations.delete(key)
      return [...result.content, ...observation]
    },
  }
  return fused
}

/**
 * Register shadows for one agent.
 * @returns the installed fiber, or `undefined` when nothing was installed.
 */
function installForAgent(
  ctx: Context,
  config: ActionFusionConfig,
  agent: Agent,
): ReturnType<Context['inject']> {
  return agent.ctx.inject(['tools'], (scope) => {
    for (const toolName of config.tools) {
      // The GLOBAL view is the base: reading the agent's view could pick up an
      // earlier shadow of our own and nest wrappers on a re-install.
      const base = ctx.tools.get(toolName)
      if (base === undefined) {
        ctx.logger.info(`sol-dsh: action fusion skipped "${toolName}" (not registered in this composition)`)
        continue
      }
      scope.tools.register(fuseDefinition(ctx, config, toolName, base))
    }
  })
}

/**
 * Register the per-agent tool shadows.
 * @param ctx - the plugin context; `ctx.on` registers an effect that unloads with the plugin.
 * @param config - validated bundle configuration.
 */
export function apply(ctx: Context, config: ActionFusionConfig): void {
  if (!config.enabled) {
    ctx.logger.info('sol-dsh: action fusion is disabled by configuration')
    return
  }
  const fibers = new Map<Agent, ReturnType<Context['inject']>>()
  const install = (agent: Agent): void => {
    if (fibers.has(agent)) return
    fibers.set(agent, installForAgent(ctx, config, agent))
  }
  for (const agent of ctx.agents.list()) install(agent)
  // `agent/created` is serial: its listener must return `undefined` explicitly
  // rather than a void block body.
  ctx.on('agent/created', ({ agent }) => {
    install(agent)
    return undefined
  })
  // The shadow fibers hang off each agent's context, not this plugin's, so they
  // must be disposed explicitly when the plugin unloads.
  ctx.effect(() => async () => {
    const installed = [...fibers.values()]
    fibers.clear()
    await Promise.all(installed.map(fiber => fiber.dispose()))
  })
  ctx.logger.info(
    `sol-dsh: action fusion active (fusing ${config.tools.join(', ')} with ${config.shellTool})`,
  )
}

export { THEN_RUN_FAILED, THEN_RUN_SKIPPED, THEN_RUN_SUCCEEDED } from './params.js'
