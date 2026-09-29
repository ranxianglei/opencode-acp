# WORKLOG - V2 context patch: stop blanket AiMessage.make from rejecting live attachment messages

- Task ID: `2026-09-29_v2-media-validation`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-09-29 17:30

## 1. Summary

- **What was done** (1–3 sentences): Replaced the blanket `AiMessage.make(...)` re-validation over every assembled outgoing message with provenance-gated validation. ACP-authored messages are validated; host-owned messages are trusted-valid and carried through untouched. Added T1.1–T1.5b regression tests that simulate the `@opencode/ai >= 2.0.18` media rejection version-independently.
- **Why** (1–3 sentences): On 2.0.18+ media is an `Asset`-instance nominal type only the host's own module copy satisfies; ACP's copy rejected valid host data, rolling back every patch for any attachment-bearing message. Validating by provenance restores the intended invariant ("ACP never authors a malformed part") without rejecting host-owned data.
- **Behavior / compatibility changes**: **Yes — intentional.** Old: every final message re-run through public `AiMessage.make`; a host attachment → whole patch rejected `invalid-schema`. New: host-owned messages skipped from nominal validation (trusted-valid); ACP-authored parts still validated (full `make` for ACP-composed insertions, delta check for ACP edits of host messages). Protective invariants (duplicate-message-id, duplicate-call-id, invalid-tool-pair, invalid-order) unchanged and still firing. See REQ §4 and DESIGN for detail.
- **Risk level**: Low (localized validation gating; all protective checks preserved and re-tested).

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| `fix(v2): validate context patches by provenance instead of blanket AiMessage.make (#455)` | Code (`lib/v2/projection/patch.ts`), tests (`tests/v2-context-patch.test.ts`) and this devlog — single commit |

### Key Files

- `lib/v2/projection/patch.ts` — `validateFinalMessages` now takes an `authored: ReadonlySet<object>` set and skips host-owned messages from nominal re-validation; dispatches full `AiMessage.make` for ACP-composed insertions (`isAcpOwnedId`) and a new delta check otherwise. New exported helpers `isAcpAuthoredPartId(id)` and `validateAcpAuthoredParts(message)`. `applyV2ContextPatch` builds the authored set from `replacements ∪ insertions` and passes it in.
- `tests/v2-context-patch.test.ts` — T1.1–T1.5b under a new `#455` describe block + `buildAttachmentFixture` / `withHostSchemaRejection` helpers.
- `devlog/2026-09-29_v2-media-validation/` — REQ / DESIGN / WORKLOG.

## 3. Design & Implementation Notes

- **Entry point / key function**: `validateFinalMessages(messages, mappedCallIds, removedCallIds, authored)` in `lib/v2/projection/patch.ts`; call site in `applyV2ContextPatch` builds `authoredMessages = new Set([...replacements.values(), ...insertions.map(e => e.message)])`.
- **Key configuration items**: none.
- **Key logic explanation**: see DESIGN.md. The discriminator is message provenance (in the authored set or not), then authorship class (`isAcpOwnedId` → full make; else delta). Delta validates only parts whose id is `prt_dcp_text_*` / `prt_dcp_summary_*`, requiring well-formed text; provider parts are ignored.

## 4. Testing & Verification

### Build & Test Commands

```sh
node --import tsx --test tests/v2-context-patch.test.ts   # 35 pass (29 pre-existing + 6 new)
npx tsc --noEmit                                           # clean
npx prettier --check lib/v2/projection/patch.ts tests/v2-context-patch.test.ts
node --import tsx --test tests/*.test.ts                   # full suite
```

### Test Coverage

- New/modified test files: `tests/v2-context-patch.test.ts`.
- Test count: 35 total in file, 35 pass, 0 fail. Full repo suite: 1422/1423 pass.
- Key scenarios verified:
  - T1.1 attachment fixture under simulated 2.0.18 rejection → accepted; `make` never handed host media msg.
  - T1.2 attachment reaches final message by object identity.
  - T1.3 ACP prune (text → empty) of same message accepted; attachment survives.
  - T1.4 delta-check unit (provider ignored; malformed ACP part rejected; id discriminator).
  - T1.5 duplicate message id → `duplicate-message-id`; orphaned tool result / removed-but-present call → `invalid-tool-pair`.
  - T1.5b order shift of retained sources → `invalid-order`.
  - Regression proof: reintroducing the blanket loop makes T1.1/T1.2/T1.3 FAIL; restoring the fix makes them PASS.

### Results

- **PASS/FAIL**: PASS for this change.
- **Key logs/data**: pre-existing baseline failure unrelated to this change — `tests/soft-block.test.ts` hardcodes `/tmp/opencode-dcp-dangerous-${pid}` and `mkdirSync`s at module load; this sandbox mounts `/tmp` read-only, so the file crashes on import (EACCES) regardless of `TMPDIR`. It fails identically on the base branch here and on any read-only-`/tmp` environment; it is NOT caused by #455. (Candidate follow-up: use `fs.mkdtemp(os.tmpdir())`.)

## 5. Risk Assessment & Rollback

- **Risk points**: authored-set computation must exactly match ACP's mutation path (it does: replacements ∪ insertions). Over-trusting host data is bounded because provider messages ACP never touched are the only ones skipped, and ACP's own parts are still delta-checked.
- **Rollback method**:
  - Revert commit(s): `<sha>`.
  - Rollback impact: restores blanket validation (re-introduces the #455 symptom on 2.0.18+ hosts).
- **Compatibility notes** (data format, config schema): No changes.

## 6. Lessons Learned (optional)

- What went well: end-collection authored-set gave a minimal-diff, provably-complete discriminator without threading state through three functions.
- What could be improved: simulating a cross-module-instance `instanceof` rejection via a spy on the shared `Message.make` is version-independent but couples the test to `make` being a writable static (true today).
- Reusable conclusions: when validating host-owned data against a nominal type the validator cannot itself satisfy, gate on provenance rather than relaxing the type.

## 7. Follow-ups (optional)

- [ ] `tests/soft-block.test.ts` uses hardcoded `/tmp` (breaks in read-only-`/tmp` sandboxes). Consider `fs.mkdtemp(path.join(os.tmpdir(), ...))`. Pre-existing, unrelated to #455.
