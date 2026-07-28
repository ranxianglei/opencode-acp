# REQ: Remove GC Module — Replace with Emergency Tool Output Truncation

## Problem

The GC module (`lib/gc/truncate.ts`) was the source of 4 bugs found during property-based testing:

1. **BUG 1**: Single-line summary GC output exceeds maxLength by 19 chars (marker string not accounted for)
2. **BUG 2**: Long header causes massive GC output overrun (header itself can be >> maxLength)
3. **BUG 3** (MOST SEVERE): Barely-over-maxLength summary silently fails truncation — GC returns LONGER string than input, `savedChars <= 0`, block NOT updated
4. **BUG 4**: Off-by-one marker reservation (reserves 20 chars for 19-char marker)

## Root Cause

The GC truncated **model-written summaries** — the most valuable, distilled content in context. This destroyed memory at the worst possible time (100% context). The truncation logic had multiple boundary bugs that either failed silently or produced output exceeding the limit.

## Solution

1. **Delete `lib/gc/truncate.ts`** entirely — remove the bug-prone module
2. **Add `lib/messages/truncate-tools.ts`** — emergency tool output truncation that:
   - Activates at the same threshold (default 100% context)
   - Truncates **tool outputs** (build logs, directory listings) — high redundancy, low density
   - Keeps 2000-char prefix + 2000-char suffix per truncated output
   - Protects the last 3 messages (model is actively working with them)
   - **Never touches summaries** — they contain essential distilled information

3. **Remove aging warning** from `nudge.ts` — it referenced GC threshold and warned about blocks "at risk of truncation", which no longer applies

4. **Keep `config.gc` fields** for backward compatibility (existing configs won't break)

## Files Changed

| File | Action |
|------|--------|
| `lib/gc/truncate.ts` | DELETED |
| `tests/gc-truncate-mock.test.ts` | DELETED |
| `tests/gc-truncate-pure.test.ts` | DELETED |
| `lib/messages/truncate-tools.ts` | NEW — emergency tool output truncation |
| `lib/hooks.ts` | Remove `runMajorGC` call, add `truncateLargeToolOutputs` call |
| `lib/prompts/extensions/nudge.ts` | Remove aging warning, remove `gcConfig` param |
| `lib/commands/manual.ts` | Update `buildCompressedBlockGuidance` call (remove gcConfig arg) |
| `tests/property-bughunt.test.ts` | Remove GC tests, keep MessageIDs/Sync/Prune tests |

## Verification

- 926 tests pass (0 failures)
- TypeScript typecheck clean
- tsup build clean
