# REQ: Bump context-compress-algorithms to 1.3.0

## Problem

cc-alg 1.3.0 ships holistic TIER2/TIER3 compression prompts (summarize by theme,
not per-block). The old per-block format caused length overflow when compressing
70+ T1 blocks (issue #256). ACP needs to consume the updated prompts.

## Solution

Update `context-compress-algorithms` dependency from 1.2.1 to 1.3.0.

## Scope

- `package.json` — version bump
- `package-lock.json` — lockfile update
