# DESIGN - Strip leaked bare ACP message refs from completed assistant text

- Task ID: `2026-09-17_bare-ref-leak`
- Home Repo: `opencode-acp`
- Created: 2026-09-17
- Status: Accepted

## 1. Problem Statement

- **What problem are we solving?** Completed assistant text occasionally ends with a bare ACP ref + garbage tail (`m00057 <random multilingual text>`). The ref carries no tag, so the existing tag-only sanitizer in `experimental.text.complete` passes it through; the suffix is persisted to OpenCode's DB and re-enters later context and compression summaries (#431).
- **Why now?** Production reports across multiple models/providers; every occurrence permanently corrupts one persisted assistant message and degrades future context quality. The fix is small and provably safe.

## 2. Goals & Non-Goals

- **Goals**:
    - Strip the observed leak shape at completion time (before persistence) without touching legitimate prose that mentions refs.
    - Stay safe when session state is unavailable (soft-cap eviction, internal sessions) → degrade to today's behavior.
    - Zero new dependencies; pure string logic with full unit coverage.
- **Non-Goals**:
    - Changing ref injection (`injectMessageIds`) — IDs on past messages are load-bearing for compress boundaries.
    - Fixing model-side degeneration itself (uncontrollable; only containable).
    - Stripping echoes of ALREADY-assigned refs (below the next-to-allocate bound) — those may be legitimate citations.

## 3. Current Architecture (if applicable)

