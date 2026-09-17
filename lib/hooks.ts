import type { SessionState, WithParts } from "./state"
import type { Logger } from "./logger"
import type { PluginConfig } from "./config"
import type { HostServices } from "./host"
import { resolveHostServices } from "./host/legacy"
import { stripHallucinationsFromString } from "./messages"
import { renderSystemPrompt, type PromptStore } from "./prompts"
import { buildProtectedToolsExtension } from "./prompts/extensions/system"
import {
    applyPendingCompressionDurations,
    buildCompressionTimingKey,
    resolveCompressionDuration,
} from "./compress/timing"
import { filterMessagesInPlace } from "./messages/shape"
import { getLastUserMessage } from "./messages/query"
import { dispatchAcpCommand } from "./commands"
import { type HostPermissionSnapshot } from "./host-permissions"
import { compressPermission, syncCompressPermissionState } from "./compress-permission"
import { ensureBuiltinFiltersRegistered } from "./messages/filter/builtin"
import {
    createSessionState,
    cloneSessionState,
    commitSessionState,
    saveSessionState,
    type SessionStateRegistry,
} from "./state"
import { DeferredMutationEffects } from "./state/transaction"
import { runMessageTransform } from "./messages/transform"

const INTERNAL_AGENT_SIGNATURES = [
    "You are a title generator",
    "You are a helpful AI assistant tasked with summarizing conversations",
    "You are an anchored context summarization assistant for coding sessions",
    "Summarize what was done in this conversation",
]

// [FIX Bug 37] OpenCode built-in hidden primary-mode agents that must NOT be
// run through the message-transform pipeline. These small internal LLM
// requests (title/summary/compaction generation) carry the agent name on the
// user message's `info.agent` field. Mutating them corrupts the request and
// shared session state (e.g. countTurns runs on the wrong message set).
// Keep in sync with INTERNAL_AGENT_SIGNATURES (system-prompt layer) and the
// agent IDs defined in OpenCode's packages/core/src/plugin/agent.ts.
const INTERNAL_AGENT_NAMES = new Set(["title", "summary", "compaction"])

function isInternalAgentRequest(messages: WithParts[]): boolean {
    const lastUserMessage = getLastUserMessage(messages)
    if (!lastUserMessage) {
        return false
    }
    const agent = (lastUserMessage.info as { agent?: unknown }).agent
    return typeof agent === "string" && INTERNAL_AGENT_NAMES.has(agent)
}

export interface PreparedMessageTransformTransaction {
    workingMessages: WithParts[]
    workingState: SessionState
    effects: DeferredMutationEffects
}

/**
 * Prepare the shared message transform without committing any state, messages,
 * persistence, or host-facing effects. V1 commits this immediately; V2 first
 * validates its provider-message patch and then uses the same commit seam.
 */
export async function prepareMessageTransformTransaction(
    messages: WithParts[],
    state: SessionState,
    config: PluginConfig,
    logger: Logger,
    prompts: PromptStore,
    hostPermissions: HostPermissionSnapshot,
    requestModelLimit: number | undefined,
    modelLimitKnown: boolean | undefined,
    debugNotify?: (text: string) => void | Promise<void>,
    sanitizeAssistantTextOnly = false,
    effects?: DeferredMutationEffects,
    measuredSystemTokens?: number,
): Promise<PreparedMessageTransformTransaction> {
    const workingMessages = structuredClone(messages) as WithParts[]
    const workingState = cloneSessionState(state)
    const transactionEffects = effects ?? new DeferredMutationEffects()
    prompts.reload()
    ensureBuiltinFiltersRegistered()

    await runMessageTransform(
        workingMessages,
        workingState,
        config,
        prompts.getRuntimePrompts(),
        logger,
        hostPermissions,
        {
            requestModelLimit,
            modelLimitKnown,
            effects: transactionEffects,
            debugNotify,
            sanitizeAssistantTextOnly,
            measuredSystemTokens,
        },
    )

    return { workingMessages, workingState, effects: transactionEffects }
}

