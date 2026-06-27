// Class A — fresh implementation from behavioral spec (DESIGN.md §4.4).
// Registered tool name: "batch".

import { tool } from "@opencode-ai/plugin"
import type { ToolDefinition } from "@opencode-ai/plugin"
import type { ToolContext, CompressionResult } from "../types"
import { compressRange } from "../range-mode"
import { compressMessages } from "../message-mode"
import { saveSessionState } from "../../state/persistence"
import { formatBlockRef } from "../../infra/message-refs"
import { formatTokenCount } from "../../ui/utils"

const TOOL_DESCRIPTION = `Compresses multiple ranges and/or messages in a single call.

Each operation allocates its own block, applied in sequence. Use this when several
spans can be summarized independently — it avoids repeated round-trips and lets you
free a large amount of context at once.

Arguments (all optional, but at least one of ranges/messages must be non-empty):
  - ranges:   array of { startId, endId, summary, topic? } — each compresses a span
  - messages: array of { ids, summary, topic? } — each compresses a set of messages

All operations share the session's current compression state; later entries see the
state left by earlier ones. A single failure does not abort the batch — the tool
records an error for that entry and continues with the rest.

Do NOT call this tool in parallel with compress or decompress — state mutations may conflict.`

function buildSchema() {
    return {
        ranges: tool.schema
            .array(
                tool.schema.object({
                    startId: tool.schema.string(),
                    endId: tool.schema.string(),
                    summary: tool.schema.string(),
                    topic: tool.schema.string().optional(),
                }),
            )
            .optional()
            .describe("Range-mode operations to apply in order."),
        messages: tool.schema
            .array(
                tool.schema.object({
                    ids: tool.schema.array(tool.schema.string()),
                    summary: tool.schema.string(),
                    topic: tool.schema.string().optional(),
                }),
            )
            .optional()
            .describe("Message-mode operations to apply in order."),
    }
}

interface BatchTotals {
    blockIds: number[]
    compressedTokens: number
    summaryTokens: number
    errors: string[]
    rangeCount: number
    messageRuns: number
}

function emptyTotals(): BatchTotals {
    return {
        blockIds: [],
        compressedTokens: 0,
        summaryTokens: 0,
        errors: [],
        rangeCount: 0,
        messageRuns: 0,
    }
}

function accumulate(totals: BatchTotals, result: CompressionResult): void {
    for (const id of result.blockIds) {
        totals.blockIds.push(id)
    }
    totals.compressedTokens += result.compressedTokens
    totals.summaryTokens += result.summaryTokens
    for (const err of result.errors) {
        totals.errors.push(err)
    }
}

export function createBatchTool(ctx: ToolContext): ToolDefinition {
    return tool({
        description: TOOL_DESCRIPTION,
        args: buildSchema(),
        async execute(args, toolCtx) {
            if (ctx.config.compress.permission === "ask") {
                await toolCtx.ask({
                    permission: "compress",
                    patterns: ["*"],
                    always: ["*"],
                    metadata: {},
                })
            }

            toolCtx.metadata({ title: "Batch compress" })

            const ranges = args.ranges ?? []
            const messages = args.messages ?? []

            if (ranges.length === 0 && messages.length === 0) {
                return "Error: batch requires at least one range or message operation."
            }

            const totals = emptyTotals()

            for (const entry of ranges) {
                if (!entry.startId || !entry.endId || !entry.summary) {
                    totals.errors.push(
                        "Skipped range entry: startId, endId, and summary are required.",
                    )
                    continue
                }

                const result = compressRange(
                    ctx.config,
                    ctx.state,
                    ctx.logger,
                    ctx.messages,
                    entry.startId,
                    entry.endId,
                    entry.summary,
                    entry.topic,
                    toolCtx.messageID,
                )
                totals.rangeCount += result.blockIds.length > 0 ? 1 : 0
                accumulate(totals, result)
            }

            for (const entry of messages) {
                if (!entry.ids || entry.ids.length === 0 || !entry.summary) {
                    totals.errors.push(
                        "Skipped message entry: ids (non-empty) and summary are required.",
                    )
                    continue
                }

                const result = compressMessages(
                    ctx.config,
                    ctx.state,
                    ctx.logger,
                    ctx.messages,
                    entry.ids,
                    entry.summary,
                    entry.topic,
                    toolCtx.messageID,
                )
                totals.messageRuns += result.blockIds.length > 0 ? 1 : 0
                accumulate(totals, result)
            }

            ctx.state.stats.totalPruneTokens += totals.compressedTokens
            await saveSessionState(ctx.state, ctx.logger)

            const lines: string[] = []
            const refs = totals.blockIds.map((id) => formatBlockRef(id)).join(", ")
            lines.push(
                `Batch complete: ${totals.rangeCount} range(s) and ${totals.messageRuns} message run(s) → blocks ${refs || "(none)"}. Freed ~${formatTokenCount(totals.compressedTokens)} tokens.`,
            )
            if (totals.errors.length > 0) {
                lines.push("Issues:")
                for (const err of totals.errors) {
                    lines.push(`  - ${err}`)
                }
            }

            ctx.logger.info("Batch tool completed", {
                blockIds: totals.blockIds,
                rangeCount: totals.rangeCount,
                messageRuns: totals.messageRuns,
                compressedTokens: totals.compressedTokens,
                errorCount: totals.errors.length,
            })

            return lines.join("\n")
        },
    })
}
