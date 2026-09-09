# REQ — compress.reasoning：compress 调用思考的按需 drop

- **日期**: 2026-09-09
- **分支**: `2026-09-09_compress-reasoning-drop`
- **Issue**: #368（替代已关闭的 PR #370 — 允许列表/激活门方案被所有者否决，按新设计干净重做）
- **状态**: 实现完成，待双 agent review

## 1. 问题（#368）

`compress` 工具调用消息被硬排除在一切压缩选择之外（Bug 39），每轮请求原样重发，
其 `reasoning`（thinking）部分随之永久驻留 —— 形成压缩永远无法回收的不可压缩底座
（实测会话中占残余上下文 83.5%）。

## 2. 新设计（所有者逐条定稿）

**配置**（嵌套对象，字段级合并）：

```jsonc
{
  "compress": {
    "reasoning": {
      "drop": true,        // 总开关，默认 true
      "threshold": 2048    // 单条思考大小阈值（chars），默认 2048；0 = 无条件 drop
    },
    "providers": {                    // #344 三级 cascade，字段级深合并
      "my-gateway": { "reasoning": { "drop": false } },
      "anthropic": { "models": { "claude-opus-4-5": { "reasoning": { "threshold": 8000 } } } }
    }
  }
}
```

**行为**：请求时 pass，对满足全部条件的消息移除 `reasoning` part：
1. **轮次已关闭**：严格位于最后一条真实用户消息之前（活跃轮永不触碰 — 部分
   provider 要求重放活跃轮 thinking）；
2. **选择器**：消息携带 `tool === "compress"` 的工具 part（**仅 compress**，
   不含 skill/task 等其他保护工具 — 所有者定稿：本功能只作用于 compress，
   且 compress 永远被保护，"protected" 命名废弃）；
3. **单条大小**：该消息 reasoning 总长（多个 part 求和）**严格大于** threshold
   才 drop（所有者定稿："超过一定范围…单个思考大小"；小思考保留；非累计）。

**解析顺序**：`providers[p].models[m].reasoning` > `providers[p].reasoning` >
`compress.reasoning`（字段级：深层只在字段显式设置时覆盖浅层）。
provider/model id 取本请求最后一条用户消息 `info.model`，取不到回落
`state.modelProviderID` / `state.modelID`。

**三级配置文件**：global/configDir/project 层内 `reasoning` 同样字段级合并
（深层不写不清空浅层）。

## 3. 被否决的旧方案（PR #370，已关闭）

- ~~`stripProtectedReasoningProviders` 允许列表~~：providerID 因人而异无法枚举
  （且默认值 "gemini" 匹配不上第一方 `google`），应走现有 cascade 由用户用
  自己的 provider key 配置；
- ~~`stripProtectedReasoningMinMessages` 消息数激活门~~：消息总数与底座大小
  无关，代理变量；
- ~~累计预算模型~~：所有者定稿为单条思考大小，不累计；
- ~~平铺 4 键 `stripProtectedReasoning*`~~：改嵌套 `compress.reasoning`。

## 4. 不变量

- 只改请求数组，不写任何持久化状态；
- 非 reasoning part（tool call/text/synthetic）原样保留；
- 无最后用户消息（fail-safe）→ 不 drop；
- 幂等（drop 后再跑 removed=0）；
- 内部命名规约（§2.6）：不涉及 dcp 标签改动。

## 5. 验收标准

- [x] 纯函数 `dropCompressReasoning(messages, threshold)`：轮次关闭/选择器
      （仅 compress，skill 为负例）/单条阈值（<、==、>、0=无条件、多 part 求和）/
      幂等/无用户消息 fail-safe
- [x] 三层配置文件字段级合并 + cascade 深合并（model > provider > global）单测
- [x] hook 级 e2e：kill-switch、阈值门、provider 级关闭、model 级覆盖胜出
- [x] config-validation：`compress.reasoning` 对象 + drop/threshold 类型校验
- [x] schema 三处（compress / providers 项 / models 项）
- [x] 文档四份（CONFIGURATION 中英 + README 中英）
- [x] mutation 验证：门逐个禁用时对应测试必须失败

## 6. 风险与回滚

- 回滚：`compress.reasoning.drop: false`（立即 no-op）或 revert 分支。
- 兼容：纯新增嵌套键；无持久化状态/内部标签改动；PR #370 未发布无兼容包袱。
