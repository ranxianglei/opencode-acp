# REQ - Fix one-click release failure caused by package-lock.json version drift

- Task ID: `2026-09-30_fix-oneclick-release-lockfile-drift`
- Home Repo: `opencode-acp`
- Created: 2026-09-30
- Status: InProgress
- Priority: P1
- Owner: ranxianglei
- References: https://github.com/ranxianglei/opencode-acp/issues/400 (failed-run report); failed workflow run 36737443321 ("Release (one-click)", head 5c449fd1)

## Problem

The "Release (one-click)" workflow (`release-manual.yml`, `workflow_dispatch`) failed at the **Bump version** step:

```text
package.json: replaced 1 occurrence(s)
version field not found in package-lock.json
##[error]Process completed with exit code 1.
```

The run had resolved version correctly (auto-bump npm latest 1.18.2 → 1.18.3) and passed the Drift guard (master package.json == npm latest); it died at the file rewrite.

## Root cause (verified)

1. `package-lock.json` on master still carried `"version": "1.16.0"` (top level + `packages[""]`) while `package.json` was at 1.18.2. Every release PR since v1.16.0 (1.17.0, 1.17.1, 1.18.0, 1.18.1, 1.18.2) bumped only `package.json` + changelogs — the lockfile version was never synced.
2. The Bump step keyed its string replacement on the exact old-version string (`"version": "<old>"`) in **both** files, so any drift between the two files aborts the release. Latent time bomb: the next release after any lockfile drift would fail the same way.

## Fix

1. Resync `package-lock.json`: 1.16.0 → 1.18.2 (top level + `packages[""]`). Immediate unblock; restores master self-consistency.
2. Make the Bump step **idempotent**: JSON-parse each manifest, set `.version` (and `packages[""].version` for the lockfile), re-serialize with the file's detected indent. Round-trip serialization verified **byte-identical** on both files, so diffs stay limited to the changed version line(s) regardless of prior drift. Fail-fast kept for a missing top-level `version` field.
3. Drift guard gains a non-fatal `::warning::` when lockfile ≠ package.json version — visibility without breaking.

**Behavior change (intentional):** previously, lockfile/package.json version drift was FATAL at Bump (exit 1); now it is healed automatically (lockfile resynced to the target version) with a warning.

## Out of scope

- Whether release PRs should touch `package-lock.json` as standard process (owner decision; AGENTS.md §5.4.2 currently lists only package.json + changelogs + devlog).
- Publishing itself — owner re-runs "Release (one-click)" after merge.
