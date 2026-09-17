# DESIGN - V2 compaction usage becomes phantom system overhead (#421)

- Task ID: `2026-09-17_v2-compaction-phantom-system`
- Home Repo: `opencode-acp`
- Created: 2026-09-17
- Status: Accepted

## 1. Problem Statement

- **What problem are we solving?** In OpenCode v2 the native compaction checkpoint is projected as an assistant message with `info.summary === true` whose `tokens` are copied **verbatim from the compaction request** (`lib/v2/projection/shared.ts` `makeAssistantInfo`). The system-overhead calibration (`cacheSystemPromptTokens`) picks the first assistant with input tokens and stores `input − firstUserTextTokens` as a permanent estimate of "system prompt + tool schemas". After a compaction that anchor is the summary itself, so the stored value is the *compaction request size* (repro: input 653137 → phantom 653136). Everything downstream inherits it: hard-guard budget (`context.ts`/`transform.ts`: 400000 − 653136 − 32768 = **−285904**), nudge context usage, tool truncation overhead, and `/acp context`.
- **Why now?** It fires on every V2 session that hits native compaction — before and after process reload — while actual provider usage stays far smaller, producing negative-budget log spam and unnecessary tool clearing.

## 2. Goals & Non-Goals

- **Goals**:
  - First request after compaction **and** after reload must not carry a phantom overhead; usable budget stays nonnegative.
  - No unnecessary tool clearing caused by inflated estimates.
  - Prefer the *actual* outgoing wire overhead when it can be measured (V2 exposes `event.system`).
  - Distinguish heuristic estimates from measured values in status output.
  - Preserve V1 behavior and all existing tests (#255 calibration suite included).
- **Non-Goals**:
  - Changing how V2 projects compaction sources (the verbatim token copy is correct for usage reporting elsewhere; the bug is in *consuming* it for calibration).
  - Persisting `systemPromptTokens*` across restarts (intentionally transient; recalibration on load is the fix).
  - New configuration surface.

## 3. Current Architecture (before)

```
V2 host event ──► v2/context.ts run() ──► prepareMessageTransformTransaction(...)
                                                        │
                                                        ▼
                              runMessageTransform (lib/messages/transform.ts)
                                                        │
                                                        ▼
                     cacheSystemPromptTokens(state, messages)   [lib/ui/utils.ts]
                       first assistant w/ input>0 → input − firstUserText = cached forever
                                                        │
        ┌───────────────────────────────┬────────────────┴───────────────┐
        ▼                               ▼                                ▼
  hard-guard budget              nudge context usage            tool-truncation overhead
```

Pain points: anchor selection ignores `summary`/staleness; only first user text subtracted; no invalidation on compaction or model switch; V2's real `event.system` never measured.

## 4. Proposed Architecture

### Overview

```
V2 host event ──► v2/context.ts run()
                    │  measuredSystemTokens = Σ countTokens(event.system[].text)
                    │                        + countTokens(rendered ACP system prompt)
                    ▼
          prepareMessageTransformTransaction(..., measuredSystemTokens?)
                    ▼
          runMessageTransform(options.measuredSystemTokens)
                    │  model switch? ──► clear systemPromptTokens{,Source}
                    ▼
          cacheSystemPromptTokens(state, messages, measuredSystemTokens?)
                    │  calibrated = calibrateSystemOverhead(state, messages)
                    │     anchors: first assistant NOT summary AND created ≥ lastCompaction
                    │     prefix:  Σ countAllMessageTokens(pre-anchor wire-visible msgs)
                    │  store max(calibrated, measured) + provenance ("heuristic"|"measured")
                    ▼
          resetOnCompaction (native compaction detected) ──► clear both fields (recalibrate next turn)
```

### Key components

- `calibrateSystemOverhead(state, messages)` (lib/token-utils.ts) — single source of truth for the heuristic; `estimateSystemPromptTokens(messages, lastCompaction = 0)` delegates to it.
- `cacheSystemPromptTokens(state, messages, measuredSystemTokens?)` (lib/ui/utils.ts) — merges heuristic + measured, records provenance; keeps the [FIX #255] stable-positive-cache early return.
- Invalidation points: `resetOnCompaction` (lib/state/utils.ts) and the model-switch block in `runMessageTransform` (lib/messages/transform.ts).
- Measurement site: `lib/v2/context.ts` (only V2 has access to the host's outgoing `event.system`; ACP's own rendered system prompt is counted separately because it is appended at commit time).
- Status: `lib/compress/status.ts` labels the breakdown segment `[measured]` / `[estimated]`.

### Data flow

Heuristic path (both runtimes): anchor residual → floor by measurement (V2 only) → cache with provenance. Invalidated on compaction/model switch → recomputed next transform. Reload: state file restores `lastCompaction`, `systemPromptTokens` starts undefined → same guarded path.

### API / interface changes

| API | Change |
|-----|--------|
| `cacheSystemPromptTokens` | new optional 3rd param `measuredSystemTokens?: number` (backward compatible) |
| `estimateSystemPromptTokens` | new optional 2nd param `lastCompaction = 0` (backward compatible) |
| `calibrateSystemOverhead` | new export |
| `SessionState` | new transient field `systemPromptTokensSource: "heuristic" \| "measured" \| undefined` (not persisted — no migration) |
| `prepareMessageTransformTransaction` | new optional trailing param `measuredSystemTokens?: number` |
| `MessageTransformOptions` | new `measuredSystemTokens?: number` |
| `/acp context` output | system segment gains `[measured]`/`[estimated]` suffix |

Internal `dcp-*` tag naming untouched (§2.6 backward-compat rule).

## 5. Design Decisions & Rationale

| Decision | Options Considered | Chosen | Why |
|----------|--------------------|--------|-----|
| Where to stop the phantom | (a) strip/zero usage in V2 projection; (b) guard the calibration consumer | (b) guard consumer | Projection's verbatim copy feeds legitimate usage reporting (`getCurrentTokenUsage` already guards summaries); zeroing there would corrupt other consumers. Fix belongs where the wrong *interpretation* happens. |
| Anchor staleness signal | (a) `info.summary === true` only; (b) also `created < lastCompaction` | (b) both | Native compaction may leave non-summary pre-compaction assistants visible; their prompts described a window that no longer exists. Mirrors the existing guard in `getCurrentTokenUsage`. |
| Prefix subtraction | (a) first user text only (legacy); (b) full wire-visible pre-anchor prefix via BPE | (b) | Post-compaction prefixes contain the summary text; legacy underestimates. Plain-text sessions compute identically (#255 suite green), so compatibility holds. |
| Measured vs heuristic combination | (a) replace heuristic with measurement; (b) `max(measured, calibrated)` | (b) | Heuristic residual includes tool schemas which `event.system` alone does not; taking the larger avoids regressing below true overhead when only one signal is available. Provenance records which won. |
| Calibration cost | (a) length/4 fast estimate; (b) real BPE `countAllMessageTokens` | (b) | Consistency with `/acp context` math. Runs once per init/compaction/model-switch, not per LLM call — acceptable. |
| Persistence | persist source alongside tokens | no | `systemPromptTokens` was already intentionally transient; persistence would reintroduce stale estimates across model changes. |

## 6. Impact Analysis

- **V1**: unchanged code path except prefix accuracy improvement and model-switch invalidation (strictly more correct); #255 regression suite passes unmodified.
- **V2**: first post-compaction request now gets `undefined` (no phantom) until either the measured floor applies (always available in V2) or a fresh post-compaction assistant provides an anchor. Budgets stay nonnegative; no spurious tool clearing.
- **Performance**: one extra BPE pass over the pre-anchor prefix per calibration event; one extra `countTokens` over system parts per V2 transaction (system parts are small relative to history).
- **Compatibility**: no persisted-state change, no config change, no internal tag rename; all public function signatures extended with optional trailing parameters only.
