# REQ: Promote allowSubAgents to Top-Level + Default True

## Problem

`allowSubAgents` was under `experimental` config namespace with default `false`. The feature is stable, tested, and useful — subagent sessions benefit from compression just like main sessions. Keeping it experimental and off by default prevents users from discovering it.

## Requirements

1. Move `allowSubAgents` from `experimental.allowSubAgents` to top-level `allowSubAgents`
2. Change default from `false` to `true`
3. Full backward compatibility: old `experimental.allowSubAgents` still read (top-level takes priority)
4. Update all documentation (README, CONFIGURATION, AGENTS.md)
5. Update JSON schema (dcp.schema.json)

## Acceptance Criteria

- [x] `config.allowSubAgents` is a top-level boolean field
- [x] Default is `true` (was `false`)
- [x] Old `experimental.allowSubAgents` configs still work (backward compat)
- [x] All 4 hooks sites updated (`index.ts` line 111, `hooks.ts` lines 89/110/166)
- [x] JSON schema updated with top-level field + deprecated experimental field
- [x] README.md, README.zh-CN.md, CONFIGURATION.md, CONFIGURATION.zh-CN.md updated
- [x] AGENTS.md §2.4 default config updated
- [x] Typecheck passes
- [x] All 954 tests pass
- [x] Dual-agent review
