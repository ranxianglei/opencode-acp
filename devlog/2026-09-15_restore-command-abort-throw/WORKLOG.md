# WORKLOG - Restore throw-based abort for /acp subcommands (#398)

- Task ID: `2026-09-15_restore-command-abort-throw`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-09-15 15:10

## 1. Summary

- **What was done** (1–3 sentences): Restored `throw new Error("__DCP_CONTEXT_HANDLED__")` as the command-abort mechanism in the two `/acp` branches that PR #297 had downgraded to normal returns (`stats`/`status`/bare, and the `context` fallback). Added a regression-guard test suite asserting every handled `/acp` branch rejects with the sentinel AND that its notification prompt carries `noReply:true` + `ignored:true`.
- **Why** (1–3 sentences): opencode's `Plugin.trigger` aborts a command only when a hook throws; the command is registered with `template: ""` (no `$ARGUMENTS`), so a normal return lets opencode append the raw arguments to the empty template and send them to the model. Since v1.17.0 this leaked `status`/`stats`/`context` as user messages and triggered spurious ~40K-token model calls (issue #398).
- **Behavior / compatibility changes**: Yes — `/acp status|stats|context` now abort the command instead of leaking the argument word to the model. Side effect: one `level=ERROR` log line per `/acp` invocation on opencode ≥ 1.18.18 (the known cost of the only available abort mechanism; #296 noise, explicitly accepted per issue #398 discussion). No persisted-state, config-schema, or API changes.
- **Risk level**: Low

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| `2c59c07` | fix: restore throw-based abort for /acp subcommands (regression guard #398) |
| `85bc780` | docs: record final commit sha in WORKLOG |
| `2202bcc` | test: address review nits - type prompt recorder, tighten deny-permission abort assertion (#398) |

### Key Files

- `lib/hooks.ts` — `createCommandExecuteHandler`: stats/status/bare branch `return` → `throw`; context fallback gains trailing `throw`; added `[FIX #398]` comment documenting why throws are mandatory (this line was broken once before by PR #297).
- `tests/hooks-permission.test.ts` — replaced the flawed #296 test (asserted normal return) with `createCommandHarness()` + `expectAbortedAfterNotification()` helpers and two tests: regression guard looping all six handled branches, and non-acp pass-through.
- `devlog/2026-09-15_restore-command-abort-throw/REQ.md` — requirement record.

## 3. Design & Implementation Notes

- **Entry point / key function**: `createCommandExecuteHandler` in `lib/hooks.ts` (registered for `command.execute.before` in `index.ts`).
- **Key configuration items**: none changed.
- **Key logic explanation**: The hook has no cancel signal in its output type (`@opencode-ai/plugin` CommandOutput = `{ parts }` only), so throwing is the *only* way to stop opencode from executing the command template. All branches must therefore end in the sentinel throw *after* their handler runs (handlers send the `ignored:true, noReply:true` notification via `sendIgnoredMessage`). The `[FIX #398]` comment warns future maintainers not to convert these throws back into returns (PR #297 did exactly that while chasing #296's ERROR-log noise).

## 4. Testing & Verification

### Build & Test Commands

```sh
npm run typecheck
npm test
node --import tsx --test tests/hooks-permission.test.ts
```

### Test Coverage

- New/modified test files: `tests/hooks-permission.test.ts`
- Test count: 1264 total, 1264 pass, 0 fail (full suite); hooks-permission file: 10 pass / 0 fail
- Key scenarios verified:
  - Each of `stats`, `status`, `""`, `context`, `help`, `export --stdout` rejects with `Error: __DCP_CONTEXT_HANDLED__`
  - For each case exactly one `session.prompt` call is recorded with `body.noReply === true` and `parts[0].ignored === true` (notification path intact, no plain-message leak)
  - Non-`acp` commands still resolve without throwing (pass-through preserved)
  - **Mutation check**: temporarily reverting `lib/hooks.ts` (git stash) makes the regression guard fail (`not ok 4`), confirming the test catches the original bug; fix restored and re-verified green

### Results

- **PASS/FAIL**: PASS
- **Key logs/data** (optional): mutation run output — `not ok 4 - command execute aborts every handled /acp branch by throwing (regression guard #398)` on buggy code; full suite green after restore.

## 5. Risk Assessment & Rollback

- **Risk points**: opencode ≥ 1.18.18 logs one `level=ERROR` line per `/acp` invocation (accepted trade-off, see REQ.md). No other behavior change; export/help branches untouched.
- **Rollback method**:
  - Revert commit(s): `2c59c07`
  - Rollback impact: returns to the v1.17.0+ leak behavior (subcommand words sent to the model).
- **Compatibility notes** (data format, config schema): No changes.

## 6. Lessons Learned (optional)

- What went well: the A/B evidence in the issue plus reading `guard()` confirmed the throw propagates cleanly (not swallowed).
- What could be improved: PR #297's new test asserted the wrong property ("handler resolves") instead of the observable contract ("command aborted"); contract-level assertions should target side effects (prompt recording), not control flow.
- Reusable conclusions: in opencode, hook return values cannot cancel command execution — throw-or-leak until upstream adds a silent-abort API.

## 7. Follow-ups (optional)

- [ ] Negotiate a silent-abort API with opencode upstream (hook output control field / explicit cancel signal); once available, replace the sentinel throw and close #296 properly.
- [ ] Track upstream acceptance; if rejected, document the ERROR-log cost in README troubleshooting.
