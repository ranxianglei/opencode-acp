import { tool } from "@opencode-ai/plugin"
import type { ToolContext } from "./types"
import { countMessageCharacters, countTokens } from "../token-utils"
import { MESSAGE_FORMAT_EXTENSION } from "../prompts/extensions/tool"
import { formatIssues, formatResult, resolveMessages, validateArgs } from "./message-utils"
import {
    finalizeSession,
    prepareSession,
    snapshotCompressionState,
    restoreCompressionState,
    type NotificationEntry,
} from "./pipeline"
import { appendProtectedPromptInfo, appendProtectedTools } from "./protected-content"
import {
    allocateBlockId,
    allocateRunId,
    applyCompressionState,
    wrapCompressedSummary,
} from "./state"
import { resolveKeepMarkers } from "./keep-markers"
import type { CompressMessageToolArgs } from "./types"

function buildSchema(maxSummaryLengthHard: number) {
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
                        .describe(
                            "Complete technical summary replacing that one message. Keep only essential details (conclusions, file paths, decisions, exact values, etc.).",
                        ),
                }),
            )
            .describe("Batch of individual message summaries to create in one tool call"),
        summaryMaxChars: tool.schema
            .number()
            .optional()
            .describe(
                `Override max summary length (default max: ${maxSummaryLengthHard} chars). Use when content is important and needs more detail — don't lose critical info just to fit the limit.`,
            ),
    }
}

export function createCompressMessageTool(ctx: ToolContext): ReturnType<typeof tool> {
    ctx.prompts.reload()
    const runtimePrompts = ctx.prompts.getRuntimePrompts()

    return tool({
        description: runtimePrompts.compressMessage + MESSAGE_FORMAT_EXTENSION,
        args: buildSchema(ctx.config.compress.maxSummaryLengthHard),
        async execute(args, toolCtx) {
            const input = args as CompressMessageToolArgs
            validateArgs(input)

            const maxLen =
                (args as { summaryMaxChars?: number }).summaryMaxChars ??
                ctx.config.compress.maxSummaryLengthHard
            for (const entry of input.content) {
                if (entry.summary.length > maxLen) {
                    throw new Error(
                        `Summary too long (${entry.summary.length} chars, max ${maxLen}).\n1. If this summary is nearly the same size as the original content, it may not be worth compressing — skip it.\n2. Strip noise (failed attempts, verbose outputs) but keep project-critical details (file paths, decisions, exact values).\n3. For important content needing detail, pass summaryMaxChars to increase the limit — don't lose critical info just to fit. Example: add "summaryMaxChars": 6000 to the tool call args.`,
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

            const snapshot = snapshotCompressionState(ctx.state)
            const runId = allocateRunId(ctx.state)

            try {
                for (const { plan, summaryWithTools } of preparedPlans) {
                    const blockId = allocateBlockId(ctx.state)
                    const keepResult = resolveKeepMarkers(
                        summaryWithTools,
                        rawMessages,
                        ctx.state,
                        ctx.config,
                    )
                    const resolvedSummary = keepResult.summary
                    const storedSummary = wrapCompressedSummary(blockId, resolvedSummary)
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
                    )

                    notifications.push({
                        blockId,
                        runId,
                        summary: resolvedSummary,
                        summaryTokens,
                    })
                }

                await finalizeSession(ctx, toolCtx, rawMessages, notifications, input.topic)
            } catch (error) {
                restoreCompressionState(ctx.state, snapshot)
                throw error
            }

            // Compress tool calls stay visible in context (Phase 2: compress-as-anchor).
            // The tool input carries the summary; no stripping needed.

            return formatResult(plans.length, skippedIssues, skippedCount)
        },
    })
}
