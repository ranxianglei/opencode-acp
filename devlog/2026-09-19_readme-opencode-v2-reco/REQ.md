# REQ — README: point OpenCode 2.x users to billion-context

## Goal

`opencode-acp` uses the OpenCode **V1** plugin API and does not load on OpenCode 2.x, but the READMEs never say so at the top of the page — a 2.x user following the install command gets a plugin that silently does nothing. Update `README.md` and `README.zh-CN.md` (both languages) to:

1. Add a prominent callout near the top: on OpenCode 2.x this extension will not load; the recommended context manager for 2.x is [billion-context](https://github.com/ranxianglei/billion-context) (`bili opencode` launcher or `bili plugin install opencode` native plugin); opencode-acp remains fully supported on OpenCode 1.x.
2. Split the "Which do I need?" / 「该选哪个?」 table row for `opencode` into `opencode 1.x` (this extension) and `opencode 2.0+` (billion-context).
3. Add a matching note under Installation / 安装 (the install command targets 1.x).

Source: [billion-context#985](https://github.com/ranxianglei/billion-context/issues/985) (ranxianglei): "这里的readme也更新 v2版本推荐 https://github.com/ranxianglei/billion-context 注意中英文都改."

## Context

- The companion change in billion-context updates its own READMEs' OpenCode 2.0 section to make the same recommendation explicit (that PR references issue #985).
- Docs-only change: no source, no version bump, no changelog entry required (`check-pr.sh` skips the changelog check when the version is unchanged).
