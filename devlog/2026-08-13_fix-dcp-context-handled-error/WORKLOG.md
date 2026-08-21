# WORKLOG — Fix __DCP_CONTEXT_HANDLED__ Error Leak

## Changes

`lib/hooks.ts`: Replaced 2× `throw new Error("__DCP_CONTEXT_HANDLED__")` with `return` (lines 295, 299).
`tests/hooks-permission.test.ts`: Added regression test verifying handler returns normally.

## Verification

- TypeScript: 0 errors
- Tests: 977 pass, 0 fail
- Build: 391.50 KB
- Deployed locally
