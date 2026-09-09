import type { WithParts } from "../state"
import { getLastUserMessage } from "./query"

/**
 * Mirrors opencode's differentModel handling by preserving part content while
 * dropping provider metadata on assistant parts that came from a different
 * model/provider than the current turn's user message.
 */
export function stripStaleMetadata(messages: WithParts[]): void {
    const lastUserMessage = getLastUserMessage(messages)
    if (lastUserMessage?.info.role !== "user") {
        return
    }

    const modelID = lastUserMessage.info.model.modelID
    const providerID = lastUserMessage.info.model.providerID

    messages.forEach((message) => {
        if (message.info.role !== "assistant") {
            return
        }

        // [FIX Bug 8] Guard against undefined modelID/providerID
        const msgModelID = (message.info as any).modelID
        const msgProviderID = (message.info as any).providerID
        if (msgModelID === modelID && msgProviderID === providerID) {
            return
        }

        message.parts = message.parts.map((part) => {
            if (part.type !== "text" && part.type !== "tool" && part.type !== "reasoning") {
                return part
            }

            if (!("metadata" in part)) {
                return part
            }

            const { metadata: _metadata, ...rest } = part
            return rest
        })
    })
}

/**
 * Drop `reasoning` parts from HISTORICAL `compress` tool-call messages (#368).
 *
 * `compress` tool-call messages are hard-excluded from every compression
 * selection (Bug 39) and therefore re-sent every request, with their
 * `reasoning` riding along — a monotonically growing floor that compression
 * can never reclaim. This request-time pass removes ONLY the `reasoning`
 * parts from such messages when BOTH gates hold:
 *
 *   1. turn-closure: the message is strictly before the last genuine user
 *      message. The current, possibly-open round is never touched — providers
 *      may require replaying the active round's thinking.
 *   2. per-message size: the message's total reasoning length EXCEEDS
 *      `threshold` chars (owner decision: single-thinking size — small
 *      thinkings are left alone; only oversized ones are dropped; not
 *      accumulated). `threshold: 0` drops unconditionally.
 *
 * The tool call and every non-reasoning part are preserved. Only messages
 * carrying a `compress` tool part are selected (NOT other protected tools).
 * No state/DB writes; deterministic (prefix-cache-stable within a turn).
 *
 * @returns the number of `reasoning` parts removed.
 */
export function dropCompressReasoning(messages: WithParts[], threshold: number): number {
    const lastUserMessage = getLastUserMessage(messages)
    if (!lastUserMessage || lastUserMessage.info.role !== "user") {
        return 0
    }

    // Index of the last genuine user message = start of the current round.
    // Only messages strictly before it belong to closed historical turns.
    const lastUserIndex = messages.lastIndexOf(lastUserMessage)
    if (lastUserIndex <= 0) {
        return 0
    }

    let removed = 0

    for (let i = 0; i < lastUserIndex; i++) {
        const message = messages[i]
        if (!message || message.info.role !== "assistant") {
            continue
        }

        const parts = Array.isArray(message.parts) ? message.parts : []
        let hasCompressTool = false
        let reasoningLength = 0

        for (const part of parts) {
            if (part.type === "tool" && part.tool === "compress") {
                hasCompressTool = true
            } else if (part.type === "reasoning") {
                reasoningLength += part.text.length
            }
        }

        if (!hasCompressTool) {
            continue
        }
        if (reasoningLength <= threshold) {
            continue
        }

        const filtered = parts.filter((part) => part.type !== "reasoning")
        if (filtered.length === parts.length) {
            continue
        }
        message.parts = filtered
        removed += parts.length - filtered.length
    }

    return removed
}
