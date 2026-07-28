# WORKLOG: Deduplicate HOW_TO_COMPRESS_RULES

## Changes

### `lib/messages/inject/inject.ts`
- Removed `HOW_TO_COMPRESS_RULES` from import (line 45)
- Removed breakdown duplication block (lines 535-537): `if (effectiveTipsVariant !== "maxLimit") { breakdown += HOW_TO_COMPRESS_RULES }`

### `lib/prompts/turn-nudge.ts`
- Removed `import { HOW_TO_COMPRESS_RULES }` 
- Removed `${HOW_TO_COMPRESS_RULES}` from template

### `lib/prompts/iteration-nudge.ts`
- Removed `import { HOW_TO_COMPRESS_RULES }`
- Removed `${HOW_TO_COMPRESS_RULES}` from template

### `lib/prompts/context-limit-nudge.ts`
- Removed `import { HOW_TO_COMPRESS_RULES }`
- Removed `${HOW_TO_COMPRESS_RULES}` from template

## Verification
- TypeScript typecheck: clean
- Build: 427.93 KB (same as before — string constant was inlined)
- Tests: 917 pass, 0 fail
- Bundle grep confirms only `system.ts` retains the reference
