[English](./README.md) | [中文](./README.zh-CN.md)

<p align="center">
<strong>Active Context Pruning</strong> — <a href="https://opencode.ai">OpenCode</a> 的主动上下文剪枝插件
<br />
由模型决定<em>何时</em>压缩、压缩<em>什么</em> — 而非硬性截断。
</p>

---

<p align="center">
<a href="https://www.npmjs.com/package/opencode-acp"><img src="https://img.shields.io/npm/v/opencode-acp.svg?style=flat-square" alt="npm"></a>
<a href="https://github.com/ranxianglei/opencode-acp/blob/master/LICENSE"><img src="https://img.shields.io/npm/l/opencode-acp.svg?style=flat-square" alt="license"></a>
<a href="https://github.com/ranxianglei/opencode-acp"><img src="https://img.shields.io/badge/GitHub-ranxianglei%2Fopencode--acp-181717?style=flat-square&logo=github" alt="GitHub"></a>
</p>

<p align="center">
<code>opencode plugin opencode-acp@latest --global</code>
</p>

---

## 为什么选择 ACP

ACP 是 [DCP](https://github.com/Tarquinen/opencode-dynamic-context-pruning) 的强化分支，已应用 **35 项错误修复**。它将上下文管理从一种被动、易崩溃的机制，转变为足以稳定运行于生产环境的方案。

| | DCP（原版） | ACP（本分支） |
|---|---|---|
| **最大稳定会话** | ~200 条消息 | 10,000+ 条消息 |
| **每轮开销** | 20 -- 50 秒 | ~90ms |
| **状态持久化** | 重启后丢失 | 重启后保留 |
| **GC 有效性** | 从不停用旧块 | 基于年龄的自动清理 |
| **Compress 可靠性** | 边界情况失败，模型放弃 | 自动恢复反转的边界 |

> **Active（主动）** 意味着模型主动决定*何时*压缩以及*压缩什么* — 与被动方式不同，被动方式仅在上下文触及硬性限制时才做出反应。模型使用 `compress` 工具对已完成的对话片段生成高保真摘要，在保留重要细节的同时释放上下文空间。这优于被动截断，因为模型可以自行控制保留哪些信息。

主要修复包括：跨重启状态持久化、token 用量报告（此前返回 0）、摘要消息 ID 解析、基于年龄的 GC 停用、268 倍的日志/tokenizer 加速、压缩边界反转的自动交换，以及低上下文使用率时的老化警告抑制。

---

## 安装

```bash
opencode plugin opencode-acp@latest --global
```

或者添加到你的 opencode 配置中：

```json
{
  "plugin": {
    "opencode-acp": "latest"
  }
}
```

---

## 工作原理

ACP 通过 `compress` 工具和自动清理来缩减上下文大小。你的会话历史永远不会被修改 — ACP 在向 LLM 发送请求之前，用占位符替换已剪枝的内容。

### Compress

Compress 是一个暴露给模型的工具，用高保真的技术摘要替换已关闭、过时的对话内容。你可以将其视为 OpenCode 内置压缩过程的更智能版本。与在会话达到最大上下文时静态触发并对整个编码会话进行压缩不同，Compress 允许模型根据任务完成情况选择何时激活，并且只压缩不再需要逐字保留的特定消息。

ACP 支持两种压缩模式：

- **`range` 模式**将连续的对话片段压缩为一个或多个摘要。
- **`message` 模式**（实验性）独立压缩单条原始消息，使模型能够更精细地管理上下文。

在 `range` 模式下，当新的压缩与较早的压缩重叠时，较早的摘要会嵌套在新的摘要中，使信息通过压缩层级得以保留而非被稀释。在两种模式下，受保护的工具输出（如子代理和技能）以及受保护的文件模式会在压缩摘要中保留，确保最重要的信息永远不会丢失。你还可以启用 `protectUserMessages` 以在压缩过程中逐字保留你的消息，但请注意，大型提示（例如在提示中复制粘贴日志文件）将永远不会被压缩掉。

### 去重

识别重复的工具调用（相同工具、相同参数），仅保留最近的输出。在 `compress` 工具运行时重新计算，因此提示缓存仅在压缩时受到影响。

### 清除错误

在可配置的轮次后（默认：4 轮）剪除出错工具调用的输入。错误消息被保留；仅移除可能很大的输入内容。在 `compress` 工具使用时重新计算。

---

## 命令

ACP 提供 `/acp` 斜杠命令（为向后兼容也接受 `/dcp`）：

| 命令 | 说明 |
|---------|------|
| `/acp` | 显示可用的 ACP 命令 |
| `/acp context` | 按类别（system、user、assistant、tools 等）显示 token 用量明细，以及通过剪枝节省的量 |
| `/acp stats` | 跨所有会话的累计剪枝统计 |
| `/acp sweep [n]` | 剪除自上次用户消息以来的所有工具。可选数量：`/acp sweep 10` 剪除最近 10 个工具。遵循 `commands.protectedTools` 设置 |
| `/acp manual [on\|off]` | 切换手动模式。开启后，AI 不会自动使用上下文管理工具 |
| `/acp compress [focus]` | 触发一次 `compress` 工具执行。可选的焦点文本指示要压缩的内容，遵循当前 `compress.mode` |
| `/acp decompress <n>` | 按 ID 恢复特定的活动压缩。不带参数运行时显示可用的压缩 ID、token 大小和主题 |
| `/acp recompress <n>` | 按 ID 重新应用用户解压的压缩。不带参数运行时显示可重新压缩的 ID、token 大小和主题 |

---

## 配置

ACP 使用自己的配置文件，按以下顺序搜索：

1. **全局：** `~/.config/opencode/acp.jsonc`（或 `acp.json`），首次运行时自动创建
2. **自定义配置目录：** `$OPENCODE_CONFIG_DIR/acp.jsonc`（或 `acp.json`），当设置了 `OPENCODE_CONFIG_DIR` 时
3. **项目级：** 项目 `.opencode` 目录下的 `.opencode/acp.jsonc`（或 `acp.json`）

如果未找到 `acp.jsonc`，ACP 会回退到 `dcp.jsonc` / `dcp.json`（用于与现有 DCP 安装向后兼容），并在首次写入时自动迁移。

每一层覆盖前一层，因此项目设置优先于全局设置。修改配置后请重启 OpenCode。

> [!IMPORTANT]
> **禁用 OpenCode 的内置自动压缩。** ACP 自行处理上下文管理 — OpenCode 的压缩与 ACP 冲突，可能导致问题（消息重新展开、压缩状态丢失）。请在 `opencode.json` 中添加：
>
> ```jsonc
> {
>   "compaction": {
>     "auto": false
>   }
> }
> ```
>
> 或设置环境变量：`OPENCODE_DISABLE_AUTOCOMPACT=1`

> [!NOTE]
> 如果你使用上下文窗口较小的模型（如 GitHub Copilot 模型或本地模型），请在配置中降低 `compress.minContextLimit` 和 `compress.maxContextLimit` 以匹配可用上下文。

<details>
<summary><strong>默认配置</strong>（点击展开）</summary>

```jsonc
{
    "$schema": "https://raw.githubusercontent.com/Opencode-DCP/opencode-dynamic-context-pruning/master/dcp.schema.json",
    // Enable or disable the plugin
    "enabled": true,
    // Automatically update npm-installed ACP when a newer npm latest is available.
    // Version-locked plugin specs are not updated.
    "autoUpdate": true,
    // Enable debug logging to ~/.config/opencode/logs/acp/
    "debug": false,
    // Notification display: "off", "minimal", or "detailed"
    "pruneNotification": "detailed",
    // Notification type: "chat" (in-conversation) or "toast" (system toast)
    "pruneNotificationType": "chat",
    // Slash commands configuration
    "commands": {
        "enabled": true,
        // Additional tools to protect from pruning via commands (e.g., /acp sweep)
        "protectedTools": [],
    },
    // Manual mode: disables autonomous context management,
    // tools only run when explicitly triggered via /acp commands
    "manualMode": {
        "enabled": false,
        // When true, automatic cleanup (deduplication, purgeErrors)
        // still runs even in manual mode
        "automaticStrategies": true,
    },
    // Protect from pruning for <turns> message turns past tool invocation
    "turnProtection": {
        "enabled": false,
        "turns": 4,
    },
    // Experimental settings
    "experimental": {
        // Allow ACP processing in subagent sessions
        "allowSubAgents": false,
        // Enable user-editable prompt overrides under dcp-prompts directories
        // When false (default), prompt override files/directories are ignored
        "customPrompts": false,
    },
    // Protect file operations from pruning via glob patterns
    // Patterns match tool parameters.filePath (e.g. read/write/edit)
    "protectedFilePatterns": [],
    // Unified context compression tool and behavior settings
    "compress": {
        // Compression mode: "range" (compress spans into block summaries)
        // or experimental "message" (compress individual raw messages)
        "mode": "range",
        // Permission mode: "allow" (no prompt), "ask" (prompt), "deny" (tool not registered)
        "permission": "allow",
        // Show compression content in a chat notification
        "showCompression": true,
        // Let active summary tokens extend the effective maxContextLimit
        "summaryBuffer": true,
        // Soft upper threshold: above this, ACP keeps injecting strong
        // compression nudges (based on nudgeFrequency), so compression is
        // much more likely. Accepts: number or "X%" of model context window.
        "maxContextLimit": "55%",
        // Soft lower threshold for reminder nudges: below this, turn/iteration
        // reminders are off (compression less likely). At/above this, reminders
        // are on. Accepts: number or "X%" of model context window.
        "minContextLimit": "45%",
        // Optional per-model override for maxContextLimit by providerID/modelID.
        // If present, this wins over the global maxContextLimit.
        // Accepts: number or "X%".
        // Example:
        // "modelMaxLimits": {
        //     "openai/gpt-5.3-codex": 120000,
        //     "anthropic/claude-sonnet-4.6": "80%"
        // },
        // Optional per-model override for minContextLimit.
        // If present, this wins over the global minContextLimit.
        // "modelMinLimits": {
        //     "openai/gpt-5.3-codex": 50000,
        //     "anthropic/claude-sonnet-4.6": "25%"
        // },
        // How often the context-limit nudge fires (1 = every fetch, 5 = every 5th)
        "nudgeFrequency": 5,
        // Start adding compression reminders after this many
        // messages have happened since the last user message
        "iterationNudgeThreshold": 15,
        // Controls how likely compression is after user messages
        // ("strong" = more likely, "soft" = less likely)
        "nudgeForce": "soft",
        // Tool names whose completed outputs are appended to the compression
        "protectedTools": [],
        // Preserve text wrapped in <protect>...</protect> when compressed
        "protectTags": false,
        // Preserve your messages during compression.
        // Warning: large copy-pasted prompts will never be compressed away
        "protectUserMessages": false,
    },
    // Automatic pruning strategies
    "strategies": {
        // Remove duplicate tool calls (same tool with same arguments)
        "deduplication": {
            "enabled": true,
            // Additional tools to protect from pruning
            "protectedTools": [],
        },
        // Prune tool inputs for errored tools after X turns
        "purgeErrors": {
            "enabled": true,
            // Number of turns before errored tool inputs are pruned
            "turns": 4,
            // Additional tools to protect from pruning
            "protectedTools": [],
        },
    },
}
```

</details>

### Prompt 覆盖

ACP 暴露六个可编辑的 prompt：

- `system`
- `compress-range`
- `compress-message`
- `context-limit-nudge`
- `turn-nudge`
- `iteration-nudge`

此功能默认禁用。在 ACP 配置中将 `experimental.customPrompts` 设为 `true` 以激活。

启用后，托管的默认值会作为纯文本 prompt 文件写入 `~/.config/opencode/acp-prompts/defaults/`。该目录中的 `README.md` 解释了每个 prompt 以及如何创建覆盖。

要自定义行为，在覆盖目录下添加同名文件并作为纯文本编辑。

要重置覆盖，从覆盖目录中删除对应文件。

### 受保护工具

默认情况下，以下工具始终受保护不被剪枝：
`task`、`skill`、`todowrite`、`todoread`、`compress`、`batch`、`plan_enter`、`plan_exit`、`write`、`edit`

`commands` 和 `strategies` 中的 `protectedTools` 数组会添加到此默认列表。

对于 `compress` 工具，`compress.protectedTools` 确保特定工具的输出会被附加到压缩摘要中。默认包含 `task`、`skill`、`todowrite` 和 `todoread`。

---

## 对 Prompt 缓存的影响

LLM 提供商基于精确前缀匹配来缓存 prompt。当 ACP 剪枝内容时，它会修改消息，从而从该点开始使缓存的前缀失效。

**权衡：** 你会损失一些缓存读取，但从缩减的上下文大小中获得 token 节省，并减少因过时上下文产生的幻觉。在大多数情况下，尤其是长会话中，节省的开销超过缓存未命中的代价。

> [!NOTE]
> 在测试中，使用 ACP 的缓存命中率约为 85%，不使用时约为 90%。

**以下场景无影响：**

- **按请求计费** — 如 GitHub Copilot 等按请求而非按 token 计费的提供商。
- **统一 token 定价** — 如 Cerebras 等对缓存和未缓存 token 统一价格的提供商。

---

## 从 DCP 迁移

ACP 是 DCP 的直接替代品。迁移步骤：

1. 从 `opencode.json` 中移除旧的 DCP 插件
2. 安装 ACP：`opencode plugin install opencode-acp@latest --global`
3. 重启 OpenCode

**保留的内容：**

- 会话状态（压缩块、消息 ID 映射） — 自动从 `plugin/dcp/` 迁移到 `~/.local/share/opencode/storage/plugin/acp/`
- 配置文件 `~/.config/opencode/dcp.jsonc` — ACP 自动迁移到 `acp.jsonc`
- `~/.config/opencode/dcp-prompts/` 中的 prompt 覆盖 — 自动迁移到 `acp-prompts/`

**变更的内容：**

- 存储目录：`plugin/dcp/` → `plugin/acp/`（首次启动时自动迁移）
- 日志目录：`logs/dcp/` → `logs/acp/`
- 斜杠命令：`/dcp` → `/acp`（两者均可用于向后兼容）
- 通知标题：`DCP` → `ACP`
- 上下文用量标签：`DCP threshold` → `ACP threshold`

ACP 在首次启动时自动将配置从 `dcp.jsonc` 迁移到 `acp.jsonc`，将 prompt 从 `dcp-prompts/` 迁移到 `acp-prompts/`。

---

<details>
<summary><strong>错误修复（共 35 项）</strong> — 基于 DCP v3.1.11</summary>

| # | 严重程度 | 摘要 |
|---|----------|------|
| 1 | 严重 | 状态在重启后未持久化 — messageIds、块停用、保存错误均静默丢失 |
| 2 | 严重 | resetOnCompaction() 清除所有压缩块 — 撤销所有剪枝工作 |
| 3 | 严重 | prune 静默丢弃摘要 — 当锚点前无用户消息时导致数据丢失 |
| 4 | 严重 | getCurrentTokenUsage 返回 0 — 导致 nudge 永远无法触发 |
| 5 | 高 | loadPruneMessagesState 重复 activeBlockIds + reasoning-strip 未定义保护缺失 |
| 6 | 高 | 合成摘要消息获得 mNNNN 引用但对边界查找不可见 |
| 7 | 高 | 状态在重启后未持久化 — messageIds、块停用和保存错误均静默丢失 |
| 8 | 高 | isMessageCompacted() 与压缩摘要消息处理不一致 |
| 9 | 高 | 已压缩的块摘要保留过时的 mNNNN 消息 ID 标签 — 模型复制过时 ID |
| 10 | 高 | 模型使用 nudge/摘要中的过时 mNNNN ID — compress 因 "startId not available" 失败 |
| 11 | 高 | 主 GC 跳过没有 generation 字段的旧块 — 过大的块永远不会被回收 |
| 12 | 高 | 基于百分比的阈值基于有效输入上下文而非完整模型上下文窗口计算 |
| 13 | 高 | 上下文窗口泄漏 — 压缩后的消息在 /compact 后重新出现 |
| 14 | 高 | 压缩通知将完整块摘要写入数据库 — 每条通知可达 150KB+ |
| 15 | 高 | npm 自动安装用上游包覆盖分支 |
| 16 | 高 | compress 输出中的摘要 mNNNN 引用 — 模型复制过时的消息 ID |
| 17 | 高 | 合成消息不在 messageIdToBlockId 中 — compress 无法找到它们 |
| 18 | 高 | compress 在压缩完成后阻止模型响应 |
| 19 | 高 | 动态块引导破坏 API 前缀缓存 |
| 20 | 高 | GC 从不停用旧块 — 死重无限累积 |
| 21 | 高 | Logger + tokenizer 每轮延迟 20-50 秒（268 倍减速） |
| 22 | 高 | compress 在块边界反转时抛出硬错误 — 模型放弃 |
| 23--34 | 中 | 去重、错误清除、schema 验证、hook 时序等方面的多项修复 |
| 35 | 高 | 在低上下文使用率（<50%）时显示老化警告 — 触发不必要的 compress，浪费 token |

完整列表及根因分析，请参见 [Bug Tracker](https://github.com/ranxianglei/opencode-acp/issues)。

</details>

---

## 许可证

AGPL-3.0-or-later — 本项目是 [@tarquinen/opencode-dcp](https://github.com/Tarquinen/opencode-dynamic-context-pruning) 的分支。原始版权归原始作者所有。修改和错误修复由 ranxianglei 完成。
