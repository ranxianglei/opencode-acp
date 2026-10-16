# REQ - Large-image context guard (metering + nudge + standing rule)

- Task ID: `2026-10-16_image-context-guard`
- Home Repo: `opencode-acp`
- Created: 2026-10-16
- Status: InProgress
- Priority: P1
- Owner: ranxianglei
- References: https://github.com/ranxianglei/opencode-acp/issues/489

## 1. Background & Problem Statement

- **Context**: A model reads a large image file into context (e.g. a 2.4 MB PNG at
  3298×1642 as a data-URL `file` part). Vision-billed this is ~1.3K tokens, but many
  providers bill the raw base64 as text (~300K+ tokens), instantly blowing the window.
- **Current behavior (symptom)**: ACP's context metering is image-blind. Every counter
  (`getCurrentTokenUsage`, `countAllMessageTokens`, `countMessageCharacters`,
  `estimateContextComposition`) counts only text + tool-output parts; `file` parts
  contribute 0. So nudges never fire for image growth, compressible-range sizing shows
  0 tokens for image messages, and the protected-recent budget can be silently eaten by
  one giant base64 blob (it WAS counted there via `JSON.stringify`, inconsistently with
  every other counter). The session "dies" without any warning or guidance.
- **Expected behavior**: Image parts carry a vision-style token estimate through ALL
  counters; when a large image enters context mid-session, the model immediately gets a
  strong directive to compress older ranges first ("compress before reading images"), and
  the system prompt carries a standing rule so the model proactively makes room before
  reading images.
- **Impact**: Any session that reads large screenshots/diagrams dies unrecoverably from
  the user's perspective until manual intervention; #478's disk archive only preserves
  pixels AFTER folding — it does not prevent the overflow itself.

## 2. Reproduction (if applicable)

- **Environment**: any OpenCode 1.x session with ACP enabled; provider that bills
  base64 as text (or any provider where the image's real cost >> its vision cost).
- **Minimal reproduction steps**:
  1) Let context grow moderately (nudges not yet due).
  2) Read a ≥1 MB image file into context (file part / data URL).
  3) Observe: `acp_status` breakdown shows no image contribution; no nudge fires even
     though the next API call will bill hundreds of K tokens.
- **Relevant configuration**: none required (defaults cover it); new knobs
  `compress.images.largeBytes` (default 524288) and `compress.images.nudge` (default true).

## 3. Constraints & Non-Goals

- **Constraints**:
  - Backward compatibility: persisted state must load old files (new fields optional);
    internal `dcp*` tags untouched; no config key removed/renamed.
  - Performance requirements: per-turn overhead must stay O(messages × parts); no full
    base64 decode (header scan of ≤256 KB only); per-message estimate cached.
  - Resource limits: no new npm dependencies (hand-rolled header parsing only).
- **Non-Goals** (explicitly out of scope):
  - Downscaling/re-encoding images on read (would need host-side image tooling).
  - Changing how OpenCode itself bills/encodes file parts.
  - V2 / billion-context behavior.

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
  - [ ] `parseImageDimensions` extracts width/height from minimal synthetic
    PNG/JPEG/GIF/WebP(VP8|VP8L|VP8X)/BMP headers; returns undefined for garbage/short
    buffers instead of throwing.
  - [ ] Vision formula: 3298×1642 → 1336 tokens (scaled 1568×780 → 4×2 tiles × 167);
    unknown-dims ≥256 KB → capped 2672; unknown-dims <256 KB → base64/4 proxy.
  - [ ] `getCurrentTokenUsage` includes pending-image delta for file parts arriving after
    the last assistant message with token data; compaction-epoch semantics unchanged
    (still returns 0 before compaction epoch).
  - [ ] `countMessageCharacters` includes image-equivalent chars so the recommend-side
    and execute-side min-size counters stay aligned (#359 parity invariant).
  - [ ] `estimateContextComposition` reports an `imageTokens` category included in total.
  - [ ] Large image entering context emits exactly ONE notice per distinct image
    (dedup by message+part+payload hash); notice suppressed on turns where a compress
    already happened; re-fires on a later plain turn while the image persists.
  - [ ] System prompt contains the IMAGE HANDLING standing rule iff
    `compress.images.nudge !== false`.
- **Performance / Stability**:
  - [ ] No per-turn hashing of full payloads (slot-prefix prefilter before payload hash);
    estimate cache bounded (512 entries).
- **Regression**:
  - [ ] New/modified test cases added to test suite and passing
    (tests/image-tokens.test.ts, tests/image-metering.test.ts, tests/image-nudge.test.ts,
    extended tests/config-validation.test.ts).

## 5. Proposed Approach (optional)

- **Affected modules & entry files**:
  - NEW `lib/compress/image-tokens.ts` (dimension parsing + vision-token estimation + cache)
  - NEW `lib/messages/large-images.ts` (surge detection + dedup + notice formatting)
  - `lib/token-utils.ts`, `lib/messages/inject/utils.ts`, `lib/messages/inject/inject.ts`
    (metering + nudge wiring), `lib/compress/status.ts` (acp_status image category),
    `lib/config.ts`, `lib/config-validation.ts`, `dcp.schema.json` (new config keys),
    `lib/state/{types,state,persistence}.ts` (persisted dedup index),
    `lib/prompts/{index.ts,extensions/system.ts}` + `lib/hooks.ts` (standing rule),
    docs (CONFIGURATION.md/.zh-CN.md, README.md/.zh-CN.md).
- **Risks**: counters' numeric values change for sessions containing images (intended —
  they were wrong before); visible-segment ranking no longer marks image-only messages as
  tool segments; acp_status breakdown line gains an always-shown images category.
- **Rollback strategy**: single revert of the PR branch; persisted state field is
  optional so old/new versions interoperate both directions.
