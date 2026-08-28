# ACP 配置参考手册

[English](./CONFIGURATION.md) | [中文](./CONFIGURATION.zh-CN.md)

Active Context Pruning (ACP) 所有可配置参数的完整参考手册。

## 配置文件位置

ACP 从最多三层配置文件中读取（后加载的覆盖先加载的）：

| 层级 | 路径 | 作用范围 |
|------|------|---------|
| **全局** | `~/.config/opencode/acp.jsonc` | 所有会话 |
| **配置目录** | `$OPENCODE_CONFIG_DIR/acp.jsonc` | 该配置目录下的所有会话 |
| **项目** | `.opencode/acp.jsonc`（从当前目录向上搜索） | 仅当前项目 |

> **提示：** 在配置文件中添加 `"$schema": "https://raw.githubusercontent.com/ranxianglei/opencode-acp/master/dcp.schema.json"` 可获得 IDE 自动补全。

## 快速开始

```jsonc
// ~/.config/opencode/acp.jsonc
{
    "$schema": "https://raw.githubusercontent.com/ranxianglei/opencode-acp/master/dcp.schema.json",
    "enabled": true,
    "compress": {
        "maxContextLimit": "70%",
        "minContextLimit": "70%",
        "protectedTools": ["skill"]
    }
}
```

---

## 参数参考

状态说明：**ACTIVE** = 当前生效 | **DEPRECATED** = 接受但无效果 | **EXPERIMENTAL** = 可能变更

---

### 通用参数

#### `enabled`
- **类型：** `boolean`
- **默认值：** `true`
- **状态：** ACTIVE
- **说明：** 主开关。设为 `false` 可完全禁用 ACP。

#### `autoUpdate`
- **类型：** `boolean`
- **默认值：** `true`
- **状态：** ACTIVE
- **说明：** 启动时自动检查并安装 ACP 更新，跟踪安装时所用的 dist-tag/规范（`opencode-acp@stable` 跟随 `stable` 标签；`^1.14.0` 等范围规范跟随 `latest`）。版本锁定的规范永不更新。

#### `debug`
- **类型：** `boolean`
- **默认值：** `false`
- **状态：** ACTIVE
- **说明：** 启用调试模式。设为 `true` 时，ACP 在每次压缩后发送聊天通知，显示块详情，并将 `logLevel` 置为 `debug`（INFO/DEBUG 日志与按请求的上下文快照，`~/.config/opencode/logs/acp/`）。设为 `true` 时此开关优先于 `logLevel`。

#### `logLevel`
- **类型：** `"debug" | "info" | "warn" | "error" | "silent"`
- **默认值：** `"info"`
- **状态：** ACTIVE
- **说明：** 文件日志详细级别（`~/.config/opencode/logs/acp/daily/<日期>.log`）。默认 `info`：默认落盘决策级事件（压缩提示决策、转换摘要、自动更新检查、模型切换等）。`warn`/`error` 减少输出；`silent` 完全关闭文件日志；`debug` 额外启用按请求的上下文快照与详细转储。`debug: true` 时忽略此配置。

#### `pruneNotification`
- **类型：** `"off" | "minimal" | "detailed"`
- **默认值：** `"off"`
- **状态：** ACTIVE
- **说明：** 压缩通知的详细程度。
  - `"off"` — 不显示通知
  - `"minimal"` — 简短的一行摘要
  - `"detailed"` — 完整块详情（主题、token 数量、范围）

#### `pruneNotificationType`
- **类型：** `"chat" | "toast"`
- **默认值：** `"toast"`
- **状态：** ACTIVE
- **说明：** 压缩通知的投递方式。
  - `"toast"` — 瞬时弹窗提示（推荐；非阻塞）
  - `"chat"` — 注入为聊天消息（部分 provider 拒绝空消息时可能冻结会话）

#### `protectedFilePatterns`
- **类型：** `string[]`
- **默认值：** `[]`
- **状态：** ACTIVE
- **说明：** 需保护文件内容的 Glob 匹配模式。当模型读取匹配这些模式的文件时，工具输出会被注入到压缩摘要中，而非被压缩。示例：`["**/*.env", "**/secrets.json"]`

