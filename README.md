# SoL-DSH

Evidence-preserving context and tool-efficiency extensions for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), built as a
standalone out-of-tree `dsh` bundle.

SoL-DSH is a sibling of [SoL-Pi](https://github.com/NVIDIA/SoL-Pi), which applies
the same ideas to the Pi coding agent. The two projects share algorithm design,
not code structure: SoL-Pi is a Pi extension and this project is a Cordis plugin
tree, so no runtime API is common between them.

## Mechanisms

| Mechanism | Status | Harness seam |
|---|---|---|
| Evidence-Preserving Reducer | implemented | `tools/post-execute` |
| ObservationPack | planned | `ctx.sessions.registerMessageProjection` |
| Action Fusion | planned | agent-scoped tool registration |
| Online Context Compact | planned | `BasicCompactionEngine` subclass |

### Evidence-Preserving Reducer

A long build or test log usually changes the next decision through only a few
lines. The reducer:

1. identifies an eligible result — a `bash` call whose command looks like a
   build, test, or type-check invocation;
2. recovers the **complete** log, preferring the bash tool's canonical
   `stdout`/`stderr` `spillPath` over the possibly truncated model-facing text;
3. persists that log as a session spill artifact;
4. delegates the first reading of it to a reducer model;
5. accepts the resulting receipt **only when every quoted line is found byte for
   byte in the archive**, the echoed source hash matches, the claimed status
   matches the command's real exit, and a failing log carries failure evidence;
6. replaces the model-facing content with the verified receipt.

A receipt that fails any check is discarded and the original output reaches the
frontier agent untouched. Reduction is an optimization, never a precondition for
correctness: a model error, an unresolvable route, an oversized source, a
likely-secret body, or an internal fault all fail open.

The canonical tool value and the durable session log are never modified — only
the model-facing content of that one call changes.

## Requirements

SoL-DSH targets one exact harness revision and is not guaranteed for any other:

| Component | Version |
|---|---|
| `@deepseek-ai/dsh` | `0.1.7-alpha.1`, tag `dsh-v0.1.7-alpha.1` |
| `@deepseek-ai/cordis` | `4.0.3` |
| `@deepseek-ai/schemastery` | `3.18.3` |
| Node.js | `>=22.19.0` |

A different harness version is a compatibility change.

**The target is the source checkout, not an npm-installed harness.** SoL-DSH is
developed against a `deepseek-harness` checkout at tag `dsh-v0.1.7-alpha.1`
(commit `c36a83ff6b`), launched as `pnpm dsh ...` from that checkout. A globally
installed `@deepseek-ai/dsh` is a *different* resolution of the same packages
and is not what this project supports, so do not point SoL-DSH at one. Note also
that the npm `latest` dist-tag points at an older release than `alpha`, so any
npm-based dependency needs an explicit version.

## Install

Build the bundle, then link it into a profile. Every `dsh` invocation below runs
from the harness checkout as `pnpm dsh`:

```sh
# 1. build SoL-DSH
cd /absolute/path/to/SoL-DSH
npm install
npm run build

# 2. link it into a profile (from the deepseek-harness checkout)
cd /absolute/path/to/deepseek-harness
pnpm dsh plugin --profile <name> add /absolute/path/to/SoL-DSH
pnpm dsh --profile <name> --dump-config   # confirm the "# == sol-dsh" layer
pnpm dsh --profile <name>
```

`plugin add` both links the checkout and appends this bundle to the profile's
`dsh.profile.bundles`, because `package.json` declares `dsh.bundle`.

A linked plugin keeps its own `node_modules`, so the shared harness packages
appear twice — once as SoL-DSH's `devDependencies` (for type checking and
standalone runs) and once in the running harness. At runtime the harness's peer
interception must supply its own copies, which is what makes
`@deepseek-ai/cordis` service identity line up. That resolution has not been
verified end to end yet; see Known limitations.

## Configuration

Every field is declared in the exported Schemastery `Config` and validated by
Cordis when the row loads. Override any of them in your profile's
`cordis.patch.yml` by row id `sol-dsh-evidence-preserving-reducer`, or from the
home-level patch.

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Whether the reducer may rewrite eligible results. |
| `minBytes` | `4096` | Minimum UTF-8 source size before reduction is attempted. |
| `maxChars` | `600000` | Maximum source size delegated to the reducer model. |
| `maxOutputTokens` | `2048` | Output cap for the reducer call. |
| `timeoutMs` | `90000` | Wall-clock deadline for the reducer call. |
| `reducerProvider` | `''` | Reducer provider route; empty uses the session's own route. |
| `reducerModel` | `''` | Reducer model id; empty uses the session's own route. |
| `commandPatterns` | see below | Regex sources identifying reducible logs. |

`reducerProvider`/`reducerModel` must be set together or both left empty.
Credentials are never part of this configuration: the harness `llm` seam
resolves them from the adapter's own credential references.

**Unknown keys are ignored, not rejected.** Schemastery object schemas have no
strict mode and the harness loader does not reject undeclared config keys, so a
misspelled field is silently dropped rather than failing the load. SoL-Pi
enforced fatal unknown keys with its own checker; that property is not
available here, and adding a bespoke checker would fight the platform's config
system. Confirm effective values instead with
`dsh --profile <name> --dump-config`, or edit them through the Settings UI,
which is generated from this same schema.