- **How it works today**: `index.ts` registers `experimental.text.complete: guard(createTextCompleteHandler())`. The handler runs `stripHallucinationsFromString(output.text)` which removes DCP/ACP XML tags via `DCP_PAIRED_TAG_REGEX` + `DCP_UNPAIRED_TAG_REGEX` (`lib/messages/utils.ts`). No session state is consulted; the factory takes no arguments.
- **ID allocation**: `assignMessageRefs` (each `messages.transform`) assigns refs sequentially from `state.messageIds.nextRef` (5-digit zero-padded); compressed blocks allocate from `state.prune.messages.nextBlockId`. Both counters are strictly monotonic per session and are reset consistently on compaction (`resetOnCompaction` rebuilds `messageIds` fresh while preserving `prune.messages`).
- **Pain points**: (1) bare refs are invisible to tag regexes; (2) the completing message does NOT yet have its own ref at `text.complete` time — assignment happens on the NEXT transform — so "look up this message's exact ref" (the issue's suggested approach) is impossible at hook time.

## 4. Proposed Architecture

- **Overview** (text diagram):

```
experimental.text.complete (per completed assistant part)
    │
    ├─► stripHallucinationsFromString(text)          # existing: paired/unpaired TAGS only
    │
    └─► registry.get(input.sessionID)?               # sync in-memory lookup, may miss
            ├─ state found → stripLeakedTrailingRefs(text,
            │       { nextMessageRef: state.messageIds.nextRef,
            │         nextBlockRef:   state.prune.messages.nextBlockId })
            │       single global-regex scan for LINE-LEADING bare mNNNNN/bN;
            │       first match with value >= its bound → truncate to end of string,
            │       trim trailing whitespace; warn-log with removedChars + tail preview
            └─ state missing → unchanged (today's behavior)
```

- **Key components**:
    - `stripLeakedTrailingRefs(text, bounds)` — new pure function in `lib/messages/utils.ts`; no side effects, no state access, fully unit-testable.
    - `createTextCompleteHandler(registry, logger)` — signature extended; wiring change only.
- **Data flow**: completion text → tag strip → future-ref strip → assigned back to `output.text`. One registry Map read per completion.
- **API / interface changes**: internal factory signature only (`createTextCompleteHandler` is not an exported public API of the package entry beyond plugin internals). No config keys added. No persisted-state changes.

## 5. Design Decisions & Rationale

| Decision | Options Considered | Chosen | Why |
|----------|--------------------|--------|-----|
| What identifies a leaked ref | (a) exact ref of completing message via `input.messageID` (issue suggestion); (b) future-ref bound (value ≥ next-to-allocate); (c) heuristic "last line looks like ref+garbage" | (b) | (a) is impossible at hook time — the completing message's ref is not assigned until the next transform; (c) is brittle and risks cutting real prose. (b) exploits a hard invariant: monotonic, non-reusing allocation ⇒ any value ≥ next-to-allocate cannot have been visible to the model, hence cannot be a legitimate citation. Zero false positives by construction. |
| Where in the line | Any position vs line-leading only | Line-leading only (`(?:^\|\n)[ \t]*`) | The observed degeneration starts a new line/paragraph; embedded mentions ("see m00042") must survive — the issue explicitly requires keeping legitimate older refs in prose. |
| Which formats match | Broad `\bm\d+\b` vs exact injected format | Exact injected format: lowercase `m` + 4–5 digits, lowercase `b` + non-zero digits | Only what ACP injects can be echoed as a self-ref; uppercase product codes (`M00057`) and arbitrary digit widths stay untouched. |
| Cut extent | Remove just the token vs truncate to end of string | Truncate from first qualifying match to end of string (+ trailing-ws trim) | After degeneration begins, everything after the first leaked ref is part of the garbage run (issue evidence); token-only removal would leave the multilingual tail. |
| Missing/unknown state | Throw/skip-strip vs fall back to tag-only | Fall back to tag-only (input unchanged by the new pass) | Safety over coverage: never crash or alter output when the ID space is unknown (registry soft-cap eviction, internal title/summary sessions). |
| State access path | `registry.getOrCreate()` vs `registry.get()` | `get()` (sync, no fetch) | `getOrCreate` requires a client fetch — wrong tool for a hot per-completion hook; a miss must simply mean "no extra stripping". |
| Regex instance | Module-level shared `/g` regex vs rebuilt per call | Rebuilt per call (`new RegExp(src, "g")`) | Global regexes carry mutable `lastIndex`; shared instances would corrupt concurrent/repeated scans. Cost is negligible (one small RegExp per completion). |

## 6. Impact Analysis

- **Backward compatibility**: full. No state format, config schema, persistence path, or public naming (`dcp` internal tags preserved) changes. Behavior delta limited to removing the degenerate tail when it occurs.
- **Performance**: O(text) single regex scan + O(1) Map lookup per completed part; negligible versus LLM round-trips. Regex rebuilt per call (microsecond-scale).
- **Security**: reduces prompt-injection surface slightly — leaked garbage no longer persists into future context/compression summaries. No new attack surface introduced.
- **Dependencies** (new packages required): none.

## 7. Migration Plan (if applicable)

- **Steps**: none required — ships as normal code; no flags, no data migration.
- **Feature flags / gradual rollout**: intentionally none (the strip is conservative and self-contained); rollback = revert commit.

## 8. Open Questions & Known Limitations

- [ ] If future reports show echoes of ALREADY-assigned refs (value < bound), consider a second, stricter pass (e.g., ref-on-last-line + non-prose tail heuristics). Not needed for the reported evidence.
- [ ] **Residual post-compaction window** (found in review): `resetOnCompaction` (`lib/state/utils.ts`) rebuilds `messageIds` fresh (`nextRef → 1`) when OpenCode compacts the session, so the invariant holds only *within a compaction epoch*. After a `/compact`, a stale pre-compaction ref echoed line-leading could numerically be ≥ the freshly-reset counter and be truncated. The window is narrow (requires compaction plus degenerate end-of-output behavior) and the cut content is still a trailing ref-led fragment, but if this ever matters, track a per-session high-water mark of allocated refs and use `max(nextRef, highWater)` as the bound. Deliberately not implemented here: it would add a persisted state field (backward-compat migration surface) for a corner case with no reported evidence.
