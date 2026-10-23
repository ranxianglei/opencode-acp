# REQ — sticky-truncation hardening (post-#486 review fixes)

## Background

PR #486 (merged) implemented `compress.emergencyTruncation` (default off) plus
sticky truncation for issue #485. Dual-agent review (2 reviewers) found
2 MAJOR + 3 MINOR + nits after merge. This iteration lands the fixes.

## Requirements

1. **Major 1** — Sticky map must persist in the SAME request that freezes it.
   All other transform-hook save triggers fire earlier; the init-time
   "always save" only coincidentally carries turn-1 freezes (snapshot aliases
   the live map until the save queue drains). A later quiet request freezing
   with no other trigger would never reach disk → restart replays pristine A
   once → the exact #485 flip.
2. **Major 2** — `compress.providers.<p>[.models.<m>].emergencyTruncation`
   validated but was silently ignored: the hooks gate read raw
   `config.compress.emergencyTruncation`. Resolve through
   `applyCompressOverrides` like the reasoning/smartPlan gates.
3. **Minor 3** — Non-string tool outputs were never frozen (snapshot skipped
   them, replay skipped them) although guards stringify → truncate. The flip
   survived for object-shaped outputs.
4. **Minor 4** — Fork/subagent sessions did not inherit the parent sticky map
   (fork branch of `ensureSessionInitialized` returns before the regular
   sticky restore).
5. **Nit 7** — Use the declared `PersistedSessionState.stickyTruncations`
   field instead of an ad-hoc cast.
6. **Observation 8** — `truncateLargeToolOutputs` lacked the
   `part.tool === "compress"` exclusion that `enforceContextBudget` has; with
   stickiness on, a truncated compress summary would be frozen forever.

## Acceptance

- Both majors have fail-when-broken tests (verified: reverting each fix
  makes its test fail).
- Full suite green; build green; no version bump (feature branch).
