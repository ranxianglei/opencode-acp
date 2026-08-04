import type { CoreMessage } from "acp-kernel"
export type { CoreMessage } from "acp-kernel"
import type { WithParts } from "../state"

// Message projection between OpenCode's SDK shape (WithParts = { info, parts[] })
// and acp-kernel's CoreMessage. Phase 1: pure shape translation, not yet wired
// into the message-transform hook (that is Phase 2 — see devlog DESIGN.md §4).
//
// OpenCode Part kinds (see lib/message-ids.ts, lib/messages/utils.ts):
//   text      { type:"text", text, ignored? }
//   tool      { type:"tool", tool, callID, messageID?, state:{ status, input?, output?, error?, time? } }
//   reasoning { type:"reasoning", text }
//
// acp-kernel CoreMessage: { id, role, contentType:"text"|"tool-call"|"tool-result"|"reasoning", text?, toolName?, toolCallId? }
// A single OpenCode tool part spans the call AND its result (state.status
// pending→completed), so a completed tool part projects to TWO CoreMessages
// (tool-call + tool-result) sharing the same toolCallId — required so the
// kernel's protected-tool-pairing (Bug 39) and tool-pair boundary adjustment
// can match call↔result by toolCallId.

type AnyPart = {
    type?: string
    text?: string
    tool?: string
    callID?: string
    state?: {
        status?: string
        input?: unknown
        output?: unknown
        error?: string | { message?: string }
        time?: { start?: string; end?: string }
    }
}

function stringifyContent(value: unknown): string {
    if (value === undefined || value === null) return ""
    if (typeof value === "string") return value
    try {
        return JSON.stringify(value)
    } catch {
        return String(value)
    }
}

function extractText(parts: AnyPart[]): string {
    let text = ""
    for (const part of parts) {
        if (part.type === "text" && typeof part.text === "string") {
            text = text ? `${text}\n${part.text}` : part.text
        }
    }
    return text
}

function toolResultText(part: AnyPart): string {
    const state = part.state
    if (!state) return ""
    if (state.status === "error") {
        const err = state.error
        const msg = typeof err === "string" ? err : err?.message ?? ""
        return msg || "tool error"
    }
    if (state.output !== undefined && state.output !== null) {
        return stringifyContent(state.output)
    }
    return ""
}

export function withPartsToCoreMessages(messages: WithParts[]): CoreMessage[] {
    const out: CoreMessage[] = []
    for (const message of messages) {
        const id = message.info.id
        const role = message.info.role
        const parts = message.parts as AnyPart[]

        if (role === "user") {
            const text = extractText(parts)
            if (text.length > 0) {
                out.push({ id, role: "user", contentType: "text", text })
            }
            continue
        }

        if (role === "assistant") {
            const toolParts = parts.filter((p) => p.type === "tool" && typeof p.callID === "string")
            const reasoningText = parts
                .filter((p) => p.type === "reasoning" && typeof p.text === "string")
                .map((p) => p.text as string)
                .join("\n")
            const textBody = extractText(parts)

            if (toolParts.length === 0) {
                if (textBody.length > 0) {
                    out.push({ id, role: "assistant", contentType: "text", text: textBody })
                }
                if (reasoningText.length > 0) {
                    out.push({ id, role: "assistant", contentType: "reasoning", text: reasoningText })
                }
                continue
            }

            for (const part of toolParts) {
                const callID = part.callID as string
                const inputText = part.state?.input !== undefined ? stringifyContent(part.state.input) : ""
                out.push({
                    id: `${id}#${callID}`,
                    role: "assistant",
                    contentType: "tool-call",
                    toolName: part.tool,
                    toolCallId: callID,
                    text: inputText,
                })
                if (part.state?.status === "completed" || part.state?.status === "error") {
                    out.push({
                        id: `${id}#${callID}#result`,
                        role: "tool",
                        contentType: "tool-result",
                        toolName: part.tool,
                        toolCallId: callID,
                        text: toolResultText(part),
                    })
                }
            }
            if (reasoningText.length > 0) {
                out.push({ id, role: "assistant", contentType: "reasoning", text: reasoningText })
            }
            continue
        }

        // system / other roles: carry text through as-is so the kernel sees the
        // full window (it will classify system tokens in the context breakdown).
        const text = extractText(parts)
        if (text.length > 0) {
            out.push({ id, role: role === "system" ? "system" : "user", contentType: "text", text })
        }
    }
    return out
}

// Inverse: given the kernel's output CoreMessage[] and the original OpenCode
// messages (keyed by id), reconstruct the surviving OpenCode message list in
// order. Used by Phase 2 to convert processTurn output back to SDK messages.
//
// Rules (pai-acp coreOutToAgentMessages pattern):
//   - CoreMessages whose id starts with "acp_summary_" are synthetic recap
//     slots — skipped. With compress-as-anchor, summaries live inside the
//     model's own compress calls, so no synthetic message is emitted.
//   - A plain id (no '#') maps 1:1 to its original message.
//   - A split id ("baseId#callID[#result]") means the original assistant
//     message had multiple tool calls; reconstruct it keeping only the
//     surviving callIDs.
export function coreMessagesToWithParts(coreOut: CoreMessage[], originalById: Map<string, WithParts>): WithParts[] {
    const out: WithParts[] = []
    const emittedBase = new Set<string>()

    for (const core of coreOut) {
        if (core.id.startsWith("acp_summary_")) continue

        const hashIdx = core.id.indexOf("#")
        if (hashIdx < 0) {
            const original = originalById.get(core.id)
            if (original) out.push(original)
            continue
        }

        const baseId = core.id.substring(0, hashIdx)
        if (emittedBase.has(baseId)) continue
        emittedBase.add(baseId)

        const original = originalById.get(baseId)
        if (!original) continue

        const survivingCallIds = new Set(
            coreOut
                .filter((c) => c.id.startsWith(`${baseId}#`) && !c.id.startsWith("acp_summary_"))
                .map((c) => c.toolCallId)
                .filter((cid): cid is string => typeof cid === "string"),
        )

        out.push(reconstructMultiCallMessage(original, survivingCallIds))
    }

    return out
}

function reconstructMultiCallMessage(original: WithParts, survivingCallIds: Set<string>): WithParts {
    const filteredParts = (original.parts as AnyPart[]).filter((part) => {
        if (part.type === "tool" && typeof part.callID === "string") {
            return survivingCallIds.has(part.callID)
        }
        return true
    })
    return { info: original.info, parts: filteredParts as WithParts["parts"] }
}
