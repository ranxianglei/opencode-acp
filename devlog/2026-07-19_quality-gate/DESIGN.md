# DESIGN - Pluggable Compression Quality Gate

- Task ID: `2026-07-19_quality-gate`
- Home Repo: `opencode-acp`
- Created: 2026-07-19
- Status: Accepted

## 1. Problem Statement

- **What problem are we solving?** ACP silently accepts catastrophic compression failures (147-char summaries of 72K-token ranges). Need a post-compression quality check that detects these and warns, with an architecture flexible enough to support future algorithms (different metrics, external LLM judges).
- **Why now?** Calibration research on issue #20 showed 3.3% of all blocks have <1% retention — too many to ignore. The model has no signal that its summaries are bad.

## 2. Goals & Non-Goals

- **Goals**:
  - Pluggable: gate is selectable by name from config
  - Default gate (`rouge-recall-v1`) catches the catastrophic cases (b27/b28 pattern) with FPR < 10%
  - Future-extension surface: external-API gate, BERTScore gate, custom-model gate can be added without touching pipeline
  - Non-blocking: failures warn, never reject
- **Non-Goals**:
  - External API gate implementation (interface only)
  - Auto-decompression on failure
  - Per-transform-hook evaluation (only on compress)

## 3. Current Architecture

`compress/range.ts` and `compress/message.ts`:
1. Validate plans (phantom, dangerous last-segment)
2. For each plan: inject placeholders, append protected content, allocate block IDs, applyCompressionState
3. Call `finalizeSession(pipeline.ts)` — saves state, sends notification

`finalizeSession` is the single integration point. It receives `NotificationEntry[]` (one per block) with `{ blockId, runId, summary, summaryTokens }`. The original messages are still in `rawMessages`.

## 4. Proposed Architecture

### Overview

```
pipeline.finalizeSession(ctx, toolCtx, rawMessages, entries, batchTopic)
    │
    ├─► (existing) saveSessionState, applyPendingCompressionDurations
    │
    ├─► (NEW) evaluateQualityGates(state, rawMessages, entries, config, logger)
    │       │
    │       ├─► for each entry:
    │       │     build QualityGateContext { block, summary, originalChunks, originalText }
    │       │     gate = registry.get(config.qualityGate.algorithm)
    │       │     result = gate.evaluate(ctx)
    │       │     if !result.passed: logger.warn + accumulate stats
    │       │
    │       └─► return QualityReport { failures: [...], passed: N, total: M }
    │
    └─► (existing) sendCompressNotification  // unchanged
```

### Key components

**`lib/compress/quality-gate/types.ts`** — Pure types, no runtime.

```typescript
export interface QualityGateContext {
    block: CompressionBlock
    summary: string
    /** Per-direct-message text, in original order. Chunk[i] = directMessageIds[i]'s text. */
    originalChunks: string[]
    /** Concatenated original text. Equal to originalChunks.join('\n'). Provided for convenience. */
    originalText: string
    /** Original token estimate (chars / 4). */
    originalTokens: number
}

export interface QualityGateMetric {
    name: string
    value: number
    /** Optional display format hint. */
    format?: "raw" | "percent" | "ratio"
}

export interface QualityGateResult {
    passed: boolean
    /** Which layer fired (algorithm-specific). e.g. "L1-length", "L2-recall". */
    layer?: string
    /** Human-readable reason for failure. */
    reason?: string
    /** Metrics for logging/notification. */
    metrics: QualityGateMetric[]
}

export interface QualityGate {
    /** Unique gate name (e.g. "rouge-recall-v1"). Used in config. */
    name: string
    /** Algorithm version — bump when thresholds/logic change. */
    version: string
    /** Evaluate the gate. MUST NOT throw — on error return { passed: true, metrics: [], ... }. */
    evaluate(ctx: QualityGateContext, config: unknown): QualityGateResult
}
```

**`lib/compress/quality-gate/registry.ts`** — Singleton map.

```typescript
const registry = new Map<string, QualityGate>()

export function registerQualityGate(gate: QualityGate): void
export function getQualityGate(name: string): QualityGate | undefined
export function listQualityGates(): string[]
```

**`lib/compress/quality-gate/tokenizer.ts`** — Shared tokenizer used by recall-based gates.

