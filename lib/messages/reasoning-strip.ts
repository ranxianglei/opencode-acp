import type { WithParts } from "../state/types"
import { getLastUserMessage } from "./query"

type MutablePart = {
    type: string
    metadata?: unknown
}

export function stripStaleMetadata(messages: WithParts[]): void {
    if (!Array.isArray(messages) || messages.length === 0) return

    const lastUser = getLastUserMessage(messages)
    if (!lastUser) return

    const userInfo = lastUser.info as {
        role: string
        model?: { modelID?: string; providerID?: string } | null
    }
    if (!userInfo.model) return
    const userModelID = userInfo.model.modelID
    const userProviderID = userInfo.model.providerID

    for (const msg of messages) {
        if (!msg || !msg.info) continue
        if (msg.info.role !== "assistant") continue

        const assistantInfo = msg.info as {
            role: string
            modelID?: string
            providerID?: string
        }
        const assistantModelID = assistantInfo.modelID
        const assistantProviderID = assistantInfo.providerID

        if (
            userModelID !== undefined &&
            userModelID !== "" &&
            userProviderID !== undefined &&
            userProviderID !== "" &&
            assistantModelID === userModelID &&
            assistantProviderID === userProviderID
        ) {
            continue
        }

        for (const rawPart of msg.parts) {
            if (!rawPart) continue
            const part = rawPart as MutablePart
            if (
                part.type === "text" ||
                part.type === "tool" ||
                part.type === "reasoning"
            ) {
                if ("metadata" in part) {
                    delete part.metadata
                }
            }
        }
    }
}
