/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 *
 * Action Fusion's parameter surface. Two invariants here are easy to break and
 * expensive to notice: `then_run` must stay OPTIONAL (or every mutation would be
 * forced to chain a command), and the dispatched arguments must survive a
 * lossless-JSON boundary (which is why an absent timeout is omitted rather than
 * set to `undefined`).
 */
import { describe, expect, it } from 'vitest'
import {
  observationBlocks,
  observationHeader,
  parseThenRun,
  splitThenRun,
  THEN_RUN_PARAM,
  THEN_RUN_SCHEMA,
  thenRunArguments,
  withThenRun,
} from '../src/action-fusion/params.js'

/** A base parameter schema shaped like the shipped `write` tool's. */
const BASE_PARAMETERS = {
  type: 'object',
  properties: {
    file_path: { type: 'string' },
    content: { type: 'string' },
    sandbox_permissions: { type: 'string', enum: ['default', 'workspace-write'] },
    justification: { type: 'string' },
  },
  required: ['file_path', 'content'],
}

describe('withThenRun', () => {
  it('adds the parameter without disturbing the base schema', () => {
    const extended = withThenRun(BASE_PARAMETERS)
    const properties = extended['properties'] as Record<string, unknown>
    expect(Object.keys(properties)).toEqual([
      'file_path',
      'content',
      'sandbox_permissions',
      'justification',
      THEN_RUN_PARAM,
    ])
    // Sandbox escalation fields must survive: losing them would quietly remove
    // the shipped approval path from the fused tool.
    expect(properties['sandbox_permissions']).toEqual(BASE_PARAMETERS.properties.sandbox_permissions)
  })

  it('keeps then_run optional', () => {
    // Requiring it would force a chained command on every mutation, which is
    // the opposite of the mechanism's intent.
    expect(withThenRun(BASE_PARAMETERS)['required']).toEqual(['file_path', 'content'])
    expect(THEN_RUN_SCHEMA.required).toEqual(['command'])
  })

  it('does not mutate the base schema it was given', () => {
    const snapshot = structuredClone(BASE_PARAMETERS)
    withThenRun(BASE_PARAMETERS)
    expect(BASE_PARAMETERS).toEqual(snapshot)
  })

  it('tolerates a schema with no properties block', () => {
    const extended = withThenRun({ type: 'object' })
    expect(Object.keys(extended['properties'] as Record<string, unknown>)).toEqual([THEN_RUN_PARAM])
  })

  it('declares only keywords the harness schema subset allows', () => {
    // The registry rejects an unsupported keyword at registration time, which
    // would stop the whole plugin from mounting. Property NAMES are not
    // keywords, so the walk descends through `properties` values instead of
    // treating its keys as schema nodes.
    const allowed = new Set([
      'type', 'properties', 'required', 'additionalProperties', 'items',
      'enum', 'const', 'description', 'title', 'default', 'examples', 'oneOf',
    ])
    const walk = (node: unknown): void => {
      if (typeof node !== 'object' || node === null || Array.isArray(node)) return
      for (const [key, value] of Object.entries(node)) {
        expect(allowed.has(key), `unexpected schema keyword "${key}"`).toBe(true)
        if (key === 'properties' && typeof value === 'object' && value !== null) {
          for (const child of Object.values(value)) walk(child)
        } else if (key !== 'required' && key !== 'enum') {
          walk(value)
        }
      }
    }
    walk(THEN_RUN_SCHEMA)
  })
})

describe('splitThenRun', () => {
  it('separates the base arguments from the request', () => {
    const { baseArgs, thenRun } = splitThenRun({
      file_path: '/tmp/a.js',
      content: 'x',
      [THEN_RUN_PARAM]: { command: 'node /tmp/a.js' },
    })
    expect(baseArgs).toEqual({ file_path: '/tmp/a.js', content: 'x' })
    expect(thenRun).toEqual({ command: 'node /tmp/a.js' })
  })

  it('leaves the base arguments untouched when nothing was chained', () => {
    const { baseArgs, thenRun } = splitThenRun({ file_path: '/tmp/a.js' })
    expect(baseArgs).toEqual({ file_path: '/tmp/a.js' })
    expect(thenRun).toBeUndefined()
  })

  it('never forwards the extra key to the base tool', () => {
    // The base `execute` validates its own arguments, so a leaked key would be
    // rejected or silently ignored depending on its schema.
    const { baseArgs } = splitThenRun({ a: 1, [THEN_RUN_PARAM]: { command: 'x' } })
    expect(Object.keys(baseArgs)).not.toContain(THEN_RUN_PARAM)
  })

  it('does not mutate the caller arguments', () => {
    const args = { a: 1, [THEN_RUN_PARAM]: { command: 'x' } }
    const snapshot = structuredClone(args)
    splitThenRun(args)
    expect(args).toEqual(snapshot)
  })

  it('degrades to empty arguments for a non-object input', () => {
    expect(splitThenRun(null)).toEqual({ baseArgs: {}, thenRun: undefined })
    expect(splitThenRun('nope')).toEqual({ baseArgs: {}, thenRun: undefined })
  })
})

