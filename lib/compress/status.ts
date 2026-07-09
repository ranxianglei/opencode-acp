import { tool } from "@opencode-ai/plugin"
import type { ToolContext } from "./types"
import { formatAge } from "../ui/utils"
import type { CompressionBlock, WithParts } from "../state/types"
import { estimateContextComposition, type ContextComposition } from "../messages/inject/utils"
import { fetchSessionMessages } from "./search"

const ACP_STATUS_TOOL_DESCRIPTION = `Show full context status: visible (uncompressed) breakdown + compressed block list.

Returns two sections:
1. VISIBLE CONTEXT — token breakdown by category (tool outputs, code, text, summaries) with largest items per category. Helps you decide what to compress.
2. COMPRESSED BLOCKS — active compression blocks with sizes, ages, topics, and message-ID ranges consumed. Helps you choose safe boundaries and track what was compressed away.

Use this tool when:
- You want to see what's consuming context (tool outputs? code? text?)
- You are unsure which mNNNNN refs are still compressible
- Before choosing compress boundaries, if any prior compressions exist
- You want to see block sizes before deciding to decompress
- A compress call failed with "not available" (the ID was likely consumed)

Args:
- mode: "summary" (default) — compact one-line per category and per block. "detailed" — adds largest items per category with descriptions, plus block age/generation/effective message count/consumed lineage.
- sort: "recent" (default) | "size" (largest compressed first) | "age" (oldest surviving first, nearing GC).
- limit: max blocks to show (default 30).`

function formatTokens(n: number): string {
    if (!Number.isFinite(n) || n <= 0) return "0"
    return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n)
}

function formatSizePair(compressed: number, summary: number): string {
    return `${formatTokens(compressed)}→${formatTokens(summary)}`
}

function formatIdRange(block: CompressionBlock): string {
    const start = (block.startId || "").trim()
    const end = (block.endId || "").trim()
    if (!start || !end) return "—"
    if (start === end) return start
    return `${start}–${end}`
}

function sortBlocks(
    blocks: CompressionBlock[],
    sort: "recent" | "size" | "age",
): CompressionBlock[] {
    const copy = [...blocks]
    if (sort === "size") {
        copy.sort((a, b) => (b.compressedTokens || 0) - (a.compressedTokens || 0))
    } else if (sort === "age") {
        copy.sort((a, b) => (b.survivedCount || 0) - (a.survivedCount || 0))
    } else {
        copy.sort((a, b) => b.createdAt - a.createdAt)
    }
    return copy
}

function renderSummaryRow(block: CompressionBlock, idWidth: number): string {
    const idStr = `b${block.blockId}`.padEnd(idWidth + 1)
    const sizeStr = formatSizePair(block.compressedTokens, block.summaryTokens).padStart(13)
    const ageStr = formatAge(block.createdAt).padStart(10)
    const rangeStr = formatIdRange(block).padStart(19)
    const topic = block.topic || "(no topic)"
    return `  ${idStr} ${sizeStr}  ${ageStr}  ${rangeStr}   "${topic}"`
}

function renderDetailedRow(block: CompressionBlock, idWidth: number): string {
    const idStr = `b${block.blockId}`.padEnd(idWidth + 1)
    const sizeStr = formatSizePair(block.compressedTokens, block.summaryTokens).padStart(13)
    const ageStr = formatAge(block.createdAt).padStart(10)
    const rangeStr = formatIdRange(block).padStart(19)
    const survived = block.survivedCount ?? 0
    const gen = block.generation ?? "young"
    const effCount = block.effectiveMessageIds?.length ?? 0
    const consumedLineage =
        block.consumedBlockIds && block.consumedBlockIds.length > 0
            ? ` nested=[${block.consumedBlockIds.map((n) => `b${n}`).join(",")}]`
            : ""
    const topic = block.topic || "(no topic)"
    return `  ${idStr} ${sizeStr}  ${ageStr}  ${rangeStr}  age=${survived} ${gen} eff=${effCount}${consumedLineage}  "${topic}"`
}

