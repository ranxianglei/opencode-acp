# REQ - E2E Test for ACP Compression

- Task ID: `2026-07-22_e2e-test`
- Home Repo: `opencode-acp`
- Created: 2026-07-22
- Status: InProgress
- Priority: P1
- Owner: bot
- References: dog/opencode-acp#20, ework-aio scripts (fake-llm-server.ts reference)

## 1. Background & Problem Statement

- **Context**: ACP has 817 unit/integration tests covering internal logic, but zero end-to-end tests that exercise the full pipeline: opencode → ACP plugin hooks → compress tool → state persistence. The quality gate enforcement (PR #173) was tested through `createCompressRangeTool` integration tests, but these mock the opencode runtime (`ToolContext.client.session.messages`). Real-world issues like tool registration failures, message transform hook ordering, or state persistence bugs would not be caught.
- **Current behavior (symptom)**: No way to verify that a real opencode session with ACP produces correct compression state. Manual testing requires running opencode interactively and inspecting state files by hand.
- **Expected behavior**: Automated E2E test that: (1) builds ACP, (2) starts a fake LLM server, (3) runs scripted conversations through opencode, (4) verifies ACP state files match expectations.
- **Impact**: Regression protection for the full pipeline. Catches integration bugs between opencode and ACP that unit tests miss.

## 2. Reproduction (if applicable)

- **Environment**:
  - Node: v25.9.0
  - OS/Arch: linux-x64
  - opencode binary: `/home/dog/.local/bin/opencode`
  - bun: 1.3.13 (for fake-llm-server.ts)
- **Minimal reproduction steps**: N/A (new test infrastructure)

## 3. Constraints & Non-Goals

- **Constraints**:
  - Must not require Docker (local-first; Docker optional for CI later)
  - Must not disrupt the user's real opencode config (use `HOME=/tmp/acp-e2e` isolation)
  - Must not require real API keys (fake LLM server)
  - Must use bun for fake-llm-server.ts (matches awork-web reference, Bun.serve is simpler than Node http)
  - Scenarios must be JSON-defined for easy extension
- **Non-Goals** (explicitly out of scope):
  - Docker containerization (can be added later for CI)
  - Testing ACP nudges (requires real context-limit behavior, hard to script deterministically)
  - Testing GC/truncation (requires long-running sessions, impractical for E2E)
  - Testing protected tool exclusion (requires specific tool registration in opencode)

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
  - [ ] `scripts/e2e/run-e2e.sh` runs all scenarios and exits 0 on pass, 1 on fail
  - [ ] Scenario 01 (basic-compress): produces exactly 1 block with correct summary
  - [ ] Scenario 02 (quality-reject): bad summary rejected, `qualityGateRetryPending === true`, 0 blocks
  - [ ] Scenario 03 (quality-acknowledge): rejected then acknowledged, block created with flag consumed
  - [ ] Scenario 04 (batch-compress): multiple ranges in one call, multiple blocks created
- **Performance / Stability**:
  - [ ] Each scenario completes in <60 seconds
  - [ ] No leftover processes (fake LLM killed on exit)
- **Regression**:
  - [ ] Existing 817 tests still pass
  - [ ] `npm run typecheck` and `npm run build` still pass

## 5. Proposed Approach

- **Affected modules & entry files**:
  - NEW: `scripts/e2e/fake-llm-server.ts` — Bun SSE server, scenario-driven
  - NEW: `scripts/e2e/run-e2e.sh` — orchestrator
  - NEW: `scripts/e2e/verify.ts` — ACP state file verifier
  - NEW: `scripts/e2e/scenarios/*.json` — test scenario definitions
  - NEW: `scripts/e2e/README.md` — usage guide

- **Architecture**:
  ```
  run-e2e.sh
    ├── Build ACP (npm run build)
    ├── Start fake LLM server (bun fake-llm-server.ts --scenario <json>)
    ├── Configure opencode (HOME=/tmp/acp-e2e, fake provider + local ACP plugin)
    ├── For each user turn: opencode run -c "message" (multi-turn conversation)
    ├── Read ACP state file
    └── Run verify.ts (assert blockCount, qualityGateRetryPending, etc.)
  ```

- **Key design decisions**:
  1. **HOME isolation**: `HOME=/tmp/acp-e2e` gives fresh opencode config + DB + ACP state, zero collision with user's real environment
  2. **Scenario-driven**: JSON files define turn-by-turn LLM responses (text or compress tool_use)
  3. **Fake LLM turn tracking**: counts user messages in request to determine current turn
  4. **mNNNNN ref parsing**: fake LLM parses `dcp-message-id` tags from conversation to find compress boundaries
  5. **SSE streaming**: opencode defaults to `stream=true`, must return SSE chunks (learned from awork-web)
  6. **opencode warm-up**: first run triggers DB migration, takes 30-60s

- **Risks**:
  - opencode plugin loading from local path might differ from npm install
  - ACP message transform hooks might add/modify messages in unexpected ways
  - Timing: opencode might be slow to start, needs generous timeouts

- **Rollback strategy**: All new files under `scripts/e2e/` — no changes to existing code. Revert = delete directory.
