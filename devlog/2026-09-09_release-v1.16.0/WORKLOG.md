# WORKLOG — release v1.16.0

- **日期**: 2026-09-09
- **分支**: `2026-09-09_release-v1.16.0`

## 步骤（对照 AGENTS.md §5.4.2）

1. `git checkout -b 2026-09-09_release-v1.16.0 master`（基点 5135dfd = PR #380 的 merge commit；v1.15.0 之后 master 上唯一未发布变更）
2. `npm version 1.16.0 --no-git-tag-version`
3. CHANGELOG.md / CHANGELOG.zh-CN.md 顶部新增 `### v1.16.0` 条目（问题/功能/安装，沿用 v1.15.0 条目格式；含 jsonc 配置示例 + 路径语义表）
4. devlog REQ.md + WORKLOG.md
5. `./scripts/ci/check-pr.sh 2026-09-09_release-v1.16.0 origin/master` → All checks passed
6. commit + push + PR → 等待人工合并
7. 合并后 release.yml 自动：检测 release 分支名 → 打 `v1.16.0` tag → npm ci → check:package → test → `npm publish`（latest）→ GitHub Release

## 发布内容

见 REQ.md 表格。核心：PR #380 `storagePath`（#379）。

## 备注

- merge 由人工执行（AGENTS.md §5.1.1.2 — Agent 绝不合并 PR）。
- 版本号不含 `-` 后缀 → CI 发布到 `latest`（非 dev tag）。
- PR #381（docs）合并后如需并入本次发布，需另切 release 分支。
