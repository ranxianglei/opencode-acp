# REQ - Replace Compress Protected Tools

- Task ID: `2026-07-22_replace-compress-protected-tools`
- Status: Done

## Problem

`compress.protectedTools` is additive, so users cannot override the default `skill` protection.

## Acceptance Criteria

- Omission retains the root default of `["skill"]`.
- An explicit array, including `[]`, replaces inherited protection.

## Behavioral Change (breaking)

Merge semantics for `compress.protectedTools` change from **additive** to
**replacement**. A config that previously set `compress.protectedTools: ["task"]`
produced `["skill", "task"]` (inheriting the root `skill`); after this change it
produces `["task"]` only, dropping `skill` protection.

This is intentional — `compress.protectedTools` is a standalone complete policy,
not an extension of a hardcoded base (unlike `commands.protectedTools` /
`strategies.*.protectedTools`, which remain additive over the 11-tool
`DEFAULT_PROTECTED_TOOLS`). The release changelog MUST flag this as a breaking
change so users who customized this field know to add `"skill"` back explicitly
if they want to keep it.
