import type { SessionState, WithParts } from "../state/types"
import type { PluginConfig } from "../config/types"
import type { Logger } from "../infra/logger"
import type { CompressionResult, ResolvedMessage } from "./types"
import { allocateBlock } from "../state/mutations/blocks"
import { markPruned } from "../state/mutations/prune-map"
import { countTokensSync } from "../infra/token-counter"
import { resolveMessageRef } from "./search"

export function resolveMessageIds(
    state: SessionState,
    messages: WithParts[],
    ids: string[],
    logger: Logger,
): ResolvedMessage[] {
    const results: ResolvedMessage[] = []

    for (const id of ids) {
        const msg = resolveMessageRef(state, messages, id, logger)
        if (!msg) {
            results.push({ messageId: id, index: -1, valid: false })
        } else {
            const index = messages.indexOf(msg)
            results.push({ messageId: msg.info.id, index, valid: true })
        }
    }

    return results
}

function collectToolIdsForMessage(msg: WithParts): string[] {
    const toolIds: string[] = []
    const parts = Array.isArray(msg.parts) ? msg.parts : []
    for (const part of parts) {
        if (part.type === "tool") {
            const toolPart = part as { type: "tool"; callID: string }
            toolIds.push(toolPart.callID)
        }
    }
    return toolIds
}

function computeMessageTokens(state: SessionState, msg: WithParts): number {
    const pruneEntry = state.prune.messages.byMessageId.get(msg.info.id)
    if (pruneEntry) {
        return pruneEntry.tokenCount
    }

    let total = 0
    const parts = Array.isArray(msg.parts) ? msg.parts : []
    for (const part of parts) {
        if (part.type === "text" && "text" in part) {
            const textPart = part as { text: string }
            total += countTokensSync(textPart.text)
        }
    }
    return total
}

export function compressMessages(
    config: PluginConfig,
    state: SessionState,
    logger: Logger,
    messages: WithParts[],
    ids: string[],
    summary: string,
    topic?: string,
    compressMessageId?: string,
): CompressionResult {
    const errors: string[] = []
    const resolved = resolveMessageIds(state, messages, ids, logger)
    const valid = resolved.filter((r) => r.valid)

    if (valid.length === 0) {
        errors.push(`No valid message IDs found in: ${ids.join(", ")}`)
        return { blockIds: [], compressedTokens: 0, summaryTokens: countTokensSync(summary), errors }
    }

    const runId = state.prune.messages.nextRunId
    const blockIds: number[] = []
    let totalCompressedTokens = 0

    for (const res of valid) {
        const msg = messages[res.index]!
        const messageIds = [msg.info.id]
        const toolIds = collectToolIdsForMessage(msg)
        const compressedTokens = computeMessageTokens(state, msg)
        const summaryTokens = countTokensSync(summary)

        const block = allocateBlock(state, {
            topic: topic ?? "message compression",
            summary,
            startId: res.messageId,
            endId: res.messageId,
            anchorMessageId: res.messageId,
            compressMessageId: compressMessageId ?? "",
            compressedTokens,
            summaryTokens,
            mode: "message",
            runId,
            directMessageIds: messageIds,
            directToolIds: toolIds,
            effectiveMessageIds: messageIds,
            effectiveToolIds: toolIds,
        })

        blockIds.push(block.blockId)
        totalCompressedTokens += compressedTokens

        markPruned(state, messageIds, block.blockId, compressedTokens)

        for (const toolId of toolIds) {
            state.prune.tools.set(toolId, block.blockId)
        }
    }

    state.prune.messages.nextRunId = runId + 1

    logger.info("Message compression completed", {
        blockIds,
        messageCount: valid.length,
        compressedTokens: totalCompressedTokens,
    })

    return {
        blockIds,
        compressedTokens: totalCompressedTokens,
        summaryTokens: countTokensSync(summary),
        errors,
    }
}
