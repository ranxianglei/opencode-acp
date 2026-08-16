# WORKLOG - Invalidate stale modelContextLimit after a model switch

- Task ID: `2026-08-16_model-switch-stale-limit`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-08-16

## 1. Summary

- **What was done** (1–3 sentences): `modelContextLimit` is now tracked together with the model identity it was captured for. The messages transform invalidates the limit when the turn's model no longer matches, so the first turn after a model switch uses the standard "limit unknown" path; the system-prompt hook (which fires later in the same turn) repopulates the correct limit plus the new identity.
- **Why** (1–3 sentences): `system.transform` (the only limit writer) fires AFTER `messages.transform` in every turn — confirmed in OpenCode stable v1.14.45 source (`session/prompt.ts:1583` → `session/llm.ts:118`). After a 200K→1M switch, the 50% emergency threshold was computed as 50%×200K=100K against 260K real tokens, tripping the emergency at 26% of the new window (issue #312).
- **Behavior / compatibility changes**: Yes — first turn after a model switch (and first turn after upgrading from a pre-identity state file) uses unknown-limit semantics instead of the previous model's window. Persisted state change is additive (two optional string fields). No config-schema or exported-API removals.
- **Risk level**: Low

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| `<sha>` | fix: invalidate stale modelContextLimit on model switch (#312) |

### Key Files

- `lib/state/types.ts` — `SessionState.modelProviderID?` / `modelID?`: provenance of the cached limit.
- `lib/state/utils.ts` — new `syncModelIdentity(state, providerID, modelID): boolean`: invalidates `modelContextLimit` on model mismatch or unknown provenance; records the current identity; no-op on match or missing model info.
- `lib/state/state.ts` — `createSessionState`/`resetSessionState` init the new fields; `ensureSessionInitialized` restores them with `typeof === "string"` guards (legacy files load unchanged).
- `lib/state/persistence.ts` — `modelProviderID?`/`modelID?` added to `PersistedSessionState` and `saveSessionState` (additive).
- `lib/hooks.ts` — `createSystemPromptHandler` stores `input.model.id`/`input.model.providerID` alongside the limit; `createChatMessageTransformHandler` calls `syncModelIdentity` after state resolution (debug log on invalidation); inline system-hook input type extended with `id`/`providerID`.
- `tests/model-switch-limit.test.ts` — 9 new tests: 5 `syncModelIdentity` unit tests, 1 persistence round-trip, 1 e2e #312 regression (200K→1M, 260K tokens, no false emergency before or after the system-hook refresh), 2 control tests (emergency still fires with a matching 1M limit; steady-state same-model keeps the limit).

## 3. Design & Implementation Notes

- **Entry point / key function**: `syncModelIdentity()` (lib/state/utils.ts) — single invalidation point; called once per transform at the top of the pipeline, before every limit-consuming stage (filters, prune, GC, batch cleanup, truncation, nudge injection).
- **Key configuration items**: none new — existing `compress.emergencyThresholdPercent`, `min/maxContextLimit` percentage thresholds now resolve against the *current* model's window (or unknown) instead of possibly the previous one.
- **Key logic explanation** (if non-trivial):
  - Turn N on model A: system.transform stores `(limit_A, A)`.
  - User switches to model B. Turn N+1, messages.transform: `getModelInfo(messages)` yields B → mismatch → `modelContextLimit = undefined`, identity = B. Pipeline runs on the unknown-limit path (no emergency/min/max nudges; adaptive growth floor 6K; GC/truncation no-op).
  - Turn N+1, system.transform: stores `(limit_B, B)`.
  - Turn N+2+: identity matches → limit_B kept.
  - The invalidation is idempotent: if system.transform does not fire in a turn (early returns), the next transform re-detects nothing (identity already updated) and the limit stays unknown until it does fire.
  - `variant` is intentionally excluded from identity — the context window is per-model, not per-variant.

## 4. Testing & Verification

### Build & Test Commands

```sh
# Build
cd opencode-acp && npm run build

# Run full test suite
node --import tsx --test tests/*.test.ts

# Run specific test file
node --import tsx --test tests/model-switch-limit.test.ts

# Type check
npx tsc --noEmit
```

### Results

- `npm run typecheck` — pass.
- `node --import tsx --test tests/*.test.ts` — **990 pass, 0 fail** (981 baseline + 9 new).
- **Bug-reproduction verification** (AGENTS.md §5.2): with the invalidation call disabled (`if (false && syncModelIdentity(...))`), the e2e regression `issue #312: no false emergency on first turn after switching 200K → 1M` FAILS with `AssertionError: stale 200K limit must be invalidated` (actual 200000, expected undefined) — the test captures the root cause, not the fix's side effects. Re-enabled: all green.
- Formatting: repo is not prettier-clean repo-wide (383 files pre-existing); new lines verified prettier-stable (diff of `prettier <file>` vs file shows only pre-existing untouched regions).

## 5. Review (AGENTS.md §5.3 — dual-agent required)

- [x] Agent review 1 (correctness/lifecycle): **APPROVE** (confidence 0.95) — invalidation fires at exactly the right point (before every limit consumer, every transform path checked: commands/internal-agents/ephemeral state/subagents all safe); namespace match verified against OpenCode source (step model built from `lastUser.model`, system.transform receives the same object's `.id`/`.providerID`); no scenario invalidates a correct limit; the 1-turn unknown-limit degradation equals the pre-existing first-turn state and all consumers already guard `undefined`; e2e test empirically verified to fail on a master scratch worktree and pass with the fix.
- [x] Agent review 2 (backward compatibility/state integrity): **APPROVE** (confidence 0.85) — legacy JSON (no identity fields) loads unchanged (structural validation + `typeof` restore guards); first transform takes the safe unknown-provenance invalidation, self-heals same turn; limit+identity always written/persisted atomically as one snapshot, survive eviction+reload consistently; `dcp.schema.json` correctly untouched (user-config schema, not state format); per-transform cost = one early-exit `findLast` + 2 string comparisons, negligible vs the transform's existing full scans; no `as any`/`ts-ignore` introduced.
- **P3 findings (both fixed before commit)**: (1) three new lines exceeded printWidth 100 → hand-wrapped to prettier-stable form (verified: `prettier <file>` diff vs file shows only pre-existing untouched regions); (2) debug log mislabeled fresh-session first-turn identity establishment as "Model switch detected (unknown → …)" → now logs `Model identity established (…) / limit awaits system.transform` when no prior identity, `Model switch detected (from → to)` only on a real switch.
## 6. Open Items

- None.
