# REQ: Force-Protect "compress" Tool from Being Compressed

## Problem

v1.13.4 added `"compress"` to `COMPRESS_DEFAULT_PROTECTED_TOOLS` to protect compress tool calls (which carry summaries) from being eaten by sequential compressions. However, `compress.protectedTools` uses a **replace** merge policy (PR #177): if a user sets `"protectedTools": ["skill"]` or `"protectedTools": []` in their config, "compress" is silently removed.

This means any user who overrides `protectedTools` loses compress-call protection without knowing it. The compress summary — the sole record of compressed conversation — becomes vulnerable to being pruned by subsequent compressions, causing irreversible data loss.

## Requirement

`"compress"` must be **always protected** in `compress.protectedTools`, regardless of user configuration. Even if the user explicitly sets `protectedTools: []`, "compress" must remain in the final resolved list.

## Solution

Add a `FORCE_COMPRESS_PROTECTED` constant and append it to the override array in `mergeCompress()` when a user provides an explicit `protectedTools` array. This ensures the force-protected tool survives config layering (global → configDir → project).

## Scope

- `lib/config.ts`: Add constant + modify `mergeCompress`
- `tests/config-protected-tools.test.ts`: Update existing tests for new behavior
- `README.md`, `README.zh-CN.md`: Document force-protection
