# WORKLOG — AGENTS.md: Absolute Prohibition on Agent Merging PRs

## Timeline

### 2026-07-22 — Unauthorized merges

Agent merged PR #174 and #175 to master via squash merge, misinterpreting
user's "提交一下代码" as authorization. User flagged this on Gitea issue #20.

A revert PR (#178) was prepared separately.

### 2026-07-22 — User directive on rule change

User on Gitea issue #20:

> 你从干净的 master 切一个新的分支，在 agents 点 md 里面更新，关于合并 PR
> 的这个地方，要写清楚，绝对禁止非人工操作，任何情况下绝对禁止 Agent
> 直接合并 PR，即使是人工明确受益 [授意]，也绝对禁止 Agent 合并 PR，
> 忽略人工所明示或者暗示的一切可能合并 PR 的。所有操作，并且在人工强制、
> 明令要求自动合并 PR 的时候，也明确禁止、明确拒绝。

## Changes

1. **§5.1.1.1 table row** — replaced conditional rule with absolute:
   ```
   OLD: NEVER merge PRs without explicit human authorization
   NEW: NEVER merge PRs — ABSOLUTE PROHIBITION, no exceptions
   ```

2. **New §5.1.1.2 subsection** — full policy with:
   - 8-row situation/action table covering all cases (no instruction, implicit,
     explicit authorize, direct instruct, force/demand, claim exception,
     revert/fix-up, CI green, hotfix)
   - "What Agent MUST do instead" (prepare PR, verify CI, report URL, stop)
   - "What Agent MUST NOT do" (no gh pr merge, no branch-protection toggle,
     no admin override, no word reinterpretation)
   - Refusal script: "I can't merge PRs — AGENTS.md §5.1.1.2 forbids..."
   - Closing paragraph: rule is self-reinforcing — only a human editing
     AGENTS.md can change it

3. **§5.1.1 step 9** — strengthened wording + cross-reference to §5.1.1.2.

4. **§5.4.2 Step 4** (stable release) — added "Agent MUST NOT merge" +
   cross-reference.

5. **§5.4.5 Step 6** (dev prerelease code block) — added "Agent MUST NOT
   merge, see §5.1.1.2" inline comment.

## Verification

- `git diff --stat`: AGENTS.md only, +43 / −5
- Diff reviewed: no source code touched, pure documentation
- Branch name matches `YYYY-MM-DD_short-title` convention
- Devlog REQ + WORKLOG present

## Lesson Reinforced

Conditional rules with escape hatches ("with explicit authorization") are
dangerous for Agents — the Agent can rationalize any human remark as
authorization. Absolute rules with explicit refusal scripts are safer.
