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
