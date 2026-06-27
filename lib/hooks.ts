import type { SessionState, WithParts } from "./state/types"
import type { Logger } from "./infra/logger"
import type { PluginConfig } from "./config/types"
import type { HostPermissionSnapshot } from "./host-permissions"
import {
    stripHallucinations,
    stripHallucinationsFromString,
    appendToLastTextPart,
    createSyntheticUserMessage,
} from "./messages/utils"
import { filterMessagesInPlace, filterMessages, isMessageWithInfo } from "./messages/shape"
import { assignMessageRefs } from "./message-ids"
import { injectMessageIds, injectCompressNudges, applyAnchoredNudges } from "./messages/inject/inject"
import { buildPriorityMap } from "./messages/priority"
import { getLastUserMessage, isIgnoredUserMessage } from "./messages/query"
import { prune } from "./messages/prune"
import { syncCompressionBlocks } from "./messages/sync"
import { stripStaleMetadata } from "./messages/reasoning-strip"
import { runMajorGC } from "./gc"
import { runBatchCleanup } from "./gc/merge"
import {
    checkSession,
    ensureSessionInitialized,
    saveSessionState,
    syncToolCache,
} from "./state"
import {
    compressPermission,
    syncCompressPermissionState,
} from "./permissions"
import {
    buildCompressionTimingKey,
    consumeCompressionStart,
    resolveCompressionDuration,
    applyPendingCompressionDurations,
} from "./compress/timing"
import { formatMessageRef, formatMessageIdTag } from "./infra/message-refs"

export { handleMessageTransform, createPluginEntry, type PluginContext } from "./plugin/entry"

const INTERNAL_AGENT_NAMES = new Set(["title", "summary", "compaction"])

const ACP_SUFFIX_SEED = "acp-dynamic-guidance"

function isInternalAgentRequest(messages: WithParts[]): boolean {
    const lastUserMessage = getLastUserMessage(messages)
    if (!lastUserMessage) {
        return false
    }
    const agent = (lastUserMessage.info as { agent?: unknown }).agent
    return typeof agent === "string" && INTERNAL_AGENT_NAMES.has(agent)
}

function createSuffixMessage(messages: WithParts[]): WithParts | null {
    if (messages.length === 0) return null
    const base = messages.find((m) => m.info.role === "user") || messages[messages.length - 1]
    if (!base) return null
    const synthetic = createSyntheticUserMessage(base, "", ACP_SUFFIX_SEED)
    messages.push(synthetic)
    return synthetic
}

function applyPendingManualTrigger(
    state: SessionState,
    messages: WithParts[],
    logger: Logger,
): void {
    const pending = state.pendingManualTrigger
    if (!pending) {
        return
    }

    if (!state.sessionId || pending.sessionId !== state.sessionId) {
        state.pendingManualTrigger = null
        return
    }

    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (!msg) continue
        if (msg.info.role !== "user" || isIgnoredUserMessage(msg)) {
            continue
        }

        for (const part of msg.parts) {
            if (!part) continue
            if (part.type !== "text") continue
            const textPart = part as { type: string; synthetic?: boolean; text?: string }
            if (textPart.synthetic === true) {
                continue
            }

            textPart.text = pending.prompt
            state.pendingManualTrigger = null
            logger.debug("Applied manual prompt", { sessionId: pending.sessionId })
            return
        }
    }

    state.pendingManualTrigger = null
}

function appendBatchCleanupNudge(messages: WithParts[], nudgeText: string): void {
    const lastUser = getLastUserMessage(messages)
    if (!lastUser) return
    appendToLastTextPart(lastUser, nudgeText)
}

function buildToolIdList(state: SessionState, messages: WithParts[]): void {
    const ids: string[] = []
    const seen = new Set<string>()
    for (const msg of messages) {
        if (!msg || !Array.isArray(msg.parts)) continue
        for (const part of msg.parts) {
            if (!part) continue
            const p = part as { type?: string; callID?: unknown }
            if (p.type === "tool" && typeof p.callID === "string" && !seen.has(p.callID)) {
                seen.add(p.callID)
                ids.push(p.callID)
            }
        }
    }
    state.toolIdList = ids
}

function cacheSystemPromptTokens(state: SessionState, messages: WithParts[]): void {
    for (const msg of messages) {
        if (!msg || !msg.info) continue
        if ((msg.info as { role?: string }).role !== "system") continue
        const text = (msg.parts ?? [])
            .map((p) => (p && p.type === "text" ? (p as { text?: string }).text ?? "" : ""))
            .join("")
        if (text.length > 0) {
            state.systemPromptTokens = text.length
            return
        }
    }
}

