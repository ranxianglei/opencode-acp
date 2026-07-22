import { tool } from "@opencode-ai/plugin"
import type { ToolContext } from "./types"
import { countMessageCharacters, countTokens } from "../token-utils"
import { RANGE_FORMAT_EXTENSION } from "../prompts/extensions/tool"
import {
    finalizeSession,
    prepareSession,
    snapshotCompressionState,
    restoreCompressionState,
    checkLastSegmentDangerous,
    checkPhantomBlock,
    type NotificationEntry,
} from "./pipeline"
import {
    appendProtectedPromptInfo,
    appendProtectedTools,
    appendProtectedUserMessages,
    filterProtectedToolMessages,
} from "./protected-content"
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
import type { CompressRangeToolArgs } from "./types"
import { resolveKeepMarkers } from "./keep-markers"
import {
    buildQualityRejectionError,
    evaluatePreCommitQuality,
} from "./quality-gate"

function buildSchema(maxSummaryLengthHard: number) {
    return {
        topic: tool.schema
            .string()
            .optional()
            .describe(
                "Fallback topic for entries without their own. Omit when each content entry specifies its own topic.",
            ),
        content: tool.schema
            .array(
                tool.schema.object({
                    topic: tool.schema
                        .string()
                        .optional()
                        .describe(
                            "Short label (3-5 words) for THIS range, e.g. 'Auth System Exploration'. Omit to use top-level topic. When compressing multiple unrelated ranges, give each its own topic for better quality.",
                        ),
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
                        .describe(
                            "Complete technical summary replacing all content in range. Keep only essential details (conclusions, file paths, decisions, exact values, etc.).",
                        ),
                }),
            )
            .describe(
                "One or more ranges to compress, each with start/end boundaries and a summary. When compressing multiple unrelated ranges in one call, give each its own topic.",
            ),
        summaryMaxChars: tool.schema
            .number()
            .optional()
            .describe(
                `Override max summary length (default max: ${maxSummaryLengthHard} chars). Use when content is important and needs more detail — don't lose critical info just to fit the limit.`,
            ),
        dangerous: tool.schema
            .boolean()
            .optional()
            .describe(
                "Set to true ONLY when you are certain the most recent message(s) must be compressed. Required when a range includes the tail of the conversation.",
            ),
        acknowledgeRisk: tool.schema
            .boolean()
            .optional()
            .describe(
                'Set to true to bypass the quality gate when you judge the summary acceptable despite some information loss (e.g. the range is low-value, or you cannot make it denser). Usable on the first attempt. For content that matters, prefer writing a dense summary or splitting an oversized range instead.',
            ),
    }
}

