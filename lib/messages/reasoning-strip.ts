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
