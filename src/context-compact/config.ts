/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 *
 * Adapted for DeepSeek Harness from SoL-Pi's Online Context Compact.
 */
import Schema from '@deepseek-ai/schemastery'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { DEFAULT_COMPACTION_ECONOMICS } from './economics.js'

/**
 * Economics fields added on top of the stock compaction configuration.
 *
 * The base backend's own fields (`thresholdRatio`, `retainRatio`,
 * `retainTokens`, `summarizationProvider`, …) are merged in below rather than
 * redeclared, so this row accepts everything the shipped row accepts.
 */
export interface EconomicsConfig {
  /** Whether the economic gate may defer automatic pressure compaction. */
  enabled: boolean
  /** Estimated token size of one replacement summary, before it is written. */
  memoTokenEstimate: number
  /**
   * Billed cost of a cache write relative to a cache read on this route.
   *
   * The harness reports cache token *counts* but no price, so this stays a
   * configuration fact. `12.5` is the shipped default, matching the original
   * policy. `0` states that a cache write adds no cost over a read, which makes
   * every affordable compaction economic and restores near-stock eagerness.
   */
  cacheWriteReadRatio: number
  /** Multiplier applied to the estimated remaining requests. */
  remainingRequestScale: number
  /** Standard deviations subtracted from the per-boundary request mean. */
  remainingRequestStddevK: number
  /** Headroom below the context window at which compaction is forced regardless of cost. */
  windowReserveTokens: number
  /** Horizon multiplier granted to the first compaction. */
  firstCompactionRequestScale: number
  /** Extra margin a later compaction must clear. */
  subsequentCompactionMargin: number
  /** Fallback requests-per-boundary when no boundary has been observed yet. */
  fallbackRequestsPerBoundary: number
}

/** Shipped defaults, matching the original policy. */
export const DEFAULT_ECONOMICS_CONFIG: EconomicsConfig = Object.freeze({
  enabled: true,
  memoTokenEstimate: 1200,
  cacheWriteReadRatio: 12.5,
  remainingRequestScale: DEFAULT_COMPACTION_ECONOMICS.remainingRequestScale,
  remainingRequestStddevK: DEFAULT_COMPACTION_ECONOMICS.remainingRequestStddevK,
  windowReserveTokens: DEFAULT_COMPACTION_ECONOMICS.windowReserveTokens,
  firstCompactionRequestScale: DEFAULT_COMPACTION_ECONOMICS.firstCompactionRequestScale,
  subsequentCompactionMargin: DEFAULT_COMPACTION_ECONOMICS.subsequentCompactionMargin,
  fallbackRequestsPerBoundary: 8,
})

/** The economics half of the schema. */
const economicsFields = {
  enabled: Schema.boolean().default(DEFAULT_ECONOMICS_CONFIG.enabled),
  memoTokenEstimate: Schema.number().default(DEFAULT_ECONOMICS_CONFIG.memoTokenEstimate),
  cacheWriteReadRatio: Schema.number().default(DEFAULT_ECONOMICS_CONFIG.cacheWriteReadRatio),
  remainingRequestScale: Schema.number().default(DEFAULT_ECONOMICS_CONFIG.remainingRequestScale),
  remainingRequestStddevK: Schema.number().default(DEFAULT_ECONOMICS_CONFIG.remainingRequestStddevK),
  windowReserveTokens: Schema.number().default(DEFAULT_ECONOMICS_CONFIG.windowReserveTokens),
  firstCompactionRequestScale: Schema.number().default(DEFAULT_ECONOMICS_CONFIG.firstCompactionRequestScale),
  subsequentCompactionMargin: Schema.number().default(DEFAULT_ECONOMICS_CONFIG.subsequentCompactionMargin),
  fallbackRequestsPerBoundary: Schema.number().default(DEFAULT_ECONOMICS_CONFIG.fallbackRequestsPerBoundary),
} as const

/**
 * The row's full schema: every stock compaction field, plus the economics
 * fields this plugin adds.
 *
 * Merging the base schema's own field map is what keeps this row a drop-in
 * replacement — a profile that configured `retainTokens` on `compaction-basic`
 * configures it here unchanged.
 */
export const Config = Schema.object({
  ...(BasicCompactionEngine.Config as unknown as { dict: Record<string, unknown> }).dict,
  ...economicsFields,
})

/** One validated row configuration. */
export type Config = EconomicsConfig & Record<string, unknown>

/** The stock backend's own accepted configuration keys. */
const BASE_CONFIG_KEYS: ReadonlySet<string> = new Set(
  Object.keys((BasicCompactionEngine.Config as unknown as { dict: Record<string, unknown> }).dict),
)

/** The stock backend's accepted configuration keys, sorted, for tests and diagnostics. */
export const BASE_CONFIG_KEY_LIST: readonly string[] = [...BASE_CONFIG_KEYS].sort()

/**
 * Narrow one validated row configuration to the fields the stock backend accepts.
 *
 * The base constructor runs a strict key check that rejects anything it does not
 * know, so the economics fields must be stripped before `super()` sees them —
 * otherwise construction throws and, because this row replaces the stock one,
 * the composition is left with no compaction service at all.
 * @param config - the fully validated row configuration.
 * @returns only the keys the stock `BasicCompactionEngine` recognizes.
 */
export function baseConfigOf(config: Record<string, unknown>): Record<string, unknown> {
  const base: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) {
    if (BASE_CONFIG_KEYS.has(key)) base[key] = value
  }
  return base
}

/**
 * Read the economics fields, falling back to the shipped default per field.
 * @param config - the fully validated row configuration.
 * @returns every economics field with its effective value.
 */
export function economicsOf(config: Record<string, unknown>): EconomicsConfig {
  const pick = <K extends keyof EconomicsConfig>(key: K): EconomicsConfig[K] => {
    const value = config[key as string]
    return (value === undefined ? DEFAULT_ECONOMICS_CONFIG[key] : value) as EconomicsConfig[K]
  }
  return {
    enabled: pick('enabled'),
    memoTokenEstimate: pick('memoTokenEstimate'),
    cacheWriteReadRatio: pick('cacheWriteReadRatio'),
    remainingRequestScale: pick('remainingRequestScale'),
    remainingRequestStddevK: pick('remainingRequestStddevK'),
    windowReserveTokens: pick('windowReserveTokens'),
    firstCompactionRequestScale: pick('firstCompactionRequestScale'),
    subsequentCompactionMargin: pick('subsequentCompactionMargin'),
    fallbackRequestsPerBoundary: pick('fallbackRequestsPerBoundary'),
  }
}
