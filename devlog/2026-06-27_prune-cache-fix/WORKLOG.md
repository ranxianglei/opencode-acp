# WORKLOG

## 2026-06-27

### Investigation
- Analyzed ses_102504697 cache miss data: 176 misses, 89% waste ratio
- Identified root cause: `pruneToolOutputs` mutates `part.state.output` in-place
- Confirmed via source analysis: prune.ts:94 `part.state.output = PRUNED_TOOL_OUTPUT_REPLACEMENT`
- Cross-referenced with issue #5 (nudge cache fix) — same class of bug, different pipeline

### Implementation
- Disabled `pruneToolOutputs`, `pruneToolInputs`, `pruneToolErrors` in `prune()` function
- Kept `filterCompressedRanges` (compression mechanism) intact
- Deployed hotfix to local cache for immediate testing

### Verification
- Built with `bun run build` — success
- Verified dist: `pruneToolOutputs` call count = 0
- Deployed to `~/.cache/opencode/packages/opencode-acp@latest/` — MD5 match
- Functional test: proxy + ACP working correctly

### Next Steps
- Add test coverage
- Dual-agent review
- npm publish as 1.4.2
