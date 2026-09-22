/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 *
 * The compaction cost model decides when NOT to compact, which is a new
 * behaviour in front of a shipped safety mechanism. These tests pin the two
 * properties that matter: it must never suppress compaction near the window
 * limit, and it must not defer on an unavailable horizon (that regression
 * disabled compaction entirely in the common plan-less session).
 */
import { describe, expect, it } from 'vitest'
import {
  decideCompaction,
  DEFAULT_COMPACTION_ECONOMICS,
  estimateRemainingRequests,
  type CompactionEconomics,
} from '../src/context-compact/economics.js'

const ECONOMICS: CompactionEconomics = DEFAULT_COMPACTION_ECONOMICS

/** A decision input representing a healthy session far from its limit. */
function input(overrides: Partial<Parameters<typeof decideCompaction>[0]> = {}) {
  return {
    writeTokens: 40_000,
    archiveTokens: 30_000,
    memoTokens: 1_000,
    contextTokens: 40_000,
    completedBoundaryRequestCounts: [10],
    remainingBoundaries: 4,
    averageContextTokenIncrement: 2_000,
    contextWindowTokens: 200_000,
    priorCompactionCount: 0,
    carriedDebtTokens: 0,
    cacheDebtRepaymentTokens: 0,
    cacheWriteReadRatio: 12.5,
    economics: ECONOMICS,
    ...overrides,
  }
}

describe('estimateRemainingRequests', () => {
  it('takes the minimum of the work-based and window-based bounds', () => {
    // 10 requests per boundary x 4 boundaries would allow 41; the window can
    // only fit (200000-40000)/2000 = 80, so the work bound governs here.
    const estimate = estimateRemainingRequests({
      completedBoundaryRequestCounts: [10],
      remainingBoundaries: 4,
      scale: 1,
      standardDeviationK: 0,
      contextTokens: 40_000,
      contextWindowTokens: 200_000,
      averageContextTokenIncrement: 2_000,
    })
    expect(estimate.expectedRemainingRequests).toBe(41)
    expect(estimate.windowRequestUpperBound).toBe(80)
  })

  it('lets the window bound govern when it is the smaller one', () => {
    const estimate = estimateRemainingRequests({
      completedBoundaryRequestCounts: [50],
      remainingBoundaries: 10,
      scale: 1,
      standardDeviationK: 0,
      contextTokens: 190_000,
      contextWindowTokens: 200_000,
      averageContextTokenIncrement: 2_000,
    })
    expect(estimate.unboundedExpectedRemainingRequests).toBe(501)
    expect(estimate.windowRequestUpperBound).toBe(5)
    expect(estimate.expectedRemainingRequests).toBe(5)
  })

  it('omits the window bound when no token increment is known', () => {
    const estimate = estimateRemainingRequests({
      completedBoundaryRequestCounts: [10],
      remainingBoundaries: 2,
      scale: 1,
      standardDeviationK: 0,
      contextTokens: 40_000,
      contextWindowTokens: 200_000,
      averageContextTokenIncrement: null,
    })
    expect(estimate.windowRequestUpperBound).toBeNull()
    expect(estimate.expectedRemainingRequests).toBe(21)
  })

  it('never reports a negative window bound when the context is over the limit', () => {
    const estimate = estimateRemainingRequests({
      completedBoundaryRequestCounts: [10],
      remainingBoundaries: 1,
      scale: 1,
      standardDeviationK: 0,
      contextTokens: 250_000,
      contextWindowTokens: 200_000,
      averageContextTokenIncrement: 2_000,
    })
    expect(estimate.windowRequestUpperBound).toBe(0)
    expect(estimate.expectedRemainingRequests).toBe(0)
  })

  it('halves a mean drawn from too few samples when variance is requested', () => {
    const estimate = estimateRemainingRequests({
      completedBoundaryRequestCounts: [10],
      remainingBoundaries: 4,
      scale: 1,
      standardDeviationK: 1,
      contextTokens: 0,
      contextWindowTokens: null,
      averageContextTokenIncrement: null,
    })
    // One sample is below the variance floor, so the small-sample penalty applies.
    expect(estimate.requestsPerBoundaryLowerBound).toBe(5)
  })

  it('treats zero remaining boundaries as work that is already finished', () => {
    const estimate = estimateRemainingRequests({
      completedBoundaryRequestCounts: [10],
      remainingBoundaries: 0,
      scale: 1,
      standardDeviationK: 0,
      contextTokens: 40_000,
      contextWindowTokens: 200_000,
      averageContextTokenIncrement: 2_000,
    })
    expect(estimate.unboundedExpectedRemainingRequests).toBe(1)
  })
})

