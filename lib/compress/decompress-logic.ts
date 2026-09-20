import type { CompressionBlock, PruneMessagesState, WithParts } from "../state"
import { parseBlockRef } from "../message-ids"
import { bumpPruneStructureVersion } from "../state/utils"
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
    options?: { full?: boolean },
): void {
    const deactivatedAt = Date.now()

    for (const block of target.blocks) {
        block.active = false
        block.deactivatedByUser = true
        block.deactivatedAt = deactivatedAt
        block.deactivatedByBlockId = undefined

        if (options?.full) {
            const visited = new Set<number>()
            const queue = [...block.consumedBlockIds]
            while (queue.length > 0) {
                const consumedId = queue.shift()!
                if (visited.has(consumedId)) continue
                visited.add(consumedId)
                const consumedBlock = messagesState.blocksById.get(consumedId)
                if (consumedBlock) {
                    consumedBlock.deactivatedByUserDeep = true
                    queue.push(...consumedBlock.consumedBlockIds)
                }
            }
        }
    }

    // [Issue #384] Block liveness changed — invalidate sync + hide-consumed
    // caches derived from previous versions.
    if (target.blocks.length > 0) {
        bumpPruneStructureVersion(messagesState)
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

export interface DecompressAvailabilityResult {
    /** Message IDs whose visibility this decompression would restore (membership-wise). */
    requiredMessageIds: string[]
    /** Subset of requiredMessageIds present in the fetched host history. */
    availableMessageIds: string[]
    /** Subset of requiredMessageIds absent from the fetched host history.
     * Non-empty ⇒ committing would claim restored content that does not exist. */
    missingMessageIds: string[]
}

/**
 * Compute the message IDs whose visibility changes if `targets` are deactivated.
 *
 * A message becomes visible iff every block currently covering it belongs to the
 * deactivation set AND (one-tier only) it is not re-covered by a consumed block
 * that syncCompressionBlocks will reactivate. One-tier decompression leaves
 * non-user-deactivated consumed blocks alive, so their covered messages stay
 * hidden and are not required sources; full decompression deep-deactivates them,
 * so everything under the targets must be present in history.
 *
 * The result is conservative by design: over-requiring an ID can only cause a
 * safe-direction abort, never a false "restored" claim.
 */
export function collectRequiredDecompressMessageIds(
    messagesState: PruneMessagesState,
    targets: CompressionTarget[],
    options: { full?: boolean } = {},
): string[] {
    const targetBlockIds = new Set<number>()
    for (const target of targets) {
        for (const block of target.blocks) {
            targetBlockIds.add(block.blockId)
        }
    }
    if (targetBlockIds.size === 0) {
        return []
    }

    // Transitive consumed closure of the target blocks.
    const consumedClosure = new Set<number>()
    const queue: number[] = []
    for (const target of targets) {
        for (const block of target.blocks) {
            for (const id of block.consumedBlockIds ?? []) {
                if (!consumedClosure.has(id)) {
                    queue.push(id)
                }
            }
        }
    }
    while (queue.length > 0) {
        const id = queue.shift()!
        if (consumedClosure.has(id)) continue
        consumedClosure.add(id)
        const consumed = messagesState.blocksById.get(id)
        if (consumed) {
            for (const nested of consumed.consumedBlockIds ?? []) {
                if (!consumedClosure.has(nested)) {
                    queue.push(nested)
                }
            }
        }
    }

    // One-tier: consumed blocks that sync will reactivate keep their messages hidden.
    let shieldedMessageIds: Set<string> | null = null
    if (!options.full) {
        shieldedMessageIds = new Set<string>()
        for (const id of consumedClosure) {
            const block = messagesState.blocksById.get(id)
            if (!block || block.deactivatedByUser || block.deactivatedByUserDeep) continue
            for (const messageId of block.effectiveMessageIds ?? []) {
                shieldedMessageIds.add(messageId)
            }
        }
    }

    const required: string[] = []
    for (const [messageId, entry] of messagesState.byMessageId) {
        if (entry.activeBlockIds.length === 0) continue
        let exclusivelyCoveredByTargets = true
        for (const blockId of entry.activeBlockIds) {
            if (!targetBlockIds.has(blockId)) {
                exclusivelyCoveredByTargets = false
                break
            }
        }
        if (!exclusivelyCoveredByTargets) continue
        if (shieldedMessageIds?.has(messageId)) continue
        required.push(messageId)
    }
    required.sort()
    return required
}

/**
 * [Issue #446] Verify that every source message a decompression would restore is
 * actually present in the fetched host history. Membership transitions alone prove
 * nothing about content: if the host removed the originals (native compaction,
 * external deletion), deactivating the target still reports "Restored N" while
 * nothing returns to context, stats are decremented by phantom tokens, and the
 * terminal user-deactivation discards the summary coverage.
 */
export function checkDecompressSourceAvailability(
    messagesState: PruneMessagesState,
    targets: CompressionTarget[],
    options: { full?: boolean },
    presentInHistory: Set<string>,
): DecompressAvailabilityResult {
    const requiredMessageIds = collectRequiredDecompressMessageIds(messagesState, targets, options)
    const available: string[] = []
    const missing: string[] = []
    for (const messageId of requiredMessageIds) {
        if (presentInHistory.has(messageId)) {
            available.push(messageId)
        } else {
            missing.push(messageId)
        }
    }
    return { requiredMessageIds, availableMessageIds: available, missingMessageIds: missing }
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