export function createCompressRangeTool(ctx: ToolContext): ReturnType<typeof tool> {
    ctx.prompts.reload()
    const runtimePrompts = ctx.prompts.getRuntimePrompts()

    return tool({
        description: runtimePrompts.compressRange + RANGE_FORMAT_EXTENSION,
        args: buildSchema(ctx.config.compress.maxSummaryLengthHard),
        async execute(args, toolCtx) {
            const input = args as CompressRangeToolArgs
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
                `Compress Range: ${input.topic ?? "(batch)"}`,
            )
            const resolvedPlans = resolveRanges(input, searchContext, ctx.state)
            validateNonOverlapping(resolvedPlans)

            const filteredPlans = resolvedPlans
                .map((plan) => ({
                    ...plan,
                    selection: filterProtectedToolMessages(
                        plan.selection,
                        searchContext,
                        ctx.config.compress.protectedTools,
                        ctx.config.protectedFilePatterns,
                    ),
                }))
                .filter((plan) => plan.selection.messageIds.length > 0)

            if (filteredPlans.length === 0) {
                throw new Error(
                    "All selected messages contain protected tool outputs and cannot be compressed. Protected tools (task, skill, todowrite, etc.) must remain in visible context.",
                )
            }

            const minCompressRange = ctx.config.compress.minCompressRange
            if (minCompressRange > 0) {
                let totalChars = 0
                const counted = new Set<string>()
                for (const plan of filteredPlans) {
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

            const dangerous =
                (args as { dangerous?: boolean }).dangerous === true

            const lastSegmentError = checkLastSegmentDangerous(
                ctx,
                filteredPlans.map((p) => p.selection.messageIds),
                rawMessages,
                dangerous,
            )
            if (lastSegmentError) throw lastSegmentError

            const notifications: NotificationEntry[] = []
            const preparedPlans: Array<{
                entry: (typeof filteredPlans)[number]["entry"]
                selection: (typeof filteredPlans)[number]["selection"]
                anchorMessageId: string
                finalSummary: string
                consumedBlockIds: number[]
            }> = []
            let totalCompressedMessages = 0

            for (const plan of filteredPlans) {
                const parsedPlaceholders = parseBlockPlaceholders(plan.entry.summary)
                validateSummaryPlaceholders(
                    parsedPlaceholders,
                    plan.selection.requiredBlockIds,
                    plan.selection.startReference,
                    plan.selection.endReference,
                    searchContext.summaryByBlockId,
                    ctx.logger,
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

                // [Plan B] Auto-detect consumed blocks: requiredBlockIds already
                // covers every active block whose anchor is in [start, end]; merge
                // with boundary blocks (when start/end is a bN ref) and dedup.
                const boundaryConsumed = extractBoundaryConsumedBlocks(
                    plan.selection.startReference,
                    plan.selection.endReference,
                )
                const seenConsumed = new Set<number>()
                const mergeConsumedBlockIds = [
                    ...plan.selection.requiredBlockIds,
                    ...boundaryConsumed,
                ].filter((id) => {
                    if (seenConsumed.has(id)) return false
                    seenConsumed.add(id)
                    return true
                })

                preparedPlans.push({
                    entry: plan.entry,
                    selection: plan.selection,
                    anchorMessageId: plan.anchorMessageId,
                    finalSummary: completedSummary.expandedSummary,
                    consumedBlockIds: mergeConsumedBlockIds,
                })
            }

            const phantomError = checkPhantomBlock(
                ctx.state,
                preparedPlans.map((p) => ({
                    messageIds: p.selection.messageIds,
                    consumedBlockIds: p.consumedBlockIds,
                })),
            )
            if (phantomError) throw phantomError

            const acknowledgeRisk =
                (args as { acknowledgeRisk?: boolean }).acknowledgeRisk === true

            const qualityGateRetryPendingBefore = ctx.state.qualityGateRetryPending

            if (acknowledgeRisk) {
                ctx.state.qualityGateRetryPending = false
            } else {
                ctx.state.qualityGateRetryPending = false
                for (const plan of preparedPlans) {
                    const result = evaluatePreCommitQuality(
                        rawMessages,
                        plan.selection.messageIds,
                        plan.selection.messageTokenById,
                        plan.finalSummary,
                        ctx.config,
                        ctx.logger,
                    )
                    if (result && !result.passed) {
                        ctx.state.qualityGateRetryPending = true
                        throw buildQualityRejectionError(
                            {
                                startId: plan.entry.startId,
                                endId: plan.entry.endId,
                                summary: plan.finalSummary,
                                messageIds: plan.selection.messageIds,
                                messageTokenById: plan.selection.messageTokenById,
                            },
                            result,
                        )
                    }
                }
            }

            const snapshot = snapshotCompressionState(ctx.state)
            const runId = allocateRunId(ctx.state)

            try {
                for (const preparedPlan of preparedPlans) {
                    const blockId = allocateBlockId(ctx.state)
                    const keepResult = resolveKeepMarkers(
                        preparedPlan.finalSummary,
                        rawMessages,
                        ctx.state,
                        ctx.config,
                    )
                    preparedPlan.finalSummary = keepResult.summary
                    const storedSummary = wrapCompressedSummary(blockId, preparedPlan.finalSummary)
                    const summaryTokens = countTokens(storedSummary)

                    const applied = applyCompressionState(
                        ctx.state,
                        {
                            topic: preparedPlan.entry.topic ?? input.topic ?? "",
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

                await finalizeSession(
                    ctx,
                    toolCtx,
                    rawMessages,
                    notifications,
                    input.topic,
                )
            } catch (error) {
                restoreCompressionState(ctx.state, snapshot)
                ctx.state.qualityGateRetryPending = qualityGateRetryPendingBefore
                throw error
            }

            return `Compressed ${totalCompressedMessages} messages into ${COMPRESSED_BLOCK_HEADER}.\nIMPORTANT: This was an automatic context compression. You MUST continue your previous task exactly where you left off. Do NOT ask the user what to do next.\n💡 Tip: Use search_context('keyword') to find compressed content when you need it later.`
        },
    })
}

function extractBoundaryConsumedBlocks(
    startReference: { kind: string; blockId?: number },
    endReference: { kind: string; blockId?: number },
): number[] {
    const consumed: number[] = []
    const seen = new Set<number>()
    for (const ref of [startReference, endReference]) {
        if (
            ref.kind === "compressed-block" &&
            ref.blockId !== undefined &&
            !seen.has(ref.blockId)
        ) {
            seen.add(ref.blockId)
            consumed.push(ref.blockId)
        }
    }
    return consumed
}
