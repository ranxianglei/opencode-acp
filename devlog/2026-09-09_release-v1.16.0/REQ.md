# REQ — release v1.16.0

- **日期**: 2026-09-09
- **分支**: `2026-09-09_release-v1.16.0`（自 master @ 5135dfd）
- **版本**: 1.15.0 → 1.16.0（minor：含新功能）

## 发布内容（v1.15.0..master）

| PR | 类型 | 内容 |
| --- | --- | --- |
| #380 | feat | `storagePath` — 自定义会话状态文件存储位置（closes #379）。绝对 / `~` / 项目相对路径语义；瞬态 `SessionState.storageDir`（不持久化）；不自动迁移 + 一次性 WARN；19 新测试（全量 1131/1131）；双 agent 代码 + 测试评审 |

## 版本号决策

含新功能（storagePath）→ minor bump 1.15.0 → **1.16.0**。

注：PR #381（messageFilters 配置文档）截至切分支时仍 open，不在本次发布范围；如需并入需另切 release 分支。

## 清单

- [x] package.json version → 1.16.0
- [x] CHANGELOG.md / CHANGELOG.zh-CN.md 顶部新增 `### v1.16.0` 条目
- [x] devlog REQ + WORKLOG
- [x] `./scripts/ci/check-pr.sh` 通过
- [ ] PR 合并（人工）后 release.yml 自动打 tag `v1.16.0`、构建、测试、发 npm `latest`、建 GitHub Release