export function createChatMessageTransformHandler(
    client: unknown,
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    prompts: unknown,
    hostPermissions: HostPermissionSnapshot,
): (input: unknown, output: { messages: WithParts[] }) => Promise<void> {
    return async function (_input, output) {
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

        await checkSession(client, state, logger, output.messages, config.manualMode.enabled)

        syncCompressPermissionState(state, config, hostPermissions, output.messages)

        if (state.isSubAgent && !config.experimental.allowSubAgents) {
            return
        }

        stripHallucinations(output.messages)
        cacheSystemPromptTokens(state, output.messages)
        assignMessageRefs(state, output.messages)
        const activeBlockCountBefore = state.prune.messages.activeBlockIds.size
        syncCompressionBlocks(state, logger, output.messages)
        if (state.prune.messages.activeBlockIds.size !== activeBlockCountBefore) {
            void saveSessionState(state, logger)
        }
        syncToolCache(state, config, logger, output.messages)
        buildToolIdList(state, output.messages)
        runMajorGC(state, config, logger)
        const batchResult = runBatchCleanup(state, config, logger, output.messages)
        if (batchResult.tier === 1 && batchResult.nudgeText) {
            appendBatchCleanupNudge(output.messages, batchResult.nudgeText)
        }
        if (batchResult.mergedCount > 0) {
            void saveSessionState(state, logger)
        }
        prune(state, logger, config, output.messages)
        assignMessageRefs(state, output.messages)

        const compressionPriorities = buildPriorityMap(config, state, output.messages)

        if (typeof prompts === "object" && prompts !== null) {
            const p = prompts as {
                reload?: () => void
                getRuntimePrompts?: () => {
                    contextLimitNudge: string
                    turnNudge: string
                    iterationNudge: string
                }
            }
            if (typeof p.reload === "function") {
                p.reload()
            }

            injectCompressNudges(state, config, logger, output.messages)
        }

        injectMessageIds(state, config, output.messages, compressionPriorities)

        if (typeof prompts === "object" && prompts !== null) {
            const p = prompts as {
                getRuntimePrompts?: () => {
                    contextLimitNudge: string
                    turnNudge: string
                    iterationNudge: string
                }
            }
            if (typeof p.getRuntimePrompts === "function") {
                const runtimePrompts = p.getRuntimePrompts()
                applyAnchoredNudges(
                    state,
                    config,
                    logger,
                    output.messages,
                )
                void runtimePrompts
            }
        }

        applyPendingManualTrigger(state, output.messages, logger)
        stripStaleMetadata(output.messages)

        if (state.sessionId) {
            try {
                await logger.saveContext?.(state.sessionId, output.messages)
            } catch (err) {
                logger.debug("saveContext failed", { error: String(err) })
            }
        }
    }
}

export function createTextCompleteHandler(): (
    _input: unknown,
    output: { text: string },
) => Promise<void> {
    return async function (_input, output) {
        output.text = stripHallucinationsFromString(output.text)
    }
}

interface CompressEventPart {
    type?: string
    tool?: string
    callID?: string
    messageID?: string
    sessionID?: string
    state?: {
        status?: string
        input?: unknown
        output?: unknown
        title?: string
        metadata?: unknown
        raw?: string
        time?: { start?: unknown; end?: unknown }
    }
}

interface CompressEventPayload {
    type?: string
    time?: number
    properties?: {
        sessionID?: string
        time?: number
        part?: CompressEventPart
    }
}

export function createEventHandler(
    state: SessionState,
    logger: Logger,
): (input: { event: CompressEventPayload }) => Promise<void> {
    return async function (input) {
        const event = input?.event
        if (!event) return

        const eventTime =
            typeof event.time === "number" && Number.isFinite(event.time)
                ? event.time
                : typeof event.properties?.time === "number" &&
                    Number.isFinite(event.properties.time)
                  ? event.properties.time
                  : undefined

        if (event.type !== "message.part.updated") {
            return
        }

        const part = event.properties?.part
        if (!part || part.type !== "tool" || part.tool !== "compress") {
            return
        }

        if (typeof part.callID !== "string" || typeof part.messageID !== "string") {
            return
        }

        const status = part.state?.status

        if (status === "pending") {
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

        if (status === "completed") {
            const key = buildCompressionTimingKey(part.messageID, part.callID)
            const start = consumeCompressionStart(state, part.messageID, part.callID)
            const partTime = part.state?.time as { start?: unknown; end?: unknown } | undefined
            const durationMs = resolveCompressionDuration(start, eventTime, partTime)
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

        if (status === "running") {
            return
        }

        state.compressionTiming.startsByCallId.delete(
            buildCompressionTimingKey(part.messageID, part.callID),
        )
    }
}

export function createCommandExecuteHandler(
    client: unknown,
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    workingDirectory: string,
    hostPermissions: HostPermissionSnapshot,
): (
    input: { command: string; sessionID: string; arguments: string },
    output: { parts: unknown[] },
) => Promise<void> {
    return async function (input, _output) {
        if (!config.commands.enabled) {
            return
        }

        if (input.command !== "acp" && input.command !== "dcp") {
            return
        }

        const messagesResponse = await (client as {
            session?: {
                messages?: (path: { path: { id: string } }) => Promise<{
                    data?: WithParts[]
                }>
            }
        }).session?.messages?.({ path: { id: input.sessionID } })

        const messages = filterMessages(messagesResponse?.data ?? ([] as WithParts[]))

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

        void workingDirectory
    }
}

export function appendBatchCleanupNudgeExport(messages: WithParts[], nudgeText: string): void {
    appendBatchCleanupNudge(messages, nudgeText)
}

export function isInternalAgentRequestExported(messages: WithParts[]): boolean {
    return isInternalAgentRequest(messages)
}

import { renderSystemPrompt } from "./prompts/system"
import type { PromptStore } from "./prompts/store"

export function createSystemPromptHandler(
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    prompts: PromptStore,
) {
    return async (_input: unknown, output: { system: string[] }) => {
        const systemPrompt = renderSystemPrompt({
            compressMode: config.compress.mode,
            showCompression: config.compress.showCompression,
            manualMode: config.manualMode.enabled,
            isSubAgent: state.isSubAgent,
            protectedTools: config.compress.protectedTools,
        })
        if (systemPrompt) {
            output.system.push(systemPrompt)
        }
    }
}

export {
    isMessageWithInfo,
    formatMessageRef,
    formatMessageIdTag,
    ensureSessionInitialized,
    checkSession,
    saveSessionState,
}