function pct(n: number, total: number): number {
    if (n <= 0 || total <= 0) return 0
    return Math.max(1, Math.round((n / total) * 100))
}

function describeToolMessage(msg: WithParts): string {
    for (const part of msg.parts || []) {
        if (part.type === "tool") {
            const toolPart = part as any
            const toolName = toolPart.tool || "?"
            const input = toolPart.state?.input
            if (input && typeof input === "object") {
                if (input.command) return `${toolName}: ${String(input.command).slice(0, 60)}`
                if (input.filePath) return `${toolName}: ${String(input.filePath).slice(0, 60)}`
                if (input.query) return `${toolName}: ${String(input.query).slice(0, 60)}`
                if (input.pattern) return `${toolName}: ${String(input.pattern).slice(0, 60)}`
                if (input.content) return `${toolName}: ${String(input.content).slice(0, 40)}`
            }
            return toolName
        }
    }
    const textPart = (msg.parts || []).find((p) => p.type === "text") as any
    if (textPart?.text) {
        return textPart.text.slice(0, 60).replace(/\n/g, " ")
    }
    return "?"
}

function renderVisibleBreakdown(
    composition: ContextComposition,
    visibleMessages: WithParts[],
    state: any,
    mode: "summary" | "detailed",
): string[] {
    const lines: string[] = []
    const total = composition.total
    const toolPct = pct(composition.toolTokens, total)
    const codePct = pct(composition.codeTokens, total)
    const textPct = pct(composition.textTokens, total)
    const summaryPct = pct(composition.summaryTokens, total)

    lines.push("VISIBLE CONTEXT (uncompressed)")
    lines.push(
        `  ${formatTokens(total)} total | ${formatTokens(composition.toolTokens)} tool (${toolPct}%) | ${formatTokens(composition.codeTokens)} code (${codePct}%) | ${formatTokens(composition.textTokens)} text (${textPct}%) | ${formatTokens(composition.summaryTokens)} summaries (${summaryPct}%)`,
    )

    const topTypes = composition.toolTypeBreakdown.slice(0, mode === "detailed" ? 5 : 3)
    if (topTypes.length > 0) {
        const parts = topTypes.map((t) => {
            const tp = pct(t.tokens, total)
            return mode === "detailed"
                ? `${t.tool} (${formatTokens(t.tokens)}, ${tp}%)`
                : `${t.tool} (${tp}%)`
        })
        lines.push(`  Top tools: ${parts.join(", ")}`)
    }

    if (mode === "detailed") {
        const byRef = state?.messageIds?.byRef
        if (composition.largestToolRanges.length > 0) {
            const items = composition.largestToolRanges.slice(0, 10).map((r) => {
                const rawId = byRef?.get(r.ref) || ""
                const msg = visibleMessages.find((m) => (m.info as any)?.id === rawId)
                const desc = msg ? describeToolMessage(msg) : ""
                return `${r.ref} (${formatTokens(r.tokens)}) ${desc}`
            })
            lines.push(`  Largest tool outputs:`)
            for (const item of items) {
                lines.push(`    ${item}`)
            }
        }
        if (composition.largestCodeRanges.length > 0) {
            lines.push(
                `  Largest code messages: ${composition.largestCodeRanges.map((r) => `${r.ref} (${formatTokens(r.tokens)})`).join(", ")}`,
            )
        }
        if (composition.largestMessageRanges.length > 0) {
            lines.push(
                `  Largest text messages: ${composition.largestMessageRanges.map((r) => `${r.ref} (${formatTokens(r.tokens)})`).join(", ")}`,
            )
        }
    }

    return lines
}

function buildVisibleMessages(
    rawMessages: WithParts[],
    ctx: ToolContext,
): WithParts[] {
    const pruneMap = ctx.state.prune.messages.byMessageId
    const visible = rawMessages.filter((msg) => {
        const msgId = (msg.info as any)?.id || ""
        const entry = pruneMap.get(msgId)
        return !entry || entry.activeBlockIds.length === 0
    })

    const activeBlocks = Array.from(ctx.state.prune.messages.activeBlockIds)
        .map((id) => ctx.state.prune.messages.blocksById.get(id))
        .filter((b): b is NonNullable<typeof b> => b !== undefined && b.active)

    for (const block of activeBlocks) {
        visible.push({
            info: { id: `msg_acp_summary_b${block.blockId}` } as any,
            parts: [{ type: "text", text: block.summary || "[Compressed conversation section]" } as any],
        } as any)
    }

    return visible
}

