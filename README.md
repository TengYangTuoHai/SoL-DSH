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
| ObservationPack | implemented | `agent/pre-step` + surface replacement protocol |
| Action Fusion | implemented | agent-scoped tool shadowing + `ctx.tools.execute` |
| Online Context Compact | implemented | `BasicCompactionEngine` subclass + `compactIfNeeded` gate |

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

### ObservationPack

A large tool result is usually read once and then replayed into every later
provider request. ObservationPack sends such a result in full for its first
`fullSends` requests, then replaces it with a short placeholder that names an
archived copy, so recall stays possible without replay.

**Its mechanism is not the one SoL-Pi uses, and that is deliberate.** The
comparable harness seam is `ctx.sessions.registerMessageProjection`, which
rewrites derived history without touching stored events — but that seam needs a
plugin-owned session event to describe the change, and an out-of-tree plugin
cannot write one:

- `Session.append` offers no way to mark an event `ignorable`;
- the persistence read path refuses a log containing an unknown event type that
  is not so marked (`validateStoredEvents` in `@deepseek-ai/dsh-session-persistence`).

A plugin taking that route would produce a session log that **cannot be
resumed**. SoL-DSH therefore uses the surface replacement protocol the harness
already ships for exactly this purpose, the same one
`@deepseek-ai/dsh-compaction-tool-result-pruner` uses:

1. append a `compaction/prune` shadow-price event pricing the shadowed node;
2. append the replacement `tool/result` immediately after it, with
   `surfaceOp: { op: 'replace', … }` citing the shadowed seq.

Both event types are known to the harness, the canonical value is untouched, and
the original event stays in the log for replay and inspection. The compaction
invariant validates `compaction/prune` on its own, so a bare prune outside a
compaction transaction is legal.

Eligibility is conservative: the node must still be a current surface node (so a
previously packed node, whose original seq is now shadowed, is never revisited),
entirely text (images and files are left alone rather than half-packed), larger
than `minBytes`, and have `fullSends` assistant messages after it.

### Action Fusion

Rollouts repeatedly show the same pair of turns: edit or write a file, then run
a command to test, build, or start it. Action Fusion extends each configured
mutation tool with an optional `then_run`, so one call applies the mutation, runs
the command, and returns one combined observation — the model decision between
the two turns disappears.

**Mechanism: wrap, do not reimplement.** The harness does not export the shipped
`write`/`edit` definitions, so this plugin extends whatever is globally
registered:

1. `ctx.tools.get(name)` reads the global definition — its compiled JSON Schema,
   canonical output contract, renderer, and presentation projections.
2. A shadow is registered through `agent.ctx`. That is legal because the
   duplicate check is **per layer**, and scoped registrations shadow inherited
   ones; a global re-registration of `write` would throw.
3. The shadow reuses the base `output` object untouched and forwards every other
   member. The wrap therefore inherits the sandbox escalation fields
   (`sandbox_permissions`, `justification`), the `fs/write-intent`
   read-before-write gate, and the `write`/`edit` diff cards.

The follow-up command is dispatched through `ctx.tools.execute()`, **not** by
calling the shell executor directly, so it traverses the full pipeline —
approval policy, monotonic guards, sandbox resolution, and result
post-processing. A fused command is subject to exactly the same policy as one
the model issued itself.

The canonical value is never widened. `execute` returns the base mutation's value
unchanged, and the command's observation is grafted onto the model-facing content
in `finalizeContent`, the documented hook for a last-mile content transform. The
value shape the shipped UI cards and programmatic callers expect is preserved.

Three behaviours matter for correctness:

- **A failed mutation skips the command entirely.** The base `execute` throws and
  the exception propagates untouched.
- **A failed command never rolls back the mutation.** A non-zero exit is a
  *successful* shell call in this harness, so the plugin reports it in the
  observation and keeps the edit — the same way the model would see it from a
  separate call.
- **The status marker follows the command, not the tool call.** Because a
  non-zero exit is not an error, reading `isError` alone would label a failing
  build as a success — the single most decision-relevant case. The marker reads
  the exit status instead: `[then_run:succeeded] exit=0` versus
  `[then_run:failed] exit=N (the mutation was applied and kept)`.

