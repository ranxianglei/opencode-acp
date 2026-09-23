# REQ - Reduce standing prompt surfaces; add lean prompt pack

- Task ID: `2026-09-24_prompt-trim-lean-pack`
- Home Repo: `opencode-acp`
- Created: 2026-09-24
- Status: Done
- Priority: P1
- Owner: ranxianglei
- References: issue https://github.com/ranxianglei/opencode-acp/issues/452 ; style reference https://github.com/ranxianglei/billion-context-pi (lean pack lives in `acp-kernel/src/packs.ts`, MIT)

## 1. Background & Problem Statement

- **Context**: Every LLM call in an ACP session pays the standing prompt surface: the rendered ACP system-prompt sections plus the five registered tool descriptions (`compress`, `decompress`, `search_context`, `acp_status`, `acp_context_recap`). This is pure overhead that grows with session length.
- **Current behavior (symptom)**: Measured standing surface (Anthropic tokenizer, candidates-off mode) was 9004 tokens before this change, with heavy redundancy: duplicated boundary-ID rules, duplicated batching prose, multi-line JSON examples repeated in nudges that already appear in the tool description, and verbose tool descriptions that restate semantics already covered by the system prompt. There is also no way to select a more compact surface at all.
- **Expected behavior**:
  - Phase 1: trim the default surfaces in place (~20% reduction) without weakening any load-bearing contract (ID resolution rules, KEEP/REF marker docs, protected-tool semantics, candidate-mode variants, internal `dcp` XML tags).
  - Phase 2: provide a billion-context-pi-style lean mode as config option `compress.promptPack: "default" | "lean"` (global scope, default `"default"`) selecting a condensed system prompt (LEAN_HOW_TO_COMPRESS replaces HOW_TO_COMPRESS_RULES) and one-line tool descriptions.
- **Impact**: Lower per-call token cost for all users (phase 1) and an opt-in path for very long sessions where prompt overhead matters most (phase 2).

## 2. Reproduction (if applicable)

- **Environment**: Node 22+, any OS. Size measurement: render `buildSystemPrompt(false)` + the five tool descriptions and count tokens with `@anthropic-ai/tokenizer`.
- **Minimal reproduction steps**:
  1) Run any opencode session with ACP enabled; inspect the request payload system prompt + tool definitions.
  2) Measure standing surface as above (before: 9004 tok).
- **Relevant configuration**: none for phase 1; `"compress": { "promptPack": "lean" }` for phase 2.

## 3. Constraints & Non-Goals

- **Constraints**:
  - Backward compatibility: persisted state format untouched; internal `dcp-*` tag names untouched; the four load-bearing rule classes (COMPRESS_PHILOSOPHY, HOW_TO_COMPRESS_RULES, TIER2/TIER3 guidance) must not be silently degraded — lean uses the kernel's condensed contract which preserves every class plus the INTEGRITY/PENDING anti-fabrication rules; existing three-level prompt file overrides must still win over any pack.
  - Performance requirements: pack selection is a static string choice at store construction — zero runtime cost beyond one object lookup.
  - Resource limits: no new runtime dependencies.
- **Non-Goals** (explicitly out of scope):
  - Per-provider / per-model pack selection (bcp does this; deferred — global scope suffices for v1).
  - User-defined packs loaded from directories (bcp's `.pi/acp/packs/*.json`) — deferred.
  - Modifying the shared `context-compress-algorithms` package itself.
  - Trimming nudge *trigger* thresholds or compression behavior of any kind.

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
  - [x] `npm run typecheck` passes; full test suite passes (only pre-existing environmental failures remain, see WORKLOG).
  - [x] New `tests/prompt-packs.test.ts` (16 tests) pins: pack ids, lean<default sizes, load-bearing fragment presence in lean text, candidates-mode toggle, lean vs default tool-description pairs, default descriptions byte-stable, config validation (unknown-key + enum value checks), mergeCompress propagation, and PromptStore integration (lean served, default byte-identical to builders, file override beats lean).
  - [x] `compress.promptPack` accepted by validation (`getInvalidConfigKeys` / `validateConfigTypes`) and declared in `dcp.schema.json`.
  - [x] With `promptPack` unset, tool factories receive exactly the previously shipped description strings (regression-guarded by tests).
- **Performance / Stability**:
  - [x] Measured standing surface: 9004 → 7143 tokens (-20.7%) for the default pack; lean system prompt ~57% smaller than default, lean tool descriptions 30–76% smaller (exact numbers in WORKLOG §3).
