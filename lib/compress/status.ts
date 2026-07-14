import { tool } from "@opencode-ai/plugin"
import type { ToolContext } from "./types"
import { formatAge } from "../ui/utils"
import type { CompressionBlock, WithParts } from "../state/types"
import {
    estimateContextComposition,
    buildCompressibleRanges,
    formatCompressibleRanges,
} from "../messages/inject/utils"
import { fetchSessionMessages } from "./search"

const ACP_STATUS_TOOL_DESCRIPTION = `Show context status — overview includes compressible ranges by default.

No args: Overview with totals, compressed blocks, and compressible ranges.
scope:"uncompressed": Compressible ranges only (default view:"ranges"). Add view:"messages" for per-message listing with tool/sort filters.
scope:"compressed": Drill into compressed blocks — list each with full details (age, generation, consumed lineage).

Use this tool to:
- See what's consuming context + compressible ranges in one call (no args)
- Focus on ranges only (scope:"uncompressed")
- Find all messages of a specific tool type (scope:"uncompressed", view:"messages", tool:"bash")
- Check block details before decompressing (scope:"compressed")`

function formatTokens(n: number): string {
    if (!Number.isFinite(n) || n <= 0) return "0"
    return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n)
}

function pct(n: number, total: number): number {
    if (n <= 0 || total <= 0) return 0
    return Math.max(1, Math.round((n / total) * 100))
}

