# WORKLOG: more-compression-candidates

## 2026-07-09

### Implementation

Cherry-picked commit `ea7db98` from `2026-07-09_summary-role-assistant`
onto a fresh branch `2026-07-09_more-compression-candidates` based on
`master` (`b8fba7a`).

Changes (3 lines across 2 files):

- `lib/messages/inject/utils.ts:652` — `perMessage.slice(0, 10)` →
  `slice(0, 15)` (`largestRanges`)
- `lib/messages/inject/utils.ts:653` — `perTool.slice(0, 5)` →
  `slice(0, 15)` (`largestToolRanges`)
- `lib/messages/inject/inject.ts:214` —
  `composition.largestRanges.slice(0, 5)` → `slice(0, 15)`
  (`toolOutputReminder` top ranges)

### Verification

- `npm run typecheck` — clean
- `npm run build` — clean
- Tests — green on the source branch (no test changes in this slice)

### Files

- `lib/messages/inject/utils.ts`
- `lib/messages/inject/inject.ts`
- `devlog/2026-07-09_more-compression-candidates/REQ.md`
- `devlog/2026-07-09_more-compression-candidates/WORKLOG.md`
