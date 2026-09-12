# REQ — compress.candidates 配置开关（默认关闭）

## 背景

PR #341（adaptive compression candidates）引入 MICRO/EPISODE 压缩候选：
nudge 与 `acp_status` 显示预先校验、可批量提交的压缩目标，取代原始范围
列表。经评审讨论：算法在机械层严格不劣（executor-parity、工具对闭包、
fail-closed），但语义层缺乏定量 A/B 数据，直接全量上线有回归风险。

## 需求

为候选功能加配置开关 `compress.candidates`：

1. **默认 `false`** —— 行为与 master（PR 合入前）完全一致：
   - nudge 模板用原始文案（"largest ranges"、RANGE STRATEGY）
   - nudge/breakdown 显示 `formatCompressibleRanges` 范围列表
   - `acp_status scope:"uncompressed"` 默认视图为 ranges
   - 不执行候选规划（零性能开销）
2. **显式 `true`** —— 启用候选模式（PR #341 原行为）：
   - 三个 nudge 模板（context-limit/turn/iteration）追加候选指导块
   - nudge/breakdown 显示 MICRO/EPISODE 候选列表 + 批量提示
   - `acp_status` 默认视图为 candidates
3. 配置需贯通：类型、默认值、三层合并、unknown-key 白名单、JSON schema、
   中英文文档。
4. 测试：既有候选测试改为显式 `candidates: true`；新增开关测试文件，满足
   §5.7（多轮、副作用断言、preserveRecentMessages=20 生产配置、完整
   growth cycle）。

## 验收标准

- `npm run typecheck`、`npm run test`、`npm run build` 全绿。
- 默认配置下 nudge/acp_status 输出与 master 文案逐字一致。
- 开启后候选行为与 PR #341 评审版一致（模板指导块以追加方式恢复）。
