/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 *
 * Adapted for DeepSeek Harness from SoL-Pi's Online Context Compact economics.
 * The model is pure and portable; it is ported essentially unchanged so the
 * decision stays faithful to the original.
 */

/** Deployment-tunable knobs of the compaction cost model. */
export interface CompactionEconomics {
  /** Multiplier applied to the estimated remaining requests. */
  readonly remainingRequestScale: number
  /** Standard deviations subtracted from the per-boundary request mean. */
  readonly remainingRequestStddevK: number
  /** Headroom below the context window at which compaction is forced regardless of cost. */
  readonly windowReserveTokens: number
  /** Horizon multiplier granted to the first compaction, which also buys a reusable prefix. */
  readonly firstCompactionRequestScale: number
  /** Extra margin a later compaction must clear, because it re-writes what a prior one paid for. */
  readonly subsequentCompactionMargin: number
}

/** Shipped defaults, matching the original policy. */
export const DEFAULT_COMPACTION_ECONOMICS: CompactionEconomics = Object.freeze({
  remainingRequestScale: 1,
  remainingRequestStddevK: 0,
  windowReserveTokens: 16_384,
  firstCompactionRequestScale: 2,
  subsequentCompactionMargin: 1.5,
})

/** Why the decision came out the way it did. */
export type CompactionReason =
  | 'economic'
  | 'window_protection'
  | 'deferred_economic'
  | 'deferred_subsequent_margin'
  | 'deferred_carried_debt'
  | 'horizon_unavailable'
  | 'cache_ratio_unavailable'
  | 'non_positive_saving'

/** Estimated number of model requests still to come. */
export interface RequestHorizonEstimate {
  /** Observed request counts of completed plan boundaries, oldest first. */
  readonly completedBoundaryRequestCounts: readonly number[]
  readonly requestsPerBoundaryMean: number
  readonly requestsPerBoundaryLowerBound: number
  readonly unboundedExpectedRemainingRequests: number
  readonly averageContextTokenIncrement: number | null
  readonly windowRequestUpperBound: number | null
  readonly expectedRemainingRequests: number
}

/** The full cost comparison behind one compaction decision. */
export interface CompactionDecision {
  readonly writeTokens: number
  readonly archiveTokens: number
  readonly memoTokens: number
  readonly contextTokens: number
  readonly completedBoundaryRequestCounts: readonly number[] | null
  readonly requestsPerBoundaryMean: number | null
  readonly requestsPerBoundaryLowerBound: number | null
  readonly unboundedExpectedRemainingRequests: number | null
  readonly averageContextTokenIncrement: number | null
  readonly windowRequestUpperBound: number | null
  readonly expectedRemainingRequests: number | null
  readonly breakevenRequests: number | null
  readonly combinedBreakevenRequests: number | null
  readonly effectiveHorizonRequests: number | null
  readonly cacheWriteReadRatio: number | null
  readonly incrementalCacheCostRatio: number | null
  readonly priorCompactionCount: number
  readonly carriedDebtTokens: number
  readonly cacheDebtRepaymentTokens: number
  readonly compact: boolean
  readonly reason: CompactionReason
}

/** Below this many samples the variance estimate is not trustworthy. */
const MINIMUM_VARIANCE_SAMPLES = 3
/** Downward adjustment applied to a mean drawn from too few samples. */
const SMALL_SAMPLE_SCALE = 0.5

/**
 * Estimate how many model requests remain, from observed work per plan boundary
 * and the room left in the context window.
 *
 * The two bounds answer different questions: the boundary-based figure asks
 * "how much work is left?", while the window-based figure asks "how many more
 * requests fit?" — and the smaller of the two is the honest horizon.
 * @param input - observed boundary samples, remaining work, and window state.
 * @returns the horizon estimate and the intermediates behind it.
 */
export function estimateRemainingRequests(input: {
  readonly completedBoundaryRequestCounts: readonly number[]
  readonly remainingBoundaries: number
  readonly scale: number
  readonly standardDeviationK: number
  readonly contextTokens: number
  readonly contextWindowTokens: number | null
  readonly averageContextTokenIncrement: number | null
}): RequestHorizonEstimate {
  const mean =
    input.completedBoundaryRequestCounts.reduce((total, count) => total + count, 0) /
    Math.max(1, input.completedBoundaryRequestCounts.length)
  let lowerBound = mean
  if (input.standardDeviationK !== 0) {
    if (input.completedBoundaryRequestCounts.length < MINIMUM_VARIANCE_SAMPLES) {
      lowerBound *= SMALL_SAMPLE_SCALE
    } else {
      const variance = input.completedBoundaryRequestCounts.reduce(
        (total, count) => total + (count - mean) ** 2,
        0,
      )
      const deviation = Math.sqrt(variance / (input.completedBoundaryRequestCounts.length - 1))
      lowerBound = Math.max(0, mean - input.standardDeviationK * deviation)
    }
  }

  const unboundedExpectedRemainingRequests =
    1 + Math.floor(lowerBound * Math.max(0, input.remainingBoundaries) * input.scale)
  const windowRequestUpperBound =
    input.contextWindowTokens === null ||
    input.averageContextTokenIncrement === null ||
    input.averageContextTokenIncrement <= 0
      ? null
      : Math.max(
          0,
          Math.floor((input.contextWindowTokens - input.contextTokens) / input.averageContextTokenIncrement),
        )

  return {
    completedBoundaryRequestCounts: [...input.completedBoundaryRequestCounts],
    requestsPerBoundaryMean: mean,
    requestsPerBoundaryLowerBound: lowerBound,
    unboundedExpectedRemainingRequests,
    averageContextTokenIncrement: input.averageContextTokenIncrement,
    windowRequestUpperBound,
    expectedRemainingRequests:
      windowRequestUpperBound === null
        ? unboundedExpectedRemainingRequests
        : Math.min(unboundedExpectedRemainingRequests, windowRequestUpperBound),
  }
}

