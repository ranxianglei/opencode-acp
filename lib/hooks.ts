import type { SessionState, WithParts } from "./state"
import type { Logger } from "./logger"
import type { PluginConfig } from "./config"
import { assignMessageRefs } from "./message-ids"
import {
    buildPriorityMap,
    buildToolIdList,
    dropEmptyMessages,
    injectCompressNudges,
    injectMessageIds,
    prune,
    stripHallucinations,
    stripHallucinationsFromString,
    stripStaleMetadata,
    syncCompressionBlocks,
    computeInputBudget,
} from "./messages"
import { renderSystemPrompt, type PromptStore } from "./prompts"
import { buildProtectedToolsExtension } from "./prompts/extensions/system"
import {
    applyPendingCompressionDurations,
    buildCompressionTimingKey,
    resolveCompressionDuration,
} from "./compress/timing"
import { filterMessages, filterMessagesInPlace } from "./messages/shape"
import { getLastUserMessage } from "./messages/query"
import { OUTPUT_RESERVE_TOKENS, truncateLargeToolOutputs } from "./messages/truncate-tools"
import { resolveEffectiveContextLimit } from "./state/utils"
import {
    handleContextCommand,
    handleStatsCommand,
} from "./commands"
import { handleExportCommand } from "./commands/export"
import { sendIgnoredMessage } from "./ui/notification"
import { type HostPermissionSnapshot } from "./host-permissions"
import { compressPermission, syncCompressPermissionState } from "./compress-permission"
import { hideConsumedCompressCalls } from "./compress/hide-consumed"
import { hideFailedCompressCalls } from "./compress/hide-failed"
import { applyMessageFilters } from "./messages/filter/apply"
import { ensureBuiltinFiltersRegistered } from "./messages/filter/builtin"
import { createSessionState, saveSessionState, syncToolCache, updatePerTurnState, type SessionStateRegistry } from "./state"
import { cacheSystemPromptTokens } from "./ui/utils"
import { runBatchCleanup } from "./gc/merge"
import { getCurrentTokenUsage } from "./token-utils"

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
        const state = input.sessionID ? registry.get(input.sessionID) : undefined

        if (!state || (state.isSubAgent && !config.allowSubAgents)) {
            return
        }

        const systemText = output.system.join("\n")
        if (INTERNAL_AGENT_SIGNATURES.some((sig) => systemText.includes(sig))) {
            logger.info("Skipping DCP system prompt injection for internal agent")
            return
        }

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

        prompts.reload()
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
}

