# WORKLOG - decompress.toFile exports original text instead of falling back to the summary

- Task ID: `2026-09-20_decompress-tofile-originals`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-09-20

## 1. Summary

- **What was done**: Fixed the two content-recovery helpers in `lib/compress/decompress.ts` that read the wrong fields on SDK-shaped `WithParts` records. `extractMessageId` now reads `m?.info?.id`; a new `serializeMessagePart` serializes text parts verbatim and tool parts via `extractToolContent` (`[name] input/output`), skipping structural parts; `extractMessageText` now builds `[role]\n<segments>` from `m.info.role` + serialized `m.parts`. The `toFile` branch now distinguishes a successful raw export from a true missing-original fallback and reports which happened in the returned message.
- **Why**: For an active block with retrievable originals, the old helpers matched zero messages (top-level `m.id` is always empty on `{ info, parts }` records) and would have produced empty text even if IDs matched — so toFile silently wrote the block summary while reporting success. Both helpers had to be corrected together.
- **Behavior / compatibility changes**: Yes — `toFile` on an active block now writes original message text instead of the summary, and the success message reports "N original messages" vs "no original messages found; wrote block summary". No state format, config schema, persistence, or public API change. Block lifecycle unchanged (still stays compressed).
- **Risk level**: Low

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| `(this commit)` | fix: decompress.toFile exports original text, not the summary (#445) |

### Key Files

- `lib/compress/decompress.ts` — `extractMessageId` → `m?.info?.id`; new `type MessagePart` + `serializeMessagePart(part): string | null`; `extractMessageText` rebuilds from `info.role` + serialized `parts`; toFile branch computes `sourceNote` and distinguishes raw export vs summary fallback; imports `extractToolContent` from `../token-utils`.
- `tests/active-block-decompress-tofile.test.ts` — NEW E2E regression suite (see Testing below).

## 3. Design & Implementation Notes

- **Entry point / key functions**: `extractMessageId`, `serializeMessagePart`, `extractMessageText` in `lib/compress/decompress.ts`; consumed by the `toFile` branch of `createDecompressTool(...).execute`.
- **Key logic**:
    - `serializeMessagePart`: `text` → verbatim non-empty string; `tool` → `[<tool>] <input/output joined by newline>` using `extractToolContent` (empty → null); any other structural part type → null (skipped). This mirrors what token-utils counts so exported tool content is faithful.
    - `extractMessageText`: `[${role}]\n${segments.join("\n\n")}` where role = `m.info.role ?? "unknown"` and segments are the non-null serialized parts.
    - toFile branch: `lines.length > 0` → join with `\n\n---\n\n`, note = "N original message(s)"; else → `targets[0]?.blocks[0]?.summary ?? "(no content available)"`, note = "no original messages found; wrote block summary (N block(s))". Return string uses the note.
- **Key configuration items**: none — no new config surface.

## 4. Testing & Verification

### Build & Test Commands

```sh
npm run typecheck                       # tsc --noEmit
node --import tsx --test tests/active-block-decompress-tofile.test.ts   # new suite
npm test                                # full suite
```

### Test Coverage

- New test file: `tests/active-block-decompress-tofile.test.ts` (ESM; uses static `import os/path/fs`, not `require`).
    - Test 1 "E2E: toFile on active block exports original text (not summary) with mixed text/tool parts": active block b7 over a real SDK-shaped history (a user text part carrying sentinel `ORIGINAL DETAIL 42`, and an assistant message with a text part + a completed `bash` tool part whose output also carries the sentinel). Asserts: no error, "written to", "original message" present and "no original messages found" absent; file includes the sentinel, `[user]`, `[assistant]`, labeled `[bash]`, and the tool output line; file does NOT include the summary text; block b7 still active.
    - Test 2 "E2E: toFile falls back to summary only when originals are genuinely absent": active block b9 referencing an id not present in fetched history (history holds an unrelated message). Asserts: "no original messages found" AND "wrote block summary"; file content equals the stored summary exactly; unrelated message text NOT leaked in.
- Bug-fail proof (per AGENTS.md §5.7): stashed only `lib/compress/decompress.ts` back to master and re-ran the suite → both tests FAIL against the buggy code (0 pass / 2 fail); restored the fix → both PASS. Confirms the tests genuinely catch the defect.

### Results

- **PASS/FAIL**: PASS — typecheck clean; full suite green except the two known pre-existing sandbox artifacts below.
- **Key data**: full suite (final branch state) **1306 tests / 1304 pass / 2 fail**. Both failures are environment artifacts of this sandbox (read-only `/tmp`), identical on clean master (verified by stashing the fix and re-running those files), not regressions:
    - `tests/soft-block.test.ts` — crashes at import: `Error: EACCES: permission denied, mkdir '/tmp/opencode-dcp-dangerous-*'` (`/tmp` mounted read-only here; passes on CI).
    - `tests/inactive-block-decompress.test.ts` "E2E: toFile on inactive block writes block summary" — `toFile path must be under <workspace>/.tmp or ~/.cache/opencode/. Got: /tmp/test-inactive-block-decompress.txt` (same `/tmp` cause; the test hardcodes `/tmp/…`).

## 5. Risk Assessment & Rollback

- **Risk points**: none material. Behavior change is confined to what `toFile` writes for active blocks and its returned note; the fallback path is preserved for genuinely-missing originals.
- **Rollback method**: Revert the single PR commit. No state/persistence/API changes; reverting restores exact previous behavior.
- **Compatibility notes** (data format, config schema): No — none.

## 6. Lessons Learned

- What went well: reusing `extractToolContent` avoided a second tool-output parser and keeps exported text consistent with token accounting.
- What could be improved: repo-wide `prettier --check` currently fails on many master files due to Prettier version drift (package.json pins `^3.8.1`, installed 3.9.5 reformats differently — e.g. it wants to wrap the long `.describe()` strings in this very file). Running `prettier --write` introduced unrelated reflow noise, so this PR deliberately keeps a minimal diff matching master's existing style and does NOT blanket-reformat. CI does not gate on Prettier (verified: no workflow references it). Prettier cleanup belongs in a separate housekeeping task.

## 7. Follow-ups

- [ ] Prettier version-pinning / repo-wide reformat as a separate housekeeping task (do NOT mix into feature PRs).
- [ ] Consider making the pre-existing `/tmp`-hardcoded E2E tests use `os.tmpdir()` so they pass in sandboxes where `/tmp` is read-only (separate, low priority).
