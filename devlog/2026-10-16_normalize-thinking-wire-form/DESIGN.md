# DESIGN — compress.reasoning.normalize：请求时归一化历史思考的 wire 形态

- **日期**: 2026-10-16
- **分支**: `2026-10-16_normalize-thinking-wire-form`
- **Issue**: #482
- **状态**: Accepted（随实现定稿）

## 1. 问题陈述

- **要解决什么**：历史 assistant 消息的思考在 wire 上的序列化形态随宿主模型元数据表刷新而
  漂移，导致按内容哈希计算的消息 id 失效、下游压缩账本失配。
- **为什么现在**：billion-context#3301 实测旗舰会话 986 条失配 ≈ 2×带思考消息数；账本侧
  确定性恢复（#3316）已就位，缺的就是「把 wire 形态钉死」这一步。ACP 的 `messages.transform`
  是交给宿主序列化之前最后一个可控边界，是钉死形态的正确位置。

## 2. 目标 / 非目标

- **目标**：让带思考的历史 assistant 消息在 wire 上字节确定（对元数据表 / 版本 / provider
  配置不变），且与 kernel 拆分形态 mint 出相同 id（存量账本零别名对齐）。
- **非目标**：不写持久化状态；不自动识别/旁路需要结构化 thinking 回放的直连 provider（留
  kill-switch）；不改 dcp 内部标签。

## 3. 现状架构

- transform 管线（`lib/hooks.ts` `createChatMessageTransformHandler`）顺序执行若干 pass；
  #368 已在其中加了 `dropCompressReasoning`（请求时移除超大 reasoning）。
- **痛点**：reasoning 放哪个字段由宿主每次请求按当前元数据表现算，插件侧无法控制 → 同一段
  历史两次请求字节不同。

## 4. 提议架构

- **概览**：在 #368 drop 之后插入一个纯函数 pass `normalizeThinkingForm`，把所有 reasoning
  part 折叠进单个 `<thinking>` 标记 text part。折叠后消息不再携带 reasoning part → 宿主没有
  可 interleaved 的东西 → wire 字节稳定。
- **关键组件**：`normalizeThinkingForm(messages): number`（`lib/messages/reasoning-strip.ts`，
  就地改写、返回计数，与 `dropCompressReasoning` 同风格）。
- **数据流**：`output.messages` 经 drop → normalize → filters → prune → nudge → injectIds。
  normalize 只读 config 的 cascade 结果（复用 drop 那步解析出的 `reasoningConfig`）。
- **接口变更**：`CompressReasoningConfig` += 可选 `normalize?: boolean`；schema/validation/docs
  同步。无导出 API 破坏性变更。

## 5. 设计决策与理由

| 决策 | 备选 | 选定 | 理由 |
| --- | --- | --- | --- |
| join 分隔符 | `\n` / 空串 | **空串 `""`** | 宿主 `lowerAssistantMessage` 用 `.join("")`；空串拼接使 `<thinking>` 块与拆分形态逐字节一致，kernel 还原后哈希相同 |
| 默认值 | 默认关 / 默认开 | **默认开（kill-switch）** | 直接交付修复；结构化回放 lane 用 `normalize:false` 逃生 |
| 活跃轮豁免 | 豁免 / 不豁免 | **不豁免** | 豁免会在活跃→关闭过渡触发一次性哈希翻转，破坏稳定性；目标是全量字节确定 |
| 放置位置 | 独立新模块 / 并入 reasoning-strip | **并入 reasoning-strip** | 与 drop 同属「请求时 reasoning 处理」域，共享 WithParts 工具；不加新模块边界 |
| 未配置时的合并行为 | 始终注入默认 key / 条件式转发 | **条件式转发** | 保持未配置时 resolved reasoning 对象字节不变，既有 deepEqual 测试零回归 |

## 6. 影响分析

- **向后兼容**：纯新增可选键；wire 形态默认变化（见 REQ §6），kill-switch 可回退。
- **性能**：每请求 O(消息数 × parts)，仅对带 reasoning 的 assistant 消息做字符串拼接，开销可忽略。
- **安全**：不涉及凭证 / 网络 / 系统修改。
- **依赖**：无新增包。

## 7. 迁移计划

- 无需迁移：无持久化状态 / 标签改动。
- Feature flag：`compress.reasoning.normalize`（默认开；`false` 立即 no-op）。

## 8. 开放问题

- [ ] 是否需要为「需结构化 thinking 回放的直连 provider」加自动检测并默认关闭 normalize？
      本次留 kill-switch 手动配置，后续可评估自动化。