export async function commitPreparedMessageTransformTransaction(
    prepared: PreparedMessageTransformTransaction,
    state: SessionState,
    logger: Logger,
    messages?: WithParts[],
    isActive?: () => boolean,
    flushEffects = true,
): Promise<void> {
    if (!commitPreparedMessageTransformState(prepared, state, messages, isActive)) return

    if (!flushEffects) return

    // Disposal can begin while a host persistence write is in flight. The
    // state/event commit above is already atomic; do not start any deferred
    // host-facing work after the lifecycle fence is crossed.
    if (isActive && !isActive()) return
    if (prepared.effects.persistenceRequested) {
        try {
            await saveSessionState(state, logger)
        } catch (error) {
            logger.warn("Failed to persist message transform state", {
                sessionId: state.sessionId,
                error: error instanceof Error ? error.message : String(error),
            })
        }
    }
    if (isActive && !isActive()) return
    try {
        await prepared.effects.run()
    } catch (error) {
        logger.warn("Deferred message transform effect failed", {
            sessionId: state.sessionId,
            error: error instanceof Error ? error.message : String(error),
        })
    }
}

/** Commit the prepared state/message values synchronously, without flushing effects. */
export function commitPreparedMessageTransformState(
    prepared: PreparedMessageTransformTransaction,
    state: SessionState,
    messages?: WithParts[],
    isActive?: () => boolean,
): boolean {
    if (isActive && !isActive()) return false
    commitSessionState(state, prepared.workingState)
    if (messages) messages.splice(0, messages.length, ...prepared.workingMessages)
    return true
}

async function runMessageTransformTransaction(
    messages: WithParts[],
    state: SessionState,
    config: PluginConfig,
    logger: Logger,
    prompts: PromptStore,
    hostPermissions: HostPermissionSnapshot,
    requestModelLimit: number | undefined,
    modelLimitKnown: boolean | undefined,
    debugNotify: (text: string) => void | Promise<void>,
): Promise<void> {
    const prepared = await prepareMessageTransformTransaction(
        messages,
        state,
        config,
        logger,
        prompts,
        hostPermissions,
        requestModelLimit,
        modelLimitKnown,
        debugNotify,
    )
    await commitPreparedMessageTransformTransaction(prepared, state, logger, messages)
}

export function createSystemPromptHandler(
    registry: SessionStateRegistry,
    logger: Logger,
    config: PluginConfig,
    prompts: PromptStore,
) {
    return async (
        input: {
            sessionID?: string
            model: {
                id?: string
                providerID?: string
                limit: { context: number; input?: number; output?: number }
            }
        },
        output: { system: string[] },
    ) => {
        // [FIX #312] Record the live limit for this model BEFORE the state
        // guard below: the catalog is stateless and must keep accepting
        // entries even when the session state has not been created yet, so
        // the messages hook can reconcile a model switch on its next call.
        registry.recordModelLimit(
            input.model?.providerID,
            input.model?.id,
            input.model?.limit?.context,
        )

        // messages.transform creates the session state before this fires; if
        // absent (internal-agent early-return), there is nothing to attribute.
        const existingState = input.sessionID ? registry.get(input.sessionID) : undefined

        if (!existingState || (existingState.isSubAgent && !config.allowSubAgents)) {
            return
        }

        const primarySystemPrompt = output.system[0]
        if (
            typeof primarySystemPrompt === "string" &&
            INTERNAL_AGENT_SIGNATURES.some((sig) => primarySystemPrompt.includes(sig))
        ) {
            logger.info("Skipping DCP system prompt injection for internal agent")
            return
        }

        prompts.reload()
        const runSystemTransform = async (state: SessionState) => {
            // [FIX #346] Attribute the limit to the session only for real session
            // requests: internal agents (title/summary/compaction) may run on a
            // different model and must not overwrite the session's limit.
            // Persist on change so a freshly spawned process (headless
            // spawn+resume) resumes with the limit already known — the system
            // hook is the only writer and fires AFTER messages.transform within
            // a request, so without this the limit is learned and lost every
            // message and the safety net never engages.
            if (input.model?.limit?.context) {
                const limit = input.model.limit.context
                const providerID = input.model?.providerID
                const modelID = input.model?.id
                // Identity fields are only written when present: a limit without
                // identity must not clobber the pair the messages hook relies on
                // for staleness detection (#312).
                const changed =
                    state.modelContextLimit !== limit ||
                    (providerID !== undefined && state.modelProviderID !== providerID) ||
                    (modelID !== undefined && state.modelID !== modelID)
                state.modelContextLimit = limit
                // [FIX #312 follow-up] Record WHICH model the limit belongs to so
                // the messages hook can detect staleness on a catalog miss.
                if (providerID !== undefined) {
                    state.modelProviderID = providerID
                }
                if (modelID !== undefined) {
                    state.modelID = modelID
                }
                if (changed) {
                    saveSessionState(state, logger).catch(() => {})
                }
            }

            const effectivePermission = compressPermission(state, config)

            if (effectivePermission === "deny") {
                return
            }

            const runtimePrompts = prompts.getRuntimePrompts()
            const newPrompt = renderSystemPrompt(
                runtimePrompts,
                buildProtectedToolsExtension(config.compress.protectedTools),
                state.isSubAgent && config.allowSubAgents,
            )
            if (output.system.length > 0) {
                output.system[output.system.length - 1] += "\n\n" + newPrompt
            } else {
                output.system.push(newPrompt)
            }
        }
        if (registry.withSessionMutation) {
            await registry.withSessionMutation(input.sessionID!, runSystemTransform)
        } else {
            await runSystemTransform(existingState)
        }
    }
}

