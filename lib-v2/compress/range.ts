import { tool } from "@opencode-ai/plugin"
import type { ToolContext, CompressRangeToolArgs } from "./types"
import { countTokensSync } from "../infra/token-counter"
import { RANGE_FORMAT_EXTENSION } from "../prompts/extensions/tool"
import { finalizeSession, prepareSession, type NotificationEntry } from "./pipeline"
import { appendProtectedPromptInfo, appendProtectedTools, appendProtectedUserMessages } from "./protected-content"
import {
    appendMissingBlockSummaries,
    injectBlockPlaceholders,
    parseBlockPlaceholders,
    resolveRanges,
    validateArgs,
    validateNonOverlapping,
    validateSummaryPlaceholders,
} from "./range-utils"
import {
    COMPRESSED_BLOCK_HEADER,
    allocateBlockId,
    allocateRunId,
    applyCompressionState,
    wrapCompressedSummary,
} from "./state"

function extractBoundaryConsumedBlocks(
    startReference: any,
    endReference: any,
): number[] {
    const ids: number[] = []
    if (startReference?.kind === "compressed-block" && typeof startReference.blockId === "number") {
        ids.push(startReference.blockId)
    }
    if (endReference?.kind === "compressed-block" && typeof endReference.blockId === "number") {
        ids.push(endReference.blockId)
    }
    return ids
}

export function createCompressRangeTool(ctx: any): ReturnType<typeof tool> {
    const prompts = ctx.prompts
    if (prompts && typeof prompts.reload === "function") {
        prompts.reload()
    }
    const runtimePrompts = prompts?.getRuntimePrompts?.() ?? {
        compressMessage: "",
        compressRange: "",
    }

    return tool({
        description: (runtimePrompts.compressRange || "") + RANGE_FORMAT_EXTENSION,
        args: {
            topic: tool.schema
                .string()
                .describe("Short label (3-5 words) for display - e.g., 'Auth System Exploration'"),
            content: tool.schema
                .array(
                    tool.schema.object({
                        startId: tool.schema
                            .string()
                            .describe(
                                "Message or block ID marking the beginning of range (e.g. m00001, b2)",
                            ),
                        endId: tool.schema
                            .string()
                            .describe("Message or block ID marking the end of range (e.g. m00012, b5)"),
                        summary: tool.schema
                            .string()
                            .describe("Complete technical summary replacing all content in range"),
                    }),
                )
                .describe(
                    "One or more ranges to compress, each with start/end boundaries and a summary",
                ),
        },
        async execute(args: any, toolCtx: any) {
            const input = args as CompressRangeToolArgs
            validateArgs(input)
            const callId =
                typeof toolCtx?.callID === "string" ? toolCtx.callID : undefined

            const { rawMessages, searchContext } = await prepareSession(
                ctx,
                toolCtx,
                `Compress Range: ${input.topic}`,
            )
            const resolvedPlans = resolveRanges(input, searchContext, ctx.state)
            validateNonOverlapping(resolvedPlans)

            const notifications: NotificationEntry[] = []
            const preparedPlans: Array<{
                entry: (typeof resolvedPlans)[number]["entry"]
                selection: (typeof resolvedPlans)[number]["selection"]
                anchorMessageId: string
                finalSummary: string
                consumedBlockIds: number[]
            }> = []
            let totalCompressedMessages = 0

            for (const plan of resolvedPlans) {
                const parsedPlaceholders = parseBlockPlaceholders(plan.entry.summary)
                validateSummaryPlaceholders(
                    parsedPlaceholders,
                    plan.selection.requiredBlockIds,
                    plan.selection.startReference,
                    plan.selection.endReference,
                    searchContext.summaryByBlockId,
                )

                const injected = injectBlockPlaceholders(
                    plan.entry.summary,
                    parsedPlaceholders,
                    searchContext.summaryByBlockId,
                    plan.selection.startReference,
                    plan.selection.endReference,
                )

                const summaryWithUsers = appendProtectedUserMessages(
                    injected.expandedSummary,
                    plan.selection,
                    searchContext,
                    ctx.state,
                    ctx.config.compress.protectUserMessages,
                )

                const summaryWithPromptInfo = appendProtectedPromptInfo(
                    summaryWithUsers,
                    plan.selection,
                    searchContext,
                    ctx.state,
                    ctx.config.compress.protectTags,
                )

                const summaryWithTools = await appendProtectedTools(
                    ctx.client,
                    ctx.state,
                    ctx.config.experimental.allowSubAgents,
                    summaryWithPromptInfo,
                    plan.selection,
                    searchContext,
                    ctx.config.compress.protectedTools,
                    ctx.config.protectedFilePatterns,
                )

                const completedSummary = appendMissingBlockSummaries(
                    summaryWithTools,
                    [],
                    searchContext.summaryByBlockId,
                    injected.consumedBlockIds,
                )

                const mergeConsumedBlockIds = extractBoundaryConsumedBlocks(
                    plan.selection.startReference,
                    plan.selection.endReference,
                )

                preparedPlans.push({
                    entry: plan.entry,
                    selection: plan.selection,
                    anchorMessageId: plan.anchorMessageId,
                    finalSummary: completedSummary.expandedSummary,
                    consumedBlockIds: mergeConsumedBlockIds,
                })
            }

            const runId = allocateRunId(ctx.state)

            for (const preparedPlan of preparedPlans) {
                const blockId = allocateBlockId(ctx.state)
                const storedSummary = wrapCompressedSummary(blockId, preparedPlan.finalSummary)
                const summaryTokens = countTokensSync(storedSummary)

                const applied = applyCompressionState(
                    ctx.state,
                    {
                        topic: preparedPlan.entry.topic || input.topic,
                        batchTopic: input.topic,
                        startId: preparedPlan.entry.startId,
                        endId: preparedPlan.entry.endId,
                        mode: "range",
                        runId,
                        compressMessageId: toolCtx.messageID,
                        compressCallId: callId,
                        summaryTokens,
                    },
                    preparedPlan.selection,
                    preparedPlan.anchorMessageId,
                    blockId,
                    storedSummary,
                    preparedPlan.consumedBlockIds,
                    ctx.config.gc,
                )

                totalCompressedMessages += applied.messageIds.length

                notifications.push({
                    blockId,
                    runId,
                    summary: preparedPlan.finalSummary,
                    summaryTokens,
                })
            }

            await finalizeSession(ctx, toolCtx, rawMessages, notifications, input.topic)

            return `Compressed ${totalCompressedMessages} messages into ${COMPRESSED_BLOCK_HEADER}.\nIMPORTANT: This was an automatic context compression. You MUST continue your previous task exactly where you left off. Do NOT ask the user what to do next.`
        },
    })
}

export type { ToolContext }
