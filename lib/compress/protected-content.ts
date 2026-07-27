import type { SessionState, WithParts } from "../state"
import type { CompressConfig } from "../config"
import { isIgnoredUserMessage, isSyntheticMessage } from "../messages/query"
import {
    getFilePathsFromParameters,
    isFilePathProtected,
    isToolNameProtected,
} from "../protected-patterns"
import { fetchSessionMessages } from "./search"
import type { SearchContext, SelectionResolution } from "./types"

export function appendProtectedUserMessages(
    summary: string,
    selection: SelectionResolution,
    searchContext: SearchContext,
    state: SessionState,
    enabled: boolean,
): string {
    if (!enabled) return summary

    const userTexts: string[] = []

    for (const messageId of selection.messageIds) {
        const existingCompressionEntry = state.prune.messages.byMessageId.get(messageId)
        if (existingCompressionEntry && existingCompressionEntry.activeBlockIds.length > 0) {
            continue
        }

        const message = searchContext.rawMessagesById.get(messageId)
        if (!message) continue
        if (message.info.role !== "user") continue
        if (isIgnoredUserMessage(message)) continue

        const parts = Array.isArray(message.parts) ? message.parts : []
        for (const part of parts) {
            if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
                userTexts.push(part.text)
                break
            }
        }
    }

    if (userTexts.length === 0) {
        return summary
    }

    const heading = "\n\nThe following user messages were sent in this conversation verbatim:"
    const body = userTexts.map((text) => `\n${text}`).join("")
    return summary + heading + body
}

export function appendProtectedPromptInfo(
    summary: string,
    selection: SelectionResolution,
    searchContext: SearchContext,
    state: SessionState,
    enabled: boolean,
): string {
    if (!enabled) return summary

    const protectedTexts: string[] = []

    for (const messageId of selection.messageIds) {
        const existingCompressionEntry = state.prune.messages.byMessageId.get(messageId)
        if (existingCompressionEntry && existingCompressionEntry.activeBlockIds.length > 0) {
            continue
        }

        const message = searchContext.rawMessagesById.get(messageId)
        if (!message) continue
        if (message.info.role !== "user") continue
        if (isIgnoredUserMessage(message)) continue

        const parts = Array.isArray(message.parts) ? message.parts : []
        for (const part of parts) {
            if (part.type !== "text" || typeof part.text !== "string") continue

            protectedTexts.push(...extractProtectedPromptInfo(part.text))
        }
    }

    if (protectedTexts.length === 0) {
        return summary
    }

    const heading =
        "\n\nThe following protected prompt information was included in this conversation verbatim:"
    const body = protectedTexts.map((text) => `\n${text}`).join("")
    return summary + heading + body
}

export function extractProtectedPromptInfo(text: string): string[] {
    const protectedTexts: string[] = []
    const protectTagRegex = /<protect>([\s\S]*?)<\/protect>/gi

    for (const match of text.matchAll(protectTagRegex)) {
        const protectedText = match[1]?.trim()
        if (protectedText) {
            protectedTexts.push(protectedText)
        }
    }

    return protectedTexts
}

export async function appendProtectedTools(
    client: any,
    state: SessionState,
    summary: string,
    selection: SelectionResolution,
    searchContext: SearchContext,
    protectedTools: string[],
    protectedFilePatterns: string[] = [],
): Promise<string> {
    const protectedOutputs: string[] = []

    for (const messageId of selection.messageIds) {
        const existingCompressionEntry = state.prune.messages.byMessageId.get(messageId)
        if (existingCompressionEntry && existingCompressionEntry.activeBlockIds.length > 0) {
            continue
        }

        const message = searchContext.rawMessagesById.get(messageId)
        if (!message) continue

        const parts = Array.isArray(message.parts) ? message.parts : []
        for (const part of parts) {
            if (part.type === "tool" && part.callID) {
                let isToolProtected = isToolNameProtected(part.tool, protectedTools)

                if (!isToolProtected && protectedFilePatterns.length > 0) {
                    const filePaths = getFilePathsFromParameters(part.tool, part.state?.input)
                    if (isFilePathProtected(filePaths, protectedFilePatterns)) {
                        isToolProtected = true
                    }
                }

                if (isToolProtected) {
                    const title = `Tool: ${part.tool}`
                    let output = ""

                    if (part.state?.status === "completed" && part.state?.output) {
                        output =
                            typeof part.state.output === "string"
                                ? part.state.output
                                : JSON.stringify(part.state.output)
                    }

                    if (output) {
                        protectedOutputs.push(`\n### ${title}\n${output}`)
                    }
                }
            }
        }
    }

    if (protectedOutputs.length === 0) {
        return summary
    }

    const heading = "\n\nThe following protected tools were used in this conversation as well:"
    return summary + heading + protectedOutputs.join("")
}

