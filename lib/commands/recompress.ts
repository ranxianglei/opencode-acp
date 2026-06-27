import type { SessionState, PruneMessagesState } from "../state/types"
import type { CommandContext, CommandResult } from "./types"
import { parseBlockIds } from "./decompress"
import { formatTokenCount } from "../ui/utils"
import type { Logger } from "../infra/logger"
import type { WithParts } from "../state/types"
import { syncCompressionBlocks } from "../messages/sync"
import { saveSessionState } from "../state/persistence"
import { parseBlockRef } from "../infra/message-refs"
import {
    getRecompressibleCompressionTargets,
    resolveCompressionTarget,
    type CompressionTarget,
} from "./compression-targets"

export interface RecompressCommandContext {
    client: any
    state: SessionState
    logger: Logger
    sessionId: string
    messages: WithParts[]
    args: string[]
}

async function sendIgnoredMessage(
    client: any,
    sessionId: string,
    text: string,
    logger: Logger,
): Promise<void> {
    try {
        if (client?.session?.prompt) {
            await client.session.prompt({
                body: { parts: [{ text }] },
            })
        } else if (client?.session?.createMessage) {
            await client.session.createMessage({
                message: { sessionID: sessionId, role: "user", content: text },
            })
        }
    } catch (err) {
        logger.debug("Failed to send ignored message", { err: String(err) })
    }
}

