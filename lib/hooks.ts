import type { SessionState, WithParts } from "./state"
import type { Logger } from "./logger"
import type { PluginConfig } from "./config"
import { assignMessageRefs } from "./message-ids"
import {
    buildPriorityMap,
    buildToolIdList,
    injectCompressNudges,
    injectExtendedSubAgentResults,
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
    consumeCompressionStart,
    resolveCompressionDuration,
} from "./compress/timing"
import { filterMessages, filterMessagesInPlace } from "./messages/shape"
import { getLastUserMessage } from "./messages/query"
import {
    applyPendingManualTrigger,
    handleContextCommand,
    handleDecompressCommand,
    handleHelpCommand,
    handleManualToggleCommand,
    handleManualTriggerCommand,
    handleRecompressCommand,
    handleStatsCommand,
    handleSweepCommand,
} from "./commands"
import { type HostPermissionSnapshot } from "./host-permissions"
import { compressPermission, syncCompressPermissionState } from "./compress-permission"
import { checkSession, ensureSessionInitialized, saveSessionState, syncToolCache } from "./state"
import { cacheSystemPromptTokens } from "./ui/utils"
import { runTruncateGC, shouldRunMajorGC, getGCParams } from "./gc/truncate"
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
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    prompts: PromptStore,
) {
    return async (
        input: {
            sessionID?: string
            model: { limit: { context: number; input?: number; output?: number } }
        },
        output: { system: string[] },
    ) => {
        if (input.model?.limit?.context) {
            state.modelContextLimit = input.model.limit.context
        }

        if (state.isSubAgent && !config.experimental.allowSubAgents) {
            return
        }

        const systemText = output.system.join("\n")
        if (INTERNAL_AGENT_SIGNATURES.some((sig) => systemText.includes(sig))) {
            logger.info("Skipping DCP system prompt injection for internal agent")
            return
        }

        const effectivePermission =
            input.sessionID && state.sessionId === input.sessionID
                ? compressPermission(state, config)
                : config.compress.permission

        if (effectivePermission === "deny") {
            return
        }

        if (state.nudges.shouldInjectThisTurn === false && !state.manualMode) {
            return
        }

        prompts.reload()
        const runtimePrompts = prompts.getRuntimePrompts()
        const newPrompt = renderSystemPrompt(
            runtimePrompts,
            buildProtectedToolsExtension(config.compress.protectedTools),
            !!state.manualMode,
            state.isSubAgent && config.experimental.allowSubAgents,
        )
        if (output.system.length > 0) {
            output.system[output.system.length - 1] += "\n\n" + newPrompt
        } else {
            output.system.push(newPrompt)
        }
    }
}

