/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { createHash } from 'node:crypto'

/** Hex SHA-256 of one UTF-8 string. */
export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** Whether a runtime value is a JSON object rather than an array or scalar. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read one key from an unknown value, or `undefined` when it is not a record. */
export function recordValue(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined
}

/** Best-effort human-readable message from an arbitrary thrown value. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Purely computed identity and size of one reducer source body.
 *
 * Computing this costs no I/O and no model call, so it is available before the
 * source is persisted: the hash is what the reducer echoes back and what
 * validation checks, while persistence happens only once a receipt is accepted.
 */
export interface SourceDigest {
  /** Hex SHA-256 of the exact source text. */
  readonly hash: string
  /** UTF-8 byte length. */
  readonly bytes: number
  /** UTF-16 code-unit length, the bound the model prompt is sized against. */
  readonly chars: number
  /** Line count; an empty body is zero lines. */
  readonly lines: number
}

/** Compute one source body's digest without touching the filesystem. */
export function digestOf(body: string): SourceDigest {
  return {
    hash: sha256(body),
    bytes: Buffer.byteLength(body, 'utf8'),
    chars: body.length,
    lines: body.length === 0 ? 0 : body.split('\n').length,
  }
}
