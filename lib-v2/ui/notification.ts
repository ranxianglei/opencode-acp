import type { CompressionBlock } from "../state/types"
import type { PluginConfig } from "../config/types"

export interface NotificationInput {
    blocks: CompressionBlock[]
    config: PluginConfig
    mode: "chat" | "toast"
    style: "minimal" | "detailed" | "off"
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
