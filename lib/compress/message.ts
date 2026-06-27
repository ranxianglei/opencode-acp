import { tool } from "@opencode-ai/plugin"
import type { ToolContext, CompressMessageToolArgs } from "./types"
import { countTokensSync } from "../infra/token-counter"
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

export function createCompressMessageTool(ctx: any): ReturnType<typeof tool> {
    const prompts = ctx.prompts
    if (prompts && typeof prompts.reload === "function") {
        prompts.reload()
    }
    const runtimePrompts = prompts?.getRuntimePrompts?.() ?? {
        compressMessage: "",
        compressRange: "",
    }

    return tool({
        description: (runtimePrompts.compressMessage || "") + MESSAGE_FORMAT_EXTENSION,
        args: {
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
        },
        async execute(args: any, toolCtx: any) {
            const input = args as CompressMessageToolArgs
            validateArgs(input)
            const callId =
                typeof toolCtx?.callID === "string" ? toolCtx.callID : undefined

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
                const summaryTokens = countTokensSync(storedSummary)

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

            return formatResult(plans.length, skippedIssues, skippedCount)
        },
    })
}