---

### `commands`

控制 ACP 斜杠命令（`/acp context`、`/acp stats` 等）。

#### `commands.enabled`
- **类型：** `boolean`
- **默认值：** `true`
- **状态：** ACTIVE
- **说明：** 启用或禁用所有 `/acp` 斜杠命令。

#### `commands.protectedTools`
- **类型：** `string[]`
- **默认值：** `["task", "skill", "todowrite", "todoread", "compress", "decompress", "batch", "plan_enter", "plan_exit", "write", "edit"]`
- **状态：** ACTIVE
- **说明：** 这些工具的输出受保护，不会被压缩。受保护工具的输出完整保留在可见上下文中。显式数组会**替换**默认值（设 `[]` 表示不保护任何工具）。

---

### `allowSubAgents`

- **类型：** `boolean`
- **默认值：** `true`
- **状态：** ACTIVE
- **说明：** 允许 ACP 在子代理（sub-agent）会话中运行。开启后，子代理会话获得完整的压缩、nudge 和上下文管理能力。设为 `false` 可将 ACP 限制在主会话中。
- **迁移：** v1.14.13 从 `experimental.allowSubAgents`（默认 `false`）移至顶层 `allowSubAgents`（默认 `true`）。旧的 `experimental.allowSubAgents` 仍可读取以保持向后兼容 —— 顶层优先。

---

### `experimental`

实验性功能，可能变更或移除。

#### `experimental.customPrompts`
- **类型：** `boolean`
- **默认值：** `false`
- **状态：** EXPERIMENTAL
- **说明：** 启用从 `~/.config/opencode/acp-prompts/` 加载自定义 prompt 覆盖。

---

### `compress`

核心压缩行为。

#### `compress.permission`
- **类型：** `"ask" | "allow" | "deny"`
- **默认值：** `"allow"`
- **状态：** ACTIVE
- **说明：** `compress` 工具的权限级别。
  - `"allow"` — 自动批准压缩调用
  - `"ask"` — 每次压缩前提示用户确认
  - `"deny"` — 阻止所有压缩调用

#### `compress.showCompression`
- **类型：** `boolean`
- **默认值：** `true`
- **状态：** ACTIVE
- **说明：** 在聊天 UI 中显示压缩状态指示。

#### `compress.summaryBuffer`
- **类型：** `boolean`
- **默认值：** `true`
- **状态：** ACTIVE
- **说明：** 将摘要缓冲区指引注入系统 prompt，帮助模型了解现有块及其覆盖范围。

#### `compress.maxContextLimit`
- **类型：** `number | \`${number}%\``
- **默认值：** `"55%"`
- **状态：** ACTIVE
- **说明：** 上下文使用率上限（以模型上下文窗口的百分比或绝对 token 数表示）。超过此值时，ACP 提示模型进行压缩。示例：`"55%"` 或 `100000`。

#### `compress.minContextLimit`
- **类型：** `number | \`${number}%\``
- **默认值：** `"45%"`
- **状态：** ACTIVE
- **说明：** 上下文使用率下限。使用率降至此值以下时，ACP 停止 nudge。

#### `compress.modelMaxLimits`
- **类型：** `Record<string, number | \`${number}%\`>`
- **默认值：** `undefined`
- **状态：** ACTIVE
- **说明：** 按模型覆盖 `maxContextLimit`。以模型 ID 为键。示例：`{"gpt-4": 80000, "claude-3-opus": "50%"}`

#### `compress.modelMinLimits`
- **类型：** `Record<string, number | \`${number}%\`>`
- **默认值：** `undefined`
- **状态：** ACTIVE
- **说明：** 按模型覆盖 `minContextLimit`。

#### `compress.contextLimitFallback`
- **类型：** `number`
- **默认值：** `128000`
- **状态：** ACTIVE
- **说明：** 当模型上下文窗口未知时使用的回退窗口（绝对 token 数）——例如未声明 limit 的自定义 provider、从未学到 limit 的 headless spawn+resume 会话，或模型切换使旧 limit 失效后的短暂窗口。驱动所有百分比阈值（`maxContextLimit`/`minContextLimit`）、紧急 nudge 覆盖、批量清理 GC 与 in-flight 工具输出截断。已知真实模型 limit 时始终优先，按模型覆盖（`modelMaxLimits`/`modelMinLimits`）同样优先。设为 `0` 可禁用回退（旧行为：学到 limit 前无安全网）。

