# 更新日志

### v1.14.26 — 任意 compress 字段支持按 provider/按模型覆盖；增长型提醒遵循 minNudgeContextPercent 下限

**问题**：T1 增长型提醒在远低于配置的上下文下限时就触发 —— `minNudgeContextPercent` 下限被传入触发策略但被忽略，导致增长型提醒在任何上下文大小下都会触发（issue #342：400K 模型上配置了 150K 下限，却在 67K–152K 触发了 10 次 `trigger=growth` 提醒）。

**修复**（#343）：
- 增长型提醒现在要求 `currentTokens >= minNudgeContextPercent% × 模型上下文窗口`（默认 **5%**；设为 `0` 表示禁用）。超 max（`maxContextLimit`）和 98% 紧急提醒绕过下限；T2/T3 层级提升提醒不受影响。
- 模型上下文窗口未知时，下限不可解析，保持修复前的纯增长行为。
- 文档：修正 README/CONFIGURATION 中过期的 `minContextLimit`/`maxContextLimit` 默认值（45%/55% → 80%/80%），并澄清 `minContextLimit` 管 turn/iteration 提醒、`minNudgeContextPercent` 管增长型提醒下限。

**新功能**（#351）：
- 新增嵌套 `compress.providers` 映射：任意 `compress` 字段都可按 provider 和按模型覆盖（23 项 —— 阈值、提醒行为、保护、保留策略等）。逐字段解析优先级：model > provider > 全局；未知的 provider/model ID 回退到全局值。
- 嵌套 `maxContextLimit` 优先于旧版扁平 `modelMaxLimits` 映射（嵌套 > 扁平 > 全局）。覆盖在三层配置文件间按 provider/model 键深合并。
- 严格校验（未知字段和错误类型均拒绝）+ JSON schema；README（中英）与 CONFIGURATION（中英）均已补充文档与配方。

**安装**：`opencode plugin opencode-acp@latest --global`

### v1.14.25 — 在 billion-context 代理下自动禁用

**问题**：运行 `bili opencode`（billion-context 启动器）的用户会同时加载两套 ACP：代理在 wire 层注入 compress / decompress / search_context / acp_status 并提供自己的 `/acp` 面板，而 opencode-acp 又注册了同名工具和竞争性的 `/acp` 命令 —— 工具重复注册，且客户端面板遮蔽了代理的真实压缩状态。

**修复**（#335）：
- 插件启动时检查 `process.env.BILLION_CONTEXT_PROXY`（`bili` 启动器必设），命中则打印一行日志并返回空插件对象 —— 不注册任何工具、命令或转换。
- 未设置该环境变量时行为零变化；独立安装完全不受影响。

**安装**：`opencode plugin opencode-acp@latest --global`