function parseBlockIdArg(arg: string): number | null {
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

function snapshotActiveMessages(messagesState: PruneMessagesState): Set<string> {
    const activeMessages = new Set<string>()
    for (const [messageId, entry] of messagesState.byMessageId) {
        if (entry.activeBlockIds.length > 0) {
            activeMessages.add(messageId)
        }
    }
    return activeMessages
}

function formatRecompressMessage(
    target: CompressionTarget,
    recompressedMessageCount: number,
    recompressedTokens: number,
    deactivatedBlockIds: number[],
): string {
    const lines: string[] = []

    lines.push(`Re-applied compression ${target.displayId}.`)
    if (target.runId !== target.displayId || target.grouped) {
        lines.push(`Tool call label: Compression #${target.runId}.`)
    }
    if (deactivatedBlockIds.length > 0) {
        const refs = deactivatedBlockIds.map((id) => String(id)).join(", ")
        lines.push(`Also re-compressed nested compression(s): ${refs}.`)
    }

    if (recompressedMessageCount > 0) {
        lines.push(
            `Re-compressed ${recompressedMessageCount} message(s) (~${formatTokenCount(recompressedTokens)}).`,
        )
    } else {
        lines.push("No messages were re-compressed.")
    }

    return lines.join("\n")
}

function formatAvailableBlocksMessage(availableTargets: CompressionTarget[]): string {
    const lines: string[] = []

    lines.push("Usage: /acp recompress <n>")
    lines.push("")

    if (availableTargets.length === 0) {
        lines.push("No user-decompressed blocks are available to re-compress.")
        return lines.join("\n")
    }

    lines.push("Available user-decompressed compressions:")
    for (const target of availableTargets) {
        const topic = target.topic.replace(/\s+/g, " ").trim() || "(no topic)"
        const label = `${target.displayId} (${formatTokenCount(target.compressedTokens)})`
        const details = target.grouped
            ? `Compression #${target.runId} - ${target.blocks.length} messages`
            : `Compression #${target.runId}`
        lines.push(`  ${label}  ${details} - ${topic}`)
    }

    return lines.join("\n")
}

export async function handleRecompressCommand(ctx: RecompressCommandContext): Promise<void> {
    const { client, state, logger, sessionId, messages, args } = ctx

    const targetArg = args[0]

    if (args.length > 1) {
        await sendIgnoredMessage(
            client,
            sessionId,
            "Invalid arguments. Usage: /acp recompress <n>",
            logger,
        )
        return
    }

    syncCompressionBlocks(state, logger, messages)
    const messagesState = state.prune.messages
    const availableMessageIds = new Set(messages.map((msg) => msg.info.id))

    if (!targetArg) {
        const availableTargets = getRecompressibleCompressionTargets(
            messagesState,
            availableMessageIds,
        )
        const message = formatAvailableBlocksMessage(availableTargets)
        await sendIgnoredMessage(client, sessionId, message, logger)
        return
    }

    const targetBlockId = parseBlockIdArg(targetArg)
    if (targetBlockId === null) {
        await sendIgnoredMessage(
            client,
            sessionId,
            `Please enter a compression number. Example: /acp recompress 2`,
            logger,
        )
        return
    }

    const target = resolveCompressionTarget(messagesState, targetBlockId)
    if (!target) {
        await sendIgnoredMessage(
            client,
            sessionId,
            `Compression ${targetBlockId} does not exist.`,
            logger,
        )
        return
    }

    if (target.blocks.some((block) => !availableMessageIds.has(block.compressMessageId))) {
        await sendIgnoredMessage(
            client,
            sessionId,
            `Compression ${target.displayId} can no longer be re-applied because its origin message is no longer in this session.`,
            logger,
        )
        return
    }

    if (!target.blocks.some((block) => block.deactivatedByUser)) {
        const message = target.blocks.some((block) => block.active)
            ? `Compression ${target.displayId} is already active.`
            : `Compression ${target.displayId} is not user-decompressed.`
        await sendIgnoredMessage(client, sessionId, message, logger)
        return
    }

    const activeMessagesBefore = snapshotActiveMessages(messagesState)
    const activeBlockIdsBefore = new Set(messagesState.activeBlockIds)

    for (const block of target.blocks) {
        block.deactivatedByUser = false
        block.deactivatedAt = undefined
        block.deactivatedByBlockId = undefined
    }

    syncCompressionBlocks(state, logger, messages)

    let recompressedMessageCount = 0
    let recompressedTokens = 0
    for (const [messageId, entry] of messagesState.byMessageId) {
        const isActiveNow = entry.activeBlockIds.length > 0
        if (isActiveNow && !activeMessagesBefore.has(messageId)) {
            recompressedMessageCount++
            recompressedTokens += entry.tokenCount
        }
    }

    state.stats.totalPruneTokens += recompressedTokens

    const deactivatedBlockIds = Array.from(activeBlockIdsBefore)
        .filter((blockId) => !messagesState.activeBlockIds.has(blockId))
        .sort((a, b) => a - b)

    await saveSessionState(state, logger)

    const message = formatRecompressMessage(
        target,
        recompressedMessageCount,
        recompressedTokens,
        deactivatedBlockIds,
    )
    await sendIgnoredMessage(client, sessionId, message, logger)
}

export function recompressCommand(ctx: CommandContext): CommandResult {
    const { state, args, logger } = ctx

    if (args.length === 0) {
        return { output: listRecompressible(state) }
    }

    const parsed = parseBlockIds(args)
    if (parsed.invalid.length > 0) {
        return {
            output: `Invalid block id(s): ${parsed.invalid.join(", ")}. Block ids must be numbers (e.g. \`/acp recompress 3\`).`,
            isError: true,
        }
    }

    const lines: string[] = ["**Recompress**", ""]
    let succeeded = 0
    for (const id of parsed.valid) {
        const block = state.prune.messages.blocksById.get(id)
        if (!block) {
            lines.push(`- b${id}: not found`)
            continue
        }
        if (block.active) {
            lines.push(`- b${id}: already active`)
            continue
        }
        if (!block.deactivatedByUser) {
            lines.push(`- b${id}: was consumed by another block (cannot recompress)`)
            continue
        }
        reactivateUserDeactivatedBlock(state, id)
        succeeded++
        lines.push(`- b${id}: re-applied (${formatTokenCount(block.compressedTokens)} tokens)`)
        logger.info("block recompressed by user", { blockId: id })
    }

    lines.push("")
    lines.push(`Recompressed ${succeeded} of ${parsed.valid.length} block(s).`)

    return { output: lines.join("\n") }
}

function listRecompressible(state: SessionState): string {
    const all = Array.from(state.prune.messages.blocksById.values())
    const recompressible = all.filter((b) => !b.active && b.deactivatedByUser)
    const lines: string[] = ["**User-decompressed blocks available to recompress**", ""]
    if (recompressible.length === 0) {
        lines.push("No recompressible blocks. Blocks consumed by newer compressions cannot be recompressed.")
        return lines.join("\n")
    }
    const sorted = [...recompressible].sort((a, b) => a.blockId - b.blockId)
    lines.push("id | tokens | topic")
    for (const block of sorted) {
        lines.push(`- b${block.blockId}: ${formatTokenCount(block.compressedTokens)} | ${block.topic || "untitled"}`)
    }
    lines.push("")
    lines.push("Use \`/acp recompress <id>\` to re-apply a block (accepts multiple ids).")
    return lines.join("\n")
}

function reactivateUserDeactivatedBlock(state: SessionState, blockId: number): boolean {
    const messages = state.prune.messages
    const block = messages.blocksById.get(blockId)
    if (!block) return false

    block.active = true
    block.deactivatedByUser = false
    block.deactivatedAt = undefined
    block.deactivatedByBlockId = undefined

    messages.activeBlockIds.add(blockId)
    if (block.anchorMessageId) {
        messages.activeByAnchorMessageId.set(block.anchorMessageId, blockId)
    }
    return true
}
