# REQ: Configuration Documentation

## Problem

ACP has 60+ configurable parameters across 7 config sections (general, commands, manualMode, turnProtection, experimental, compress, gc, qualityGate). These parameters were documented only as inline code comments and a partial "Default Configuration" block in the README. Users had no comprehensive reference to discover what's configurable, what the defaults are, or which parameters are deprecated vs active.

## Requirement

Create a standalone `CONFIGURATION.md` file that documents every configurable parameter with:
- Parameter path (e.g., `compress.maxContextLimit`)
- Type
- Default value
- Status (ACTIVE / DEPRECATED / EXPERIMENTAL)
- Description

Include:
- Config file location reference (3-layer merge)
- Quick-start example
- Common config recipes (aggressive, conservative, disable, per-model, protect files)
- Removed parameters table
- Config validation note

Also update README.md and README.zh-CN.md to link to the new documentation.

## Acceptance Criteria

- [x] CONFIGURATION.md created with all parameters from `lib/config.ts` and `lib/config-validation.ts`
- [x] README.md links to CONFIGURATION.md
- [x] README.zh-CN.md links to CONFIGURATION.md
- [x] No code changes (documentation only)
