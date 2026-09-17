import type { Message as AiMessageValue, SystemPart } from "@opencode/ai"
import { SystemPart as SystemPartSchema } from "@opencode/ai"
import type { PluginConfig } from "../config"
import { compressPermission } from "../compress-permission"
import { buildProtectedToolsExtension } from "../prompts/extensions/system"
import { renderSystemPrompt, type PromptStore } from "../prompts"
import { commitPreparedMessageTransformState, prepareMessageTransformTransaction } from "../hooks"
import type { HostPermissionRule, HostPermissionSnapshot } from "../host-permissions"
import type { SessionState, SessionStateRegistry } from "../state"
import type { Logger } from "../logger"
import { countTokens } from "../token-utils"
import { saveSessionState } from "../state/persistence"
import { DeferredMutationEffects } from "../state/transaction"
import type { V2HostAdapter } from "./host"
import {
    applyV2ContextPatch,
    normalizeV2ProjectedHistory,
    restoreMissingV2OpaqueSources,
    type V2ProjectionModel,
} from "./projection"
import { isAcpOwnedNoticeId } from "./projection/shared"

export interface V2ContextEvent {
    readonly sessionID: string
    readonly agent: string
    readonly model: V2ProjectionModel
    system: SystemPart[]
    messages: AiMessageValue[]
}

interface PreparedV2ContextCommit {
    prepared: Awaited<ReturnType<typeof prepareMessageTransformTransaction>>
    messages: AiMessageValue[]
    systemPart?: SystemPart
}

function modelLimitFromInventory(
    inventory: readonly { providerId: string; modelId: string; contextLimit?: number }[],
    model: V2ProjectionModel,
): number | undefined {
    const limit = inventory.find(
        (entry) => entry.providerId === model.providerID && entry.modelId === model.id,
    )?.contextLimit
    return typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? limit : undefined
}

const AUXILIARY_AGENT_NAMES = new Set(["title", "summary", "compaction"])

async function fetchV2AgentPermissions(
    host: V2HostAdapter,
    agent: string,
    logger: Logger,
): Promise<readonly HostPermissionRule[] | undefined> {
    if (!host.agentPermissions) return undefined

    let rules: readonly HostPermissionRule[]
    try {
        rules = await host.agentPermissions(agent)
    } catch (error) {
        logger.warn("V2 agent permission lookup failed closed", {
            agent,
            error: error instanceof Error ? error.message : String(error),
        })
        rules = [{ action: "*", resource: "*", effect: "deny" }]
    }
    return rules
}

/**
 * Build the primary V2 context hook. The callback deliberately owns one
 * registry guard for the complete operation; system rendering happens inside
 * that operation and never calls the V1 system hook or acquires a second lock.
 */
