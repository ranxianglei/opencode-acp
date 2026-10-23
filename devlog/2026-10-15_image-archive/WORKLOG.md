# WORKLOG - Image Archive for Folded Context (#478)

- Task ID: `2026-10-15_image-archive`
- Home Repo: `opencode-acp`
- Status: InProgress
- Updated: 2026-10-15

## 1. Summary

- **What was done** (1–3 sentences):
  Images attached as `FilePart`s (data URLs) are now eagerly spilled to disk when they first enter a session, and a pointer appendix listing their host-readable paths is injected into any folded block summary that covers them — so image bytes survive folding instead of being silently dropped with the original messages. The model re-reads archived pixels with its own file tools; no new tool or system-prompt surface is added.
- **Why** (1–3 sentences):
  Folding currently drops image FileParts with no record in the summary — after native compaction or external deletion the bytes are gone forever, while text content survives via summaries. This ports the billion-context #1995/#2640 principle (archive + file-first recovery) into ACP's fold-time pipeline.
- **Behavior / compatibility changes**: Yes —
  - New config key `compress.images` (`enabled` default `true`, `minBytes` default `16384`, `ttlDays` default `7`). Disabled ⇒ byte-identical status quo.
  - New storage dir `<storageDir>/images/<dirName(sessionId)>/` (mode 0o600 files).
  - Folded block summaries gain an "Images captured in this range…" appendix ONLY when the covered messages contain archived images ≥ minBytes.
  - Session state file gains an optional `imageArchive` metadata index + two optional stats fields; old state files load unchanged (raw-ID keyed, no compaction-reset coupling).
- **Risk level**: Low — additive path; every I/O failure is caught and logged, never takes down a request; disabled flag restores exact prior behavior.

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| `90e71a28` | feat: image archive — spill data-URL images at index time, inject re-read pointers into folded summaries (#478) |

### Key Files

- `lib/compress/image-archive.ts` (NEW) — pure helpers (`parseImageDataUrl`, `extForMediaType`, `archiveDirName`) + `archiveSessionImages` (per-turn spill pass), `pruneImageArchive` (once-per-process TTL sweep), `appendArchivedImagePointers` (summary appendix).
- `lib/hooks.ts` — transform pipeline: after the FIRST `assignMessageRefs`, run the archive pass when `compress.images.enabled`; persist state on new archives; fire the TTL sweep.
- `lib/compress/range.ts` — summary chain gains the image-pointer appendix as the last step before `finalSummary` (consistent with other protected-content appendices; quality gate sees it).
- `lib/state/types.ts` — `ArchivedImageEntry`, `SessionState.imageArchive` (persisted, raw-ID keyed), `SessionState.imagePruneDone` (transient), optional `SessionStats.imagesArchived/imageBytesArchived`.
- `lib/state/state.ts` — factory/reset init + persisted merge with entry sanitization.
- `lib/state/persistence.ts` — `PersistedSessionState.imageArchive?` + save literal field.
- `lib/config.ts` — `CompressImagesConfig` + `DEFAULT_COMPRESS_IMAGES`, `CompressConfig.images?`, default config, `mergeCompress` field-wise merge; excluded from per-model override cascade (session-scoped disk side effect).
- `lib/config-validation.ts` — whitelist keys + type checks mirroring the `reasoning` pattern.
- `dcp.schema.json` — top-level `compress.images` property object (provider/model override nodes intentionally untouched).
- `tests/image-archive.test.ts` (NEW) — 8 unit tests covering parse/ext/dir-name helpers, spill behavior (permissions, dedup, skip cases), TTL prune semantics, pointer appendix rendering.
- `devlog/2026-10-15_image-archive/{REQ,WORKLOG,DESIGN}.md`.

## 3. Design & Implementation Notes

- **Entry point / key function**: `archiveSessionImages(state, messages, images, logger)` called from `createChatMessageTransformHandler` right after the first `assignMessageRefs` (refs must exist before anything else reads them; archiving has zero dependency on blocks).
- **Key configuration items**: `compress.images.{enabled,minBytes,ttlDays}` — see CONFIGURATION.md.
- **Key logic explanation** (if non-trivial):
  - Files are named `<sha8(rawMessageId)>-p<partIndex>-<sha8(content)>.<ext>` under `<storageDir>/images/<archiveDirName(sessionId)>/`. Content-salted names make skip-if-exists safe across ref re-issue (BC lesson from #2607); raw-ID prefix makes per-message lookup O(1).
  - Index is keyed by RAW message ID (not mNNNNN refs) so it survives compaction ref re-issue without clearing — stale pointers degrade the same way existing mNNNNN refs in summaries already do, while paths stay valid.
  - TTL sweep runs once per session state per process (`imagePruneDone`, not persisted) and is best-effort: per-file stat/unlink failures are logged, never thrown.
  - Only `data:` URL images of known binary types (png/jpeg/gif/webp/avif/bmp) are archived; SVG is deliberately excluded (scriptable text format); remote/file:// URLs are out of scope for v1.

## 4. Testing & Verification

### Build & Test Commands

```sh
npm run typecheck                     # clean
npm run build                         # clean
node --import tsx --test tests/image-archive.test.ts          # 8/8 pass
node --import tsx --test tests/compress-range.test.ts tests/config-validation.test.ts \
  tests/compress-state.test.ts tests/e2e-message-transform.test.ts tests/e2e-blocks-nudges.test.ts
  # 105/105 pass (targeted regression on touched modules)
```

### Test Coverage

- New test files: `tests/image-archive.test.ts` (8 tests)
- Test count (targeted set incl. new file): 113 total, 113 pass, 0 fail
- Key scenarios verified:
  - Spill writes 0o600 files, indexes by raw message ID, accumulates stats, dedups on repeat passes.
  - Skip matrix: below-minBytes, disabled, non-data URLs, svg mime.
  - TTL prune removes expired files, drops index entries, rmdirs empty session dirs, keeps fresh files, honors once-per-state guard.
  - Pointer appendix resolves mNNNNN refs via `byRawId`, falls back to raw IDs, no-op when empty/disabled.
  - Existing compress-range / config-validation / e2e transform suites unaffected.

### Results

- Typecheck: PASS. Build: PASS. Targeted tests: PASS. Full suite delegated to CI.
