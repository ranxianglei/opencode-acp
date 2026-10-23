# DESIGN - Image Archive for Folded Context (#478)

- Task ID: `2026-10-15_image-archive`
- Home Repo: `opencode-acp`
- Created: 2026-10-15
- Status: Accepted

## 1. Problem Statement

- **What problem are we solving?** Images attached to messages arrive as SDK `FilePart`s (`type: "file"`, `mime: image/*`, data-URL). When a range containing such a message is folded, the FilePart is dropped with the original message and the generated summary carries no record of the image — the pixels are unrecoverable once OpenCode's own storage loses the originals (native compaction, external deletion). Text content survives folding via summaries; images do not.
- **Why now?** Issue #478 asks for image support "referencing billion-context's principle": images should not be summarized — they get dumped to a file that the model re-reads with its own tools when needed. BC shipped exactly this as #1995/#2607/#2640 (eager spill + file-first recovery); ACP has no equivalent.

## 2. Goals & Non-Goals

- **Goals**:
  - Image bytes survive folding: spilled to disk before/at index time, never destroyed by ACP.
  - Folded summaries tell the model where archived images live (re-readable absolute paths).
  - No new tool surface, no system-prompt change; recovery uses the model's existing file tools.
  - Zero impact when disabled or when no archivable images exist (byte-identical summaries).
