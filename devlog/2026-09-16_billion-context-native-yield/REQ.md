# REQ - Yield to billion-context native mode via action-time env re-check

- Task ID: `2026-09-16_billion-context-native-yield`
- Home Repo: `opencode-acp`
- Created: 2026-09-16
- Status: InProgress
- Priority: P1
- Owner: ranxianglei (agent: ework-daemon)
- References: https://github.com/ranxianglei/opencode-acp/issues/405 · source analysis: ranxianglei/billion-context#820 · marker provided by ranxianglei/billion-context PR #824

## 1. Background & Problem Statement

- **Context**: billion-context adds an OpenCode 2.x host-native mode (`opencode-native`, PR #824): a package-installed plugin bootstraps its own proxy and replaces model-API requests at `http.request` time (new Request object pointing at `<proxy>/bili/<url>`; `Request.url` is readonly, #810). If opencode-acp is loaded alongside it, both compress → violates the single-compression-owner principle.
- **Current behavior (symptom)**: ACP's self-disable signals are all sampled statically at setup/config time:
    1. `index.ts` setup check reads `BILLION_CONTEXT_PROXY` once — in native mode that var is written only AFTER async proxy bootstrap, so setup misses it.
    2. The config hook / `lib/bili-proxy.ts` rely on `/bili/` in provider `baseURL` — native mode never touches configured baseURL, so the signal is invisible.
    - Result: launcher mode and manual-wiring mode yield correctly; **native mode has no detectable signal at all** → double compression for users with both plugins installed.
- **Expected behavior**: ACP yields (deny tools + no-op hooks + one-time log) whenever billion-context owns compression in this process, regardless of when the ownership marker appears relative to ACP setup.
- **Impact**: Users with `opencode-acp` + `<configDir>/plugins/billion-context` installed get double compression in native mode until the billion-context installer reconciles third-party entries (`bili plugin install opencode` does not currently remove the opencode-acp entry) — this fix is the safety net.

## 2. Reproduction (if applicable)

- **Environment**: any host with opencode 2.x + ACP plugin + billion-context native plugin installed simultaneously.
- **Minimal reproduction steps**:
    1. Install both plugins so both load in one opencode process.
    2. Start opencode directly (no `bili` launcher).
    3. Observe: ACP stays fully active while the native plugin also compresses via the proxy.
- **Relevant configuration**: none specific — failure is structural (signal timing), independent of ACP config values.

## 3. Constraints & Non-Goals

- **Constraints**:
    - Backward compatibility: persisted state format, internal `dcp` tags, exported APIs unchanged. Existing launcher/manual-mode yield behavior must be byte-for-byte preserved (existing tests green).
    - Performance requirements: env reads are O(1); guard runs on every LLM request — no new I/O, no log spam (one-time log per source per factory instance).
    - Marker contract (billion-context side, verified on branch `2026-09-15_opencode-native-plugin`): `markNativeHost()` sets `process.env.BILLION_CONTEXT_NATIVE = "opencode"` synchronously at module evaluation, first-writer-wins, gated by `nativeBootstrapGate`.
- **Non-Goals** (explicitly out of scope):
    - Changing the billion-context installer to remove third-party plugin entries (their repo's problem).
    - Detecting the proxy by probing ports/health endpoints (env marker is the agreed synchronous contract).
    - Any state-persistence changes.

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
    - [x] `detectBiliEnvYield(env?)` pure function returns `"launcher"` / `"native"` / `null` with launcher precedence; unit-tested.
    - [x] Setup-time fast path: either marker set before factory run → factory returns `{}` (no hooks/tools), one-time log.
    - [x] Marker set AFTER factory run (the #405 race): next config run denies all 5 ACP tools and skips command/primary_tools wiring; all guarded hooks (system/messages/text.complete/command/event) become no-ops.
    - [x] Tool execute gate: with either marker set, every ACP tool's execute throws a clear "disabled" error (shared `resolveToolContext` chokepoint covers all five tools).
    - [x] `BILLION_CONTEXT_PROXY` is re-read at action time too (launcher marker landing late yields identically).
    - [x] Re-enable: unsetting the marker restores full ACP behavior (config wiring + ID injection + tool gate passes).
    - [x] Exactly one yield log line per source per factory instance across repeated hook invocations.
    - [x] Pre-existing `bili-proxy-integration.test.ts` (manual `/bili/` mode) still passes unchanged.
- **Performance / Stability**:
    - [x] No new I/O on the hot path; `npm run typecheck`, `npm test`, `npm run build` all pass.
