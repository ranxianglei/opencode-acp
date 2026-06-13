import type { Logger } from "../logger"
import type { SessionState, WithParts } from "../state"
import { syncCompressionBlocks } from "../messages"
import { getCurrentParams } from "../token-utils"
import { sendIgnoredMessage } from "../ui/notification"
import { formatTokenCount } from "../ui/utils"
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
import { saveSessionState } from "../state/persistence"

export interface DecompressCommandContext {
    client: any
    state: SessionState
    logger: Logger
    sessionId: string
    messages: WithParts[]
    args: string[]
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
    const entries = availableTargets.map((target) => {
        const topic = target.topic.replace(/\s+/g, " ").trim() || "(no topic)"
        const label = `${target.displayId} (${formatTokenCount(target.compressedTokens)})`
        const details = target.grouped
            ? `Compression #${target.runId} - ${target.blocks.length} messages`
            : `Compression #${target.runId}`
        return { label, topic: `${details} - ${topic}` }
    })

    const labelWidth = Math.max(...entries.map((entry) => entry.label.length)) + 4
    for (const entry of entries) {
        lines.push(`  ${entry.label.padEnd(labelWidth)}${entry.topic}`)
    }

    return lines.join("\n")
}

export async function handleDecompressCommand(ctx: DecompressCommandContext): Promise<void> {
    const { client, state, logger, sessionId, messages, args } = ctx

    const params = getCurrentParams(state, messages, logger)
    const targetArg = args[0]

    if (args.length > 1) {
        await sendIgnoredMessage(
            client,
            sessionId,
            "Invalid arguments. Usage: /acp decompress <n>",
            params,
            logger,
        )
        return
    }

    syncCompressionBlocks(state, logger, messages)
    const messagesState = state.prune.messages

    if (!targetArg) {
        const availableTargets = getActiveCompressionTargets(messagesState)
        const message = formatAvailableBlocksMessage(availableTargets)
        await sendIgnoredMessage(client, sessionId, message, params, logger)
        return
    }

    const targetBlockId = parseBlockIdArg(targetArg)
    if (targetBlockId === null) {
        await sendIgnoredMessage(
            client,
            sessionId,
            `Please enter a compression number. Example: /acp decompress 2`,
            params,
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
            params,
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
                params,
                logger,
            )
            return
        }

        await sendIgnoredMessage(
            client,
            sessionId,
            `Compression ${target.displayId} is not active.`,
            params,
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
    await sendIgnoredMessage(client, sessionId, message, params, logger)

    logger.info("Decompress command completed", {
        targetBlockId: target.displayId,
        targetRunId: target.runId,
        restoredMessageCount,
        restoredTokens,
        reactivatedBlockIds,
    })
}
