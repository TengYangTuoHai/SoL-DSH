/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 *
 * Configuration behaviour that was wrong at least once. The stock
 * `BasicCompactionEngine` constructor runs a strict key check, so the economics
 * fields must be stripped before it runs; when they were not, construction threw
 * and — because this row replaces the stock one — the composition was left with
 * no compaction service at all. These tests hold that line.
 */
import { describe, expect, it } from 'vitest'
import {
  BASE_CONFIG_KEY_LIST,
  baseConfigOf,
  Config,
  DEFAULT_ECONOMICS_CONFIG,
  economicsOf,
} from '../src/context-compact/config.js'
import { Config as ReducerConfig, compileCommandPatterns } from '../src/reducer/config.js'

/** Every economics key this plugin adds. */
const ECONOMICS_KEYS = Object.keys(DEFAULT_ECONOMICS_CONFIG)

describe('context-compact config schema', () => {
  it('accepts the stock compaction fields', () => {
    const resolved = Config({
      thresholdRatio: 0.7,
      retainTokens: 5_000,
      summarizationProvider: 'p',
      summarizationModel: 'm',
      auto: false,
      maxTokens: 4_000,
      headroomTokens: 8_000,
    })
    // Passthrough is what makes this row a drop-in replacement: a profile that
    // configured these on compaction-basic configures them here unchanged.
    expect(resolved.thresholdRatio).toBe(0.7)
    expect(resolved.retainTokens).toBe(5_000)
    expect(resolved.summarizationProvider).toBe('p')
    expect(resolved.summarizationModel).toBe('m')
    expect(resolved.auto).toBe(false)
    expect(resolved.maxTokens).toBe(4_000)
    expect(resolved.headroomTokens).toBe(8_000)
  })

  it('fills the economics defaults', () => {
    const resolved = Config({})
    for (const key of ECONOMICS_KEYS) {
      expect(resolved[key]).toEqual(DEFAULT_ECONOMICS_CONFIG[key as keyof typeof DEFAULT_ECONOMICS_CONFIG])
    }
    expect(resolved.cacheWriteReadRatio).toBe(12.5)
    expect(resolved.enabled).toBe(true)
  })

  it('declares every stock key alongside the economics keys', () => {
    const declared = Object.keys((Config as unknown as { dict: Record<string, unknown> }).dict)
    for (const key of BASE_CONFIG_KEY_LIST) expect(declared).toContain(key)
    for (const key of ECONOMICS_KEYS) expect(declared).toContain(key)
  })
})

describe('baseConfigOf', () => {
  it('keeps stock keys and drops every economics key', () => {
    const mixed = {
      thresholdRatio: 0.7,
      retainTokens: 5_000,
      auto: false,
      enabled: true,
      cacheWriteReadRatio: 12.5,
      memoTokenEstimate: 900,
      windowReserveTokens: 1_000,
      remainingRequestScale: 1,
      remainingRequestStddevK: 0,
      firstCompactionRequestScale: 2,
      subsequentCompactionMargin: 1.5,
      fallbackRequestsPerBoundary: 8,
    }
    const base = baseConfigOf(mixed)
    expect(Object.keys(base).sort()).toEqual(['auto', 'retainTokens', 'thresholdRatio'])
    // Every surviving key is one the stock key check recognizes, which is the
    // property that keeps the base constructor from throwing.
    for (const key of Object.keys(base)) expect(BASE_CONFIG_KEY_LIST).toContain(key)
  })

  it('leaves nothing behind that the stock key check would reject', () => {
    const base = baseConfigOf(Object.fromEntries(ECONOMICS_KEYS.map(k => [k, 1])))
    expect(base).toEqual({})
    for (const key of Object.keys(base)) expect(BASE_CONFIG_KEY_LIST).toContain(key)
  })

  it('does not mutate its input', () => {
    const input = { enabled: true, thresholdRatio: 0.7 }
    const snapshot = { ...input }
    baseConfigOf(input)
    expect(input).toEqual(snapshot)
  })

  it('passes an economics-only configuration through as an empty object', () => {
    // The shipped patch sets economics fields and relies on the stock defaults
    // for everything else, so this is the row's real shape.
    expect(baseConfigOf({ enabled: true, cacheWriteReadRatio: 12.5 })).toEqual({})
  })
})

