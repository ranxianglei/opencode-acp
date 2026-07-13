# WORKLOG - Batch Compress Interface (Multi-Topic)

- Task ID: `2026-07-13_batch-compress`
- References: dog/opencode-acp#26
- Status: Implemented — typecheck, 646 tests, build all pass.

## Summary

Added a batch interface to the `compress` tool: one call now accepts multiple topics, each grouping its own ranges. Introduced a `cooldownOutputs` rate-limit that blocks repeated compress calls until enough new assistant outputs appear. Updated the tool description, system-prompt format extension, and the three injection nudges to teach the `topics` format and emphasize compressing everything in one call. Legacy single-topic `{topic, content}` args remain accepted via an internal backward-compat shim.

## Changes by Layer

### State (`lib/state/`)

- `types.ts`: `Nudges` gained `lastCompressAssistantCount: number | undefined` — records the assistant-output count at the last successful compress; used by the cooldown check.
- `state.ts`: `createInitialState`, `resetSessionState`, and the persisted-state restore path all initialize/carry the new field.
- `utils.ts`: `resetOnCompaction` (third `Nudges` construction site) initializes it too — typecheck caught this.
- `persistence.ts`: `PersistedNudges` gained the optional field; `saveSessionState` writes it. Old state files without the field load cleanly (`undefined` → cooldown disabled until first success).

### Config (`lib/config.ts`, `lib/config-validation.ts`, `dcp.schema.json`)

- `CompressConfig.cooldownOutputs?: number` (optional; default `2` in `DEFAULT_CONFIG`).
- `mergeCompress` propagates the override-or-base value.
- `config-validation.ts`: `compress.cooldownOutputs` added to `VALID_CONFIG_KEYS` with a `typeof === "number" && >= 0` check.
- `dcp.schema.json`: `cooldownOutputs` property (number, min 0, default 2) added to `compress`.

### Compress subsystem (`lib/compress/`)

- `types.ts`: new `CompressBatchTopic { topic: string; content: CompressRangeEntry[] }`; `ResolvedRangeCompression` gained `topic: string`.
- `range-utils.ts`: `resolveRanges` stamps `plan.topic = args.topic`; `validateNonOverlapping` error now names the offending topics. The existing "Overlapping ranges cannot be compressed in the same batch" phrase is retained so existing tests still match.
- `pipeline.ts`: four new helpers — `countAssistantOutputs`, `isOverMaxContextLimit` (mirrors `inject/utils` logic, returns `false` when `modelContextLimit` is unset to avoid a compress→inject reverse dependency), `checkCompressCooldown` (early-returns on disabled/manual/first-call/over-limit; else throws a "Frequent compression blocked" error), `recordCompressSuccess` (writes the assistant-output count on success).
- `range.ts`: `buildSchema` rewritten — `topics` is the new primary input (array of `{topic, content}`); legacy `topic`/`content` still accepted; `summaryMaxChars` retained. `normalizeTopics()` wraps a legacy single-topic call into a one-element `topics` array, or throws guidance if neither shape is present. `execute` flow: normalize → per-topic `validateArgs` → summary-length loop → `prepareSession` → `checkCompressCooldown` → `flatMap` resolve all topics → global `validateNonOverlapping` → (unchanged filter/min-range/prepare loop) → single `allocateRunId` → per-plan `applyCompressionState` (carrying `topic` + `batchTopic`) → `recordCompressSuccess` → `finalizeSession`. All blocks in one call share one `runId`.
- `message.ts`: added `checkCompressCooldown` after `prepareSession` and `recordCompressSuccess` before `finalizeSession`. Schema unchanged (message mode already had per-entry topic).

### Prompts (`lib/prompts/`)

- `compress-range.ts`: "BATCHING" section rewritten to "BATCHING — MULTIPLE TOPICS IN ONE CALL" with a `topics` JSON example and the rules (one topic per concern, all ready ranges in one call, don't split, global overlap, legacy accepted).
- `extensions/tool.ts`: `RANGE_FORMAT_EXTENSION` now shows the `topics` array JSON.
- `context-limit-nudge.ts`, `turn-nudge.ts`, `iteration-nudge.ts`: JSON examples switched to `topics`; "add more `topics` entries" guidance.
- `messages/inject/inject.ts`: the one-call hint at the injection site mentions `topics`.

### Tests

- `tests/compress-batch.test.ts` (new, 8 tests): multi-topic (2 blocks, own topics, shared runId), legacy shim, cross-topic overlap rejected, cooldown blocks, cooldown allows, manual bypass, cooldown disabled, missing-fields guidance.
- `tests/prompts.test.ts`: one assertion updated (`content` array → `topics`).

## Verification

- `npm run typecheck` — clean.
- `npm test` — 646 pass / 0 fail (638 existing + 8 new).
- `npm run build` — succeeds (`dist/index.js` 389 KB).

## Notes / Gotchas

- Existing test `buildConfig()` factories omit `cooldownOutputs`, so at runtime it is `undefined` and the cooldown helper early-returns — this is why no existing multi-compress test needed changes.
- In the new cooldown tests, `state.sessionId` is pinned to the test session ID before calling `execute`, so `ensureSessionInitialized` (which resets state on a sessionId mismatch) becomes a no-op and the manually-set `nudges`/`manualMode` fields survive.
- Backticks inside the nudge template literals had to be escaped (`\``) — an unescaped backtick trips TS1005.
