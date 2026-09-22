/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 *
 * Adapted for DeepSeek Harness from SoL-Pi's Action Fusion.
 */
import Schema from '@deepseek-ai/schemastery'

/** Deployment-tunable Action Fusion policy, validated by Cordis from the bundle patch. */
export interface Config {
  /** Whether the fuser may shadow the configured tools at all. */
  enabled: boolean
  /**
   * Tool names to fuse, each shadowed per agent with an added `then_run`.
   *
   * A name with no globally registered definition is skipped rather than
   * registered from nothing: this plugin extends shipped tools, it does not own
   * their schemas.
   */
  tools: string[]
  /** Shell tool dispatched for the follow-up command, subject to its own policy. */
  shellTool: string
  /** Fallback per-command timeout when `then_run.timeoutMs` is absent. */
  defaultTimeoutMs: number
}

/** Cordis configuration schema; defaults are the shipped policy. */
export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true),
  tools: Schema.array(Schema.string()).default(['write', 'edit']),
  shellTool: Schema.string().default('bash'),
  defaultTimeoutMs: Schema.number().default(120_000),
})
