# REQ — Promote stable v1.14.18

Sync the `stable` npm dist-tag to v1.14.18 (currently at 1.14.13).

## Requirement

- Tag-only release: no code changes.
- CI (`release.yml`) detects the `promote: stable v1.14.18` merge title and runs
  `npm dist-tag add opencode-acp@1.14.18 stable`.

## Prerequisite

v1.14.18 must already be published to npm (`latest` tag) — i.e. PR #306 must be
merged BEFORE this PR. Otherwise `npm dist-tag add` fails with 404.

## Acceptance criteria

- Merge triggers release.yml promote-stable path (green).
- `npm view opencode-acp dist-tags` shows `stable: 1.14.18`.
