# REQ: /acp stats command as acp_status wrapper

## Problem

PR #233 removed `/acp stats` along with other redundant slash commands. Users lost direct access to compression status from the command bar.

## Solution

Re-add `/acp stats` (and `/acp status` alias) as a thin wrapper around `buildStatusReport` — the same logic used by the model-facing `acp_status` tool. This gives users the acp_status overview via slash command without duplicating any rendering logic.

## Changes

1. **`lib/compress/status.ts`**: Extract `buildStatusReport()` from `createAcpStatusTool.execute`. The tool's execute now delegates to it. Introduced `StatusRenderContext` interface (`{ state, config? }`) replacing `ToolContext` in internal render functions.

2. **`lib/commands/stats.ts`** (new): `handleStatsCommand` calls `buildStatusReport` with no args (overview) and sends result via `sendIgnoredMessage`.

3. **`lib/commands/index.ts`**: Export `handleStatsCommand`.

4. **`lib/hooks.ts`**: Dispatch `stats`/`status` sub-args to `handleStatsCommand`.

5. **`tests/stats-command.test.ts`** (new): 3 tests covering overview, token breakdown, compressed scope.

## User experience

```
/acp stats
```
Shows the same overview as `acp_status` tool: visible context breakdown, compressed blocks, compressible ranges.
