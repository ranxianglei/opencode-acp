# REQ: Debug Nudge Chat Visibility

## Goal
In debug mode, persist the full ACP nudge text (compression prompts, ranges, tips, breakdown) to the chat UI via `sendIgnoredMessage`, so users can see exactly what ACP injected for debugging.

## Problem
Currently, debug mode only shows nudge text via:
- Logger debug file (not visible in UI)
- 5-second toast popup (ephemeral, not persisted)

The nudge suffix message is ephemeral (transform hook only, not persisted to DB), so users cannot inspect what ACP actually injected.

## Solution
In the `debugNotify` callback in `hooks.ts`, call `sendIgnoredMessage` with the full nudge text prefixed with `[ACP Debug Nudge]`. This persists to the conversation database as `ignored: true` (user-visible, model-invisible).
