# 更新日志

### v1.18.0 — 自适应压缩候选（opt-in）：MICRO/EPISODE 目标，执行同构校验

**PR #341 + 后续修复。** 在既有范围 nudge 之上加了一层候选规划 —— 默认关闭，未开启时与 v1.17.1 行为逐字节一致。

**开启后**（`{"compress": {"candidates": true}}`）：
- nudge 与 `acp_status` 展示预先校验、可批量提交的压缩目标，而非原始范围：**MICRO** = 单条大消息或完整工具事务（call+result 闭包）；**EPISODE** = 相邻小单元构成的历史片段（≥ `minCompressRange`）。
- 执行同构：候选通过与 `compress` 工具相同的 `prepareExecutableRangePlans` 路径校验 —— 列表中的目标均可直接提交（工具对闭合、保护同等、Bug 39 语义保留）。规划 fail-closed，开销限制在可见上下文内（v1.17.1 #385 保证 ~1.2 ms）。
- 解决过度压缩问题：模型面对 "compress m00150–m00220" 时不再为了省一个大工具输出而整段压掉。

**默认 OFF = 精确还原 v1.17.1**：基础 nudge 模板、breakdown 文案、`acp_status` 概览、debug 日志均恢复原文；候选规划不执行（零开销）。合并后评审确认：`compress.candidates` 不可按模型覆盖（仅全局/项目层）—— 类型、校验白名单、文档三处已对齐。一个有意保留的 PR 分支变更：transform 管道重排（工具输出截断与预算守卫移到 nudge 注入之后）在两种模式下均生效；e2e 场景 01–12 全部在 OFF 模式下通过。

**同版本包含**：system prompt 与 compress-range prompt 的候选指导同样受开关门控（a1a2f23）；e2e 场景 13 显式开启；新增 12 个测试（含 §5.7 四轮 growth-cycle、生产配置 `preserveRecentMessages: 20`、#207 baseline 保留断言）。全量 1263/1263。

**安装**：`opencode plugin opencode-acp@latest --global`

### v1.17.1 — transform 开销不再随压缩历史增长（13.6 s → 1.2 ms）+ 配置/CI 修复

捆绑三项修复 —— 主打 #385，消除 #384 报告的长会话卡顿：

**1. transform 成本收敛到可见上下文 + 活跃块**（#385，修复 #384）：
每次 transform 的工作量随**总压缩历史**而非可见上下文增长。候选规划在 1000 条消息下实测 **13.6 s**，修复后 **~1.2 ms**（验收目标 ≤20 ms，余量 ~17×；同基准前后对比，`scripts/bench-candidate-planning.ts`）。
- **RC1** `resolveBoundaryIds()` 每个候选草稿都重建全局边界索引 → 请求级 `SearchContext.boundaryLookup` 记忆化，每次 compress 调用只建一次。
- **RC1b** `resolveSelection()` 每条消息跑真实 Anthropic BPE 分词器（实测 ~27 ms/KB）→ 新 `estimateAllMessageTokensFast()`（字符/4，既有估算惯例）；对正确性有要求的位置保留精确 BPE。
- **RC2** T1 nudge 分析（上下文构成 / 保护引用 / 可压缩范围）在无 nudge 可触发时也每次全量计算 → 改为 `nudgeAllowed || emergencyOverride || tierTriggerPossible` 时才计算，所有消费方空值守卫。
- **RC3** `syncCompressionBlocks()` 每次重放全部块（含失活），`hideConsumedCompressCalls()` 每次重建不变索引 → 瞬态 `structureVersion` 在三处块变更点递增；结构未变时 sync 跳过全量重放；hide-consumed 按版本缓存派生索引。
- **RC4** 发后即忘的状态保存可能竞态（旧快照覆盖新）→ 有序合并的每会话保存队列（入队时快照、`setImmediate` 排空、批内只写最新、FIFO、失败隔离）。
- 持久化格式**不变** —— 新字段全部瞬态；候选执行校验、Bug 39 保护语义、decompression、fork 恢复未动。新增 20 个测试（sync 等价性、缓存失效、记忆化、保存合并、§5.7 多轮增长周期）。

