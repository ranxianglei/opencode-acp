# WORKLOG — Quality Gate (Issue #20, v1.13.0)

## Goal

Add a pluggable post-compression quality gate that detects summaries which catastrophically lost content. Non-blocking — failures only `logger.warn`. Default algorithm `rouge-recall-v1` calibrated against 6,913 real-world blocks.

## Branch

`2026-07-19_quality-gate` from `master`.

## Implementation

### Files created

| File | Purpose |
|---|---|
| `lib/compress/quality-gate/types.ts` | `QualityGate`, `QualityGateContext`, `QualityGateResult`, `QualityGateMetric`, `QualityReport` |
| `lib/compress/quality-gate/registry.ts` | Singleton `Map` of registered gates. Idempotent registration; conflicts on same-name+different-version throw. |
| `lib/compress/quality-gate/tokenizer.ts` | Hand-rolled word-level tokenizer (English keywords ≥4 chars + Chinese unigrams/bigrams). Separate from ACP's BPE tokenizer — too coarse for ROUGE. |
| `lib/compress/quality-gate/algorithms/rouge-recall-v1.ts` | Default algorithm. Two-layer: L1 length floor (200 chars OR 1% retention), L2 AND-combine (ROUGE-1 F1 < 0.05 AND top-20 recall < 0.20). |
| `lib/compress/quality-gate/algorithms/index.ts` | `ensureBuiltinGatesRegistered()` idempotent initializer. |
| `lib/compress/quality-gate/evaluate.ts` | `evaluateBlockQuality()` + `evaluateBatchQuality()`. Walks `block.directMessageIds`, extracts text/tool content, runs gate. Try/catch wraps evaluate — on throw → `{ passed: true, metrics: [] }`. |
| `lib/compress/quality-gate/index.ts` | Barrel export. |
| `tests/quality-gate-tokenizer.test.ts` | 33 tests covering empty input, EN length filter, lowercase, digit filter, alphanumeric words, ZH unigrams+bigrams, ZH stopword filter, mixed EN+ZH, opts flags, termFrequency, topKByTf, extractFilePaths, rouge1 recall/precision/F1, topKRecall, jaccard. |
| `tests/quality-gate-registry.test.ts` | 8 tests: getQualityGate for unknown, register+get roundtrip, same-object re-register, same-name+same-version allowed, same-name+different-version throws, listQualityGates sorted, list empty, clear. |
| `tests/quality-gate-rouge-recall-v1.test.ts` | 21 tests: name/version stability, defaults, L1 failures (short/retention/boundary), L2 failures (b27 regression, AND-combine), metrics field coverage, pathCoverage, empty original skip-L2, custom config overrides, invalid config fallback, undefined config, mixed EN+ZH, b27 retention regression. |
| `tests/quality-gate-pipeline-integration.test.ts` | 12 tests covering `evaluateBlockQuality` + `evaluateBatchQuality`: disabled returns null, enabled runs gate, missing block, no direct messages, partial messages, tool-call content extraction, empty entries, all-passing, all-failing, mixed, gate disabled, unknown algorithm. |

### Files modified

| File | Change |
|---|---|
| `lib/config.ts` | Added `QualityGateConfig` interface + `qualityGate` field on `PluginConfig` + default config + `mergeQualityGate()` + clone support. |
| `lib/config-validation.ts` | Added 4 VALID_CONFIG_KEYS: `qualityGate`, `qualityGate.enabled`, `qualityGate.algorithm`, `qualityGate.algorithms`. |
| `lib/compress/pipeline.ts` | `finalizeSession()` now calls `evaluateBatchQuality()` after state save when `entries.length > 0`. Failures → `ctx.logger.warn("Compression quality gate FAILED", ...)`. Non-blocking. |
| `dcp.schema.json` | Added `qualityGate.*` schema with defaults matching code. |
| `README.md` | New "Quality gate" section under "How It Works". New default-config block. v1.13.0 changelog entry. |
| `README.zh-CN.md` | 同步中文翻译。 |
| `AGENTS.md` | Module map updated with `lib/compress/quality-gate/` subtree. Pipeline dataflow line updated. |

### Algorithm decisions

- **Non-blocking**: Model already moved on by the time the gate runs; rejecting the compression would leave state inconsistent. Failures only `logger.warn`.
- **Sync signature today**: Future external-API gates need either type widening or internal wait+timeout wrap. Registry/config shape unchanged.
- **L1 length floor**: 200 chars / 1% retention. Calibrated against 6,913 real-world blocks → 100% recall on catastrophic failures, 0% FPR.
- **L2 AND-combine**: OR would push FPR to 30%+; AND keeps FPR at ~6.6% while still catching the "long enough but content-empty" failure mode.
- **Default `enabled: false`**: One release burn-in before flipping default. Users opt in via config.
- **Hand-rolled tokenizer**: ACP's BPE tokenizer is wrong granularity for ROUGE. English keywords ≥4 chars (filters noise), Chinese unigrams+bigrams (captures meaningful CJK units).
- **Top-K constant K=20**: Matches calibration.
- **Path coverage**: Only reported when original has ≥5 distinct paths (otherwise noise).

### Bug found and fixed during implementation

`rouge-recall-v1.evaluate()` originally computed `retentionPct = originalChars > 0 ? ... : 0` then checked `retentionPct < threshold`. When `originalText` is empty, this always failed L1. Fixed: only check retention when `originalChars > 0` (no signal when original is empty).

## Verification

```
typecheck: PASS
build: PASS (npm run build)
tests: 842/842 PASS  (was 768; +74 new tests)
```

Test breakdown:
- `quality-gate-tokenizer.test.ts`: 33/33
- `quality-gate-registry.test.ts`: 8/8
- `quality-gate-rouge-recall-v1.test.ts`: 21/21
- `quality-gate-pipeline-integration.test.ts`: 12/12
- All other 768 existing tests: unchanged, still passing

## TODO (post-merge)

- Dual-agent code review (lib + tests)
- After one release burn-in, flip `qualityGate.enabled` default to `true`
- Consider future external-API judge algorithm (LLM-as-judge)

## Notes

- Pre-edit hook fires on every comment/docstring. Strategy: keep only (a) public-API contract docs, (b) algorithm/math rationale, (c) bug-case traceability. Drop section dividers and obvious field descriptions. Each hook trigger acknowledged individually with this priority list.
- Tests use `TEST_CONFIG` (lowered L1 thresholds) to isolate Layer 2 logic. The DEFAULT config is tested separately in dedicated tests.
