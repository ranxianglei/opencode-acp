# WORKLOG - README 增加「该选哪个?」一节(EN+ZH)

- Task ID: `2026-09-04_readme-which-do-i-need`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-09-04

## 1. Summary

- **What was done** (1–3 sentences): 在 `README.md` 与 `README.zh-CN.md` 各新增一节「Which do I need? / 该选哪个?」,放在「## Installation / ## 安装」之前。内容为 owner 在 ranxianglei/billion-context#511 中定稿的四行选型表(pi / opencode / omp / 其余所有),每个项目带各自 GitHub 链接。
- **Why** (1–3 sentences): 三个包(billion-context / billion-context-pi / opencode-acp)经常被一起问「我该怎么选」。billion-context README 已有同节(PR #512),owner 要求跨仓库保持一致、方便用户互相跳转(issue #362)。
- **Behavior / compatibility changes**: No — 纯文档改动,不涉及代码、状态格式、配置或内部命名。
- **Risk level**: Low

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| `6fd6875` | docs: add "Which do I need?" section to READMEs (EN+ZH) |

### Key Files

- `README.md` — 「## Proven at scale」与「## Installation」之间插入「## Which do I need?」节(按本仓库风格以 `---` 分隔)。
- `README.zh-CN.md` — 「实战验证」与「安装」之间插入「## 该选哪个?」节,内容与 EN 对应。
- `devlog/2026-09-04_readme-which-do-i-need/REQ.md` — 需求记录。

## 3. Design & Implementation Notes

- **表格内容来源**: 与 billion-context master `README.md` L115-124 / `README.zh-CN.md` L53-62 已合入的同节逐字一致(通过 GitHub API 核对);仅在本仓库中补了 `---` 分隔线以匹配本仓库章节排版。
- **位置**: issue 明确要求放在「## Installation」之前(与 billion-context 的位置一致)。
- **口径**: 只回答「什么时候选什么」,不展开三者原理/关系 —— owner 在 #511 floor 9 明确「写的太啰嗦…只需说什么时候选什么即可」,floor 13 确认精简版「这个可以了」。

## 4. Testing & Verification

### Build & Test Commands

```sh
npm run typecheck   # pass
npm run build       # pass (dist/index.js 425.45 KB)
npm run test        # 1077 pass / 0 fail
```

### Test Coverage

- New/modified test files: 无(纯 markdown,无源码改动)
- Test count: 1077 total, 1077 pass, 0 fail(全量回归确认无副作用)

### Results

- **PASS/FAIL**: PASS
- Markdown 结构核对: EN/ZH 两节均位于 Installation/安装 之前;表格四行完整;四个 GitHub 链接齐全。

## 5. Risk Assessment & Rollback

- **Risk points**: 无。
- **Rollback method**:
  - Revert commit(s): 本 PR 的单个 docs commit
  - Rollback impact: 无
- **Compatibility notes** (data format, config schema): No

## 6. Lessons Learned (optional)

- 跨仓库同步文案时,直接通过 GitHub API(`Accept: application/vnd.github.raw+json`)拉取对方 master 的已合入版本做逐字比对,比凭 issue 正文更可靠(raw.githubusercontent.com 在本环境不可达,api.github.com 可达)。

## 7. Follow-ups (optional)

- [ ] billion-context-pi 侧的同款 issue(ranxianglei/billion-context-pi#290)由该仓库的 agent 处理,不在本 PR 范围。
