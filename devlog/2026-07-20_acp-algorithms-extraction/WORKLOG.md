# WORKLOG: ACP Algorithm Extraction

## Iteration summary

Extracted a subset of ACP's algorithm implementations into a separate
MIT-licensed package `context-compress-algorithms`, leaving interfaces,
registries, and orchestration in ACP. Wired as a runtime dependency so
defaults work out-of-box.

## Scope decision (revised mid-iteration)

The initial plan was to extract **all** prompts (system, compress-range,
compress-message, context-limit-nudge, turn-nudge, iteration-nudge) plus
compression-rules. User feedback in dog/opencode-acp#30 narrowed this:

> "如何的这个是我们最有价值的,而且是自己搞的 我理解,你可以主要保留这个
> 像那些系统的那些工具的那些可以还是给他还原回去 因为它是一个通用的原则"

Only `compression-rules.ts` (HOW TO COMPRESS — our original work, the
valuable IP) is extracted. The 6 system-tool-related prompts were restored
to ACP because they reference host-specific tool names (`acp_status`,
`compress`) and are not general principles. A `CompressionPromptProvider`
registry abstraction was prototyped and reverted as overkill for exporting
two constants.

## Final scope

Extracted to `context-compress-algorithms`:
- Quality gate (`rouge-recall-v1` + tokenizer)
- `compression-rules.ts` only (`HOW_TO_COMPRESS_RULES`, `COMPRESS_PHILOSOPHY`)
- Trigger policy (`computeShouldNudge` + `resolveAdaptiveNudgeGrowth`)

Restored to ACP (provider experiment reverted):
- `lib/prompts/system.ts`
- `lib/prompts/compress-range.ts`
- `lib/prompts/compress-message.ts`
- `lib/prompts/context-limit-nudge.ts`
- `lib/prompts/turn-nudge.ts`
- `lib/prompts/iteration-nudge.ts`

## Files

### New: `context-compress-algorithms` package (`/home/dog/projects/context-compress-algorithms/`)

```
context-compress-algorithms/
├── package.json              # MIT, exports: ., ./quality-gate, ./prompts, ./trigger
├── tsconfig.json             # rootDir: src, include: src/**
├── tsup.config.ts            # entries: index, quality-gate/index, prompts/index, trigger/index
├── LICENSE                   # MIT
├── README.md
├── src/
│   ├── index.ts              # re-exports all modules
│   ├── quality-gate/
│   │   ├── types.ts          # BlockSnapshot (subset of CompressionBlock), QualityGate, etc.
│   │   ├── tokenizer.ts      # tokenize, rouge1F1, rouge1Recall, rouge1Precision, topKRecall, etc.
│   │   ├── rouge-recall-v1.ts # default gate impl (BUG FIX: retentionPct div-by-zero guard)
│   │   └── index.ts          # barrel + registerQualityGates helper
│   ├── prompts/
│   │   ├── compression-rules.ts # HOW_TO_COMPRESS_RULES, COMPRESS_PHILOSOPHY
│   │   └── index.ts             # barrel
│   └── trigger/
│       ├── types.ts          # CompressionTriggerPolicy, NudgeDecision, etc.
│       ├── default.ts        # defaultTriggerPolicy (computeShouldNudge + resolveAdaptiveNudgeGrowth)
│       └── index.ts          # barrel
└── tests/
    ├── quality-gate-tokenizer.test.ts       # 28 tests (moved from ACP)
    └── quality-gate-rouge-recall-v1.test.ts # 27 tests (26 moved + 1 new for div-by-zero guard)
```

**55 tests, all passing.**

### Modified: ACP

**Deleted** (moved to context-compress-algorithms):
- `lib/compress/quality-gate/algorithms/rouge-recall-v1.ts`
- `lib/compress/quality-gate/tokenizer.ts`
- `lib/prompts/compression-rules.ts`
- `tests/quality-gate-tokenizer.test.ts` (moved)
- `tests/quality-gate-rouge-recall-v1.test.ts` (moved)

**Added**:
- `lib/messages/inject/policy/{types,registry,index}.ts` — CompressionTriggerPolicy interface + registry
- `tests/trigger-policy-integration.test.ts` — 3 tests (auto-registration + decision branches + growth boundaries)

