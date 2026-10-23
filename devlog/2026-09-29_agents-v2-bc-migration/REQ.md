# REQ - Codify OpenCode V2 → billion-context migration policy in AGENTS.md

- Task ID: `2026-09-29_agents-v2-bc-migration`
- Home Repo: `opencode-acp`
- Created: 2026-09-29
- Status: InProgress
- Priority: P2
- Owner: ranxianglei (requested); executed by ework-daemon
- References: #442 (ruling: OpenCode V2 routes through billion-context), #395/#434 (history), billion-context#754 (V2 delivery), PR #441 (README 2.x pointer, merged)

## 1. Background & Problem Statement

- **Context**: Per #442, opencode-acp stays OpenCode **1.x-only**; OpenCode **2.x** is served by the sibling `billion-context` package. The in-repo experimental V2 native port (`lib/v2/*`, on the retired `v2-base` branch) is not maintained. Contributors keep filing OpenCode-V2 requests here regardless (e.g., @akrhin's batch #455–#467 on 2026-09-29).
- **Current behavior (symptom)**: There is no standing, authoritative instruction in AGENTS.md telling agents how to handle a future OpenCode-V2 request in this repo, so each one must be re-litigated from scratch.
- **Expected behavior**: AGENTS.md states the V2→billion-context decision and a MANDATORY agent behavior rule — politely decline, recommend billion-context (with install commands), then close the issue — while NOT misdirecting genuine OpenCode 1.x bugs that happen to mention V2.
- **Impact**: Consistent, correct triage of future V2 requests; no duplicate V2 maintenance in this repo; fair handling of mixed V1/V2 reports.

## 2. Reproduction (if applicable)

- N/A (documentation/policy change; no runtime reproduction).

## 3. Constraints & Non-Goals

- **Constraints**:
  - Docs-only; MUST NOT touch `version` in package.json (non-release branch).
  - MUST preserve existing AGENTS.md structure; insert as a new subsection under Project Overview.
- **Non-Goals** (explicitly out of scope):
  - No source or test changes.
  - No changes to the billion-context repo.
  - Do not close/reopen any issues from this PR.

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
  - [ ] New AGENTS.md section states opencode-acp = OpenCode 1.x-only and OpenCode 2.x → billion-context (`bili opencode` / `bili plugin install opencode`).
  - [ ] Section contains a MANDATORY agent behavior rule (decline → recommend billion-context → close), referencing #442.
  - [ ] Section includes the exception: verify which tree the reported path lives on before redirecting; genuine 1.x bugs stay and are handled normally.
- **Regression**:
  - [ ] No source/test/version changes; CI typecheck+test+build unaffected.

## 5. Proposed Approach (optional)

- **Affected modules & entry files**: `AGENTS.md` (new subsection 1.4), `devlog/2026-09-29_agents-v2-bc-migration/{REQ,WORKLOG}.md`.
- **Risks**: Low — documentation only.
- **Rollback strategy**: Revert the single commit.
