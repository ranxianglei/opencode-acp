# REQ - Self-disable when billion-context proxy is active

- Task ID: `2026-08-23_self-disable-proxy`
- Home Repo: `opencode-acp`
- Created: 2026-08-23
- Status: Done
- Priority: P1
- Owner: bili-agent (qwen3.8-27b)
- References: companion PRs ranxianglei/billion-context-pi#211 (same guard for pi), ranxianglei/billion-context#211 (opencode launcher + thin /acp plugin)

## 1. Background & Problem Statement

- **Context**: `billion-context` (the `bili` proxy) ships a launcher (`bili opencode`) that transparently injects the four ACP tools (compress / decompress / search_context / acp_status) at the wire level and adds its own `/acp` status command via a thin plugin. Users who ALSO have `opencode-acp` installed get both registered at once.
- **Current behavior (symptom)**: duplicate tool registrations (same tool names from two sources) and two competing `/acp` commands; the client-side plugin's panel shadows the proxy's real compression state (0% vs 51k blocks).
- **Expected behavior**: when the bili proxy is driving the session, `opencode-acp` should stand down so a single ACP authority remains.
- **Impact**: any user running `bili opencode` with `opencode-acp` in `~/.config/opencode/opencode.json` `plugin` list.

## 2. Reproduction (if applicable)

- **Environment**:
  - Node: 25.9.0
  - OS/Arch: linux-x64
- **Minimal reproduction steps**:
  1. Install `opencode-acp` (e.g. `"plugin": ["opencode-acp@latest"]`).
  2. Launch `bili opencode`.
  3. Both stacks register ACP tools; `/acp` shows the client plugin's local state instead of the proxy's.
- **Relevant configuration**: `BILLION_CONTEXT_PROXY` env var is always set by the bili launcher (points at the local proxy origin).

## 3. Constraints & Non-Goals

- **Constraints**:
  - Backward compatibility: zero behavior change when `BILLION_CONTEXT_PROXY` is absent (standalone opencode-acp unaffected).
  - No new dependencies.
- **Non-Goals** (explicitly out of scope): any coordination protocol, config flag, or UI affordance — env-var detection only.

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
  - [x] With `BILLION_CONTEXT_PROXY` set, the plugin logs `[opencode-acp] disabled: BILLION_CONTEXT_PROXY detected` and returns an empty object (no tools, no commands).
  - [x] Without the env var, startup is byte-for-byte identical to before.
- **Performance / Stability**: one `process.env` read at startup; no runtime cost after.

## 5. Alternatives Considered

- **Config flag (`disableWhenBili`)**: requires user action; env detection is zero-config and the launcher already guarantees the var.
- **Name-spacing the tools**: rejected upstream — tool names are shared vocabulary with acp-kernel.

## 6. Milestones & Estimates

- Single-commit change; implemented + verified in one pass on 2026-08-23.
