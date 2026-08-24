# WORKLOG - Self-disable when billion-context proxy is active

- Task ID: `2026-08-23_self-disable-proxy`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-08-23 23:59

## 1. Summary

- **What was done**: added an early-return guard at the plugin entry point that detects `BILLION_CONTEXT_PROXY` in the environment and disables the whole extension (logs one line, returns an empty plugin object).
- **Why**: `bili opencode` injects ACP tooling at the wire level; running both stacks duplicates the four tools and the `/acp` command, and the client-side panel shadows the proxy's real state.
- **Behavior / compatibility changes**: No — zero behavior change without the env var.
- **Risk level**: Low

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| `51fd677` | feat: self-disable when BILLION_CONTEXT_PROXY is set |

### Key Files

- `src/index.ts` — 4 lines at the top of the `Plugin` initializer: env check + log + `return {}`.

## 3. Design & Implementation Notes

- **Entry point / key function**: the default `Plugin` export (`src/index.ts`), before any hook registration.
- **Key configuration items**: `process.env.BILLION_CONTEXT_PROXY` (set exclusively by the `bili` launcher / `bili start`).
- **Key logic explanation**: the bili launcher always exports this var into the child client process, so its presence is a reliable "the proxy owns ACP for this session" signal. Returning an empty object makes opencode treat the plugin as a no-op (same shape as `enabled: false` in plugin config).

## 4. Testing & Verification

### Build & Test Commands

```sh
cd opencode-acp && npm run build
npx tsc --noEmit
node --import tsx --test tests/*.test.ts
```

### Manual verification

- `BILLION_CONTEXT_PROXY=http://127.0.0.1:8787 opencode run "hi"` → stderr shows `[opencode-acp] disabled: BILLION_CONTEXT_PROXY detected`; no ACP tools registered.
- Without the var: plugin activates normally, tools present, `/acp` works.
- End-to-end with the launcher (`node dist/index.js opencode run "reply with exactly: pong"` from billion-context): proxy log shows wire-injected tools `[compress,decompress,search_context,acp_status]` + the bili thin plugin's `/acp` renders the proxy panel.

## 5. Rollback Plan

- Single revert commit; no schema/config/data migrations involved.

## 6. Lessons Learned

- opencode resolves `opencode-acp@latest` from `~/.cache/opencode/packages/` (NOT `~/.config/opencode/node_modules/`) — patching the wrong copy shows no effect; verify the load path in the session log before debugging further.
- The empty-object return is the same contract as a disabled plugin, so no special-casing is needed elsewhere.