export function messageContainsProtectedTool(
    message: WithParts,
    protectedTools: string[],
    protectedFilePatterns: string[] = [],
): boolean {
    const parts = Array.isArray(message.parts) ? message.parts : []
    for (const part of parts) {
        if (part.type !== "tool" || !part.callID) continue

        if (isToolNameProtected(part.tool, protectedTools)) {
            return true
        }

        if (protectedFilePatterns.length > 0) {
            const filePaths = getFilePathsFromParameters(part.tool, part.state?.input)
            if (isFilePathProtected(filePaths, protectedFilePatterns)) {
                return true
            }
        }
    }
    return false
}

export function filterProtectedToolMessages(
    selection: SelectionResolution,
    searchContext: SearchContext,
    protectedTools: string[],
    protectedFilePatterns: string[] = [],
): SelectionResolution {
    const removedMessageIds = new Set<string>()
    const removedToolIds = new Set<string>()

    for (const messageId of selection.messageIds) {
        const message = searchContext.rawMessagesById.get(messageId)
        if (!message) continue

        if (messageContainsProtectedTool(message, protectedTools, protectedFilePatterns)) {
            removedMessageIds.add(messageId)
            const parts = Array.isArray(message.parts) ? message.parts : []
            for (const part of parts) {
                if (part.type === "tool" && part.callID) {
                    removedToolIds.add(part.callID)
                }
            }
        }
    }

    if (removedMessageIds.size === 0) {
        return selection
    }

    const filteredMessageIds = selection.messageIds.filter(
        (id) => !removedMessageIds.has(id),
    )
    const filteredMessageTokenById = new Map<string, number>()
    for (const id of filteredMessageIds) {
        const tokens = selection.messageTokenById.get(id)
        if (tokens !== undefined) {
            filteredMessageTokenById.set(id, tokens)
        }
    }
    const filteredToolIds = selection.toolIds.filter((id) => !removedToolIds.has(id))

    return {
        ...selection,
        messageIds: filteredMessageIds,
        messageTokenById: filteredMessageTokenById,
        toolIds: filteredToolIds,
    }
}

export function filterLastUserMessage(
    selection: SelectionResolution,
    searchContext: SearchContext,
    state: SessionState,
    compress: CompressConfig,
): SelectionResolution {
    if (compress.lastSegmentSoftBlock === false) return selection
    if (!(compress.preserveLastUserMessage ?? true)) return selection

    let lastUserMessageId: string | null = null
    for (let i = searchContext.rawMessages.length - 1; i >= 0; i--) {
        const msg = searchContext.rawMessages[i]
        const id = msg?.info?.id
        if (!id || typeof id !== "string") continue
        if (isSyntheticMessage(msg)) continue
        if (isIgnoredUserMessage(msg)) continue
        if (state.prune.messages.byMessageId.has(id)) continue
        if (msg.info.role === "user") {
            lastUserMessageId = id
            break
        }
    }

    if (!lastUserMessageId || !selection.messageIds.includes(lastUserMessageId)) {
        return selection
    }

    const filteredMessageIds = selection.messageIds.filter((id) => id !== lastUserMessageId)
    const filteredMessageTokenById = new Map<string, number>()
    for (const id of filteredMessageIds) {
        const tokens = selection.messageTokenById.get(id)
        if (tokens !== undefined) {
            filteredMessageTokenById.set(id, tokens)
        }
    }

    return {
        ...selection,
        messageIds: filteredMessageIds,
        messageTokenById: filteredMessageTokenById,
    }
}