describe('decideCompaction - window protection', () => {
  it('compacts regardless of cost inside the reserve', () => {
    // The saving here is real but the horizon is short, so the economics alone
    // would defer. Near the limit the alternative to compacting is failing.
    const decision = decideCompaction(input({
      contextTokens: 190_000,
      contextWindowTokens: 200_000,
      archiveTokens: 100_000,
      completedBoundaryRequestCounts: [1],
      remainingBoundaries: 1,
    }))
    expect(decision.compact).toBe(true)
    expect(decision.reason).toBe('window_protection')
  })

  it('does not compact on protection when nothing can be removed', () => {
    const decision = decideCompaction(input({
      contextTokens: 199_000,
      contextWindowTokens: 200_000,
      archiveTokens: 500,
      memoTokens: 1_000,
    }))
    expect(decision.compact).toBe(false)
    expect(decision.reason).toBe('non_positive_saving')
  })
})

describe('decideCompaction - economics', () => {
  it('compacts when the breakeven fits inside the horizon', () => {
    const decision = decideCompaction(input())
    // saving 29000, incremental ratio 11.5 -> 40000*11.5/29000 ~ 15.9 requests
    expect(decision.breakevenRequests).toBeCloseTo(15.86, 1)
    expect(decision.compact).toBe(true)
    expect(decision.reason).toBe('economic')
  })

  it('defers when even the first-compaction horizon is too short', () => {
    // A first compaction may double its horizon, so the case must be far short
    // of breakeven rather than merely below it: 1 boundary x 1 request gives a
    // horizon of 2, doubled to 4, against a breakeven near 16.
    const decision = decideCompaction(input({
      completedBoundaryRequestCounts: [1],
      remainingBoundaries: 1,
    }))
    expect(decision.effectiveHorizonRequests).toBe(4)
    expect(decision.compact).toBe(false)
    expect(decision.reason).toBe('deferred_economic')
  })

  it('doubles the first compaction horizon but never past the window bound', () => {
    // mean 3 x 3 boundaries -> unbounded 10, doubled to 20 by the
    // first-compaction scale, which stays under the window bound of 80.
    const decision = decideCompaction(input({
      completedBoundaryRequestCounts: [3],
      remainingBoundaries: 3,
    }))
    expect(decision.expectedRemainingRequests).toBe(10)
    expect(decision.priorCompactionCount).toBe(0)
    expect(decision.effectiveHorizonRequests).toBe(20)
  })

  it('ignores the first-compaction scale on a later compaction', () => {
    const later = decideCompaction(input({
      completedBoundaryRequestCounts: [3],
      remainingBoundaries: 3,
      priorCompactionCount: 1,
    }))
    // A later compaction gets no multiplier: its effective horizon is the
    // estimate itself, which is what makes a second compaction harder.
    expect(later.effectiveHorizonRequests).toBe(10)
  })

  it('demands a larger margin on a later compaction', () => {
    // Horizon 25, breakeven ~15.9: the raw comparison passes, and so does the
    // 1.5x margin (23.8), so a debt-free later compaction still proceeds.
    const later = decideCompaction(input({
      completedBoundaryRequestCounts: [6],
      remainingBoundaries: 4,
      priorCompactionCount: 1,
    }))
    expect(later.expectedRemainingRequests).toBe(25)
    expect(later.breakevenRequests! * 1.5).toBeLessThanOrEqual(25)
    expect(later.compact).toBe(true)
    expect(later.reason).toBe('economic')
  })

  it('folds carried cache debt into the later-compaction gate', () => {
    // Same shape as the passing later compaction above, but with an unpaid debt
    // large enough to push the combined breakeven past the horizon. The margin
    // gate clears first, so the debt gate is the one that must bite.
    const withDebt = decideCompaction(input({
      completedBoundaryRequestCounts: [6],
      remainingBoundaries: 4,
      priorCompactionCount: 1,
      carriedDebtTokens: 300_000,
    }))
    expect(withDebt.combinedBreakevenRequests).toBeGreaterThan(25)
    expect(withDebt.compact).toBe(false)
    expect(withDebt.reason).toBe('deferred_carried_debt')
  })

  it('reports the margin gate ahead of the debt gate when both would defer', () => {
    // Precedence is explicit in the implementation, so pin it: a short horizon
    // that fails the margin is reported as the margin, not as debt.
    const short = decideCompaction(input({
      completedBoundaryRequestCounts: [4],
      remainingBoundaries: 4,
      priorCompactionCount: 1,
      carriedDebtTokens: 300_000,
    }))
    expect(short.breakevenRequests! * 1.5).toBeGreaterThan(short.expectedRemainingRequests!)
    expect(short.reason).toBe('deferred_subsequent_margin')
  })

  it('makes every affordable compaction economic at a zero cache ratio', () => {
    const decision = decideCompaction(input({
      cacheWriteReadRatio: 0,
      completedBoundaryRequestCounts: [1],
      remainingBoundaries: 1,
    }))
    expect(decision.incrementalCacheCostRatio).toBe(0)
    expect(decision.breakevenRequests).toBe(0)
    expect(decision.compact).toBe(true)
  })

  it('clamps an incremental ratio below zero cost at zero', () => {
    // A ratio of 1 means a cache write costs the same as a read, so compacting
    // adds no cache premium.
    const decision = decideCompaction(input({ cacheWriteReadRatio: 0.5 }))
    expect(decision.incrementalCacheCostRatio).toBe(0)
  })
})

