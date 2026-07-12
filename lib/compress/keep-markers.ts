import type { WithParts } from "../state"
import type { SessionState } from "../state"
import type { PluginConfig } from "../config"

const KEEP_REGEX = /\[\[KEEP:(m\d+)\]\]/g
const REF_REGEX = /\[\[REF:(m\d+)\|([^\]]+)\]\]/g

export interface KeepMarkerResult {
    summary: string
    expandedCount: number
    refCount: number
    unresolvedRefs: string[]
}

export function resolveKeepMarkers(
    summary: string,
    messages: WithParts[],
    state: SessionState,
    config: PluginConfig,
): KeepMarkerResult {
    const msgByRef = new Map<string, WithParts>()
    for (const msg of messages) {
        const ref = state.messageIds.byRawId.get(msg.info.id)
        if (ref) msgByRef.set(ref, msg)
    }

    const maxChars = config.compress?.keepEmbedMaxChars ?? 2000
    let expandedCount = 0
    let refCount = 0
    const unresolvedRefs: string[] = []

    const expanded = summary
        .replace(KEEP_REGEX, (match, ref: string) => {
            const msg = msgByRef.get(ref)
            if (!msg) {
                unresolvedRefs.push(ref)
                return match
            }
            expandedCount++
            return formatKeptMessage(msg, ref, maxChars)
        })
        .replace(REF_REGEX, (_match, ref: string, desc: string) => {
            const msg = msgByRef.get(ref)
            if (!msg) {
                unresolvedRefs.push(ref)
                return _match
            }
            refCount++
            return `[→ ${ref}: ${desc.trim()}]`
        })

    return { summary: expanded, expandedCount, refCount, unresolvedRefs }
}

function formatKeptMessage(msg: WithParts, ref: string, maxChars: number): string {
    const formatted = formatByType(msg)
    const truncated = truncate(formatted, maxChars)
    return `\n--- [${ref}: ${labelForMessage(msg)}] ---\n${truncated}\n--- end ---\n`
}

function formatByType(msg: WithParts): string {
    for (const part of msg.parts || []) {
        if (part.type === "text" && typeof (part as any).text === "string") {
            return (part as any).text as string
        }
        if (part.type === "tool") {
            const tool = (part as any).tool || "unknown"
            const state = (part as any).state || {}
            const input = state.input || {}
            const output = state.output || ""

            switch (tool) {
                case "bash":
                case "interactive_bash": {
                    const cmd = typeof input === "string" ? input : input.command || JSON.stringify(input)
                    return `$ ${cmd}\n${output}`
                }
                case "read": {
                    const fp = input.filePath || input.path || input.file || ""
                    return output
                }
                case "write":
                case "edit": {
                    const fp = input.filePath || input.path || ""
                    const content = input.content || input.newString || ""
                    return `${fp}:\n${content}`
                }
                case "reply": {
                    return output || "[reply posted]"
                }
                case "grep":
                case "glob": {
                    return output
                }
                default: {
                    if (output && typeof output === "string" && output.length > 0) {
                        return output
                    }
                    const compact = JSON.stringify({ tool, input }, null, 0)
                    return compact.length > 500 ? compact.slice(0, 500) + "..." : compact
                }
            }
        }
    }
    return "[empty message]"
}

function labelForMessage(msg: WithParts): string {
    for (const part of msg.parts || []) {
        if (part.type === "tool") {
            const tool = (part as any).tool || "unknown"
            const input = (part as any).state?.input || {}
            const fp = input.filePath || input.path || input.command || ""
            return fp ? `${tool}: ${String(fp).slice(0, 60)}` : tool
        }
    }
    return msg.info.role === "user" ? "user" : "text"
}

function truncate(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text
    return text.slice(0, maxChars) + `\n... [truncated, ${text.length} chars total]`
}
