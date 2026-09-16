# DESIGN - Yield to billion-context native mode via action-time env re-check

- Task ID: `2026-09-16_billion-context-native-yield`
- Home Repo: `opencode-acp`
- Created: 2026-09-16
- Status: Accepted

## 1. Problem Statement

- **What problem are we solving?** ACP cannot detect that billion-context owns compression in **native** mode (OpenCode 2.x package plugin): every existing self-disable signal (`BILLION_CONTEXT_PROXY` sampled once at setup; `/bili/` prefix in configured provider baseURL) is statically sampled before/without the native-mode ownership marker ever becoming visible. Result: double compression (#405).
- **Why now?**: billion-context PR #824 (native mode, open) ships a synchronous ownership marker specifically so standalone extensions like ACP can back off — ACP must consume it before that PR merges or the double-compression window goes live.

## 2. Goals & Non-Goals

- **Goals**:
    - Detect both owner markers (`BILLION_CONTEXT_PROXY` launcher, `BILLION_CONTEXT_NATIVE` native) at action time, not just startup.
    - On detection: reuse the existing yield path (deny ACP tools in config hook + no-op all guarded hooks + one-time log); tools additionally throw at execute time.
    - Non-latching: unsetting the marker restores ACP (mirrors existing `/bili/` flag semantics).
    - Zero state-format/API breakage; hot path stays O(1) with no I/O.
- **Non-Goals**:
    - No installer-side reconciliation of third-party plugin entries (billion-context repo scope).
    - No health-probe/port-based proxy discovery.
    - No changes to compression pipeline internals.

## 3. Current Architecture

- **How it works today**:
    ```
    opencode process start
      └─ plugin factory (index.ts)
           ├─ sample process.env.BILLION_CONTEXT_PROXY ONCE → return {} if set   [launcher mode only]
           ├─ register hooks wrapped in guard(disabledByBiliProxy flag)
           └─ config hook: findBiliProxyProviders(baseURL "/bili/") → set flag + deny tools [manual mode only]
    ```
- **Pain points**: both signals are point-in-time samples. Native mode writes its marker later (module evaluation order vs ACP setup) and never touches baseURL → undetectable.

## 4. Proposed Architecture

- **Overview**:
    ```
    every ACP action re-samples env via detectBiliEnvYield():
      setup fast path   : marker set → factory returns {}            (existing pattern, extended to 2 vars)
      guard(hook call)  : marker set → no-op + one-time log          (NEW lazy branch)
      config hook run   : marker set → deny 5 tools, skip wiring     (NEW lazy branch, shared denyAcpTools helper)
      resolveToolContext(): marker set → throw "disabled" error      (NEW; single chokepoint for all 5 tools)
    ```
- **Key components**:
    - `lib/bili-proxy.ts`: `detectBiliEnvYield(env?) → "launcher" | "native" | null` (pure, injectable env), `describeBiliEnvYield(source)`, constants `BILI_PROXY_ENV_VAR` / `BILI_NATIVE_ENV_VAR`. Launcher precedence (native bootstrap refuses to run while the launcher var is set).
    - `index.ts`: closure-level `noteEnvYield()` dedups logging per source per factory instance (guard runs on every LLM request).
    - `lib/compress/types.ts`: `resolveToolContext()` gate — first statement of every tool execute, so one check covers compress/decompress/search_context/acp_status/acp_context_recap without touching the five tool files.
- **Data flow**: no new data structures; `process.env` remains the sole carrier of the cross-plugin contract. Precedence chain when multiple signals are active: any signal yields; for logging/description, `disabledByBiliProxy` (/bili/) branch keeps its own message, env branches use `describeBiliEnvYield`.

## 5. Alternatives Considered

| Option                                                      | Verdict      | Why                                                                                                                                                   |
| ----------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wrap each tool's `execute` in index.ts with a typed wrapper | Rejected     | Requires SDK type gymnastics for 5 tools; `resolveToolContext` gives identical coverage at one existing chokepoint with zero signature changes        |
| Poll a file/port to discover the native proxy               | Rejected     | I/O on hot path, race-prone, and the env marker is the agreed synchronous contract already shipped on the billion-context side                        |
| Latch disable permanently once detected                     | Rejected     | Breaks parity with the existing non-latched `/bili/` semantics (config reload restores ACP); tests assert the restore path                            |
| Check only in the config hook                               | Insufficient | Config runs are discrete events; a tool call between the marker landing and the next config run would still act — hence the `resolveToolContext` gate |

## 6. Backward Compatibility

- Persisted state format: unchanged. Internal `dcp` tags: unchanged. Exported APIs: additive only (new exports in `lib/bili-proxy`). Existing log message for `/bili/` detection: verbatim preserved. Launcher-mode behavior: identical outcome, same log wording family.
