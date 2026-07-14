import type { Logger } from "../logger"
import type { SessionState } from "../state"
import {
    formatPrunedItemsList,
    formatProgressBar,
    formatStatsHeader,
    formatTokenCount,
} from "./utils"
import { ToolParameterEntry } from "../state"
import { PluginConfig } from "../config"

export type PruneReason = "completion" | "noise" | "extraction"
export const PRUNE_REASON_LABELS: Record<PruneReason, string> = {
    completion: "Task Complete",
    noise: "Noise Removal",
    extraction: "Extraction",
}

interface CompressionNotificationEntry {
    blockId: number
    runId: number
    summary: string
    summaryTokens: number
}

function buildMinimalMessage(state: SessionState, reason: PruneReason | undefined): string {
    const reasonSuffix = reason ? ` — ${PRUNE_REASON_LABELS[reason]}` : ""
    return (
        formatStatsHeader(state.stats.totalPruneTokens, state.stats.pruneTokenCounter) +
        reasonSuffix
    )
}

function buildDetailedMessage(
    state: SessionState,
    reason: PruneReason | undefined,
    pruneToolIds: string[],
    toolMetadata: Map<string, ToolParameterEntry>,
    workingDirectory: string,
): string {
    let message = formatStatsHeader(state.stats.totalPruneTokens, state.stats.pruneTokenCounter)

    if (pruneToolIds.length > 0) {
        const pruneTokenCounterStr = `~${formatTokenCount(state.stats.pruneTokenCounter)}`
        const reasonLabel = reason ? ` — ${PRUNE_REASON_LABELS[reason]}` : ""
        message += `\n\n▣ Pruning (${pruneTokenCounterStr})${reasonLabel}`

        const itemLines = formatPrunedItemsList(pruneToolIds, toolMetadata, workingDirectory)
        message += "\n" + itemLines.join("\n")
    }

    return message.trim()
}

const TOAST_BODY_MAX_LINES = 12
const TOAST_SUMMARY_MAX_CHARS = 600
const NOTIFICATION_SUMMARY_MAX_CHARS = 1500

function formatEntryRanges(
    entries: CompressionNotificationEntry[],
    state: SessionState,
): string | null {
    const parts: string[] = []
    for (const entry of entries) {
        const block = state.prune.messages.blocksById.get(entry.blockId)
        if (!block) continue
        const startRef = block.startId
        const endRef = block.endId
        if (!startRef || !endRef) continue
        if (startRef === endRef) {
            parts.push(`b${entry.blockId}: ${startRef}`)
        } else {
            parts.push(`b${entry.blockId}: ${startRef}–${endRef}`)
        }
    }
    return parts.length > 0 ? parts.join(", ") : null
}

function truncateToastBody(body: string, maxLines: number = TOAST_BODY_MAX_LINES): string {
    const lines = body.split("\n")
    if (lines.length <= maxLines) {
        return body
    }
    const kept = lines.slice(0, maxLines - 1)
    const remaining = lines.length - maxLines + 1
    return kept.join("\n") + `\n... and ${remaining} more`
}

function truncateToastSummary(summary: string, maxChars: number = TOAST_SUMMARY_MAX_CHARS): string {
    if (summary.length <= maxChars) {
        return summary
    }
    return summary.slice(0, maxChars - 3) + "..."
}

function buildCompressionSummary(
    entries: CompressionNotificationEntry[],
    state: SessionState,
): string {
    if (entries.length === 1) {
        return entries[0]?.summary ?? ""
    }

    const perEntryMax = Math.floor(NOTIFICATION_SUMMARY_MAX_CHARS / entries.length)
    let result = ""
    let shown = 0
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]
        const topic = state.prune.messages.blocksById.get(entry.blockId)?.topic ?? "(unknown topic)"
        const truncated =
            entry.summary.length > perEntryMax
                ? entry.summary.slice(0, perEntryMax - 3) + "..."
                : entry.summary
        const section = `### ${topic}\n${truncated}`
        if (result.length + section.length + 2 > NOTIFICATION_SUMMARY_MAX_CHARS) {
            const remaining = entries.length - shown
            if (remaining > 0) {
                result += (result ? "\n\n" : "") + `... and ${remaining} more`
            }
            break
        }
        result += (result ? "\n\n" : "") + section
        shown++
    }
    return result
}

function getCompressionLabel(entries: CompressionNotificationEntry[]): string {
    const runId = entries[0]?.runId
    const blockIds = entries.map((e) => `b${e.blockId}`)
    if (runId === undefined) {
        return "Compression"
    }

    return `Compression #${runId} → ${blockIds.join(", ")}`
}

function formatCompressionMetrics(removedTokens: number, summaryTokens: number): string {
    const metrics = [`-${formatTokenCount(removedTokens, true)} removed`]
    if (summaryTokens > 0) {
        metrics.push(`+${formatTokenCount(summaryTokens, true)} summary`)
    }
    return metrics.join(", ")
}

function formatContextTransition(tokensBefore: number, tokensAfter: number): string {
    const beforeStr = formatTokenCount(tokensBefore, true)
    const afterStr = formatTokenCount(tokensAfter, true)
    return `Context ${beforeStr} → ${afterStr}`
}