**Modified**:
- `package.json` — `context-compress-algorithms` declared as `file:../context-compress-algorithms` in **devDependencies** (NOT `dependencies`); `files` whitelist includes `NOTICE` and `README.zh-CN.md`
- `tsup.config.ts` — `noExternal` lists `context-compress-algorithms` so the published tarball is self-contained
- `NOTICE` (new) — MIT attribution for bundled cc-alg bytes (satisfies MIT license retention requirement)
- `lib/compress/quality-gate/algorithms/index.ts` — rewritten: imports `rougeRecallV1` from new pkg, calls `registerQualityGate(rougeRecallV1)` on every `ensureBuiltinGatesRegistered()` (the `initialized` flag was removed — it broke test isolation after `clearQualityGateRegistryForTests()`)
- `lib/compress/quality-gate/index.ts` — barrel exports trimmed (rougeRecallV1 etc. removed; tokenizer helpers removed)
- `lib/messages/inject/inject.ts` — imports `COMPRESS_PHILOSOPHY` / `HOW_TO_COMPRESS_RULES` from `context-compress-algorithms/prompts`
- `lib/messages/inject/utils.ts` — `computeShouldNudge` and `resolveAdaptiveNudgeGrowth` delegate to `getDefaultTriggerPolicy()`; module top-level calls `ensureBuiltinTriggerPolicyRegistered()` for auto-registration
- `lib/prompts/{system,context-limit-nudge,turn-nudge,iteration-nudge}.ts` — `HOW_TO_COMPRESS_RULES` import path switched from `./compression-rules` to `context-compress-algorithms/prompts`
- `tests/quality-gate-pipeline-integration.test.ts` — uses inline stub gate (decouples pipeline tests from rouge-recall-v1 algorithm); added auto-registration tests + end-to-end test with real gate from new pkg

## Bug fix discovered during review (the real one)

**Initial (wrong) claim**: `rouge1Precision` had a `for...in summarySet` bug
that always returned 0.

**Reality** (verified by two independent review agents via `git show HEAD:`):
HEAD's `lib/compress/quality-gate/tokenizer.ts` already used
`for (const t of summarySet)` — the bug never existed. The fictional claim
came from a stale diff state. `rouge1Precision` behavior is unchanged.

**Actual behavioral change** (intentional, defensive): In
`rouge-recall-v1.ts`, the `retentionPct` zero-guard was corrected:

```diff
-const retentionPct = originalChars > 0
+const retentionPct = ctx.block.compressedTokens > 0
     ? (summaryLen / (ctx.block.compressedTokens * 4)) * 100
     : 0
```

The divisor is `compressedTokens * 4`, so the zero-guard belongs on
`compressedTokens`. Old behavior: when `compressedTokens === 0` with
non-empty original, `summaryLen / 0 = Infinity`, and
`Infinity < layer1MinRetentionPct (1.0)` is `false` → L1 retention check
silently passed (a latent div-by-zero bug). New behavior: returns `0` →
correctly fails L1 retention. Test added in
`tests/quality-gate-rouge-recall-v1.test.ts`:
"Layer 1 retention guard uses compressedTokens for div-by-zero safety".

This is the only intended behavioral change. Everything else is a pure
code move.

## Test counts

| Suite                      | Before | After |
|----------------------------|-------:|------:|
| ACP                        |    846 |   798 |
| context-compress-algorithms|      — |    55 |
| **Total**                  |  **846** |  **853** |

ACP deltas:
- `-54` tests moved to cc-algorithms (tokenizer 28 + rouge-recall-v1 26)
- `-4` tests removed (`tests/prompt-provider-integration.test.ts` deleted when provider experiment was reverted)
- `+10` tests added (3 trigger-policy-integration + 7 in modified quality-gate-pipeline-integration)
- Net: `-48` → 798

cc-algorithms deltas:
- `+54` tests moved from ACP
- `+1` test added (compressedTokens=0 div-by-zero guard)
- Net: 55

## Pattern established

Three plugin extension points now follow the same shape (quality-gate +
trigger-policy; prompt-provider experiment was reverted):

```ts
// ACP side: interface + registry + auto-register-from-cc-algorithms
export interface XFoobar { name, version, ... }
export function registerXFoobar(x: XFoobar): void
export function getDefaultXFoobar(): XFoobar | null
export function ensureBuiltinXFoobarRegistered(): void  // calls registerXFoobar(defaultXFoobar from cc-algorithms)

// cc-algorithms side: implementation + default + register helper
export const defaultXFoobar: XFoobar = { ... }
export function registerXFoobars(register: (x) => void) { register(defaultXFoobar) }
```

Registries drop the `initialized` flag — `registerX` is idempotent for the
same object reference, so calling `ensureBuiltinXRegistered()` repeatedly
is a no-op. Removing the flag fixes test isolation (after
`clearXRegistryForTests()`, the next `ensureBuiltinXRegistered()` correctly
re-registers).

## Verification

