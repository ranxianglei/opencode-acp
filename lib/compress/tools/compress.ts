import { tool } from "@opencode-ai/plugin"
import type { ToolDefinition } from "@opencode-ai/plugin"
import type { ToolContext } from "../types"
import type { CompressMode } from "../types"
import { compressRange } from "../range-mode"
import { compressMessages } from "../message-mode"
import { saveSessionState } from "../../state/persistence"
import { formatBlockRef } from "../../infra/message-refs"
import { formatTokenCount } from "../../ui/utils"

// Class A — fresh implementation from behavioral spec (DESIGN.md §4.4).
// Registered tool name: "compress".

const TOOL_DESCRIPTION = `Compresses conversation content into a high-fidelity summary block, freeing context while preserving recoverability.

Two modes are supported:

[range] (default) — compress a contiguous span of messages:
  - startId: the mNNNNN ref of the first message in the span (required)
  - endId:   the mNNNNN ref of the last message in the span (required)
  - summary: faithful summary of the span (required)
  - topic:   short label for the block (optional)

[message] — compress individual messages into per-message blocks sharing one runId:
  - ids:     array of mNNNNN refs to compress (required)
  - summary: shared summary applied to each block (required)
  - topic:   short label for the run (optional)

Rules:
  - Summaries must preserve all decisions, file paths, signatures, and constraints needed for later work.
  - Tool outputs from protected tools are automatically appended to the summary.
  - Reversed boundaries (endId before startId) are auto-swapped.
  - Call decompress (or the /acp decompress command) to restore a block when exact detail is needed.
  - Do NOT call this tool in parallel with decompress — their state mutations may conflict.`

function buildSchema() {
    return {
        mode: tool.schema
            .enum(["range", "message"])
            .optional()
            .describe('Compression mode: "range" (span) or "message" (individual). Defaults to the configured mode.'),
        startId: tool.schema
            .string()
            .optional()
            .describe('Range mode: mNNNNN ref of the first message in the span.'),
        endId: tool.schema
            .string()
            .optional()
            .describe('Range mode: mNNNNN ref of the last message in the span.'),
        ids: tool.schema
            .array(tool.schema.string())
            .optional()
            .describe('Message mode: array of mNNNNN refs to compress individually.'),
        summary: tool.schema
            .string()
            .describe("High-fidelity summary of the content being compressed."),
        topic: tool.schema
            .string()
            .optional()
            .describe("Short label describing what the block covers."),
    }
}

function resolveMode(args: { mode?: CompressMode }, ctx: ToolContext): CompressMode {
    return args.mode ?? ctx.config.compress.mode
}

function describeErrors(errors: string[]): string {
    return errors.map((e) => `  - ${e}`).join("\n")
}

function buildRangeResult(
    blockIds: number[],
    compressedTokens: number,
    summaryTokens: number,
    errors: string[],
): string {
    const lines: string[] = []
    if (blockIds.length > 0) {
        const refs = blockIds.map((id) => formatBlockRef(id)).join(", ")
        lines.push(
            `Compressed span into block ${refs}. Freed ~${formatTokenCount(compressedTokens)} tokens (summary: ${formatTokenCount(summaryTokens)}).`,
        )
    } else {
        lines.push("Compression produced no block.")
    }
    if (errors.length > 0) {
        lines.push("Issues:")
        lines.push(describeErrors(errors))
    }
    return lines.join("\n")
}

function buildMessageResult(
    blockIds: number[],
    compressedTokens: number,
    summaryTokens: number,
    errors: string[],
): string {
    const lines: string[] = []
    if (blockIds.length > 0) {
        const refs = blockIds.map((id) => formatBlockRef(id)).join(", ")
        lines.push(
            `Compressed ${blockIds.length} message(s) into blocks ${refs}. Freed ~${formatTokenCount(compressedTokens)} tokens (summary: ${formatTokenCount(summaryTokens)} each).`,
        )
    } else {
        lines.push("Compression produced no blocks.")
    }
    if (errors.length > 0) {
        lines.push("Issues:")
        lines.push(describeErrors(errors))
    }
    return lines.join("\n")
}

export function createCompressTool(ctx: ToolContext): ToolDefinition {
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

            toolCtx.metadata({ title: "Compress" })

            const mode = resolveMode(args, ctx)
            const summary = args.summary
            const topic = args.topic

            if (mode === "range") {
                const startId = args.startId
                const endId = args.endId
                if (!startId || !endId) {
                    return "Error: range mode requires both startId and endId."
                }

                const result = compressRange(
                    ctx.config,
                    ctx.state,
                    ctx.logger,
                    ctx.messages,
                    startId,
                    endId,
                    summary,
                    topic,
                    toolCtx.messageID,
                )

                ctx.state.stats.totalPruneTokens += result.compressedTokens
                await saveSessionState(ctx.state, ctx.logger)

                ctx.logger.info("Compress tool completed (range)", {
                    blockIds: result.blockIds,
                    compressedTokens: result.compressedTokens,
                    summaryTokens: result.summaryTokens,
                })

                return buildRangeResult(
                    result.blockIds,
                    result.compressedTokens,
                    result.summaryTokens,
                    result.errors,
                )
            }

            const ids = args.ids
            if (!ids || ids.length === 0) {
                return "Error: message mode requires a non-empty ids array."
            }

            const result = compressMessages(
                ctx.config,
                ctx.state,
                ctx.logger,
                ctx.messages,
                ids,
                summary,
                topic,
                toolCtx.messageID,
            )

            ctx.state.stats.totalPruneTokens += result.compressedTokens
            await saveSessionState(ctx.state, ctx.logger)

            ctx.logger.info("Compress tool completed (message)", {
                blockIds: result.blockIds,
                compressedTokens: result.compressedTokens,
                summaryTokens: result.summaryTokens,
            })

            return buildMessageResult(
                result.blockIds,
                result.compressedTokens,
                result.summaryTokens,
                result.errors,
            )
        },
    })
}
