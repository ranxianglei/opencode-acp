# DESIGN - Invalidate stale modelContextLimit after a model switch

- Task ID: `2026-08-16_model-switch-stale-limit`
- Home Repo: `opencode-acp`
- Created: 2026-08-16
- Status: Accepted

## 1. Problem Statement

- **What problem are we solving?** Percentage-based context thresholds are computed against `state.modelContextLimit`, which lags the active model by one turn after a model switch (issue #312: 50% emergency fired at 26% of the new 1M window).
- **Why now?** User-visible false emergency nudges on a common workflow (switching to a larger-window model to continue an existing session).

## 2. Goals & Non-Goals

- **Goals**:
  - No threshold is ever computed from a limit whose model identity does not match the current turn.
  - Self-correcting within one turn without extra API calls.
  - Additive, backward-compatible persisted state.
- **Non-Goals**:
  - Perfect first-turn accuracy after a switch (accepted 1-turn "limit unknown" window).
  - Upstream hook-ordering change in OpenCode.
  - Fetching model limits via `client.app.providers()` (see §5, option B).

## 3. Current Architecture (if applicable)

- **How it works today**:
  - `messages.transform` (prompt.ts:1583) runs the full ACP pipeline: filters, prune, GC, `injectCompressNudges` — all reading `state.modelContextLimit`.
  - `system.transform` (llm.ts:118) runs LATER in the same turn and is the only writer: `state.modelContextLimit = input.model.limit.context`.
  - Consequence: turn N+1 (first turn after a switch) evaluates the stale limit from model M(N); M(N+1)'s limit lands only after that transform.
- **Pain points**:
  - `emergencyThresholdPercent: "50%"` × stale 200K = 100K → 260K-token session trips the emergency at 26% of the real 1M window.
  - Same stale value distorts percentage `min/maxContextLimit` and the adaptive `nudgeGrowthTokens` (5% of 200K = 10K instead of 50K).
  - No record of WHICH model a limit belongs to, so staleness is undetectable.

## 4. Proposed Architecture

- **Overview**:
  ```
  messages.transform (turn N+1, model M2)
    └─ syncModelIdentity(state, M2) ── mismatch with stored (limit ← M1)
         └─ state.modelContextLimit = undefined   ← "limit unknown" path
    └─ pipeline runs with unknown-limit semantics
  system.transform (turn N+1, model M2)   ← later in the same turn
    └─ state.modelContextLimit = M2.limit.context
       state.modelProviderID / modelID = M2      ← provenance recorded
  messages.transform (turn N+2, model M2)
    └─ syncModelIdentity: identity matches → limit kept (1M)
  ```
- **Key components**:
  - `SessionState.modelProviderID?` / `modelID?` — provenance of the cached limit (persisted, optional).
  - `syncModelIdentity(state, providerID, modelID): boolean` (lib/state/utils.ts) — the single invalidation point; returns true when a switch (or unknown provenance) was detected.
  - `createSystemPromptHandler` — stores identity alongside the limit.
  - `createChatMessageTransformHandler` — calls `syncModelIdentity` right after state resolution, before any limit-consuming stage.
- **Data flow**: model identity flows from the last user message (`info.model.providerID/modelID`) into `syncModelIdentity`; from the SDK `Model` (`id`/`providerID`) into the system handler. Both use the same provider/model ID namespace.

## 5. Decisions

| Decision | Options | Choice | Rationale |
|---|---|---|---|
| Stale-limit handling | (a) trust it, (b) invalidate on identity mismatch, (c) fetch fresh limit via `client.app.providers()` | (b) | (a) is the bug. (c) adds an async API call + error/caching surface to the hot path; per-session-state DESIGN already rejected `provider.list` for this reason. (b) reuses the existing, well-tested "limit unknown" semantics (unknown-limit path already guards GC, truncate, filters, adaptive growth). |
| Where to invalidate | (a) inside each consumer, (b) one call at the transform entry | (b) | Every consumer (filters → prune → GC → nudge) runs after state resolution in `createChatMessageTransformHandler`; one call covers all. Consumers already handle `undefined` limits. |
| Provenance storage | (a) model string `provider/model`, (b) two fields | (b) | Matches `UserMessage.info.model` shape; avoids parsing; both optional for backward compat. |
| Legacy files (limit, no identity) | (a) trust, (b) invalidate first transform | (b) | A limit whose model cannot be verified is a stale guess; the project's own rule (README v1.13.x changelog) is to surface `undefined` rather than distorted percentages. Cost: one unknown-limit turn after upgrade — self-corrects same turn. |
| Variant in identity | (a) include `variant`, (b) ignore | (b) | `limit.context` is per-model; variants are parameter presets on the same model. Including it would invalidate on variant flips with no limit change. |

## 6. Impact Analysis

- **Backward compatibility**: additive. `modelProviderID?`/`modelID?` are optional in `SessionState` and `PersistedSessionState`; old JSON loads unchanged (restore guards check `typeof === "string"`). Older plugin versions ignore the new fields. No exported API removal; `syncModelIdentity` is a new export.
- **Performance**: one `findLast` over messages (model info, same cost as the existing `getLastUserMessage` already called in the same handler) + one identity comparison. Negligible.
- **Behavioral**: first turn after a model switch (and first turn after an upgrade from a pre-identity version) uses unknown-limit semantics: no emergency/min/max nudges, adaptive growth falls to the 6K floor, GC/batch-cleanup/truncation skip. System prompt limit line for that turn shows the unknown-limit variant (existing behavior).
- **Security**: N/A.

## 7. Rollback

Revert the branch. Persisted new fields are inert to older code.
