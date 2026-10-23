# REQ — emergency truncation kill switch (issue #485)

## Background

Issue #485 reports provider prefix-cache thrash: a session hovering at the
emergency-truncation threshold oscillates between truncated and full tool
outputs across consecutive requests (A→B→A byte-identical). Each flip
invalidates the provider prefix cache from that message onward; combined with
opencode's automatic retries the churn (550K↔670K request bodies every turn)
took down the owner's serving cluster.

Root cause: `truncateLargeToolOutputs` (lib/messages/truncate-tools.ts) and
`enforceContextBudget` (lib/messages/enforce-budget.ts) operate on a fresh
pristine copy of `output.messages` each request. Truncation never persists in
the session store, and the guards gate on the LAST assistant's reported usage
— which reflects the *truncated* request. Result: bang-bang control with no
hysteresis (truncate → smaller usage → no truncation → full restore → cache
miss → over budget again → truncate…).

## Requirement

Add a config switch `compress.emergencyTruncation` (boolean, **default
`false`**) that gates BOTH emergency-truncation guards in the
message-transform pipeline:

- `true` — guards run: oversized old tool outputs are truncated head+tail
  near the context wall to keep the request within the model's window.
  Truncation is **sticky** (#485 follow-up, user request m00196): once a
  tool output is truncated, the result is frozen in SessionState keyed by
  tool call ID and replayed verbatim on every later request (and across
  restarts via state persistence). The wire view never oscillates
  (A→B→B→B); the full content stays in the session store / on disk, so
  nothing is lost.
- `false` (default) — guards are skipped entirely; a session that outgrows
  the window fails loudly at the provider (HTTP 400) instead of being
  silently mutated per-request. Compression nudges remain the primary
  mechanism for staying under the wall.

The switch must be:

1. Part of `CompressOverridableConfig` (provider/model-level overrides work).
2. Schema-validated (`dcp.schema.json`) and type-checked (`config-validation.ts`).
3. Documented in CONFIGURATION.md / CONFIGURATION.zh-CN.md with the #485
   rationale.

## Non-goals

- No version bump / CHANGELOG on this feature branch.
- Sticky map is per-session and pruned when calls vanish; no cross-session
  sharing.

## Acceptance

- Default config: guards do not run; oversized tool output survives the
  transform byte-identical.
- Opt-in: guards run and truncate as before (existing behavior preserved).
- Full test suite passes.