export function createAcpStatusTool(ctx: ToolContext): ReturnType<typeof tool> {
    ctx.prompts.reload()

    return tool({
        description: ACP_STATUS_TOOL_DESCRIPTION,
        args: {
            mode: tool.schema
                .string()
                .optional()
                .describe('Output detail level: "summary" (default) or "detailed"'),
            sort: tool.schema
                .string()
                .optional()
                .describe('Sort order for blocks: "recent" (default), "size", or "age"'),
            limit: tool.schema
                .number()
                .optional()
                .describe("Maximum blocks to show (default 30)"),
        },
        async execute(args, toolCtx) {
            const mode = args.mode === "detailed" ? "detailed" : "summary"
            const sort: "recent" | "size" | "age" =
                args.sort === "size" || args.sort === "age" ? args.sort : "recent"
            const limit = Number.isFinite(args.limit) && args.limit! > 0 ? Math.min(args.limit!, 200) : 30

            const lines: string[] = []

            try {
                const rawMessages = await fetchSessionMessages(ctx.client, toolCtx.sessionID)
                const visibleMessages = buildVisibleMessages(rawMessages, ctx)
                const composition = estimateContextComposition(visibleMessages, ctx.state)

                lines.push(...renderVisibleBreakdown(composition, visibleMessages, ctx.state, mode))
            } catch {
                lines.push("VISIBLE CONTEXT (uncompressed)")
                lines.push("  (unable to fetch messages for breakdown)")
            }

            lines.push("")
            const messages = ctx.state.prune.messages
            const activeIds = Array.from(messages.activeBlockIds).sort((a, b) => a - b)

            if (activeIds.length === 0) {
                lines.push("COMPRESSED BLOCKS")
                lines.push("  No compressed blocks. Context is fully visible.")
                return lines.join("\n")
            }

            const allBlocks = activeIds
                .map((id) => messages.blocksById.get(id))
                .filter((b): b is NonNullable<typeof b> => b !== undefined && b.active)

            if (allBlocks.length === 0) {
                lines.push("COMPRESSED BLOCKS")
                lines.push("  No compressed blocks. Context is fully visible.")
                return lines.join("\n")
            }

            const totalSummary = allBlocks.reduce((s, b) => s + (b.summaryTokens || 0), 0)
            const totalCompressed = allBlocks.reduce((s, b) => s + (b.compressedTokens || 0), 0)
            const sorted = sortBlocks(allBlocks, sort)
            const shown = sorted.slice(0, limit)
            const truncated = sorted.length - shown.length

            const idWidth = Math.max(...shown.map((b) => String(b.blockId).length))

            lines.push(
                `COMPRESSED BLOCKS — ${allBlocks.length} active (${formatTokens(totalSummary)} summary, ${formatTokens(totalCompressed)} original compressed)`,
            )
            lines.push("")

            for (const b of shown) {
                lines.push(
                    mode === "detailed" ? renderDetailedRow(b, idWidth) : renderSummaryRow(b, idWidth),
                )
            }

            if (truncated > 0) {
                lines.push("")
                lines.push(`${shown.length} of ${sorted.length} blocks shown (${truncated} hidden). Raise limit or change sort to see more.`)
            }

            lines.push("")
            const sortHint =
                sort === "recent"
                    ? 'Blocks sorted by recent. Use acp_status({sort:"size"}) for largest, {sort:"age"}) for near-GC.'
                    : `Blocks sorted by ${sort}.`
            lines.push(`${sortHint} Use decompress to restore a block's full content, or search_context to search within compressed blocks.`)

            return lines.join("\n")
        },
    })
}