export function createChatMessageTransformHandler(
    client: any,
    registry: SessionStateRegistry,
    logger: Logger,
    config: PluginConfig,
    prompts: PromptStore,
    hostPermissions: HostPermissionSnapshot,
) {
    return async (input: {}, output: { messages: WithParts[] }) => {
        const receivedMessages = Array.isArray(output.messages) ? output.messages.length : 0
        const messages = filterMessagesInPlace(output.messages)
        if (messages.length !== receivedMessages) {
            logger.warn("Skipping messages with unexpected shape during chat transform", {
                received: receivedMessages,
                usable: messages.length,
            })
        }

        // [FIX Bug 37] Skip OpenCode internal agents (title/summary/compaction).
        // These small hidden LLM requests must not be mutated, and resolving a
        // session state for them would corrupt it (currentTurn, etc.).
        if (isInternalAgentRequest(messages)) {
            logger.debug("Skipping message transform for internal agent request")
            return
        }

        const lastUserMessage = getLastUserMessage(messages)
        let state: SessionState
        if (!lastUserMessage) {
            // Ephemeral state: no session to resolve, but keep running
            // state-independent stages (e.g. stripHallucinations).
            state = createSessionState()
        } else {
            // [FIX #33] Per-session state: each session keeps its own SessionState,
            // so interleaved sessions no longer reset each other's modelContextLimit.
            state = await registry.getOrCreate(
                client,
                lastUserMessage.info.sessionID,
                messages,
                config,
            )

            // [FIX #312] system.transform (the only writer of
            // state.modelContextLimit) fires AFTER messages.transform within
            // one request, so on the first request after a model switch the
            // value still reflects the previous model. Reconcile it from the
            // catalog entry for the model named on this request's user message
            // before any consumer (filters, GC, nudge thresholds) reads it.
            const requestModel = (
                lastUserMessage.info as { model?: { providerID?: string; modelID?: string } }
            ).model
            let requestModelLimit = registry.resolveModelLimit(
                requestModel?.providerID,
                requestModel?.modelID,
            )
            // [FIX #346] Catalog miss: the init-time seed is fire-and-forget and
            // races server readiness, so in headless spawn+resume mode the
            // catalog can stay empty for the whole process lifetime. During a
            // request the server is guaranteed up (we are inside its pipeline),
            // so retry hydration once per process before any threshold math.
            if (
                requestModelLimit === undefined &&
                requestModel?.providerID &&
                requestModel?.modelID
            ) {
                requestModelLimit = await registry.hydrateAndResolve(
                    client,
                    requestModel.providerID,
                    requestModel.modelID,
                )
            }
            const prevModelID = state.modelID
            if (requestModelLimit !== undefined) {
                state.modelContextLimit = requestModelLimit
                state.modelProviderID = requestModel?.providerID
                state.modelID = requestModel?.modelID
            } else if (
                // [FIX #312 fallback] Catalog miss: we cannot CORRECT the
                // limit, but we can tell when it belongs to a DIFFERENT model.
                // Invalidate instead of letting every percentage threshold
                // below run against the wrong window (#312's false positive).
                // States persisted before this identity pair existed carry no
                // identity and are treated as stale for the same reason.
                // Consumers already tolerate undefined — fresh sessions run
                // with it until the first system.transform sets the pair.
                requestModel?.providerID &&
                requestModel?.modelID &&
                state.modelContextLimit !== undefined &&
                (state.modelProviderID !== requestModel.providerID ||
                    state.modelID !== requestModel.modelID)
            ) {
                state.modelContextLimit = undefined
                state.modelProviderID = requestModel.providerID
                state.modelID = requestModel.modelID
            }
            if (requestModel?.modelID && requestModel.modelID !== prevModelID) {
                logger.info("Model switched mid-session", {
                    session: state.sessionId,
                    from: prevModelID,
                    to: requestModel.modelID,
                    contextLimit: state.modelContextLimit,
                })
            }
            await updatePerTurnState(state, logger, messages)
        }

        syncCompressPermissionState(state, config, hostPermissions, output.messages)

        if (state.isSubAgent && !config.allowSubAgents) {
            return
        }

        stripHallucinations(output.messages)
        ensureBuiltinFiltersRegistered()
        const effectiveLimit = resolveEffectiveContextLimit(state, config)
        applyMessageFilters(output.messages, config.messageFilters, logger, {
            sessionId: state.sessionId ?? "",
            isSubAgent: state.isSubAgent,
            modelContextLimit: effectiveLimit?.limit,
        })
        cacheSystemPromptTokens(state, output.messages)
        assignMessageRefs(state, output.messages)
        const activeBlockCountBefore = state.prune.messages.activeBlockIds.size // [FIX Bug 4]
        syncCompressionBlocks(state, logger, output.messages)
        if (state.prune.messages.activeBlockIds.size !== activeBlockCountBefore) { // [FIX Bug 4]
            saveSessionState(state, logger).catch(() => {}) // [FIX Bug 4] persist deactivations
        }
        syncToolCache(state, config, logger, output.messages)
        buildToolIdList(state, output.messages)
        const batchResult = runBatchCleanup(state, config, logger, output.messages)
        if (batchResult.mergedCount > 0) {
            saveSessionState(state, logger).catch(() => {})
        }
        const prePruneTokens = getCurrentTokenUsage(state, output.messages)
        prune(state, logger, config, output.messages)
        truncateLargeToolOutputs(state, config, logger, output.messages)
        hideConsumedCompressCalls(state, output.messages)
        assignMessageRefs(state, output.messages)
        const compressionPriorities = buildPriorityMap(config, state, output.messages)
        prompts.reload()
        injectCompressNudges(
            state,
            config,
            logger,
            output.messages,
            prompts.getRuntimePrompts(),
            compressionPriorities,
            config.debug
                ? (text: string) => {
                      // sendIgnoredMessage writes an ignored:true user msg to DB.
                      // opencode's runtime loop detects it as "last user" (role-only,
                      // ignores the flag) → phantom turn → compress → notification →
                      // infinite loop. Use logger.debug + toast instead.
                      logger.debug(`[ACP Debug] Nudge injected:\n${text}`)
                      client.tui
                          .showToast({
                              body: {
                                  title: "ACP: Nudge Injected",
                                  message: text.slice(0, 500),
                                  variant: "info",
                                  duration: 5000,
                              },
                          })
                          .catch(() => {})
                  }
                : undefined,
            prePruneTokens,
        )
        injectMessageIds(state, config, output.messages, compressionPriorities)
        hideFailedCompressCalls(output.messages)
        stripStaleMetadata(output.messages)
        dropEmptyMessages(output.messages)
        const postTokens = getCurrentTokenUsage(state, output.messages)
        // [FIX #346] Hard guard: if the post-transform context still exceeds
        // the model's real request budget (window minus system prompt + tool
        // schemas + output-token reserve), the backend will reject the
        // request. opencode exits 0 with zero output in that case (upstream
        // behavior the plugin cannot change), so this ERROR is the only
        // signal that the session has hit the length-rejection wall.
        if (postTokens !== undefined && effectiveLimit) {
            const budget =
                effectiveLimit.limit - (state.systemPromptTokens ?? 0) - OUTPUT_RESERVE_TOKENS
            if (postTokens > budget) {
                logger.error(
                    "ACP hard guard: context exceeds model budget after in-flight reduction",
                    {
                        session: state.sessionId,
                        postTokens,
                        budget,
                        contextLimit: effectiveLimit.limit,
                        contextLimitSource: effectiveLimit.source,
                        hint: "request will likely be rejected; run /compact or start a new session",
                    },
                )
            }
        }
        logger.info("Chat transform complete", {
            session: state.sessionId,
            model: state.modelID,
            messages: output.messages.length,
            prePruneTokens,
            postTokens,
            contextLimit: effectiveLimit?.limit,
            contextLimitSource: effectiveLimit?.source,
            usagePct:
                postTokens !== undefined && effectiveLimit
                    ? `${((postTokens / effectiveLimit.limit) * 100).toFixed(1)}%`
                    : undefined,
            nudged: state.nudges.shouldInjectThisTurn,
        })

        if (state.sessionId) {
            await logger.saveContext(state.sessionId, output.messages)
        }
    }
}

