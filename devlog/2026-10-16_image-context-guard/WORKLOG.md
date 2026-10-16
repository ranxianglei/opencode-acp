# WORKLOG - Large-image context guard (metering + nudge + standing rule)

- Task ID: `2026-10-16_image-context-guard`
- Home Repo: `opencode-acp`
- Status: InProgress
- Updated: 2026-10-16

## 1. Summary

**Status: Done** — all targeted tests green; awaiting CI + dual-agent review.

- **What was done** (1–3 sentences): Made all ACP token counters image-aware via a new
  vision-style estimator (`lib/compress/image-tokens.ts`), added a one-shot "large image
  just entered context — compress older ranges first" notice
  (`lib/messages/large-images.ts`) wired into `injectCompressNudges`, and added a static
  IMAGE HANDLING standing rule to the system prompt. New config keys
  `compress.images.largeBytes` / `.nudge`.
- **Why** (1–3 sentences): Issue #489 — a 2.4 MB / 3298×1642 image read into context
  killed the session because metering reported ~0 for image parts, so no nudge ever
  fired and ranges showed no size. Owner directive: compress before reading images.
- **Behavior / compatibility changes**: Yes (intended, disclosed):
  - All counters now include an image estimate for data-URL image `file` parts
    (previously 0 everywhere except `computeProtectedRefs`, which used base64 chars/4).
  - `getCurrentTokenUsage` adds a pending-image delta for images arriving after the last
    assistant message with usage data (compaction-epoch = 0 semantics preserved).
  - `acp_status` breakdown line gains an always-shown `images` category; drilldown sizes
    include image tokens.
  - Context breakdown in nudges gains the same category.
  - Visible-segment ranking no longer marks image-only messages as tool segments.
  - `ContextComposition` type gains `imageTokens`.
  - System prompt gains a static paragraph when `compress.images.nudge !== false`.
- **Risk level**: Medium (counter semantics change, but the old values were wrong;
  state format change is additive/optional).

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| _(pending — single implementation commit + devlog)_ | |

### Key Files

- `lib/compress/image-tokens.ts` — NEW: dimension parsing (PNG/JPEG/GIF/WebP/BMP),
  vision-token formula, bounded fallbacks, cached `estimateImagePartTokens(part)`.
- `lib/messages/large-images.ts` — NEW: surge detection with persisted dedup
  (`state.imageSurgeNudged`) + notice formatting.
- `lib/token-utils.ts` — counters image-aware; exported `countPendingImageTokens`;
  primary usage path += pending delta.
- `lib/messages/inject/utils.ts` — `imageTokens` composition category; protected-recent
  refs use vision estimate instead of JSON.stringify.
- `lib/messages/inject/inject.ts` — surge notice block (gated by config), OR-wired
  `shouldInjectThisTurn`, tier trigger yields to notice, visible segments image-aware.
- `lib/compress/status.ts` — acp_status overview breakdown + drilldown include images.
- `lib/config.ts` / `lib/config-validation.ts` / `dcp.schema.json` — new keys
  `largeBytes` (default 524288) + `nudge` (default true), validated.
- `lib/state/{types,state,persistence}.ts` — persisted `imageSurgeNudged` map
  (create/reset/restore/save), mirroring #478's `imageArchive` pattern.
- `lib/prompts/extensions/system.ts` / `lib/prompts/index.ts` / `lib/hooks.ts` —
  `IMAGE_GUARD_SYSTEM_EXTENSION` rendered when nudge enabled.
- `lib/compress/image-archive.ts` — `sha8` export made public (dedup keys reuse it).
- Docs: `CONFIGURATION.md`/.zh-CN.md, `README.md`/.zh-CN.md default-config sections.

## 3. Design & Implementation Notes

- **Entry point / key function**: `estimateImagePartTokens(part)`
  (`lib/compress/image-tokens.ts`) — consumed by every counter; see DESIGN.md §4 flow.
- **Key configuration items**: `compress.images.largeBytes` (524288 default; 0 disables
  surge notice), `compress.images.nudge` (true default; false also removes the system
  prompt rule).
- **Key logic explanation** (if non-trivial): vision formula scales the longest side to
  ≤1568 px keeping aspect, counts 512-px tiles × 167 tokens capped at 16 tiles (2672);
  unknown dimensions fall back to 2672 for ≥256 KB payloads and base64len/4 below that.
  Dedup uses a slot prefix `sha8(rawId):p{partIndex}:` checked against existing keys
  BEFORE hashing the payload, so steady-state turns never re-hash multi-MB base64.

## 4. Testing & Verification

### Build & Test Commands

