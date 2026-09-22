/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 *
 * Adapted for DeepSeek Harness from SoL-Pi's ObservationPack.
 */
import Schema from '@deepseek-ai/schemastery'

/** Deployment-tunable ObservationPack policy, validated by Cordis from the bundle patch. */
export interface Config {
  /** Whether the packer may replace surface tool results at all. */
  enabled: boolean
  /** Minimum UTF-8 size of a result before it becomes packable. */
  minBytes: number
  /**
   * How many assistant messages must follow a result before it is packed away.
   *
   * A result is therefore sent in full for this many provider requests and
   * replaced afterwards, which is what makes the replacement safe: the frontier
   * agent has already had a chance to read the original in context.
   */
  fullSends: number
  /** Upper bound on replacements committed by one pass, so one step stays bounded. */
  maxPerPass: number
}

/** Cordis configuration schema; defaults are the shipped policy. */
export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true),
  minBytes: Schema.number().default(8192),
  fullSends: Schema.number().default(3),
  maxPerPass: Schema.number().default(8),
})