export async function sendCompressNotification(
    client: any,
    logger: Logger,
    config: PluginConfig,
    state: SessionState,
    sessionId: string,
    entries: CompressionNotificationEntry[],
    batchTopic: string | undefined,
    sessionMessageIds: string[],
    params: any,
    contextTokensBefore: number,
): Promise<boolean> {
    if (config.pruneNotification === "off") {
        return false
    }

    if (entries.length === 0) {
        return false
    }

    let message: string
    const compressionLabel = getCompressionLabel(entries)
    const summary = buildCompressionSummary(entries, state)
    const summaryTokens = entries.reduce((total, entry) => total + entry.summaryTokens, 0)
    const summaryTokensStr = formatTokenCount(summaryTokens)
    const compressedTokens = entries.reduce((total, entry) => {
        const compressionBlock = state.prune.messages.blocksById.get(entry.blockId)
        if (!compressionBlock) {
            logger.error("Compression block missing for notification", {
                compressionId: entry.blockId,
                sessionId,
            })
            return total
        }

        return total + compressionBlock.compressedTokens
    }, 0)

    const newlyCompressedMessageIds: string[] = []
    const newlyCompressedToolIds: string[] = []
    const seenMessageIds = new Set<string>()
    const seenToolIds = new Set<string>()

    for (const entry of entries) {
        const compressionBlock = state.prune.messages.blocksById.get(entry.blockId)
        if (!compressionBlock) {
            continue
        }

        for (const messageId of compressionBlock.directMessageIds) {
            if (seenMessageIds.has(messageId)) {
                continue
            }
            seenMessageIds.add(messageId)
            newlyCompressedMessageIds.push(messageId)
        }

        for (const toolId of compressionBlock.directToolIds) {
            if (seenToolIds.has(toolId)) {
                continue
            }
            seenToolIds.add(toolId)
            newlyCompressedToolIds.push(toolId)
        }
    }

    const topic =
        batchTopic ??
        (entries.length === 1
            ? (state.prune.messages.blocksById.get(entries[0]?.blockId ?? -1)?.topic ??
              "(unknown topic)")
            : "(unknown topic)")

    const contextTokensAfter = Math.max(0, contextTokensBefore - compressedTokens + summaryTokens)
    const notificationHeader = `▣ ACP | ${formatContextTransition(
        contextTokensBefore,
        contextTokensAfter,
    )}`

    let displaySummary: string = summary

    if (config.pruneNotification === "minimal") {
        message = `${notificationHeader} — ${compressionLabel}`
    } else {
        message = notificationHeader

        const activePrunedMessages = new Map<string, number>()
        for (const [messageId, entry] of state.prune.messages.byMessageId) {
            if (entry.activeBlockIds.length > 0) {
                activePrunedMessages.set(messageId, entry.tokenCount)
            }
        }
        const progressBar = formatProgressBar(
            sessionMessageIds,
            activePrunedMessages,
            newlyCompressedMessageIds,
            50,
        )
        message += `\n\n${progressBar}`
        message += `\n▣ ${compressionLabel} ${formatCompressionMetrics(compressedTokens, summaryTokens)}`
        const rangeStr = formatEntryRanges(entries, state)
        if (rangeStr) {
            message += `\n→ Range: ${rangeStr}`
        }
        message += `\n→ Topic: ${topic}`
        message += `\n→ Items: ${newlyCompressedMessageIds.length} messages`
        if (newlyCompressedToolIds.length > 0) {
            message += ` and ${newlyCompressedToolIds.length} tools compressed`
        } else {
            message += ` compressed`
        }
        if (config.compress.showCompression) {
            if (config.pruneNotification === "detailed") {
                displaySummary = summary
            } else {
                displaySummary =
                    summary.length > NOTIFICATION_SUMMARY_MAX_CHARS
                        ? truncateToastSummary(summary, NOTIFICATION_SUMMARY_MAX_CHARS)
                        : summary
            }
            message += `\n→ Compression (~${summaryTokensStr}): ${displaySummary}`
        }
    }

    if (config.pruneNotificationType === "toast") {
        let toastMessage = message
        toastMessage =
            config.pruneNotification === "minimal" ? toastMessage : truncateToastBody(toastMessage)

        await client.tui.showToast({
            body: {
                title: "ACP: Compress Notification",
                message: toastMessage,
                variant: "info",
                duration: 5000,
            },
        })
        return true
    }

    await sendIgnoredMessage(client, sessionId, message, params, logger)
    return true
}

export async function sendIgnoredMessage(
    client: any,
    sessionID: string,
    text: string,
    params: any,
    logger: Logger,
): Promise<void> {
    const agent = params.agent || undefined
    const variant = params.variant || undefined
    const model =
        params.providerId && params.modelId
            ? {
                  providerID: params.providerId,
                  modelID: params.modelId,
              }
            : undefined

    try {
        await client.session.prompt({
            path: {
                id: sessionID,
            },
            body: {
                noReply: true,
                agent: agent,
                model: model,
                variant: variant,
                parts: [
                    {
                        type: "text",
                        text: text,
                        ignored: true,
                    },
                ],
            },
        })
    } catch (error: any) {
        logger.error("Failed to send notification", { error: error.message })
    }
}