### Online Context Compact

The stock backend compacts automatically when the context crosses a fixed share
of the window. That is a *pressure* rule: it says "the context is large", not
"compacting now is worth its price". This mechanism subclasses the stock backend
and puts a cost model in front of the automatic timing decision.

Compacting is never free. It pays a summarization write, and on a cached route
it pays an incremental cache write on the next request — every token the
compaction removed has to be re-written once. It pays off only if the tokens it
removes would otherwise be replayed in enough remaining requests to cover that
cost.

**Mechanism: subclass, gate, then delegate.**

- `compactIfNeeded` is called by the base class's own `agent/pre-step` and
  `agent/request-error` listeners, and the base keeps that call dynamically
  dispatched so a subclass override is honoured at event time. The override is
  the gate.
- `context-overflow` is **never** gated. That path is corrective, not economic:
  the provider already refused the request, so the only alternative to
  compacting is failing.
- Window protection overrides the cost comparison: within `windowReserveTokens`
  of the limit, compaction proceeds regardless of price.
- **An unavailable horizon is not evidence of waste.** When no plan is visible —
  no todo list, no active goal — there is nothing to suggest the session is
  ending, so the gate leaves the decision to the stock policy. Deferring there
  would suppress compaction almost everywhere and let context grow until the
  reserve fired, which is a regression, not an optimization.
- Every fault inside the gate fails open to stock behaviour, because compaction
  is a safety function and a bug here must cost money, not the session.

The horizon comes from signals the harness already has: the live `todos`
projection (a standing plan cleared each turn, so its open items are the work
left in this scope), else an active goal's remaining rounds, else nothing — in
which case the gate stands down.

**Substituting the stock backend needs two patch steps.** A Cordis context holds
exactly one `ctx.compaction` implementation, so this engine cannot mount beside
the stock one. A patch may not change a row's `name` — the loader refuses that
with a `name mismatch` warning and skips the entry — so the shipped patch
disables the stock `compaction-basic` row and inserts this engine as its own
row. A profile that prefers the stock backend can re-enable that row in a later
patch layer.

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
interception supplies its own copies, which is what makes
`@deepseek-ai/cordis` service identity line up. This has been verified: every
mechanism loads and runs from a linked checkout.

**Do not add a `prepare` script.** An earlier revision ran `tsc` from
`prepare` so a fresh clone would be immediately buildable. That hangs
`dsh plugin add`: pnpm blocks a package's build scripts until the user approves
them, prints an `allowBuilds` instruction, and waits — while `dsh plugin` pipes
pnpm's output, so the prompt is invisible and the command never returns. Build
explicitly with `npm run build` instead, and make sure `lib/` exists before
linking the bundle, because the harness loads built JS and never compiles
TypeScript from a plugin.

### When changes take effect

`dsh plugin add` writes the profile's `package.json` and `node_modules`, and a
running harness watching its own tree picks that up: the example probe session
recorded a `request/header` with `reason: resume` at the exact second the profile
changed, and began loading the mechanisms present in the bundle patch *at that
moment*. Two consequences matter while iterating:

- **Editing an out-of-tree bundle's `cordis.patch.yml` does NOT trigger a
  reload.** The watcher's root is the harness checkout, not the linked package
  directory, so a patch edit made after the last profile write is invisible until
  a restart. A live session can therefore be running an older patch than the one
  on disk — check the `request/header` history before trusting that a change
  landed.
- **A restart is the only way to guarantee the current patch is loaded.** Prefer
  it whenever a change touched `cordis.patch.yml` or a plugin's built JS.

### Verifying what is actually live

Inspect a session log for each mechanism's signature. Counting raw strings in
the log is **not** good enough, for two reasons learned the hard way:

- `compaction/prune` alone proves nothing — the harness ships its own
  `@deepseek-ai/dsh-compaction-tool-result-pruner` that also emits it.
- A conversation *about* this plugin contains the same marker text a mechanism
  emits. One session reported 198 occurrences of `[then_run:` while none of its
  requests ever saw a `then_run` parameter; every one came from prose.

