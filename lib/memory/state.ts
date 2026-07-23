import type { SessionState, MemoryEntry } from "../state/types"
import type { Logger } from "../logger"

export function formatMemoryId(n: number): string {
    return `mem_${String(n).padStart(3, "0")}`
}

export function recordMemory(
    state: SessionState,
    messageId: string,
    topic: string,
    logger: Logger,
): MemoryEntry {
    const id = formatMemoryId(state.memories.nextId)
    const entry: MemoryEntry = {
        id,
        messageId,
        topic,
        createdAt: Date.now(),
        forgotten: false,
    }
    state.memories.entries.set(id, entry)
    state.memories.nextId += 1
    logger.info("Recorded memory", { id, topic, messageId })
    return entry
}

export function forgetMemory(state: SessionState, id: string): boolean {
    const entry = state.memories.entries.get(id)
    if (!entry) return false
    entry.forgotten = true
    return true
}

export function listMemories(state: SessionState): MemoryEntry[] {
    return Array.from(state.memories.entries.values()).sort((a, b) => a.createdAt - b.createdAt)
}

export function getActiveMemoryMessageIds(state: SessionState): Set<string> {
    const forgotten = new Set<string>()
    if (!state.memories) return forgotten
    for (const entry of state.memories.entries.values()) {
        if (entry.forgotten) {
            forgotten.add(entry.messageId)
        }
    }
    return forgotten
}