/**
 * Decide whether compacting now is worth its cost.
 *
 * Compacting is never free: it pays a summarization write and, on a cached
 * route, an incremental cache write on the next request. It only pays off if
 * the tokens it removes will be avoided in enough remaining requests to cover
 * that. Window protection overrides the whole comparison, because near the
 * limit the alternative is not "spend less" but "fail".
 * @param input - token accounting, horizon inputs, and prior cost state.
 * @returns the decision plus every intermediate used to reach it.
 */
export function decideCompaction(input: {
  readonly writeTokens: number
  readonly archiveTokens: number
  readonly memoTokens: number
  readonly contextTokens: number
  readonly completedBoundaryRequestCounts: readonly number[] | null
  readonly remainingBoundaries: number
  readonly averageContextTokenIncrement: number | null
  readonly contextWindowTokens: number | null
  readonly priorCompactionCount: number
  readonly carriedDebtTokens: number
  readonly cacheDebtRepaymentTokens: number
  readonly cacheWriteReadRatio: number | null
  readonly economics: CompactionEconomics
}): CompactionDecision {
  const horizon =
    input.completedBoundaryRequestCounts === null
      ? null
      : estimateRemainingRequests({
          completedBoundaryRequestCounts: input.completedBoundaryRequestCounts,
          remainingBoundaries: input.remainingBoundaries,
          scale: input.economics.remainingRequestScale,
          standardDeviationK: input.economics.remainingRequestStddevK,
          contextTokens: input.contextTokens,
          contextWindowTokens: input.contextWindowTokens,
          averageContextTokenIncrement: input.averageContextTokenIncrement,
        })
  const savingTokens = input.archiveTokens - input.memoTokens
  const incrementalCacheCostRatio =
    input.cacheWriteReadRatio === null ? null : Math.max(0, input.cacheWriteReadRatio - 1)
  const breakevenRequests =
    savingTokens > 0 && incrementalCacheCostRatio !== null
      ? (input.writeTokens * incrementalCacheCostRatio) / savingTokens
      : null
  const combinedBreakevenRequests =
    savingTokens > 0 && incrementalCacheCostRatio !== null
      ? (input.carriedDebtTokens + input.writeTokens * incrementalCacheCostRatio) / savingTokens
      : null
  const firstCompaction = input.priorCompactionCount === 0
  const effectiveHorizonRequests =
    horizon === null
      ? null
      : firstCompaction
        ? Math.min(
            horizon.expectedRemainingRequests * input.economics.firstCompactionRequestScale,
            horizon.windowRequestUpperBound ?? Number.POSITIVE_INFINITY,
          )
        : horizon.expectedRemainingRequests
  const windowProtection =
    input.contextWindowTokens !== null &&
    input.contextTokens >= input.contextWindowTokens - input.economics.windowReserveTokens
  const baseEconomic =
    horizon !== null &&
    horizon.expectedRemainingRequests > 0 &&
    breakevenRequests !== null &&
    breakevenRequests <= horizon.expectedRemainingRequests
  const firstEconomic =
    firstCompaction &&
    effectiveHorizonRequests !== null &&
    effectiveHorizonRequests > 0 &&
    breakevenRequests !== null &&
    breakevenRequests <= effectiveHorizonRequests
  const subsequentMarginOpen =
    !firstCompaction &&
    horizon !== null &&
    breakevenRequests !== null &&
    breakevenRequests * input.economics.subsequentCompactionMargin <= horizon.expectedRemainingRequests
  const carriedDebtGateOpen =
    !firstCompaction &&
    horizon !== null &&
    combinedBreakevenRequests !== null &&
    combinedBreakevenRequests <= horizon.expectedRemainingRequests
  const economic = firstCompaction ? firstEconomic : baseEconomic && subsequentMarginOpen && carriedDebtGateOpen
  const compressible = savingTokens > 0
  const compact = compressible && (windowProtection || economic)

  return {
    writeTokens: input.writeTokens,
    archiveTokens: input.archiveTokens,
    memoTokens: input.memoTokens,
    contextTokens: input.contextTokens,
    ...(horizon ?? {
      completedBoundaryRequestCounts: null,
      requestsPerBoundaryMean: null,
      requestsPerBoundaryLowerBound: null,
      unboundedExpectedRemainingRequests: null,
      averageContextTokenIncrement: input.averageContextTokenIncrement,
      windowRequestUpperBound: null,
      expectedRemainingRequests: null,
    }),
    breakevenRequests,
    combinedBreakevenRequests,
    effectiveHorizonRequests,
    cacheWriteReadRatio: input.cacheWriteReadRatio,
    incrementalCacheCostRatio,
    priorCompactionCount: input.priorCompactionCount,
    carriedDebtTokens: input.carriedDebtTokens,
    cacheDebtRepaymentTokens: input.cacheDebtRepaymentTokens,
    compact,
    reason: !compressible
      ? 'non_positive_saving'
      : windowProtection
        ? 'window_protection'
        : economic
          ? 'economic'
          : horizon === null
            ? 'horizon_unavailable'
            : breakevenRequests === null
              ? 'cache_ratio_unavailable'
              : !firstCompaction && baseEconomic && !subsequentMarginOpen
                ? 'deferred_subsequent_margin'
                : !firstCompaction && baseEconomic && !carriedDebtGateOpen
                  ? 'deferred_carried_debt'
                  : 'deferred_economic',
  }
}
