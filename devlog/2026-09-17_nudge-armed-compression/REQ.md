# REQ - Nudge-armed compression

- Task ID: `2026-09-17_nudge-armed-compression`
- Home Repo: `opencode-acp`
- Created: 2026-09-17
- Status: Complete
- Priority: P1
- Owner: Codex
- References: issue #436

## Background

With `smartPlanRequired`, a nudge lists ranges but the model must spend another inference turn calling `acp_status` before compression. Large local-model contexts make that redundant round trip expensive, while ACP execution is sub-second. Small compressions also force cold prefill too frequently.

Expected behavior: a nudge arms the same validated canonical range directly; `acp_status` remains optional for inspection or refresh; local policy requires larger ranges and nudges earlier.

## Constraints

- Preserve structure-version, visibility, protected-content, TTL, and exact-range validation.
- Preserve `acp_status` and manual status-driven arming.
- Do not change persisted state or weaken summary quality gates.

## Acceptance criteria

- [x] A valid nudge arms exactly one model-visible smart plan.
- [x] Nudge text contains its exact range and says status is optional.
- [x] Stale or altered plans remain rejected.
- [x] Multi-turn protected-tail regression passes.
- [x] Typecheck, tests, build, and two independent reviews pass.
