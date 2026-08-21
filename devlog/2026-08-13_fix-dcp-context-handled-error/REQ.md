# REQ — Fix __DCP_CONTEXT_HANDLED__ Error Leak (Issue #296)

## Problem

`/acp` commands throw `Error: __DCP_CONTEXT_HANDLED__` which leaks to the opencode error log. In opencode 1.18.18, this produces `level=ERROR` entries for every `/acp` invocation.

## Root Cause

The command handler in `hooks.ts` threw `new Error("__DCP_CONTEXT_HANDLED__")` after handling `/acp` commands. This sentinel was meant to abort command processing, but opencode catches and logs it as an error.

## Fix

Replace both `throw new Error("__DCP_CONTEXT_HANDLED__")` with `return`. The commands deliver output via `sendIgnoredMessage` (which writes directly to the session via `client.session.prompt`), so the hook can return normally without any side effects.