export function createV2ContextHandler(
    host: V2HostAdapter,
    registry: SessionStateRegistry,
    logger: Logger,
    config: PluginConfig,
    prompts: PromptStore,
    hostPermissions: HostPermissionSnapshot,
    isActive: () => boolean = () => true,
): (event: V2ContextEvent) => Promise<void> {
    return async (event) => {
        try {
            if (!Array.isArray(event.messages) || !Array.isArray(event.system)) return
            if (AUXILIARY_AGENT_NAMES.has(event.agent)) return
            if (!isActive()) return
            // Fetch first, then perform the lifecycle check before touching the
            // shared permission snapshot.  A setup unload can complete while a
            // public host call is awaiting; late results must not hydrate a
            // dead plugin instance.
            const agentRules = await fetchV2AgentPermissions(host, event.agent, logger)
            if (!isActive()) return
            if (agentRules) {
                hostPermissions.v2Agents = {
                    ...(hostPermissions.v2Agents ?? {}),
                    [event.agent]: agentRules,
                }
            }

            let requestModelLimit: number | undefined
            let modelLimitKnown = false
            let inventory: readonly {
                providerId: string
                modelId: string
                contextLimit?: number
            }[] = []
            try {
                inventory = await host.models.list()
            } catch (error) {
                logger.warn("V2 model catalog lookup failed", {
                    sessionId: event.sessionID,
                    model: `${event.model.providerID}/${event.model.id}`,
                    error: error instanceof Error ? error.message : String(error),
                })
            }
            // Catalog results are already in memory.  Check lifecycle before
            // synchronously recording them; unlike the old async hydrator this
            // cannot mutate the catalog after unload.
            if (!isActive()) return
            for (const entry of inventory) {
                registry.recordModelLimit(entry.providerId, entry.modelId, entry.contextLimit)
            }

            // Resolve after recording so a transient catalog omission/failure
            // cannot discard a valid cached limit. A direct inventory fallback
            // is retained for lightweight registries used by tests.
            requestModelLimit = registry.resolveModelLimit(event.model.providerID, event.model.id)
            requestModelLimit ??= modelLimitFromInventory(inventory, event.model)
            modelLimitKnown = requestModelLimit !== undefined

            const loadProjection = async () => {
                // The registry reservation is installed before this callback is
                // invoked. Reading projected history outside that reservation
                // would allow an older snapshot to commit after a newer request.
                const projected = await host.projectedContext(event.sessionID)
                const projection = normalizeV2ProjectedHistory(projected, event.messages, {
                    sessionID: event.sessionID,
                    agent: event.agent,
                    directory: host.directory,
                    currentModel: event.model,
                })
                if (!projection.valid) {
                    logger.warn("V2 context projection rejected", {
                        sessionId: event.sessionID,
                        reason: projection.rejection?.message,
                    })
                }
                return projection
            }

            const effects = new DeferredMutationEffects()

            const run = async (
                state: SessionState,
                projection: Awaited<ReturnType<typeof loadProjection>>,
            ): Promise<PreparedV2ContextCommit | undefined> => {
                if (!projection.valid || !isActive()) return undefined
                // [FIX #421] Measure current-wire system overhead BEFORE the
                // transform: host system parts plus ACP's rendered system
                // prompt (pushed to event.system only at commit, below). The
                // floor keeps the first request after native compaction/reload
                // from calibrating against stale pre-compaction usage anchors.
                // Flags are re-evaluated against workingState at commit; a
                // mid-transform flip skews this estimate by at most one prompt
                // render, which is acceptable for a budget floor.
                let measuredSystemPrompt: string | undefined
                if (
                    !(state.isSubAgent && !config.allowSubAgents) &&
                    compressPermission(state, config) !== "deny"
                ) {
                    measuredSystemPrompt = renderSystemPrompt(
                        prompts.getRuntimePrompts(),
                        buildProtectedToolsExtension(config.compress.protectedTools),
                        state.isSubAgent && config.allowSubAgents,
                    )
                }
                const measuredSystemTokens =
                    event.system.reduce((sum, part) => sum + countTokens(part.text), 0) +
                    (measuredSystemPrompt ? countTokens(measuredSystemPrompt) : 0)
                const prepared = await prepareMessageTransformTransaction(
                    projection.messages,
                    state,
                    config,
                    logger,
                    prompts,
                    hostPermissions,
                    requestModelLimit,
                    modelLimitKnown,
                    (text) =>
                        host.notifications.notify({
                            title: "ACP: Nudge Injected",
                            message: text,
                            variant: "info",
                            duration: 5000,
                        }),
                    true,
                    effects,
                    measuredSystemTokens,
                )
                // A non-resuming command notice remains in projected session
                // history for the user, but must be removed from every later
                // provider request. The patcher then removes only this
                // ACP-owned source message from the original V2 messages.
                prepared.workingMessages = prepared.workingMessages.filter(
                    (message) =>
                        !isAcpOwnedNoticeId(
                            typeof message.info.id === "string" ? message.info.id : undefined,
                        ),
                )
                const opaqueRestoration = restoreMissingV2OpaqueSources(
                    projection,
                    prepared.workingMessages,
                )
                if (!opaqueRestoration.accepted) {
                    logger.warn(
                        "V2 opaque source restoration rejected; preserving provider request",
                        {
                            sessionId: event.sessionID,
                            reason: opaqueRestoration.reason,
                        },
                    )
                    return undefined
                }
                prepared.workingMessages = opaqueRestoration.messages
                const patch = applyV2ContextPatch(
                    projection,
                    prepared.workingMessages,
                    event.messages,
                )
                if (!patch.accepted) {
                    logger.warn("V2 context patch rejected; preserving provider request", {
                        sessionId: event.sessionID,
                        reason: patch.rejection.message,
                    })
                    return undefined
                }

                if (!isActive()) return undefined

                let systemPrompt: string | undefined
                if (
                    !(prepared.workingState.isSubAgent && !config.allowSubAgents) &&
                    compressPermission(prepared.workingState, config) !== "deny"
                ) {
                    systemPrompt = renderSystemPrompt(
                        prompts.getRuntimePrompts(),
                        buildProtectedToolsExtension(config.compress.protectedTools),
                        prepared.workingState.isSubAgent && config.allowSubAgents,
                    )
                }

                // Build event values before the synchronous accepted boundary;
                // initialization and transform effects stay staged until the
                // registry accepts this result.
                const systemPart = systemPrompt ? SystemPartSchema.make(systemPrompt) : undefined
                return { prepared, messages: patch.messages, systemPart }
            }

            const flushEffects = async (state: SessionState): Promise<void> => {
                if (effects.persistenceRequested) {
                    if (!isActive()) return
                    try {
                        await saveSessionState(state, logger)
                    } catch (error) {
                        logger.warn("Failed to persist V2 context state", {
                            sessionId: event.sessionID,
                            error: error instanceof Error ? error.message : String(error),
                        })
                    }
                }
                if (!isActive()) return
                try {
                    await effects.run(isActive)
                } catch (error) {
                    logger.warn("Deferred V2 context effect failed", {
                        sessionId: event.sessionID,
                        error: error instanceof Error ? error.message : String(error),
                    })
                }
            }

            // Reserve before projected history is fetched/normalized, then keep
            // initialization, transformation, patch validation, and commit in
            // that one reservation.
            if (registry.withSessionMutationAndInitialize) {
                const committed = await registry.withSessionMutationAndInitialize(
                    host.sessions,
                    event.sessionID,
                    loadProjection,
                    (projection) =>
                        isActive() && projection.valid ? projection.messages : undefined,
                    config,
                    run,
                    {
                        effects,
                        isActive,
                        commitResult: (result) => result !== undefined,
                        commit: (_state, result) => {
                            if (!result) throw new Error("V2 context commit has no result")
                            const originalMessages = event.messages
                            const originalMessageValues = [...event.messages]
                            const originalSystemValues = [...event.system]
                            try {
                                if (
                                    !commitPreparedMessageTransformState(
                                        result.prepared,
                                        _state,
                                        undefined,
                                    )
                                ) {
                                    throw new Error("V2 context commit became inactive")
                                }
                                event.messages = result.messages
                                if (result.systemPart) event.system.push(result.systemPart)
                            } catch (error) {
                                // The registry restores live ACP state when a
                                // synchronous commit throws.  Restore the
                                // externally visible event as well so a
                                // partially applied message/system commit can
                                // never escape to the host.
                                try {
                                    event.messages = originalMessages
                                } catch {}
                                try {
                                    originalMessages.splice(
                                        0,
                                        originalMessages.length,
                                        ...originalMessageValues,
                                    )
                                } catch {}
                                try {
                                    event.system.splice(
                                        0,
                                        event.system.length,
                                        ...originalSystemValues,
                                    )
                                } catch {}
                                throw error
                            }
                        },
                        postCommit: flushEffects,
                    },
                )
                if (committed === undefined) return
            } else {
                // Compatibility for lightweight registry doubles from older
                // V2 fixtures. Real registries always use the atomic path.
                const projection = await loadProjection()
                if (!projection.valid || !isActive()) return
                await registry.getOrCreate(
                    host.sessions,
                    event.sessionID,
                    projection.messages,
                    config,
                )
                const state = registry.get(event.sessionID)
                if (state) {
                    const result = await run(state, projection)
                    if (result === undefined || !isActive()) return
                    if (!commitPreparedMessageTransformState(result.prepared, state, undefined))
                        return
                    event.messages = result.messages
                    if (result.systemPart) event.system.push(result.systemPart)
                    await flushEffects(state)
                }
            }
        } catch (error) {
            logger.warn("V2 context hook failed closed", {
                sessionId: event.sessionID,
                error: error instanceof Error ? error.message : String(error),
            })
        }
    }
}