- **Non-Goals** (v1):
  - Proactive offload of aged-but-unfolded images from the live wire (UX risk: model loses direct pixel view mid-task; token release happens at fold time instead — the same moment as today's silent loss).
  - Remote (`http(s)://`) and `file://` URL images (data URLs cover the dominant attachment path in headless/daemon usage).
  - Non-image mimes (PDFs, audio) — same mechanism could extend later, not requested.
  - Lossy pre-compression / downscaling (BC kernel's separate `image-compress.ts` concern, default-off there).
  - Per-model override cascade for the new config (session-scoped disk side effect must not fork per model).

## 3. Current Architecture (if applicable)

- **How it works today**: `createChatMessageTransformHandler` (lib/hooks.ts) runs assignMessageRefs → syncCompressionBlocks → prune → nudges → injectMessageIds on every LLM call. The compress tool (range mode, lib/compress/range.ts) resolves boundaries, builds the summary chain (protected user messages → prompt info → protected tools → missing block summaries → quality gate), then allocates a block covering those message IDs. Prune replaces covered messages with the block summary in subsequent requests. FileParts travel only inside the original messages — nothing references them after folding.
- **Pain points**: silent image loss at fold time; no recovery path; token accounting already ignores FileParts (out of scope here).

## 4. Proposed Architecture

- **Overview**:

```
message arrives (FilePart data-URL image ≥ minBytes)
        │
        ▼
hooks.ts transform handler, after FIRST assignMessageRefs
        │
        ├─► archiveSessionImages()          [lib/compress/image-archive.ts]
        │       decode → <storageDir>/images/<dirName(sid)>/<sha8(rawId)>-p<i>-<sha8(content)>.<ext>  (0o600, skip-if-exists)
        │       state.imageArchive[rawMsgId] += { path, mediaType, bytes }   (metadata only, persisted)
        │       state.stats.imagesArchived/imageBytesArchived += …
        │       (new archives ⇒ saveSessionState fire-and-forget)
        │
        └─► pruneImageArchive()             once per session state per process
                delete files older than ttlDays, drop index entries, rmdir empty dir

…later, model folds a range covering msg X…
        │
        ▼
range.ts summary chain (last step, before finalSummary):
appendArchivedImagePointers()  →  "- m00042: /abs/path/img.png (image/png, 24576 bytes)" lines
        │
        ▼
model sees pointer line in block summary → re-reads file with its own read tool
```

- **Key components**:
  - `lib/compress/image-archive.ts` (NEW leaf module, no new imports into barrel): pure helpers + three stateful ops, all failure-tolerant (per-file try/catch, warn-log, never throw — a request must never die because an archive write failed).
  - `SessionState.imageArchive`: `Record<rawMessageId, ArchivedImageEntry[]>`, persisted, sanitized on load.
  - Summary appendix: plain-text pointer lines appended by the existing protected-content machinery pattern (no new prompt file).
- **Data flow**: one-way. Pixels: memory → disk (once). Metadata: disk-backed state file ↔ SessionState. Wire: pointer text inside block summaries only. Nothing is read back by ACP itself — the MODEL reads the files.
- **API / interface changes**:
  - Config: `compress.images { enabled?: boolean = true, minBytes?: number = 16384, ttlDays?: number = 7 }` (top-level `compress` node only; excluded from provider/model override cascade like `reasoning`).
  - State file: optional `imageArchive` object + optional `stats.imagesArchived` / `stats.imageBytesArchived`; old files load unchanged.
  - Storage: new `<storageDir>/images/<dirName(sessionId)>/` tree.

## 5. Design Decisions & Rationale

| Decision | Options Considered | Chosen | Why |
|----------|--------------------|--------|-----|
| Recovery mechanism | (a) new ACP tool to fetch image bytes back into context; (b) inline base64 re-injection at prune time; (c) file-first: dump + pointer, model re-reads | (c) | Owner direction ("dump到一个文件，模型自己重新read") + BC-proven; (a)/(b) add tool/prompt surface and re-bloat the wire ACP exists to keep small |
| Spill timing | (a) eager at index time; (b) lazy at fold time | (a) | Fold-time would need the original bytes, which may already be gone (compaction/deletion) — eager guarantees availability; matches BC |
| Index key | (a) mNNNNN ref; (b) raw message ID | (b) | Refs re-issue on native compaction; raw IDs are stable, so the index needs no compaction-reset coupling. Stale pointer lines degrade exactly like existing mNNNNN refs in summaries while paths stay valid |
| Filename scheme | (a) ref-based; (b) `<sha8(rawId)>-p<i>-<sha8(content)>.<ext>` | (b) | Content salt makes skip-if-exists safe across re-issue (BC #2607 lesson); raw-ID prefix gives O(1) per-message lookup without scanning |
| MIME allowlist | all `image/*` vs binary-only set | png/jpeg/gif/webp/avif/bmp only | SVG is a scriptable TEXT format — persisting arbitrary SVG bytes to a host-readable path is a needless attack surface |
| Proactive offload of unfolded images | yes vs no (v1) | no | Model loses direct pixel view mid-task for marginal token savings; BC's cache-poisoning history (stripImages every turn on 3/4 wires) shows wire surgery is high-risk. Token release at fold time strictly improves today's loss |
| TTL sweep frequency | every turn vs once per process per session | once | Sweep is O(files) fs work; once-per-process is enough for a 7-day TTL and keeps the hot path free. Flag is transient (not persisted) so each process start re-sweeps |
| Override cascade | include in per-model overrides vs exclude | exclude | Archive location is session-scoped; cascading per-model would fork archive dirs and make pointers model-dependent |

## 6. Impact Analysis

- **Backward compatibility**: additive. Old state files load (optional fields); `compress.images.enabled=false` reproduces prior behavior exactly (no appendix, no I/O beyond the flag check). Internal `dcp-*` tags, block schema, and persisted formats untouched apart from the optional additions.
- **Performance**: per-turn pass does a linear scan of parts with string checks; disk writes only for NEW qualifying images (skip-if-exists via index + `existsSync`). Quality gate now sees slightly longer summaries when appendices present (consistent with other appendices).
- **Security**: files written 0o600 under the existing storage dir; SVG excluded; no network access; no new public API.
- **Cache behavior**: no change to prompt-cache strategy — archive work happens off-wire; the appendix only appears inside newly created block summaries (which were cache-churning events anyway).
- **Failure modes**: every fs operation wrapped; worst case = warning log + status quo (no archive, no pointer). TTL prune failures leave files behind (next sweep retries); empty-dir rmdir is best-effort.
