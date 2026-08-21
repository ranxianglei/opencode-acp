# WORKLOG — default-on decision-level logging

## 变更

### lib/logger.ts
- 新增 `export type LogLevel = "debug"|"info"|"warn"|"error"|"silent"` 与 `LEVEL_RANK`（silent=99 吞掉一切）。
- 构造签名 `constructor(enabled: boolean, level?: LogLevel)`；`this.level = level ?? (enabled ? "debug" : "warn")` —— 纯布尔调用保持旧语义。
- `get enabled()` 改为派生视图（`level === "debug"`）。
- `write()` 按级别秩次门控；`info()/debug()` 增加可选 `data` 参数（`unknown`，非 any）。
- `saveContext` 仅在 debug 级写快照。

### 配置链
- `lib/config.ts`：`PluginConfig.logLevel: LogLevel`，默认 `"info"`，mergeLayer 合并。
- `lib/config-validation.ts`：VALID_CONFIG_KEYS + 枚举校验（5 值）。
- `dcp.schema.json`：logLevel string enum，default "info"。

### 装配
- `index.ts`：`new Logger(config.debug, config.debug ? "debug" : config.logLevel)`；初始化 INFO（版本/工作区/级别/secure/auto-update）；`startAutoUpdate(ctx, config.autoUpdate, logger)`。

### INFO 决策日志铺设
- `lib/messages/inject/inject.ts`：nudge 注入（trigger=tier/growth/emergency + usagePct + growthFloor + 推荐区间）、紧急 /compact 通知、抑制原因（all_protected / in_protected_zone / below_effective_floor）、tier 触发注入。
- `lib/hooks.ts`：每请求 transform 完成摘要（模型/消息数/pre-post tokens/上下文占用%/是否 nudge）；会话内模型切换。
- `lib/update.ts`：线程化可选 Logger；检查启动/跳过原因（无包目录、不可读、无目标、规范不可更新、tag 无版本、已最新）/发现新版本/失败/应用成功。

### 测试
- `tests/logger.test.ts` 新增 4 例：显式 info 级（INFO/WARN/ERROR 写、DEBUG 门控）、silent 全吞、error 级仅 ERROR、`enabled` getter 反映显式级别。8/8 通过。

### 文档
- CONFIGURATION.md / CONFIGURATION.zh-CN.md：新增 `logLevel` 小节，重写 `debug` 小节（覆盖关系）。
- README.md / README.zh-CN.md：配置示例加 `logLevel`。

## 验证

- `npx tsc --noEmit` → 0 errors。
- `node --import tsx --test tests/logger.test.ts` → 8 pass / 0 fail。
- 全量：见 PR 检查项（发布前跑）。

## 风险与回滚

- 日志量增长有限：决策级事件每请求 ~2 行 + 低频路径；无 per-message 转储。
- 回滚点：本 PR 单 commit revert 即可。
