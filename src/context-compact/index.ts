/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 *
 * Online Context Compact for DeepSeek Harness.
 *
 * The stock backend compacts automatically when the context crosses a fixed
 * share of the window. That is a *pressure* rule: it says "the context is
 * large", not "compacting now is worth its price". This plugin subclasses it and
 * puts a cost model in front of the automatic path.
 *
 * Compacting is never free. It pays a summarization write, and on a cached route
 * it pays an incremental cache write on the next request — every token the
 * compaction removed has to be re-written once. It only pays off if the tokens it
 * removes would otherwise be replayed in enough remaining requests to cover that
 * cost. When few requests remain, deferring is cheaper than compacting.
 *
 * Mechanism — subclass, gate, then delegate.
 *
 * `compactIfNeeded` is called by the base class's own `agent/pre-step` and
 * `agent/request-error` listeners, and the base deliberately keeps that call
 * dynamically dispatched so a subclass override is honoured at event time. This
 * override is therefore the gate:
 *
 * - `context-overflow` is never gated. That path is corrective, not economic:
 *   the provider already refused the request, so the only alternative to
 *   compacting is failing.
 * - `pressure` is gated, but window protection overrides the cost comparison:
 *   within `windowReserveTokens` of the limit, compaction proceeds regardless.
 * - Every fault inside the gate fails open to the stock behaviour, because
 *   compaction is a safety function and a bug here must cost money, not the
 *   session.
 *
 * What this plugin does NOT do is reimplement range selection, summarization,
 * retention, or replay. Those stay exactly as shipped; only the *timing
 * decision* is added.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type { CompactionResult, CompactionTrigger } from '@deepseek-ai/dsh-compaction'
import type { Session } from '@deepseek-ai/dsh-session'
import { errorMessage, recordValue } from '../shared/digest.js'
import { Config as ConfigSchema, DEFAULT_ECONOMICS_CONFIG, type EconomicsConfig } from './config.js'
import { decideCompaction, type CompactionDecision, type CompactionEconomics } from './economics.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'sol-dsh-context-compact'

/** Cordis reads this schema to validate the bundle layer and fill defaults. */
export const Config = ConfigSchema

/** Per-agent bookkeeping the cost model needs across steps. */
interface AgentLedger {
  /** Model requests observed for this agent; each step is one request. */
  requests: number
  /** Outstanding cache cost a prior compaction has not yet earned back. */
  debtTokens: number
  /** Tokens each later request repays from that debt. */
  repaymentTokens: number
  /** Compactions this engine has landed for this agent. */
  compactions: number
}

/** The `todos` projection's shape, read structurally to avoid a package coupling. */
interface TodoLike {
  readonly status?: unknown
}

/** The `goals` service's shape, read structurally to avoid a package coupling. */
interface GoalsLike {
  get(agent: Agent): { readonly roundsStarted?: number; readonly maxGoalRounds?: number } | undefined
}

/** Per-session client state reader, read structurally to avoid a package coupling. */
interface ProjectionsLike {
  stateOf(session: Session, key: string): unknown
}

/** What one boundary measurement produced. */
interface BoundaryReading {
  /** Completed boundaries observed so far. */
  readonly completed: number
  /** Boundaries still to do, or `undefined` when no plan is visible. */
  readonly remaining: number | undefined
}

/** The stock backend's own accepted configuration keys. */
const BASE_CONFIG_KEYS: ReadonlySet<string> = new Set(
  Object.keys((BasicCompactionEngine.Config as unknown as { dict: Record<string, unknown> }).dict),
)

/**
 * Narrow one validated row configuration to the fields the stock backend accepts.
 *
 * The base constructor runs a strict key check that rejects anything it does not
 * know, so the economics fields must be stripped before `super()` sees them —
 * otherwise construction throws and the composition is left with no compaction
 * service at all, because this row replaced the stock one.
 */
function baseConfigOf(config: Record<string, unknown>): Record<string, unknown> {
  const base: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) {
    if (BASE_CONFIG_KEYS.has(key)) base[key] = value
  }
  return base
}

