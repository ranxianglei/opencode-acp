import type { WithParts } from "../state"
import type { PluginConfig } from "../config"
import type { Logger } from "../logger"
import { countTokens } from "../token-utils"
import type { AcpCoreRuntime } from "./runtime"
import { withPartsToCoreMessages, reconstructMessages } from "./messages"
import { renderNudgeText } from "acp-kernel"
import { renderAcpSystemPrompt } from "./system-prompt"
import { handleAcpCommand } from "./commands"

const INTERNAL_AGENT_NAMES = new Set(["title", "summary", "compaction"])
const INTERNAL_AGENT_SIGNATURES = [
    "You are a title generator",
    "You are a helpful AI assistant tasked with summarizing conversations",
    "Summarize what was done in this conversation",
]

type AnyPart = { type?: string; text?: string; agent?: unknown }
type AnyMessageInfo = { id: string; role: string; sessionID?: string; agent?: unknown }

function getLastUserMessage(messages: WithParts[]): WithParts | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]!.info.role === "user") return messages[i]
    }
    return undefined
}

function isInternalAgentRequest(messages: WithParts[]): boolean {
    const lastUser = getLastUserMessage(messages)
    if (!lastUser) return false
    const agent = (lastUser.info as AnyMessageInfo).agent
    return typeof agent === "string" && INTERNAL_AGENT_NAMES.has(agent)
}

function estimateInputTokens(coreTexts: string[]): number {
    let total = 0
    for (const text of coreTexts) total += countTokens(text)
    return total
}

export interface SessionModelLimits {
    get(sessionId: string): number | undefined
    set(sessionId: string, limit: number): void
}

export function createSessionModelLimits(): SessionModelLimits {
    const map = new Map<string, number>()
    return {
        get: (sid) => map.get(sid),
        set: (sid, limit) => {
            map.set(sid, limit)
        },
    }
}

export function createSystemPromptHandler(
    logger: Logger,
    config: PluginConfig,
    modelLimits: SessionModelLimits,
) {
    return async (
        input: { sessionID?: string; model?: { limit?: { context?: number } } },
        output: { system: string[] },
    ) => {
        if (input.sessionID && input.model?.limit?.context) {
            modelLimits.set(input.sessionID, input.model.limit.context)
        }
        if (config.compress.permission === "deny") return

        const systemText = output.system.join("\n")
        if (INTERNAL_AGENT_SIGNATURES.some((sig) => systemText.includes(sig))) {
            logger.info("Skipping ACP system prompt for internal agent")
            return
        }

        const prompt = renderAcpSystemPrompt()
        if (output.system.length > 0) {
            output.system[output.system.length - 1] += "\n\n" + prompt
        } else {
            output.system.push(prompt)
        }
    }
}

function injectNudge(messages: WithParts[], nudgeText: string): void {
    const lastUser = getLastUserMessage(messages)
    if (lastUser) {
        ;(lastUser.parts as AnyPart[]).push({ type: "text", text: nudgeText })
        return
    }
    messages.push({
        info: { id: `acp_nudge_${Date.now()}`, role: "user", sessionID: "" } as any,
        parts: [{ type: "text", text: nudgeText }] as any,
    })
}

export function createChatMessageTransformHandler(
    client: any,
    runtime: AcpCoreRuntime,
    logger: Logger,
    config: PluginConfig,
    modelLimits: SessionModelLimits,
) {
    return async (_input: unknown, output: { messages: WithParts[] }) => {
        const messages = output.messages
        if (!Array.isArray(messages) || messages.length === 0) return

        if (isInternalAgentRequest(messages)) {
            logger.debug("Skipping transform for internal agent request")
            return
        }

        const lastUser = getLastUserMessage(messages)
        const sessionId = (lastUser?.info as AnyMessageInfo)?.sessionID
        if (!sessionId) return

        const release = await runtime.acquireLock(sessionId)
        try {
            const originalById = new Map<string, WithParts>()
            for (const m of messages) originalById.set(m.info.id, m)

            const { state, coreMessages } = await runtime.stateFor(sessionId, messages)
            const modelContextLimit = modelLimits.get(sessionId)
            const kernelConfig = runtime.configFor(config, modelContextLimit)
            const tokenCount = estimateInputTokens(coreMessages.map((c) => c.text ?? ""))

            const result = runtime.core.processTurn({
                messages: coreMessages,
                state,
                config: kernelConfig,
                tokenCount,
            })

            const { messages: reconstructed } = reconstructMessages(
                result.messages,
                originalById,
            )

            output.messages = reconstructed

            const nudge = result.nudge
            if (nudge?.shouldInject) {
                const rendered = renderNudgeText(nudge)
                injectNudge(output.messages, rendered.text)
                logger.debug("ACP nudge injected", { voice: rendered.voice, reason: nudge.reason })
            }

            await runtime.save(result.state, sessionId)
        } finally {
            release()
        }
    }
}

export function createTextCompleteHandler() {
    return async (_input: unknown, output: { text: string }) => {
        if (typeof output.text === "string") {
            output.text = output.text.replace(/<acp[^>]*>m\d{1,5}<\/acp>/g, "")
        }
    }
}

export function createCommandExecuteHandler(
    client: any,
    runtime: AcpCoreRuntime,
    logger: Logger,
    config: PluginConfig,
    modelLimits: SessionModelLimits,
) {
    return async (
        input: { command: string; sessionID: string; arguments: string },
        _output: { parts: any[] },
    ) => {
        if (!config.commands.enabled) return
        if (input.command !== "acp" && input.command !== "dcp") return
        if (config.compress.permission === "deny") return

        const messagesResponse = await client.session.messages({ path: { id: input.sessionID } })
        const messages: WithParts[] = (messagesResponse.data || messagesResponse) as WithParts[]

        const handled = await handleAcpCommand({
            subcommand: (input.arguments ?? "").trim().toLowerCase(),
            messages,
            runtime,
            config,
            modelLimits,
            sessionId: input.sessionID,
            client,
            logger,
        })
        if (handled) throw new Error("__ACP_CONTEXT_HANDLED__")
    }
}

export function createEventHandler(_logger: Logger) {
    return async (_input: { event: any }) => {
        // Compress-timing attachment is a non-essential nicety; the kernel's
        // CompressionBlock.durationMs is optional. Reserved for a follow-up.
    }
}
