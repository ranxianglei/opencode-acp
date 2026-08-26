# WORKLOG - Self-disable in manual proxy mode (detect `/bili/` in provider baseURL)

- Task ID: `2026-08-27_bili-proxy-self-disable`
- Home Repo: `opencode-acp`
- Status: InProgress
- Updated: 2026-08-27

## 1. Summary

- **What was done** (1–3 sentences): Added `lib/bili-proxy.ts` (pure
  detection of the `/bili/` proxy marker in provider baseURLs) and wired it
  into the plugin `config` hook in `index.ts`: on detection, all five ACP
  tools are permission-denied (removing them from the LLM tool list), the
  `/acp` command and `primary_tools` wiring are skipped, and a factory-scoped
  flag turns all five ACP hooks into no-ops.
- **Why** (1–3 sentences): Issue #337 — the v1.14.25 self-disable only checks
  `BILLION_CONTEXT_PROXY`, which only the `bili <client>` launcher sets.
  Manual proxy mode (`bili start` + provider `baseURL` at the proxy) left ACP
  fully active on top of a proxy that already compresses context. The
  `/bili/` path prefix in a baseURL is the documented zero-config detection
  signal.
- **Behavior / compatibility changes**: Yes — new: when a provider baseURL
  contains `/bili/`, ACP disables itself (same effect as the env-var guard).
  No change to persisted state format, internal `dcp` naming, or the env-var
  path.
- **Risk level**: Low

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| `52f3356` | feat: self-disable in manual proxy mode (detect `/bili/` in provider baseURL) |

### Key Files

- `lib/bili-proxy.ts` (new) — pure detection: `BILI_PROXY_MARKER = "/bili/"`,
  `findBiliProxyProviders(provider): BiliProxyMatch[]`; reads
  `options.baseURL` (SDK-typed location) with a defensive top-level
  `baseURL` fallback.
- `index.ts` — import; factory-scoped `disabledByBiliProxy` flag + `guard()`
  wrapper around the five hooks; config hook: detect → log → deny five ACP
  tools → early return (skip command/primary_tools/permission defaults/
  host-permission seeding).
- `tests/bili-proxy.test.ts` (new) — 11 unit tests for the detector
  (marker constant, null/non-object input, options vs top-level precedence,
  multi-provider, non-string values, lookalike negatives).
- `tests/bili-proxy-integration.test.ts` (new) — 4 integration tests through
  the real plugin factory (index.ts) with isolated XDG homes and
  `autoUpdate: false`: deny + skip-wiring on detection; all hooks no-op;
  enabled path unchanged (command registered, ID injection runs); re-enable
  after the proxy is removed from config.
- `devlog/2026-08-27_bili-proxy-self-disable/` — REQ / DESIGN / WORKLOG.

## 3. Design & Implementation Notes

- **Entry point / key function**: `findBiliProxyProviders` (lib/bili-proxy.ts)
  called from the `config` hook (index.ts).
- **Key logic explanation**: See DESIGN.md. Detection must live in the
  `config` hook because the plugin factory (`ctx`) does not expose the merged
  opencode config, and awaiting `client.config.get()` inside the factory
  deadlocks (verified empirically — the server is not listening yet). The
  config hook fires before the first LLM request with the full merged
  provider config. Tool removal from the LLM request is achieved via
  `permission: "deny"` (verified against a live opencode 1.14.46 instance:
  denied plugin tools are absent from the captured request's tool list).
- **Flag semantics**: `disabledByBiliProxy` is assigned (not latched) on each
  config-hook invocation so a config reload without the proxy restores ACP.

## 4. Testing & Verification

### Build & Test Commands

```sh
npm run build
npm run typecheck
node --import tsx --test tests/*.test.ts
node --import tsx --test tests/bili-proxy.test.ts tests/bili-proxy-integration.test.ts
```

### Test Coverage

- New/modified test files: `tests/bili-proxy.test.ts`,
  `tests/bili-proxy-integration.test.ts`
- Test count: 1044 total, 1044 pass, 0 fail (15 new: 11 unit + 4 integration)
- Key scenarios verified:
  - `/bili/` in `options.baseURL` → all 5 tools denied, no `/acp` command,
    no `primary_tools` mutation
  - disabled: messages.transform leaves message text byte-identical
    (no ID injection), system.transform appends nothing, text.complete is a
    no-op, event hook resolves
  - no proxy: `/acp` command registered, `compress: "allow"` default applied,
    `dcp-message-id` injection runs (real pipeline)
  - proxy removed in a later config invocation → ACP behavior restored
  - lookalikes rejected: `/bilix/`, `bilibili.com`, `/bili` (no slash),
    `api.bili.example.com`

### Results

- **PASS/FAIL**: PASS — typecheck clean, build clean, 1044/1044 tests pass.
- **Key logs/data**: live-opencode probe (`.opencode/probe/`, gitignored):
  config hook receives merged provider config before first LLM request;
  permission-deny removes plugin tools from the request; factory-time
  `client.config.get()` await deadlocks.

## 5. Risk Assessment & Rollback

- **Risk points**:
  - False positive on a non-proxy URL containing `/bili/` → ACP disabled
    until the URL changes. Accepted, documented in REQ §3/DESIGN §4.
  - `format:check` fails on ~413 pre-existing files in this environment
    (prettier 3.9.5 vs the repo's 3.8.x formatting baseline); files touched
    by this change were formatted with the installed prettier. CI does not
    run format:check.
- **Rollback method**:
  - Revert commit(s): `52f3356`
  - Rollback impact: none — additive module + index.ts wiring; no state
    migration.
- **Compatibility notes** (data format, config schema): No changes.

## 6. Lessons Learned (optional)

- The plugin `config` hook is the only reliable, non-deadlocking point to
  read the merged opencode config (provider baseURLs included) — factory-time
  client awaits deadlock because the server starts listening after the
  factory resolves.
- Permission `deny` is a verified lever for removing plugin-registered tools
  from the LLM tool list without mutating the plugin result object late.

## 7. Follow-ups (optional)

- [ ] Consider a config option to override the disable (REQ non-goal for now)
- [ ] Docker E2E scenario for the nudge→compress flow is unaffected; no
      nudge/growth logic changed (§5.7 not triggered)
