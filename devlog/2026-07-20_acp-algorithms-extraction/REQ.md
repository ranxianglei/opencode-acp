# REQ: ACP Algorithm Extraction (context-compress-algorithms)

## Background

`opencode-acp` is AGPL-3.0 (fork of DCP). The user wants to "hollow out"
a subset of the core algorithms — quality gate, compression-rules, trigger
policy — into a separate MIT-licensed package so that:

1. The algorithm implementations can be reused in non-AGPL contexts.
2. Users who reject AGPL can still use ACP's algorithm surface.
3. The algorithm code has a clean copyright trail (user-authored, no DCP
   lineage for quality gate; user-accepted risk for DCP-derived
   compression-rules and trigger).

Legal analysis (see issue dog/opencode-acp#30): moving AGPL code behind an
interface does not change its license — only clean-room rewrite fully
escapes. However, the user owns copyright on their modifications and
accepts the legal risk for DCP-derivative extraction.

## Scope (narrowed during iteration)

### Extracted

- **Quality gate** (`rouge-recall-v1` + tokenizer) — wholly user-authored
  in ACP v1.13.0, no DCP lineage. Clean copyright, free to dual-license.
- **`compression-rules.ts`** (`HOW_TO_COMPRESS_RULES`, `COMPRESS_PHILOSOPHY`)
  — user's most valuable original work per dog/opencode-acp#30.
- **Trigger policy** (`computeShouldNudge` + `resolveAdaptiveNudgeGrowth`)
  — DCP-derivative; user accepts legal risk.

### Restored to ACP (NOT extracted)

The 6 host-specific prompts (`system.ts`, `compress-range.ts`,
`compress-message.ts`, `context-limit-nudge.ts`, `turn-nudge.ts`,
`iteration-nudge.ts`) reference host tool names (`acp_status`, `compress`)
and are not general principles. Per user feedback in dog/opencode-acp#30,
these stay in ACP.

### Deferred (NOT extracted, user decision)

- GC truncate algorithm (`lib/gc/truncate.ts`)
- Dedup signature utilities (`createToolSignature` etc.)
- Generation promotion policy

User: "看起来剩下的不需要拆" (looks like the rest doesn't need extraction).

## Requirements

### Functional

1. Create a new MIT-licensed package `context-compress-algorithms`
   containing:
   - Quality gate implementation (`rouge-recall-v1` + tokenizer)
   - `compression-rules.ts` (HOW_TO_COMPRESS_RULES + COMPRESS_PHILOSOPHY)
   - Trigger policy (`computeShouldNudge` + `resolveAdaptiveNudgeGrowth`)

2. ACP keeps:
   - Public interface types (QualityGate, CompressionTriggerPolicy)
   - Singleton registries (registerX / getDefaultX / etc.)
   - Pipeline orchestration (evaluation, injection, store logic)

3. ACP wires `context-compress-algorithms` as a runtime dependency so
   default implementations are auto-registered on plugin init. Users
   install only `opencode-acp` and get working defaults.

4. External packages can register alternative implementations via the
   same registry API.

### Non-functional

- ACP test count: existing tests must still pass after extraction. Net
  decrease is acceptable for tests whose subject moved to cc-algorithms.
- `context-compress-algorithms` must have NO runtime dependency on
  `opencode-acp` (type-only via structural typing).
- Pure-refactor invariant: no behavioral changes except documented
  defensive fixes.

## Out of scope

- Public registration of alternative quality gates / trigger policies via
  `acp.jsonc` config (future work).
- Extracting `inject/utils.ts` beyond `computeShouldNudge` and
  `resolveAdaptiveNudgeGrowth`.
- npm publishing of `context-compress-algorithms` (deferred; local `file:`
  dependency for now — must be promoted to version range before next ACP
  release).

## Acceptance criteria

- [x] `context-compress-algorithms` package exists at
  `/home/dog/projects/context-compress-algorithms/`
- [x] `context-compress-algorithms` builds (`npm run build`) and tests pass
- [x] ACP typecheck passes
- [x] ACP tests pass (798/798)
- [x] ACP builds
- [x] `context-compress-algorithms` wired as ACP runtime dependency
- [x] Quality gate auto-registers from cc-algorithms
- [x] Compression-rules constants importable from cc-algorithms
- [x] Trigger policy auto-registers from cc-algorithms
- [x] Defensive fix: `retentionPct` div-by-zero guard uses
      `compressedTokens` (not `originalChars`); test added
- [x] Dual-agent equivalence review completed (oracle + sisyphus-junior);
      all 7 architecture checks passed, behavioral changes documented

## Legal note

The quality gate was wholly authored by `ranxianglei` in ACP v1.13.0 with
no DCP lineage — clean copyright, free to dual-license.

`compression-rules.ts` and the trigger policy ARE derivative works of DCP.
Extraction to a MIT package is a legal risk that the user explicitly
accepted in dog/opencode-acp#30. This devlog records that decision.
