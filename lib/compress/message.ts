import { tool } from "@opencode-ai/plugin"
import type { ToolContext } from "./types"
import { countMessageCharacters, countTokens } from "../token-utils"
import { MESSAGE_FORMAT_EXTENSION } from "../prompts/extensions/tool"
import { formatIssues, formatResult, resolveMessages, validateArgs } from "./message-utils"
import { finalizeSession, prepareSession, type NotificationEntry } from "./pipeline"
import { appendProtectedPromptInfo, appendProtectedTools } from "./protected-content"
import {
    allocateBlockId,
    allocateRunId,
    applyCompressionState,
    wrapCompressedSummary,
} from "./state"
import type { CompressMessageToolArgs } from "./types"

function buildSchema() {
    return {
        topic: tool.schema
            .string()
            .describe(
                "Short label (3-5 words) for the overall batch - e.g., 'Closed Research Notes'",
            ),
        content: tool.schema
            .array(
                tool.schema.object({
                    messageId: tool.schema
                        .string()
                        .describe("Raw message ID to compress (e.g. m00001)"),
                    topic: tool.schema
                        .string()
                        .describe("Short label (3-5 words) for this one message summary"),
                    summary: tool.schema
                        .string()
                        .describe("Complete technical summary replacing that one message"),
                }),
            )
            .describe("Batch of individual message summaries to create in one tool call"),
    }
}

export function createCompressMessageTool(ctx: ToolContext): ReturnType<typeof tool> {
    ctx.prompts.reload()
    const runtimePrompts = ctx.prompts.getRuntimePrompts()

    return tool({
        description: runtimePrompts.compressMessage + MESSAGE_FORMAT_EXTENSION,
        args: buildSchema(),
        async execute(args, toolCtx) {
            const input = args as CompressMessageToolArgs
            validateArgs(input)

            const maxSummaryLength = ctx.config.compress.maxSummaryLength
            for (const entry of input.content) {
                if (entry.summary.length > maxSummaryLength) {
                    throw new Error(
                        `Summary too long (${entry.summary.length} chars, max ${maxSummaryLength}). Write a shorter summary focusing on key conclusions only.`,
                    )
                }
            }

            const callId =
                typeof (toolCtx as unknown as { callID?: unknown }).callID === "string"
                    ? (toolCtx as unknown as { callID: string }).callID
                    : undefined

            const { rawMessages, searchContext } = await prepareSession(
                ctx,
                toolCtx,
                `Compress Message: ${input.topic}`,
            )
            const { plans, skippedIssues, skippedCount } = resolveMessages(
                input,
                searchContext,
                ctx.state,
                ctx.config,
            )

            if (plans.length === 0 && skippedCount > 0) {
                throw new Error(formatIssues(skippedIssues, skippedCount))
            }

            const minCompressRange = ctx.config.compress.minCompressRange
            if (minCompressRange > 0) {
                let totalChars = 0
                const counted = new Set<string>()
                for (const plan of plans) {
                    for (const messageId of plan.selection.messageIds) {
                        if (counted.has(messageId)) continue
                        counted.add(messageId)
                        const rawMessage = searchContext.rawMessagesById.get(messageId)
                        if (rawMessage) {
                            totalChars += countMessageCharacters(rawMessage)
                        }
                    }
                }
                // Intentionally throws after prepareSession: the char count needs
                // resolved plans + rawMessages, only available post-prepare. No state
                // is persisted (finalizeSession/saveSessionState never runs).
                if (totalChars < minCompressRange) {
                    throw new Error(
                        `Range too small (${totalChars} chars, min ${minCompressRange}). Not worth compressing — overhead exceeds savings.`,
                    )
                }
            }

            const notifications: NotificationEntry[] = []

            const preparedPlans: Array<{
                plan: (typeof plans)[number]
                summaryWithTools: string
            }> = []

            for (const plan of plans) {
                const summaryWithPromptInfo = appendProtectedPromptInfo(
                    plan.entry.summary,
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

                preparedPlans.push({
                    plan,
                    summaryWithTools,
                })
            }

            const runId = allocateRunId(ctx.state)

            for (const { plan, summaryWithTools } of preparedPlans) {
                const blockId = allocateBlockId(ctx.state)
                const storedSummary = wrapCompressedSummary(blockId, summaryWithTools)
                const summaryTokens = countTokens(storedSummary)

                applyCompressionState(
                    ctx.state,
                    {
                        topic: plan.entry.topic,
                        batchTopic: input.topic,
                        startId: plan.entry.messageId,
                        endId: plan.entry.messageId,
                        mode: "message",
                        runId,
                        compressMessageId: toolCtx.messageID,
                        compressCallId: callId,
                        summaryTokens,
                    },
                    plan.selection,
                    plan.anchorMessageId,
                    blockId,
                    storedSummary,
                    [],
                    ctx.config.gc,
                )

                notifications.push({
                    blockId,
                    runId,
                    summary: summaryWithTools,
                    summaryTokens,
                })
            }

            await finalizeSession(ctx, toolCtx, rawMessages, notifications, input.topic)

            // TODO: compress input cleanup needs OpenCode API support.
            // After execution, the stored tool part's input still contains the full
            // summaries (duplicated in the block). The ToolContext exposes no API to
            // modify stored parts; rawMessages are fetched copies that don't persist;
            // and "tool.execute.after" can only modify output/title/metadata, not
            // input/args. Consider truncating compress tool inputs in the
            // "experimental.chat.messages.transform" hook instead.

            return formatResult(plans.length, skippedIssues, skippedCount)
        },
    })
}
