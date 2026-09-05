# REQ - README 增加「该选哪个?」一节

- Task ID: `2026-09-04_readme-which-do-i-need`
- Home Repo: `opencode-acp`
- Created: 2026-09-04
- Status: Done
- Priority: P2
- Owner: ranxianglei
- References: https://github.com/ranxianglei/opencode-acp/issues/362 · 来源 ranxianglei/billion-context#511(同节已在 billion-context PR #512 定稿)

## 1. Background & Problem Statement

- **Context**: 三个包(`billion-context` / `billion-context-pi` / `opencode-acp`)经常被一起问「我该怎么选」。billion-context 的 README 已统一了一节「Which do I need? / 该选哪个?」(ranxianglei/billion-context#511),owner 要求 opencode-acp 与 billion-context-pi 的 README 也加同一节,跨仓库保持一致、方便用户互相跳转。
- **Current behavior (symptom)**: `opencode-acp` 的 `README.md` / `README.zh-CN.md` 目前没有这一节。
- **Expected behavior**: 两个 README 各加一节「Which do I need? / 该选哪个?」,内容为 owner 在 #511 中定稿的四行表格(pi / opencode / omp / 其余所有),每个项目带各自 GitHub 链接。位置:**放在「## Why ACP / ## 为什么选择 ACP」之后**(2026-09-05 owner 修订;最初要求放在 Installation 之前)。
- **Impact**: 纯文档;用户跨仓库选型时可互相跳转,口径统一。
- **修订记录**: 2026-09-05 owner 反馈「放在 为什么选择 ACP 后面吧」——节位置由「## Installation 之前」改为「## Why ACP / ## 为什么选择 ACP 之后」。表格内容不变(仍与 billion-context 逐字一致)。

## 2. Reproduction (if applicable)

不适用(文档改动)。

## 3. Constraints & Non-Goals

- **Constraints**:
  - Backward compatibility: 不涉及代码/状态/配置,无兼容性影响。
  - 内容必须与 billion-context README(PR #512 落定版)逐字一致(表格 + GitHub 链接),只按本仓库风格补 `---` 分隔线。
  - EN/ZH 两个 README 同步修改。
  - 不动 `package.json` version。
- **Non-Goals**:
  - 不解释三者原理/关系(billion-context 侧已删掉冗长解释,owner 明确「只需说什么时候选什么即可」)。
  - 不改其他章节。

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
  - [x] `README.md` 在「## Why ACP」之后新增「## Which do I need?」节,表格四行(pi / opencode / omp / everything else),每个项目带 GitHub 链接
  - [x] `README.zh-CN.md` 在「## 为什么选择 ACP」之后新增「## 该选哪个?」节,内容与 EN 对应、与 billion-context ZH README 一致
  - [x] 表格内容与 billion-context master README 中已合入的同节逐字一致
- **Performance / Stability**: 不适用
- **Regression**:
  - [ ] 无源码改动,typecheck/build/test 不受影响(仍跑一次确认)

## 5. Proposed Approach (optional)

- **Affected modules & entry files**:
  - `README.md`(EN)
  - `README.zh-CN.md`(ZH)
  - `devlog/2026-09-04_readme-which-do-i-need/`(本目录)
- **Risks**: 无(纯 markdown)。
- **Rollback strategy**: revert 单个 commit。