### Default command patterns

Matched case-insensitively anywhere in the command string, so a compound command
such as `cd app && pnpm test` still qualifies:

`lake build`, `lean`, `coq`, `cargo build|test|check|clippy`, `zig build`,
`pytest`, `ctest`, `ninja`, `make`, `python -m pytest|unittest|py_compile`,
`cmake --build`, `npm|pnpm|yarn test`, `go test`, `bazel test`, `tsc`,
`vitest run`.

## Audit trail

The plugin logs one line per decision through `ctx.logger` — why a candidate was
skipped or refused, which receipt reason a reduction fell back on, and the
byte/token accounting of an applied reduction.

Decision records deliberately do **not** use custom session events. In this
harness the persistence read path refuses a log containing an event type it does
not know unless that event carries `ignorable: true`, and `Session.append()`
provides no way for a plugin to set that marker — so an out-of-tree plugin
writing custom events would produce a session log that cannot be resumed. The
accepted receipt itself is durable as that call's tool-result content.

## Known limitations

- **Reducer only.** The other three mechanisms are not implemented yet.
- **No client half.** The savings indicator that Pi renders in its TUI has no
  counterpart here yet; a `shell.overlay` client plugin is the planned home for
  it. The plugin is host-side only.
- **`bash` only.** The reducer recognises the built-in `bash` tool. A
  persistent-shell or another executor's result is not reduced.
- **Pattern-based candidacy.** A reducible log produced by a command outside
  `commandPatterns` is ignored rather than reduced.
- **Spill artifact on a refused shrink.** The source is persisted before the
  receipt is rendered, so a receipt that turns out not to be smaller than its
  source leaves an unused (but still valid, retrievable) artifact.
- **No automated test suite.** The mechanism is verified by the smoke tests
  below, not by regression tests.
- **Undeclared config keys are ignored.** See the note under Configuration.
- **The reducer's own decision log is not persisted.** `ctx.logger` lines do not
  appear in the headless stdout or in `$DSH_HOME/logs`, so the audit trail is
  only visible where the harness routes logger output.
- **The reducer costs tokens to save tokens.** Round 1 spent 10,026 tokens and
  round 2 spent 65,532 to read one log each. The mechanism wins when the same
  log would otherwise be replayed across many later requests; for a log read
  once it is a net loss.
- **`maxChars` bounds delegation, not recovery.** A source larger than
  `maxChars` is skipped entirely rather than partially reduced.

## Verification

Two one-shot headless runs against deliberately failing builds, with the
reducer installed as a linked bundle in a scratch profile. Both used the
session's own routed model as the reducer.

### Round 1 — small log, canonical value carries the text

| Measure | Result |
|---|---|
| Source | `29,768` bytes, 408 lines, `npm test` exited `1` |
| Model-facing result | `1,787`-byte verified receipt |
| Context removed | **94.0%** |
| Verified evidence | 7 items, every quote found byte for byte |
| Reducer cost | 10,026 tokens |

The frontier agent received the receipt instead of the log, then followed the
receipt's `readback` guidance to open the spill artifact and confirm the quotes
were accurate — the intended "authority plus readback" split. Of the six
`tool/result` events in that session, only the eligible candidate was replaced;
the agent's own verification reads were left untouched.

### Round 2 — oversized log, recovered through the executor's spill file

This round exercises the case that matters in practice: output large enough that
the harness itself truncates it before the reducer ever sees it. `bash-local`
retains only the last `maxOutputBytes` (`64_000`) in memory and writes the
complete stream to a spill file, so a naive reducer would silently reason over a
tail.

| Measure | Result |
|---|---|
| Source | `205,449` bytes, 2,409 lines, `npm test` exited `1` |
| What the executor kept in memory | `64,000` bytes / 746 lines — **head discarded** |
| Model-facing result | `1,535`-byte verified receipt |
| Context removed | **99.3%** |
| Reducer cost | 65,532 tokens |

The proof that the complete log reached the reducer, not the retained tail:

- the receipt's `source_sha256` matches the archived source **byte for byte**;
- the archive is `205,449` bytes, not the `64,000`-byte tail;
- the receipt quotes lines 8 and 9 (`SOLPROBE_SYMBOL_0`, `SOLPROBE_SYMBOL_1`),
  and those lines exist **only** in the complete log — the retained tail no
  longer contains them.

Had `stdout`/`stderr` `spillPath` recovery failed, those head quotes would have
been unverifiable, validation would have refused the receipt, and the whole
mechanism would have fallen back to the raw log.

### Still unverified

- **The notice-text fallback.** `probeReducerSource` prefers the canonical
  value, so the `bodyFromNotice` path that parses a persisted spill-policy
  notice has never been reached. It remains a fallback of last resort.
- **Stderr-only capture.** Both rounds wrote to stderr. The stdout/stderr
  assembly (`"\n[stderr]\n"` join) has only been observed with a small stdout
  banner and a large stderr.

## Licence

MIT. Portions adapted from SoL-Pi; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
