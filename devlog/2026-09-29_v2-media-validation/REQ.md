# REQ - V2 context patch: stop blanket AiMessage.make from rejecting live attachment messages

- Task ID: `2026-09-29_v2-media-validation`
- Home Repo: `opencode-acp`
- Created: 2026-09-29
- Status: Done
- Priority: P1
- Owner: ranxianglei
- References: https://github.com/ranxianglei/opencode-acp/issues/455

## 1. Background & Problem Statement

- **Context**: V2 port of opencode-acp on OpenCode 2.0.x (`@opencode/ai`). Before a V2 context patch is accepted, `validateFinalMessages` (`lib/v2/projection/patch.ts`) re-validates every assembled outgoing message with the public `AiMessage.make(...)`.
- **Current behavior (symptom)**: On `@opencode/ai >= 2.0.18`, `MediaPart.media` is modeled as an `Asset`-instance nominal type (`Schema.declare((value) => value instanceof Asset)`). ACP's own module copy of `AiMessage.make` cannot satisfy that `instanceof` for host-owned media assets, so it rejects the host's own messages. Any live message carrying an attachment makes the whole patch roll back: `accepted === false`, rejection `invalid-schema` ("Final V2 message schema is invalid"). ACP pruning / protected-content retention / compression blocks are silently dropped for that request and the turn proceeds unpruned.
- **Expected behavior**: ACP validates only what ACP authored. Host-owned parts (media, provider metadata, tool results) are trusted-valid and carried through untouched; the patch is accepted and the attachment survives by object identity.
- **Impact**: Every attachment-bearing conversation silently loses ACP context management on affected hosts.

## 2. Reproduction (if applicable)

- **Environment**:
  - Node: 22.x
  - OS/Arch: linux
  - Root cause verified on `@opencode/ai >= 2.0.18`; regression test simulates that behavior version-independently against the installed runtime.
- **Minimal reproduction steps**:
  1) Build a projection whose outgoing history contains a user message with a text part plus an opaque media (attachment) part.
  2) Have ACP edit/prune the text part of that same message.
  3) Run `applyV2ContextPatch`. Pre-fix the blanket `AiMessage.make` over the host media message throws → patch rejected `invalid-schema`. Post-fix the host message is skipped from nominal validation → accepted.
- **Relevant configuration**: none (runtime schema behavior of `@opencode/ai`).

## 3. Constraints & Non-Goals

- **Constraints**:
  - Backward compatibility: persisted state format and internal `dcp` naming unchanged. No config schema change.
  - Must keep every protective invariant that already exists (duplicate-message-id, duplicate-call-id, invalid-tool-pair, invalid-order) firing exactly as before.
  - Minimal diff; no new dependencies.
- **Non-Goals** (explicitly out of scope):
  - Changing how `@opencode/ai` models media (upstream concern).
  - Fixing the orthogonal `opaque-origin` guard that refuses full removal of the last correlatable part of an opaque-bearing message (pre-existing, unrelated to #455).

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
  - [x] T1.1 replay of an attachment-bearing fixture under simulated 2.0.18 rejection → `accepted === true`; `AiMessage.make` is never handed the host media message.
  - [x] T1.2 the host attachment reaches `finalMessages` by object identity.
  - [x] T1.3 an ACP prune (text reduced to empty) of that same message still accepted; attachment survives.
  - [x] T1.4 delta check (`validateAcpAuthoredParts`) unit: provider parts ignored; malformed ACP-authored part → `invalid-schema`; `isAcpAuthoredPartId` discriminator correct.
- **Performance / Stability**:
  - [x] No new per-message allocation beyond one `Set` built from existing replacement/insertion collections.
- **Regression**:
  - [x] T1.5 protective invariants still reject: duplicate message id → `duplicate-message-id`, orphaned tool result / removed-but-present call → `invalid-tool-pair`.
  - [x] T1.5b order shift of retained sources → `invalid-order`.
  - [x] New tests verified to FAIL when the blanket validation is reintroduced (T1.1/T1.2/T1.3 fail), then pass with the fix.
  - [x] Full suite green except a pre-existing environmental failure unrelated to this change (see WORKLOG §4).

## 5. Proposed Approach (optional)

- **Affected modules & entry files**:
  - `lib/v2/projection/patch.ts` — `validateFinalMessages`, new `isAcpAuthoredPartId` / `validateAcpAuthoredParts` helpers, `applyV2ContextPatch` call site.
  - `tests/v2-context-patch.test.ts` — T1.1–T1.5b.
- **Risks**: Over-trusting host data if the authored-set is computed wrong (mitigated: set = replacements ∪ insertions, the exact path by which ACP mutates/assembles a message; plus the delta check as defense-in-depth).
- **Rollback strategy**: Revert the single commit; restores blanket validation.
