# WORKLOG — compress.candidates 配置开关

## 变更清单

| 文件 | 变更 |
|---|---|
| `lib/config.ts` | `CompressConfig.candidates: boolean`；默认值 `false`；三层合并 `override.candidates ?? base.candidates` |
| `lib/config-validation.ts` | known paths 增加 `compress.candidates` |
| `dcp.schema.json` | compress.properties 增加 `candidates`（boolean, default false） |
| `lib/prompts/context-limit-nudge.ts` | 恢复 master 原文为 `CONTEXT_LIMIT_NUDGE`；PR 候选指令拆为 `CANDIDATE_GUIDANCE` 导出（独立 system-reminder 块，启用时追加） |
| `lib/prompts/turn-nudge.ts` | 同上：master 原文 + `TURN_CANDIDATE_GUIDANCE` |
| `lib/prompts/iteration-nudge.ts` | 同上：master 原文 + `ITERATION_CANDIDATE_GUIDANCE` |
| `lib/messages/inject/inject.ts` | `candidatesEnabled = config.compress.candidates === true` 门控 7 处：规划调用、candidateText 计算、noExecutableCandidates/nothingToCompress、applyAnchoredNudges 的 prompts 包装（启用时三模板追加候选块，防御空串）、actionHint、breakdown 💡 行（两种文案）、maxLimit 强告警文案（两种） |
| `lib/compress/status.ts` | `renderCompressionCandidates` 在 `candidates !== true` 时回退 `renderUncompressedRanges`；工具描述与 view 参数描述改为配置中立 |
| `tests/compression-candidates.test.ts`、`compression-candidates-property.test.ts`、`e2e-blocks-nudges.test.ts`、`e2e-message-transform.test.ts` | config 工厂显式 `candidates: true`（恢复 PR 行为） |
| `tests/nudge-text.test.ts` | 默认模板断言 master 文案（无 MICRO/EPISODE）；guidance 常量断言候选文案 |
| `tests/compression-candidates-switch.test.ts` | 新增 5 测试：默认关=nudge 显示 ranges 且无 MICRO/EPISODE；开=候选；默认关 status=ranges；开 status=候选；preserveRecentMessages=20 生产配置 4 轮 growth cycle（baseline→growth→nudge→压缩→新 baseline→growth→nudge） |
| `CONFIGURATION.md` / `CONFIGURATION.zh-CN.md` | `compress.candidates` 条目 + 可覆盖字段列表 |

## 关键实现决策

1. **门控以 config 为唯一信号**（不依赖 hooks 传参），测试与生产路径一致。
2. **模板拆分而非双模板**：默认模板 = master 原文（byte-exact），候选指导
   作为独立常量在启用时追加 —— 用户对模板的文件级覆盖（acp-prompts/）
   继续作用于基座，不受开关影响。
3. **关闭时零开销**：规划（全历史校验）只在 `nudgeAllowed && candidatesEnabled`
   时执行。
4. **调试发现**：`currentTokens` 取自最后一条 assistant 消息的 usage 记录
   （`getCurrentTokenUsage` 倒序查找），不是消息求和；且 inject 会向
   messages 追加合成 suffix —— 测试须按引用捕获 tail。

## 评审跟进（独立 reviewer，双评审之一）

Reviewer 结论 "fix first"，处理如下：

| 发现 | 处置 |
|---|---|
| C（Medium，开关提交引入）：docs 称 `candidates` 可按模型覆盖，但 `OVERRIDE_FIELD_TYPES`/嵌套 schema/运行时均不支持 —— 四向不一致 | ✅ 已修：`CompressOverridableConfig` Omit 列表排除 `candidates`，CONFIGURATION.md/.zh-CN 可覆盖字段列表移除（全局/项目层配置不受影响） |
| A（Low）：OFF 模式 efficiencyNote 措辞多了 "when content is no longer needed" | ✅ 已修：OFF 时恢复 master 原文 |
| D（Low）：OFF 模式 acp_status 无参概览输出 renderUncompressedRanges 块（含表头/提示）而非 master 的裸范围列表 | ✅ 已修：OFF 恢复 master 裸 `formatCompressibleRanges` + 原 Tip 行 |
| E（Info）：OFF 模式 debug 日志报 "0 candidate(s)" | ✅ 已修：OFF 恢复 master 的 range 日志行 |
| F（Info）：每次 transform 无条件 `messages.slice()` | ✅ 已修：仅 candidates 开启时拷贝 |
| B（Medium，PR 既有）：hooks.ts 管道重排（truncateLargeToolOutputs/enforceContextBudget 移到 nudge 之后）未门控 | ⛔ 保留：属 PR #341 既有设计，四轮 ework 评审通过；e2e 场景 01–12 全部在 OFF 模式下通过验证重排无害。已在 PR 评论中明示 |

## 验证

- typecheck 0 错误；**1261/1261** 测试通过；build OK。
- 开关测试含 §5.7.1 四要素：多轮（4 次调用共享 state）、副作用断言
  （shouldInjectThisTurn + lastPerMessageNudgeTokens 双断言，含 #207
  baseline 保留语义）、生产配置（preserveRecentMessages: 20）、完整
  growth cycle。

## 评审修复（review follow-up, 2026-09-12）

CI e2e 在 977643f 上失败：scenario 13 断言 `candidateSelected === true` 得 false。
根因：`scripts/e2e/scenarios/13-adaptive-compression-candidates.json` 的 acpConfig
未显式开启 `candidates`（开关默认 false）→ 无候选广播 → fake LLM 走 `resolveRange(refs,"all")`
回退路径，candidateSelected 永不置位。scenarios 01–12 全绿（默认关行为端到端一致）。
修复：该场景 JSON 增加 `"candidates": true`。

系统提示泄漏候选文案：`lib/prompts/system.ts` / `lib/prompts/compress-range.ts`
的模板此前无条件包含候选指导（acp_status 描述、COMPRESSION CANDIDATES 节、
breakdown 段、compress 工具提示的 CANDIDATE GUIDANCE 段），与"默认 false =
master 完全一致"的承诺不符（关闭时 acp_status 描述甚至与实际默认视图矛盾）。
修复：两模板改为构建函数 `buildSystemPrompt(candidatesEnabled)` /
`buildCompressRangePrompt(candidatesEnabled)`，OFF 分支使用 master 原文（程序化
提取自 origin/master，非手抄），ON 分支与原 PR 输出字节一致（已验证）；
`PromptStore` 构造器新增第 4 参 `candidatesEnabled`（默认 false），由 index.ts
按 `config.compress.candidates === true` 传入；`SYSTEM` / `COMPRESS_RANGE`
导出保留（= ON 变体），向后兼容。compress-range.ts 中 startId/endId 措辞改动
（Bug 34 auto-swap 说明）保持无条件 —— 该能力不受开关控制。

测试：`tests/prompts.test.ts` fixture 工厂加 `candidatesEnabled` 参数；既有
range-mode compress prompt 测试显式开启；新增 2 测试（store 级开/关门控、
`buildSystemPrompt(false)` master 文案回归）。

验证：typecheck 0 错误；**1263/1263** 测试通过；build OK；prettier 通过；
`buildSystemPrompt(true)` / `buildCompressRangePrompt(true)` 与开关提交前输出
逐字节比对一致。
