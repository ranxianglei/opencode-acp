# DESIGN — Canonicalize historical thinking wire shape

**Branch**: `2026-10-16_canonicalize-reasoning-shape`
**Issue**: [#482](https://github.com/ranxianglei/opencode-acp/issues/482) · 来源: billion-context#3301

## 1. Mechanism being fixed

The host serializer picks, **per request**, which field carries replayed
reasoning based on its CURRENT model-metadata table row
(`capabilities.interleaved` / `compatibility.reasoningField`). That choice is
not stored with the message. A metadata-table refresh therefore re-shapes every
historical thinking message's wire bytes without any model switch or config
change. Downstream identity (billion-context mints message ids from serialized
bytes) drifts wholesale; order-centric reconciliation cannot resync because each
thinking turn collapses from 2 cores to 1 and positional offset accumulates
monotonically.

Constraint derived: the fix must land at the **producer side** — the last
controllable boundary before serialization. That boundary is
`experimental.chat.messages.transform`.

## 2. Why normalize at the transform boundary

- Stored messages cannot be rewritten: state/DB format stays untouched, no
  migration, fork/compaction recovery paths unaffected.
- Every request re-runs the transform, so the pinned shape holds for the whole
  session lifetime regardless of how often the metadata table refreshes.
- The transform receives `WithParts[]` before host serialization — the only
  place where part-level control still exists.

## 3. Canonical form: tagged merge

Three candidates were evaluated:

| Option | Wire result | Id continuity | Verdict |
| ------ | ----------- | ------------- | ------- |
| Strip reasoning | text only | ids change (content lost) | rejected — loses information |
| Untagged merge (`{R}{T}`) | one text blob | kernel cannot recover split cores → different id space | rejected — breaks anchor continuity |
| **Tagged merge `<thinking>\n{R}\n</thinking>\n{T}`** | one text blob | kernel recovers split cores BEFORE identity derivation → byte-identical ids to the `reasoning_content` split form | **chosen** |

The tag is one of the demoted-thinking FORMS in the billion-context kernel
(`kernel/src/wire/demoted-thinking.ts`, verified against master 2026-10-16):

```ts
const FORMS = [
    { open: "\x3c\x3e\n", close: "\n\x3e\x3e" },        // plain angle-bracket dialect
    { open: "<thinking>\n", close: "\n</thinking>" },   // ← this one
    { open: "```thinking\n", close: "\n```" },          // fenced-code dialect
];
```

`splitDemotedThinking()` fires only when the tag opens at content offset 0 —
exactly where the synthesized part places it — consumes the single `\n` glue
after the close, and returns `{ reasoning, text }` cores that both wire forms
(normalized and split) converge to before `deriveMessageId`. Result: existing
anchors hit exactly, zero alias registration needed.

Join semantics mirror the host's own `lowerAssistantMessage`: all reasoning
parts concatenated with `""`, all text parts concatenated with `""`, then the
tag wrap. This parity is what makes the normalized wire mint the same ids the
split form minted.

Lockstep obligation: if the kernel FORMS list or glue handling ever changes,
`CANONICAL_OPEN`/`CANONICAL_CLOSE` in `lib/messages/reasoning-canonicalize.ts`
must change with it (byte-pinned unit tests exist to catch silent drift on our
side).

## 4. Pipeline placement

```
stripHallucinations
→ dropCompressReasoning        (#368, config-gated)   ← drops first
→ canonicalizeReasoningShape   (#482, new, unconditional)
→ applyMessageFilters
→ assignMessageRefs
→ … token accounting / prune / nudge / ref injection
```

- AFTER the #368 drop: oversized compress-call reasoning that the drop gate
  removed stays removed — the merge can only fold what survived the gate.
- BEFORE token accounting / pruning / ref assignment: every later stage sees
  the post-normalization array, so usage stats, candidate planning, and refs
  are computed over the stable bytes.
- Unconditional (no config gate): see §5 and §6 — the escape hatch lives in
  the competing PR #484 variant (`compress.reasoning.normalize`); owner decides
  which surface ships.

## 5. Scope: all assistant messages, no closed-turn gate

The #368 drop intentionally exempts the active round (in-flight thinking must
stay structured for the provider). The canonicalize pass deliberately has NO
such exemption, because its threat model is different:

An active turn's assistant message is serialized under metadata table M₁ while
active. If the table refreshes to M₂ before the round closes, the same message
re-serializes in a different shape once it becomes history — its id drifts at
exactly the moment it enters the ledger's anchoring domain. Exempting the
active round would therefore re-open the bug for the most recent turn of every
refresh window. Folding uniformly means a message carries one stable wire id
for its entire lifetime (active and historical), which is what the downstream
ledger needs.

Consequence (accepted): the model sees its own current-round thinking as tagged
inline text rather than a structured reasoning field. For openai-compat /
litellm lanes this is near-invisible (the field was usually dropped by the
relay anyway); for direct lanes requiring structured replay it is the known
boundary below.

## 6. Known boundaries

- **Direct Anthropic-native**: signed thinking blocks are not replayable as
  plain text; folding removes the structured field (and signature) from the
  previous assistant turn. Sessions pinned to such providers may need the
  escape-hatch variant (#484's `compress.reasoning.normalize: false`).
- **Gemini thoughtSignature**: same class — the signature rides the structured
  field, not the text.
- **openai-compat / litellm relays**: minimal impact; these lanes typically
  discard the reasoning field on replay, so the visible change is small and the
  stability gain is full.
- **Literal `<thinking>` in model prose**: if a text part itself begins with
  the tag, the kernel's multi-block loop treats it as an additional demoted
  block during recovery. Both wire forms undergo the identical recovery, so
  form-invariance (the property this fix buys) still holds; only the absolute
  id value differs from a hypothetical tag-free serialization — consistent
  across forms, which is all the ledger requires.

## 7. Determinism, idempotence, cache impact

- Pure function over the per-request parts arrays; no state reads/writes.
- Second run sees zero reasoning parts → zero mutations → prefix-cache bytes
  move exactly once per message, then stay stable.
- Token accounting now counts the merged text (same characters plus ~25 chars
  of tag overhead per thinking message) — previously counted reasoning parts
  are replaced by their folded copy; net drift is negligible and deterministic.

## 8. Cross-repo dependencies

- billion-context kernel `demoted-thinking.ts` FORMS list — lockstep (§3).
- billion-context#3301 — parent issue (re-anchor mismatch).
- billion-context#3316 — deterministic recovery of already-damaged ledgers
  (out of scope here).
- OpenCode 2.x lane — same change lands in billion-context
  `src/agent/opencode-native.ts` via a separate PR (repo policy §1.4).
