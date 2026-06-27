import type { SessionState, WithParts } from "../state/types"
import type { PluginConfig } from "../config/types"
import type { Logger } from "../infra/logger"
import type { CompressionResult, ResolvedRange } from "./types"
import { resolveBoundary, type ResolvedBoundary } from "./search"
import { allocateBlock, consumeBlocks } from "../state/mutations/blocks"
import { markPruned } from "../state/mutations/prune-map"
import { countTokensSync } from "../infra/token-counter"

export function collectRangeContent(
    state: SessionState,
    messages: WithParts[],
    boundary: ResolvedBoundary,
): ResolvedRange {
    const messageIds: string[] = []
    const toolIds: string[] = []
    const nestedBlockIds: number[] = []

    for (let i = boundary.startIndex; i <= boundary.endIndex; i++) {
        const msg = messages[i]
        if (!msg) continue

        messageIds.push(msg.info.id)

        const parts = Array.isArray(msg.parts) ? msg.parts : []
        for (const part of parts) {
            if (part.type === "tool") {
                const toolPart = part as { type: "tool"; callID: string }
                toolIds.push(toolPart.callID)
            }
        }

        const pruneEntry = state.prune.messages.byMessageId.get(msg.info.id)
        if (pruneEntry) {
            for (const blockId of pruneEntry.allBlockIds) {
                if (!nestedBlockIds.includes(blockId)) {
                    nestedBlockIds.push(blockId)
                }
            }
        }
    }

    return {
        startIndex: boundary.startIndex,
        endIndex: boundary.endIndex,
        messageIds,
        toolIds,
        nestedBlockIds,
    }
}

function computeCompressedTokens(
    state: SessionState,
    messages: WithParts[],
    range: ResolvedRange,
): number {
    let total = 0
    for (const msgId of range.messageIds) {
        const pruneEntry = state.prune.messages.byMessageId.get(msgId)
        if (pruneEntry) {
            total += pruneEntry.tokenCount
            continue
        }

        const msg = messages.find((m) => m.info.id === msgId)
        if (msg) {
            const parts = Array.isArray(msg.parts) ? msg.parts : []
            for (const part of parts) {
                if (part.type === "text" && "text" in part) {
                    const textPart = part as { text: string }
                    total += countTokensSync(textPart.text)
                }
            }
        }
    }
    return total
}

export function compressRange(
    config: PluginConfig,
    state: SessionState,
    logger: Logger,
    messages: WithParts[],
    startId: string,
    endId: string,
    summary: string,
    topic?: string,
    compressMessageId?: string,
): CompressionResult {
    const errors: string[] = []

    const boundary = resolveBoundary(state, messages, startId, endId, logger)
    if (!boundary) {
        errors.push(`Could not resolve boundaries: start=${startId}, end=${endId}`)
        return { blockIds: [], compressedTokens: 0, summaryTokens: countTokensSync(summary), errors }
    }

    const range = collectRangeContent(state, messages, boundary)

    const anchorMessage = messages[boundary.startIndex]
    const anchorMessageId = anchorMessage?.info.id ?? startId

    const compressedTokens = computeCompressedTokens(state, messages, range)
    const summaryTokens = countTokensSync(summary)

    const block = allocateBlock(state, {
        topic: topic ?? "compression",
        summary,
        startId,
        endId,
        anchorMessageId,
        compressMessageId: compressMessageId ?? "",
        compressedTokens,
        summaryTokens,
        mode: config.compress.mode,
        directMessageIds: range.messageIds,
        directToolIds: range.toolIds,
        effectiveMessageIds: range.messageIds,
        effectiveToolIds: range.toolIds,
        includedBlockIds: range.nestedBlockIds,
    })

    if (range.nestedBlockIds.length > 0) {
        consumeBlocks(state, range.nestedBlockIds, block.blockId)
    }

    markPruned(state, range.messageIds, block.blockId, compressedTokens)

    for (const toolId of range.toolIds) {
        state.prune.tools.set(toolId, block.blockId)
    }

    logger.info("Range compression completed", {
        blockId: block.blockId,
        messageCount: range.messageIds.length,
        compressedTokens,
        summaryTokens,
    })

    return {
        blockIds: [block.blockId],
        compressedTokens,
        summaryTokens,
        errors,
    }
}
