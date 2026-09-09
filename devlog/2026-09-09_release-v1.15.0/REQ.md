# REQ — release v1.15.0

- **日期**: 2026-09-09
- **分支**: `2026-09-09_release-v1.15.0`（自 github/master @ 4a8b443）
- **版本**: 1.14.27 → 1.15.0（minor：含新功能）

## 发布内容（v1.14.27..master）

| PR | 类型 | 内容 |
| --- | --- | --- |
| #377 | feat | `compress.reasoning` — 请求时丢弃已关闭轮次 compress 调用的超大 reasoning（closes #368，supersedes #370）。嵌套配置字段级合并 + #344 cascade；1112 测试；双 agent review |
| #367 | docs | AGENTS.md 要求开发中发现/修复的问题必须建 issue 跟踪（流程文档，非用户可见） |

## 版本号决策

含新功能（compress.reasoning）→ minor bump 1.14.27 → **1.15.0**。

## 清单

- [x] package.json version → 1.15.0
- [x] CHANGELOG.md / CHANGELOG.zh-CN.md 顶部新增 `### v1.15.0` 条目
- [x] devlog REQ + WORKLOG
- [x] `./scripts/ci/check-pr.sh` 通过
- [ ] PR 合并（人工）后 release.yml 自动打 tag `v1.15.0`、构建、测试、发 npm `latest`、建 GitHub Release
