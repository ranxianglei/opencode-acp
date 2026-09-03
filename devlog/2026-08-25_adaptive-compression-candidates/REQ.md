# REQ - Adaptive Compression Candidates

- Task ID: `2026-08-25_adaptive-compression-candidates`
- Home Repo: `opencode-acp`
- Created: 2026-08-25
- Status: Completed
- Priority: P1
- Owner: OpenCode
- References: `docs/superpowers/specs/2026-08-25-adaptive-compression-candidates-design.md`

## 1. Background & Problem Statement

- **Context**: ACP currently recommends contiguous compression ranges while its
  range executor, state model, and retrieval lifecycle are already mature.
- **Current behavior (symptom)**: A large stale tool artifact inside useful
  reasoning is recommended only as part of a broad range, so the model must
  either discard useful context or retain an expensive artifact.
- **Expected behavior**: ACP recommends executable, non-overlapping micro-ranges
  for large independent messages/tool transactions and episode ranges for
  adjacent smaller historical units.
- **Impact**: Better compression selection without changing persisted state,
  the `compress` tool contract, or compression execution semantics.
- **Post-compression performance follow-up**: Once a block exists, OpenCode
  still provides the raw transcript to every transform. Avoid reprocessing
  hidden raw content where the downstream operation already ignores it, and do
  not plan candidates on turns that cannot emit a nudge.

## 2. Reproduction (if applicable)

- **Environment**:
    - Node: 22+
    - OS/Arch: Linux
- **Minimal reproduction steps**:
    1. Build a session containing useful reasoning around a large stale tool
       output.
    2. Allow ACP to inject a compression recommendation.
    3. Observe that the recommendation is a broad contiguous range rather than
       the independent artifact transaction.
- **Relevant configuration**: Existing `compress.minCompressRange` and
  protection settings; no new configuration is introduced.

## 3. Constraints & Non-Goals

- **Constraints**:
    - Backward compatibility: preserve the existing range tool, free-form ranges,
      schema, block state, persistence, retrieval, decompression, quality gate,
      and T1/T2/T3 behavior.
    - Performance requirements: deterministic linear-ish planning over the visible
      message snapshot; bounded output of at most 12 candidates.
    - Resource limits: candidate text must remain bounded and fail closed on
      planner errors.
- **Non-Goals** (explicitly out of scope):
    - Automatic compression.
    - A message/range mode toggle or new compression tool.
    - Tool-output-only artifact capsules or part-level persisted coverage.
    - Arbitrary non-contiguous source sets.
    - Candidate persistence or configuration migration.

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
    - [x] Large plain messages and complete tool transactions produce micro-range
          candidates when they meet `minCompressRange`.
    - [x] Adjacent smaller eligible units produce one episode candidate when their
          aggregate retained characters meet `minCompressRange`.
    - [x] Candidates are pair-safe, non-overlapping, deterministic, bounded to 12,
          and survive executor-equivalent filters.
    - [x] Nudge and default `acp_status` candidate output share one planner and
          ordering.
- **Performance / Stability**:
    - [x] Planner failures omit candidate guidance without blocking a request.
    - [x] Existing compression state and arbitrary range execution remain intact.
    - [x] Status remains read-only and candidate planning does not persist state.
- **Regression**:
    - [x] New/modified test cases added to test suite and passing.
    - [x] Existing unit, property, build, and E2E suites pass.
    - [x] No-nudge turns do not invoke candidate planning.
    - [x] Unchanged active block membership does not rebuild every tracked message.

## 5. Proposed Approach (optional)

- **Affected modules & entry files**:
    - `lib/compress/range-utils.ts` and `lib/compress/range.ts` for shared
      executor-equivalent selection semantics.
    - `lib/messages/inject/candidates.ts` for the pure planner.
    - `lib/messages/inject/inject.ts`, `lib/hooks.ts`, and `lib/compress/status.ts`
      for integration.
    - `tests/` and `scripts/e2e/` for focused and end-to-end coverage.
- **Risks**: Recommendation/executor drift, tool-pair boundary mistakes,
  nudge baseline regressions, status projection differences, and prompt growth.
- **Rollback strategy**: Revert the candidate planner integration while leaving
  the existing range executor and persisted state format unchanged.
