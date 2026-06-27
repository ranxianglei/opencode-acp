# WORKLOG - Skip message transform for OpenCode internal agents (title/summary/compaction)

- Task ID: `2026-06-27_title-gen-skip`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-06-27 03:40

## 1. Summary

- **What was done**: Added an internal-agent guard at the top of
  `createChatMessageTransformHandler` so that OpenCode's built-in `title`,
  `summary`, and `compaction` agent requests are returned early without
  mutation. Detection uses the last user message's `info.agent` field.
- **Why**: The system-prompt handler already skipped these via
  `INTERNAL_AGENT_SIGNATURES`, but the message-transform handler ran its full
  pipeline on them, corrupting both the small internal request (mNNNN/nudge
  injection) and shared session state (`countTurns` over `currentTurn`,
  `assignMessageRefs` over the ref map). This broke session title generation
  whenever ACP was loaded (upstream issue #15).
- **Behavior / compatibility changes**: No. Persisted state format, exported
  APIs, and internal `dcp` tags are unchanged. Only runtime skip behavior for
  three hidden OpenCode agent IDs is added.
- **Risk level**: Low

## 2. Change Log

### Key Files

- `lib/hooks.ts` — added `INTERNAL_AGENT_NAMES` set + `isInternalAgentRequest()`
  helper; added early-return guard before `checkSession` in
  `createChatMessageTransformHandler`. Guard placed before `checkSession`
  specifically to prevent `countTurns` running on the internal request's
  message set.
- `tests/e2e-message-transform.test.ts` — extended `makeUserMessage` with an
  optional `agent` param; added 3 tests (title skip, summary+compaction skip,
  build still processed).

## 3. Design & Implementation Notes

- **Entry point**: `createChatMessageTransformHandler` (lib/hooks.ts).
- **Detection signal**: `getLastUserMessage(messages)?.info.agent` against
  `{title, summary, compaction}`. These IDs are confirmed in OpenCode source
  (`packages/core/src/plugin/agent.ts`) as hidden primary-mode agents whose
  system prompts match `INTERNAL_AGENT_SIGNATURES`.
- **Why before checkSession**: `checkSession` → `countTurns(state, messages)`
  would overwrite `state.currentTurn` using the internal request's tiny message
  set. The guard must precede it to avoid state corruption.
- **Defence in depth**: The system-prompt handler's signature-based detection
  remains as a second layer; the two lists are cross-referenced in comments.

## 4. Testing & Verification

### Build & Test Commands

```sh
npm run typecheck   # PASS (tsc --noEmit, clean)
npm run build       # PASS (dist/index.js 303.99 KB)
node --import tsx --test tests/*.test.ts   # 389 pass, 0 fail
```

### Test Coverage

- New tests: 3 in `tests/e2e-message-transform.test.ts`
  - title agent request skipped, messages + state unmutated
  - summary & compaction agent requests skipped
  - build agent request still fully processed (no false positives)
- Test count: 389 total, 389 pass, 0 fail (baseline 386 → +3)

### Results

- **PASS**

## 5. Risk Assessment & Rollback

- **Risk points**: Detector relies on the `agent` field naming. If a future
  OpenCode version renames internal agents, detection would miss — but the
  system-prompt-signature layer still catches them.
- **Rollback method**: revert the single commit.
- **Compatibility notes**: No data format / config schema changes.

## 6. Follow-ups (optional)

- [ ] Consider unifying `INTERNAL_AGENT_NAMES` and `INTERNAL_AGENT_SIGNATURES`
      into a single source of truth if a third detection site is ever needed.