So parse events, look only inside `tool/result` content, require the fusion
marker at the start of its own block, and read the tool shadow from the last
`request/header`:

```sh
for f in $(find "${DSH_HOME:-$HOME/.dsh}/sessions" -name 'session.v4.jsonl.zstd' -newermt '-10 minutes'); do
  node -e '
    const z = require("node:zlib"), fs = require("node:fs")
    const b = fs.readFileSync(process.argv[1]), M = Buffer.from([0x28,0xB5,0x2F,0xFD])
    const o = []; let i = 0
    while ((i = b.indexOf(M, i)) !== -1) { o.push(i); i += 4 }
    let text = ""
    for (let k = 0; k < o.length; k++) {
      const e = k + 1 < o.length ? o[k+1] : b.length
      try { text += z.zstdDecompressSync(b.subarray(o[k], e)).toString("utf8") } catch {}
    }
    const events = text.split("\n").filter(Boolean)
      .map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    let reducer = 0, obspack = 0, fusion = 0
    for (const e of events) {
      if (e.type !== "tool/result") continue
      const blocks = (e.data.message?.content ?? []).filter(x => x.type === "text")
      const whole = blocks.map(x => x.text).join("\n")
      if (whole.includes("sol_dsh_evidence_receipt_v1")) reducer++
      if (whole.includes("sol_dsh_observation_v1")) obspack++
      if (blocks.some(x => x.text.startsWith("[then_run:"))) fusion++
    }
    const compact = events.filter(e => e.type === "compaction/start").length
    const tools = events.filter(e => e.type === "request/header").pop()?.data.header?.tools ?? []
    const shadowed = tools.some(t => Object.keys(t.parameters?.properties ?? {}).includes("then_run"))
    if (reducer || obspack || fusion || compact || shadowed) {
      console.log(process.argv[1].split("session-")[1].slice(0, 8),
        "reducer=" + reducer, "obspack=" + obspack, "fusion=" + fusion,
        "compact=" + compact, "tools.shadowed=" + shadowed)
    }
  ' "$f"
done
```

A session log is stored as appended zstd frames, so a single
`zstdDecompressSync` returns only the first frame — scan for the magic bytes as
above, or most of the events read as a single `session` header.

`tools.shadowed=true` is the reliable signal that Action Fusion mounted, because
it reads the tool schema the model actually received rather than any marker text.

### Reverting one mechanism

A profile's own `cordis.patch.yml` is applied after every bundle layer, so any
mechanism can be turned off without touching this package.

The other three are additive and need only their own `enabled: false`.

**Restoring the stock compaction backend needs the row disabled, not
`enabled: false`.** This engine is a class plugin, and a subclass cannot avoid
its parent's constructor — `ctx.compaction` is registered there, before any
config is read. So `enabled: false` still claims the service, and re-enabling
`compaction-basic` beside it fails with:

```
sol-dsh-context-compact (sol-dsh/context-compact):
  Error: service "compaction" has been registered at <BasicCompactionEngine>
```

The harness contains that failure as a warning and the stock backend still
serves compaction, but the boot is noisy. Disable the row instead:

```yaml
- id: compaction-basic
  disabled: false
- id: sol-dsh-context-compact
  disabled: true
```

`enabled: false` remains the right switch for keeping the engine mounted while
making every decision the stock one — for example to A/B the gate without
changing which services are composed.

## Configuration

Each mechanism is a separate plugin row with its own schema, so either can be
disabled without touching the other. Override any field in your profile's
`cordis.patch.yml` by row id, or from the home-level patch. A patch replaces a
row's whole `config` value rather than deep-merging it, so restate every key the
row needs.

### `sol-dsh-evidence-preserving-reducer`

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

### `sol-dsh-observation-pack`

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Whether the packer may replace surface results. |
| `minBytes` | `8192` | Minimum UTF-8 size before a result becomes packable. |
| `fullSends` | `3` | Assistant messages that must follow before packing. |
| `maxPerPass` | `8` | Upper bound on replacements committed by one pass. |

`fullSends` is what makes the replacement safe: a result is sent in full for
that many requests, so the frontier agent has already had the original in
context before the placeholder takes its place.

