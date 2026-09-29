# WORKLOG - V2 per-tool permission resolution

- Task ID: `2026-09-29_v2-per-tool-permission`
- Home Repo: `opencode-acp`
- Status: InProgress
- Updated: 2026-09-29

## 1. Summary

- **What was done** (1–3 sentences): V2 tool permission resolution now keys on
  the real tool name instead of the hard-coded literal `"compress"`. The inert
  `options.permission` declaration now carries each tool's own name, and the
  fail-closed ask/deny messages plus result metadata name the actual tool.
- **Why** (1–3 sentences): Issue #459 — all five V2 tools inherited one shared
  decision, so granular host rulesets produced the opposite of their intended
  effect (e.g. an `ask` on `compress` refused four unrelated read-only tools).
- **Behavior / compatibility changes**: Yes —
  - Old → new: every V2 tool resolved under action `"compress"` → each tool
    resolves under its own name (`decompress`, `search_context`, `acp_status`,
    `acp_context_recap` no longer inherit `compress` rules). Rules written
    against those names now take effect; rules that previously leaked onto
    them no longer do.
  - Refusal metadata `permission` field: `"compress"` for all tools → the real
    tool name. Message text for non-compress tools now names the tool
    (previously hard-coded "the `compress` permission").
  - Unchanged on purpose: behavior for `compress` itself is byte-identical
    (message text, metadata value, resolution); ACP's own
    `compress.permission` config gate remains a global gate over ACP tools;
    V1 path and nudge gating (`state.compressPermission`) untouched; OpenCode
    ordered last-match semantics preserved; fail-closed `ask` preserved
    (no native permission-request API in OpenCode 2.0.3).
- **Risk level**: Low (one comparison argument + message templating; full suite
  green).

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| `ab42c8ed` | fix(v2): resolve host permission rules per real tool name |

### Key Files

- `lib/host-permissions.ts` — `resolveEffectiveCompressPermission()` gains an
  optional `toolName` parameter (default `"compress"`) used only by the V2
  ordered-rules branch; legacy V1 branch unchanged.
- `lib/v2/tools.ts` — `resolveToolPermission()` receives the definition's real
  name; `options.permission` set per tool; ask/deny refusal messages and result
  metadata made dynamic per tool name.
- `tests/v2-tools.test.ts` — updated four tests that pinned the hard-coded
  `"compress"` behavior (rules now target the test tool's own name; `options`
  assertion per tool name); added regression suite covering deny/ask isolation
  across all five tool names including the issue's failure scenarios.
- `README.md` — one sentence documenting per-tool rule resolution on V2.

## 3. Design & Implementation Notes

- `options.permission` kept (not deleted) but set to the real tool name: live
  measurement showed the field never reaches the host evaluate pipeline today,
  but if the host ever honors it as the evaluation action, per-name values make
  granular host rules work end-to-end instead of mis-declaring "compress".
- The issue's literal example `[{action:"compress",effect:"ask"},{action:"*",effect:"deny"}]`
  resolves to deny-for-all under OpenCode's ordered last-match semantics (the
  later `*` rule wins for every action). ACP deliberately does not redefine
  platform ordering; users express intent by ordering the specific rule last.
  Tests use unambiguous orderings and assert per-name independence directly.
- `lib/compress/pipeline.ts` and `lib/compress/decompress.ts` call
  `toolCtx.ask({permission:"compress"})` — that is the V1 host-permission path
  (no-op on V2 via `toSharedContext`'s empty `ask`) and stays as-is.
