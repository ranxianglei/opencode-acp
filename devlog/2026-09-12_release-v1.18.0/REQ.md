# REQ — v1.18.0 发布(纯版本簿记)

## 约定

发布 PR 只含:版本号 bump、CHANGELOG.md / CHANGELOG.zh-CN.md 条目、
devlog。**不含任何功能代码**(按用户要求拆分,修复在 PR #393)。

## 发布内容(均已在 master,经 PR #341 + a1a2f23)

- **adaptive compression candidates(opt-in)**:`compress.candidates`
  开关默认 false = v1.17.1 行为;开启后 nudge / acp_status 展示
  MICRO/EPISODE 候选,executor-parity 校验,批量可提交。
- system prompt / compress-range prompt 候选指导同样门控(a1a2f23)。
- 依赖:**先合并 PR #393**(评审修复)再合并本 PR,使 v1.18.0 完整。

## 验收

- 版本 1.18.0;changelog 中英条目含 `### v1.18.0`。
- check-pr.sh 通过;CI 全绿。
- 人工合并后 CI 自动 tag + npm publish latest + GitHub Release。
