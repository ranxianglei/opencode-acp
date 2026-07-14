# WORKLOG: Empty Suffix Message Backstop

## Iteration

| Step                                                                    | Status | Notes                                                |
| ----------------------------------------------------------------------- | ------ | ---------------------------------------------------- |
| Branch `2026-07-07_empty-suffix-backstop` cut from `master` (`d08ae01`) | ✅     |                                                      |
| Devlog entry created                                                    | ✅     | REQ.md + DESIGN.md + WORKLOG.md                      |
| Primary fix in `inject.ts`                                              | ⏳     | splice empty suffix at end of `injectCompressNudges` |
| Backstop utility in `utils.ts`                                          | ⏳     | `dropEmptyUserMessages`                              |
| Barrel export in `index.ts`                                             | ⏳     | export new symbol                                    |
| Pipeline wiring in `hooks.ts`                                           | ⏳     | call backstop after `stripStaleMetadata`             |
| Tests                                                                   | ⏳     | `tests/drop-empty-user-messages.test.ts`             |
| `npm run typecheck`                                                     | ⏳     |                                                      |
| `npm run test`                                                          | ⏳     | 407 existing + new tests, 0 failures                 |
| `npm run build`                                                         | ⏳     |                                                      |
| Commit                                                                  | ⏳     | atomic: code+test together, devlog separate          |
| Push + GitHub PR                                                        | ⏳     |                                                      |

## Key Files

- `lib/messages/inject/inject.ts` — primary fix (splice empty suffix)
- `lib/messages/utils.ts` — `dropEmptyUserMessages` utility
- `lib/messages/index.ts` — barrel export
- `lib/hooks.ts` — pipeline wiring
- `tests/drop-empty-user-messages.test.ts` — new test file

## Root Cause Reference

See `REQ.md`. Summary: the 5%-growth-gated nudge change left the synthetic
suffix message empty on most turns, and the empty message reached the LLM
because no cleanup removed it.
