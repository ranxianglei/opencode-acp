# REQ - Replace Compress Protected Tools

- Task ID: `2026-07-22_replace-compress-protected-tools`
- Status: Done

## Problem

`compress.protectedTools` is additive, so users cannot override the default `skill` protection.

## Acceptance Criteria

- Omission retains the root default of `["skill"]`.
- An explicit array, including `[]`, replaces inherited protection.
