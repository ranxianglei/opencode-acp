# WORKLOG - Codify OpenCode V2 → billion-context migration policy in AGENTS.md

- Task ID: `2026-09-29_agents-v2-bc-migration`
- Home Repo: `opencode-acp`
- Status: InProgress
- Updated: 2026-09-29 22:06

## 1. Summary

- **What was done**: Added AGENTS.md §1.4 documenting the OpenCode V2 → billion-context migration decision and a MANDATORY agent triage rule for future V2 requests.
- **Why**: Owner directive (#442): after manually closing the V2 issues, codify the policy so future similar requests are politely redirected to billion-context and closed — without misdirecting genuine 1.x bugs that mention V2.
- **Behavior / compatibility changes**: No. Documentation/policy only; no runtime behavior, config schema, or version change.
- **Risk level**: Low

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| (single commit on branch) | docs(agents): codify OpenCode V2 -> billion-context migration + triage rule (#442) |

### Key Files

- `AGENTS.md` — new §1.4 under Project Overview (scope boundary + mandatory triage rule).
- `devlog/2026-09-29_agents-v2-bc-migration/REQ.md`, `WORKLOG.md` — this entry.

## 3. Design & Implementation Notes

- Placed under Project Overview (§1.4) so agents encounter the scope boundary early, before any implementation work.
- Encodes the **exception** discovered while working #442: @akrhin's 2026-09-29 batch mixed genuine OpenCode 1.x / live-master bugs into OpenCode-V2 threads — #457 (`permission.acp_status:"deny"` silently overridden to `"allow"` at `index.ts:252-258` / `lib/host-permissions.ts:96-99`), #465 (wildcard variant), #461 (unbounded module-level Set in `lib/messages/truncate-tools.ts`). The rule explicitly forbids dismissing those just because the thread references V2.

## 4. Testing & Verification

### Build & Test Commands

```sh
npm run typecheck   # unaffected (docs-only), run for safety
npm test            # unaffected (docs-only)
```

### Test Coverage

- New/modified test files: none (docs only).
- Key scenarios verified: AGENTS.md renders correctly; no source/test/version touched.

### Results

- **PASS/FAIL**: N/A for runtime. Docs-only change (no source/test/version touched), so CI typecheck+test+build are unaffected. Local toolchain not run in this worktree (dependencies not installed); CI covers it on the PR.

## 5. Risk Assessment & Rollback

- **Risk points**: None functional. Wording clarity / correct tree-attribution is the only concern.
- **Rollback method**: Revert the single commit.
- **Compatibility notes** (data format, config schema): No.

## 7. Follow-ups

- [ ] None. (The #457 permission bug is tracked separately in its own issue thread, not in this PR.)
