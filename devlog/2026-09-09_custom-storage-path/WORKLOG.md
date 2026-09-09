# WORKLOG - Support custom storage location for compressed content (session state files)

- Task ID: `2026-09-09_custom-storage-path`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-09-09

## 1. Summary

- **What was done**: New top-level `storagePath` config option relocating the
  per-session state directory (`{sessionId}.json` files). Absolute / `~` /
  project-relative path semantics; resolved once per session and carried on
  `SessionState.storageDir` (transient, never persisted). WARN (no
  auto-migration) when the custom location is empty but the default location
  holds the session file.
- **Why**: Issue #379 — users on containers / NFS homes / small XDG data
  dirs need to relocate ACP's state files; the location was hardcoded.
- **Behavior / compatibility changes**: No, when unset. The default location
  (`$XDG_DATA_HOME/opencode/storage/plugin/acp`) is byte-for-byte unchanged;
  no persisted-format change.
- **Risk level**: Low

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| `7c1a2ba` | feat: storagePath config for custom session-state storage location |
| `645928e` | docs: finalize devlog for storagePath |
| `24bb1e4` | test: address round-1 review findings (config-merge, resume, cwd-fallback, non-persistence) |
| `7c619bc` | test: address round-2 review findings (registry wiring, resetSessionState, WARN wording) |

### Key Files

- `lib/config.ts` — `PluginConfig.storagePath?: string` + `mergeLayer` merge
- `lib/config-validation.ts` — `VALID_CONFIG_KEYS` + string type check
- `dcp.schema.json` — `storagePath` property (schema is `additionalProperties: false`)
- `lib/state/persistence.ts` — `getDefaultStorageDir()` / `resolveStorageDir()`
  (exported); `storageDir?` threaded through path/save/load/stats helpers;
  `saveSessionState` reads `sessionState.storageDir`
- `lib/state/types.ts` — transient `SessionState.storageDir`
- `lib/state/state.ts` — `createSessionState` / `resetSessionState` /
  `ensureSessionInitialized` (resolve + migration WARN) / registry
  `projectDir` constructor arg
- `index.ts` — `new SessionStateRegistry(logger, ctx.directory)`
- `tests/storage-path.test.ts` — 19 new tests
- `CONFIGURATION.md`, `CONFIGURATION.zh-CN.md` — parameter entry + recipe
- `devlog/2026-09-09_custom-storage-path/` — REQ / DESIGN / WORKLOG

## 3. Design & Implementation Notes

- **Entry point / key function**: `resolveStorageDir(configured, projectDir)`
  in `lib/state/persistence.ts`; resolution happens in
  `ensureSessionInitialized` (`lib/state/state.ts`) once per session.
- **Key configuration items**: `storagePath` (top-level string, optional).
- **Key logic explanation**: `state.storageDir` is transient — derived from
  config at session init, consumed by `saveSessionState` (via
  `sessionState.storageDir`) and `loadSessionState` (explicit param in
  `ensureSessionInitialized`). The migration WARN fires in the
  `persisted === null` branch, at most once per session because init
  early-returns on repeat calls.

## 4. Testing & Verification

### Build & Test Commands

```sh
npm run typecheck
npm run build
node --import tsx --test tests/storage-path.test.ts
npm run test
```

### Test Coverage

- New/modified test files: `tests/storage-path.test.ts` (19 tests)
- Test count: 1131 total, 1131 pass, 0 fail (full suite)
- Key scenarios verified:
  - `resolveStorageDir`: unset/empty → default; absolute as-is; `~`/`~/...`
    → home; relative → project dir
  - save to custom dir (not default); load from custom dir; default-location
    round-trip regression; `loadAllSessionStats` with custom dir
  - `ensureSessionInitialized` resolves absolute + relative `storagePath`
    (relative against `projectDir`); `process.cwd()` fallback when
    `projectDir` omitted; custom-location resume without spurious WARN
  - migration WARN fires only when file exists solely at default location;
    no WARN when `storagePath` unset
  - `getConfig` layering (global → project override → unset);
    `validateConfigTypes` rejects non-string / accepts undefined
  - transient `storageDir` never appears in persisted JSON;
    `SessionStateRegistry.getOrCreate` passes `projectDir` through;
    `resetSessionState` clears `storageDir`
- Regression detection verified by mutation testing: dropping the
  `mergeLayer` storagePath line, making `resolveStorageDir` always return
  the default dir, or ignoring `storageDir` in save/load each fail multiple
  new tests.

### Dual-Agent Review (AGENTS.md §5.3 / §5.6)

- Code review ×2 independent agents: both APPROVE. Round-1 deferred
  follow-ups (optional `config?` fallback, custom→custom switch not warned,
  no startup validation of `storagePath`, cwd-fallback threading, e2e
  hardcoded default path) recorded in §7. Round-2 NIT (WARN wording for a
  corrupt custom file) fixed.
- Test review ×2 independent agents: round 1 REQUEST_CHANGES (narrow —
  missing config-merge / resume / validation / cwd-fallback tests) → all
  fixed in `24bb1e4`; round 2 APPROVE with two MINOR gaps (registry
  `projectDir` wiring, `resetSessionState` clearing `storageDir`) → fixed
  in the round-2 commit.

### Results

- **PASS/FAIL**: PASS
- **Key logs/data**: `# tests 1131 / # pass 1131 / # fail 0`

## 5. Risk Assessment & Rollback

- **Risk points**: relative-path base (mitigated: project dir); state
  "loss" on location switch (mitigated: WARN).
- **Rollback method**:
  - Revert commit(s): `7c1a2ba`, `645928e`, `24bb1e4`, `7c619bc`
  - Rollback impact: none — option is additive and unset by default.
- **Compatibility notes** (data format, config schema): No persisted-format
  change; schema gains one optional property.

## 6. Lessons Learned (optional)

- The repo's prettier baseline is not clean (pre-existing); only new/changed
  lines were kept prettier-conformant to avoid unrelated diff noise.

## 7. Follow-ups (optional)

- [ ] Optional: `ACP_STORAGE_DIR` env var override (deferred per issue
      discussion — config option is the supported path)
- [ ] WARN when switching `storagePath` from one custom location to another
      (only default→custom is warned today)
- [ ] Startup validation of `storagePath` (writability check; today
      ENOTDIR/EACCES surfaces at first save, logged, no crash)
- [ ] Thread `projectDir` through `ToolContext` so the compress-tool init
      path doesn't rely on the `process.cwd()` fallback
- [ ] `scripts/e2e/run-e2e.sh` hardcodes the default storage path