#### `compress.nudgeFrequency`
- **类型：** `number`
- **默认值：** `5`
- **状态：** ACTIVE
- **说明：** nudge 注入之间的最小轮数间隔。防止每轮都打扰模型。

#### `compress.minNudgeContextPercent`
- **类型：** `number`
- **默认值：** `15`
- **状态：** ACTIVE
- **说明：** 触发任何 nudge 的最低上下文使用率百分比。低于此值时不注入 nudge。

#### `compress.nudgeGrowthTokens`
- **类型：** `number`
- **默认值：** `50000`（固定值）
- **状态：** ACTIVE
- **说明：** nudge 增长阈值。当上下文自上次 nudge 以来增长超过此 token 数时，ACP 触发 nudge。默认值为固定值，所有模型上下文窗口大小一致（此前按窗口百分比缩放——v1.14.23 移除，因会导致小窗口模型 nudge 频率约 4 倍偏高）。

#### `compress.toolOutputNudgeThreshold`
- **类型：** `number`
- **默认值：** `undefined`
- **状态：** ACTIVE
- **说明：** 专门针对工具输出的 nudge token 阈值。当工具输出超过此值时，定向 nudge 建议压缩工具输出。

#### `compress.iterationNudgeThreshold`
- **类型：** `number`
- **默认值：** `15`
- **状态：** ACTIVE
- **说明：** 当自上次用户消息以来积累了此数量的消息时，注入迭代 nudge（表示无用户交互的长工具调用链）。

#### `compress.nudgeForce`
- **类型：** `"strong" | "soft"`
- **默认值：** `"soft"`
- **状态：** ACTIVE
- **说明：** nudge 的语气。
  - `"soft"` — 信息性，让模型自行决定
  - `"strong"` — 更紧迫，强调上下文溢出风险

#### `compress.protectedTools`
- **类型：** `string[]`
- **默认值：** `["skill", "compress"]`
- **状态：** ACTIVE
- **说明：** 这些工具的输出会从压缩范围中软过滤。与 `commands.protectedTools`（硬保护）不同，这些工具的输出从可压缩范围中排除，但其内容仍可在摘要中被引用。显式数组会**替换**默认值。

> **注意：** `"compress"` 无论用户配置如何，都会被强制追加到此列表 — 压缩工具调用绝不能丢失。

#### `compress.protectTags`
- **类型：** `boolean`
- **默认值：** `false`
- **状态：** ACTIVE
- **说明：** 设为 `true` 时，`<protect>...</protect>` 标签包裹的内容受保护，不被压缩。

#### `compress.protectUserMessages`
- **类型：** `boolean`
- **默认值：** `false`
- **状态：** ACTIVE
- **说明：** 设为 `true` 时，所有用户消息受保护，不被压缩（不仅仅是最后一条）。

#### `compress.maxSummaryLengthHard`
- **类型：** `number`
- **默认值：** `20000`
- **状态：** ACTIVE
- **说明：** 摘要长度的硬限制（字符数）。摘要超过此长度的压缩调用会被拒绝。

#### `compress.minCompressRange`
- **类型：** `number`
- **默认值：** `5000`
- **状态：** ACTIVE
- **说明：** 压缩范围的最小估算 token 数。小于此值的范围会从推荐列表中过滤掉（不值得压缩）。

#### `compress.minNudgeGrowthRatio`
- **类型：** `number`
- **默认值：** `0.45`
- **状态：** ACTIVE
- **说明：** 用于计算 nudge 增长下限的 `nudgeGrowthTokens` 比例。值越大 = nudge 频率越低。

#### `compress.minNudgeGrowthFloor`
- **类型：** `number`
- **默认值：** `5000`
- **状态：** ACTIVE
- **说明：** nudge 增长阈值的最小 token 数。实际阈值为 `max(此值, minNudgeGrowthRatio × nudgeGrowthTokens)`。