function formatIdRange(block: CompressionBlock): string {
    const start = (block.startId || "").trim()
    const end = (block.endId || "").trim()
    if (!start || !end) return "—"
    if (start === end) return start
    return `${start}–${end}`
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

interface VisibleMessageInfo {
    ref: string
    tokens: number
    tool: string
    index: number
}

function collectVisibleMessages(
    rawMessages: WithParts[],
    ctx: ToolContext,
): { messages: VisibleMessageInfo[]; summaryTokens: number } {
    const pruneMap = ctx.state.prune.messages.byMessageId
    const byRawId = ctx.state.messageIds.byRawId
    const result: VisibleMessageInfo[] = []
    let summaryTokens = 0

    const activeBlocks = Array.from(ctx.state.prune.messages.activeBlockIds)
        .map((id) => ctx.state.prune.messages.blocksById.get(id))
        .filter((b): b is NonNullable<typeof b> => b !== undefined && b.active)

    for (const block of activeBlocks) {
        summaryTokens += block.summaryTokens || 0
    }

    rawMessages.forEach((msg, idx) => {
        const msgId = (msg.info as any)?.id || ""
        const entry = pruneMap.get(msgId)
        if (entry && entry.activeBlockIds.length > 0) return

        const ref = byRawId.get(msgId)
        if (!ref) return

        let tokens = 0
        let toolName = ""

        for (const part of msg.parts || []) {
            if (part.type === "text" && typeof (part as any).text === "string") {
                tokens += Math.round(((part as any).text as string).length / 4)
            } else if (part.type === "tool") {
                const raw = JSON.stringify(part)
                tokens += Math.round(raw.length / 4)
                if (!toolName) {
                    toolName = (part as any)?.tool || "unknown"
                }
            }
        }

        if (tokens > 0) {
            result.push({ ref, tokens, tool: toolName || "text", index: idx })
        }
    })

    return { messages: result, summaryTokens }
}

function renderOverview(
    visibleMessages: VisibleMessageInfo[],
    summaryTokens: number,
    blocks: CompressionBlock[],
    fetchFailed: boolean,
    rawMessages: WithParts[],
    ctx: ToolContext,
): string[] {
    const lines: string[] = []

    const toolTypeMap = new Map<string, number>()
    for (const m of visibleMessages) {
        toolTypeMap.set(m.tool, (toolTypeMap.get(m.tool) || 0) + m.tokens)
    }
    const topToolName = Array.from(toolTypeMap.entries()).sort((a, b) => b[1] - a[1])[0]?.[0]

    if (fetchFailed) {
        lines.push("VISIBLE CONTEXT (uncompressed)")
        lines.push("  (unable to fetch messages for breakdown)")
    } else {
        const totalTool = visibleMessages
            .filter((m) => m.tool !== "text" && m.tool !== "step-finish")
            .reduce((s, m) => s + m.tokens, 0)
        const totalText = visibleMessages
            .filter((m) => m.tool === "text")
            .reduce((s, m) => s + m.tokens, 0)
        const total = totalTool + totalText + summaryTokens

        const toolPct = pct(totalTool, total)
        const textPct = pct(totalText, total)
        const summaryPct = pct(summaryTokens, total)

        lines.push("VISIBLE CONTEXT (uncompressed)")
        lines.push(
            `  ${formatTokens(total)} total | ${formatTokens(totalTool)} tool (${toolPct}%) | ${formatTokens(totalText)} text (${textPct}%) | ${formatTokens(summaryTokens)} summaries (${summaryPct}%)`,
        )

        const topTypes = Array.from(toolTypeMap.entries())
            .map(([tool, tokens]) => ({ tool, tokens }))
            .sort((a, b) => b.tokens - a.tokens)
            .slice(0, 3)
        if (topTypes.length > 0) {
            lines.push(
                `  Top tools: ${topTypes.map((t) => `${t.tool} (${pct(t.tokens, total)}%)`).join(", ")}`,
            )
        }
    }

    lines.push("")

    if (blocks.length === 0) {
        lines.push("COMPRESSED BLOCKS")
        lines.push("  No compressed blocks.")
    } else {
        const totalSummary = blocks.reduce((s, b) => s + (b.summaryTokens || 0), 0)
        const totalCompressed = blocks.reduce((s, b) => s + (b.compressedTokens || 0), 0)
        lines.push(
            `COMPRESSED BLOCKS — ${blocks.length} active (${formatTokens(totalSummary)} summary, ${formatTokens(totalCompressed)} original)`,
        )
        lines.push("")
        const sorted = [...blocks].sort((a, b) => b.createdAt - a.createdAt)
        for (const b of sorted.slice(0, 30)) {
            const ageStr = formatAge(b.createdAt)
            const range = formatIdRange(b)
            const topic = b.topic || "(no topic)"
            lines.push(
                `  b${b.blockId}  ${formatTokens(b.compressedTokens)}→${formatTokens(b.summaryTokens)}  ${ageStr}  ${range}  "${topic}"`,
            )
        }
    }

    if (!fetchFailed) {
        const pruneMap = ctx.state.prune.messages.byMessageId
        const visibleRaw = rawMessages.filter((msg) => {
            const msgId = (msg.info as any)?.id || ""
            const entry = pruneMap.get(msgId)
            return !entry || entry.activeBlockIds.length === 0
        })
        const contextRanges = buildCompressibleRanges(
            visibleRaw,
            ctx.state,
            ctx.config?.compress?.protectedTools ?? [],
            ctx.config?.protectedFilePatterns ?? [],
        )
        if (contextRanges.compressible.length > 0 || contextRanges.protected.length > 0) {
            lines.push("")
            lines.push(
                formatCompressibleRanges(contextRanges.compressible, contextRanges.protected),
            )
        }
    }

    lines.push("")

    const hintTool = topToolName || "bash"
    lines.push(
        `Tip: acp_status({scope:"uncompressed", view:"messages", tool:"${hintTool}"}) for per-message listing`,
    )

    return lines
}

function renderUncompressedRanges(rawMessages: WithParts[], ctx: ToolContext): string[] {
    const pruneMap = ctx.state.prune.messages.byMessageId
    const visibleMessages = rawMessages.filter((msg) => {
        const msgId = (msg.info as any)?.id || ""
        const entry = pruneMap.get(msgId)
        return !entry || entry.activeBlockIds.length === 0
    })

    const contextRanges = buildCompressibleRanges(
        visibleMessages,
        ctx.state,
        ctx.config?.compress?.protectedTools ?? [],
        ctx.config?.protectedFilePatterns ?? [],
    )
    const compressible = contextRanges.compressible
    const totalTokens = compressible.reduce((s, r) => s + r.tokens, 0)
    const totalMsgs = compressible.reduce((s, r) => s + r.count, 0)

    const lines: string[] = []
    lines.push(
        `UNCOMPRESSED — ${formatTokens(totalTokens)} | ${totalMsgs} msgs in ${compressible.length} ranges`,
    )
    lines.push("")

    if (compressible.length === 0 && contextRanges.protected.length === 0) {
        lines.push("  (no compressible ranges)")
    } else {
        lines.push(formatCompressibleRanges(compressible, contextRanges.protected))
    }

    lines.push("")
    lines.push(`Per-message listing: acp_status({scope:"uncompressed", view:"messages"})`)
    lines.push(`Filter by tool: acp_status({scope:"uncompressed", view:"messages", tool:"bash"})`)

    return lines
}

function renderUncompressedDrilldown(
    visibleMessages: VisibleMessageInfo[],
    toolFilter: string | undefined,
    sort: string,
    limit: number,
): string[] {
    const lines: string[] = []
    let filtered = visibleMessages

    if (toolFilter) {
        filtered = filtered.filter((m) => m.tool === toolFilter)
    }

    if (sort === "time") {
        filtered.sort((a, b) => a.index - b.index)
    } else if (sort === "tool") {
        filtered.sort((a, b) => a.tool.localeCompare(b.tool) || b.tokens - a.tokens)
    } else {
        filtered.sort((a, b) => b.tokens - a.tokens)
    }

    const totalTokens = filtered.reduce((s, m) => s + m.tokens, 0)
    const allTokens = visibleMessages.reduce((s, m) => s + m.tokens, 0)

    const header = toolFilter
        ? `UNCOMPRESSED — ${toolFilter}: ${formatTokens(totalTokens)} | ${filtered.length} msgs | ${pct(totalTokens, allTokens)}% of visible`
        : `UNCOMPRESSED — ${formatTokens(totalTokens)} | ${filtered.length} msgs`

    lines.push(header)
    lines.push(`Sorted by ${sort}`)
    lines.push("")

    const shown = filtered.slice(0, limit)
    for (const m of shown) {
        lines.push(`  ${m.ref} (${formatTokens(m.tokens)}) ${m.tool}`)
    }

    if (filtered.length > shown.length) {
        lines.push("")
        lines.push(
            `${shown.length} of ${filtered.length} shown (${filtered.length - shown.length} hidden).`,
        )
    }

    if (filtered.length > 1 && sort !== "time") {
        const refs = filtered.map((m) => m.index)
        const minIdx = Math.min(...refs)
        const maxIdx = Math.max(...refs)
        const span = maxIdx - minIdx
        const avgGap = span / (filtered.length - 1)
        const minRef = filtered.find((m) => m.index === minIdx)?.ref || "?"
        const maxRef = filtered.find((m) => m.index === maxIdx)?.ref || "?"
        lines.push("")
        lines.push(`Spread: ${minRef}–${maxRef} (avg gap ${avgGap.toFixed(0)} msgs)`)
    }

    return lines
}

function renderCompressedDrilldown(
    blocks: CompressionBlock[],
    sort: string,
    limit: number,
): string[] {
    const lines: string[] = []
    let sorted = [...blocks]

    if (sort === "time") {
        sorted.sort((a, b) => a.createdAt - b.createdAt)
    } else if (sort === "age") {
        sorted.sort((a, b) => (b.survivedCount || 0) - (a.survivedCount || 0))
    } else {
        sorted.sort((a, b) => (b.compressedTokens || 0) - (a.compressedTokens || 0))
    }

    const totalSummary = sorted.reduce((s, b) => s + (b.summaryTokens || 0), 0)
    const totalCompressed = sorted.reduce((s, b) => s + (b.compressedTokens || 0), 0)

    lines.push(
        `COMPRESSED — ${sorted.length} blocks | ${formatTokens(totalCompressed)} original → ${formatTokens(totalSummary)} summary`,
    )
    lines.push(`Sorted by ${sort === "time" ? "time" : sort === "age" ? "age" : "size"}`)
    lines.push("")

    const shown = sorted.slice(0, limit)
    for (const b of shown) {
        const survived = b.survivedCount ?? 0
        const gen = b.generation ?? "young"
        const effCount = b.effectiveMessageIds?.length ?? 0
        const consumed =
            b.consumedBlockIds && b.consumedBlockIds.length > 0
                ? ` nested=[${b.consumedBlockIds.map((n) => `b${n}`).join(",")}]`
                : ""
        const topic = b.topic || "(no topic)"
        lines.push(
            `  b${b.blockId}  ${formatTokens(b.compressedTokens)}→${formatTokens(b.summaryTokens)}  ${formatAge(b.createdAt)}  ${formatIdRange(b)}  age=${survived} ${gen} eff=${effCount}${consumed}`,
        )
        lines.push(`    "${topic}"`)
    }

    if (sorted.length > shown.length) {
        lines.push("")
        lines.push(`${shown.length} of ${sorted.length} shown.`)
    }

    lines.push("")
    lines.push(
        "Use decompress to restore a block's content, or search_context to search within blocks.",
    )

    return lines
}

function buildVisibleWithSummaries(rawMessages: WithParts[], ctx: ToolContext): WithParts[] {
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
            parts: [
                { type: "text", text: block.summary || "[Compressed conversation section]" } as any,
            ],
        } as any)
    }

    return visible
}

