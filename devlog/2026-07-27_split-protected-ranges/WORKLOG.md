# WORKLOG - Split Protected Ranges + Soften Last-User-Message Protection

- Task ID: `2026-07-27_split-protected-ranges`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-07-27 13:30

## 1. Summary

- **What was done**: Two changes — (1) `buildCompressibleRanges` now splits giant groups at the protected-zone boundary so the unprotected head survives as a recommended range; (2) `preserveLastUserMessage` moved from hard-reject (`checkProtectedRange` throw) to soft-filter (`filterLastUserMessage` excludes from compress plan, like Bug 39).
- **Why**: In autonomous agentic sessions (1 user message + many assistant messages), the giant group was entirely filtered out by `excludeProtectedRanges`, leaving zero recommendations and suppressing the nudge — the model could never compress. The hard-reject on last user message additionally blocked deliberate compressions.
- **Behavior / compatibility changes**: Yes — `preserveLastUserMessage` semantics change from hard-reject to soft-filter. Config field kept; `lastSegmentSoftBlock: false` disables all protection including the new soft filter.
- **Risk level**: Medium

## 2. Change Log

### Key Files

- `lib/messages/inject/utils.ts` — `buildCompressibleRanges`: added `protectedZoneRefs` param; grouping loop skips protected messages (closes current group before skipping). `computeProtectedRefs`: removed `preserveLastUser` block (moved to pipeline).
- `lib/messages/inject/inject.ts` — moved `computeProtectedRefs` before `buildCompressibleRanges`; added `allInProtectedZone` condition to `nothingToCompress` (covers case where all messages are protected → no compressible ranges at all).
- `lib/compress/pipeline.ts` — `computeProtectedRawIds`: removed `preserveLastUser` block.
- `lib/compress/protected-content.ts` — new `filterLastUserMessage` function (follows Bug 39 `filterProtectedToolMessages` pattern; respects `lastSegmentSoftBlock` and `preserveLastUserMessage`).
- `lib/compress/range.ts` — applied `filterLastUserMessage` after `filterProtectedToolMessages` in plan pipeline.
- `lib/compress/message.ts` — applied `filterLastUserMessage` after `resolveMessages`; updated `plans` → `filteredPlans` references.
- `lib/compress/status.ts` — both `buildCompressibleRanges` call sites now compute `protectedRefs` and pass it; defensive `ctx.config?.compress` guard for test compatibility.

## 3. Design & Implementation Notes

- **Change 1 (group splitting)**: The protected zone is always a contiguous tail. When `buildCompressibleRanges` encounters a message in `protectedZoneRefs`, it closes the current group (pushing the unprotected head) and skips the protected message. This naturally splits the giant group with correct `count`/`tokens`/`toolPct`/`textPct` for the head — no post-hoc recalculation needed.
- **Change 2 (soft filter)**: `filterLastUserMessage` finds the last real user message (scan backward, skip synthetic/ignored/pruned) and removes it from `selection.messageIds` if present. The user message survives in visible context; surrounding tool output compresses normally. Consistent with Bug 39's `filterProtectedToolMessages`.
- **`nothingToCompress` fix**: Added `allInProtectedZone = protectedRefs.size > 0 && unprotectedCompressible.length === 0` to cover the new case where all messages are in the protected zone (group splitting produces zero compressible ranges). Without this, the nudge would fire with no recommendations.

## 4. Testing & Verification

### Test Coverage

- New test files: none (added to existing files)
- New/modified test files:
  - `tests/preserve-recent.test.ts` — 2 new tests (group splitting + all-protected), 1 updated test (last user message no longer in hard-protected set)
  - `tests/soft-block.test.ts` — 1 updated test (last user message soft-filtered, not hard-rejected)
- Test count: 922 total, 922 pass, 0 fail
- Key scenarios verified:
  - Giant group (1 user + 49 assistant) splits at protected boundary → unprotected head recommended
  - All messages in protected zone → no compressible ranges (short session protection)
  - Last user message soft-filtered from compress plan → compress succeeds, user message survives
  - `lastSegmentSoftBlock: false` disables soft filter (backward compat)

### Results

- **PASS**: typecheck 0 errors, build success, 922/922 tests pass

## 5. Risk Assessment & Rollback

- **Risk points**: Behavioral change in `preserveLastUserMessage` (hard→soft). If any user workflow depends on the hard rejection, they'll see compressions proceed where they previously failed. This is the intended fix.
- **Rollback method**: Revert all commits on branch `2026-07-27_split-protected-ranges`.
- **Compatibility notes**: Config schema unchanged. `preserveLastUserMessage` field kept with new semantics. Persisted state format unchanged.

## 6. Follow-ups

- [ ] Deploy + test in real opencode session to verify autonomous agentic scenario
- [ ] Consider adding per-message grouping breaks (every N messages) as a secondary defense against giant groups
