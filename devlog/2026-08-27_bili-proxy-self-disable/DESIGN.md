# DESIGN - Self-disable in manual proxy mode

- Task ID: `2026-08-27_bili-proxy-self-disable`
- Home Repo: `opencode-acp`
- Created: 2026-08-27
- Status: InProgress

## 1. Problem

The v1.14.25 self-disable (PR #335) only checks `process.env.BILLION_CONTEXT_PROXY`
at plugin-factory time. That variable is set exclusively by the `bili <client>`
launcher. Manual proxy mode (`bili start` + provider `baseURL` pointed at the
proxy) leaves it unset, so ACP stays active on top of a proxy that already
manages context.

## 2. Where the provider config is observable

Empirically verified against a live opencode 1.14.46 instance (probe harness in
`.opencode/probe/`, logs `run*.log` / `fakellm.log`):

1. **The plugin factory (`ctx`) does NOT expose the merged opencode config.**
   `PluginInput` is `{ client, project, directory, worktree, experimental_workspace,
   serverUrl, $ }`. Awaiting `ctx.client.config.get()` *inside* the factory
   **deadlocks** (the HTTP server is not listening yet; the factory promise is
   awaited before listen). Fire-and-forget succeeds ~30ms after the factory
   returns — this is why `registry.hydrateModelLimitsFromClient` is already
   fire-and-forget (index.ts).
2. **The `config` hook** (`Hooks.config?: (input: Config) => Promise<void>`)
   fires after the factory returns and **before the first LLM request**, and
   receives the full merged `Config` including
   `provider[name].options.baseURL`.
3. **Setting `permission.<tool> = "deny"` for a plugin-registered tool in the
   config hook removes that tool from the LLM's tool list** (captured request
   no longer contained the probe tool). This is the verified lever for
   tool-level disable.

Therefore detection must happen in the `config` hook, not in the factory.

## 3. Design

### 3.1 Detection — `lib/bili-proxy.ts` (new, pure)

```ts
export const BILI_PROXY_MARKER = "/bili/"
export interface BiliProxyMatch { provider: string; baseURL: string }
export function findBiliProxyProviders(provider: unknown): BiliProxyMatch[]
```

- Scans every entry of the (possibly undefined) provider map.
- Reads `options.baseURL` (the SDK-typed location); falls back to a top-level
  `baseURL` defensively in case the config shape drifts.
- Case-sensitive substring match on `/bili/`. Deliberately conservative: any
  provider whose path contains the marker triggers the disable (sessions can
  switch providers mid-run, so checking only the "default" model's provider
  would miss switches). Lookalikes (`/bilix/`, `bilibili.com`, bare `/bili`)
  do not match.
- Pure function of its input → trivially unit-testable, no SDK imports.

### 3.2 Disable wiring — `index.ts`

Factory scope gains:

```ts
let disabledByBiliProxy = false
const guard =
    <TArgs extends unknown[]>(fn: (...args: TArgs) => Promise<void>) =>
    (...args: TArgs): Promise<void> =>
        disabledByBiliProxy ? Promise.resolve() : fn(...args)
```

- All five hooks (`experimental.chat.system.transform`,
  `experimental.chat.messages.transform`, `experimental.text.complete`,
  `command.execute.before`, `event`) are wrapped in `guard(...)`. The creators
  in `lib/hooks.ts` are untouched — no signature changes, no new parameters
  flowing through the hook pipeline.
- The `config` hook, at its top:
  1. `const biliMatches = findBiliProxyProviders(opencodeConfig.provider)`
  2. `disabledByBiliProxy = biliMatches.length > 0` — **assigned, not
     latched**, so a config reload without the proxy restores ACP (the flag
     and the permission/config mutations are both re-derived per invocation).
  3. If matches: log
     `[opencode-acp] disabled: /bili/ proxy detected in provider baseURL (<names>) — proxy handles compression`
     (console.log, mirroring the env-var guard's user-visible style), set
     `permission` deny for all five ACP tools (same `as typeof permission`
     cast pattern as the existing default-permission block), and **return
     early** — skipping `/acp` command registration, `primary_tools` wiring,
     default-permission application, and host-permission seeding (all
     meaningless while disabled).

### 3.3 What is NOT done (and why)

- **The `tool` object on the plugin result is not mutated.** It is built at
  factory time, before the config hook runs. Removal from the LLM tool list is
  achieved by the permission `deny` (verified in §2.3). Mutating the returned
  hooks object late is unverified behavior and unnecessary.
- **No network probing** of the baseURL — config inspection only (see REQ
  non-goals).
- **Factory-time side effects are left as-is** (`startAutoUpdate`,
  `hydrateModelLimitsFromClient`, `configureClientAuth`): they run before the
  config hook can detect the proxy, but none of them activate ACP behavior
  (no tools, transforms, prompts, or commands), so they are harmless.
- **The env-var guard is unchanged** and remains the fast path (checked before
  any object allocation at factory time).

### 3.4 State / compatibility impact

- No `SessionState` / persisted-format change.
- No internal `dcp` tag/naming change.
- No `package.json` version change (feature branch; release handled separately).

## 4. Failure modes

| Scenario | Behavior |
|----------|----------|
| Proxy in one of several providers | Disable triggers (conservative) |
| `/bili/` appears in a non-proxy URL | ACP disabled; user removes the marker to re-enable (documented trade-off) |
| Config reload removes the proxy | Flag flips back; next config hook re-applies defaults; hooks resume |
| `BILLION_CONTEXT_PROXY` also set | Env-var guard wins at factory time; config hook never registered — same outcome |
| `config.enabled: false` | Unchanged early return before any of this |