describe('economicsOf', () => {
  it('reads explicit values and falls back per field', () => {
    const economics = economicsOf({ enabled: false, cacheWriteReadRatio: 0 })
    expect(economics.enabled).toBe(false)
    expect(economics.cacheWriteReadRatio).toBe(0)
    // Untouched fields keep their defaults rather than becoming undefined.
    expect(economics.windowReserveTokens).toBe(DEFAULT_ECONOMICS_CONFIG.windowReserveTokens)
    expect(economics.memoTokenEstimate).toBe(DEFAULT_ECONOMICS_CONFIG.memoTokenEstimate)
  })

  it('returns every field for an empty configuration', () => {
    expect(economicsOf({})).toEqual(DEFAULT_ECONOMICS_CONFIG)
  })

  it('treats an explicit zero as a value, not as absence', () => {
    // A zero cache ratio is the meaningful "caching is free" setting; a falsy
    // check would silently restore the 12.5 default and defer compaction.
    expect(economicsOf({ cacheWriteReadRatio: 0 }).cacheWriteReadRatio).toBe(0)
  })
})

describe('reducer config schema', () => {
  it('fills shipped defaults for an empty configuration', () => {
    const resolved = ReducerConfig({})
    expect(resolved.enabled).toBe(true)
    expect(resolved.minBytes).toBe(4_096)
    expect(resolved.reducerProvider).toBe('')
    expect(resolved.reducerModel).toBe('')
    expect(resolved.commandPatterns.length).toBeGreaterThan(0)
  })

  it('rejects a wrong-typed field instead of coercing it', () => {
    expect(() => ReducerConfig({ minBytes: 'big' })).toThrow()
  })

  it('compiles every default pattern', () => {
    const patterns = compileCommandPatterns(ReducerConfig({}).commandPatterns)
    expect(patterns).toHaveLength(ReducerConfig({}).commandPatterns.length)
  })

  it('names the offending pattern when one is not a valid regex', () => {
    expect(() => compileCommandPatterns(['^(ok$', 'fine'])).toThrow(/commandPatterns\[0\]/)
  })
})

describe('reducer command patterns', () => {
  const patterns = compileCommandPatterns(ReducerConfig({}).commandPatterns)
  const matches = (command: string): boolean => patterns.some(p => p.test(command))

  it('recognises the build and test commands it exists for', () => {
    for (const command of [
      'pnpm test',
      'pnpm run test',
      'npm test',
      'cd app && pnpm test',
      'cargo test',
      'cargo check',
      'pytest -q',
      'python3 -m pytest',
      'cmake --build build',
      'go test ./...',
      'tsc -p .',
      'vitest run',
      'lake build',
      'make',
      'ctest',
    ]) {
      expect(matches(command), command).toBe(true)
    }
  })

  it('ignores commands that produce no reducible log', () => {
    for (const command of [
      'ls -la',
      'git status',
      'echo hello',
      'cat package.json',
      'npm install',
    ]) {
      expect(matches(command), command).toBe(false)
    }
  })

  it('does not fire on a word that merely contains a pattern', () => {
    // `latest` and `remake` must not match, or the reducer would intercept
    // unrelated commands. The `(?:^|[;&|()\s])` guard is what prevents it.
    for (const command of ['ls latest.txt', 'echo remake', 'cat mytest.log']) {
      expect(matches(command), command).toBe(false)
    }
  })

  it('matches after a shell separator', () => {
    expect(matches('echo start; pnpm test')).toBe(true)
    expect(matches('true | make')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(matches('PNPM TEST')).toBe(true)
  })
})
