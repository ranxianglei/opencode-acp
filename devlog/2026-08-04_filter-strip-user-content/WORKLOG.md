# WORKLOG: Fix omo-system-reminder filter dropping user content

## 2026-08-04

- User identified the bug: "看看这个会删除的时候剥离出错，把正确的用户历史消息剥离错误吗？"
- Root cause: `omo-system-reminder` v1.2.0 filter returned `{ action: "drop" }` for entire message when `<system-reminder>` blocks present. Phase 2 `keepLastOnly` hard-dropped older matches, losing user content.
- Fix 1: Rewrote filter to v1.3.0 — strips blocks, returns `modify` when user text remains, `drop` only for pure OMO content
- Fix 2: Phase 2 now applies filter's actual decision for older matches instead of unconditional drop
- Added regression test: 4 messages with mixed user content + blocks, oldest 2 stripped (user text preserved), latest 2 kept as-is
- Updated test: lone OMO marker with user content → `modify` (was `drop`)
- Updated version check: 1.2.0 → 1.3.0
- 954 tests pass, typecheck clean