### `sol-dsh-action-fusion`

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Whether the fuser may shadow the configured tools. |
| `tools` | `['write', 'edit']` | Tool names to extend with `then_run`. |
| `shellTool` | `bash` | Shell tool the follow-up command is dispatched to. |
| `defaultTimeoutMs` | `120000` | Fallback timeout when `then_run.timeoutMs` is absent. |

A name in `tools` with no globally registered definition is skipped with a log
line rather than registered from nothing: this plugin extends shipped tools, it
does not own their schemas.

### `sol-dsh-context-compact`

This row also accepts **every stock compaction field** — `thresholdRatio`,
`headroomTokens`, `retainRatio`, `retainTokens`, `summarizationProvider`,
`summarizationModel`, `maxTokens`, `compactionRetries`, `maxOverflowRetries`,
`modelPolicies`, `auto` — because its schema is the stock schema merged with the
fields below.

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Whether the cost model may defer automatic pressure compaction. |
| `cacheWriteReadRatio` | `12.5` | Billed cache-write cost relative to a cache read. `0` makes every affordable compaction economic. |
| `windowReserveTokens` | `16384` | Headroom below the window at which compaction is forced regardless of cost. |
| `memoTokenEstimate` | `1200` | Estimated size of one replacement summary. |
| `remainingRequestScale` | `1` | Multiplier on the estimated remaining requests. |
| `remainingRequestStddevK` | `0` | Standard deviations subtracted from the per-boundary mean. |
| `firstCompactionRequestScale` | `2` | Horizon multiplier granted to the first compaction. |
| `subsequentCompactionMargin` | `1.5` | Extra margin a later compaction must clear. |
| `fallbackRequestsPerBoundary` | `8` | Requests per boundary when none has been observed yet. |

Setting `enabled: false` makes the engine delegate every decision to the stock
policy, which is the supported way to turn the cost model off without editing
the composition.

### Both mechanisms

**Unknown keys are ignored, not rejected.** Schemastery object schemas have no
strict mode and the harness loader does not reject undeclared config keys, so a
misspelled field is silently dropped rather than failing the load. SoL-Pi
enforced fatal unknown keys with its own checker; that property is not
available here, and adding a bespoke checker would fight the platform's config
system. Confirm effective values instead with
`dsh --profile <name> --dump-config`, or edit them through the Settings UI,
which is generated from this same schema.

### Default command patterns

The reducer's `commandPatterns`, matched case-insensitively anywhere in the
command string, so a compound command such as `cd app && pnpm test` still
qualifies:

`lake build`, `lean`, `coq`, `cargo build|test|check|clippy`, `zig build`,
`pytest`, `ctest`, `ninja`, `make`, `python -m pytest|unittest|py_compile`,
`cmake --build`, `npm|pnpm|yarn test`, `go test`, `bazel test`, `tsc`,
`vitest run`.

## Audit trail

The plugin logs one line per decision through `ctx.logger` — why a candidate was
skipped or refused, which receipt reason a reduction fell back on, the
byte/token accounting of an applied reduction, and each packed observation.

Decision records deliberately do **not** use custom session events. In this
harness the persistence read path refuses a log containing an event type it does
not know unless that event carries `ignorable: true`, and `Session.append()`
provides no way for a plugin to set that marker — so an out-of-tree plugin
writing custom events would produce a session log that cannot be resumed. The
accepted receipt is durable as that call's tool-result content, and a packed
observation is durable as a `compaction/prune` plus `tool/result` replacement.

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
- **No automated test suite.** The mechanisms are verified by the smoke tests
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
- **ObservationPack can archive a preview instead of the original.** When
  `dsh-spill-policy` has already replaced a large result, the packer archives
  that already-spilled preview rather than reusing the original artifact. The
  chain still reaches the original — the preview carries its own locator — but
  it costs a second artifact.
- **ObservationPack is text-only.** A result carrying images or files is left
  alone, because it cannot be archived as UTF-8 text.
- **Overlap with a shipped package.** `@deepseek-ai/dsh-compaction-tool-result-pruner`
  already trims over-budget results, but only when the compaction backend runs
  it under pressure. ObservationPack is proactive, on a fixed request count.