```sh
# Build
cd opencode-acp && npm run build

# Run specific test files (targeted — full suite runs in CI)
node --import tsx --test tests/image-tokens.test.ts
node --import tsx --test tests/image-metering.test.ts
node --import tsx --test tests/image-nudge.test.ts
node --import tsx --test tests/config-validation.test.ts

# Type check
npm run typecheck
```

### Test Coverage

- New/modified test files: `tests/image-tokens.test.ts` (11), `tests/image-metering.test.ts`
  (10), `tests/image-nudge.test.ts` (4, multi-turn per AGENTS.md §5.7 with
  preserveRecentMessages: 20), extended `tests/config-validation.test.ts` (+2), updated
  `tests/image-archive.test.ts` fixture to the widened `CompressImagesConfig`.
- Test count: 25 new tests in the three new files + 2 extended validation cases;
  affected-scope regression batch (19 files covering counters/nudges/ranges/status/e2e/
  persistence/candidates/smart-plan): 286 pass / 0 fail.
- Key scenarios verified:
  - dimension parsing per format (PNG/JPEG/GIF/WebP VP8|VP8L|VP8X/BMP) + garbage/truncation safety
  - 3298×1642 → 1336 tokens; tile cap 2672; fallbacks (≥256KB → cap, <256KB → b64/4)
  - pending-image delta in getCurrentTokenUsage incl. compaction-epoch still returns 0
  - countMessageCharacters est×4 parity (feeds #359 min-size on both sides)
  - composition imageTokens included in total
  - protected-recent budget no longer blown by one large image
  - one-shot notice dedup across turns, compress-turn suppression, re-fire next plain turn
  - config gates (nudge:false / largeBytes:0) and system-prompt standing rule on/off

### Results

- **PASS/FAIL**: PASS — 25/25 new, 286/286 affected-scope, typecheck clean, build clean.
  Full suite runs in CI (local full-suite runs are out of policy).

## 5. Risk Assessment & Rollback

- **Risk points**: counter value shifts for image-bearing sessions (intended fix);
  acp_status output format change (additive segment); system prompt length +~60 words.
- **Rollback method**:
  - Revert commit(s): _(pending sha)_
  - Rollback impact: none — state field optional both directions.
- **Compatibility notes** (data format, config schema): Yes — additive only
  (`imageSurgeNudged` optional in persisted state; two new optional config keys).

## 6. Lessons Learned (optional)

- The #359 parity invariant (recommend-side vs execute-side min-size counters must use
  the same source) means any new content class has to be added at the shared counter,
  not patched per consumer.
- Buffer methods do not exist on plain `Uint8Array` — use `DataView` with explicit
  endianness when parsing headers from decoded base64.
- Synthetic-header tests caught two real parser bugs before merge: WebP VP8L packs
  width/height across THREE bytes after the signature byte (the height's upper bits
  live in the third one), and pre-#489 persisted state lacks `imageSurgeNudged` so the
  dedup map needs lazy healing (`??=`), not an assumption of presence.

## 7. Follow-ups (optional)

- [ ] Consider extending `ArchivedImageEntry` with parsed width/height so archive
      pointers can advertise size without re-reading the file (separate issue if pursued).

## 8. Master merge (conflict resolution for PR #490)

Merged `master` (98a16d5b, includes #486 emergency-truncation-switch, #487
release v1.18.5, #488 sticky-truncation-hardening) into this branch. Conflicts
in `lib/state/types.ts`, `lib/state/state.ts`, `lib/state/persistence.ts`: both
sides appended new `SessionState` fields at the same spots — kept BOTH
(`imageSurgeNudged` from #489 and `stickyTruncations` from #485/#486) in all six
hunks (interface decl, createSessionState init, resetSessionState, persistence
restore, PersistedSessionState interface, toPersistedState). No behavior change
beyond adding master's features to this branch. Verified: typecheck clean,
targeted tests (image-*, emergency-truncation-switch, truncate-tools,
persistence, compress-state) 97/97 pass.

## 9. Review hardening (independent review of PR #490)

- `parseImageDimensions` VP8 branch read width/height without verifying the
  frame tag (every other format checks its magic). A corrupt `VP8 ` chunk
  could yield plausible-looking garbage dims. Added the 9D 01 2A check at
  chunk-payload offset 3 — the real cwebp layout, cross-checked against
  probe-image-size / fumadocs image-size parsers and cwebp sample output —
  so corrupt chunks now fall back to the size-based estimate. The old
  comment ("Frame tag (3) + start code (3)") mislaid the tag at offset 0;
  corrected.
- `tests/image-nudge.test.ts`: added `lastPerMessageNudgeTokens` assertions
  after every turn of the multi-turn cycle (AGENTS.md §5.7.1 side-effect
  requirement) — pins that the image notice never touches the per-message
  nudge baseline.
- New test: corrupt VP8 frame tag → `parseImageDimensions` returns undefined.
