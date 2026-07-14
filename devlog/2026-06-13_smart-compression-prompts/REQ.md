# REQ: Smart Compression Prompts

## Background

ACP 默认配置的 45%/55% 阈值只控制 nudge 何时触发，但系统提示词和 context usage 注入文本在无条件鼓励压缩。具体问题：

1. **Context usage 文本**：每轮注入 "use the compress tool proactively to manage context quality"——不管上下文是 10% 还是 55%，导致模型在低使用率时也频繁压缩
2. **系统提示词**："Evaluate conversation signal-to-noise REGULARLY" 过度鼓励压缩，没有上下文充裕度感知
3. **缺少压缩优先级指导**：模型不知道什么该先压缩、什么该谨慎压缩
4. **缺少恢复线索指导**：压缩后不生成可恢复的线索

## Acceptance Criteria

1. Context usage 注入文本根据使用率分层（充裕/适中/紧张），充裕时提示"少压缩或基本不压缩"
2. 系统提示词包含压缩优先级指导：
    - 优先压缩：bash 大量输出、无用日志、冗余工具结果、探索死胡同
    - 谨慎压缩：临时密钥、文件路径、关键方法签名、用户偏好、错误信息
3. 系统提示词要求压缩重要内容前确认已在外部存储（文件、issue、devlog 等）
4. 系统提示词要求压缩后生成恢复线索（如自言自语式总结）

## Proposed Approach

- 修改 `lib/prompts/system.ts`：重写压缩哲学
- 修改 `lib/messages/inject/inject.ts` + `lib/messages/inject/utils.ts`：分层 context usage 文本
- 纯提示词变更，无逻辑/类型变化
