# REQ — Add security & dependency-hygiene files (HOL scan remediation)

## Background

`opencode-acp` was nominated for inclusion in
[hashgraph-online/awesome-ai-plugins](https://github.com/hashgraph-online/awesome-ai-plugins)
(see [issue #387](https://github.com/ranxianglei/opencode-acp/issues/387)). The catalog's HOL
centralized scanner scored `opencode-acp` at **79/100**, one point below the required
**≥ 80** pass threshold (0 critical / 0 high / 13 medium / 2 low).

The gap is driven largely by missing best-practice artifacts rather than by defects in the
plugin code.

## Goal

Raise the repository's HOL scan score to ≥ 80 by adding the standard, genuinely-useful
artifacts the scanner expects — without changing any plugin behavior.

## Changes

| File | Purpose | Scanner rule addressed |
| ---- | ------- | ---------------------- |
| `SECURITY.md` | Private vulnerability-reporting policy | `SECURITY_MD_MISSING` (security, medium) |
| `.github/dependabot.yml` | Weekly npm + GitHub Actions update PRs | `DEPENDABOT_MISSING` (operational-security, low) |
| `.gitattributes` | Explicitly mark binary assets | general repository hygiene |

Note: `.gitattributes` deliberately sets **no global text rule** — only explicit binary
markings — so it cannot re-normalize line endings of already-committed files.

## Non-goals

- No changes under `lib/`, `index.ts`, or `tests/` — behavior is untouched, so no dual-agent
  code review is required.
- No `version` bump (this is not a release PR).
- No changes to existing CI workflow action versions (kept out of scope to avoid churning the
  release pipeline; a follow-up if the score needs more margin).

## Acceptance criteria

- `npm run typecheck`, `npm run test`, and `npm run format:check` all pass.
- New files present and correctly formatted.
- PR references issue #387.