- ACP `npm run typecheck` — clean
- ACP `npm test` — 798/798 pass
- ACP `npm run build` — succeeds
- cc-algorithms `npm run typecheck` — clean
- cc-algorithms `npm test` — 55/55 pass
- cc-algorithms `npm run build` — succeeds

Dual-agent equivalence review (oracle + sisyphus-junior, both independent):
- 7 architecture checks passed (init order, idempotency, constants, etc.)
- Confirmed `rouge1Precision` "bug fix" claim was fictional
- Surfaced the real `retentionPct` behavioral change (now documented + tested)
- Flagged stale WORKLOG (this rewrite addresses that)

## Followups (not done)

- Promote `context-compress-algorithms` to an independently-published npm
  package (its own version, its own release flow) so the MIT promise is
  consumable by third parties. Currently the `file:` symlink only resolves
  on developer machines — the bundled bytes are AGPL (as part of ACP) and
  external consumers have no way to install cc-algorithms standalone. The
  inline-bundling fix below solved the immediate upgrade-break, but the
  "algorithm itself usable as MIT" commitment is not yet real in practice.
- Add `triggerPolicy` config field to `acp.jsonc` so users can pick between
  registered policies via config (currently first-registered-wins for the
  default slot).
- Extract `inject/utils.ts` decision helpers beyond `computeShouldNudge` if
  more pure algorithms surface (GC truncate + dedup signature utilities
  were analyzed and deferred — user said "看起来剩下的不需要拆").
- `.d.ts` files in `dist/lib/` still re-export types from
  `context-compress-algorithms/{quality-gate,trigger}` — runtime-irrelevant
  (opencode plugin loader does not type-check) but TS-typed consumers of
  ACP would need cc-alg types. Consider `import type` rewrite or skipLibCheck.
- Consider publishing `context-compress-algorithms` as a separate GitHub
  repo for cleaner provenance.

## Late followup: inline-bundling fix (2026-07-20)

**Problem discovered after dual-agent review**: the original
`"context-compress-algorithms": "file:../context-compress-algorithms"` in
`dependencies` combined with tsup's default externalization produced a
published tarball whose `dist/index.js` imported a package that did not
exist on consumer machines. Reproduced failure in a clean dir:

```
$ npm install opencode-acp-1.13.1.tgz     # silent success
$ node -e "import('opencode-acp')"
Error: Cannot find package 'context-compress-algorithms'
  imported from .../node_modules/opencode-acp/dist/index.js
```

Both auto-upgrade and manual-upgrade paths hit the same wall: `npm install`
silently dropped the unresolvable `file:` dep, and the runtime crashed on
first module load.

**Fix** (3 files):

| File             | Change                                                                  |
|------------------|-------------------------------------------------------------------------|
| `tsup.config.ts` | Added `"context-compress-algorithms"` to `noExternal`                   |
| `package.json`   | Moved cc-alg from `dependencies` to `devDependencies`; added `NOTICE` + `README.zh-CN.md` to `files` |
| `NOTICE` (new)   | MIT attribution block (required by MIT license §1)                      |

**Why moving to devDependencies is safe**: cc-alg has zero own dependencies
(verified — its `package.json` has neither `dependencies` nor
`peerDependencies`), so tsup inlining it produces a self-contained bundle
with no transitive cost.

**Verification**:
- Bundle grew 415 KB → 435 KB (+20 KB after tree-shaking; raw cc-alg
  dist is 204 KB but only used exports survive bundling)
- `dist/index.js` has 0 bare `context-compress-algorithms` imports
- 12 algorithm symbols (`rougeRecallV1`, `defaultTriggerPolicy`,
  `HOW_TO_COMPRESS_RULES`, `COMPRESS_PHILOSOPHY`) inlined
- Clean-dir simulation: `npm pack` → `npm install` in `/tmp` →
  `import('opencode-acp')` loads successfully with no MODULE_NOT_FOUND
- ACP test suite: 798/798 pass (no regression)
- `npm run verify:package`: passes (173 entries, NOTICE + LICENSE + READMEs)

**What is NOT solved by this fix**: the "algorithm itself usable as MIT
under the standalone cc-alg package" commitment. Bundling solves the ACP
upgrade path; it does not make cc-alg installable by third parties. See
followups above.

## Style debt noted by reviewers (non-blocking)

- `lib/messages/inject/utils.ts:210-214`: import block placed mid-file
  (between interface declarations). Conventional placement is top-of-file.
- `registerTriggerPolicy` is exported with two unrelated signatures
  (cc-algorithms version takes a callback; ACP version takes a policy
  object). No collision (different modules), but reading both packages is
  confusing. Consider renaming the cc-algorithms helper.
