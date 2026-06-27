import type { SessionState, WithParts } from "./state/types"
import type { Logger } from "./infra/logger"
import type { PluginConfig } from "./config/types"
import type { HostPermissionSnapshot } from "./host-permissions"
import {
    stripHallucinations,
    stripHallucinationsFromString,
    appendToLastTextPart,
} from "./messages/utils"
import { filterMessagesInPlace, isMessageWithInfo } from "./messages/shape"
import { assignMessageRefs } from "./message-ids"
import { getLastUserMessage } from "./messages/query"
import { resolveEffectiveCompressPermission } from "./host-permissions"

export { handleMessageTransform, createPluginEntry, type PluginContext } from "./plugin/entry"

const INTERNAL_AGENT_NAMES = new Set(["title", "summary", "compaction"])

function isInternalAgentRequest(messages: WithParts[]): boolean {
    const lastUserMessage = getLastUserMessage(messages)
    if (!lastUserMessage) {
        return false
    }
    const agent = (lastUserMessage.info as { agent?: unknown }).agent
    return typeof agent === "string" && INTERNAL_AGENT_NAMES.has(agent)
}

function syncCompressPermissionState(
    state: SessionState,
    config: PluginConfig,
    hostPermissions: HostPermissionSnapshot,
): void {
    const effective = resolveEffectiveCompressPermission(
        config.compress.permission,
        hostPermissions,
    )
    if (effective && effective !== config.compress.permission) {
        ;(state as { compressPermissionOverride?: string }).compressPermissionOverride = effective
    }
}

function effectiveCompressPermission(
    state: SessionState,
    config: PluginConfig,
): PluginConfig["compress"]["permission"] {
    const override = (state as { compressPermissionOverride?: string }).compressPermissionOverride
    if (
        override === "ask" ||
        override === "allow" ||
        override === "deny"
    ) {
        return override
    }
    return config.compress.permission
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

        if (messages.length === 0) {
            return
        }

        if (isInternalAgentRequest(messages)) {
            logger.debug("Skipping message transform for internal agent request")
            return
        }

        syncCompressPermissionState(state, config, hostPermissions)

        if (state.isSubAgent && !config.experimental.allowSubAgents) {
            return
        }

        const permission = effectiveCompressPermission(state, config)
        if (permission === "deny") {
            stripHallucinations(output.messages)
            return
        }

        stripHallucinations(output.messages)
        assignMessageRefs(state, output.messages)

        try {
            const { injectMessageIds, injectCompressNudges } = await import("./messages/inject/inject")
            const { buildPriorityMap } = await import("./messages/priority")
            const { applyAnchoredNudges } = await import("./messages/inject/utils")

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
                injectMessageIds(state, config, output.messages)
                const runtimePrompts = typeof p.getRuntimePrompts === "function" ? p.getRuntimePrompts() : undefined
                if (runtimePrompts) {
                    applyAnchoredNudges(
                        state,
                        config,
                        output.messages,
                        {
                            system: "",
                            compressRange: "",
                            compressMessage: "",
                            contextLimitNudge: runtimePrompts.contextLimitNudge ?? "",
                            turnNudge: runtimePrompts.turnNudge ?? "",
                            iterationNudge: runtimePrompts.iterationNudge ?? "",
                        },
                        compressionPriorities,
                    )
                }
            }
        } catch (error) {
            logger.debug("Optional pipeline stages failed", { error: String(error) })
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

export function createEventHandler(
    state: SessionState,
    logger: Logger,
): (input: { event: unknown }) => Promise<void> {
    return async function (_input) {
        void state
        void logger
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
    return async function (_input, _output) {
        void client
        void state
        void logger
        void config
        void workingDirectory
        void hostPermissions
    }
}

export function appendBatchCleanupNudge(messages: WithParts[], nudgeText: string): void {
    const lastUser = getLastUserMessage(messages)
    if (!lastUser) return
    appendToLastTextPart(lastUser, nudgeText)
}

export function isInternalAgentRequestExported(messages: WithParts[]): boolean {
    return isInternalAgentRequest(messages)
}

export { isMessageWithInfo }
