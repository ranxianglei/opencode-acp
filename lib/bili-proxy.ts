/**
 * Billion-context (`bili`) proxy detection in opencode provider config.
 *
 * Manual proxy mode (`bili start` + a provider whose baseURL is pointed at
 * the proxy) does NOT set `BILLION_CONTEXT_PROXY` — that env var is only set
 * by the `bili <client>` launcher. The `/bili/` path prefix in a provider
 * baseURL is the documented zero-config self-detection signal (billion-context
 * CONFIGURATION.md): `http://<proxy-host>:<port>/bili/<upstream-url>`.
 *
 * When a provider routes through the proxy, the proxy handles context
 * compression itself, so ACP must disable itself (same behavior as the
 * `BILLION_CONTEXT_PROXY` env-var guard in index.ts).
 */

export const BILI_PROXY_MARKER = "/bili/"

export interface BiliProxyMatch {
    provider: string
    baseURL: string
}

function extractBaseURL(entry: unknown): string | undefined {
    if (!entry || typeof entry !== "object") return undefined
    const record = entry as Record<string, unknown>
    const options = record.options
    if (options && typeof options === "object") {
        const optionBaseURL = (options as Record<string, unknown>).baseURL
        if (typeof optionBaseURL === "string" && optionBaseURL.length > 0) {
            return optionBaseURL
        }
    }
    // Defensive fallback: some configs place baseURL at the provider top
    // level rather than under `options`.
    const topLevelBaseURL = record.baseURL
    if (typeof topLevelBaseURL === "string" && topLevelBaseURL.length > 0) {
        return topLevelBaseURL
    }
    return undefined
}

/**
 * Scan opencode's provider config for every provider whose baseURL routes
 * through the bili proxy (contains the `/bili/` path prefix).
 *
 * Pure function — safe to unit test. Returns `[]` for null/undefined/non-object
 * input and for providers without a string baseURL.
 */
export function findBiliProxyProviders(provider: unknown): BiliProxyMatch[] {
    if (!provider || typeof provider !== "object") return []
    const matches: BiliProxyMatch[] = []
    for (const [name, entry] of Object.entries(provider as Record<string, unknown>)) {
        const baseURL = extractBaseURL(entry)
        if (baseURL !== undefined && baseURL.includes(BILI_PROXY_MARKER)) {
            matches.push({ provider: name, baseURL })
        }
    }
    return matches
}

/**
 * [FIX #405] Process-env ownership markers left by billion-context.
 *
 * Two owner modes are invisible to the provider-config signal above:
 *
 * - Launcher mode (`bili <client>`): sets `BILLION_CONTEXT_PROXY` for the
 *   launched child process. ACP's setup-time sample catches it only if the
 *   variable already exists when the plugin factory runs — re-sampling env at
 *   action time removes that timing assumption entirely.
 *
 * - Native mode (billion-context opencode-native plugin, #820/#824): the
 *   plugin replaces model-API requests at `http.request` time, so the
 *   configured provider baseURL never contains `/bili/`, and
 *   `BILLION_CONTEXT_PROXY` is written only after the async proxy bootstrap.
 *   The native entry marks ownership synchronously at module evaluation
 *   (`markNativeHost()`, first-writer-wins) — but that evaluation can still
 *   land AFTER ACP's setup sampled env, depending on plugin load order.
 *
 * Consumers must therefore sample env at ACTION time (hook invocations,
 * config runs, tool calls) and never trust a startup snapshot.
 */
export const BILI_PROXY_ENV_VAR = "BILLION_CONTEXT_PROXY"
export const BILI_NATIVE_ENV_VAR = "BILLION_CONTEXT_NATIVE"

export type BiliEnvYield = "launcher" | "native"

/**
 * Detect a billion-context ownership marker in the given environment
 * (defaults to `process.env`). Pure — safe to unit test.
 *
 * Returns `"launcher"` when `BILLION_CONTEXT_PROXY` is set (takes precedence —
 * native bootstrap refuses to run while it is set, so both cannot normally
 * coexist), `"native"` when only `BILLION_CONTEXT_NATIVE` is set, else `null`.
 */
export function detectBiliEnvYield(env: Record<string, string | undefined> = process.env): BiliEnvYield | null {
    if (env[BILI_PROXY_ENV_VAR]) return "launcher"
    if (env[BILI_NATIVE_ENV_VAR]) return "native"
    return null
}

/** Human-readable ownership source for logs and error messages. */
export function describeBiliEnvYield(source: BiliEnvYield): string {
    return source === "native"
        ? "BILLION_CONTEXT_NATIVE set (billion-context native mode)"
        : "BILLION_CONTEXT_PROXY set (billion-context launcher mode)"
}
