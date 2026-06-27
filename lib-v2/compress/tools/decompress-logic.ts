// Class B — migrated from v1 lib/compress/decompress-logic.ts with interface adaptation.
// Imports adapted to lib-v2 paths; CompressionTarget inlined (v2 has no commands/compression-targets).

import type {
    CompressionBlock,
    PruneMessagesState,
    WithParts,
} from "../../state/types"
import { parseBlockRef } from "../../infra/message-refs"

export interface CompressionTarget {
    displayId: number
    runId: number
    topic: string
    compressedTokens: number
    durationMs: number
    grouped: boolean
    blocks: CompressionBlock[]
}

export function resolveCompressionTarget(
    messagesState: PruneMessagesState,
    blockId: number,
): CompressionTarget | null {
    const block = messagesState.blocksById.get(blockId)
    if (!block) {
        return null
    }

    if (block.mode !== "message") {
        return buildTarget([block])
    }

    const blocks = Array.from(messagesState.blocksById.values()).filter(
        (candidate) => candidate.mode === "message" && candidate.runId === block.runId,
    )
    if (blocks.length === 0) {
        return null
    }

    return buildTarget(blocks)
}

function buildTarget(blocks: CompressionBlock[]): CompressionTarget {
    const ordered = [...blocks].sort(byBlockId)
    const first = ordered[0]
    if (!first) {
        throw new Error("Cannot build compression target from empty block list.")
    }

    const grouped = first.mode === "message"
    return {
        displayId: first.blockId,
        runId: first.runId,
        topic: grouped ? first.batchTopic || first.topic : first.topic,
        compressedTokens: ordered.reduce((total, b) => total + b.compressedTokens, 0),
        durationMs: ordered.reduce((total, b) => Math.max(total, b.durationMs), 0),
        grouped,
        blocks: ordered,
    }
}

function byBlockId(a: CompressionBlock, b: CompressionBlock): number {
    return a.blockId - b.blockId
}

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
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : null
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

        messagesState.activeBlockIds.delete(block.blockId)
        if (block.anchorMessageId) {
            const current = messagesState.activeByAnchorMessageId.get(block.anchorMessageId)
            if (current === block.blockId) {
                messagesState.activeByAnchorMessageId.delete(block.anchorMessageId)
            }
        }

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
