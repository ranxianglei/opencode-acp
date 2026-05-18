import type { PluginConfig } from "../config"
import type { WithParts } from "../state"
import { isMessageWithInfo } from "./shape"

export const getLastUserMessage = (
    messages: WithParts[],
    startIndex?: number,
): WithParts | null => {
    const start = startIndex ?? messages.length - 1
    for (let i = start; i >= 0; i--) {
        const msg = messages[i]
        if (!isMessageWithInfo(msg)) {
            continue
        }
        if (msg.info.role === "user" && !isIgnoredUserMessage(msg)) {
            return msg
        }
    }
    return null
}

export const messageHasCompress = (message: WithParts): boolean => {
    if (!isMessageWithInfo(message)) {
        return false
    }

    if (message.info.role !== "assistant") {
        return false
    }

    const parts = Array.isArray(message.parts) ? message.parts : []
    return parts.some(
        (part) =>
            part.type === "tool" && part.tool === "compress" && part.state?.status === "completed",
    )
}

export const isIgnoredUserMessage = (message: WithParts): boolean => {
    if (!isMessageWithInfo(message)) {
        return false
    }

    if (message.info.role !== "user") {
        return false
    }

    const parts = Array.isArray(message.parts) ? message.parts : []
    if (parts.length === 0) {
        return true
    }

    for (const part of parts) {
        if (!(part as any).ignored) {
            return false
        }
    }

    return true
}

export function isProtectedUserMessage(config: PluginConfig, message: WithParts): boolean {
    if (!isMessageWithInfo(message)) {
        return false
    }

    return (
        config.compress.mode === "message" &&
        config.compress.protectUserMessages &&
        message.info.role === "user" &&
        !isIgnoredUserMessage(message)
    )
}