- Tokenize: lowercase → extract EN words `[a-z][a-z0-9_]+` with length ≥ 4 → exclude stopwords → extract ZH unigrams + bigrams (excluding ZH stopwords)
- Stopwords: EN articles/prepositions/common-verbs/code-noise + ZH particles/pronouns/conjunctions
- Paths: extract regex `(?:[a-zA-Z0-9_-]+/){1,}[a-zA-Z0-9_-]+\.[a-zA-Z]{1,5}` for path-coverage metrics
- tf counting: standard Map<string, number>

**`lib/compress/quality-gate/algorithms/rouge-recall-v1.ts`** — Default algorithm.

Layer 1 (length gate, 100% recall on catastrophic, 0% FPR):
- FAIL if `summary.length < minChars` (default 200) OR `retentionPct < minRetentionPct` (default 1.0)

Layer 2 (content coverage, ~6.6% FPR on good-zone):
- Only run if Layer 1 passed
- Compute `rougeF1` and `top20Recall` on content tokens
- FAIL if `rougeF1 < maxF1` (default 0.05) AND `top20Recall < maxTop20` (default 0.20)

Result includes metrics: `{ summaryLen, retentionPct, rougeF1, rougeRecall, top20Recall, nOriginalPaths, pathCoverage }`

**`lib/compress/quality-gate/algorithms/index.ts`** — Auto-registers built-in gates on import.

```typescript
import { registerQualityGate } from "../registry"
import { rougeRecallV1 } from "./rouge-recall-v1"

let registered = false
export function ensureBuiltinGatesRegistered(): void {
    if (registered) return
    registerQualityGate(rougeRecallV1)
    registered = true
}
```

**`lib/compress/quality-gate/index.ts`** — Public API barrel.

```typescript
export { evaluateBlockQuality, evaluateBatchQuality } from "./evaluate"
export { registerQualityGate, getQualityGate, listQualityGates } from "./registry"
export type { QualityGate, QualityGateContext, QualityGateResult, QualityGateMetric } from "./types"
```

**`lib/compress/quality-gate/evaluate.ts`** — Orchestrator.

```typescript
export function evaluateBlockQuality(
    state: SessionState,
    rawMessages: WithParts[],
    entry: NotificationEntry,
    config: PluginConfig,
    logger: Logger,
): QualityGateResult | null {
    if (!config.qualityGate?.enabled) return null
    ensureBuiltinGatesRegistered()
    const gate = getQualityGate(config.qualityGate.algorithm)
    if (!gate) {
        logger.warn("Quality gate not found", { algorithm: config.qualityGate.algorithm })
        return null
    }
    const block = state.prune.messages.blocksById.get(entry.blockId)
    if (!block) return null
    const ctx = buildContext(block, rawMessages)
    const algoConfig = config.qualityGate.algorithms?.[gate.name] ?? {}
    try {
        return gate.evaluate(ctx, algoConfig)
    } catch (err) {
        logger.warn("Quality gate threw — treating as pass", { gate: gate.name, error: String(err) })
        return { passed: true, metrics: [] }
    }
}

export function evaluateBatchQuality(
    state, rawMessages, entries, config, logger,
): QualityReport {
    const failures: Array<{ entry: NotificationEntry; result: QualityGateResult }> = []
    for (const entry of entries) {
        const result = evaluateBlockQuality(state, rawMessages, entry, config, logger)
        if (result && !result.passed) failures.push({ entry, result })
    }
    return { total: entries.length, passed: entries.length - failures.length, failures }
}
```

### Config schema

Add to `PluginConfig`:

```typescript
export interface QualityGateConfig {
    enabled: boolean
    /** Which gate to use (must exist in registry). */
    algorithm: string
    /** Per-algorithm config. Keys are gate names. */
    algorithms: {
        "rouge-recall-v1"?: RougeRecallV1Config
        // Future: "external-api-v1"?: ExternalApiConfig
        [key: string]: unknown
    }
}

export interface RougeRecallV1Config {
    layer1MinChars: number
    layer1MinRetentionPct: number
    layer2MaxRougeF1: number
    layer2MaxTop20Recall: number
}

export interface PluginConfig {
    // ... existing
    qualityGate: QualityGateConfig
}
```

Default:
```typescript
qualityGate: {
    enabled: false,  // opt-in for v1; flip to true in next release after burn-in
    algorithm: "rouge-recall-v1",
    algorithms: {
        "rouge-recall-v1": {
            layer1MinChars: 200,
            layer1MinRetentionPct: 1.0,
            layer2MaxRougeF1: 0.05,
            layer2MaxTop20Recall: 0.20,
        },
    },
},
```

