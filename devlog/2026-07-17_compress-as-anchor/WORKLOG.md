# WORKLOG: Compress-as-anchor

## Steps

1. Created branch `2026-07-17_compress-as-anchor` from `github/master` @ `6446fa6`.
2. Source changes: removed synthetic recap injection, simplified `filterCompressedRanges` to message-hiding only.
3. Test changes: rewrote 8 tests to assert no-recap behavior, removed 6 obsolete tests, deleted `tests/strip-stale-compress.test.ts`.
4. Verified: typecheck 0 errors, 724/724 tests pass, build clean.

## Verification

- TypeScript: 0 errors
- Tests: 724/724 pass (Node v25.9.0)
- Build: clean