- **Action Fusion shadows only the tools it names.** It does not touch the
  persistent-shell, PowerShell, or `str_replace_editor` tools, and a tool mounted
  after the agent is created is not picked up until the next reload.
- **Action Fusion adds one nested call per fused call.** The follow-up still
  costs a full tool dispatch (and its approval, if policy asks), so a fused call
  is not free — it removes a model round trip, not the work.
- **The shadow is per agent, not per composition.** Each agent receives its own
  registration, so a composition with many agents holds one shadow each.
- **A plugin that fails to activate does not stop the harness.** A bad `inject`
  list surfaces as `dsh: warning: 1 entry did not activate` plus the Cordis error,
  and the rest of the profile boots. Check for that line after changing a plugin.
- **The compaction estimate is coarse.** `archiveTokens` is derived from the
  retained-tail policy, while the backend picks its real range by balancing
  tool-call pairs against checkpoint boundaries. The gate can therefore approve
  a compaction that the backend then refuses as unprofitable. The backend's own
  guard keeps this safe, but it can cost one wasted summarization attempt.
- **Online Context Compact only gates the automatic path.** Manual `/compact`
  still runs the stock `compactNow` untouched, and `context-overflow` recovery
  is never gated.
- **The horizon needs a visible plan.** With neither a todo list nor an active
  goal, the gate stands down and behaviour is exactly the stock policy — which
  means the cost model does nothing in the common plan-less session.
- **Activation failure is contagious for `/compact`.** This engine replaces the
  stock backend's row, so if it fails to mount, `command-compact` reports
  `pending (waiting for service: compaction)` and compaction is unavailable
  entirely. Test a configuration change before relying on it.
- **The gated path has only been observed in short probe sessions.** Runs A2 and
  B2 complete two to three steps before the model hits a token cap, so the
  long-run behaviour of deferral — in particular whether repeated deferral
  starves compaction until the window reserve fires — is unverified.

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

### Round 3 — ObservationPack surface replacement

A four-step run whose first step produced a 25,370-byte result, with
`fullSends` lowered to `1` so packing was reachable in a short run.

| Measure | Result |
|---|---|
| Source result | `25,370` bytes, 260 lines |
| Model-facing placeholder | `434` bytes |
| Context removed | **98.3%** |
| Shadow-price event | `compaction/prune`, `shadowedSeqs [18]`, `shadowedTokenCount 6351` |
| Replacement | `tool/result` seq 26, cites seq 18, `surfaceOp { op: 'replace' }` |

The frontier agent received the placeholder naming the archived locator instead
of the original body, and reported it without the log ever being replayed.

**The log stayed resumable.** Every event type written is one the harness
already knows, and the session was then adopted again with
`--session-id <id>`, which answered `RESUME_OK` with exit `0`. That is the
property the projection-seam route would have failed: a plugin-owned event type
would have made the persistence read path refuse this session entirely.

### Round 4 — Action Fusion

Two runs against the shipped `write` tool.

*Fused write and run, one call:*

| Measure | Result |
|---|---|
| `tool/call` events | **1** — one call performed both the write and the execution |
| Model-facing result | base write rendering, then `[then_run:succeeded]`, then `FUSED_OK` |
| `write` parameters the model saw | `file_path, content, sandbox_permissions, justification, then_run` |
| `edit` parameters the model saw | `file_path, old_string, new_string, replace_all, sandbox_permissions, justification, then_run` |
| `required` | `["file_path","content"]` — `then_run` stayed optional |

The sandbox escalation fields surviving is the evidence that wrapping preserved
the shipped definition rather than rebuilding it.

*Plain call and failing command, one call each:*

| Measure | Result |
|---|---|
| `tool/call` events | 2 |
| `then_run` markers across both results | **1** — only the fused call produced one |
| Plain write result | no marker; the unfused path is untouched |
| Failing command (`exit 7`) | `[then_run:failed] exit=7 (the mutation was applied and kept)` |
| Filesystem | both files written, including the one whose command failed |

That last row is the important one: a failing follow-up command is reported, not
raised, and does not undo the mutation.

