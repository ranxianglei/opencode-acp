# REQ - Split Protected Ranges + Soften Last-User-Message Protection

- Task ID: `2026-07-27_split-protected-ranges`
- Home Repo: `opencode-acp`
- Created: 2026-07-27
- Status: Done
- Priority: P0
- Owner: awork
- References: dog/opencode-acp#37, PR #207 (growth baseline fix)

## 1. Background & Problem Statement

- **Context**: PR #201 (preserve-recent) added a protected zone (last N messages + last user message) to prevent compressing active work. This introduced two mechanisms: `excludeProtectedRanges` (filter recommendations) and `checkProtectedRange` (hard-reject compress calls covering protected messages).
- **Current behavior (symptom)**: In autonomous agentic sessions (1 user message + many assistant/tool messages), `buildCompressibleRanges` creates ONE giant group because grouping only breaks on user messages — and tool results are `assistant` role in OpenCode. The giant group's endRef falls in the protected zone → `excludeProtectedRanges` removes the ENTIRE range → no recommendations → nudge suppressed → model can never compress. Additionally, `preserveLastUserMessage` causes `checkProtectedRange` to hard-reject any compress covering the last user message, even when the model deliberately wants to compress surrounding tool output.
- **Expected behavior**: (1) Giant groups split at the protected-zone boundary — the unprotected head becomes a recommended range. (2) The last user message is soft-filtered (excluded from compress plan, like Bug 39 protected tools) instead of hard-rejecting the entire compress call.
- **Impact**: Autonomous sessions reaching 500K+ context with zero successful compressions. Model gets no guidance on what to compress.

## 2. Reproduction (if applicable)

- **Environment**: OpenCode with ACP v1.14.1, any model
- **Minimal reproduction steps**:
  1. Send 1 user message
  2. Let the model work autonomously (tool calls, reasoning) until 100+ messages
  3. Observe: no compression nudge fires, context grows unboundedly
- **Root cause confirmed via real session data**: tool results in OpenCode storage are `role="assistant"` (verified from 411-message session: 96 user / 315 assistant; tool results appear as `parts=('tool',)` within assistant messages).

## 3. Constraints & Non-Goals

- **Constraints**:
  - Backward compatibility: `preserveLastUserMessage` config field kept (semantics changes from hard-reject to soft-filter)
  - `lastSegmentSoftBlock: false` must disable ALL protection including the new soft filter
  - Last 20 messages stay hard-protected (active working set)
- **Non-Goals**:
  - First user message protection (handled elsewhere per user)
  - Changing `preserveRecentMessages` / `preserveRecentTokens` behavior
  - Changing `checkProtectedRange` behavior for last-N messages

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
  - [x] `buildCompressibleRanges` splits groups at protected-zone boundary when `protectedZoneRefs` is passed
  - [x] Unprotected head appears as a recommended range; protected tail excluded
  - [x] Last user message soft-filtered from compress plan (not hard-rejected)
  - [x] `checkProtectedRange` no longer rejects based on last user message
  - [x] `lastSegmentSoftBlock: false` disables soft filter too
- **Regression**:
  - [x] All 922 tests pass (920 existing + 2 new)

## 5. Proposed Approach

- **Affected modules & entry files**:
  - `lib/messages/inject/utils.ts` — `buildCompressibleRanges` (add `protectedZoneRefs` param), `computeProtectedRefs` (remove `preserveLastUser`)
  - `lib/messages/inject/inject.ts` — reorder `computeProtectedRefs` before `buildCompressibleRanges`, add `allInProtectedZone` to `nothingToCompress`
  - `lib/compress/pipeline.ts` — `computeProtectedRawIds` (remove `preserveLastUser`)
  - `lib/compress/protected-content.ts` — new `filterLastUserMessage` function
  - `lib/compress/range.ts` — apply `filterLastUserMessage` in pipeline
  - `lib/compress/message.ts` — apply `filterLastUserMessage` in pipeline
  - `lib/compress/status.ts` — pass `protectedRefs` to `buildCompressibleRanges`
- **Risks**: Behavioral change — last user message no longer hard-rejected. Users relying on this will see different behavior (soft filter instead). This is intentional and correct.
- **Rollback strategy**: Revert all commits on this branch.
