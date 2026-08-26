# REQ - Self-disable in manual proxy mode (detect `/bili/` in provider baseURL)

- Task ID: `2026-08-27_bili-proxy-self-disable`
- Home Repo: `opencode-acp`
- Created: 2026-08-27
- Status: InProgress
- Priority: P1
- Owner: ranxianglei
- References: https://github.com/ranxianglei/opencode-acp/issues/337, prior art PR #335 (`devlog/2026-08-23_self-disable-proxy/`)

## 1. Background & Problem Statement

- **Context**: Since v1.14.25 (PR #335), opencode-acp self-disables when the
  `BILLION_CONTEXT_PROXY` environment variable is set, because the
  billion-context proxy performs its own context compression and running ACP
  on top of it would double-process context. However, that env var is only
  set by the `bili <client>` launcher.
- **Current behavior (symptom)**: In **manual proxy mode** — user runs
  `bili start` and points an opencode provider's `baseURL` at the proxy
  (`http://<proxy-host>:<port>/bili/<upstream-url>`) — ACP stays fully
  active: it injects `mNNNNN` message IDs, appends the ACP system prompt,
  fires nudges, and registers the compress/decompress/acp_status/
  acp_context_recap/search_context tools. The proxy and ACP then both try to
  manage context.
- **Expected behavior**: ACP detects the proxy in the provider config and
  disables itself with the same effect as the env-var guard: no ACP tools in
  the LLM tool list, no system-prompt injection, no message-transform
  pipeline (IDs/nudges/pruning), no `/acp` command.
- **Impact**: Users in manual proxy mode get conflicting context management
  (ACP nudges reference compression tools/state the proxy does not know
  about); the documented zero-config detection signal (`/bili/` in baseURL,
  per billion-context CONFIGURATION.md) is ignored.

## 2. Reproduction (if applicable)

- **Environment**:
  - Node: 22/24
  - OS/Arch: linux
- **Minimal reproduction steps**:
  1) `bili start` (proxy on some port, e.g. 8787)
  2) In opencode config, set a provider
     `options.baseURL = "http://127.0.0.1:8787/bili/https://api.openai.com/v1"`
  3) Start opencode with the opencode-acp plugin (no `BILLION_CONTEXT_PROXY`
     env var)
  4) Observe: ACP system prompt appended, `mNNNNN` IDs injected, ACP tools
     present in the LLM request — ACP did NOT self-disable.
- **Relevant configuration**: provider `options.baseURL` containing the
  `/bili/` path prefix.

## 3. Constraints & Non-Goals

- **Constraints**:
  - Backward compatibility: the `BILLION_CONTEXT_PROXY` env-var guard must
    keep working unchanged (fast path at plugin init). Persisted state
    format and internal `dcp` naming are untouched.
  - Performance: detection runs once per config-hook invocation over the
    provider map (O(providers)); zero added cost per LLM request when no
    proxy is present (one boolean check in each guarded hook).
  - No new dependencies.
- **Non-Goals** (explicitly out of scope):
  - Detecting the proxy by probing the network (e.g. HTTP HEAD to the
    baseURL) — config inspection only.
  - Changing what the billion-context proxy itself does.
  - A user-facing config option to opt out of the disable (if the proxy is
    in the path, ACP must be off; remove the proxy to re-enable).

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
  - [x] When any provider's `baseURL` (under `options`, or defensively at the
    provider top level) contains `/bili/`, the config hook sets
    `permission = "deny"` for all five ACP tools
    (compress, decompress, search_context, acp_status, acp_context_recap).
  - [x] In that case the `/acp` command is not registered and
    `experimental.primary_tools` is not modified.
  - [x] In that case all five ACP hooks (system.transform,
    messages.transform, text.complete, command.execute.before, event) are
    no-ops: messages arrive at the LLM unmodified and no ACP system prompt is
    appended.
  - [x] When no provider routes through the proxy, behavior is identical to
    before (command registered, defaults applied, full pipeline runs).
  - [x] If a later config-hook invocation sees no proxy (config reload),
    ACP behavior is restored (flag is assigned, not latched).
  - [x] Lookalike paths do NOT trigger the disable: `/bilix/`,
    `bilibili.com`, `/bili` without trailing slash, `api.bili.example.com`.
- **Performance / Stability**:
  - [x] No per-request cost beyond a boolean read; no network calls.
- **Regression**:
  - [x] New/modified test cases added to test suite and passing
    (`tests/bili-proxy.test.ts`, `tests/bili-proxy-integration.test.ts`;
    full suite green).

## 5. Proposed Approach (optional)

- **Affected modules & entry files**:
  - `lib/bili-proxy.ts` (new) — pure detection: `findBiliProxyProviders(provider)`
  - `index.ts` — config hook: detect → deny tools → skip wiring → set flag;
    factory-scoped `guard()` wraps the five hooks
  - `tests/bili-proxy.test.ts`, `tests/bili-proxy-integration.test.ts` (new)
- **Risks**:
  - False positive: a non-proxy baseURL that happens to contain `/bili/`
    would disable ACP. Accepted — the marker is the documented proxy path
    prefix; user removes it from the URL to re-enable.
  - The `tool` object on the plugin result is not mutated; disabling relies
    on permission `deny` removing the tools from the LLM tool list. This was
    verified empirically against a live opencode instance (probe run in
    `.opencode/probe/`, see WORKLOG).
- **Rollback strategy**: revert the single commit; no state migration
  involved.
