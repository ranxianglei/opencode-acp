# REQ — Canonicalize historical thinking wire shape

**Branch**: `2026-10-16_canonicalize-reasoning-shape`
**Issue**: [#482](https://github.com/ranxianglei/opencode-acp/issues/482)
**Source**: 来源: [billion-context#3301](https://github.com/ranxianglei/billion-context/issues/3301) 分析「元数据刷新后已折叠内容 re-anchor 认不回来」时发现

## Problem

The wire shape of historical assistant thinking is decided by the OpenCode host at
request time from its CURRENT model-metadata table (`interleaved` /
`compatibility.reasoningField` in models.dev data): reasoning may land in a
`reasoning_content`-style field, be renamed, or be merged into `content` depending
on which metadata row is active. The two fields are never stored with the message.

Downstream, billion-context mints message identity hashes from the serialized bytes.
A metadata-table refresh therefore re-mints every thinking message's id overnight —
with no model switch, no config change — and folded history can no longer be
re-anchored (`[fold-reconcile] resent history drifted: N covered id(s) missing`).
Reported scale: 986 missing ids on one session; observed on opencode 1.19.0 and
2.0.24 alike.

Order-centric reconciliation (billion-context KDD #11) survives re-encoding and id
re-minting but NOT re-shaping: each thinking turn changes from 2 cores (reasoning +
text) to 1 core (merged), so positional offset accumulates monotonically and resync
(3 consecutive same-index agreements) becomes impossible once the offset persists.
The churn class is outside the order ladder's survival domain by construction.

## Requirement

Normalize the input to the host serializer so the output becomes deterministic:
in `experimental.chat.messages.transform`, merge every assistant message's
reasoning parts into ONE canonical tagged text part before hand-off. After the
transform the message carries no reasoning parts, so host serialization can no
longer depend on the metadata table — the wire shape (and thus the downstream id
space) is stable across metadata refreshes, host versions, and provider configs.

### Canonical form

`<thinking>\n{reasoning}\n</thinking>\n{text}` — the `<thinking>` variant of the
demoted-thinking FORMS list in the billion-context kernel
(`kernel/src/wire/demoted-thinking.ts`). Chosen because the kernel recovers this
tagged-inline form back into the split reasoning/text cores BEFORE identity
derivation — i.e. the canonical form mints exactly the same ids as the split
`reasoning_content` form, preserving continuity with existing anchors without any
alias registration. Untagged merge rejected (breaks id continuity); stripping
rejected (loses information).

## Scope

- New module `lib/messages/reasoning-canonicalize.ts` (pure function over
  `WithParts[]`, barrel-exported).
- One pipeline step in `lib/hooks.ts`, placed after the #368
  `dropCompressReasoning` step (oversized compress-call reasoning is dropped first,
  never merged) and before token accounting / pruning / ref assignment.
- No new config surface, no persisted-state format change, no version bump.

## Out of scope

- OpenCode 2.x lane — served by billion-context's own native plugin
  (`src/agent/opencode-native.ts`), separate PR per repo policy §1.4.
- Recovery of already-damaged ledgers — billion-context#3316 (deterministic
  recovery from stored decompositions + import entry).
- Non-plugin client lanes (no transform boundary exists there).

## Acceptance criteria

1. Assistant message with reasoning parts → single canonical tagged text part,
   exact bytes `<thinking>\n{R}\n</thinking>\n{T}` (tag-only when no text).
2. Non-text/non-reasoning parts (tool, image, file) preserved in original relative
   order; synthesized part reuses the first folded part's id.
3. Deterministic and idempotent: a second pass normalizes nothing (prefix-cache
   byte stability).
4. Empty-string-only reasoning → untouched. Non-assistant messages → untouched.
5. typecheck + targeted tests + build green; devlog complete; PR references #482.