describe('parseThenRun', () => {
  const FALLBACK = 'Run the follow-up command for write'

  it('reads a complete request', () => {
    expect(parseThenRun({ command: 'node x.js', description: 'Run x', timeoutMs: 5_000 }, FALLBACK, 120_000))
      .toEqual({ command: 'node x.js', description: 'Run x', timeoutMs: 5_000 })
  })

  it('supplies the fallback description and timeout when omitted', () => {
    expect(parseThenRun({ command: 'node x.js' }, FALLBACK, 120_000))
      .toEqual({ command: 'node x.js', description: FALLBACK, timeoutMs: 120_000 })
  })

  it('refuses a request that names no command', () => {
    for (const value of [undefined, null, 'command', 42, [], {}, { command: '' }, { command: '   ' }, { command: 7 }]) {
      expect(parseThenRun(value, FALLBACK, 1_000), JSON.stringify(value)).toBeUndefined()
    }
  })

  it('rejects a non-positive or non-finite timeout rather than passing it on', () => {
    // A zero or negative timeout would make the shell tool fail or run
    // unbounded; NaN would not survive JSON at all.
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 'soon', null]) {
      expect(parseThenRun({ command: 'x', timeoutMs }, FALLBACK, 9_000)?.timeoutMs, String(timeoutMs)).toBe(9_000)
    }
  })

  it('ignores a blank description rather than sending an empty label', () => {
    expect(parseThenRun({ command: 'x', description: '   ' }, FALLBACK, 1_000)?.description).toBe(FALLBACK)
  })

  it('trims only for the emptiness test, not for the command itself', () => {
    // The command is passed through verbatim: leading whitespace can be
    // meaningful in shell text, and the harness is not a normalizer.
    expect(parseThenRun({ command: '  ls  ' }, FALLBACK, 1_000)?.command).toBe('  ls  ')
  })
})

describe('thenRunArguments', () => {
  it('produces a losslessly JSON-serializable object', () => {
    const args = thenRunArguments({ command: 'node x.js', description: 'Run x', timeoutMs: 5_000 }, 'write')
    expect(JSON.parse(JSON.stringify(args))).toEqual(args)
    expect(Object.values(args).every(v => v !== undefined)).toBe(true)
  })

  it('omits the timeout when there is none, instead of emitting undefined', () => {
    // Arguments cross a lossless-JSON boundary; `undefined` is not a JSON value
    // and would either throw or silently drop the key at the wrong layer.
    const args = thenRunArguments({ command: 'x', description: 'd', timeoutMs: undefined }, 'write')
    expect(Object.keys(args)).toEqual(['command', 'description'])
    expect('timeoutMs' in args).toBe(false)
  })

  it('synthesizes a usable description when the model gave none', () => {
    const args = thenRunArguments({ command: 'x', description: '', timeoutMs: 1_000 }, 'edit')
    expect(args['description']).toBe('Run the follow-up command for edit')
  })

  it('carries the command through unchanged', () => {
    const command = 'cd /tmp && node "a b.js" --flag=1'
    expect(thenRunArguments({ command, description: 'd', timeoutMs: 1_000 }, 'write')['command']).toBe(command)
  })
})

describe('observationHeader', () => {
  const success = (exitCode?: number) => ({
    isError: false as const,
    value: exitCode === undefined ? {} : { exitCode },
    content: [],
  })

  it('reports a clean exit as success', () => {
    expect(observationHeader(success(0) as never)).toBe('[then_run:succeeded] exit=0')
  })

  it('labels a non-zero exit as a failure and says the mutation survived', () => {
    // A non-zero exit is a SUCCESSFUL tool call in this harness, so reading
    // `isError` alone would label a failing build as a success.
    const header = observationHeader(success(7) as never)
    expect(header).toBe('[then_run:failed] exit=7 (the mutation was applied and kept)')
  })

  it('reports a call-level failure as a command that did not run', () => {
    const failed = { isError: true as const, error: { message: 'denied by policy' }, content: [] }
    const header = observationHeader(failed as never)
    expect(header).toBe('[then_run:failed] the command did not run: denied by policy')
  })

  it('says so explicitly when no exit status came back', () => {
    // The harness omits exitCode for background and persistent-shell results;
    // silence there must not be read as success.
    const header = observationHeader(success() as never)
    expect(header).toContain('[then_run:succeeded]')
    expect(header).toMatch(/no exit status reported/i)
  })
})

describe('observationBlocks', () => {
  const outcome = { isError: false as const, value: { exitCode: 0 }, content: [{ type: 'text', text: 'OUT\n' }] }

  it('puts the marker in its own block ahead of the output', () => {
    const blocks = observationBlocks(outcome as never)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]!.text?.startsWith('[then_run:')).toBe(true)
    expect(blocks[1]!.text).toBe('OUT\n')
  })

  it('terminates the marker with a newline so a naive join stays readable', () => {
    // Observed in practice: a consumer that concatenated the blocks made the
    // model read `exit=0` and the first output line as one word.
    const blocks = observationBlocks(outcome as never)
    expect(blocks[0]!.text?.endsWith('\n')).toBe(true)
    const naive = blocks.map(b => b.text ?? '').join('')
    expect(naive).toBe('[then_run:succeeded] exit=0\nOUT\n')
    expect(naive).not.toContain('exit=0OUT')
  })

  it('keeps the output blocks untouched', () => {
    const original = [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]
    const blocks = observationBlocks({ isError: false, value: { exitCode: 0 }, content: original } as never)
    expect(blocks.slice(1)).toEqual(original)
  })
})