function runMajorGC(
    state: SessionState,
    config: PluginConfig,
    logger: Logger,
    messages: WithParts[],
): void {
    // [FIX Bug 32] Age-based deactivation does NOT depend on modelContextLimit.
    // modelContextLimit is set in the system prompt hook, which runs AFTER the
    // messages transform hook. If we guard this with modelContextLimit, age-based
    // deactivation never runs after restart (modelContextLimit starts as undefined).
    const maxBlockAge = config.gc.maxBlockAge ?? 15
    let agedOutCount = 0
    let agedOutTokens = 0
    const now = Date.now()
    for (const [blockId, block] of state.prune.messages.blocksById) {
        if (!block.active) continue
        const age = block.survivedCount ?? 0
        if (age > maxBlockAge) {
            block.active = false
            block.deactivatedAt = now
            block.deactivatedByBlockId = undefined
            state.prune.messages.activeBlockIds.delete(Number(blockId))
            const anchorMapped = state.prune.messages.activeByAnchorMessageId.get(block.anchorMessageId)
            if (anchorMapped === Number(blockId)) {
                state.prune.messages.activeByAnchorMessageId.delete(block.anchorMessageId)
            }
            agedOutCount++
            agedOutTokens += block.summaryTokens ?? Math.round(block.summary.length / 4)
        }
    }

    if (agedOutCount > 0) {
        logger.info("Major GC: deactivated aged-out blocks", {
            agedOutCount,
            agedOutTokens,
            maxBlockAge,
        })
        void saveSessionState(state, logger)
    }

    if (!state.modelContextLimit) return

    const currentTokens = getCurrentTokenUsage(state, messages)

    // Check if any active block is oversized (summary > 2x maxOldGenSummaryLength)
    // These should always be truncated regardless of token threshold
    const oversizedThreshold = config.gc.maxOldGenSummaryLength * 2
    let hasOversizedBlocks = false
    for (const [, block] of state.prune.messages.blocksById) {
        if (block.active && block.summary.length > oversizedThreshold) {
            hasOversizedBlocks = true
            break
        }
    }

    if (!shouldRunMajorGC(currentTokens, state.modelContextLimit, config.gc) && !hasOversizedBlocks) return

    const oldBlocks: import("./state").CompressionBlock[] = []
    for (const [blockId, block] of state.prune.messages.blocksById) {
        if (!block.active) continue
        if (
            block.generation === "old" ||
            block.generation === undefined ||
            block.summary.length > config.gc.maxOldGenSummaryLength
        ) {
            oldBlocks.push(block)
        }
    }

    if (oldBlocks.length === 0) return

    const params = getGCParams(config.gc, state.modelContextLimit, currentTokens)
    const result = runTruncateGC(oldBlocks, params)

    if (result.compactedBlocks > 0) {
        logger.info("Major GC: truncated old-gen blocks", {
            compactedBlocks: result.compactedBlocks,
            savedTokens: result.savedTokens,
            currentTokens,
            threshold: config.gc.majorGcThresholdPercent,
        })
        void saveSessionState(state, logger)
    }
}

export function createChatMessageTransformHandler(
    client: any,
    state: SessionState,
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
        // These small hidden LLM requests must not be mutated, and running
        // checkSession on them would corrupt shared state (currentTurn, etc.).
        if (isInternalAgentRequest(messages)) {
            logger.debug("Skipping message transform for internal agent request")
            return
        }

        await checkSession(client, state, logger, output.messages, config.manualMode.enabled)

        syncCompressPermissionState(state, config, hostPermissions, output.messages)

        if (state.isSubAgent && !config.experimental.allowSubAgents) {
            return
        }

        stripHallucinations(output.messages)
        cacheSystemPromptTokens(state, output.messages)
        assignMessageRefs(state, output.messages)
        const activeBlockCountBefore = state.prune.messages.activeBlockIds.size // [FIX Bug 4]
        syncCompressionBlocks(state, logger, output.messages)
        if (state.prune.messages.activeBlockIds.size !== activeBlockCountBefore) { // [FIX Bug 4]
            void saveSessionState(state, logger) // [FIX Bug 4] persist deactivations
        }
        syncToolCache(state, config, logger, output.messages)
        buildToolIdList(state, output.messages)
        runMajorGC(state, config, logger, output.messages)
        const batchResult = runBatchCleanup(state, config, logger, output.messages)
        if (batchResult.mergedCount > 0) {
            void saveSessionState(state, logger)
        }
        prune(state, logger, config, output.messages)
        // [FIX Bug 2] assign refs to newly created synthetic messages from prune/filterCompressedRanges
        assignMessageRefs(state, output.messages)
        await injectExtendedSubAgentResults(
            client,
            state,
            logger,
            output.messages,
            config.experimental.allowSubAgents,
        )
        const compressionPriorities = buildPriorityMap(config, state, output.messages)
        prompts.reload()
        injectCompressNudges(
            state,
            config,
            logger,
            output.messages,
            prompts.getRuntimePrompts(),
            compressionPriorities,
        )
        injectMessageIds(state, config, output.messages, compressionPriorities)
        applyPendingManualTrigger(state, output.messages, logger)
        stripStaleMetadata(output.messages)

        if (state.sessionId) {
            await logger.saveContext(state.sessionId, output.messages)
        }
    }
}

