/**
 * [FIX #312] Catalog of per-model context limits, keyed `${providerID}/${modelID}`.
 *
 * Within one LLM request the host fires experimental.chat.messages.transform
 * BEFORE experimental.chat.system.transform (sst/opencode: session/prompt.ts
 * triggers messages.transform, then llm/request.ts triggers system.transform
 * during handle.process). state.modelContextLimit is written only by the
 * system hook, so on the first request after a model switch every percentage
 * threshold (emergencyThresholdPercent, min/maxContextLimit "%", adaptive
 * nudge growth, GC tiers) is still computed against the PREVIOUS model's
 * limit. This catalog lets the messages hook reconcile against the model
 * named on the request's user message instead of waiting one turn.
 *
 * Entries are recorded live by the system hook every request and seeded once
 * at plugin init from the host's /config/providers catalog.
 *
 * Standalone factory (not embedded in SessionStateRegistry) so the test
 * registry stub can compose the SAME implementation instead of hand-rolling
 * a drift-prone copy.
 */
export interface ModelLimitCatalog {
    record(
        providerId: string | undefined,
        modelId: string | undefined,
        limit: number | undefined,
    ): void
    resolve(providerId: string | undefined, modelId: string | undefined): number | undefined
    hydrateFromClient(client: unknown): Promise<number>
}

export function createModelLimitCatalog(): ModelLimitCatalog {
    const modelLimits = new Map<string, number>()
    return {
        record(providerId, modelId, limit) {
            if (!providerId || !modelId || typeof limit !== "number" || limit <= 0) return
            modelLimits.set(`${providerId}/${modelId}`, limit)
        },
        resolve(providerId, modelId) {
            if (!providerId || !modelId) return undefined
            return modelLimits.get(`${providerId}/${modelId}`)
        },
        /**
         * Best-effort one-time seed from the host's provider catalog
         * (`client.config.providers()` → GET /config/providers). Never throws;
         * returns the number of model-limit entries recorded.
         */
        async hydrateFromClient(client: unknown): Promise<number> {
            try {
                const config = client as {
                    config?: { providers?: () => Promise<{ data?: unknown }> }
                }
                const result = await config.config?.providers?.()
                const payload = result as { data?: { providers?: unknown } } | undefined
                const providers = payload?.data?.providers
                if (!Array.isArray(providers)) return 0
                let recorded = 0
                for (const provider of providers) {
                    const { id, models } = (provider ?? {}) as {
                        id?: unknown
                        models?: Record<string, unknown>
                    }
                    if (typeof id !== "string" || !models) continue
                    for (const [modelId, model] of Object.entries(models)) {
                        const limit = (model as { limit?: { context?: unknown } } | null)?.limit
                        const context = limit?.context
                        if (typeof context === "number" && context > 0) {
                            modelLimits.set(`${id}/${modelId}`, context)
                            recorded++
                        }
                    }
                }
                return recorded
            } catch {
                return 0
            }
        },
    }
}
