# WORKLOG — PR #341 候选开关的评审修复

## 变更

从 pr341-merge-test 工作区(stash pop 到基于 github/master 的本分支,
无冲突)提取 reviewer 要求的代码级修复,7 个文件:

- `lib/config.ts`:`CompressOverridableConfig` Omit 列表加 `candidates`
- `lib/messages/inject/inject.ts`:efficiencyNote 与 debug
  Recommendation-filter 日志按 `candidatesEnabled` 分叉,OFF 恢复 master 原文
- `lib/compress/status.ts`:无参概览 OFF 时走 master 裸
  `formatCompressibleRanges` 路径(computeProtectedRefs +
  buildCompressibleRanges),Tip 行 OFF 恢复原样
- `lib/hooks.ts`:`candidateMessages` 仅在 `candidates === true` 时 slice
- `CONFIGURATION.md` / `CONFIGURATION.zh-CN.md`:可覆盖字段列表移除
  `candidates`
- `devlog/2026-09-12_candidate-switch/WORKLOG.md`:评审跟进表(B 保留理由)

## 验证

- typecheck 0 错误;1263/1263 测试;build OK(在 release 分支 cc868b3
  上验证,与本分支内容相同;本分支另跑 typecheck+全量)。
- check-pr.sh:分支名/规范通过;无版本变更,无 changelog 要求。

## 备注

- finding B(hooks 管道重排)不修,理由见 REQ。
- 修复内容曾暂存在 v1.18.0 发布分支(cc868b3),后按"发布 PR 不得含
  功能代码"的约定拆出;发布分支已重置为纯版本簿记。
