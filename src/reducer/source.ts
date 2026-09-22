/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 *
 * Adapted for DeepSeek Harness. The original located a Pi `bash` result and
 * recovered pi's untruncated output log; this version reads the harness bash
 * tool's canonical value, whose `stdout`/`stderr` streams carry an optional
 * `spillPath` holding the complete output, and falls back to the persisted
 * spill-policy notice when only the model-facing content is available.
 */
import { readFile } from 'node:fs/promises'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { isRecord, recordValue } from '../shared/digest.js'
import { LIKELY_SECRET } from './config.js'

/** Exact prefix of the spill-policy notice, mirroring `@deepseek-ai/dsh-spill-policy/notice`. */
const NOTICE_LOCATION = ' Full formatted result stored at: '
/** Separator between the assembled stdout and stderr sections. */
const STDERR_MARKER = '\n[stderr]\n'

/** A tool result the reducer is allowed to consider, plus the exact text to reduce. */
export interface ReducerSource {
  /** The shell command that produced the log. */
  readonly command: string
  /** The complete log text every evidence quote is checked against. */
  readonly body: string
  /** Whether the command itself reported failure. */
  readonly isError: boolean
  /** Replace the model-facing content with an accepted receipt. */
  readonly projectReceipt: (receipt: string) => ContentBlock[]
}

/** Why a tool result was not reduced. */
export type SourceProbe =
  | { readonly kind: 'skip' }
  | { readonly kind: 'refuse'; readonly reason: string }
  | { readonly kind: 'source'; readonly source: ReducerSource }

/** Concatenate the text blocks of one model-facing content array. */
function textOf(content: readonly ContentBlock[]): string {
  let text = ''
  for (const block of content) {
    if (block.type !== 'text') continue
    text += text === '' ? block.text : `\n${block.text}`
  }
  return text
}

/** Read one file, or `undefined` when it cannot be read as text. */
async function fileText(path: string): Promise<string | undefined> {
  if (path === '' || path.includes('\n')) return undefined
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

/** One canonical bash output stream. */
interface CanonicalStream {
  readonly text: string | undefined
  readonly spillPath: string | undefined
}

/** Narrow one `stdout`/`stderr` member of the bash tool's canonical value. */
function streamOf(value: Record<string, unknown>, key: string): CanonicalStream | undefined {
  const stream = value[key]
  if (!isRecord(stream)) return undefined
  return {
    text: typeof stream['text'] === 'string' ? stream['text'] : undefined,
    spillPath: typeof stream['spillPath'] === 'string' ? stream['spillPath'] : undefined,
  }
}

/** Assemble the complete log from the bash tool's canonical value. */
async function bodyFromValue(
  value: unknown,
): Promise<{ readonly body: string; readonly exitCode: number | undefined } | undefined> {
  if (!isRecord(value)) return undefined
  const out = streamOf(value, 'stdout')
  if (out === undefined) return undefined
  const err = streamOf(value, 'stderr')
  // A stream that was truncated on the wire keeps its complete bytes at spillPath.
  const stdout = (await fileText(out.spillPath ?? '')) ?? out.text ?? ''
  const stderr = err === undefined ? '' : (await fileText(err.spillPath ?? '')) ?? err.text ?? ''
  const exitCode = typeof value['exitCode'] === 'number' ? value['exitCode'] : undefined
  return { body: stderr === '' ? stdout : `${stdout}${STDERR_MARKER}${stderr}`, exitCode }
}

/**
 * Recover the complete log from a persisted spill-policy notice.
 *
 * The notice ends with `<locator>. <retrievalHint>)`, and neither part may be
 * split on the separator `. ` unambiguously, so each separator position is
 * tried as a real file until one reads back.
 */
async function bodyFromNotice(text: string): Promise<string | undefined> {
  const at = text.lastIndexOf(NOTICE_LOCATION)
  if (at < 0) return undefined
  const rest = text.slice(at + NOTICE_LOCATION.length, text.endsWith(')') ? text.length - 1 : text.length)
  for (let index = rest.indexOf('. '); index > 0; index = rest.indexOf('. ', index + 1)) {
    const content = await fileText(rest.slice(0, index))
    if (content !== undefined) return content
  }
  return fileText(rest)
}

/**
 * Decide whether one settled tool result is a reducer candidate, and recover
 * its complete log text.
 * @param exec - the settled execution, carrying the tool name and parsed arguments.
 * @param result - the normalized outcome, carrying the canonical value or the failure.
 * @param decision - the post-execute decision the reducer would replace.
 * @param patterns - compiled command matchers identifying reducible logs.
 * @returns a source to reduce, a refusal, or a skip.
 */
export async function probeReducerSource(
  exec: ToolExecution,
  result: Readonly<ToolExecutionResult>,
  decision: PostToolDecision,
  patterns: readonly RegExp[],
): Promise<SourceProbe> {
  if (exec.name !== 'bash') return { kind: 'skip' }
  const command = recordValue(exec.arguments, 'command')
  if (typeof command !== 'string' || command === '') return { kind: 'skip' }
  if (!patterns.some((pattern) => pattern.test(command))) return { kind: 'skip' }

  const projected = decision.kind === 'accept' && decision.content !== undefined ? decision.content : result.content
  const visible = textOf(projected)

  const canonical = result.isError ? undefined : await bodyFromValue(result.value)
  const body = canonical?.body ?? (await bodyFromNotice(visible)) ?? visible
  if (body === '') return { kind: 'skip' }
  if (LIKELY_SECRET.test(body)) return { kind: 'refuse', reason: 'likely-secret' }

  // A non-zero exit is a successful tool call describing a failed command, so
  // the receipt's status must follow the command, not the call.
  const isError = result.isError || (canonical?.exitCode !== undefined && canonical.exitCode !== 0)

  return {
    kind: 'source',
    source: {
      command,
      body,
      isError,
      projectReceipt: (receipt) => [{ type: 'text', text: receipt }],
    },
  }
}
