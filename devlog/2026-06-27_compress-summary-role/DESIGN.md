# DESIGN: Merge compression summary into following user turn (Bug 36)

- Task ID: `2026-06-27_compress-summary-role`

## 1. Problem (data-flow level)

Every LLM call runs the message-transform pipeline (`lib/hooks.ts` → `prune` → `filterCompressedRanges`). For each active compression block, the pruned range is replaced by a synthetic summary message. Prior to this change that message was unconditionally `role: "user"`, placed at the start of the range.

Flow before:

```
raw: [u1(user), a1(asst), u2(user), a2(asst)]   block covers u1,a1
  → prune → [SUMMARY(user), u2(user), a2(asst)]
```

Two consecutive user-role historical messages. The model read the recap (containing the assistant's prior output) as a user turn → self-Q&A / role confusion.

## 2. Constraint discovery (why not adaptive role)

`@opencode-ai/sdk/v2` `AssistantMessage` requires fields absent from `UserMessage`: `parentID, modelID, providerID, mode, path, cost, tokens{...}`. The codebase creates **zero** synthetic assistant messages today. Fabricating these fields is unverifiable downstream (token accounting — which this plugin itself depends on — cost tracking, message-tree integrity). For a stability-focused plugin this risk is unacceptable. ⇒ Adaptive-role approach (emit `role: "assistant"` summaries) rejected.

## 3. Chosen design — forward merge (Option F)

Decision rule inside `filterCompressedRanges`, computed per active block:

```
nextSurviving = first non-pruned message at/after the block's anchor index

if nextSurviving is role "user":
    prependCompressionSummary(nextSurviving, summary, blockId)
    // no new message emitted; the recap rides inside the user's real turn
else (assistant, or no following message):
    prior behavior — emit a standalone role:"user" synthetic message
    (includes the [FIX Bug 1] fallback for "no preceding user message")
```

Flow after:

```
raw: [u1(user), a1(asst), u2(user), a2(asst)]   block covers u1,a1
  → prune → [u2'(user = "[recap...]\n\nHow are you?"), a2(asst)]
```

Single user turn. No fake conversational turn is perceived; the self-Q&A loop has no structural trigger.

### Why this is safe

- Transform is **transient**: rebuilt from raw session state every LLM call. `prune.ts` already mutates message text and tool outputs in-place per pass (e.g. `PRUNED_TOOL_OUTPUT_REPLACEMENT`). Prepending recap text is the same kind of transient mutation — nothing is persisted, decompress/recompress operate on raw state and never observe the merge.
- **Cache**: compression already breaks strict prefix cache at the compression point regardless; merging changes one message's content vs. inserting one new message — equivalent cache impact.
- **No new message shapes**: stays entirely within user-role territory. No fabricated `AssistantMessage` fields.

## 4. Idempotency & multi-block edge case

`prependCompressionSummary` uses a block-id-scoped delimiter:

```
[ACP compressed context summary (block <id>) — prior conversation recap]
<summary>
[End ACP compressed context summary]

<original user text>
```

- If the block's marker is already present in the target text part, the prepend is a no-op (returns false) → the caller falls back to a standalone message. This guards against any re-entry.
- When two adjacent blocks share the same following user message, each gets its own delimited entry prepended (acceptable: both are valid recaps, each block-scoped).

## 5. What does NOT change

- Compression block data model, `CompressionBlock` shape, persistence.
- GC truncation (`gc/truncate.ts`) — touches summary length, not placement/role.
- Decompress/recompress — keyed off block state and the `msg_dcp_summary_` id prefix; role/placement-agnostic.
- The suffix-guidance nudge (`lib/messages/inject/inject.ts` → `createSuffixMessage`) — still a standalone `role: "user"` message at the end of the array. Its id also uses the `msg_dcp_summary_` prefix (deterministic seed `acp-dynamic-guidance`); tests must distinguish the two by content, not prefix.
- `createSyntheticUserMessage` signature — unchanged (still used by the non-merge fallback path and by the suffix nudge).

## 6. Alternatives considered

| Option                                           | Verdict                                                                                       |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| A. Adaptive role (`assistant` when next is user) | Rejected — requires fabricating full `AssistantMessage` fields; unverifiable downstream risk. |
| B. Merge into following user msg unconditionally | Subsumed by F (F only merges when next is user, preserving status quo otherwise).             |
| D. Summary role = role of range's first message  | Rejected — still collides with the following user in the exact reported pattern.              |

## 7. Test impact

- No test previously asserted the summary's role was `"user"`.
- One e2e test asserted a standalone `msg_dcp_summary_` message existed for a block followed by a user turn — updated to assert the merge (content-based, see §5).
- Added a structural regression test asserting no two adjacent historical user-role messages after any compression pass.
