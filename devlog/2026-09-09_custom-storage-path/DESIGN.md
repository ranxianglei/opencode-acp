# DESIGN - Support custom storage location for compressed content (session state files)

- Task ID: `2026-09-09_custom-storage-path`
- Home Repo: `opencode-acp`
- Created: 2026-09-09
- Status: Done

## 1. Overview

Add a top-level `storagePath` config option that relocates the per-session
state directory. The directory is resolved **once per session** at init and
carried on `SessionState` so every save/load in that session uses the same
location without re-reading config.

## 2. Data Flow

```
index.ts
  └─ new SessionStateRegistry(logger, ctx.directory)   # projectDir captured once
        │
        ▼  (each messages.transform / compress tool call)
SessionStateRegistry.getOrCreate(client, sessionId, messages, config)
  └─ ensureSessionInitialized(..., config, projectDir)
        ├─ resetSessionState(state)                    # clears storageDir
        ├─ state.storageDir = config?.storagePath
        │      ? resolveStorageDir(config.storagePath, projectDir ?? cwd())
        │      : undefined                             # undefined = default XDG
        ├─ loadSessionState(sessionId, logger, state.storageDir)
        │     └─ if null && state.storageDir && existsSync(defaultPath)
        │           → logger.warn (no auto-migration, once per session)
        └─ saveSessionState(state, ...)                # reads state.storageDir
```

Key invariant: `state.storageDir` is **transient** — it is never serialized
into the persisted JSON. It is re-derived from config on every session init,
so a config change takes effect on the next session (or process restart).

## 3. Path Resolution Semantics (`resolveStorageDir`)

| Input                     | Result                                        |
| ------------------------- | --------------------------------------------- |
| `undefined` / `""` / ws   | default: `$XDG_DATA_HOME/opencode/storage/plugin/acp` |
| `~`                       | `homedir()`                                   |
| `~/foo`                   | `join(homedir(), "foo")`                      |
| absolute (`/...`)         | as-is                                         |
| relative (`foo`)          | `join(projectDir, "foo")`                     |

`projectDir` is opencode's `ctx.directory`, threaded through the registry.
The `process.cwd()` fallback only applies to callers that lack directory
context (e.g. `decompress`/`pipeline` re-init paths) — in practice the
messages hook has already initialized the session by then.

## 4. Module Changes

| File                    | Change |
| ----------------------- | ------ |
| `lib/config.ts`         | `PluginConfig.storagePath?: string`; `mergeLayer` merges it |
| `lib/config-validation.ts` | `VALID_CONFIG_KEYS` + string type check |
| `dcp.schema.json`       | new `storagePath` property |
| `lib/state/persistence.ts` | `getDefaultStorageDir()` (exported), `resolveStorageDir()` (exported); `storageDir?` threaded through `getSessionFilePath` / `writePersistedSessionState` / `loadSessionState` / `loadAllSessionStats`; `saveSessionState` reads `sessionState.storageDir` |
| `lib/state/types.ts`    | transient `SessionState.storageDir: string \| undefined` |
| `lib/state/state.ts`    | `createSessionState`/`resetSessionState` init the field; `ensureSessionInitialized` resolves it + migration WARN; registry takes `projectDir` |
| `index.ts`              | passes `ctx.directory` to the registry |

## 5. Backward Compatibility

- Option unset → `state.storageDir === undefined` → every path helper falls
  back to `getDefaultStorageDir()`, which is byte-for-byte the previous
  behavior. No persisted-format change (field is transient).
- Existing state files keep loading from the default location.

## 6. Migration Policy

No automatic copy/move of existing state files. When `storagePath` is set,
the configured dir has no file for the session, but the default location does,
ACP logs a WARN (once per session, since init runs once per session) naming
both paths. Rationale: silently moving user data between locations is a
surprise; a WARN is discoverable and non-destructive.

## 7. Risks & Mitigations

- **Relative-path base ambiguity** → resolved against `ctx.directory`
  (project dir), matching user expectation of "project-local storage".
- **State "loss" on switch** → mitigated by the WARN.
- **Transient field accidentally persisted** → `saveSessionState` never reads
  `storageDir` into the `PersistedSessionState` shape; covered by tests.