export function createAcpStatusTool(ctx: ToolContext): ReturnType<typeof tool> {
    ctx.prompts.reload()

    return tool({
        description: ACP_STATUS_TOOL_DESCRIPTION,
        args: {
            scope: tool.schema
                .string()
                .optional()
                .describe('Drill down: "compressed" or "uncompressed". No arg = overview of both.'),
            view: tool.schema
                .string()
                .optional()
                .describe(
                    'Display format for scope:"uncompressed": "ranges" (default, grouped by turn — matches nudge format) or "messages" (per-message listing with sort/filter)',
                ),
            tool: tool.schema
                .string()
                .optional()
                .describe(
                    'Filter by tool type (only with scope:"uncompressed", view:"messages"). e.g., "bash", "todowrite", "write"',
                ),
            sort: tool.schema
                .string()
                .optional()
                .describe('Sort order: "size" (default), "time", or "tool"'),
            limit: tool.schema.number().optional().describe("Max items to list (default 30)"),
        },
        async execute(args, toolCtx) {
            const scope =
                args.scope === "compressed" || args.scope === "uncompressed"
                    ? args.scope
                    : undefined
            const view = args.view === "messages" ? "messages" : "ranges"
            const toolFilter = typeof args.tool === "string" ? args.tool : undefined
            const sort =
                args.sort === "time" || args.sort === "tool" || args.sort === "age"
                    ? args.sort
                    : "size"
            const limit =
                Number.isFinite(args.limit) && args.limit! > 0 ? Math.min(args.limit!, 200) : 30

            const msgState = ctx.state.prune.messages
            const activeIds = Array.from(msgState.activeBlockIds).sort((a, b) => a - b)
            const allBlocks = activeIds
                .map((id) => msgState.blocksById.get(id))
                .filter((b): b is NonNullable<typeof b> => b !== undefined && b.active)

            const lines: string[] = []

            if (scope === "compressed") {
                lines.push(...renderCompressedDrilldown(allBlocks, sort, limit))
                return lines.join("\n")
            }

            let visibleMsgs: VisibleMessageInfo[] = []
            let summaryTokens = 0
            let fetchFailed = false
            let rawMessages: WithParts[] = []

            try {
                rawMessages = await fetchSessionMessages(ctx.client, toolCtx.sessionID)
                const result = collectVisibleMessages(rawMessages, ctx)
                visibleMsgs = result.messages
                summaryTokens = result.summaryTokens
            } catch {
                fetchFailed = true
            }

            if (scope === "uncompressed") {
                if (fetchFailed) return "(unable to fetch messages)"
                if (view === "messages") {
                    lines.push(...renderUncompressedDrilldown(visibleMsgs, toolFilter, sort, limit))
                } else {
                    lines.push(...renderUncompressedRanges(rawMessages, ctx))
                }
            } else {
                lines.push(
                    ...renderOverview(
                        visibleMsgs,
                        summaryTokens,
                        allBlocks,
                        fetchFailed,
                        rawMessages,
                        ctx,
                    ),
                )
            }

            return lines.join("\n")
        },
    })
}
