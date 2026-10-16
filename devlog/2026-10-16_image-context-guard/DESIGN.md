# DESIGN - Large-image context guard (metering + nudge + standing rule)

- Task ID: `2026-10-16_image-context-guard`
- Home Repo: `opencode-acp`
- Created: 2026-10-16
- Status: Accepted

## 1. Problem Statement

- **What problem are we solving?** ACP's context metering ignores image `file` parts
  entirely, so a large image read into context (issue #489: 2.4 MB, 3298×1642) inflates
  the real API bill by orders of magnitude while every ACP counter still reports ~0 —
  no nudge fires, ranges show no size, and the session dies without guidance.
- **Why now?** #478 (image disk archive) shipped pixel preservation on fold but the
  overflow itself remains unguarded; owner directive: "加上先压缩再读图片" (compress
  before reading images).

## 2. Goals & Non-Goals

- **Goals**:
  - Every token counter reports an image-appropriate estimate (vision-style when
    dimensions are parseable, bounded fallback otherwise).
  - A large image entering context mid-session triggers a one-shot strong directive to
    compress older ranges first.
  - A static system-prompt standing rule teaches proactive "make room before reading".
- **Non-Goals**: image downscaling/re-encoding; provider billing changes; V2 behavior.

## 3. Current Architecture (if applicable)

- **How it works today**: per-LLM-call transform pipeline in `lib/hooks.ts` runs
  metering (`getCurrentTokenUsage`), nudging (`injectCompressNudges` in
  `lib/messages/inject/inject.ts`), range recommendation
  (`buildCompressibleRanges`/`estimateContextComposition` in
  `lib/messages/inject/utils.ts`) — all counting text + tool-output chars only.
- **Pain points**: file parts contribute 0 to `countAllMessageTokens`,
  `countMessageCharacters`, `getCurrentTokenUsage` (primary path = last assistant usage,
  so a freshly-read image is invisible until the NEXT call, and even then only if the
  provider reports it); `computeProtectedRefs` counted them via `JSON.stringify`
  (base64 char count / 4 ≈ 300K for the issue's image) — inconsistent with all other
  counters and able to eat the whole protected-recent budget by itself.

## 4. Proposed Architecture

- **Overview**:

```
file part (data-URL image)
        │
        ▼
lib/compress/image-tokens.ts ── estimateImagePartTokens(part)
   ├─ parseImageDimensions (PNG/JPEG/GIF/WebP/BMP header scan, ≤256KB prefix)
   ├─ estimateVisionTokensForDimensions (1568 cap, 512 tiles × 167, max 16 tiles)
   ├─ fallbacks: unknown dims ≥256KB → 2672 ; <256KB → base64len/4
   └─ Map cache keyed mime:len:tail32 (cap 512)
        │ consumed by
        ├── lib/token-utils.ts        countAllMessageTokens / countMessageCharacters(×4)
        │                             getCurrentTokenUsage += pending-image delta
        ├── lib/messages/inject/utils.ts  estimateContextComposition.imageTokens
        │                             computeProtectedRefs (replaces JSON.stringify)
        ├── lib/messages/inject/inject.ts buildVisibleSegments; mNNNNN tags
        └── lib/compress/status.ts    acp_status breakdown + drilldown
lib/messages/large-images.ts ── detectNewLargeImages(messages,state,largeBytes)
   dedup key sha8(rawId):p{idx}:sha8(base64) → state.imageSurgeNudged (persisted, cap 512)
   formatLargeImageNotice(...) appended to the suffix message;
   sets state.nudges.shouldInjectThisTurn (via OR, does NOT pollute baseline/growth)
lib/prompts/extensions/system.ts ── IMAGE_GUARD_SYSTEM_EXTENSION (static, cache-safe)
   rendered iff compress.images.nudge !== false
```

- **Key components**:
  - `estimateImagePartTokens(part)` — single source of truth for image cost.
  - pending-image delta in `getCurrentTokenUsage` — closes the one-call blind window.
  - surge detection with persisted dedup — one notice per distinct image.
  - standing rule in system prompt — proactive behavior without dynamic prompt churn.
- **Data flow**: unchanged pipeline order; image estimation happens inside existing
  counter calls (no new pipeline step). Surge detection runs inside
  `injectCompressNudges` after the suffix message exists, BEFORE tier-trigger logic.
- **API / interface changes**: new config keys `compress.images.largeBytes` (number,
  default 524288, 0 disables) + `compress.images.nudge` (boolean, default true); new
  optional persisted field `SessionState.imageSurgeNudged`; `ContextComposition` gains
  `imageTokens`; `renderSystemPrompt` gains an optional 4th extension param.

## 5. Design Decisions & Rationale

| Decision | Options Considered | Chosen | Why |
|----------|--------------------|--------|-----|
| Where to make counters image-aware | patch each consumer vs fix shared source | fix `countMessageCharacters`/`countAllMessageTokens` at source | #359 parity invariant requires recommend-side and execute-side min-size counters to stay identical; patching consumers re-breaks it |
| Image cost model | raw base64/4 vs vision formula vs provider-specific | vision formula when dims parseable, bounded fallback otherwise | matches what vision providers actually bill; base64/4 for small unknowns stays conservative; hard cap prevents a single blob from dominating sizing |
| Header parsing | add image library dep vs hand-rolled | hand-rolled (PNG/JPEG/GIF/WebP/BMP) | zero new deps; only need width/height from ≤256 KB prefix; garbage must return undefined, never throw |
| Notice mechanism | new dedicated message vs reuse suffix message | append to existing suffix message | keeps one directive per turn; tier trigger yields to it that turn |
| Dedup scope | per-turn flag vs persisted record | persisted `state.imageSurgeNudged` keyed by message+part+payload hash | survives restarts; slot-prefix prefilter avoids hashing 3 MB payloads every turn |
| shouldInjectThisTurn wiring | set local `shouldInject=true` vs OR at assignment | OR at final assignment only | setting the local flag would poison `lastNudgeShownTokens`/baseline/growth machinery used by the nudge feedback loop |
| Standing rule placement | dynamic nudge text vs static system-prompt extension | static extension gated by config | Bug 19: dynamic system-prompt text busts prompt caches; a fixed paragraph is cache-safe |

## 6. Impact Analysis

- **Backward compatibility**: old persisted state loads fine (new field optional,
  validated on restore); config keys additive with defaults; internal `dcp*` tags
  untouched. Old bundles ignore nothing — no state-format break.
- **Performance**: per part O(1) after cache hit; header scan bounded to 256 KB prefix
  decoded once per unique payload; dedup prefilter makes repeated turns O(existing-keys)
  string-prefix checks before any hashing.
- **Security**: SVG excluded from archive extension map already; this change adds no
  network/host access; dimension parsing is pure byte inspection with length guards.
- **Dependencies** (new packages required): none.

## 7. Migration Plan (if applicable)

- **Steps**: none required — additive defaults. Users who want the old blind metering
  can set `compress.images.nudge: false` (standing rule off) and `largeBytes: 0`
  (surge notice off); metering itself cannot be disabled (it was wrong, not a feature).
- **Feature flags / gradual rollout**: `compress.images.nudge` gates both user-visible
  behaviors; metering fixes ship unconditionally.

## 8. Open Questions

- [ ] None blocking. Provider-specific billing variance (base64-as-text providers bill
  far more than the vision estimate) is why the notice warns explicitly rather than
  claiming an exact number.