**2. `qualityGate.algorithms` 误报 "Unknown keys"**（#389，修复 #329）：按算法名配置参数（`qualityGate.algorithms.rouge-recall-v1.*`）是合法的动态键映射，但键白名单递归进了它 —— 每次启动都对合法配置告警。已加入递归跳过列表（与 `compress.providers` / `messageFilters.filters` 同惯例）。注意：`rouge-recall-v1` 的真实参数名是 `layer1MinChars`、`layer1MinRetentionPct`、`layer2MaxRougeF1`、`layer2MaxTop20Recall` —— 未知内层键会被静默忽略，请检查参数是否真正生效。

**3. fork PR 构建恢复绿色**（#390，修复 #366）：`build-artifact` 对每个 PR 都跑 `npm publish`，但 fork PR 拿不到 `NPM_TOKEN` → ENEEDAUTH 干掉整个任务。发布步骤现在仅限同仓库头分支；fork PR 仍会构建、打包、上传构件，安装指引评论也不再对 fork 宣传不存在的 npm 标签和主仓库引用。仅 CI 改动，无运行时代码。

文件：`lib/compress/search.ts`、`lib/messages/sync.ts`、`lib/messages/utils.ts`、`lib/token-utils.ts`、`lib/state/persistence.ts`、`lib/state/types.ts`、`lib/config-validation.ts`、`scripts/bench-candidate-planning.ts`（新增）、`.github/workflows/pr-artifact.yml`。发布分支全量 1209/1209；typecheck + build 干净。

### v1.17.0 — 上下文窗口安全网 + 预算守卫：终结静默 400 死循环

捆绑六项修复，其中两项是针对“窗口未知/超出窗口”会话的新保护子系统：

**1. spawn+resume 模式的上下文窗口安全网**（#349，修复 #346 —— 高危）：
headless spawn+resume 模式下，模型目录的初始化种子与服务器就绪竞态，永久空置；`state.modelContextLimit` 每条消息学到即丢，所有百分比阈值（nudge、紧急覆盖、GC、截断）全部失效，会话无限增长直到后端拒绝。
- system hook 现在把学到的窗口（及其模型身份）持久化到会话状态，新进程启动即已知晓。
- `hydrateAndResolve()`：请求内目录未命中时（此时服务器必然已就绪）每进程重试一次 hydrate；并发调用等待同一 promise。
- 新 `resolveEffectiveContextLimit()` —— 已知模型窗口，否则新的 `compress.contextLimitFallback`（默认 128000，`0` 禁用）—— 统一驱动 nudge 阈值、紧急覆盖、GC 批量清理、工具输出截断。
- 内部 agent（标题/摘要/compaction）跑在不同模型上时不再覆盖会话窗口。
- GC 截断阈值减去 `OUTPUT_RESERVE_TOKENS`（16384）—— 服务端真正的墙是窗口减系统提示减 max_tokens，不是完整窗口。
- 变换后硬守卫：出站请求仍超真实预算时打 ERROR 日志（opencode 静默 exit-0 拒绝前唯一的信号）。

**2. 上下文预算守卫**（#350，修复 #347 —— 高危）：
未声明窗口的模型（`limit.context = 0`，自定义 OpenAI 兼容供应商常见）请求增长超过后端真实窗口 → HTTP 400 → opencode 吞掉报错、空响应 exit-0 —— 会话永久卡死且无错误可见。
- 新 `enforceContextBudget`（messages.transform 内）：估算线包超过 `modelContextLimit − compress.completionReserveTokens`（默认 32768，覆盖 opencode 对未声明 limit.output 的 32000 max_tokens 回退）时，确定性“先截断后清空”最老的可压缩工具输出。保护首条用户消息、最近 3 条、保护工具、compress 摘要（Bug 39 同等保护）；与 GC 截断标记幂等。
- 只强制模型上报的窗口 —— 绝对值 `compress.maxContextLimit` 保持软 nudge 阈值语义（剪到猜测的阈值会饿死 nudge 的可压缩目标；开发中曾触发 `e2e-blocks-nudges` 回归）。
- 模型未报窗口时每会话一次性 WARN，给出可操作的配置指引。
- 竞争方案（#348，绝对配置回退链 + 只清空）已关闭，采纳本方案。

