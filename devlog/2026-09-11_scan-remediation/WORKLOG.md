# WORKLOG — Add security & dependency-hygiene files

## Investigation

- Confirmed via the awesome-list PR (#275) CI that the HOL "Scan PR" check failed for
  `opencode-acp` at **79/100** (needs ≥ 80); findings: 0 critical / 0 high / 13 medium /
  2 low.
- Read the scanner source (`hashgraph-online/hol-guard`, `src/codex_plugin_scanner/`) to
  understand scoring: final score = `round(Σ check.points / Σ check.max_points × 100)`.
  Findings group by category (security, operational-security, best-practices, marketplace,
  …); each failing check forfeits its points. Rules live in `rules/registry.py`.
- Audited this repo against the fixable rules. **Missing:** `SECURITY.md`,
  `.github/dependabot.yml`, `.gitattributes`. **Already present/passing:** `README.md`,
  `LICENSE` (+ `license` field), `package-lock.json`, `tests/`, `CONTRIBUTING.md`.

## Implementation

- Added `SECURITY.md` — private vulnerability-reporting policy (GitHub Security Advisory +
  maintainer contact via GitHub profile), scoped to this plugin.
- Added `.github/dependabot.yml` — weekly npm + github-actions update PRs, dev-deps grouped.
- Added `.gitattributes` — explicit binary-asset marking only (no global text rule, to avoid
  re-normalizing existing files).

## Verification

- `npm run typecheck` — PASS
- `npm run test` — PASS
- `npm run format:check` — PASS
- New text files formatted with the repo's Prettier config.

## Review round 1 (2026-09-12)

Review of PR #388 found one blocking issue plus two wording issues; all fixed directly
on this branch:

- **Blocking — dependabot vs pr-validation**: `scripts/ci/check-pr.sh` enforces branch
  naming (`YYYY-MM-DD_short-title`) and devlog existence; dependabot branches
  (`dependabot/npm_and_yarn/...`) violate both, so every future dependabot PR would fail
  the required `pr-validation` check and be unmergeable. Fix: exempt `dependabot/*`
  branches from checks 1–3 (check 4, changelog/version, still applies); exemption
  documented in AGENTS.md §5.1.2.
- **SECURITY.md — maintainer contact**: pointed at the `author` field in package.json,
  which contains no email address → now points at the maintainer's GitHub profile.
- **SECURITY.md — supported versions**: covered only `opencode-acp@latest`, but the README
  installs `@stable` and both dist-tags exist on npm → policy now covers both lines.

Re-verification after fixes:

- `bash scripts/ci/check-pr.sh dependabot/npm_and_yarn/example-1.0.0 origin/master` — PASS
  (skips checks 1–3 with warning)
- `bash scripts/ci/check-pr.sh bad-branch-name origin/master` — FAILS as before
  (human branches still fully enforced)
- `npm run format:check` — PASS

## Notes / follow-ups

- Final score confirmation requires re-running the HOL scanner (`plugin-scanner verify .`),
  which cannot be executed in the agent sandbox (no PyPI egress). To be confirmed by the
  awesome-list maintainers' re-scan.
- Optional follow-up if more score margin is needed: pin CI actions to immutable SHAs and
  review the scanner's code-policy findings (e.g. dynamic-execution patterns in auto-update).
