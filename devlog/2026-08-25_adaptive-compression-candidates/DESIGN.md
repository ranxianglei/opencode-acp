# DESIGN - Adaptive Compression Candidates

- Task ID: `2026-08-25_adaptive-compression-candidates`
- Home Repo: `opencode-acp`
- Created: 2026-08-25
- Status: Accepted

## 1. Problem Statement

ACP's current contiguous recommendations are too coarse when a large stale
artifact sits inside useful surrounding reasoning. Directly porting DCP message
mode would introduce per-message block proliferation and a new tiering/state
surface. The upgrade should improve target selection while preserving ACP's
proven range executor.

## 2. Goals & Non-Goals

- **Goals**:
    - Recommend complete large tool transactions or large plain messages as
      micro-ranges.
    - Recommend contiguous residual historical units as episode ranges.
    - Make displayed candidates executable together without overlap errors.
    - Share the candidate planner between nudges and default status output.
    - Reuse exact executor filtering and character admission semantics.
- **Non-Goals**:
    - Automatic compression, new tools, new config, persisted candidate IDs, or
      artifact capsules.
    - Changing arbitrary free-form range support or compression state.

## 3. Current Architecture (if applicable)

- **How it works today**:
    - `hooks.ts` filters, assigns refs, prunes active blocks, and invokes
      `injectCompressNudges`.
    - `inject.ts` groups visible messages using approximate token accounting and
      renders ranges.
    - `range.ts` independently resolves boundaries, closes tool pairs, filters
      protected content, checks character minimums, handles phantom plans, and
      mutates state.
    - `status.ts` has a separate range renderer with different filtering.
- **Pain points**:
    - Recommendation and execution selection can drift.
    - Status and nudge output can disagree.
    - Broad groups hide large independent artifacts.

## 4. Proposed Architecture

- **Overview**:

    ```text
    hook/status message snapshot
            |
            v
    candidate planner -- shared executable range-selection helper --> executor
            |                                                        |
            +--> bounded nudge/status rendering                    +--> state
    ```

- **Key components**:
    - `range-utils.ts`: pure shared resolution/filter/admission helper used by
      both the executor and planner validation.
    - `messages/inject/candidates.ts`: pure atomic-unit, micro/episode, ranking,
      validation, and bounded-result planner.
    - Nudge/status adapters: presentation only; no duplicate selection logic.
- **Data flow**:
    1. Use the post-filter visible message snapshot and current `SessionState`.
    2. Build transitive tool-pair-safe atomic units.
    3. Exclude synthetic, ignored, active-compressed, protected, recent, and
       latest-user content using executor-equivalent semantics.
    4. Promote large units to micro candidates, aggregate smaller residual units
       into episodes, validate each candidate, rank, and cap at 12.
    5. Render the same result in nudges and default status.
- **API / interface changes**:
    - Internal pure types for candidate categories, candidates, planner input,
      diagnostics, and executable selections.
    - `acp_status` accepts `view:"candidates"`; default uncompressed/overview
      behavior uses it while `view:"ranges"` remains a diagnostic view.
    - No public compression schema or persisted state change.

## 5. Design Decisions & Rationale

| Decision         | Options Considered                                              | Chosen                                               | Why                                                                       |
| ---------------- | --------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------- |
| Selection model  | DCP message mode, new artifact blocks, adaptive existing ranges | Adaptive existing ranges                             | Precise recommendations with no state migration or new executor           |
| Pair handling    | Duplicate local logic, no closure, shared helper                | Shared executor helper plus transitive planner units | Prevents recommendation/execution drift and provider-invalid orphan pairs |
| Status UX        | Preserve raw ranges only, new opt-in view, candidates default   | Candidates default; raw ranges retained              | Smooth upgrade with one source of truth while preserving diagnostics      |
| Size threshold   | New candidate threshold, approximate tokens, existing minimum   | Existing `minCompressRange` characters               | Matches executor admission and avoids configuration proliferation         |
| Planner failure  | Block request, fallback broad ranges, omit guidance             | Fail closed                                          | Candidate guidance is advisory and must never block the model             |
| Candidate output | Unlimited, chronological only, bounded ranked list              | Ranked maximum of 12                                 | Candidate text itself consumes context and needs deterministic bounds     |

## 6. Impact Analysis

- **Backward compatibility**: Existing range calls, tool schema, free-form ranges,
  state JSON, block lineage, retrieval, decompression, and tiers remain unchanged.
- **Performance**: Planning is bounded by the current visible message count and
  tool parts. Candidate output is capped at 12. No LLM or network call is added.
- **Security**: Protected tools/files and current-context protections remain
  executor authority; planner validation fails closed if selection differs.
- **Dependencies** (new packages required): None.

## 7. Migration Plan (if applicable)

- **Steps**:
    1. Add devlog and pure executor parity tests.
    2. Extract the shared helper without changing executor behavior.
    3. Add and test the pure planner.
    4. Integrate status, then nudge rendering.
    5. Run full unit, property, build, and E2E validation.
- **Feature flags / gradual rollout**: None. The change is advisory and can be
  rolled back by removing planner presentation while retaining the executor.

## 8. Open Questions

- None for this phase. Tool-output-only capsules remain a separate future design.
