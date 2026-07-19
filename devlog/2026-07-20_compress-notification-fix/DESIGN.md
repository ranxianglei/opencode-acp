# DESIGN - Compress notification: chat injection → toast + compress-tool output

- Task ID: `2026-07-20_compress-notification-fix`
- Home Repo: `opencode-acp`
- Created: 2026-07-20
- Status: Accepted

## 1. Problem Statement

- **What problem are we solving?** Compression notifications sent as user-role messages with `ignored: true` parts cause opencode to ship an empty user message to the LLM. Strict providers (zhipuai GLM) return HTTP 400 → session stalls until external recovery.
- **Why now?** 113 occurrences on this machine; user has been chasing "停住" (pause) bug for weeks without root cause. v1.12.7 already fixed the same pattern for debug nudges but left compress notifications untouched. Now confirmed via DB inspection + ACP snapshot analysis.

## 2. Goals & Non-Goals

- **Goals**:
  - Eliminate API 400 from compress notification path
  - Preserve user's ability to see compression happened (via compress tool output + transient toast)
  - Defense in depth: `dropEmptyMessages` catches any future regression where ignored-only messages slip through
- **Non-Goals**:
  - Redesign compress notification UX (deferred)
  - Touch slash-command paths (`/acp stats` etc.) — they're user-initiated, no continuation LLM call, no bug
  - Add LLM stream lifecycle logging to opencode-core (separate concern)

## 3. Current Architecture

```
Model calls compress tool
    │
    ▼
prepareSession → applyCompressionState → saveSessionState
    │
    ▼
finalizeSession
    │
    ├─► evaluateBatchQuality (v1.13.0+, if qualityGate enabled)
    │
    └─► sendCompressNotification(client, ..., entries, contextTokensBefore)
            │
            ├─► if config.pruneNotificationType === "toast"
            │       └─► client.tui.showToast(...)   ✓ safe (transient, no DB write)
            │
            └─► else (chat / undefined / anything else)
                    └─► sendIgnoredMessage(client, sessionId, message, params, logger)
                            │
                            └─► client.session.prompt({ body: { noReply: true, parts: [{ type: "text", text: message, ignored: true }] }})
                                    │
                                    ├─► Creates user-role message in DB
                                    ├─► Part flagged ignored: true
                                    └─► opencode strips ignored parts on next LLM call → empty user msg → API 400
```

Pain points:
- `sendIgnoredMessage` is fundamentally unsafe to call during an active assistant turn
- The `noReply: true` flag is supposed to suppress continuation, but opencode still fires continuation because the compress tool finished (different code path)
- Even if opencode respected `noReply: true` here, the user message is still in DB and may interfere with later turns

## 4. Proposed Architecture

```
Model calls compress tool
    │
    ▼
prepareSession → applyCompressionState → saveSessionState
    │
    ▼
compress tool returns: "Compressed N messages into [Compressed conversation section] (X.K → Y.K, -Z.ZK). Continue your task. Tip: use search_context('keyword') to find compressed content later."
    │   ← Single line, opencode renders attached to compress tool call
    │
    ▼
finalizeSession
    │
    ├─► evaluateBatchQuality (unchanged)
    │
    └─► sendCompressNotification(client, ..., entries, contextTokensBefore)
            │
            ├─► if config.pruneNotification === "off" → return false (unchanged)
            │
            └─► client.tui.showToast({ title: "ACP: Compress Notification", message: shortSummary, duration: 5000 })
                    ← Always toast. No chat injection. No DB write.

dropEmptyMessages (defensive, runs every transform):
    for each message:
        if all parts are (empty text OR ignored: true) → drop
```

Key components:
- **`lib/ui/notification.ts:147-298`** — `sendCompressNotification` simplified to toast-only
- **`lib/compress/range.ts:334`** — compress tool output becomes single-line header
- **`lib/compress/message.ts`** — same change (message-mode compress)
- **`lib/messages/utils.ts:232-247`** — `dropEmptyMessages` defensive check

Data flow:
- Compression info lives in 4 places after this change:
  1. `CompressionBlock` in session state (full summary, topic, ranges, timestamps)
  2. `compress` tool call's `input.summary` / `input.topic` / `input.startId` / `input.endId` (model-visible)
  3. `compress` tool call's `output` (single-line header, user-visible in chat attached to tool call)
  4. Toast popup (transient, immediate user awareness)

## 5. Trade-offs

- **User sees less detail in chat scrollback**: previously the rich progress bar + summary preview lived as a separate user message; now only the single-line header attached to the compress tool call. Trade: the compress tool call's `input` already carries the same info (summary, topic, range) — the notification was redundant decoration.
- **`pruneNotificationType: "chat"` becomes no-op**: existing config values don't break, just degrade to toast. One-time warn log if user has it set explicitly.
- **Slash commands unchanged**: they're user-initiated (no continuation LLM call) so `sendIgnoredMessage` is safe there. Per-call analysis:
  - `/acp context` — user typed, no continuation, safe
  - `/acp stats` — same
  - `/acp help` — same
  - `/acp manual` — same
  - `/acp sweep` — user-triggered compress (manual mode), continuation DOES happen but the next user message will overwrite the empty one
  - `/acp decompress` / `/acp recompress` — same caveat as `/acp sweep`
  
  Wait — `/acp sweep` is user-initiated BUT triggers compression. Let me re-check. If user runs `/acp sweep` and it causes compression, the same bug could fire on the continuation. But the user explicitly initiated it, so the next user message is likely natural input, not a synthetic continuation. **Will verify in implementation.**

## 6. Migration & Compatibility

- No state migration needed — this is a code-only change
- Users on `pruneNotificationType: "chat"` see behavior change (no chat-side notification) but compress tool call still shows in chat
- Users on `pruneNotificationType: "toast"` (already the safe path) see no change
- Version bump: v1.13.1 (patch — bug fix; master is at unpublished v1.13.0 from #166 merge without release)

## 7. Risks & Mitigations

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| `dropEmptyMessages` defensive check drops legitimate messages | Low — only fires when ALL parts are `ignored: true`, which is a synthetic-only signature | Test coverage in `drop-empty-messages.test.ts` |
| Slash command paths still hit the bug | Medium — `/acp sweep` triggers compress | Verify in tests; if affected, route slash command output through toast too |
| Users miss the rich progress bar UX | Low — info still in tool call input | Document in changelog; rich UI rendering can be added later |
