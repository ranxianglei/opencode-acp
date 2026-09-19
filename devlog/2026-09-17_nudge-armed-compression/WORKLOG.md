# WORKLOG - Nudge-armed compression

- Task ID: `2026-09-17_nudge-armed-compression`
- Status: Complete
- Updated: 2026-09-17

## Summary

Measured live tool-part durations and separated ACP execution from model orchestration. Added nudge-time arming through the existing validator, optional status guidance, larger local ranges, and earlier growth thresholds.

## Evidence

- `acp_status` tool part: 307 ms.
- `compress` tool part: 308 ms; core state replacement: 5 ms.
- Surrounding inference turns: 15–23 seconds.
- First post-compression cold prefill at 193K tokens: 208 seconds.

## Files

- `lib/messages/inject/inject.ts` — nudge-time plan arming and guidance.
- `lib/compress/smart-plan.ts` — shared minimal context and recovery guidance.
- `lib/compress/range.ts` — guarded error guidance.
- `tests/inject.test.ts` — multi-turn protected-tail regression.
- User config outside repository — larger range and earlier thresholds.

## Verification

- Regression fails when nudge-time arming is removed and passes when restored.
- Targeted smart-plan/injection/range/status tests: 112/112 pass.
- Full suite: 1237/1237 pass.
- `npm run typecheck`: pass.
- `npm run build`: pass; local `dist/index.js` rebuilt.
- Changed-file Prettier check and `git diff --check`: pass.
- Repository-wide Prettier remains red on 444 pre-existing legacy files; no changed file fails.
- Two independent reviews requested changes; all reported blockers were patched. Both final re-reviews approved with no remaining blockers.

## Review fixes

- Raw-message smart-plan enforcement no longer blocks tier-2/3 block compression.
- A mandatory plan with no safe candidate suppresses contradictory compression guidance.
- Adjacent safe artificial segments merge for the 80K floor without crossing protected gaps.
- Provider/model overrides are resolved before status and execution policy checks.
- Visible snapshots are recorded only when enabled and cleared on idle/deleted lifecycle events.
- Oldest safe spans are selected first for better prefix-cache locality.

## Post-compaction hardening

- Preserved message aliases and their high-water mark across native compaction.
- Added automatic repair for persisted mixed alias epochs and block boundaries.
- Prevented range grouping from crossing a backwards/non-contiguous alias boundary.
- Sized canonical plans toward the amount needed to return below the native-compaction watermark.
- Kept mandatory single-plan policy scoped to raw messages; tier block compression remains available.
- Hardened the local native-compaction validator against serialized `[Assistant tool call]` / `[Tool result]` text and plain (non-Markdown) canonical headings.
