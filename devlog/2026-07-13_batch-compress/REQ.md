# REQ - Batch Compress Interface (Multi-Topic)

- Task ID: `2026-07-13_batch-compress`
- Home Repo: `opencode-acp`
- Created: 2026-07-13
- Status: InProgress
- Priority: P1
- Owner: sisyphus
- References: dog/opencode-acp#26

## 1. Background & Problem Statement

- **Context**: The `compress` tool (range mode) accepts a single `topic` + a `content` array of ranges per call. When the model needs to compress several unrelated conversation phases in one go, it must either (a) issue multiple compress calls (wasteful, and each call re-runs prepare/finalize), or (b) force everything under one inaccurate topic label.
- **Current behavior (symptom)**: One call = one topic (with N ranges). No rate-limit against the model calling compress repeatedly with tiny batches ("frequent compression" thrash).
- **Expected behavior**:
  1. One call = multiple topics, each topic grouping its own ranges: `{ topics: [{ topic, content: [{startId,endId,summary}] }, ...] }`.
  2. A cooldown rate-limits successive compress calls: block if called again before `cooldownOutputs` (default 2) new assistant outputs have appeared. Exemptions: first compress, manual `/acp compress`, and overMaxLimit (overflow priority).
  3. Tool description, system prompt format extension, and the per-5%-injection nudges all updated to teach the new multi-topic format and to emphasize "compress everything in one call".
  4. Backward compatibility: legacy single-topic `{topic, content}` still accepted (wrapped internally).
- **Impact**: Fewer compress round-trips, more accurate per-topic summaries, less model thrash from repeated compress calls.

## 2. Constraints & Non-Goals

- **Constraints**:
  - Backward compatibility: persisted state format additions must be optional (old state files load cleanly). Legacy `{topic, content}` tool args still accepted. Internal `dcp` tags/naming unchanged.
  - No new dependencies. TypeScript strict, no `as any`/`@ts-ignore`.
  - Per-summary char cap stays at `maxSummaryLengthHard` (default 10000); batch multiplies total budget naturally (N summaries × cap). GC old-gen truncation (>3000) unchanged.
  - Message mode already supports per-entry topic — NOT changed structurally (only gets the cooldown).
- **Non-Goals**: Changing block allocation (one range → one block, shared runId per call), GC, prune, recap injection, decompress.

## 3. Acceptance Criteria (must be testable)

- [ ] `compress({topics:[{topic,content:[...]},{topic,content:[...]}]})` creates blocks, each tagged with its own topic, sharing one runId.
- [ ] Legacy `compress({topic,content:[...]})` still works (wrapped to single-topic batch).
- [ ] Ranges from different topics are globally overlap-checked (no double-compressing same messages).
- [ ] Cooldown blocks a second compress when fewer than `cooldownOutputs` new assistant messages exist; allows after threshold met; first compress / manual / overMaxLimit are exempt.
- [ ] `cooldownOutputs` persisted across restart (backward-compat: old files without it load fine).
- [ ] Tool description + format extension + 3 nudges show the `topics` format and one-call guidance.
- [ ] `npm run typecheck`, `npm test`, `npm run build` all pass.
- [ ] New `tests/compress-batch.test.ts` covers multi-topic, legacy shim, overlap across topics, and cooldown.

## 4. Proposed Approach

- **Affected modules**: `lib/compress/{types,range,range-utils,pipeline,message}.ts`, `lib/config.ts`, `lib/config-validation.ts`, `dcp.schema.json`, `lib/state/{types,state,persistence}.ts`, `lib/prompts/{compress-range,extensions/tool,context-limit-nudge,turn-nudge,iteration-nudge}.ts`, `lib/messages/inject/inject.ts`. See DESIGN.md.
- **Risks**: Schema validation coupling (mitigated: schema accepts both forms); cooldown breaking multi-compress tests (mitigated: cooldown optional + undefined-disables).
- **Rollback strategy**: Revert the branch; no persisted-state destructive migration (additive only).
