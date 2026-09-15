# REQ - Fix Windows path separator normalization in protectedFilePatterns

- Task ID: `2026-09-16_fix-windows-path-normalization`
- Home Repo: `opencode-acp`
- Created: 2026-09-16
- Status: InProgress
- Priority: P1
- Owner: ranxianglei
- References: https://github.com/ranxianglei/opencode-acp/issues/402 ; upstream DCP commit 5f8f33b

## 1. Background & Problem Statement

- **Context**: `protectedFilePatterns` protects files from pruning by matching tool-parameter paths against glob patterns. `lib/protected-patterns.ts` normalizes path separators before glob matching so that Windows paths work.
- **Current behavior (symptom)**: On Windows, ordinary single-backslash paths (`C:\repo\src\secrets.ts`) bypass configured protection. Only patterns like `**/*.ts` accidentally worked, because `*` compiles to `[^/]*` which spans backslashes freely.
- **Expected behavior**: A documented-style pattern such as `**/secrets.ts` matches the same file whether the tool parameter uses `/` or `\` separators; patterns written with Windows separators also work.
- **Impact**: Silent security/privacy bypass — files the user explicitly protected on Windows were unprotected at all `isFilePathProtected` call sites (protected-content, sweep, deduplication, purge-errors).

## 2. Reproduction

- **Environment**: Node 22+, any OS (pure string logic)
- **Minimal reproduction steps**:
  1) Configure `"protectedFilePatterns": ["**/secrets.ts"]`
  2) Tool call with `filePath: "C:\\repo\\src\\secrets.ts"` (single backslashes at runtime)
  3) `isFilePathProtected` returns `false` — bug confirmed by new regression tests failing against pre-fix code
- **Relevant configuration**: `protectedFilePatterns` (root config key)

## 3. Constraints & Non-Goals

- **Constraints**:
  - Backward compatibility: POSIX paths and existing forward-slash patterns must behave identically; both input path and pattern are normalized on both sides, so cross-style matching stays consistent.
  - Performance requirements: none (single-string replaceAll per call)
  - Resource limits: none
- **Non-Goals**: no changes to glob semantics (`*` still `[^/]*`, does not cross separators); no changes to other call sites.

## 4. Acceptance Criteria

- **Correctness**:
  - [x] `normalizePath` converts each single backslash to `/`
  - [x] Windows path + forward-slash pattern → protected
  - [x] Forward-slash path + Windows-separator pattern → protected
  - [x] `*` does not cross a Windows separator (no over-matching)
  - [x] read / multiedit / apply_patch parameter shapes all covered
- **Performance / Stability**:
  - [x] Full test suite passes
- **Regression**:
  - [x] New test file `tests/protected-patterns.test.ts` added (ported from upstream DCP commit 5f8f33b) and passing

## 5. Proposed Approach

- **Affected modules & entry files**:
  - `lib/protected-patterns.ts` — one-line fix in `normalizePath` (+ explanatory comment)
  - `tests/protected-patterns.test.ts` — new regression suite
- **Risks**: Literal doubled backslashes (`C:\\Users`) become `C://Users` after normalization — but since both path and pattern are normalized identically, matching consistency is preserved; cross-style double-vs-single mismatches are contrived edge cases.
- **Rollback strategy**: Revert the single commit; no state format or API changes.
