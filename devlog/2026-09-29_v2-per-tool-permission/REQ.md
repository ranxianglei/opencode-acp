# REQ - V2 per-tool permission resolution

- Task ID: `2026-09-29_v2-per-tool-permission`
- Home Repo: `opencode-acp`
- Created: 2026-09-29
- Status: InProgress
- Priority: P1
- Owner: ranxianglei
- References: https://github.com/ranxianglei/opencode-acp/issues/459

## 1. Background & Problem Statement

- **Context**: On the V2 line the five ACP tools (`compress`, `decompress`,
  `search_context`, `acp_status`, `acp_context_recap`) are registered as direct
  model tools. Host permission rules (OpenCode V2 agent permissions) are ordered
  `{action, resource, effect}` entries where `action` is matched against the
  real tool name in the host's evaluate pipeline.
- **Current behavior (symptom)**: The internal resolver hard-codes the literal
  `"compress"` — `resolveEffectiveCompressPermission()` calls
  `resolveV2Permission(v2Rules, "compress")` regardless of which tool is being
  executed, and every tool declares `options.permission: "compress"`. All five
  tools therefore share one permission decision. A granular ruleset like
  `[{action:"compress",effect:"ask"},{action:"*",effect:"deny"}]` silences four
  read-only tools with a generic refusal while `compress` itself is never
  actually asked; the reverse ruleset denies all five tools.
- **Expected behavior**: Each tool resolves its own decision from the host
  ruleset using its real tool name (OpenCode's ordered last-match semantics).
  Refusal messages and result metadata name the actual tool.
- **Impact**: MAJOR — per-tool permission control does not exist on V2; silent
  misbehavior visible to users only as generic refusals.

## 2. Reproduction (if applicable)

- **Environment**: OpenCode V2 (>=2.0.3), agent permission rules in opencode.json.
- **Minimal reproduction steps**:
  1) Set agent rules `[{action:"compress",effect:"ask"}]`.
  2) Call `acp_status` (or any of the other four tools).
  3) Observed: refusal message about "the `compress` permission" even though no
     rule targets `acp_status`. Expected: normal execution.
- **Relevant configuration**: ACP `compress.permission` left at default `allow`;
  behavior driven purely by host rules.

## 3. Constraints & Non-Goals

- **Constraints**:
  - Backward compatibility: for `compress` itself, refusal message text must stay
    byte-identical; V1 permission path untouched; `state.compressPermission`
    nudge-gating semantics unchanged (still compress-specific by design);
    OpenCode's ordered last-match rule semantics preserved (not redefined);
    fail-closed `ask` on V2 preserved (OpenCode 2.0.3 exposes no native
    permission-request creation API to server plugins — DESIGN §8.1).
  - Performance requirements: none (one string comparison per tool call).
- **Non-Goals** (explicitly out of scope):
  - Routing `ask` to an interactive prompt (host capability does not exist in
    this runtime).
  - Changing what ACP's own `compress.permission` config key gates (it remains a
    global gate over ACP tools).
  - V1 per-tool permission behavior.

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
  - [x] A rule targeting `compress` (deny or ask) does not affect
    `decompress` / `search_context` / `acp_status` / `acp_context_recap`.
  - [x] A rule targeting any non-compress tool does not affect `compress`.
  - [x] `options.permission` declared per tool equals the real tool name.
  - [x] Deny/ask result metadata carries the real tool name; messages name it.
  - [x] Ordered last-match semantics preserved (later matching rule wins).
  - [x] Pre-state-acquisition safety preserved (no mutation on deny/ask paths).
- **Performance / Stability**:
  - [x] Full test suite + typecheck + build pass on Node 22/24.
