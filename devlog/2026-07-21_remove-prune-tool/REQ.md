# REQ - Remove dead `prune` tool

- Task ID: `2026-07-21_remove-prune-tool`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-07-21

## Goal

Remove the `prune` tool from the model-facing surface, since its writes to
`state.prune.tools` are never consumed (the three stripping functions in
`lib/messages/prune.ts` have been commented out since the Bug 38 HOTFIX in
v1.10.0 — in-place mutation broke GLM prefix cache). The tool reported success
("Pruned N calls") while doing nothing. Range-mode `compress` already covers
the same use case end-to-end (a todowrite/edit echo inside a compressed range
gets summarized along with everything else).

## Scope

Minimal, surgical removal:

1. **`index.ts`** — drop `createPruneTool` import and the `prune:` registration
   in the `tool:` object.
2. **`lib/compress/index.ts`** — drop the `createPruneTool` barrel export.
3. **`lib/prompts/system.ts`** — drop the `- \`prune\` —` line from the TOOLS
   section of the rendered system prompt.
4. **`lib/compress/prune-tool.ts`** — delete (now unreferenced).

## Non-Goals (intentionally left as-is)

- `lib/messages/prune.ts` still defines `pruneToolOutputs` / `pruneToolInputs` /
  `pruneToolErrors` (dead, commented out at the call site since v1.10.0).
  Cleanup is a separate refactor.
- `state.prune.tools` field still exists in the state type. The
  `deduplication` and `purgeErrors` strategies still write to it; their
  stripping is also disabled by the same HOTFIX. That's a separate issue from
  the one being fixed here.
- Tests touching `state.prune.tools` (strategies, persistence, e2e) stay —
  they exercise functions that still exist, just aren't called by the runtime
  pipeline.
- No persisted-state migration: nothing reads `state.prune.tools` at runtime,
  so stale entries in existing session JSON files are harmless.

## Compatibility

- No persisted state format change.
- No config change. Users who explicitly listed `prune` in
  `protectedTools` / `compress.protectedTools` arrays simply have a now-unused
  entry; it does not cause errors.
- System prompt loses one bullet. Models that previously called `prune` will
  fall back to `compress` (the strictly more capable tool for the same job).

## Why not also re-enable proper stripping?

Re-enabling in-place mutation would re-introduce the GLM prefix-cache
regression (Bug 38). The right long-term fix is a content-preserving
strategy — that work is tracked separately.

## Links

- GitHub issue: ranxianglei/opencode-acp#116
- Related: Bug 38 HOTFIX (v1.10.0), PR #171 (v1.13.2)
