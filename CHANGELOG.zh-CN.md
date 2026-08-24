# 更新日志

### v1.14.25 — 在 billion-context 代理下自动禁用

**问题**：运行 `bili opencode`（billion-context 启动器）的用户会同时加载两套 ACP：代理在 wire 层注入 compress / decompress / search_context / acp_status 并提供自己的 `/acp` 面板，而 opencode-acp 又注册了同名工具和竞争性的 `/acp` 命令 —— 工具重复注册，且客户端面板遮蔽了代理的真实压缩状态。

**修复**（#335）：
- 插件启动时检查 `process.env.BILLION_CONTEXT_PROXY`（`bili` 启动器必设），命中则打印一行日志并返回空插件对象 —— 不注册任何工具、命令或转换。
- 未设置该环境变量时行为零变化；独立安装完全不受影响。

**安装**：`opencode plugin opencode-acp@latest --global`

