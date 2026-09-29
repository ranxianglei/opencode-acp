# DESIGN - #455 authored-set validation gating

- Task ID: `2026-09-29_v2-media-validation`
- Home Repo: `opencode-acp`

## Problem in one line

`validateFinalMessages` ran `AiMessage.make(...)` over every assembled outgoing message. On `@opencode/ai >= 2.0.18`, media is an `Asset`-instance nominal type that only the host's own module copy satisfies, so ACP's copy rejects valid host data and rolls the whole patch back.

## Design decision: validate by provenance, not by nominal schema

The invariant blanket validation was written to enforce is *"ACP never authors a malformed part."* That invariant only needs to apply to parts ACP actually wrote — never to provider-owned data ACP merely carried through. So gate validation on **who authored the outgoing message**, then pick the right check per authorship class.

### The authored set

An assembled outgoing message is ACP-authored iff it appears in exactly one of two collections at the call site (`applyV2ContextPatch`):

```ts
const authoredMessages = new Set<object>([
    ...replacements.values(),                     // ACP edits of host messages, or an insertion occupying an existing slot
    ...insertions.map((entry) => entry.message),  // fresh ACP insertions
])
```

This is provably the complete set of messages ACP mutated or created: `replacements` is populated by `setContentPart` (the only text/input/result mutator) and by insertion-slot occupancy; `insertions` holds fresh messages. Provider messages ACP never touched stay as the original objects and are excluded → skipped from nominal re-validation. This end-collection approach was chosen over threading an accumulator through `cloneAiMessage`/`setContentPart`/`makeInsertedMessage`: it is equivalent (those are the only mutation paths) with a smaller diff and fewer call sites.

### Per-message dispatch inside `validateFinalMessages`

For each final message in `authoredMessages`:

| Class | Discriminator | Check | Why safe |
|-------|---------------|-------|----------|
| Fully ACP-composed insertion | `isAcpOwnedId(id)` (message id matches `msg_(dcp_summary_\|dcp_text_\|acp_recap_\|acp_notice_)[0-9a-f]{16}`) | public `AiMessage.make(message)` (unchanged) | every part is ACP-authored text; no host media possible, so the nominal validator applies cleanly |
| ACP-cloned host message | else (host id) | delta check `validateAcpAuthoredParts(message)` | a clone mixes provider parts (media/metadata/tool results) with ACP text; nominal validation would trip over the provider parts, so validate only ACP's own parts |

A clone can only carry an ACP-owned *message* id if it is a clone-of-insertion (all-text content), which is why `isAcpOwnedId(id)` reliably routes to full `make`; host-derived clones always have host ids and go to the delta path. No media-containing message is ever routed to full `make`.

### The delta check (`validateAcpAuthoredParts`)

ACP-authored content parts always carry a deterministic part id (`prt_dcp_text_*` / `prt_dcp_summary_*`, minted in `lib/messages/utils.ts`). Provider parts never use these prefixes. So:

- for each content part whose id matches `isAcpAuthoredPartId`, require `contentType === "text"` **and** a string `text`; otherwise reject `invalid-schema`;
- all other parts (provider media, tool results, provider metadata) are trusted-valid and left untouched.

This restores precisely "ACP never authors a malformed part" without touching host-owned data. It also doubles as a defense-in-depth backstop on the assembled outgoing message.

## What deliberately does NOT change

- `duplicate-message-id` check (top of loop, runs for all messages).
- `duplicate-call-id` counting (per tool-result, runs for all messages).
- `invalid-tool-pair` checks (post-loop, over `mappedCallIds`/`removedCallIds`).
- `invalid-order` checks (in `sourceOrderIsMonotonic` / transformed-order validation, untouched).

## Compatibility

No persisted-state, config-schema, or internal `dcp` naming change. Two new functions exported from `patch.ts` for testing; the curated `../lib/v2/projection` barrel intentionally does NOT re-export them, so the public API surface is unchanged.
