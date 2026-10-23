# REQ - Strip leaked bare ACP message refs from completed assistant text

- Task ID: `2026-09-17_bare-ref-leak`
- Home Repo: `opencode-acp`
- Created: 2026-09-17
- Status: InProgress
- Priority: P1
- Owner: ranxianglei
- References: https://github.com/ranxianglei/opencode-acp/issues/431 ; related #123 / #130 (tag-fragment sanitization)

## 1. Background & Problem Statement

- **Context**: ACP injects `<dcp-message-id ...>mNNNNN</dcp-message-id>` annotations into every visible message so the model can reference messages by short ref (`mNNNNN`) and compressed blocks by `bN` in `compress` calls. The `experimental.text.complete` hook sanitizes finished assistant text via `stripHallucinationsFromString` (`lib/messages/utils.ts`), which removes complete or incomplete DCP/ACP **tags** (`DCP_PAIRED_TAG_REGEX`, `DCP_UNPAIRED_TAG_REGEX`).
- **Current behavior (symptom)**: Assistant completions occasionally end with a **bare ref + garbage** fragment, e.g.:
    ```text
    Normal assistant progress message.

    m00057 <unrelated random multilingual text>
    ```
    The fragment carries no tag, so the tag-only sanitizer passes it through. The suffix is persisted into the assistant message in OpenCode's DB and can re-enter later model context and compression summaries. Observed across multiple models/providers (issue #431).
- **Root cause layering**:
    1. _Model side (intermittent trigger)_: at the end of generation the model degenerates and echoes the ID-annotation pattern it saw on the last visible message. Crucially, refs are allocated monotonically during the **next** `messages.transform` — the completing message does not yet have its ref assigned — so the echoed value is what will become the current message's own ref (matches issue evidence "the leaked reference matches the affected assistant message").
    2. _ACP side (fixable gap)_: no defense against bare (tag-less) refs in `text.complete`. This task fixes layer 2 only; layer 1 is model behavior we cannot control, only contain.
- **Impact**: corrupted persisted assistant output; user-visible garbage suffixes; pollution of future context/compression summaries.

## 2. Reproduction

- **Environment**: any ACP-enabled multi-turn session (model-side leak is intermittent, not deterministic)
- **Deterministic reproduction of the ACP-side gap** (unit level):
    ```ts
    stripHallucinationsFromString("Normal progress.\n\nm00057 random tail")
    // === "Normal progress.\n\nm00057 random tail"  ← unchanged, leak survives
    ```
- **Relevant configuration**: none required (default config); `debug: true` will log each strip with session/message IDs.

## 3. Constraints & Non-Goals

- **Constraints**:
    - MUST NOT broadly delete all `mNNNNN` strings from output — users may legitimately discuss refs in prose (issue #431 explicit requirement).
    - No new dependencies; pure string logic (testable without SDK/state side effects).
    - Must stay safe when session state is unavailable (registry miss after soft-cap eviction, internal title/summary sessions) → fall back to today's tag-only behavior.
    - Internal `dcp` naming preserved (Section 2.6 backward-compat rule).
- **Non-Goals**:
    - Not changing how/where refs are injected (`injectMessageIds`) — removing IDs from assistant messages would break compress-boundary references to past turns.
    - Not fixing model-side degeneration itself.
    - Not stripping bare refs that were _already assigned_ (below next-to-allocate) — those may be legitimate citations; the reported self-echo case always produces an unassigned (future) value.

## 4. Acceptance Criteria

- **Correctness**:
    - [ ] Trailing line-leading bare ref whose value ≥ `messageIds.nextRef` is truncated (with its preceding newline), trailing whitespace trimmed — the #431 repro shape.
    - [ ] Same for block refs `bN` with value ≥ `prune.messages.nextBlockId`.
    - [ ] Boundary: value exactly equal to next-to-allocate IS stripped (it does not exist yet).
    - [ ] Existing refs (value < next-to-allocate) are never stripped — neither inline ("see m00042") nor line-leading.
    - [ ] Mid-line future refs are NOT stripped (line-leading requirement protects prose like "between m00056 and m00999").
    - [ ] Uppercase/other-case forms (`M00057`, `B5`) untouched (only exact injected lowercase format matches).
    - [ ] Unknown ID space (no state / null bounds) → text unchanged except existing tag stripping.
    - [ ] Existing tag stripping (paired + unpaired) unchanged.
- **Performance / Stability**:
    - [ ] Full test suite passes; typecheck + format clean.
    - [ ] `text.complete` handler stays O(text) single-pass regex scan; one in-memory registry lookup per completion.
- **Regression tests** (per issue #431 list item 4):
    - [ ] Complete tags stripped
    - [ ] Incomplete opening/closing tags stripped
    - [ ] Bare current-message (self) ref at end of response stripped
    - [ ] Legitimate references to older `mNNNNN` IDs in normal prose survive

## 5. Proposed Approach

- **Affected modules & entry files**:
    - `lib/messages/utils.ts` — new pure function `stripLeakedTrailingRefs(text, { nextMessageRef, nextBlockRef })`: single global regex scan for LINE-LEADING bare refs (`^|\n` + optional `[ \t]` + `m\d{4,5}` or `b[1-9]\d*`); first occurrence whose numeric part is ≥ the corresponding next-to-allocate bound triggers truncation from that match start to end of string (trailing whitespace trimmed). Both bounds invalid → return input unchanged.
    - `lib/hooks.ts` — `createTextCompleteHandler(registry, logger)`: after existing `stripHallucinationsFromString`, look up live state via `registry.get(input.sessionID)` (sync, no client fetch) and apply `stripLeakedTrailingRefs` with `state.messageIds.nextRef` and `state.prune.messages.nextBlockId`; warn-log on strip.
    - `index.ts` — pass `registry` + `logger` into the factory.
    - `tests/leaked-trailing-ref.test.ts` — new regression suite (pure function + handler level).
- **Why "future ref" is safe**: refs/block IDs are strictly monotonic (allocation never reuses below `nextRef`/`nextBlockId`; compaction reset rebuilds both consistently). Any output generated before value V existed cannot legitimately cite V, so stripping V+ from a completion's tail has zero false-positive risk against real citations while covering exactly the observed self-echo signature.
- **Risks**: a variant where the model echoes an _already-assigned_ ref (e.g. the last visible one) is NOT covered — deliberately, since that value could be a legitimate citation and the issue's persisted-state evidence points at the unassigned-self-ref case. Documented as known limitation.
- **Rollback strategy**: Revert the single commit; no state format, persistence, or API changes.