#### `compress.emergencyThresholdPercent`
- **类型：** `number | \`${number}%\``
- **默认值：** `"98%"`
- **状态：** ACTIVE
- **说明：** 触发"紧急"模式的上下文使用率阈值。超过此值时，ACP 覆盖所有保护过滤器，强制 nudge 模型立即压缩。

#### `compress.maxVisibleSegments`
- **类型：** `number`
- **默认值：** `50`
- **状态：** ACTIVE
- **说明：** 系统 prompt 中分段指引显示的最大可见上下文分段数。

#### `compress.keepEmbedMaxChars`
- **类型：** `number`
- **默认值：** `2000`
- **状态：** ACTIVE
- **说明：** 在压缩摘要中使用 `[[KEEP:mNNNNN]]` 标记时，每条消息嵌入的最大字符数。

#### `compress.lastSegmentSoftBlock`
- **类型：** `boolean`
- **默认值：** `true`
- **状态：** ACTIVE
- **说明：** 设为 `true` 时，最后一个可见分段（最新消息）被视为软块 — 从压缩推荐中排除，但可通过 `dangerous: true` 覆盖。

#### `compress.preserveRecentMessages`
- **类型：** `number`
- **默认值：** `5`
- **状态：** ACTIVE
- **说明：** 保护最近 N 条消息不被压缩。这些消息会从可压缩范围中软过滤。设为 `0` 可禁用。

#### `compress.preserveRecentTokens`
- **类型：** `number`
- **默认值：** `5000`
- **状态：** ACTIVE
- **说明：** 近期消息保护的 token 预算。除了最近 N 条消息外，ACP 还保护此 token 预算内的消息（从最近消息向后扩展）。设为 `0` 可禁用。

#### `compress.preserveLastUserMessage`
- **类型：** `boolean`
- **默认值：** `true`
- **状态：** ACTIVE
- **说明：** 始终保护最近一条用户消息不被压缩，无论 `preserveRecentMessages` 或 `preserveRecentTokens` 如何设置。

---

### `gc`（生成与清理）

> **注意：** GC 截断模块（`gc/truncate.ts`）已在 v1.14.4 中移除。剩余的 `gc` 字段用于块生成追踪和批量清理（块合并）。旧配置文件中的这些字段仍然有效。

#### `gc.algorithm`
- **类型：** `"truncate"`
- **默认值：** `"truncate"`
- **状态：** DEPRECATED
- **说明：** 历史上用于选择 GC 算法。只实现过 `"truncate"`。现为 no-op — 仅为配置兼容性保留。

#### `gc.promotionThreshold`
- **类型：** `number`
- **默认值：** `5`
- **状态：** ACTIVE
- **说明：** 压缩块在从 `"young"`（新生代）提升为 `"old"`（老生代）之前，必须存活的消息变换周期数。老生代块有资格被 `gc/merge.ts` 批量合并。

#### `gc.maxBlockAge`
- **类型：** `number`
- **默认值：** `9007199254740991`（`Number.MAX_SAFE_INTEGER`）
- **状态：** DEPRECATED
- **说明：** 历史上控制基于块年龄的去激活。已设为无穷大 — 实际禁用。仅为配置兼容性保留。

#### `gc.maxOldGenSummaryLength`
- **类型：** `number`
- **默认值：** `3000`
- **状态：** ACTIVE
- **说明：** 当批量清理将多个老生代块合并为更高层级的块时，合并后摘要的最大长度（字符数）。

#### `gc.majorGcThresholdPercent`
- **类型：** `number | \`${number}%\``
- **默认值：** `"100%"`
- **状态：** ACTIVE
- **说明：** 触发紧急工具输出截断的上下文使用率阈值。当上下文达到此级别时，最大的工具输出会被截断（保留 2000 字符前缀 + 后缀）以释放空间。设为 `"200%"` 或更高可实际禁用。**摘要永远不会被截断。**

#### `gc.batchCleanup`

批量清理将多个老生代块合并为更高层级的块。