export function createCommandExecuteHandler(
    client: any,
    state: SessionState,
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

            await ensureSessionInitialized(
                client,
                state,
                input.sessionID,
                logger,
                messages,
                config.manualMode.enabled,
            )

            syncCompressPermissionState(state, config, hostPermissions, messages)

            const effectivePermission = compressPermission(state, config)
            if (effectivePermission === "deny") {
                return
            }

            const args = (input.arguments || "").trim().split(/\s+/).filter(Boolean)
            const subcommand = args[0]?.toLowerCase() || ""
            const subArgs = args.slice(1)

            const commandCtx = {
                client,
                state,
                config,
                logger,
                sessionId: input.sessionID,
                messages,
            }

            if (subcommand === "context") {
                await handleContextCommand(commandCtx)
                throw new Error("__DCP_CONTEXT_HANDLED__")
            }

            if (subcommand === "stats") {
                await handleStatsCommand(commandCtx)
                throw new Error("__DCP_STATS_HANDLED__")
            }

            if (subcommand === "sweep") {
                await handleSweepCommand({
                    ...commandCtx,
                    args: subArgs,
                    workingDirectory,
                })
                throw new Error("__DCP_SWEEP_HANDLED__")
            }

            if (subcommand === "manual") {
                await handleManualToggleCommand(commandCtx, subArgs[0]?.toLowerCase())
                throw new Error("__DCP_MANUAL_HANDLED__")
            }

            if (subcommand === "compress") {
                const userFocus = subArgs.join(" ").trim()
                const prompt = await handleManualTriggerCommand(commandCtx, "compress", userFocus)
                if (!prompt) {
                    throw new Error("__DCP_MANUAL_TRIGGER_BLOCKED__")
                }

                state.manualMode = "compress-pending"
                state.pendingManualTrigger = {
                    sessionId: input.sessionID,
                    prompt,
                }
                const rawArgs = (input.arguments || "").trim()
                output.parts.length = 0
                output.parts.push({
                    type: "text",
                    text: rawArgs ? `/dcp ${rawArgs}` : `/dcp ${subcommand}`,
                })
                return
            }

            if (subcommand === "decompress") {
                await handleDecompressCommand({
                    ...commandCtx,
                    args: subArgs,
                })
                throw new Error("__DCP_DECOMPRESS_HANDLED__")
            }

            if (subcommand === "recompress") {
                await handleRecompressCommand({
                    ...commandCtx,
                    args: subArgs,
                })
                throw new Error("__DCP_RECOMPRESS_HANDLED__")
            }

            await handleHelpCommand(commandCtx)
            throw new Error("__DCP_HELP_HANDLED__")
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

export function createEventHandler(state: SessionState, logger: Logger) {
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

        if (part.state.status === "pending") {
            if (typeof part.callID !== "string" || typeof part.messageID !== "string") {
                return
            }

            const startedAt = eventTime ?? Date.now()
            const key = buildCompressionTimingKey(part.messageID, part.callID)
            if (state.compressionTiming.startsByCallId.has(key)) {
                return
            }
            state.compressionTiming.startsByCallId.set(key, startedAt)
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
            const start = consumeCompressionStart(state, part.messageID, part.callID)
            const durationMs = resolveCompressionDuration(start, eventTime, part.state.time)
            if (typeof durationMs !== "number") {
                return
            }

            state.compressionTiming.pendingByCallId.set(key, {
                messageId: part.messageID,
                callId: part.callID,
                durationMs,
            })

            const updates = applyPendingCompressionDurations(state)
            if (updates === 0) {
                return
            }

            await saveSessionState(state, logger)

            logger.info("Attached compression time to blocks", {
                messageID: part.messageID,
                callID: part.callID,
                blocks: updates,
                durationMs,
            })
            return
        }

        if (part.state.status === "running") {
            return
        }

        if (typeof part.callID === "string" && typeof part.messageID === "string") {
            state.compressionTiming.startsByCallId.delete(
                buildCompressionTimingKey(part.messageID, part.callID),
            )
        }
    }
}
