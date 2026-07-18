import type { CompressionBlock, PruneMessagesState, WithParts } from "../state"
import { parseBlockRef } from "../message-ids"
import type { CompressionTarget } from "../commands/compression-targets"

export function parseBlockIdArg(arg: string): number | null {
    const normalized = arg.trim().toLowerCase()
    const blockRef = parseBlockRef(normalized)
    if (blockRef !== null) {
        return blockRef
    }

    if (!/^[1-9]\d*$/.test(normalized)) {
        return null
    }

    const parsed = Number.parseInt(normalized, 10)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

export type DecompressMode = "block" | "range"

export function resolveDecompressMode(args: Record<string, unknown>):
    | { ok: true; mode: DecompressMode }
    | { ok: false; error: string } {
    const hasBlockId = typeof args.blockId === "string" && args.blockId.trim() !== ""
    const hasStartId = typeof args.startId === "string" && args.startId.trim() !== ""
    const hasEndId = typeof args.endId === "string" && args.endId.trim() !== ""

    if (hasBlockId && (hasStartId || hasEndId)) {
        return { ok: false, error: "Cannot specify both blockId and startId/endId. Choose one mode." }
    }
    if (!hasBlockId && !(hasStartId && hasEndId)) {
        return { ok: false, error: "Must specify either blockId, or both startId and endId." }
    }
    return { ok: true, mode: hasBlockId ? "block" : "range" }
}

export function findActiveBlocksOverlappingMessages(
    messagesState: PruneMessagesState,
    messageIds: Set<string>,
): CompressionBlock[] {
    if (messageIds.size === 0) {
        return []
    }

    const matched = new Map<number, CompressionBlock>()
    for (const [blockId, block] of messagesState.blocksById) {
        if (!block.active) {
            continue
        }
        const effectiveIds = block.effectiveMessageIds ?? []
        for (const msgId of effectiveIds) {
            if (messageIds.has(msgId)) {
                matched.set(blockId, block)
                break
            }
        }
    }

    return Array.from(matched.values()).sort((a, b) => a.blockId - b.blockId)
}

export function findActiveParentBlockId(
    messagesState: PruneMessagesState,
    block: CompressionBlock,
): number | null {
    const queue = [...block.parentBlockIds]
    const visited = new Set<number>()

    while (queue.length > 0) {
        const parentBlockId = queue.shift()
        if (parentBlockId === undefined || visited.has(parentBlockId)) {
            continue
        }
        visited.add(parentBlockId)

        const parent = messagesState.blocksById.get(parentBlockId)
        if (!parent) {
            continue
        }

        if (parent.active) {
            return parent.blockId
        }

        for (const ancestorId of parent.parentBlockIds) {
            if (!visited.has(ancestorId)) {
                queue.push(ancestorId)
            }
        }
    }

    return null
}

export function findActiveAncestorBlockId(
    messagesState: PruneMessagesState,
    target: CompressionTarget,
): number | null {
    for (const block of target.blocks) {
        const activeAncestorBlockId = findActiveParentBlockId(messagesState, block)
        if (activeAncestorBlockId !== null) {
            return activeAncestorBlockId
        }
    }

    return null
}

export function snapshotActiveMessages(messagesState: PruneMessagesState): Map<string, number> {
    const activeMessages = new Map<string, number>()
    for (const [messageId, entry] of messagesState.byMessageId) {
        if (entry.activeBlockIds.length > 0) {
            activeMessages.set(messageId, entry.tokenCount)
        }
    }
    return activeMessages
}

export function deactivateCompressionTarget(
    messagesState: PruneMessagesState,
    target: CompressionTarget,
): void {
    const deactivatedAt = Date.now()

    for (const block of target.blocks) {
        block.active = false
        block.deactivatedByUser = true
        block.deactivatedAt = deactivatedAt
        block.deactivatedByBlockId = undefined

        // [FIX Bug 10] Mark consumed inner blocks so syncCompressionBlocks won't re-activate them
        for (const consumedId of block.consumedBlockIds) {
            const consumedBlock = messagesState.blocksById.get(consumedId)
            if (consumedBlock) {
                consumedBlock.deactivatedByUser = true
            }
        }
    }
}

export interface RestoredMessagesResult {
    restoredMessageCount: number
    restoredTokens: number
}

export function computeRestoredMessages(
    messagesState: PruneMessagesState,
    activeMessagesBefore: Map<string, number>,
): RestoredMessagesResult {
    let restoredMessageCount = 0
    let restoredTokens = 0
    for (const [messageId, tokenCount] of activeMessagesBefore) {
        const entry = messagesState.byMessageId.get(messageId)
        const isActiveNow = entry ? entry.activeBlockIds.length > 0 : false
        if (!isActiveNow) {
            restoredMessageCount++
            restoredTokens += tokenCount
        }
    }
    return { restoredMessageCount, restoredTokens }
}

export function computeReactivatedBlockIds(
    messagesState: PruneMessagesState,
    activeBlockIdsBefore: Set<number>,
): number[] {
    return Array.from(messagesState.activeBlockIds)
        .filter((blockId) => !activeBlockIdsBefore.has(blockId))
        .sort((a, b) => a - b)
}

const MAX_PREVIEW_LENGTH = 2000
const MAX_MESSAGE_PREVIEW_LENGTH = 200

export function buildRestoredContentPreview(
    messages: WithParts[],
    activeMessagesBefore: Map<string, number>,
    messagesState: PruneMessagesState,
): string {
    const restoredMessages: WithParts[] = []
    for (const msg of messages) {
        const msgId = msg.info.id
        if (activeMessagesBefore.has(msgId)) {
            const entry = messagesState.byMessageId.get(msgId)
            const isActiveNow = entry ? entry.activeBlockIds.length > 0 : false
            if (!isActiveNow) {
                restoredMessages.push(msg)
            }
        }
    }

    if (restoredMessages.length === 0) {
        return ""
    }

    const lines: string[] = []
    let totalLength = 0

    for (const msg of restoredMessages) {
        if (totalLength >= MAX_PREVIEW_LENGTH) break

        const role = msg.info.role ?? "unknown"
        const textContent = extractTextContent(msg)
        const truncated =
            textContent.length > MAX_MESSAGE_PREVIEW_LENGTH
                ? textContent.slice(0, MAX_MESSAGE_PREVIEW_LENGTH) + "..."
                : textContent

        const line = `[${role}] ${truncated}`
        lines.push(line)
        totalLength += line.length + 1
    }

    return lines.join("\n")
}

function extractTextContent(msg: WithParts): string {
    if (!msg.parts || msg.parts.length === 0) {
        return ""
    }

    const textParts: string[] = []
    for (const part of msg.parts) {
        if (typeof part === "object" && part !== null) {
            if ("text" in part && typeof part.text === "string") {
                textParts.push(part.text)
            } else if ("type" in part && part.type === "tool") {
                const toolName = "tool" in part && typeof part.tool === "string" ? part.tool : "tool"
                const state = part.state as Record<string, unknown> | undefined
                if (state && typeof state.output === "string") {
                    const output =
                        state.output.length > 80
                            ? state.output.slice(0, 80) + "..."
                            : state.output
                    textParts.push(`[${toolName}] ${output}`)
                }
            }
        }
    }

    return textParts.join(" ").replace(/\s+/g, " ").trim()
}