##### `gc.batchCleanup.lowThreshold`
- **类型：** `number | \`${number}%\``
- **默认值：** `"55%"`
- **状态：** ACTIVE
- **说明：** 低优先级批量清理的上下文使用率阈值。达到此级别时，批量清理开始考虑合并老生代块。

##### `gc.batchCleanup.highThreshold`
- **类型：** `number | \`${number}%\``
- **默认值：** `"75%"`
- **状态：** ACTIVE
- **说明：** 中优先级批量清理阈值。

##### `gc.batchCleanup.forceThreshold`
- **类型：** `number | \`${number}%\``
- **默认值：** `"90%"`
- **状态：** ACTIVE
- **说明：** 强制批量清理阈值。达到此级别时，批量清理激进地合并所有符合条件的块。

---

### `qualityGate`

压缩后质量评估。在每次压缩后运行，验证摘要质量。

#### `qualityGate.enabled`
- **类型：** `boolean`
- **默认值：** `false`
- **状态：** ACTIVE
- **说明：** 启用压缩后质量评估。设为 `true` 时，ACP 根据质量指标评估每个压缩摘要。失败仅记录日志，不阻止压缩（非阻塞）。

#### `qualityGate.algorithm`
- **类型：** `string`
- **默认值：** `"rouge-recall-v1"`
- **状态：** ACTIVE
- **说明：** 使用的质量门控算法。目前仅支持 `"rouge-recall-v1"`。

#### `qualityGate.algorithms`
- **类型：** `object`
- **状态：** ACTIVE
- **说明：** 算法特定参数。见下文。

##### `qualityGate.algorithms.rouge-recall-v1`

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `layer1MinChars` | number | 200 | 摘要的最小长度（字符） |
| `layer1MinRetentionPct` | number | 5.0 | 最小内容保留百分比 |
| `layer2MaxRougeF1` | number | 0.05 | ROUGE-1 F1 分数"过于相似"检测的最大值 |
| `layer2MaxTop20Recall` | number | 0.20 | 质量检查的最大 top-20 关键词召回率 |

---

## 常用配置模板

### 激进压缩（最大化上下文节省）
```jsonc
{
    "compress": {
        "maxContextLimit": "45%",
        "minContextLimit": "35%",
        "preserveRecentMessages": 3,
        "preserveRecentTokens": 2000,
        "nudgeFrequency": 3
    }
}
```

### 保守压缩（最小化信息丢失）
```jsonc
{
    "compress": {
        "maxContextLimit": "70%",
        "minContextLimit": "60%",
        "preserveRecentMessages": 15,
        "preserveRecentTokens": 10000,
        "nudgeFrequency": 8,
        "protectedTools": ["skill", "bash", "read", "grep", "glob"]
    }
}
```

### 完全禁用自动压缩
```jsonc
{
}
```

### 按模型设置上下文限制
```jsonc
{
    "compress": {
        "modelMaxLimits": {
            "gpt-4o": 80000,
            "claude-3.5-sonnet": "60%",
            "gemini-1.5-pro": 150000
        },
        "modelMinLimits": {
            "gpt-4o": 60000,
            "claude-3.5-sonnet": "50%"
        }
    }
}
```

### 保护敏感文件
```jsonc
{
    "protectedFilePatterns": [
        "**/*.env",
        "**/*.pem",
        "**/*.key",
        "**/credentials.json",
        "**/secrets.*"
    ]
}
```

---

## 已移除的参数

以下参数存在于旧版本中，现已移除。包含这些参数的配置文件会显示警告提示，但仍可正常工作。

| 参数 | 移除版本 | 替代方案 |
|------|---------|---------|
| `strategies.deduplication.*` | PR #206 | 压缩工具自动处理重复 |
| `strategies.purgeErrors.*` | PR #206 | 压缩工具自动处理错误清理 |
| `compress.automaticStrategies` | PR #206 | 始终开启；无需配置 |
| `state.prune.tools` | PR #206 | 仅内部使用；无需配置 |

---

## 配置验证

ACP 在加载时验证配置。未知键和类型不匹配会触发警告提示。有效键定义在 `lib/config-validation.ts`（`VALID_CONFIG_KEYS` 集合）中。
