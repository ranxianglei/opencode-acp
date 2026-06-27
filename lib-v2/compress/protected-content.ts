import type { SessionState, WithParts } from "../state/types"
import type { PluginConfig } from "../config/types"
import type { Logger } from "../infra/logger"

const PROTECTED_USER_MSG_TAG = "[protected-user-messages]"
const PROTECTED_PROMPT_INFO_TAG = "[protected-prompt-info]"
const PROTECTED_TOOLS_TAG = "[protected-tools]"

export function appendProtectedUserMessages(
    config: PluginConfig,
    messages: WithParts[],
    messageIds: string[],
    summary: string,
): string {
    if (!config.compress.protectUserMessages) return summary

    const protectedMsgs: string[] = []
    for (const msgId of messageIds) {
        const msg = messages.find((m) => m.info.id === msgId)
        if (!msg || msg.info.role !== "user") continue

        const parts = Array.isArray(msg.parts) ? msg.parts : []
        for (const part of parts) {
            if (part.type === "text" && "text" in part) {
                const textPart = part as { text: string }
                if (textPart.text.trim()) {
                    protectedMsgs.push(textPart.text)
                }
            }
        }
    }

    if (protectedMsgs.length === 0) return summary

    return `${summary}\n\n${PROTECTED_USER_MSG_TAG}\n${protectedMsgs.join("\n---\n")}\n${PROTECTED_USER_MSG_TAG}`
}

export function appendProtectedPromptInfo(summary: string, info: string): string {
    if (!info.trim()) return summary
    return `${summary}\n\n${PROTECTED_PROMPT_INFO_TAG}\n${info}\n${PROTECTED_PROMPT_INFO_TAG}`
}

export function extractProtectedPromptInfo(summary: string): string | null {
    const start = summary.indexOf(PROTECTED_PROMPT_INFO_TAG)
    if (start === -1) return null

    const contentStart = start + PROTECTED_PROMPT_INFO_TAG.length
    const end = summary.indexOf(PROTECTED_PROMPT_INFO_TAG, contentStart)
    if (end === -1) return null

    return summary.slice(contentStart, end).trim()
}

export function appendProtectedTools(
    config: PluginConfig,
    messages: WithParts[],
    messageIds: string[],
    toolIds: string[],
    summary: string,
    logger: Logger,
): string {
    const protectedToolNames = new Set(config.compress.protectedTools)
    if (protectedToolNames.size === 0) return summary

    const protectedOutputs: string[] = []

    for (const msgId of messageIds) {
        const msg = messages.find((m) => m.info.id === msgId)
        if (!msg) continue

        const parts = Array.isArray(msg.parts) ? msg.parts : []
        for (const part of parts) {
            if (part.type !== "tool") continue
            const toolPart = part as {
                type: "tool"
                tool: string
                callID: string
                state: { status: string; output?: string; input?: unknown }
            }

            if (!protectedToolNames.has(toolPart.tool)) continue
            if (!toolIds.includes(toolPart.callID)) continue
            if (toolPart.state.status !== "completed") continue

            const output = toolPart.state.output ?? ""
            if (output.trim()) {
                protectedOutputs.push(`[${toolPart.tool}] ${output}`)
            }
        }
    }

    if (protectedOutputs.length === 0) return summary

    logger.debug("Appended protected tool outputs to summary", {
        count: protectedOutputs.length,
    })

    return `${summary}\n\n${PROTECTED_TOOLS_TAG}\n${protectedOutputs.join("\n---\n")}\n${PROTECTED_TOOLS_TAG}`
}
