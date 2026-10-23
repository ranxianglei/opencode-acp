# WORKLOG — v1.18.1 发布(纯版本簿记)

## 步骤

1. 自 origin/master 创建发布分支 `2026-09-15_release-v1.18.1`。
2. `package.json` 1.18.0 → 1.18.1。
3. CHANGELOG.md / CHANGELOG.zh-CN.md 增加 v1.18.1 条目(内容 = PR #394
   论文预印本 v0.2 入库,纯文档)。
4. 验证:`check-pr.sh` 全绿(分支名 / devlog / changelog 版本串);
   typecheck / build / test / format:check 全绿。

## 验证结果

- diff 仅含簿记文件:package.json、两个 CHANGELOG、devlog。
- CI 通过后由人工合并;合并后 release.yml 自动 tag v1.18.1 +
  npm publish latest + GitHub Release。
