import type { Logger } from "../logger"
import type { CompressionBlock, SessionState, WithParts } from "../state"
import { syncCompressionBlocks } from "../messages"
import { parseBlockRef, formatBlockRef } from "../message-ids"
import { countTokens, getCurrentParams } from "../token-utils"
import { saveSessionState } from "../state/persistence"
import { sendIgnoredMessage } from "../ui/notification"
import { formatTokenCount } from "../ui/utils"
import {
    allocateBlockId,
    allocateRunId,
    wrapCompressedSummary,
    COMPRESSED_BLOCK_HEADER,
} from "../compress/state"

export interface MergeBlocksCommandContext {
    client: any
    state: SessionState
    logger: Logger
    sessionId: string
    messages: WithParts[]
    args: string[]
}

function parseBlockIdToken(token: string): number[] | null {
    const normalized = token.trim().toLowerCase()
    if (normalized.length === 0) {
        return null
    }

    if (normalized.includes("-")) {
        const parts = normalized.split("-")
        if (parts.length !== 2) {
            return null
        }
        const start = parseSingleBlockId(parts[0]!)
        const end = parseSingleBlockId(parts[1]!)
        if (start === null || end === null || end < start) {
            return null
        }
        const ids: number[] = []
        for (let id = start; id <= end; id++) {
            ids.push(id)
        }
        return ids
    }

    if (normalized.includes(",")) {
        const parts = normalized.split(",").map((p) => p.trim()).filter(Boolean)
        if (parts.length === 0) {
            return null
        }
        const ids: number[] = []
        for (const part of parts) {
            const id = parseSingleBlockId(part)
            if (id === null) {
                return null
            }
            ids.push(id)
        }
        return ids
    }

    const id = parseSingleBlockId(normalized)
    if (id === null) {
        return null
    }
    return [id]
}