function buildHelpText(): string {
    return [
        "[ACP] Available commands:",
        "",
        "  /acp              Show compression status (same as /acp stats)",
        "  /acp context      Token usage breakdown (system, user, assistant, tools)",
        "  /acp stats        Compression status: blocks, context usage, ranges",
        "  /acp export       Export active compression blocks to markdown",
        "                   Options: --output <path>, --tier t1,t2,t3, --stdout, --append",
        "  /acp help         Show this help",
        "",
        "Also accepts /dcp for backward compatibility.",
    ].join("\n")
}

export function createCommandExecuteHandler(
    client: any,
    registry: SessionStateRegistry,
    logger: Logger,
    config: PluginConfig,
    workingDirectory: string,
    hostPermissions: HostPermissionSnapshot,
) {
    return async (
        input: { command: string; sessionID: string; arguments: string },
        output: { parts: any[] },
    ) => {
        if (!config.commands.enabled) {
            return
        }

        if (input.command === "acp" || input.command === "dcp") {
            const messagesResponse = await client.session.messages({
                path: { id: input.sessionID },
            })
            const messages = filterMessages(messagesResponse.data || messagesResponse)

            const state = await registry.getOrCreate(
                client,
                input.sessionID,
                messages,
                config,
            )

            syncCompressPermissionState(state, config, hostPermissions, messages)

            const commandCtx = {
                client,
                state,
                config,
                logger,
                sessionId: input.sessionID,
                messages,
                workingDirectory,
            }

            const sub = input.arguments?.trim().toLowerCase()
            if (sub === "stats" || sub === "status" || sub === "") {
                await handleStatsCommand(commandCtx)
                throw new Error("__DCP_CONTEXT_HANDLED__")
            }

            if (sub === "export" || sub.startsWith("export ")) {
                const exportArgs = input.arguments?.trim().slice("export".length).trim() || ""
                await handleExportCommand(commandCtx, exportArgs)
                throw new Error("__DCP_CONTEXT_HANDLED__")
            }

            if (sub === "help") {
                await sendIgnoredMessage(
                    client,
                    input.sessionID,
                    buildHelpText(),
                    {},
                    logger,
                )
                throw new Error("__DCP_CONTEXT_HANDLED__")
            }

            await handleContextCommand(commandCtx)
            throw new Error("__DCP_CONTEXT_HANDLED__")
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

            for (const state of registry.all()) {
                const updates = applyPendingCompressionDurations(state)
                if (updates > 0) {
                    await saveSessionState(state, logger)
                    logger.info("Attached compression time to blocks", {
                        messageID: part.messageID,
                        callID: part.callID,
                        blocks: updates,
                        durationMs,
                    })
                }
            }
            return
        }

        if (part.state.status === "running") {
            return
        }

        if (typeof part.callID === "string" && typeof part.messageID === "string") {
            timing.startsByCallId.delete(
                buildCompressionTimingKey(part.messageID, part.callID),
            )
        }
    }
}
