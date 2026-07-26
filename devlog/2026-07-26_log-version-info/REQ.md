# Add ACP Version Info to Logs

## Problem
Daily logs and context logs had no ACP version info. When investigating issues across sessions that ran different ACP versions, there was no way to determine which version produced each log entry.

## Solution
- **Daily log**: Append `| v={VERSION}` to every log line
- **Context log**: Write `_version` file in each session's context directory (first-write only)
- Version injected at build time via tsup `define` from `package.json`

## Changes
- `tsup.config.ts`: Added `define: { ACP_VERSION: pkg.version }`
- `lib/logger.ts`: `LOG_VERSION` constant + daily log suffix + context `_version` file
