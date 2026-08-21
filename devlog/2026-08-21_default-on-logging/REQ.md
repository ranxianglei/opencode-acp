# REQ — default-on decision-level logging

## 背景

用户反馈：项目日志非常少，且只在 `debug: true` 时才写 INFO/DEBUG。默认配置（`debug: false`）下只有 WARN/ERROR 落盘，出问题时文件里几乎没有可排查的决策轨迹。

## 需求

1. **默认（非 debug）就要打印**：INFO 级决策日志默认写盘。
2. 可配置：用户能把级别调低（warn/error/silent）或调高（debug）。
3. 向后兼容：
   - `new Logger(boolean)` 现有语义不变（false→仅 WARN/ERROR；true→全量），~40 个测试文件不受影响。
   - `debug: true` 行为不变（debug 级 + saveContext 快照）。

## 方案

- `LogLevel = "debug" | "info" | "warn" | "error" | "silent"` + LEVEL_RANK 门控写入。
- 新配置项 `logLevel`（默认 `"info"`），`debug: true` 时覆盖为 debug。
- INFO 决策日志铺到核心路径：插件初始化、每请求 transform 摘要、模型切换、nudge 注入/抑制决策（含 tier 触发）、自动更新检查全程。
- saveContext 仍只在 debug 级开启（避免默认每请求 JSON 转储膨胀）。

## 验收

- 默认配置下 `~/.config/opencode/logs/acp/daily/<date>.log` 有 INFO 决策行。
- `tsc --noEmit` 0 错误；全量测试通过（含新增 4 个分级语义测试）。
