import type { CompressionBlock } from "../state/types"

export function formatTokenCount(tokens: number): string {
    if (tokens >= 1000) {
        return `${(tokens / 1000).toFixed(1)}k`
    }
    return String(tokens)
}

export function formatBlockSummary(block: CompressionBlock, maxLength: number = 200): string {
    const summary = block.summary
    if (summary.length <= maxLength) return summary
    return summary.slice(0, maxLength) + "..."
}

export function formatContextUsage(used: number, limit: number): string {
    const percent = limit > 0 ? Math.round((used / limit) * 100) : 0
    return `${formatTokenCount(used)} / ${formatTokenCount(limit)} (${percent}%)`
}
