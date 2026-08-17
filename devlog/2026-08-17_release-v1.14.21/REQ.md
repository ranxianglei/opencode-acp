# REQ — v1.14.21: /acp command fixes and completion (permission gate, export, help)

## Problem

Single-PR release shipping #286 (merged as `c230d6e`), which fixed three gaps in the `/acp` command suite:

1. **All `/acp` subcommands swallowed when compress permission = `deny`.** The command handler carried a pre-#233 `deny` gate from the era when `/acp` triggered compression. Every current subcommand (`context`, `stats`, `export`) is read-only or user-initiated, so the gate only broke legitimate usage (reported in #285 alongside the bare-command behavior mismatch).
2. **Bare `/acp` diverged from pi-acp and from the README.** pi-acp's bare `/acp` shows the full compression status report (same handler as `/acp-status`); opencode-acp showed help text.
3. **`/acp export` (#265) unimplemented** — no way to export compression blocks out of the session.

## Fix (all in #286)

- Removed the compress-permission `deny` gate from `createCommandExecuteHandler` (`lib/hooks.ts`).
- Bare `/acp` / `/dcp` now dispatches to `handleStatsCommand` (same report as `acp_status` tool); `/acp help` shows the command list.
- New `/acp export` (`lib/commands/export.ts`, ~430 lines): exports active compression blocks to markdown with `--output <path>`, `--tier t1,t2,t3`, `--stdout`, `--append`.

Closes: #285, #265.

## Acceptance

- All existing tests pass
- Release commit touches only `package.json` + lock; changelog + devlog on the release branch
- `./scripts/ci/check-pr.sh` green
- release.yml publishes v1.14.21 to npm `latest` after merge
