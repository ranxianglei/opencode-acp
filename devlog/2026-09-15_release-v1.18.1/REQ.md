# REQ — v1.18.1 发布(纯版本簿记)

## 约定

发布 PR 只含:版本号 bump、CHANGELOG.md / CHANGELOG.zh-CN.md 条目、
devlog。**不含任何功能代码**。

## 发布内容(均已在 master,经 PR #394)

- **论文预印本 v0.2 入库**:`paper/` 下英文 + 中文两版预印本
  (model-driven incremental hierarchical compression,training-free
  multi-generational context management)、`paper/figures/` 六张配图及
  `make-figures.py`、两个 README 的 MIT 开放获取标注与链接。
- 纯文档变更,无运行时代码影响。

## 验收

- 版本 1.18.1;changelog 中英条目含 `### v1.18.1`。
- check-pr.sh 通过;CI 全绿。
- 人工合并后 CI 自动 tag + npm publish latest + GitHub Release。
