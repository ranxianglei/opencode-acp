import type { CompressionBlock, SessionState } from "../state/types"
import type { PluginConfig } from "../config/types"
import type { Logger } from "../infra/logger"
import { formatTokenCount } from "./utils"

export interface NotificationInput {
    blocks: CompressionBlock[]
    config: PluginConfig
    mode: "chat" | "toast"
    style: "minimal" | "detailed" | "off"
}

export interface CompressionNotificationEntry {
    blockId: number
    runId: number
    summary: string
    summaryTokens: number
}

export function buildNotification(input: NotificationInput): string | null {
    if (input.style === "off") return null

    const activeBlocks = input.blocks.filter((b) => b.active)
    if (activeBlocks.length === 0) return null

    if (input.style === "minimal") {
        return buildMinimalNotification(activeBlocks)
    }

    return buildDetailedNotification(activeBlocks)
}

function buildMinimalNotification(blocks: CompressionBlock[]): string {
    const totalTokens = blocks.reduce((sum, b) => sum + b.compressedTokens, 0)
    return `Compressed ${blocks.length} block${blocks.length > 1 ? "s" : ""} (${totalTokens} tokens freed)`
}

function buildDetailedNotification(blocks: CompressionBlock[]): string {
    const lines: string[] = []
    const totalTokens = blocks.reduce((sum, b) => sum + b.compressedTokens, 0)

    lines.push(`**Compression complete** — ${blocks.length} block${blocks.length > 1 ? "s" : ""}, ${totalTokens} tokens freed`)
    lines.push("")

    for (const block of blocks) {
        const topic = block.topic || "untitled"
        const msgs = block.directMessageIds.length
        const tokens = block.compressedTokens
        lines.push(`- **${block.blockId}**: ${topic} (${msgs} messages, ${tokens} tokens)`)
    }

    return lines.join("\n")
}

function getCompressionLabel(entries: CompressionNotificationEntry[]): string {
    const runId = entries[0]?.runId
    if (runId === undefined) {
        return "Compression"
    }
    return `Compression #${runId}`
}

function buildCompressionSummary(entries: CompressionNotificationEntry[]): string {
    return entries.map((e) => e.summary).join("\n\n---\n\n")
}

export async function sendCompressNotification(
    client: any,
    logger: Logger,
    config: PluginConfig,
    state: SessionState,
    sessionId: string,
    entries: CompressionNotificationEntry[],
    batchTopic: string | undefined,
    _sessionMessageIds: string[],
    _params: any,
): Promise<boolean> {
    if (config.pruneNotification === "off") {
        return false
    }

    if (entries.length === 0) {
        return false
    }

    const compressionLabel = getCompressionLabel(entries)
    const summary = buildCompressionSummary(entries)
    const summaryTokens = entries.reduce((total, entry) => total + entry.summaryTokens, 0)
    const summaryTokensStr = formatTokenCount(summaryTokens)
    const compressedTokens = entries.reduce((total, entry) => {
        const compressionBlock = state.prune.messages.blocksById.get(entry.blockId)
        if (!compressionBlock) {
            return total
        }
        return total + compressionBlock.compressedTokens
    }, 0)

    const topic =
        batchTopic ??
        (entries.length === 1
            ? (state.prune.messages.blocksById.get(entries[0]?.blockId ?? -1)?.topic ??
              "(unknown topic)")
            : "(unknown topic)")

    let totalActiveSummaryTkns = 0
    for (const block of state.prune.messages.blocksById.values()) {
        if (block.active) {
            totalActiveSummaryTkns += block.summaryTokens
        }
    }
    const totalGross = state.stats.totalPruneTokens + state.stats.pruneTokenCounter
    const notificationHeader = `▣ ACP | ${formatCompressionMetrics(totalGross, totalActiveSummaryTkns)}`

    let message: string
    if (config.pruneNotification === "minimal") {
        message = `${notificationHeader} — ${compressionLabel}`
    } else {
        message = notificationHeader
        message += `\n▣ ${compressionLabel} ${formatCompressionMetrics(compressedTokens, summaryTokens)}`
        message += `\n→ Topic: ${topic}`

        const newlyCompressedMessageIds: string[] = []
        const seenMessageIds = new Set<string>()
        for (const entry of entries) {
            const block = state.prune.messages.blocksById.get(entry.blockId)
            if (!block) continue
            for (const messageId of block.directMessageIds) {
                if (!seenMessageIds.has(messageId)) {
                    seenMessageIds.add(messageId)
                    newlyCompressedMessageIds.push(messageId)
                }
            }
        }

        const messageNoun = newlyCompressedMessageIds.length === 1 ? "message" : "messages"
        message += `\n→ Items: ${newlyCompressedMessageIds.length} ${messageNoun} compressed`

        if (config.compress.showCompression) {
            message += `\n→ Compression (~${summaryTokensStr}): ${summary}`
        }
    }

    if (config.pruneNotificationType === "toast") {
        await client.tui.showToast({
            body: {
                title: "ACP: Compress Notification",
                message,
                variant: "info",
                duration: 5000,
            },
        })
        return true
    }

    return false
}

function formatCompressionMetrics(compressed: number, summary: number): string {
    const metrics: string[] = []
    if (compressed > 0) {
        metrics.push(`-${formatTokenCount(compressed)} removed`)
    }
    if (summary > 0) {
        metrics.push(`+${formatTokenCount(summary)} summary`)
    }
    return metrics.join(", ")
}
