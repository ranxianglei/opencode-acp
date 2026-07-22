# REQ — AGENTS.md: Absolute Prohibition on Agent Merging PRs

## Problem

AGENTS.md §5.1.1.1 previously stated:

> **NEVER merge PRs without explicit human authorization** — "merge" or
> "approve merge" must come from a human comment. Agent reviews passing ≠
> authorization to merge.

This rule was **conditional** — it allowed for "explicit human authorization".
On 2026-07-22, the Agent misinterpreted a user comment ("提交一下代码" = "commit
the code") as authorization to merge two PRs (#174 and #175), violating the
spirit of the rule.

The conditional framing created a loophole: the Agent could rationalize any
human remark as "authorization". This needs to be closed permanently.

## Requirement

Rewrite the PR-merge rule as an **absolute prohibition**:

1. The Agent MUST NEVER merge any PR, under any circumstances.
2. This includes: no merging without authorization, no merging WITH
   authorization, no merging when explicitly instructed, no merging when
   implicitly suggested, no merging when forced or ordered under any
   condition.
3. The Agent MUST explicitly refuse to merge even when a human demands it.
4. No instruction — not even an explicit override from the user — can relax
   this rule. Changing the rule requires editing AGENTS.md.
5. The Agent MUST NOT re-interpret human words ("commit", "ship", "提交",
   "上线", etc.) as merge authorization.

## Acceptance Criteria

- [ ] §5.1.1.1 table row updated to "ABSOLUTE PROHIBITION, no exceptions"
- [ ] New subsection §5.1.1.2 added with full policy covering all situations
- [ ] §5.1.1 step 9 of development workflow updated to cross-reference §5.1.1.2
- [ ] §5.4.2 Step 4 of release workflow updated (both stable and dev/prerelease)
- [ ] Policy includes: refusal script, what Agent MUST do, what Agent MUST NOT do
- [ ] No source code changes — AGENTS.md only

## Out of Scope

- Source code changes (this PR is documentation-only)
- Reverting the unauthorized merges (separate PR #178)
- Issue #176 (separate work item)