/** Extract the economics fields from one validated row configuration. */
function economicsOf(config: Record<string, unknown>): EconomicsConfig {
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

/**
 * Cost-model-driven compaction backend.
 *
 * Inherits pressure detection, overflow recovery, range selection, retention,
 * summarization, and replay from {@link BasicCompactionEngine}, and decides only
 * whether an automatic pressure compaction should run now.
 */
export default class EconomicCompactionEngine extends BasicCompactionEngine {
  private readonly economics: EconomicsConfig
  private readonly ledgers = new WeakMap<Agent, AgentLedger>()
  private readonly lastDecision = new WeakMap<Agent, CompactionDecision>()

  constructor(ctx: Context, config: Record<string, unknown> = {}) {
    super(ctx, baseConfigOf(config) as never)
    this.economics = economicsOf(config)
    if (!this.economics.enabled) {
      ctx.logger.info('sol-dsh: context compact economics disabled; deferring to stock pressure policy')
      return
    }
    // Registered after the base's own listener, so it advances the ledger for
    // each admitted step. A step boundary is exactly one model request.
    // Observes only: `next()` must supply the decision, or the claimed batch
    // would be replaced with an empty one.
    ctx.on('agent/pre-step', async ({ agent }, next): Promise<PreStepDecision> => {
      this.advanceLedger(agent)
      return next()
    })
    ctx.logger.info(
      'sol-dsh: context compact economics active '
      + `(reserve ${this.economics.windowReserveTokens} tokens, `
      + `cache ratio ${this.economics.cacheWriteReadRatio})`,
    )
  }

  /** Advance one agent's ledger by a single model request. */
  private advanceLedger(agent: Agent): void {
    const ledger = this.ledgers.get(agent) ?? {
      requests: 0,
      debtTokens: 0,
      repaymentTokens: 0,
      compactions: 0,
    }
    // Each later request repays a fixed slice of what the compaction cost, so
    // the debt decays as the saving is actually collected.
    const debtTokens = Math.max(0, ledger.debtTokens - ledger.repaymentTokens)
    this.ledgers.set(agent, {
      requests: ledger.requests + 1,
      debtTokens,
      repaymentTokens: debtTokens === 0 ? 0 : ledger.repaymentTokens,
      compactions: ledger.compactions,
    })
  }

  /**
   * Count plan boundaries from the live todo list.
   *
   * The `todos` projection is a standing plan cleared by the next turn, so its
   * open items are the work left in the current scope — which is exactly what
   * the horizon needs.
   */
  private readBoundaries(agent: Agent): BoundaryReading {
    const projections = this.ctx.get('sessionProjections') as ProjectionsLike | undefined
    if (projections === undefined) return { completed: 0, remaining: undefined }
    let todos: unknown
    try {
      todos = projections.stateOf(agent.session, 'todos')
    } catch {
      return { completed: 0, remaining: undefined }
    }
    if (!Array.isArray(todos)) return { completed: 0, remaining: undefined }
    let completed = 0
    let remaining = 0
    for (const item of todos as TodoLike[]) {
      const status = recordValue(item, 'status')
      if (status === 'completed') completed += 1
      else if (status === 'pending' || status === 'in_progress') remaining += 1
    }
    return { completed, remaining }
  }

  /** Count plan boundaries from an active goal's admitted rounds. */
  private readGoalBoundaries(agent: Agent): BoundaryReading | undefined {
    const goals = this.ctx.get('goals') as GoalsLike | undefined
    if (goals === undefined) return undefined
    try {
      const view = goals.get(agent)
      if (view === undefined) return undefined
      const max = view.maxGoalRounds
      const started = view.roundsStarted ?? 0
      if (typeof max !== 'number') return undefined
      return { completed: started, remaining: Math.max(0, max - started) }
    } catch {
      return undefined
    }
  }

  /**
   * Build the cost model's input from the session's live state.
   * @returns the inputs, or `undefined` when the routed target cannot be resolved.
   */
  private async gather(agent: Agent, signal: AbortSignal): Promise<Parameters<typeof decideCompaction>[0] | undefined> {
    const header = agent.session.requestHeader()
    const config = header?.config
    if (config === undefined || config.provider === '' || config.model === '') return undefined
    const info = await this.ctx.llm.resolveModelInfo(config.provider, config.model, signal)
    const contextWindowTokens = info.context?.contextWindow ?? null

    const measurement = this.ctx.tokenMeter.measure(agent.session)
    const contextTokens = measurement.totalTokens

    // The retained tail is not compressible, so only the excess above it can be
    // removed. Both retention forms are accepted, mirroring the base config.
    const retainedTail = this.config.retainTokens
      ?? (contextWindowTokens === null ? 0 : Math.floor(contextWindowTokens * this.config.retainRatio))
    const archiveTokens = Math.max(0, contextTokens - retainedTail)

    const ledger = this.ledgers.get(agent) ?? { requests: 0, debtTokens: 0, repaymentTokens: 0, compactions: 0 }
    const todoBoundaries = this.readBoundaries(agent)
    const boundaries = todoBoundaries.remaining === undefined
      ? this.readGoalBoundaries(agent) ?? { completed: 0, remaining: 1 }
      : todoBoundaries

    // With no per-boundary samples yet, the session average is the observation:
    // one sample is exact under the shipped `remainingRequestStddevK` of 0.
    const requestsPerBoundary = boundaries.completed > 0
      ? ledger.requests / boundaries.completed
      : this.economics.fallbackRequestsPerBoundary
    const averageContextTokenIncrement = ledger.requests > 0 ? contextTokens / ledger.requests : null

    const economics: CompactionEconomics = {
      remainingRequestScale: this.economics.remainingRequestScale,
      remainingRequestStddevK: this.economics.remainingRequestStddevK,
      windowReserveTokens: this.economics.windowReserveTokens,
      firstCompactionRequestScale: this.economics.firstCompactionRequestScale,
      subsequentCompactionMargin: this.economics.subsequentCompactionMargin,
    }

    return {
      writeTokens: contextTokens,
      archiveTokens,
      memoTokens: this.economics.memoTokenEstimate,
      contextTokens,
      completedBoundaryRequestCounts: boundaries.completed > 0 ? [requestsPerBoundary] : null,
      remainingBoundaries: boundaries.remaining ?? 1,
      averageContextTokenIncrement,
      contextWindowTokens,
      priorCompactionCount: ledger.compactions,
      carriedDebtTokens: ledger.debtTokens,
      cacheDebtRepaymentTokens: ledger.repaymentTokens,
      cacheWriteReadRatio: this.economics.cacheWriteReadRatio,
      economics,
    }
  }

  /** Record what one landed compaction cost, so later decisions see the debt. */
  private recordCompaction(agent: Agent, decision: CompactionDecision | undefined): void {
    const ledger = this.ledgers.get(agent) ?? { requests: 0, debtTokens: 0, repaymentTokens: 0, compactions: 0 }
    const ratio = decision?.incrementalCacheCostRatio ?? 0
    const writeTokens = decision?.writeTokens ?? 0
    const saving = Math.max(0, (decision?.archiveTokens ?? 0) - (decision?.memoTokens ?? 0))
    this.ledgers.set(agent, {
      ...ledger,
      compactions: ledger.compactions + 1,
      debtTokens: ledger.debtTokens + writeTokens * ratio,
      repaymentTokens: Math.max(0, saving),
    })
  }

  /**
   * Consider compaction for one trigger, gated by the cost model on the
   * automatic pressure path.
   * @param agent - the agent whose session would be compacted.
   * @param trigger - pressure (gated) or provider-confirmed overflow (never gated).
   * @param signal - the live turn's cancellation signal.
   * @returns the compaction result, or `null` when the gate deferred or nothing was needed.
   */
  override async compactIfNeeded(
    agent: Agent,
    trigger: CompactionTrigger,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    // Corrective path: the provider already refused the request, so there is no
    // cheaper alternative to compacting and no decision to make.
    if (!this.economics.enabled || trigger === 'context-overflow') {
      const result = await super.compactIfNeeded(agent, trigger, signal)
      if (result !== null) this.recordCompaction(agent, undefined)
      return result
    }

    let decision: CompactionDecision | undefined
    try {
      const input = await this.gather(agent, signal)
      if (input !== undefined) decision = decideCompaction(input)
    } catch (error: unknown) {
      // Never let the cost model become the reason a session cannot compact.
      this.ctx.logger.warn(`sol-dsh: compaction economics failed open: ${errorMessage(error)}`)
      return super.compactIfNeeded(agent, trigger, signal)
    }

    if (decision !== undefined) {
      this.lastDecision.set(agent, decision)
      if (!decision.compact) {
        // An unavailable horizon is not evidence that compacting is wasteful —
        // it means no plan is visible, which is the ordinary case for a session
        // that keeps no todo list. Deferring on that alone would suppress
        // compaction almost everywhere and let context grow until the reserve
        // fires, so the stock policy keeps the decision instead.
        if (decision.reason === 'horizon_unavailable') {
          this.ctx.logger.info('sol-dsh: no visible plan; leaving compaction to the stock policy')
        } else {
          this.ctx.logger.info(
            `sol-dsh: deferred compaction (${decision.reason}; `
            + `saving ${decision.archiveTokens - decision.memoTokens} tokens, `
            + `breakeven ${decision.breakevenRequests?.toFixed(1) ?? 'n/a'} requests, `
            + `horizon ${decision.expectedRemainingRequests?.toFixed(1) ?? 'n/a'})`,
          )
          return null
        }
      } else if (decision.reason === 'economic') {
        this.ctx.logger.info(
          `sol-dsh: compacting on economics (saving ${decision.archiveTokens - decision.memoTokens} tokens, `
          + `breakeven ${decision.breakevenRequests?.toFixed(1)} <= horizon `
          + `${decision.expectedRemainingRequests?.toFixed(1)})`,
        )
      }
    }

    const result = await super.compactIfNeeded(agent, trigger, signal)
    if (result !== null) this.recordCompaction(agent, decision)
    return result
  }
}