export function createChatMessageTransformHandler(
    host: HostServices,
    registry: SessionStateRegistry,
    logger: Logger,
    config: PluginConfig,
    prompts: PromptStore,
    hostPermissions: HostPermissionSnapshot,
) {
    const services = resolveHostServices(host)
    return async (_input: {}, output: { messages: WithParts[] }) => {
        const receivedMessages = Array.isArray(output.messages) ? output.messages.length : 0
        const messages = filterMessagesInPlace(output.messages)
        if (messages.length !== receivedMessages) {
            logger.warn("Skipping messages with unexpected shape during chat transform", {
                received: receivedMessages,
                usable: messages.length,
            })
        }

        if (isInternalAgentRequest(messages)) {
            logger.debug("Skipping message transform for internal agent request")
            return
        }

        const lastUserMessage = getLastUserMessage(messages)
        const debugNotify = (text: string) =>
            services.notifications.notify({
                title: "ACP: Nudge Injected",
                message: text,
                variant: "info",
                duration: 5000,
            })

        if (!lastUserMessage) {
            const state = createSessionState()
            await runMessageTransformTransaction(
                messages,
                state,
                config,
                logger,
                prompts,
                hostPermissions,
                undefined,
                undefined,
                debugNotify,
            )
            return
        }

        const sessionId = lastUserMessage.info.sessionID
        const requestModel = (
            lastUserMessage.info as { model?: { providerID?: string; modelID?: string } }
        ).model
        let requestModelLimit = registry.resolveModelLimit(
            requestModel?.providerID,
            requestModel?.modelID,
        )
        if (requestModelLimit === undefined && requestModel?.providerID && requestModel?.modelID) {
            requestModelLimit = await registry.hydrateAndResolve(
                services.models,
                requestModel.providerID,
                requestModel.modelID,
            )
        }

        const run = (state: SessionState) =>
            runMessageTransformTransaction(
                messages,
                state,
                config,
                logger,
                prompts,
                hostPermissions,
                requestModelLimit,
                requestModelLimit !== undefined,
                debugNotify,
            )
        if (registry.withSessionMutationAndInitialize) {
            await registry.withSessionMutationAndInitialize(
                services.sessions,
                sessionId,
                () => messages,
                (history) => history,
                config,
                async (state) => run(state),
            )
        } else {
            // Compatibility for lightweight registry doubles from older tests.
            await registry.getOrCreate(services.sessions, sessionId, messages, config)
            const state = registry.get(sessionId)
            if (state) await run(state)
        }
    }
}

