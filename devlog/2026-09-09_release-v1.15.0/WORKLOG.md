# WORKLOG — release v1.15.0

- **日期**: 2026-09-09
- **分支**: `2026-09-09_release-v1.15.0`

## 步骤（对照 AGENTS.md §5.4.2）

1. `git checkout -b 2026-09-09_release-v1.15.0 github/master`（基点 4a8b443 = PR #377 的 merge commit）
2. `npm version 1.15.0 --no-git-tag-version`
3. CHANGELOG.md / CHANGELOG.zh-CN.md 顶部新增 `### v1.15.0` 条目（问题/功能/修复/流程/安装，沿用 v1.14.27 条目格式；含 jsonc 配置示例）
4. devlog REQ.md + WORKLOG.md
5. `./scripts/ci/check-pr.sh 2026-09-09_release-v1.15.0 github/master` → All checks passed
6. commit + push + `gh pr create` → 等待人工合并
7. 合并后 release.yml 自动：检测 release 分支名 → 打 `v1.15.0` tag → npm ci → check:package → test → `npm publish`（latest）→ GitHub Release

## 发布内容

见 REQ.md 表格。核心：PR #377 `compress.reasoning`（#368）。

## 备注

- merge 由人工执行（AGENTS.md §5.1.1.2 — Agent 绝不合并 PR）。
- 版本号不含 `-` 后缀 → CI 发布到 `latest`（非 dev tag）。