### Pipeline integration

`pipeline.ts::finalizeSession` after `applyPendingCompressionDurations`:

```typescript
const qualityReport = evaluateBatchQuality(
    ctx.state, rawMessages, entries, ctx.config, ctx.logger,
)
if (qualityReport.failures.length > 0) {
    for (const { entry, result } of qualityReport.failures) {
        ctx.logger.warn("Compression quality gate FAILED", {
            blockId: entry.blockId,
            algorithm: ctx.config.qualityGate.algorithm,
            layer: result.layer,
            reason: result.reason,
            metrics: Object.fromEntries(result.metrics.map(m => [m.name, m.value])),
        })
    }
}
// Non-blocking: continue to saveSessionState + notification
```

`Logger.warn` goes to `logs/acp/daily/<date>.log`. Future iterations can surface in TUI.

### Data flow

```
compress call (range/message)
    │
    ▼
applyCompressionState → creates CompressionBlock with directMessageIds
    │
    ▼
finalizeSession(entries)
    │
    ├─► evaluateBatchQuality
    │       │
    │       ├─► for each entry.blockId:
    │       │     fetch block from state.prune.messages.blocksById
    │       │     for each directMessageId: extract text parts from rawMessages
    │       │     build QualityGateContext
    │       │     registry.get(algorithm).evaluate(ctx, algoConfig)
    │       │
    │       └─► return QualityReport
    │
    ├─► saveSessionState (unchanged)
    └─► sendCompressNotification (unchanged)
```

## 5. Design Decisions & Rationale

| Decision | Options Considered | Chosen | Why |
|----------|--------------------|--------|-----|
| Gate location | (a) Inside compress tool before applyCompressionState (b) After applyCompressionState in finalizeSession (c) Transform hook | (b) | Block already exists, original messages still in scope, runs once per compress |
| Failure behavior | (a) Reject compression (b) Auto-decompress (c) Warn only | (c) | Block is already created, model already moved on. Warn = info, no disruption |
| Tokenizer | (a) Reuse Anthropic tokenizer (b) Hand-rolled EN+ZH (c) External lib | (b) | Anthropic tokenizer is for cost estimation (BPE); we want word-level tokens for recall metrics. Hand-rolled avoids new deps. |
| ZH tokenization | (a) Unigrams only (b) Bigrams only (c) Both | (c) | Unigrams catch single-char matches; bigrams reduce false positives (single chars like 的/了 are noisy even with stopword removal) |
| Config default `enabled` | (a) true (b) false | (b) | Ship behind a flag for one release to burn-in; flip to true next release after telemetry confirms thresholds |
| Algorithm versioning | (a) Implicit in git history (b) Bump `version` field | (b) | If we tweak thresholds, downstream tools can detect via version |
| Multiple algorithms per call | (a) Run only configured one (b) Run all registered | (a) | Keep it simple; user picks one. Future: support array. |
| Registry pattern | (a) Map singleton (b) DI container (c) Function params | (a) | Matches existing ACP pattern (no DI); registry is module-local, easy to test |

## 6. Impact Analysis

- **Backward compatibility**: ✅ New `qualityGate` config section is optional; defaults to `enabled: false`. Existing configs work unchanged.
- **Performance**: ⚠️ Adds N evaluations per compress call where N = blocks in batch. Each evaluation is O(summary_tokens + original_tokens) for tokenization, plus O(topK log) for sorting. ~5ms typical, < 10ms for 50K-token originals.
- **Security**: ✅ No external calls in v1. External-API gate (future) will need auth + URL allow-list.
- **Dependencies**: ✅ None. Pure TS implementation.

## 7. Migration Plan

- **Steps**:
  1. Add new config section with `enabled: false` default — no behavior change
  2. Code ships; users can opt-in via config
  3. After 1 release burn-in, flip default to `enabled: true`
- **Feature flags**: `qualityGate.enabled` is the feature flag

## 8. Open Questions

- [ ] Should quality failures surface in TUI notification? (For now: logger only. Future iteration may add a warning emoji to the chat notification.)
- [ ] Should we collect aggregate stats (per-session failure rate) for diagnostics? (Future: add to `state.stats`.)
