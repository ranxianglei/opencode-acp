import type { WithParts } from "../state/types"

export function isMessageWithInfo(msg: unknown): msg is WithParts {
    if (!msg || typeof msg !== "object") return false
    const m = msg as Partial<WithParts> & { parts?: unknown }
    if (!m.info || typeof m.info !== "object") return false
    const info = m.info as {
        id?: unknown
        sessionID?: unknown
        role?: unknown
        time?: { created?: unknown } | null
    }
    if (typeof info.id !== "string" || info.id === "") return false
    if (typeof info.sessionID !== "string" || info.sessionID === "") return false
    if (info.role !== "user" && info.role !== "assistant") return false
    if (!info.time || typeof info.time !== "object") return false
    if (typeof info.time.created !== "number") return false
    if (!m.parts) return false
    return true
}

export function filterMessages(messages: unknown): WithParts[] {
    if (!Array.isArray(messages)) return []
    return messages.filter((m) => isMessageWithInfo(m)) as WithParts[]
}

export function filterMessagesInPlace(messages: unknown): WithParts[] {
    if (!Array.isArray(messages)) return []
    for (let i = messages.length - 1; i >= 0; i--) {
        if (!isMessageWithInfo(messages[i])) {
            messages.splice(i, 1)
        }
    }
    return messages as WithParts[]
}
