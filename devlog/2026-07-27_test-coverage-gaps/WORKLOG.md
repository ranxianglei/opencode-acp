# Worklog

## 2026-07-27

- Analyzed test gap: 5 structural reasons why baseline-reset bug (PR #207) survived 900+ tests
- Updated AGENTS.md §5.7: mandatory nudge/growth testing requirements (multi-turn, side-effects, production config, Docker E2E nudge verification)
- Enhanced `scripts/e2e/verify.ts`: added `nudgeBaselineSet` verify field
- Updated `scripts/e2e/README.md`: added scenario 05 to table, documented `nudgeBaselineSet`

## Round-3 (user feedback: real nudge→compress flow)

User said: "你这个应该在E to E里面，docker里面测试，实际的Open Code中测试，让它真实的触发压缩" + "你就检测是否发出注入，如果有的话，然后再给它发送命令"

Implemented real nudge→compress flow:
1. Added `detectNudge(messages)` to `fake-llm-server.ts` — scans system+user messages for ACP nudge markers (`[ACP]`, `compressible ranges`, `Breakdown:`, `Context:` + `compress`)
2. Added `"respond": "nudge-compress"` step type:
   - No nudge detected → emit `growthText` (large text to grow context)
   - Nudge detected → emit compress tool call (using provided summary/range)
   - After compress succeeds → emit acknowledgment text
3. Lowered E2E config `maxContextLimit: 20000` + `minContextLimit: 10000` so nudge fires after ~5K tokens of growth
4. Created scenario `06-nudge-triggered.json`: 7 nudge-compress turns with ~1K char growth text each. After ~4-5 turns context hits 20K → ACP injects nudge → server detects it → compresses
5. Updated README: documented nudge-compress type + scenario 06
