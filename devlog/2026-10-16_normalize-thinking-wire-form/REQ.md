# REQ — compress.reasoning.normalize：请求时归一化历史思考的 wire 形态

- **日期**: 2026-10-16
- **分支**: `2026-10-16_normalize-thinking-wire-form`
- **Issue**: #482（来源：billion-context#3301 分析「元数据刷新后 fold re-anchor 失配」时发现）
- **状态**: 实现完成，待双 agent review

## 1. 问题（#482）

同一会话、同一模型，宿主读取的模型元数据表刷新一次后，带思考的历史 assistant 消息在
wire 上换了序列化形态（思考从独立字段并入正文），按内容哈希计算的消息 id 全部失效。
下游 billion-context 的压缩账本认不回已折叠内容：原文重新上线 → 上下文膨胀 → 再压一遍；
长会话反复发生（实测旗舰会话 986 条失配 ≈ 2×带思考消息数）。

根因：宿主按【当前】元数据表决定思考放哪个字段（v1 `capabilities.interleaved`），这个
选择不随消息存储，每次请求现算 —— 所以同一份历史消息在两次请求间可能字节不同。

## 2. 设计

在 transform 管线加一步归一化（紧随 #368 的 `dropCompressReasoning` 之后）：对每个
assistant 消息，把全部 `reasoning` part 合并进一个固定标记形态的 `text` part：

```
<thinking>
{全部 R 用 "" 拼接}
</thinking>
{全部 T 用 "" 拼接}     （仅当存在 text part；R-only 不留尾部换行）
```

**配置**（复用 #368 嵌套对象，新增字段级 `normalize`）：

```jsonc
{
  "compress": {
    "reasoning": { "drop": true, "threshold": 2048, "normalize": true },
    "providers": {
      "anthropic-native": { "reasoning": { "normalize": false } }  // 直连需结构化回放
    }
  }
}
```

- `normalize` 默认启用（consumer gate `reasoningConfig?.normalize !== false`）；显式 `false` 关闭。
- 解析顺序同 #368：model > provider > global，字段级；含 `normalize`。
- 三级配置文件（global/configDir/project）字段级合并。

**为什么 join 用空字符串**：宿主 v1.14.46 `lowerAssistantMessage` 里 text 与 reasoning
都用 `.join("")`（空串，非 `\n`）。ACP 内部也用 `""` 拼接 R/T，使归一化后的 `<thinking>`
块与宿主拆分形态逐字节一致 → kernel minting 前还原为拆分形态后哈希相同 → 存量账本零别名
精确对齐。

**为什么默认开、不加活跃轮豁免**：目标是 wire 形态对元数据表 / 版本 / provider 配置字节
确定。若豁免活跃轮，活跃轮→已关闭轮过渡时会发生一次性哈希翻转，破坏稳定性。故对所有
assistant 消息统一归一化。

## 3. 不变量

- 只改请求数组，不写任何持久化状态（无状态、确定性变换）；
- tool/file/image/step 等非 reasoning/text part 原位保留；
- 幂等：归一化后不再携带 reasoning part，第二次运行零改动（前缀缓存稳定——形态只变一次）；
- 无 reasoning part 的消息 / 非 assistant 消息不动；
- 内部命名规约（§2.6）：不涉及 dcp 标签改动。

## 4. 已知边界（本次不自动处理，留 kill-switch）

直连需要结构化 thinking 回放语义的 provider（Anthropic 原生 thinking block / Gemini
`thoughtSignature`）会失去结构化字段——此类 lane 设 `compress.reasoning.normalize: false`
即可恢复旧行为。openai-compat/litellm lane（reasoning 多被中转丢弃）实际影响小。

## 5. 验收标准

- [x] 纯函数 `normalizeThinkingForm(messages)`：R+T 合并精确字节 / R-only 无尾换行 / 多 part
      用 "" 拼接 / 幂等 / 无 reasoning 不动 / 非 assistant 忽略 / tool part 原位保留 / 计数
- [x] config cascade：resolve/apply 字段级合并 normalize / model 胜 provider / 未设时 resolved
      对象不新增 key（byte-stable）
- [x] config-validation：合法 boolean 接受、非 boolean 拒绝（顶层 + providers override）
- [x] schema 三处 += `normalize`
- [x] hook 级 e2e：默认折叠为 `<thinking>` text / `normalize:false` 保留独立 reasoning
- [x] 文档四份（CONFIGURATION 中英 + README 中英）

## 6. 风险与回滚

- **行为变更（old → new）**：默认开启 wire 形态归一化——上游模型看到的历史思考从独立
  reasoning 字段变为正文里的 `<thinking>` 带标记文本（见 §4 边界与 kill-switch）。
- 回滚：`compress.reasoning.normalize: false`（立即 no-op）或 revert 分支。
- 兼容：纯新增可选键；未配置时 resolved reasoning 对象字节不变（条件式转发，见 WORKLOG §1）；
  无持久化状态 / 内部标签改动。
