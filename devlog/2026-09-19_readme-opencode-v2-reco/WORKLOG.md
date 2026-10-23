# WORKLOG — README: point OpenCode 2.x users to billion-context

## Steps

1. Created branch `2026-09-19_readme-opencode-v2-reco` from master `7ec1b76` (v1.18.2 release merge).
2. `README.md`:
   - Inserted blockquote callout between the title block and the Paper section: OpenCode 2.x users → billion-context (`bili opencode` / `bili plugin install opencode`); extension remains supported on 1.x.
   - "Which do I need?" table: split the single `opencode` row into `opencode 1.x` (opencode-acp) and `opencode 2.0+` (billion-context, with both install paths and the note that opencode-acp does not load on 2.x).
   - Installation section: added a note above the install commands that they install the V1 plugin for OpenCode 1.x only.
3. `README.zh-CN.md`: mirrored all three changes in Chinese.
4. Added this devlog entry (REQ.md + WORKLOG.md).

## Verification

- Docs-only diff: `git diff --stat` = README.md, README.zh-CN.md, devlog/2 files; zero source/test/config changes.
- Cross-checked every claim against billion-context's current code (`src/agent/opencode-v2.ts`, `src/agent/opencode-native.ts`, `src/launcher.ts`) and its READMEs before writing: both bili paths are verified end-to-end on `@opencode/cli` 2.0.3; the launcher path is the recommended easiest route.
- No version change → no changelog entry required per check-pr.sh rules.
