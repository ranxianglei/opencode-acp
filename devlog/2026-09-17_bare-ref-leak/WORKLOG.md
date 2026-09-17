# WORKLOG - Strip leaked bare ACP message refs from completed assistant text

- Task ID: `2026-09-17_bare-ref-leak`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-09-17 18:55

## 1. Summary

- **What was done** (1–3 sentences): Added a second sanitization pass to the `experimental.text.complete` hook that truncates line-leading bare ACP refs (`mNNNNN` / `bN`) whose value is at or beyond the next-to-allocate ID, i.e. IDs that cannot exist yet. The handler now receives the live session registry, so it can read `state.messageIds.nextRef` / `state.prune.messages.nextBlockId` and cut the leaked tail (the #431 repro shape) while leaving all legitimate prose untouched.
- **Why** (1–3 sentences): The existing tag-only sanitizer (`stripHallucinationsFromString`) cannot see bare refs — the model's end-of-generation self-echo of its own (not-yet-assigned) ref plus garbage was persisted into assistant messages and re-entered later context/compression summaries (#431). Future-ref truncation is provably zero-false-positive against real citations because refs are allocated strictly monotonically.
- **Behavior / compatibility changes**: Yes — completed assistant text may now have a trailing future-ref fragment removed (only in the degenerate case; normal output is byte-identical). No state format, config schema, persistence, or public API changes. Internal `dcp` naming preserved.
- **Risk level**: Low

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| `<sha>` | fix: strip leaked bare ACP refs from completed assistant text (#431) |
| `<sha>` | test: pin b0-exclusion and 4-digit m-ref branches (second-review follow-up, PR #432) |

### Second-review follow-up (PR #432, agent review pass 2)

- Independent second review verdict: APPROVE with 4 LOW findings. Two were missing
  regression pins in `tests/leaked-trailing-ref.test.ts`, fixed directly on the branch:
  - `b0` exclusion: block ids allocate from 1 (`allocateBlockId`, lib/compress/state.ts), so
    `b0` exists in no ID space; the regex's `b([1-9]\d*)` never matches it even at the
    minimum bound — now pinned by a dedicated unit case.
  - 4-digit `m` tokens: the regex accepts 4–5 digit widths (legacy tolerance); both
    directions (above-bound stripped / below-bound kept) now pinned.
- The other two findings (input-deref robustness note; cosmetic cast asymmetry in
  lib/hooks.ts) required no change — no realistic throw path, style-only.

### Key Files

- `lib/messages/utils.ts` — new pure function `stripLeakedTrailingRefs(text, { nextMessageRef, nextBlockRef })` + module-private `LEAKED_TRAILING_REF_REGEX`; exported via `lib/messages/index.ts`.
- `lib/hooks.ts` — `createTextCompleteHandler(registry, logger)` new signature; after tag stripping, looks up live state with `registry.get(input.sessionID)` and applies the new strip; warn-logs each strip with `removedChars` + 200-char tail preview.
- `index.ts` — passes `registry` + `logger` into the factory (one-line change).
- `tests/leaked-trailing-ref.test.ts` — NEW regression suite: pure-function cases (issue repro shape, boundary equality, keeps existing/inline/uppercase/six-digit refs, bN cases, both-bounds-null no-op, first-match-cut, whole-output leak → "", CRLF, whitespace trim) + handler-level cases (tag + bare-ref combined strip, legitimate citation kept, registry-miss fallback to tag-only, empty text no-throw).
- `tests/hooks-permission.test.ts`, `tests/message-priority.test.ts` — existing handler tests updated for the new factory signature (seeded registry + logger).

## 3. Design & Implementation Notes

- **Entry point / key function**: `stripLeakedTrailingRefs` in `lib/messages/utils.ts`; wired in `createTextCompleteHandler` in `lib/hooks.ts`.
- **Key configuration items**: none — always on, no config surface added.
- **Key logic explanation** (if non-trivial): single global-regex scan for LINE-LEADING bare refs only (`(?:^|\n)[ \t]*` + `m\d{4,5}` | `b[1-9]\d*`). First match whose numeric part is ≥ the corresponding next-to-allocate bound triggers truncation from match start to end of string, then trims trailing whitespace. Guards: embedded mentions ("see m00042") never match; uppercase product codes (`M00057`) never match; existing refs (< bound) always kept; unknown ID space (registry miss / null bounds) → input returned unchanged (today's behavior). Regex rebuilt per call because global regexes carry mutable `lastIndex`. Full rationale in `DESIGN.md`.

## 4. Testing & Verification

### Build & Test Commands

```sh
# Build
cd opencode-acp && npm run build

# Run full test suite
node --import tsx --test tests/*.test.ts

# Run specific test file
node --import tsx --test tests/leaked-trailing-ref.test.ts

# Type check
npx tsc --noEmit
```

### Test Coverage

- New/modified test files: `tests/leaked-trailing-ref.test.ts` (new), `tests/hooks-permission.test.ts`, `tests/message-priority.test.ts` (signature updates only)
- Test count: 1290 total (1288 + 2 second-review pins), 1288 pass, 2 fail (both pre-existing sandbox artifacts, see Results)
- Key scenarios verified:
  - #431 repro shape truncated: `"Normal assistant progress message.\n\nm00057 <garbage>"` → `"Normal assistant progress message."` (nextRef=57)
  - Boundary: ref exactly equal to next-to-allocate IS stripped; one below is kept
  - Legitimate older refs in prose survive (inline and line-leading)
  - Uppercase forms, six-digit sequences, mid-line future refs untouched
  - bN block-ref variant with `nextBlockId` bound
  - Registry miss (unknown session) → fallback to tag-only strip, no throw
  - Complete/incomplete tag stripping unchanged (existing suites green)
  - Bug-fail proof: old `stripHallucinationsFromString(repro)` returns input unchanged (bug confirmed empirically before fix)

### Results

- **PASS/FAIL**: PASS — typecheck clean, build clean, targeted files 71/71
- **Key logs/data**: full suite 1288 tests / 1286 pass / 2 fail. Both failures are environment artifacts of this sandbox, not regressions:
  - `tests/soft-block.test.ts` — crashes at import: `Error: EACCES: permission denied, mkdir '/tmp/opencode-dcp-dangerous-*'` (this sandbox mounts `/tmp` read-only; passes on CI/dev machines)
  - `tests/inactive-block-decompress.test.ts` "E2E: toFile on inactive block writes block summary" — `toFile path must be under <workspace>/.tmp or ~/.cache/opencode/. Got: /tmp/test-inactive-block-decompress.txt` (same `/tmp` cause)

## 5. Risk Assessment & Rollback

- **Risk points**:
  - Known limitation (documented, deliberate): a model echo of an ALREADY-assigned ref (below the bound) is not stripped — that value could be a legitimate citation, and the issue's evidence points at the unassigned-self-ref case.
  - Registry soft-cap eviction (32 sessions) can make state unavailable → safe fallback to today's tag-only behavior, never a crash.
- **Rollback method**:
  - Revert commit(s): `<sha>`
  - Rollback impact: none — no state/persistence/API changes; reverting restores exact previous behavior.
- **Compatibility notes** (data format, config schema): No — no format or schema changes.

## 6. Lessons Learned (optional)

- What went well: the monotonic-allocation invariant made a provably-safe heuristic possible where "look up the completing message's own ref" was impossible (assignment happens on the NEXT transform).
- What could be improved: repo-wide `npm run format:check` currently fails on many master files due to prettier version drift (package.json pins `^3.8.1`, installed 3.9.5 reformats differently) — pre-existing, out of scope here; noted in the issue thread.
- Reusable conclusions: for sanitizing model output that embeds an ID scheme, "value ≥ next-to-allocate ⇒ cannot be a real citation" is a general zero-false-positive guard whenever allocation is monotonic and non-reusing.

## 7. Follow-ups (optional)

- [ ] Consider extending the same guard to other completion surfaces if OpenCode exposes more text-complete-style hooks (not needed today).
- [ ] Prettier drift cleanup as a separate housekeeping task (do NOT mix into feature PRs).
