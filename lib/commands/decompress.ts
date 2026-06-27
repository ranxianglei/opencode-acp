import type { CommandContext, CommandResult } from "./types"
import type { Logger } from "../infra/logger"
import type { SessionState, WithParts } from "../state/types"
import { deactivateBlock } from "../state/mutations/blocks"
import { getActiveBlocks } from "../state/queries"
import { formatTokenCount } from "../ui/utils"
import { saveSessionState } from "../state/persistence"
import { syncCompressionBlocks } from "../messages/sync"
import {
    getActiveCompressionTargets,
    resolveCompressionTarget,
    type CompressionTarget,
} from "./compression-targets"
import {
    parseBlockIdArg,
    findActiveAncestorBlockId,
    snapshotActiveMessages,
    deactivateCompressionTarget,
    computeRestoredMessages,
    computeReactivatedBlockIds,
} from "../compress/decompress-logic"

export interface DecompressCommandContext {
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

function formatDecompressMessage(
    target: CompressionTarget,
    restoredMessageCount: number,
    restoredTokens: number,
    reactivatedBlockIds: number[],
): string {
    const lines: string[] = []

    lines.push(`Restored compression ${target.displayId}.`)
    if (target.runId !== target.displayId || target.grouped) {
        lines.push(`Tool call label: Compression #${target.runId}.`)
    }
    if (reactivatedBlockIds.length > 0) {
        const refs = reactivatedBlockIds.map((id) => String(id)).join(", ")
        lines.push(`Also restored nested compression(s): ${refs}.`)
    }

    if (restoredMessageCount > 0) {
        lines.push(
            `Restored ${restoredMessageCount} message(s) (~${formatTokenCount(restoredTokens)}).`,
        )
    } else {
        lines.push("No messages were restored.")
    }

    return lines.join("\n")
}

function formatAvailableBlocksMessage(availableTargets: CompressionTarget[]): string {
    const lines: string[] = []

    lines.push("Usage: /acp decompress <n>")
    lines.push("")

    if (availableTargets.length === 0) {
        lines.push("No compressions are available to restore.")
        return lines.join("\n")
    }

    lines.push("Available compressions:")
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

export async function handleDecompressCommand(ctx: DecompressCommandContext): Promise<void> {
    const { client, state, logger, sessionId, messages, args } = ctx

    const targetArg = args[0]

    if (args.length > 1) {
        await sendIgnoredMessage(
            client,
            sessionId,
            "Invalid arguments. Usage: /acp decompress <n>",
            logger,
        )
        return
    }

    syncCompressionBlocks(state, logger, messages)
    const messagesState = state.prune.messages

    if (!targetArg) {
        const availableTargets = getActiveCompressionTargets(messagesState)
        const message = formatAvailableBlocksMessage(availableTargets)
        await sendIgnoredMessage(client, sessionId, message, logger)
        return
    }

    const targetBlockId = parseBlockIdArg(targetArg)
    if (targetBlockId === null) {
        await sendIgnoredMessage(
            client,
            sessionId,
            `Please enter a compression number. Example: /acp decompress 2`,
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

    const activeBlocks = target.blocks.filter((block) => block.active)
    if (activeBlocks.length === 0) {
        const activeAncestorBlockId = findActiveAncestorBlockId(messagesState, target)
        if (activeAncestorBlockId !== null) {
            await sendIgnoredMessage(
                client,
                sessionId,
                `Compression ${target.displayId} is inside compression ${activeAncestorBlockId}. Restore compression ${activeAncestorBlockId} first.`,
                logger,
            )
            return
        }

        await sendIgnoredMessage(
            client,
            sessionId,
            `Compression ${target.displayId} is not active.`,
            logger,
        )
        return
    }

    const activeMessagesBefore = snapshotActiveMessages(messagesState)
    const activeBlockIdsBefore = new Set(messagesState.activeBlockIds)

    deactivateCompressionTarget(messagesState, target)

    syncCompressionBlocks(state, logger, messages)

    const { restoredMessageCount, restoredTokens } = computeRestoredMessages(
        messagesState,
        activeMessagesBefore,
    )

    state.stats.totalPruneTokens = Math.max(0, state.stats.totalPruneTokens - restoredTokens)

    const reactivatedBlockIds = computeReactivatedBlockIds(messagesState, activeBlockIdsBefore)

    await saveSessionState(state, logger)

    const message = formatDecompressMessage(
        target,
        restoredMessageCount,
        restoredTokens,
        reactivatedBlockIds,
    )
    await sendIgnoredMessage(client, sessionId, message, logger)
}

export function decompressCommand(ctx: CommandContext): CommandResult {
    const { state, args, logger } = ctx

    if (args.length === 0) {
        return { output: listDecompressible(state) }
    }

    const parsed = parseBlockIds(args)
    if (parsed.invalid.length > 0) {
        return {
            output: `Invalid block id(s): ${parsed.invalid.join(", ")}. Block ids must be numbers (e.g. \`/acp decompress 3\`).`,
            isError: true,
        }
    }

    const lines: string[] = ["**Decompress**", ""]
    let succeeded = 0
    for (const id of parsed.valid) {
        const block = state.prune.messages.blocksById.get(id)
        if (!block) {
            lines.push(`- b${id}: not found`)
            continue
        }
        if (!block.active) {
            lines.push(`- b${id}: already inactive (decompressed or consumed)`)
            continue
        }
        const ok = deactivateBlock(state, id, { byUser: true })
        if (ok) {
            succeeded++
            lines.push(`- b${id}: restored (${formatTokenCount(block.compressedTokens)} tokens)`)
            logger.info("block decompressed by user", { blockId: id })
        } else {
            lines.push(`- b${id}: failed to deactivate`)
        }
    }

    lines.push("")
    lines.push(`Decompressed ${succeeded} of ${parsed.valid.length} block(s).`)

    return { output: lines.join("\n") }
}

function listDecompressible(state: CommandContext["state"]): string {
    const active = getActiveBlocks(state)
    const lines: string[] = ["**Available compressions to decompress**", ""]
    if (active.length === 0) {
        lines.push("No active compression blocks.")
        return lines.join("\n")
    }
    const sorted = [...active].sort((a, b) => a.blockId - b.blockId)
    lines.push("id | tokens | topic")
    for (const block of sorted) {
        lines.push(`- b${block.blockId}: ${formatTokenCount(block.compressedTokens)} | ${block.topic || "untitled"}`)
    }
    lines.push("")
    lines.push("Use \`/acp decompress <id>\` to restore a block (accepts multiple ids).")
    return lines.join("\n")
}

interface ParsedIds {
    valid: number[]
    invalid: string[]
}

function parseBlockIds(args: string[]): ParsedIds {
    const valid: number[] = []
    const invalid: string[] = []
    for (const raw of args) {
        const trimmed = raw.replace(/^b/i, "").trim()
        const id = Number.parseInt(trimmed, 10)
        if (Number.isNaN(id) || !/^\d+$/.test(trimmed)) {
            invalid.push(raw)
        } else {
            valid.push(id)
        }
    }
    return { valid, invalid }
}

export { parseBlockIds }
