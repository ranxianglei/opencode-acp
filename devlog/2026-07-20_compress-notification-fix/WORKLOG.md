# WORKLOG — Compress Notification Freeze Fix

## Goal

Fix issue #20: repeated session freezes after `compress` tool calls. Root cause: ACP injects a user-role notification via `sendIgnoredMessage`; opencode strips the `ignored: true` part, leaving an empty user message; provider (zhipuai-lb) rejects with HTTP 400 code 1214 (`"messages 参数非法"`), `isRetryable: false`, freezing the session.

## Timeline

### Phase 1 — Triage (2026-07-19)

- User reported 3 awork-web URLs showing "opencode pause" symptoms.
- Used `awork-floor` to fetch the messages; cross-referenced with `~/.config/opencode/logs/acp/daily/2026-07-19.log` (timestamps mislabeled CST as UTC).
- Confirmed those 3 specific incidents were NOT ACP-caused (LLM stream died mid-response; ACP idle 2:17 gap in context snapshots).
- User asked to check opencode logs: `~/.local/share/opencode/log/` only retained 10 most recent files; older logs deleted. Logs lack plugin hook timing and LLM stream lifecycle events.
- Found legacy `~/.local/share/opencode/dcp-timing.log` (abandoned 2026-05-18). May 17 entries showed 22-50s hook times — this was Bug 33 (slow Anthropic tokenizer), already fixed in `lib/state/tool-cache.ts` (replaced with `text.length/4`).

### Phase 2 — Root cause discovery (2026-07-19)

- User caught a fresh failure: `msg_f7b43bb88001fjlo3i4onSu7L1` (empty assistant message at 2026-07-19 16:44:24 CST).
- sqlite query against `~/.local/share/opencode/opencode.db` revealed `$.error.data.message = "messages 参数非法。请检查文档。"` statusCode 400 isRetryable false.
- Searched error table: **113 total errors** with same code across all sessions; **8 in session `ses_08f2d5014ffebnUe5mDXKnXEuM` alone** (3,156 messages, 2026-06-25 to 2026-07-19).
- Every error has `role: assistant` (failed continuation after compress).
- Every error is preceded by a user message 9-189ms earlier containing ACP notification text (`"▣ ACP | Context X.K → Y.K...Compression #N → bN..."`).
- Traced to `sendIgnoredMessage` call at `lib/ui/notification.ts:296`.
- Confirmed mechanism: opencode serializes messages for LLM, strips `ignored: true` parts → empty user message → zhipuai-lb rejects.

### Phase 3 — Why previous fix didn't catch this

- v1.12.7 (devlog `2026-07-15_debug-no-phantom-turn/`) fixed the same pattern but only for the `debugNotify` callback path.
- `sendIgnoredMessage` was retained because "other notification paths still use it" — those other paths include `sendCompressNotification`, which is now biting.
- Slash command paths (`/acp stats`, `/acp context`, etc.) also use `sendIgnoredMessage` but are user-initiated (no continuation LLM call), so they're safe.

### Phase 4 — Fix design (2026-07-19)

User directive (verbatim): "可以！如果是这样是不是结果只显示一个头即可？详情不需要了 ui 渲染的时候实际上可以渲染成任何样子 开搞吧"

Approved two-layer fix:

1. **`lib/ui/notification.ts`** — Always toast; remove `sendIgnoredMessage` branch.
2. **`lib/messages/utils.ts`** — Extend `dropEmptyMessages` to treat `ignored: true` text parts as discardable (defense in depth).

Compress tool output already returns a minimal one-line header (`lib/compress/range.ts:334`) — no change needed there.

### Phase 5 — Implementation (2026-07-20)

- `lib/ui/notification.ts:280-298` — Removed `sendIgnoredMessage` call. Added warn log when user explicitly sets `pruneNotificationType: "chat"` so the silent fallback to toast is discoverable.
- `lib/messages/utils.ts:232-269` — Updated `isEmpty` predicate: `part.type === "text" && (empty || ignored)`. Used `(part as { ignored?: boolean }).ignored === true` cast matching `lib/messages/query.ts:58` pattern.
- `tests/drop-empty-messages.test.ts` — +4 regression tests: (a) ignored-only dropped, (b) ignored+real content preserved, (c) ignored+whitespace dropped, (d) ignored+errored tool preserved.
- `lib/config.ts:175` — Default `pruneNotificationType` changed from `"chat"` to `"toast"` so default users don't see deprecation warning.
- `AGENTS.md`, `README.md`, `README.zh-CN.md`, `TESTING.md` — Synced default-value documentation.

### Phase 6 — Verification

- `npm run typecheck`: PASS
- `npm test`: 772 tests, 0 failures (was 768; +4 new regression tests)
- `npm run build`: PASS (405.46 KB bundle)

### Phase 7 — Pending

- Oracle dual-agent code review (AGENTS.md §5.3)
- Oracle dual-agent test review (AGENTS.md §5.6)
- Push branch, create PR
- PR title: `fix: compress notification no longer injects empty user message (closes #20)`
- Human-confirmed merge (AGENTS.md §5.1.1.1)

## Files changed

| File | Change |
|------|--------|
| `lib/ui/notification.ts` | Remove `sendIgnoredMessage` call; always toast + deprecation warn log |
| `lib/messages/utils.ts` | Extend `dropEmptyMessages` to drop ignored-only messages |
| `lib/config.ts` | Default `pruneNotificationType`: `"chat"` → `"toast"` |
| `tests/drop-empty-messages.test.ts` | +4 regression tests for ignored-only message drop |
| `AGENTS.md` | §2.4 default config sync |
| `README.md` | Default value sync + v1.13.1 changelog entry |
| `README.zh-CN.md` | Default value sync + v1.13.1 changelog entry |
| `TESTING.md` | Test factory `pruneNotificationType` sync |
| `package.json` | Version bump `1.13.0` → `1.13.1` (master post-#166 is at unpublished v1.13.0) |
| `devlog/2026-07-20_compress-notification-fix/REQ.md` | Requirement (pre-implementation) |
| `devlog/2026-07-20_compress-notification-fix/DESIGN.md` | Architecture design |
| `devlog/2026-07-20_compress-notification-fix/WORKLOG.md` | This file |

## Risk assessment

- **Backward compatibility**: `pruneNotificationType: "chat"` config value still accepted (warn log + falls back to toast). No config breakage.
- **Behavior change**: Users who relied on the in-chat compress notification history will no longer see it. The compress tool's own return value (`lib/compress/range.ts:334`, single-line header) still appears in the assistant message. UI can render this however it wants.
- **Slash commands unaffected**: `/acp stats`, `/acp context`, `/acp help`, `/acp manual`, `/acp sweep`, `/acp decompress`, `/acp recompress` still use `sendIgnoredMessage` because they are user-initiated (no continuation LLM call).

## Lessons

- The v1.12.7 fix was too narrow — it patched `debugNotify` but left `sendIgnoredMessage` in place for other paths. When a function's contract is "inject user message that the LLM doesn't see", every caller is a latent bug. Future fixes should target the helper itself or audit all callers.
- "Empty user message → provider 400" is a class of bugs, not a one-off. The `dropEmptyMessages` defensive extension is the right shape: prune at the boundary, not at the source.
