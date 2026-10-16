# WORKLOG — compress.reasoning.normalize：请求时归一化历史思考的 wire 形态

- **日期**: 2026-10-16
- **分支**: `2026-10-16_normalize-thinking-wire-form`（基于 master @ ac1068ae；初版自 026dbe73，rebase 对齐 #478 之后的当前 master）
- **Issue**: #482

## 1. 实现（全部完成）

| 文件 | 变更 |
| --- | --- |
| `lib/messages/reasoning-strip.ts` | 新增导出 `normalizeThinkingForm(messages): number`：对每个 assistant 消息，把全部 `reasoning` part（`typeof p.text==="string"`）正文用 `""` 拼接为 R，全部 `text` part 正文用 `""` 拼接为 T，生成单个 `<thinking>\n{R}\n</thinking>` +（T 非空则 `\n{T}`）text part，替换原所有 reasoning/text part（tool/file/image/step 原位保留）；donor 优先复用首个 text part 对象（改其 `.text`），否则新建 id `${message.info.id}-acp-think`；返回被归一化的消息数。另加两个 type-predicate guard `isReasoningWithText`/`isTextWithText`（普通 `.filter()` 不收窄 Part union，直接 filter 会报 SubtaskPart 无 `.text`） |
| `lib/hooks.ts` | import += `normalizeThinkingForm`；`createChatMessageTransformHandler` 中 #368 drop 块之后、filters 之前：`if (reasoningConfig?.normalize !== false) normalizeThinkingForm(output.messages)`（复用 #368 已按 cascade 解析出的 `reasoningConfig`，不重复解析） |
| `lib/messages/index.ts` | barrel export += `normalizeThinkingForm` |
| `lib/config.ts` | `CompressReasoningConfig` += 可选 `normalize?: boolean`（**不**加入 `DEFAULT_COMPRESS_REASONING`）；`mergeCompress` 条件式转发：仅当某层显式设置 `normalize` 时才把它并入返回的 reasoning 对象 —— 保持未配置时 resolved 对象字节不变，既有 deepEqual 断言不受影响 |
| `lib/config-validation.ts` | VALID_CONFIG_KEYS += `compress.reasoning.normalize`；顶层 + providers override 两处类型校验 += `normalize` 必须 boolean |
| `dcp.schema.json` | 三处 reasoning（compress / providers 项 / models 项）+= `normalize` 属性 |

注：cascade **无需**改 `lib/messages/inject/utils.ts` —— `resolveCompressOverrides`/
`applyCompressOverrides` 均用对象展开 `{...base, ...override}`，provider/model 级
`normalize` 自动流转。

## 2. 测试（定向套件全绿；typecheck/build 干净）

- `tests/reasoning-strip.test.ts` +8：R+T 精确字节 / R-only 无尾换行 / 多 part "" 拼接 /
  幂等（二次运行返回 0 + JSON.stringify 不变）/ 无 reasoning 不动 / 非 assistant 忽略 /
  tool part 原位保留 / 计数
- `tests/config-validation.test.ts` +4：接受 valid `normalize:false`（known field）/
  validateConfigTypes 接受 boolean / 拒绝顶层非 boolean / 拒绝 providers override 内非 boolean
- `tests/config-providers.test.ts` +4：resolve 字段级合并 + 跨 model 继承 / model 胜 provider /
  apply 转发 provider 级 `normalize:false`（不改输入 config）/ **byte-stability**：无人设
  normalize 时 resolved 对象不新增 key（`Object.keys(reasoning).length===2`）
- `tests/e2e-message-transform.test.ts` +2 新（默认折叠为 `<thinking>` text / `normalize:false`
  保留独立 reasoning）+ 4 处 #368 keep-case 适配（加 `normalize:false` 隔离「drop 门是否移除」
  这一被测意图，避免被 #482 折叠干扰）

定向运行：config-protected-tools + config-providers + config-validation + reasoning-strip =
108/108；e2e-message-transform + e2e-blocks-nudges = 34/34。全量回归交 CI。

## 3. 文档（全部完成）

- `CONFIGURATION.md` / `CONFIGURATION.zh-CN.md`：`compress.reasoning` 参考节 Type / Default /
  Status / Description 更新 + 新增 `normalize` 字段说明（含 kill-switch 边界）+ cascade 示例
  += normalize + 解析顺序注明含 normalize
- `README.md` / `README.zh-CN.md`：compress 示例块 `reasoning` += `"normalize": true`（带 #482 注释）

## 4. 备注

- **行为变更（须在 PR/reply 披露 old→new）**：默认开启 wire 形态归一化，上游模型看到的历史
  思考从独立 reasoning 字段变为正文 `<thinking>` 带标记文本。kill-switch：
  `compress.reasoning.normalize: false`。
- **#368 vs #482 交互**：normalize 在 drop 之后跑。drop 移除的 reasoning 不会再被折叠（已消失）；
  drop 保留的小思考会被折叠进 text。因此四个 #368 e2e keep-case（断言独立 reasoning part 存活）
  加 `normalize:false` 以隔离被测意图；dropped-case 断言不受影响。
- **范围外**：直连结构化 thinking 回放 provider（Anthropic native / Gemini thoughtSignature）——
  用户可按 REQ §4 自行设 `normalize:false`，未在本 PR 加自动检测。