describe('decideCompaction - unavailable inputs', () => {
  it('refuses to compact when no horizon is observable', () => {
    // This is the case the plugin must NOT treat as "defer": the model cannot
    // weigh a cost with no horizon, so the caller falls back to stock policy.
    const decision = decideCompaction(input({ completedBoundaryRequestCounts: null }))
    expect(decision.compact).toBe(false)
    expect(decision.reason).toBe('horizon_unavailable')
    expect(decision.expectedRemainingRequests).toBeNull()
    expect(decision.effectiveHorizonRequests).toBeNull()
  })

  it('reports an unknown cache ratio rather than guessing one', () => {
    const decision = decideCompaction(input({ cacheWriteReadRatio: null, remainingBoundaries: 1 }))
    expect(decision.incrementalCacheCostRatio).toBeNull()
    expect(decision.breakevenRequests).toBeNull()
    expect(decision.compact).toBe(false)
    expect(decision.reason).toBe('cache_ratio_unavailable')
  })

  it('prefers window protection over a missing cache ratio', () => {
    // Near the limit the decision must not depend on knowing the price.
    const decision = decideCompaction(input({
      cacheWriteReadRatio: null,
      contextTokens: 195_000,
      contextWindowTokens: 200_000,
    }))
    expect(decision.compact).toBe(true)
    expect(decision.reason).toBe('window_protection')
  })

  it('reports a non-positive saving before any horizon reasoning', () => {
    const decision = decideCompaction(input({ archiveTokens: 1_000, memoTokens: 1_000 }))
    expect(decision.compact).toBe(false)
    expect(decision.reason).toBe('non_positive_saving')
  })
})

describe('decideCompaction - reporting', () => {
  it('echoes every intermediate used, so a decision can be explained', () => {
    const decision = decideCompaction(input())
    expect(decision).toMatchObject({
      writeTokens: 40_000,
      archiveTokens: 30_000,
      memoTokens: 1_000,
      contextTokens: 40_000,
      cacheWriteReadRatio: 12.5,
      priorCompactionCount: 0,
      carriedDebtTokens: 0,
    })
    expect(decision.completedBoundaryRequestCounts).not.toBeNull()
    expect(decision.requestsPerBoundaryMean).toBe(10)
  })

  it('returns the same decision for the same input', () => {
    expect(decideCompaction(input())).toEqual(decideCompaction(input()))
  })
})
