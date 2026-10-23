# WORKLOG - Fix one-click release lockfile drift

## Changes

| File | Change |
|------|--------|
| `package-lock.json` | version 1.16.0 → 1.18.2 (top level + `packages[""]`) — resync to match master `package.json` |
| `.github/workflows/release-manual.yml` | Bump step: exact-old-version needle replacement → idempotent JSON set (parse → set `.version` / `packages[""].version` → re-serialize with detected indent); Drift guard: non-fatal `::warning::` when lockfile ≠ package.json version |
| `devlog/2026-09-30_fix-oneclick-release-lockfile-drift/` | REQ + WORKLOG (this folder) |

No `package.json` version change → pr-checks changelog requirement not triggered. No runtime code touched.

## Verification (local, 2026-09-30)

1. **Round-trip proof**: `JSON.parse` → `JSON.stringify(obj, null, detectedIndent) + "\n"` reproduces BOTH master files byte-identically → re-serialization can only ever diff the changed line(s).
2. **Bump simulation** (new script verbatim, target 1.18.3):
   - synced state (package.json 1.18.2, lockfile 1.18.2) → diffs limited to package.json line 4 and lockfile lines 3+9;
   - drifted state (lockfile still 1.16.0 — the exact failed-run condition) → healed to 1.18.3, same minimal diff. Old script exits 1 here.
3. `python3 -c yaml.safe_load` on the modified workflow: OK.
4. `./scripts/ci/check-pr.sh 2026-09-30_fix-oneclick-release-lockfile-drift origin/master`: green.

## Follow-up for owner

After this PR merges, re-run **"Release (one-click)"** (blank version input auto-bumps over npm latest 1.18.2 → 1.18.3). If a future classic release-branch PR ships without touching the lockfile, the Bump step now self-heals instead of failing (with a warning in the log).
