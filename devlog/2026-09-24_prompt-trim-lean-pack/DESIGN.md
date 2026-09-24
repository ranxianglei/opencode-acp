# DESIGN - Lean prompt pack (`compress.promptPack`)

- Task ID: `2026-09-24_prompt-trim-lean-pack`
- Home Repo: `opencode-acp`
- Created: 2026-09-24
- Status: Accepted

## 1. Problem Statement

- **What problem are we solving?** The ACP standing prompt surface (system-prompt sections + five tool descriptions) is large, partially redundant, and fixed — there is no user-facing way to select a more compact surface, unlike billion-context-pi's lean mode.
- **Why now?** Issue #452. Long-context sessions amplify per-call prompt overhead; bcp proved the lean pattern works in production.

## 2. Goals & Non-Goals

- **Goals**:
    - Trim default surfaces ~20% without weakening load-bearing contracts (phase 1).
    - Ship an opt-in `"lean"` pack: condensed system prompt + one-line tool descriptions (phase 2).
    - Keep the existing three-level prompt file override system working above any pack.
- **Non-Goals**:
    - Per-provider/per-model pack scoping (bcp has it; deferred to v2 if demanded).
    - User-defined packs from directories (`<dir>/<name>.json` like bcp's pack sources).
    - Changing nudge thresholds, GC, or compression semantics.
    - Message-mode compress prompts (`lib/prompts/compress-message.ts`) are intentionally pack-independent: `mode:"message"` + `promptPack:"lean"` combines the lean system prompt and lean tool descriptions with the full default message-mode compress prompt.

## 3. Current Architecture

- `PromptStore` (lib/prompts/store.ts) owns the five editable prompts (system, compress-range, context-limit-nudge, turn-nudge, iteration-nudge) with file overrides at project > config-dir > global levels; `getRuntimePrompts()` returns the resolved strings (wrapped in reminder tags except compress-range).
- Tool descriptions were hard-coded constants inside each factory module (`lib/compress/decompress.ts`, `search.ts`, `status.ts`, `recap.ts`); only the compress tool was store-driven (`runtimePrompts.compressRange + RANGE_FORMAT_EXTENSION`).
- The system hook renders `renderSystemPrompt(...)` on every message-transform pass.

Pain points: no pack concept; descriptions unreachable by override/trim logic; redundancy across surfaces (same rules in system prompt AND tool descriptions AND nudges).

## 4. Proposed Architecture

```
config.compress.promptPack ──► index.ts ──► new PromptStore(..., promptPack)
                                                      │
        getBundledEditablePrompts(candidates, pack) ◄─┘   (packs.ts selectors)
                                                      │
                          RuntimePrompts {…existing…, decompressDescription,
                                searchContextDescription, acpStatusDescription,
                                acpContextRecapDescription}
                                                      │
   createAcpStatusTool / createDecompressTool / … read their description
   from factoryCtx.prompts.getRuntimePrompts() at creation time
```

- **New module `lib/prompts/packs.ts`** (pure functions, no I/O, no state):
    - `PromptPackId = "default" | "lean"`; `PROMPT_PACK_IDS`.
    - `DEFAULT_*` description constants — moved VERBATIM out of the four tool files (single source of truth now lives here; regression-guarded by byte-equality tests).
    - `LEAN_*` descriptions + `LEAN_HOW_TO_COMPRESS` — adapted from acp-kernel (MIT, same author) `src/packs.ts`; provenance comment in-file.
    - `buildLeanSystemPrompt(candidatesEnabled)` — compact ACP TAGS bullets, condensed SUMMARIES section, LEAN_HOW_TO_COMPRESS, one-line tier guidance, one-line breakdown categories; candidates variant adds MICRO/EPISODE bullet.
    - `buildLeanCompressRangePrompt(candidatesEnabled)` — boundary-ID/auto-detect/batching/marker rules in tight form.
    - `getToolDescriptions(pack)` → the four description strings; `buildPackSystemPrompt` / `buildPackCompressRangePrompt` selectors used by the store.
- **Precedence (unchanged mechanism, new layer)**: user file override > pack text > bundled builder output. Overrides flow through the existing `wrapRuntimePromptContent` path, so wrapping/trimming behaves identically for both packs.
- **Config**: `compress.promptPack` is GLOBAL ONLY — deliberately omitted from `CompressOverridableConfig` because the prompt surface is session-wide (one rendered system prompt per session, regardless of which provider/model serves a given call). Validated as enum in `validateConfigTypes`; declared in `dcp.schema.json`.
- **Why factories read from the store instead of receiving strings directly**: `ToolFactoryContext` already carries the `PromptStore` and factories already call `reload()`; adding a separate description channel would duplicate lifecycle handling. Reading at creation time (not per execute) keeps the hot path untouched.
- **Why `RANGE_FORMAT_EXTENSION` is shared**: the JSON wire shape is identical for both packs; only surrounding prose differs. Duplicating the format block would risk drift between packs.

## 5. Load-bearing Content Guardrails

Per acp-kernel's design doc, four rule classes must never be silently degraded: COMPRESS_PHILOSOPHY, HOW_TO_COMPRESS_RULES, TIER2_DISTILL_RULES, TIER3_CONDENSE_RULES.

- Default pack: HOW_TO_COMPRESS_RULES from `context-compress-algorithms` is UNTOUCHED; phase 1 trims only surrounding chrome/duplication.
- Lean pack: replaces it with `LEAN_HOW_TO_COMPRESS`, which preserves every class (KEEP VERBATIM list, DROP rules, CONTENT one-liners, PRIORITY order, format rules) plus the INTEGRITY/PENDING anti-fabrication rule added after the session-01a09989 fabrication incident.
- Tests pin the presence of these classes in the lean text (`tests/prompt-packs.test.ts`) so a future edit cannot silently drop them.

## 6. Risks & Mitigations

| Risk                                                         | Mitigation                                                                                                                  |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Model behavior shifts under lean (less repeated instruction) | Opt-in only; lean text is the kernel's production-proven contract; e2e lean scenario flagged as follow-up (WORKLOG §6).     |
| Default-surface trim removes something a model relied on     | Every load-bearing line kept verbatim; 16 new tests + full suite; size deltas disclosed per-surface (WORKLOG §4).           |
| Pack/override interaction surprises                          | Integration test asserts override beats lean and non-overridden surfaces stay lean; ensureDefaultFiles pinned to "default". |
| Future drift between DEFAULT_* copies and old locations      | Old constants deleted; byte-equality regression test against expected strings.                                              |

## 7. Alternatives Considered

- **Directory-loaded user packs (bcp parity)**: more flexible but adds filesystem layout, naming validation, and sanitization surface for a v1 that needs exactly two presets. Deferred; packs.ts selector design leaves room to add a resolver later without changing the store interface.
- **Trimming nudges further (remove JSON skeletons)**: rejected — the skeleton is the one thing a model copying-from-memory needs most at the moment of highest context pressure.
- **Per-model pack overrides**: rejected for v1 — one session renders one system prompt; per-model scoping would require re-rendering mid-session and complicates prefix caching.