**3. nudge/执行侧字符计数统一**（#360，修复 #359）：压缩推荐侧用 `JSON.stringify(part).length / 4` 计数工具 part，而执行侧下限检查用 `countMessageCharacters` —— 推荐可能指向执行侧判定低于下限的范围。两侧统一为 `countMessageCharacters(msg) / 4`。

**4. 分层感知的节奏重置**（#365，修复 #364）：每次 T1 捕获都重置 T2/T3 nudge 基线，重新武装 growthFloor 等待 —— 压缩活跃会话中 T2 蒸馏永远不触发。新 `isCaptureOnlyCompress()`：只有块引用边界（真正的蒸馏/凝结）重置分层基线；纯消息捕获（全部 `mNNNNN`）不重置。无边界/畸形输入保守地保持重置（保留 #235 防循环）。

**5. 上下文估算计入 reasoning token**（#374，修复 #371）：`/acp status` 总览与下钻、nudge 的 CONTEXT BREAKDOWN 此前完全遗漏 `reasoning` part；现作为独立类别追踪，计入总量与大小排序。

**6. `/acp` 命令错误日志泄漏**（#297，修复 #296）：命令处理器的 `throw new Error("__DCP_CONTEXT_HANDLED__")` 哨兵每次 `/acp` 调用都泄漏到 opencode 错误日志；改为普通 `return`（命令本就通过 `sendIgnoredMessage` 交付输出）。

文件：`lib/state/state.ts`、`lib/state/utils.ts`、`lib/hooks.ts`、`lib/config.ts`、`lib/config-validation.ts`、`lib/messages/inject/utils.ts`、`lib/messages/truncate-tools.ts`、`lib/messages/enforce-budget.ts`（新增）、`lib/messages/query.ts`、`lib/messages/inject/inject.ts`、`lib/compress/status.ts`、`dcp.schema.json`、CONFIGURATION（中英）。测试：`tests/context-limit-fallback.test.ts`、`tests/model-switch-limits.test.ts`、`tests/truncate-tools.test.ts`、`tests/enforce-budget.test.ts`（新增）、`tests/recommend-exec-counter-alignment.test.ts`（新增）、`tests/inject.test.ts`、`tests/query-pure.test.ts`、`tests/acp-status.test.ts`、`tests/hooks-permission.test.ts`。全量 1207/1207；六个 PR 合并前均在本机重新验证（typecheck + 测试 + 构建）。

### v1.16.0 — storagePath：自定义会话状态文件存储位置

**问题**：ACP 的每会话状态文件（`{sessionId}.json` —— 压缩块、nudge 状态、token 统计）此前固定写入硬编码路径 `$XDG_DATA_HOME/opencode/storage/plugin/acp`。容器、NFS 家目录或 XDG data 目录空间紧张的用户无法迁移（issue #379）。

**新功能**（#380，closes #379）：
- 新增顶层可选配置 `storagePath`（字符串），用于自定义会话状态目录：

| 取值 | 解析方式 |
|---|---|
| 未设置 / 空 | 默认 `$XDG_DATA_HOME/opencode/storage/plugin/acp`（不变） |
| `/abs/path` | 原样使用 |
| `~` / `~/x` | 展开到用户主目录 |
| `rel/path` | 相对项目目录（opencode 工作目录）解析 |

```jsonc
// acp.jsonc —— 全局 / 配置目录 / 项目三层均支持
{ "storagePath": "~/data/acp-state" }
```

- 解析结果在会话初始化时计算一次，挂在瞬态字段 `SessionState.storageDir` 上，**不会**写入持久化 JSON。
- **不自动迁移**：设置了 `storagePath` 但该位置找不到有效状态、而默认位置存在状态文件时，每会话打一次性 WARN，提示手动迁移。
- 配置校验、JSON schema、CONFIGURATION（中英）已更新；新增 19 个测试（路径解析、自定义目录读写往返、默认位置回归、三层合并、迁移 WARN、瞬态字段不泄漏、registry 接线）；全量 1131/1131 通过；双 agent 代码 + 测试评审。
- 未设置时默认位置逐字节不变；所有 API 变更为纯新增。

**安装**：`opencode plugin opencode-acp@latest --global`

