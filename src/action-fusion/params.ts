/** Markers the model can read at a glance, and that a later reader can search for. */
export const THEN_RUN_SUCCEEDED = '[then_run:succeeded]' as const
export const THEN_RUN_FAILED = '[then_run:failed]' as const
export const THEN_RUN_SKIPPED = '[then_run:skipped]' as const

/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 *
 * Action Fusion's parameter surface: the `then_run` schema added to a fused
 * tool, and the pure parsing of one model-supplied value.
 *
 * These live apart from the plugin entry so they can be tested without a
 * running Cordis context, because both encode decisions that are easy to get
 * subtly wrong:
 *
 * - the added property must remain OPTIONAL, or the model would be forced to
 *   chain a command on every mutation;
 * - `timeoutMs` must be OMITTED rather than set to `undefined` when absent,
 *   because tool arguments cross a lossless-JSON boundary and `undefined` is
 *   not a JSON value.
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { isRecord, recordValue } from '../shared/digest.js'

/** One parsed `then_run` request. */
export interface ThenRunInput {
  readonly command: string
  readonly description: string
  /** `undefined` means "use the configured default", and must stay absent from the arguments. */
  readonly timeoutMs: number | undefined
}

/** The parameter name added to every fused tool. */
export const THEN_RUN_PARAM = 'then_run' as const

/** Guidance appended to a fused tool's description. */
export const THEN_RUN_BLURB =
  ' Optionally chain one shell command that runs only after this call succeeds — '
  + 'use it for the test, build, or start step that would otherwise be your next call. '
  + 'If the mutation fails the command is skipped; a non-zero exit is reported but keeps the mutation.'

/** The `then_run` parameter added to every fused tool. */
export const THEN_RUN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    command: {
      type: 'string',
      description: 'Shell command to run next on this file after the mutation succeeds.',
    },
    description: {
      type: 'string',
      description: 'Clear, concise description of what the command does, 5-10 words (shown in the UI).',
    },
    timeoutMs: {
      type: 'number',
      description: 'Timeout in milliseconds for the follow-up command.',
    },
  },
  required: ['command'],
} as const

/**
 * Extend one base tool definition's parameter schema with `then_run`.
 *
 * The compiled root carries no `additionalProperties: false`, so the synthetic
 * argument object may be handed to the base `execute` unchanged — it ignores
 * the extra key — while the model still sees `then_run` in the schema.
 * @param parameters - the base tool's compiled parameter schema.
 * @returns a copy declaring the same properties plus `then_run`.
 */
export function withThenRun(parameters: Record<string, unknown>): Record<string, unknown> {
  const properties = isRecord(parameters['properties']) ? parameters['properties'] : {}
  return { ...parameters, properties: { ...properties, [THEN_RUN_PARAM]: THEN_RUN_SCHEMA } }
}

/**
 * Split one fused call's arguments into the base tool's arguments and the
 * optional follow-up request, without mutating the caller's object.
 * @param args - the frozen model-supplied arguments.
 * @returns the base arguments and the raw `then_run` value when present.
 */
export function splitThenRun(args: unknown): { baseArgs: Record<string, unknown>; thenRun: unknown } {
  const record = isRecord(args) ? args : {}
  const { [THEN_RUN_PARAM]: thenRun, ...baseArgs } = record
  return { baseArgs, thenRun }
}

/**
 * Parse one `then_run` value, or `undefined` when it cannot name a command.
 * @param value - the raw model-supplied value.
 * @param fallbackDescription - the description to use when none was supplied.
 * @param defaultTimeoutMs - the timeout to use when none was supplied.
 * @returns the parsed request, or `undefined` when no command was named.
 */
export function parseThenRun(
  value: unknown,
  fallbackDescription: string,
  defaultTimeoutMs: number,
): ThenRunInput | undefined {
  if (!isRecord(value)) return undefined
  const command = recordValue(value, 'command')
  if (typeof command !== 'string' || command.trim() === '') return undefined
  const rawDescription = recordValue(value, 'description')
  const description = typeof rawDescription === 'string' && rawDescription.trim() !== ''
    ? rawDescription
    : fallbackDescription
  const rawTimeout = recordValue(value, 'timeoutMs')
  const timeoutMs = typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
    ? rawTimeout
    : defaultTimeoutMs
  return { command, description, timeoutMs }
}

/**
 * Build the `arguments` object for the follow-up shell dispatch.
 *
 * `timeoutMs` is omitted rather than set to `undefined`: arguments cross a
 * lossless-JSON boundary, and `undefined` is not a JSON value.
 * @param input - the parsed follow-up request.
 * @param toolName - the tool being fused, used to synthesize a description.
 * @returns the losslessly serializable arguments for the shell tool.
 */
export function thenRunArguments(input: ThenRunInput, toolName: string): Record<string, unknown> {
  return {
    command: input.command,
    description: input.description === '' ? `Run the follow-up command for ${toolName}` : input.description,
    ...input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs },
  }
}
/**
 * Human-readable header for one command observation.
 *
 * The marker follows the COMMAND's outcome, not the tool call's. In this
 * harness a non-zero exit is a successful shell call describing a failed
 * command, so reading `isError` alone would label a failing build as a success —
 * the most decision-relevant case this mechanism produces.
 */
export function observationHeader(outcome: ToolExecutionResult): string {
  if (outcome.isError) return `${THEN_RUN_FAILED} the command did not run: ${outcome.error.message}`
  const exitCode = recordValue(outcome.value, 'exitCode')
  if (typeof exitCode !== 'number') return `${THEN_RUN_SUCCEEDED} the command ran (no exit status reported)`
  return exitCode === 0
    ? `${THEN_RUN_SUCCEEDED} exit=0`
    : `${THEN_RUN_FAILED} exit=${exitCode} (the mutation was applied and kept)`
}

/**
 * The observation grafted onto the model-facing content.
 *
 * The marker is its own content block, but a consumer that joins text blocks
 * without a separator would read `[then_run:succeeded] exit=0` and the first
 * line of output as one word — observed in practice, where the model reported
 * `exit=0REGRESSION_OK`. The trailing newline makes the boundary survive both a
 * separator-inserting and a naive concatenating join.
 */
export function observationBlocks(outcome: ToolExecutionResult): ContentBlock[] {
  return [{ type: 'text', text: `${observationHeader(outcome)}\n` }, ...outcome.content]
}
