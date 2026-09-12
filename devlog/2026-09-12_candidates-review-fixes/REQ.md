# REQ — PR #341 候选开关的评审修复(A/C/D/E/F)

## 背景

PR #341(`compress.candidates` 开关)合并后,独立 reviewer 评审结论
"fix first"。其中 finding C(Medium)由开关提交引入,其余为 PR 分支带入
master 的 OFF 模式偏差。本 PR 落地全部代码级修复;finding B(hooks 管道
重排)按评审建议保留并在 PR 描述明示。

## 需求(与 reviewer 报告对应)

| # | 发现 | 修复 |
|---|---|---|
| C | `candidates` 被类型/文档标为可按模型覆盖,但 `OVERRIDE_FIELD_TYPES`/嵌套 schema/运行时均不支持 | `CompressOverridableConfig` Omit 排除 + CONFIGURATION.md/.zh-CN 可覆盖字段列表移除 |
| A | OFF 模式 efficiencyNote 措辞 ≠ master("when content is no longer needed" 多出) | OFF 分支恢复 master 原文 |
| D | OFF 模式 acp_status 无参概览输出 renderUncompressedRanges 块(表头/提示)而非 master 裸范围列表;Tip 行多了 view:"ranges" 提示 | OFF 恢复 master 裸 `formatCompressibleRanges` + 原 Tip 行 |
| E | OFF 模式 debug 日志报 "0 candidate(s)" | OFF 恢复 master 的 `range(s)` 日志行 |
| F | 每次 transform 无条件 `messages.slice()` | 仅 `candidates === true` 时拷贝 |

## 不修(有意保留)

- **B**:`truncateLargeToolOutputs`/`enforceContextBudget` 移到 nudge 注入
  之后 —— PR #341 既有设计,e2e 场景 01–12 全部在 OFF 模式通过,两种模式
  统一管道,不做按开关分叉。

## 验收

- OFF(`candidates` 缺省/false)模式下 nudge/breakdown/acp_status/debug
  输出与 v1.17.1 逐字节一致(开关提交触及的所有字符串)。
- typecheck / 全量测试 / build 通过。