### Round 5 — Online Context Compact

Compaction is hard to force quickly, so these runs used a deliberately small
window (`contextWindow: 30000`, `thresholdRatio: 0.25`, `headroomTokens: 8000`,
`maxTokens: 4000`) and a 50 KB tool result to cross the threshold.

*Substitution and mounting.* Disabling the stock `compaction-basic` row and
inserting this engine composes cleanly: `--dump-config` shows the stock row
`disabled: true` and this row beside it, and a boot reports no
`did not activate` warning.

*The gate decides, on the same session shape:*

| Run | Visible plan | `cacheWriteReadRatio` | `compaction/start` |
|---|---|---|---|
| C (control) | none | gate disabled | **4** — stock behaviour intact |
| A2 | 1 todo open | `12.5` | **0** — deferred |
| B2 | 1 todo open | `0` | **1** — allowed |

Run A2 and B2 are the same session shape and differ only in the cost ratio, so
the difference is the gate. Run C proves the setup can compact at all and that
disabling the gate restores the stock path.

*The gate can approve a compaction the backend then declines.* In run B2 the
allowed compaction ended immediately:

```
compaction/end  error: summary is not smaller than the shadowed content
                (556 estimated framed tokens >= 86)
```

The gate estimated `archiveTokens` from the retained-tail policy (about 10,000
tokens at that moment), but the backend's own range selection found only 86
tokens it could actually shadow — it balances tool-call pairs against
checkpoint boundaries, which the estimate does not model. The backend's own
guard refused the pointless summary, so the outcome is safe; the cost is one
wasted summarization attempt. See the limitations below.

### Still unverified

- **The notice-text fallback.** `probeReducerSource` prefers the canonical
  value, so the `bodyFromNotice` path that parses a persisted spill-policy
  notice has never been reached. It remains a fallback of last resort.
- **Stderr-only capture.** The reducer rounds wrote to stderr. The stdout/stderr
  assembly (`"\n[stderr]\n"` join) has only been observed with a small stdout
  banner and a large stderr.
- **No resume of a packed session across a compaction.** Round 3 resumed
  cleanly, but interplay between a packed placeholder and a later compaction
  that shadows the same range has not been exercised.
- **ObservationPack has not been observed at its shipped `fullSends: 3`.** The
  verified run used `1`.

## Licence

MIT. Portions adapted from SoL-Pi; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Tests

`npm test` runs the regression suite (vitest). `npm run check` chains typecheck,
tests, and build.

The suite covers only the pure decision surface, deliberately: the plugin
entries need a live Cordis context and are exercised by the smoke runs instead.
To make that surface testable, the logic worth pinning was extracted out of the
entries — `context-compact/config.ts` (the config split the base constructor
requires), `action-fusion/params.ts` (the parameter surface and observation
markers), and `observation-pack/placeholder.ts` (the eligibility rule). Each
extraction also removed a duplicated implementation from its entry.

What the tests hold down, and why those properties:

| Area | Property |
|---|---|
| Receipt validation | No unverifiable summary is accepted: quotes must appear byte for byte, the source hash and schema must match, the status must agree with the observed exit, and a failing log must carry failure evidence. Each refusal reason is a way a fluent but unfounded summary could otherwise reach the frontier agent. |
| Reducer prompt | The log is fenced as untrusted, the command is hashed rather than embedded, and diagnosis is forbidden. |
| Compaction economics | Window protection overrides cost; an unavailable horizon is reported as such rather than as "do not compact"; carried debt and the subsequent-margin gate can each defer a compaction that would otherwise pass. |
| Config handling | Economics fields are stripped before the stock constructor's strict key check, and every surviving key is one it accepts. |
| Command patterns | Build and test commands match; `ls`, `git status`, and words merely containing a pattern (`latest`, `remake`) do not. |
| Action Fusion parameters | `then_run` stays optional, sandbox escalation fields survive, and the dispatched arguments stay losslessly JSON-serializable. |
| Observation markers | The marker's status follows the command's exit, not the tool call's, and it terminates with a newline so a consumer cannot fuse it with the first output line. |
