/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 *
 * Adapted for DeepSeek Harness: the reduction policy is expressed as a
 * Cordis/Schemastery `Config` instead of a JSON file, and the command trigger
 * list is deployment-configurable.
 */
import Schema from '@deepseek-ai/schemastery'

/** Schema tag echoed by every receipt the reducer accepts. */
export const RECEIPT_SCHEMA = 'sol-dsh-evidence-receipt/1' as const
/** First line of every accepted receipt, so a receipt is recognizable at a glance. */
export const RECEIPT_PREFIX = 'sol_dsh_evidence_receipt_v1' as const

/** Maximum evidence items one receipt may carry. */
export const MAX_EVIDENCE_ITEMS = 12
/** Maximum characters in one quoted evidence line. */
export const MAX_QUOTE_CHARS = 600

/**
 * Command shapes whose output carries a small decision-bearing signal inside a
 * large log: build, test, and type-check invocations. Matched case-insensitively
 * anywhere in the command string, so a compound command such as
 * `cd app && pnpm test` still qualifies.
 */
export const DEFAULT_COMMAND_PATTERNS: readonly string[] = [
  String.raw`(?:^|[;&|()\s])lake\s+(?:build|env|test|update)`,
  String.raw`(?:^|[;&|()\s])lean(?:\s|$)`,
  String.raw`(?:^|[;&|()\s])coq`,
  String.raw`(?:^|[;&|()\s])cargo\s+(?:build|test|check|clippy)`,
  String.raw`(?:^|[;&|()\s])zig\s+build`,
  String.raw`(?:^|[;&|()\s])(?:pytest|ctest|ninja|make)(?:\s|$)`,
  String.raw`(?:^|[;&|()\s])python(?:3)?\s+-m\s+(?:pytest|unittest|py_compile)`,
  String.raw`(?:^|[;&|()\s])cmake\s+--build`,
  String.raw`(?:^|[;&|()\s])(?:npm|pnpm|yarn)\s+(?:run\s+)?test`,
  String.raw`(?:^|[;&|()\s])(?:go|bazel)\s+test`,
  String.raw`(?:^|[;&|()\s])tsc(?:\s|$)`,
  String.raw`(?:^|[;&|()\s])vitest\s+run`,
]

/** Patterns indicating a body that may carry a credential and must never be delegated. */
export const LIKELY_SECRET =
  /(?:api[_-]?key|authorization|bearer|access[_-]?token|secret)[^\n]{0,32}[=:][^\n]+/i

/** Patterns indicating failure language in a body, used to require failure evidence. */
export const FAILURE_SIGNAL =
  /error|failed|failure|fatal|exception|panic|timeout|unsolved|type mismatch|assert/i

/** Deployment-tunable reduction policy validated by Cordis from the bundle patch. */
export interface Config {
  /** Whether the reducer may rewrite eligible tool results at all. */
  enabled: boolean
  /** Minimum UTF-8 byte size of a candidate body before reduction is attempted. */
  minBytes: number
  /** Maximum source size delegated to the reducer model. */
  maxChars: number
  /** Output token cap for the reducer call. */
  maxOutputTokens: number
  /** Wall-clock timeout for the reducer call, in milliseconds. */
  timeoutMs: number
  /** Reducer provider route; empty selects the session's own routed provider. */
  reducerProvider: string
  /** Reducer model id; empty selects the session's own routed model. */
  reducerModel: string
  /** Regex sources identifying which commands produce reducible logs. */
  commandPatterns: string[]
}

/** Cordis configuration schema; defaults are the shipped policy. */
export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true),
  minBytes: Schema.number().default(4096),
  maxChars: Schema.number().default(600000),
  maxOutputTokens: Schema.number().default(2048),
  timeoutMs: Schema.number().default(90000),
  reducerProvider: Schema.string().default(''),
  reducerModel: Schema.string().default(''),
  commandPatterns: Schema.array(Schema.string()).default([...DEFAULT_COMMAND_PATTERNS]),
})

/**
 * Compile the configured pattern sources, failing loudly at plugin load rather
 * than silently matching nothing at run time.
 * @param patterns - regex sources from the effective configuration.
 * @returns one compiled matcher per source.
 * @throws when a source is not a valid regular expression.
 */
export function compileCommandPatterns(patterns: readonly string[]): readonly RegExp[] {
  return patterns.map((source, index) => {
    try {
      return new RegExp(source, 'i')
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`sol-dsh: commandPatterns[${index}] is not a valid regular expression: ${detail}`)
    }
  })
}