### v1.15.0 — compress.reasoning：按需丢弃已关闭轮次 compress 调用的超大思考

**问题**：`compress` 工具调用消息被硬排除在一切压缩选择之外（Bug 39），每轮请求原样重发，其 `reasoning`（思考）部分随之永久驻留 —— 单调增长、压缩永远无法回收的上下文底座（实测会话中占残余上下文 83.5%；issue #368）。

**新功能**（#377，替代 #370）：
- 新增请求时 pass，仅当全部门条件成立时才移除消息的 `reasoning` 部分：（1）**轮次已关闭** —— 严格位于最后一条真实用户消息之前（活跃轮永不触碰；部分 provider 要求重放活跃轮 thinking）；（2）**选择器** —— 消息携带 `tool === "compress"` 工具 part（任意 status；仅 compress，不含 skill/task）；（3）**单条大小** —— 消息 reasoning 总长（多 part 求和）**严格大于** `threshold`（字符数）。小思考保留；长度不跨消息累计。持久化历史从不修改。
- 新增嵌套配置 `compress.reasoning { drop: true, threshold: 2048 }`，三层配置文件与 #344 provider/model cascade 均为**字段级**合并（model > provider > 全局；深层只覆盖显式设置的字段）：

```jsonc
{
    "compress": {
        "reasoning": { "drop": true, "threshold": 2048 },
        "providers": {
            "my-gateway": { "reasoning": { "drop": false } },
            "anthropic": { "models": { "claude-opus-4-5": { "reasoning": { "threshold": 8000 } } } }
        }
    }
}
```

- provider/model 标识取自当前请求最后一条用户消息的 `info.model`，取不到回落 session state。`threshold: 0` 表示丢弃所有非空 reasoning。
- 校验、JSON schema、README/CONFIGURATION（中英）全部更新；新增 29+ 测试（单元 / cascade / 校验 / hook 级 e2e，逐门变异验证）；全量 1112/1112 通过；双 agent review（代码 + 测试）。
- 同时修复 review 中发现的两个配置校验缺陷：`compress.providers` 内的 `reasoning` 覆盖被误报为未知字段；`compress.reasoning: null` 会导致插件启动崩溃而非警告。

**流程**（#367）：AGENTS.md 要求开发中发现/修复的问题必须建 issue 跟踪。

**安装**：`opencode plugin opencode-acp@latest --global`

### v1.14.27 — 手动代理模式（/bili/ baseURL）也触发自动禁用

**问题**：v1.14.25 的自动禁用只覆盖 `bili opencode` 启动器（环境变量 `BILLION_CONTEXT_PROXY`）。用户直接把某个 provider 的 `baseURL` 指向 billion-context 代理（手动模式）时，仍会同时加载两套上下文管理 —— ACP 的工具和 `/acp` 命令与代理在 wire 层的压缩并存（issue #337）。

**修复**（#338）：
- 插件的 config hook 现在扫描所有已配置 provider 的 `options.baseURL`，发现文档约定的 `/bili/` 路径前缀即自动禁用：五个 ACP 工具（`compress`、`decompress`、`search_context`、`acp_status`、`acp_context_recap`）全部 permission-deny（从 LLM 工具列表中移除）、跳过 `/acp` 命令和 `primary_tools` 注册、所有 transform/event hook 变为 no-op，并打印一行日志说明原因。
- 检测按 provider 进行且区分大小写；相似前缀（`/bilix/`、`bilibili.com`、裸 `/bili`）不会误判。禁用标志在配置重新加载、不再有 provider 走代理后自动解除。
- 没有任何 provider 走代理时行为零变化 —— 独立安装完全不受影响。新增 15 个测试（单元测试 + 通过真实插件工厂的集成测试）；全量测试 1044/1044 通过。

**文档**（#352）：
- 软废弃 `minContextLimit` 与 `modelMinLimits`（JSDoc + JSON schema + README/CONFIGURATION，中英）。两者在移除前仍完全生效；维护中的提醒机制是增长型提醒（`minNudgeContextPercent` + `nudgeGrowthTokens`）。`modelMaxLimits` **未**废弃。

**记账**（#358）：将 npm `stable` dist-tag 提升到 1.14.26。

**安装**：`opencode plugin opencode-acp@latest --global`

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