export function createCommandExecuteHandler(
    host: HostServices,
    registry: SessionStateRegistry,
    logger: Logger,
    config: PluginConfig,
    workingDirectory: string,
    hostPermissions: HostPermissionSnapshot,
) {
    const services = resolveHostServices(host)
    return async (
        input: { command: string; sessionID: string; arguments: string },
        output: { parts: any[] },
    ) => {
        if (!config.commands.enabled) {
            return
        }

        if (input.command === "acp" || input.command === "dcp") {
            const runCommand = async (state: SessionState, messages: WithParts[]) => {
                syncCompressPermissionState(state, config, hostPermissions, messages)

                const commandCtx = {
                    notices: services.notices,
                    state,
                    config,
                    logger,
                    sessionId: input.sessionID,
                    messages,
                    workingDirectory,
                }

                await dispatchAcpCommand(commandCtx, input.arguments ?? "")
                // [FIX #398] Every handled /acp branch MUST abort the command by throwing
                // __DCP_CONTEXT_HANDLED__. A normal return does NOT stop execution:
                // opencode's Plugin.trigger only aborts on hook errors, and the command is
                // registered with template: "" (no $ARGUMENTS), so opencode appends the raw
                // arguments to the empty template and sends them to the model as a user
                // message ("/acp status" leaked "status" to the model in v1.17.0+). The
                // resulting level=ERROR log line on opencode >= 1.18.18 is the known cost
                // of this mechanism (#296) — do NOT replace these throws with returns.
                throw new Error("__DCP_CONTEXT_HANDLED__")
            }

            if (registry.withSessionMutationAndInitialize) {
                await registry.withSessionMutationAndInitialize(
                    services.sessions,
                    input.sessionID,
                    () => services.sessions.messages(input.sessionID),
                    (history) => history,
                    config,
                    runCommand,
                )
                return
            }

            const messages = await services.sessions.messages(input.sessionID)
            const state = await registry.getOrCreate(
                services.sessions,
                input.sessionID,
                messages,
                config,
            )
            if (registry.withSessionMutation) {
                await registry.withSessionMutation(input.sessionID, (guardedState) =>
                    runCommand(guardedState, messages),
                )
            } else {
                await runCommand(state, messages)
            }
        }
    }
}

export function createTextCompleteHandler() {
    return async (
        _input: { sessionID: string; messageID: string; partID: string },
        output: { text: string },
    ) => {
        output.text = stripHallucinationsFromString(output.text)
    }
}

export function createEventHandler(registry: SessionStateRegistry, logger: Logger) {
    return async (input: { event: any }) => {
        const eventTime =
            typeof input.event?.time === "number" && Number.isFinite(input.event.time)
                ? input.event.time
                : typeof input.event?.properties?.time === "number" &&
                    Number.isFinite(input.event.properties.time)
                  ? input.event.properties.time
                  : undefined

        if (input.event.type !== "message.part.updated") {
            return
        }

        const part = input.event.properties?.part
        if (part?.type !== "tool" || part.tool !== "compress") {
            return
        }

        // [FIX #33] The event hook carries no sessionID. compressionTiming is
        // shared on the registry so record/consume use one map (a per-session map
        // would let the destructive consume delete the start in the wrong
        // session). The apply step iterates sessions; only the owner matches.
        const timing = registry.compressionTiming

        if (part.state.status === "pending") {
            if (typeof part.callID !== "string" || typeof part.messageID !== "string") {
                return
            }

            const startedAt = eventTime ?? Date.now()
            const key = buildCompressionTimingKey(part.messageID, part.callID)
            if (timing.startsByCallId.has(key)) {
                return
            }
            timing.startsByCallId.set(key, startedAt)
            logger.debug("Recorded compression start", {
                messageID: part.messageID,
                callID: part.callID,
                startedAt,
            })
            return
        }

        if (part.state.status === "completed") {
            if (typeof part.callID !== "string" || typeof part.messageID !== "string") {
                return
            }

            const key = buildCompressionTimingKey(part.messageID, part.callID)
            const start = timing.startsByCallId.get(key)
            timing.startsByCallId.delete(key)
            const durationMs = resolveCompressionDuration(start, eventTime, part.state.time)
            if (typeof durationMs !== "number") {
                return
            }

            timing.pendingByCallId.set(key, {
                messageId: part.messageID,
                callId: part.callID,
                durationMs,
            })

            await Promise.all(
                registry.all().map(async (state) => {
                    const apply = async (guardedState: SessionState) => {
                        const updates = applyPendingCompressionDurations(guardedState)
                        if (updates > 0) {
                            await saveSessionState(guardedState, logger)
                            logger.info("Attached compression time to blocks", {
                                messageID: part.messageID,
                                callID: part.callID,
                                blocks: updates,
                                durationMs,
                            })
                        }
                    }
                    if (registry.withSessionMutation && state.sessionId) {
                        await registry.withSessionMutation(state.sessionId, apply)
                    } else {
                        await apply(state)
                    }
                }),
            )
            return
        }

        if (part.state.status === "running") {
            return
        }

        if (typeof part.callID === "string" && typeof part.messageID === "string") {
            timing.startsByCallId.delete(buildCompressionTimingKey(part.messageID, part.callID))
        }
    }
}
