import { createCore, defaultCountTokens, type CompressionCore, type CompressionState, type Config } from "acp-kernel"
import type { PluginConfig } from "../config"
import type { WithParts } from "../state"
import { countTokens } from "../token-utils"
import { withPartsToCoreMessages, type CoreMessage } from "./messages"
import { resolveKernelConfig } from "./config"
import { loadKernelState, saveKernelState } from "./state"

// AcpCoreRuntime — the host adapter around acp-kernel, modeled on pai-acp's
// AcpRuntime. Owns a single CompressionCore (created once) plus a per-session
// state cache and an async lock so processTurn never runs concurrently for the
// same session. Not wired into hooks in Phase 1 (see devlog DESIGN.md §5).

export interface AcpCoreRuntime {
    readonly core: CompressionCore
    configFor(plugin: PluginConfig, modelContextLimit: number | undefined): Config
    stateFor(sessionId: string, messages: WithParts[]): Promise<{ state: CompressionState; coreMessages: CoreMessage[] }>
    save(state: CompressionState, sessionId: string): Promise<void>
    acquireLock(sessionId: string): Promise<() => void>
    invalidate(sessionId: string): void
}

interface SessionCache {
    state: CompressionState | null
}

export function createCoreRuntime(): AcpCoreRuntime {
    // Reuse the plugin's BPE tokenizer so kernel token counts match the rest
    // of opencode-acp (logger, token breakdowns, nudge math).
    const core = createCore({ countTokens: countTokens ?? defaultCountTokens })
    const cache = new Map<string, SessionCache>()
    const locks = new Map<string, Promise<void>>()

    async function acquireLock(sessionId: string): Promise<() => void> {
        const prev = locks.get(sessionId) ?? Promise.resolve()
        let release!: () => void
        const next = new Promise<void>((resolve) => {
            release = () => {
                locks.delete(sessionId)
                resolve()
            }
        })
        locks.set(sessionId, prev.then(() => next))
        await prev
        return release
    }

    async function stateFor(sessionId: string, messages: WithParts[]) {
        let session = cache.get(sessionId)
        if (!session) {
            session = { state: null }
            cache.set(sessionId, session)
        }
        if (session.state === null) {
            session.state = await loadKernelState(sessionId)
        }
        return { state: session.state, coreMessages: withPartsToCoreMessages(messages) }
    }

    async function save(state: CompressionState, sessionId: string) {
        const session = cache.get(sessionId)
        if (session) session.state = state
        await saveKernelState(state, sessionId)
    }

    function invalidate(sessionId: string) {
        cache.delete(sessionId)
    }

    return {
        core,
        configFor: resolveKernelConfig,
        stateFor,
        save,
        acquireLock,
        invalidate,
    }
}
