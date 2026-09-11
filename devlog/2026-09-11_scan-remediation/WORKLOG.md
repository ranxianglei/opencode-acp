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
  maintainer email path), scoped to this plugin.
- Added `.github/dependabot.yml` — weekly npm + github-actions update PRs, dev-deps grouped.
- Added `.gitattributes` — explicit binary-asset marking only (no global text rule, to avoid
  re-normalizing existing files).

## Verification

- `npm run typecheck` — PASS
- `npm run test` — PASS
- `npm run format:check` — PASS
- New text files formatted with the repo's Prettier config.

## Notes / follow-ups

- Final score confirmation requires re-running the HOL scanner (`plugin-scanner verify .`),
  which cannot be executed in the agent sandbox (no PyPI egress). To be confirmed by the
  awesome-list maintainers' re-scan.
- Optional follow-up if more score margin is needed: pin CI actions to immutable SHAs and
  review the scanner's code-policy findings (e.g. dynamic-execution patterns in auto-update).
