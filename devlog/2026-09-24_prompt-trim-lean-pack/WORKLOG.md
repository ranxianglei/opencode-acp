# WORKLOG - Reduce standing prompt surfaces; add lean prompt pack

- Task ID: `2026-09-24_prompt-trim-lean-pack`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-09-24 12:30

## 1. Summary

- **What was done** (1–3 sentences): Phase 1 trimmed every standing prompt surface in place (system prompt sections, five tool descriptions, nudge templates, format extension), removing duplicated rules/examples without touching load-bearing contracts. Phase 2 added `lib/prompts/packs.ts` and a new `compress.promptPack: "default" | "lean"` config option selecting a billion-context-pi-style condensed surface (LEAN_HOW_TO_COMPRESS + one-line tool descriptions), wired through `PromptStore` so tool factories read pack-aware descriptions.
- **Why** (1–3 sentences): The standing surface is paid on every LLM call; it had ~20% removable redundancy, and long-context users need an opt-in compact mode matching billion-context-pi's lean pack.
- **Behavior / compatibility changes**: Yes — see §4 (must be disclosed per AGENTS.md Issue-Work Deliverables rule 4).
- **Risk level**: Medium (prompt-text changes affect model behavior; mitigated by keeping all load-bearing rules verbatim in default pack, condensing to the kernel's proven contract in lean, opt-in config, and 17 new pinning tests).

## 2. Change Log

### Commits

| Commit     | Description                                                                                  |
| ---------- | -------------------------------------------------------------------------------------------- |
| `8b15e60d` | Phase 1: trim redundant prompt surfaces by ~21% (issue #452 phase 1)                         |
| `e3590987` | Phase 2: `compress.promptPack` lean pack + pack-aware tool descriptions + tests + devlog     |
| `6870ee9b` | Test compat: adapt master's new decompress E2E mocks to the pack-aware factory (post-rebase) |
| `5ba03aa3` | Test portability: decompress toFile path via os.tmpdir() instead of hard-coded /tmp      |
| `eff1fdb0` | Review follow-up: pin factory→store description wiring + apply dual-review findings        |

Note: branch was rebased twice onto moving master (PR #448/#449 landed new E2E suites whose minimal prompt mocks predated the pack-aware factories); SHAs above are the final post-rebase ones.

### Key Files

- `lib/prompts/packs.ts` (NEW) — `PromptPackId`, `PROMPT_PACK_IDS`, DEFAULT_* description constants (moved verbatim from the four tool files), LEAN_* descriptions, `LEAN_HOW_TO_COMPRESS` (adapted verbatim from acp-kernel MIT `src/packs.ts`, provenance noted in-file), `buildLeanSystemPrompt(candidatesEnabled)`, `buildLeanCompressRangePrompt(candidatesEnabled)`, `getToolDescriptions(pack)`, `buildPackSystemPrompt` / `buildPackCompressRangePrompt` selectors.
- `lib/prompts/store.ts` — `RuntimePrompts` extended with `decompressDescription` / `searchContextDescription` / `acpStatusDescription` / `acpContextRecapDescription`; `PromptStore` constructor takes a 5th `promptPack` param; bundled prompts built via pack selectors; `ensureDefaultFiles()` always writes the `"default"` pack (managed defaults are the reference surface); file overrides still win over pack text.
- `lib/config.ts` — `CompressConfig.promptPack: "default" | "lean"` with default `"default"`; excluded from `CompressOverridableConfig` (session-wide switch, not per-provider); `mergeCompress` propagates it.
- `lib/config-validation.ts` — key registered in `VALID_CONFIG_KEYS`; enum value check in `validateConfigTypes`.
- `dcp.schema.json` — `compress.properties.promptPack` (+ entry in `compress.default`).
- `index.ts` — passes `config.compress.promptPack ?? "default"` into `PromptStore`.
- `lib/compress/{decompress,search,status,recap}.ts` — factories now read their description from `factoryCtx.prompts.getRuntimePrompts()` after `reload()` (pack-aware); local hard-coded description constants deleted (moved to packs.ts). `range.ts` unchanged (already store-driven; `RANGE_FORMAT_EXTENSION` shared by both packs).
- `tests/prompt-packs.test.ts` (NEW) — 17 tests covering packs API, load-bearing fragments, candidates toggle, size ratios, validation, merge, PromptStore integration incl. override-beats-lean precedence, factory→store description wiring (pack-aware), and the ensureDefaultFiles default-pack invariant.
- `tests/{acp-status,recap,search-context,inactive-block-decompress}.test.ts` — minimal `{ reload() {} }` prompt mocks replaced with `makeDefaultPromptsMock()` (real default-pack descriptions from packs.ts) because factories now call `getRuntimePrompts()` at creation time.
- Phase 1 files (commit `8b15e60d`): `lib/prompts/system.ts`, `lib/prompts/compress-range.ts`, `lib/prompts/extensions/tool.ts`, `lib/prompts/context-limit-nudge.ts`, `lib/prompts/turn-nudge.ts`, `lib/prompts/iteration-nudge.ts`, `lib/compress/{decompress,search,status,recap}.ts`.

## 3. Design & Implementation Notes

See `DESIGN.md` for architecture decisions. Implementation notes:

- Tool factories read descriptions once at creation time (inside `createXTool`), not per execute call — no hot-path cost.
- Store-side normalization (`toEditablePromptText` trim + reminder-tag wrapping for non-compress-range keys) applies to pack text identically to bundled text; tests compare against `.trim()`ed builder output accordingly.
- `RANGE_FORMAT_EXTENSION` (the JSON shape contract) stays appended to both packs' compress descriptions — identical wire shape, different prose.
- Measurement method: render each surface string, count chars/tokens with `@anthropic-ai/tokenizer` via a throwaway ESM eval script (kept in `.tmp/`, not committed).

## 4. Behavior / Compatibility Changes (disclosure)

1. **Phase 1 — default standing surface shrunk 9004 → 7143 tokens (-1861, -20.7%)** (Anthropic tokenizer, candidates-off). Per-surface before → after (tokens): system(ranges) 3055→2612, system(candidates) 3301→2859, compress desc 1063→764, decompress 452→227, search 101→56, status 184→98, recap 83→59, context-limit nudge 265→246, turn nudge 117→112, iteration nudge 103→110. WHY: removed duplicated boundary-ID/batching prose, repeated JSON examples, and restatements — every load-bearing rule (ID resolution, KEEP/REF markers, protected tools, candidate variants, internal `dcp` tags) kept verbatim. Risk note: any model behavior that depended on the _redundant_ wording (e.g., re-reading a rule twice) is gone; the single remaining copy is preserved.
2. **Phase 1 bug fix — restored stripped tag names in nudges.** `context-limit-nudge.ts`, `turn-nudge.ts`, `iteration-nudge.ts` on master contained ID-rule lines where the literal `<dcp-message-id>` tag text had been stripped upstream (verified via git blob hex dump: lines read "use IDs you can see in tags" with a double-space gap). Restored the explicit tag name in all three. Old → new: broken empty reference → actual tag name. WHY: models could not follow the instruction as written.
3. **Phase 2 — new opt-in config `compress.promptPack`** (`"default"` | `"lean"`, default `"default"`, global scope). With the default, runtime behavior is unchanged by phase 2 itself (descriptions byte-identical to phase-1 output — regression-guarded by test). With `"lean"`, the system prompt switches to the condensed build (~57% smaller: 1137 vs 2612 chars ranges-mode) and tool descriptions become one-liners (30.5%–76.0% of trimmed defaults). Lean keeps all load-bearing classes including INTEGRITY/PENDING anti-fabrication rules. WHY: parity with billion-context-pi's lean mode for long-session cost control.
4. **System prompt now lists the fifth tool.** Phase 1 TOOLS section previously said "five" tools but listed four; `acp_context_recap` bullet added (latent documentation bug fix).

## 5. Test Results

- `npm run typecheck`: pass.
- Full suite `node --import tsx --test tests/*.test.ts` (post-rebase, final): **1359 tests, 1358 pass, 1 fail** — sole failure is environmental (this sandbox mounts `/tmp` read-only, documented in platform AGENTS.md) and pre-exists this change:
    - `tests/soft-block.test.ts` — `mkdirSync('/tmp/opencode-dcp-dangerous-*')` EACCES at module load.
  The other previously-failing test (`E2E: toFile on inactive block writes block summary`, hard-coded `/tmp` fixture path) was made portable in `5ba03aa3`. Both pass in CI where /tmp is writable.
- New `tests/prompt-packs.test.ts`: **17/17 pass**. Verified the suite fails when the phase-2 wiring is reverted (mocks + integration tests depend on real factory/store code paths).
- **Dual-agent review applied** (AGENTS.md §5.3 + §5.6; two independent reviewers over `git diff origin/master...HEAD`). Findings fixed in the review follow-up commit: (1) MAJOR — factory→store description wiring was unpinned by mocks alone; new test creates all four tools with a lean-serving store mock and asserts `tool.description === LEAN_*` (mutation-verified: hard-coding one description makes it fail); (2) `ensureDefaultFiles` invariant pinned by reading back the managed `system.md` and asserting default-pack-only content ("WHEN TO COMPRESS" heading, absent from all lean text); (3) config validation now also asserts acceptance of `"default"`; (4) default-pack store test extended to all four description fields (symmetry with the lean test); (5) search-description size threshold loosened 0.8→0.9 (char ratio ~76% under-measures the ~55% token reduction); (6) two test-name fidelity fixes. Reviewer verdicts: code = no blockers, minor recommendations (all applied); tests = sufficient once finding (1) was fixed.
- Prettier: all files newly added or modified by this PR are clean (`npx prettier --check`). Note: repo-wide `npm run format:check` already fails on master for ~475 pre-existing files (no format job in CI); `dcp.schema.json` and `tests/decompress-source-availability.test.ts` were left at their master formatting baseline to avoid unrelated reformat churn in this diff.

## 6. Open Items / Follow-ups

- Per-provider/per-model pack selection and directory-loaded user packs (bcp features) — candidate future issues if requested.
- Docker E2E scenario exercising a full session with `promptPack: "lean"` (nudge→compress loop under the lean surface) — recommended before anyone relies on lean in production; tracked here intentionally rather than blocking this PR.
- `tests/soft-block.test.ts:14` still hard-codes a `/tmp/opencode-dcp-dangerous-*` path at module load (EACCES on sandboxes where /tmp is read-only). Left untouched: the path appears intentional (dangerous-path fixture) and changing it would alter what the test exercises; candidate for a separate follow-up if sandbox portability matters.
