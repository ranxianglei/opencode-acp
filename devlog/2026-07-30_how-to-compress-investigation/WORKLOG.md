# WORKLOG: Re-add HOW_TO_COMPRESS_RULES to nudge injection

## 2026-07-30

### Investigation
- User reported "how to compress" injection getting lost (session ses_0b89319b, floor 8683)
- Checked deployed bundle: HOW_TO_COMPRESS_RULES IS in system prompt (system.ts:58)
- Checked debug nudge message: COMPRESS_PHILOSOPHY present but HOW_TO_COMPRESS_RULES missing
- Root cause: v1.14.7 (PR #228) removed rules from nudge to save tokens; kept in system prompt only
- "Lost in the middle" effect: system prompt is 12K chars at START of 1M+ token context — low attention
- Nudge message is at END of context — high attention — but rules are no longer there

### Implementation
- `inject.ts:44`: Added `HOW_TO_COMPRESS_RULES` to import from cc-alg
- `inject.ts:534`: Added rules before compressible ranges list (non-maxLimit path)
- `inject.ts:545`: Added rules to strong alert tipsText (maxLimit path)

### Verification
- typecheck: clean
- 934 tests pass (0 failures)
