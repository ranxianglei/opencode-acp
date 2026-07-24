# WORKLOG: Protect compress tool calls from being compressed

## Investigation (Gitea #20)

Investigated `ses_07562b88` compression deviation. Found the root cause:
sequential compressions eat previous summaries because compress tool calls
fall inside the next compress range and get pruned.

Verified in code: `COMPRESS_DEFAULT_PROTECTED_TOOLS = ["skill"]` — `compress`
not in the list. No compress-call-specific protection logic exists anywhere
in `lib/compress/` or `lib/messages/`. The inconsistency between
`DEFAULT_PROTECTED_TOOLS` (has `compress`) and `COMPRESS_DEFAULT_PROTECTED_TOOLS`
(lacks `compress`) is the gap.

GC truncation was already gated behind `majorGcThresholdPercent: "100%"`
(PR #161) and does not fire in normal operation — so relying on GC to trim
accumulated compress calls is not viable.

## Implementation

### 1. Config fix (`lib/config.ts:132`)

```diff
- const COMPRESS_DEFAULT_PROTECTED_TOOLS = ["skill"]
+ const COMPRESS_DEFAULT_PROTECTED_TOOLS = ["skill", "compress"]
```

### 2. Tests (`tests/protect-compress-calls.test.ts`)

6 tests covering:
- `messageContainsProtectedTool` detects compress tool calls as protected
- `messageContainsProtectedTool` does NOT protect when `compress` is absent (opt-out)
- `messageContainsProtectedTool` does NOT protect plain text messages
- `filterProtectedToolMessages` removes compress-call messages, keeps surrounding
- `filterProtectedToolMessages` is a no-op when `compress` is not protected (old behavior)
- `filterProtectedToolMessages` handles all-compress-call selections (empty result)

### 3. Documentation sync (schema + READMEs)

Updated stale `["skill"]` defaults to `["skill", "compress"]` in:
- `dcp.schema.json` — property default (line 254), description text, and default object (line 328)
- `README.md` — Default Configuration section (line 312-314) and Protected Tools explanation (line 403)
- `README.zh-CN.md` — same two sections

Historical changelog entries were NOT modified (they record what was true at that time).

## Verification

- `npm run typecheck` — pass
- `npm run test` — all tests pass including 6 new tests
- `npm run build` — pass
