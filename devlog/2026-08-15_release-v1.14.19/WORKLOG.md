# WORKLOG — v1.14.19

## Investigation

1. PR #306 (v1.14.18) merged → release.yml failed at same `verify-package.mjs` step: `SyntaxError: Unexpected token '', "[34mCLI["... is not valid JSON`
2. Initial assumption: same root cause as v1.14.17. But v1.14.18 already added `--ignore-scripts`...
3. Key insight: CI runner = Node 22 → npm 10.9.x. Local = Node 25 → npm 11.12.1.
4. Empirical test with `npx -y npm@10 pack --dry-run --json --ignore-scripts`:
   - npm 10.9.9: prepare STILL RUNS despite `--ignore-scripts` → stdout polluted ❌
   - npm 11.12.1: flag works → clean stdout ✓
   - This explains why v1.14.18 passed local verification but failed CI.

## Fix

- `package.json`: `"prepare": "npm run build 1>&2"` — redirect build stdout to stderr
- Verified: npm 10.9.9 `npm pack --dry-run --json` returns valid JSON (173 entries), with and without `--ignore-scripts`
- Version bumped to 1.14.19
- Changelog entries added to README.md + README.zh-CN.md

## Verification

- `npm run build`: 391.59 KB ✓
- `node scripts/verify-package.mjs`: "package verification passed for opencode-acp@1.14.19, tarball entries: 173" ✓
- Full check:package path green