function parseSingleBlockId(value: string): number | null {
    const normalized = value.trim().toLowerCase()
    if (normalized.length === 0) {
        return null
    }
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

function extractSummaryBody(summary: string): string {
    let body = summary
    const headerPrefix = COMPRESSED_BLOCK_HEADER + "\n"
    if (body.startsWith(headerPrefix)) {
        body = body.slice(headerPrefix.length)
    }
    body = body.replace(/\n<dcp-message-id[^>]*>b\d+<\/dcp-message-id>$/, "")
    return body.trim()
}

function formatRangeOrList(ids: number[]): string {
    if (ids.length === 0) {
        return ""
    }
    if (ids.length === 1) {
        return formatBlockRef(ids[0]!)
    }
    let contiguous = true
    for (let i = 1; i < ids.length; i++) {
        if (ids[i]! - ids[i - 1]! !== 1) {
            contiguous = false
            break
        }
    }
    if (contiguous) {
        return `${formatBlockRef(ids[0]!)}-${formatBlockRef(ids[ids.length - 1]!)}`
    }
    return ids.map((id) => formatBlockRef(id)).join(", ")
}

function formatMergeMessage(
    mergedCount: number,
    sourceIds: number[],
    newBlockId: number,
    savedTokens: number,
    sourceTokens: number,
    newTokens: number,
): string {
    const lines: string[] = []
    const rangeLabel = formatRangeOrList(sourceIds)
    lines.push(`Merged ${mergedCount} block${mergedCount === 1 ? "" : "s"} (${rangeLabel}) into ${formatBlockRef(newBlockId)}.`)
    lines.push(
        `Summary: ~${formatTokenCount(savedTokens)} saved (~${formatTokenCount(sourceTokens)} → ~${formatTokenCount(newTokens)}).`,
    )
    lines.push(`Deactivated: ${sourceIds.map((id) => formatBlockRef(id)).join(", ")}.`)
    return lines.join("\n")
}

export async function handleMergeBlocksCommand(ctx: MergeBlocksCommandContext): Promise<void> {
    const { client, state, logger, sessionId, messages, args } = ctx

    const params = getCurrentParams(state, messages, logger)

    if (args.length === 0) {
        await sendIgnoredMessage(
            client,
            sessionId,
            "Usage: /acp merge-blocks <range|list>\nExamples: /acp merge-blocks 421-428  ·  /acp merge-blocks 421,422,423",
            params,
            logger,
        )
        return
    }

    if (args.length > 1) {
        await sendIgnoredMessage(
            client,
            sessionId,
            "Invalid arguments. Usage: /acp merge-blocks <range|list>",
            params,
            logger,
        )
        return
    }

    const requestedIds = parseBlockIdToken(args[0]!)
    if (requestedIds === null || requestedIds.length === 0) {
        await sendIgnoredMessage(
            client,
            sessionId,
            "Could not parse block ids. Usage: /acp merge-blocks 421-428  or  /acp merge-blocks 421,422,423",
            params,
            logger,
        )
        return
    }

    syncCompressionBlocks(state, logger, messages)
    const messagesState = state.prune.messages

    const sourceBlocks: CompressionBlock[] = []
    const missingIds: number[] = []
    const inactiveIds: number[] = []
    const seen = new Set<number>()

    for (const id of requestedIds) {
        if (seen.has(id)) {
            continue
        }
        seen.add(id)
        const block = messagesState.blocksById.get(id)
        if (!block) {
            missingIds.push(id)
            continue
        }
        if (!block.active) {
            inactiveIds.push(id)
            continue
        }
        sourceBlocks.push(block)
    }

    if (missingIds.length > 0) {
        const refs = missingIds.map((id) => formatBlockRef(id)).join(", ")
        await sendIgnoredMessage(
            client,
            sessionId,
            `Block${missingIds.length === 1 ? "" : "s"} ${refs} not found.`,
            params,
            logger,
        )
        return
    }

    if (inactiveIds.length > 0) {
        const refs = inactiveIds.map((id) => formatBlockRef(id)).join(", ")
        await sendIgnoredMessage(
            client,
            sessionId,
            `Block${inactiveIds.length === 1 ? "" : "s"} ${refs} not active. Only active blocks can be merged.`,
            params,
            logger,
        )
        return
    }

    if (sourceBlocks.length < 2) {
        await sendIgnoredMessage(
            client,
            sessionId,
            "Need at least two blocks to merge. Nothing to do.",
            params,
            logger,
        )
        return
    }

    sourceBlocks.sort((a, b) => a.blockId - b.blockId)
    const sourceIds = sourceBlocks.map((block) => block.blockId)

    // Each source contributes a header carrying the (bN) placeholder so the
    // merged summary can be re-summarized later without losing block lineage.
    const sections = sourceBlocks.map((block) => {
        const topic = (block.topic || "(no topic)").replace(/\s+/g, " ").trim()
        const body = extractSummaryBody(block.summary)
        const header = `(b${block.blockId}) ${topic}`
        return body.length > 0 ? `${header}\n${body}` : header
    })
    const mergedBody = sections.join("\n---\n")

    const newBlockId = allocateBlockId(state)
    const newSummary = wrapCompressedSummary(newBlockId, mergedBody)
    const newSummaryTokens = countTokens(newSummary)

    const oldest = sourceBlocks[0]!
    const newest = sourceBlocks[sourceBlocks.length - 1]!

    const effectiveMessageIds = new Set<string>()
    const effectiveToolIds = new Set<string>()
    for (const block of sourceBlocks) {
        for (const id of block.effectiveMessageIds) effectiveMessageIds.add(id)
        for (const id of block.effectiveToolIds) effectiveToolIds.add(id)
    }

    const sourceTokens = sourceBlocks.reduce(
        (sum, block) => sum + (block.summaryTokens || Math.round(block.summary.length / 4)),
        0,
    )

    const mergedTopic = buildMergedTopic(sourceBlocks)
    const createdAt = Date.now()

    const mergedBlock: CompressionBlock = {
        blockId: newBlockId,
        runId: allocateRunId(state),
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        summaryTokens: newSummaryTokens,
        durationMs: 0,
        mode: "range",
        topic: mergedTopic,
        batchTopic: mergedTopic,
        startId: oldest.startId,
        endId: newest.endId,
        anchorMessageId: oldest.anchorMessageId,
        compressMessageId: "",
        compressCallId: undefined,
        includedBlockIds: [...sourceIds],
        consumedBlockIds: [...sourceIds],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: [...effectiveMessageIds],
        effectiveToolIds: [...effectiveToolIds],
        createdAt,
        summary: newSummary,
        survivedCount: 0,
        generation: "old",
    }

    // Insert the merged block before deactivating sources so syncCompressionBlocks
    // can wire up activeByAnchorMessageId / activeBlockIds correctly via the
    // consumedBlockIds mechanism.
    messagesState.blocksById.set(newBlockId, mergedBlock)

    syncCompressionBlocks(state, logger, messages)

    const savedTokens = Math.max(0, sourceTokens - newSummaryTokens)

    await saveSessionState(state, logger)

    const message = formatMergeMessage(
        sourceBlocks.length,
        sourceIds,
        newBlockId,
        savedTokens,
        sourceTokens,
        newSummaryTokens,
    )
    await sendIgnoredMessage(client, sessionId, message, params, logger)

    logger.info("Merge-blocks command completed", {
        newBlockId,
        sourceBlockIds: sourceIds,
        savedTokens,
        sourceTokens,
        newSummaryTokens,
    })
}

/**
 * Build a concise topic for the merged block. When all sources share the same
 * topic, reuse it; otherwise join the unique topics with " + ".
 */
function buildMergedTopic(sourceBlocks: CompressionBlock[]): string {
    const uniqueTopics: string[] = []
    const seen = new Set<string>()
    for (const block of sourceBlocks) {
        const topic = (block.topic || "(no topic)").replace(/\s+/g, " ").trim()
        if (topic.length === 0 || seen.has(topic)) {
            continue
        }
        seen.add(topic)
        uniqueTopics.push(topic)
    }
    if (uniqueTopics.length === 0) {
        return "Merged blocks"
    }
    if (uniqueTopics.length === 1) {
        return uniqueTopics[0]!
    }
    return `Merged: ${uniqueTopics.join(" + ")}`
}
