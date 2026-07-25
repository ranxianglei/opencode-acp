# REQ - Per-Session State Registry (fix subagent over-compression)

- Task ID: `2026-07-24_per-session-state`
- Home Repo: `opencode-acp`
- Created: 2026-07-24
- Status: InProgress
- Priority: P0
- Owner: bot
- References: dog/opencode-acp#33

## 1. Background & Problem Statement

- **Context**: During dual-agent PR review, review SUBAGENT sessions (e.g. `ses_06e3a79b`) over-compressed — they were nudged to compress at only ~20K context (~5% of the 1M window) and compressed content they were actively using.
- **Current behavior (symptom)**: Subagent `modelContextLimit` is `undefined` on every transform (debug log: `filterRecommendedRanges: modelContextLimit unknown` ×7), so the adaptive nudge growth floor falls back to 6000 tokens instead of 50000 → the subagent gets "soft efficiency" nudges at ~5% context.
- **Root cause** (source-confirmed): ACP uses ONE shared `SessionState` singleton (`index.ts:38`) passed to ALL hooks/tools. On every session switch (parent↔subagent interleaving), `ensureSessionInitialized`→`resetSessionState` wipes `modelContextLimit=undefined` (`state.ts:149`). `modelContextLimit` is set ONLY by the `system.transform` hook (`hooks.ts:85-86`), which fires AFTER `messages.transform` (which runs the nudge logic + saves) within a call. So the subagent's 1M is never persisted and never survives to the next transform. Parent works because it is not interleaved/reset.
- **Expected behavior**: Each session keeps its own `SessionState`; `modelContextLimit` set by `system.transform` persists across that session's transforms. Subagent should see the same 50000-token growth floor as the parent.
- **Impact**: Subagents over-compress (lose context they need); also latent concurrency hazards: `isSubAgent`/`manualMode`/compression blocks/nudge anchors get cross-contaminated when the shared singleton is reset on switch.

## 2. Reproduction (if applicable)

- **Environment**: opencode dual-agent review; glm-5.2 (1M context window); ACP v1.13.3.
- **Minimal reproduction steps**:
  1. Run a parent agent that spawns 2 subagent reviewers (interleaving transforms).
  2. Observe ACP debug logs: subagent logs `modelContextLimit unknown`; parent logs `growthThreshold=50000`.
  3. Subagent receives "soft efficiency" nudge at ~5% context and compresses active content.
- **Relevant configuration**: default config; `experimental.allowSubAgents` false.

## 3. Constraints & Non-Goals

- **Constraints**:
  - Backward compatibility: per-session JSON persistence format unchanged (no migration).
  - No `as any`/`@ts-ignore` (AGENTS.md).
  - Internal `dcp` naming preserved (AGENTS.md §2.6).
  - All 591 existing tests must still pass.
- **Non-Goals** (explicitly out of scope for v1):
  - NO "suppress nudge when limit unknown" safety net (user wants to observe whether per-session state alone fixes over-compression).
  - NO `provider.list` lookup (system.transform already supplies the limit once state is isolated).
  - NO full LRU/TTL eviction (soft cap only).
  - NO upstream opencode change (system.transform input lacks `parentSessionID`, but per-session state makes that irrelevant).

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
  - [ ] Each session has its own `SessionState`; switching sessions does not reset another session's `modelContextLimit`.
  - [ ] Subagent's `modelContextLimit` is set by its own `system.transform` and survives to subsequent `messages.transform` calls.
  - [ ] Compression durations still attach to the owning session's blocks (event handler correctness preserved).
- **Performance / Stability**:
  - [ ] Soft cap prevents unbounded registry growth (daemon-safe).
- **Regression**:
  - [ ] All existing tests pass.
  - [ ] New tests cover: per-session isolation of modelContextLimit; registry getOrCreate idempotency; event handler apply across sessions.

## 5. Proposed Approach

- **Affected modules & entry files**:
  - `lib/state/state.ts` — new `SessionStateRegistry`; extract `updatePerTurnState` from `checkSession`.
  - `index.ts` — wire `registry` instead of shared `state`.
  - `lib/hooks.ts` — all 4 handlers resolve state per-call via registry.
  - `lib/compress/types.ts` — add `ToolFactoryContext`.
  - `lib/compress/*.ts` factories — resolve state at `execute` entry.
  - `lib/compress/timing.ts` — unchanged (reads shared `state.compressionTiming`).
- **Risks**: event handler must not iterate-and-consume (destructive); see DESIGN §5.
- **Rollback strategy**: Revert the PR (no persisted-state migration, so fully reversible).
