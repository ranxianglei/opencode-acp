import type { SessionState } from "../state/types"
import { isIgnoredUserMessage } from "../messages/query"
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
            const p = part as { type?: string; text?: unknown }
            if (p.type === "text" && typeof p.text === "string" && p.text.trim()) {
                userTexts.push(p.text)
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
            const p = part as { type?: string; text?: unknown }
            if (p.type !== "text" || typeof p.text !== "string") continue

            protectedTexts.push(...extractProtectedPromptInfo(p.text))
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

function isToolNameProtected(toolName: string, protectedTools: string[]): boolean {
    if (!Array.isArray(protectedTools)) return false
    if (protectedTools.length === 0) return false
    if (protectedTools.includes(toolName)) return true
    return protectedTools.some((pattern) => {
        if (!pattern.includes("*")) return false
        const regexStr = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
        return new RegExp(`^${regexStr}$`).test(toolName)
    })
}

function getFilePathsFromParameters(toolName: string, input: unknown): string[] {
    if (!input || typeof input !== "object") return []
    const obj = input as Record<string, unknown>
    const paths: string[] = []
    for (const key of ["filePath", "path", "file", "fileName"]) {
        const v = obj[key]
        if (typeof v === "string") paths.push(v)
    }
    return paths
}

function isFilePathProtected(filePaths: string[], patterns: string[]): boolean {
    if (!patterns || patterns.length === 0) return false
    for (const fp of filePaths) {
        for (const pattern of patterns) {
            if (!pattern) continue
            if (pattern.includes("*")) {
                const regexStr = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
                if (new RegExp(`^${regexStr}$`).test(fp)) return true
            } else if (fp === pattern || fp.includes(pattern)) {
                return true
            }
        }
    }
    return false
}

function getSubAgentId(part: any): string | null {
    const output = part?.state?.output
    if (typeof output !== "string") return null
    const match = output.match(/ses_[A-Za-z0-9_-]+/)
    return match ? match[0] : null
}

function buildSubagentResultText(messages: any[]): string {
    const assistantTexts: string[] = []
    for (const msg of messages) {
        if (!msg || msg.info?.role !== "assistant") continue
        const parts = Array.isArray(msg.parts) ? msg.parts : []
        for (const part of parts) {
            const p = part as { type?: string; text?: unknown }
            if (p.type === "text" && typeof p.text === "string" && p.text.trim()) {
                assistantTexts.push(p.text)
            }
        }
    }
    return assistantTexts.join("\n\n")
}

function mergeSubagentResult(originalOutput: string, subAgentResult: string): string {
    if (!subAgentResult) return originalOutput
    return `${originalOutput}\n\n--- Sub-agent result ---\n${subAgentResult}`
}

export async function appendProtectedTools(
    client: any,
    state: SessionState,
    allowSubAgents: boolean,
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
            const p = part as { type?: string; callID?: string; tool?: string; state?: any }
            if (p.type !== "tool" || !p.callID) continue

            let isToolProtected = isToolNameProtected(p.tool || "", protectedTools)

            if (!isToolProtected && protectedFilePatterns.length > 0) {
                const filePaths = getFilePathsFromParameters(p.tool || "", p.state?.input)
                if (isFilePathProtected(filePaths, protectedFilePatterns)) {
                    isToolProtected = true
                }
            }

            if (isToolProtected) {
                const title = `Tool: ${p.tool}`
                let output = ""

                if (p.state?.status === "completed" && p.state?.output) {
                    output =
                        typeof p.state.output === "string"
                            ? p.state.output
                            : JSON.stringify(p.state.output)
                }

                if (
                    allowSubAgents &&
                    p.tool === "task" &&
                    p.state?.status === "completed" &&
                    typeof p.state?.output === "string"
                ) {
                    const cachedSubAgentResult = state.subAgentResultCache.get(p.callID)

                    if (cachedSubAgentResult !== undefined) {
                        if (cachedSubAgentResult) {
                            output = mergeSubagentResult(
                                p.state.output,
                                cachedSubAgentResult,
                            )
                        }
                    } else {
                        const subAgentSessionId = getSubAgentId(part)
                        if (subAgentSessionId) {
                            let subAgentResultText = ""
                            try {
                                const subAgentMessages = await fetchSessionMessages(
                                    client,
                                    subAgentSessionId,
                                )
                                subAgentResultText = buildSubagentResultText(subAgentMessages)
                            } catch {
                                subAgentResultText = ""
                            }

                            if (subAgentResultText) {
                                state.subAgentResultCache.set(p.callID, subAgentResultText)
                                output = mergeSubagentResult(
                                    p.state.output,
                                    subAgentResultText,
                                )
                            }
                        }
                    }
                }

                if (output) {
                    protectedOutputs.push(`\n### ${title}\n${output}`)
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
