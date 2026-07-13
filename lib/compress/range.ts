import { tool } from "@opencode-ai/plugin"
import type { ToolContext } from "./types"
import { countMessageCharacters, countTokens } from "../token-utils"
import { RANGE_FORMAT_EXTENSION } from "../prompts/extensions/tool"
import {
    checkCompressCooldown,
    finalizeSession,
    prepareSession,
    recordCompressSuccess,
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
import type { CompressBatchTopic, CompressRangeEntry } from "./types"
import { resolveKeepMarkers } from "./keep-markers"

function rangeEntrySchema() {
    return tool.schema.object({
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
    })
}

function buildSchema(maxSummaryLengthHard: number) {
    return {
        topics: tool.schema
            .array(
                tool.schema.object({
                    topic: tool.schema
                        .string()
                        .describe(
                            "Short label (3-5 words) for this group - e.g., 'Auth System Exploration'",
                        ),
                    content: tool.schema
                        .array(rangeEntrySchema())
                        .describe("One or more ranges to compress under this topic"),
                }),
            )
            .optional()
            .describe(
                "One or more topics, each grouping multiple ranges. Compress everything that is ready in a SINGLE call — do not split into multiple compress calls. Each topic becomes its own labeled block.",
            ),
        topic: tool.schema
            .string()
            .optional()
            .describe(
                "[Legacy] Single-topic label. Prefer `topics`. Accepted for backward compatibility.",
            ),
        content: tool.schema
            .array(rangeEntrySchema())
            .optional()
            .describe(
                "[Legacy] Ranges for a single topic. Prefer `topics`. Accepted for backward compatibility.",
            ),
        summaryMaxChars: tool.schema
            .number()
            .optional()
            .describe(`Override max summary length (default max: ${maxSummaryLengthHard} chars). Use when content is important and needs more detail — don't lose critical info just to fit the limit.`),
    }
}

function normalizeTopics(input: {
    topics?: unknown
    topic?: unknown
    content?: unknown
}): CompressBatchTopic[] {
    const topicsField = input.topics
    if (Array.isArray(topicsField) && topicsField.length > 0) {
        return topicsField as CompressBatchTopic[]
    }
    if (typeof input.topic === "string" && Array.isArray(input.content)) {
        return [{ topic: input.topic, content: input.content as CompressRangeEntry[] }]
    }
    throw new Error(
        "Provide `topics` (an array of { topic, content: [{ startId, endId, summary }] }) so all ready ranges compress in one call. The legacy single-topic { topic, content } shape is also accepted.",
    )
}

export function createCompressRangeTool(ctx: ToolContext): ReturnType<typeof tool> {
    ctx.prompts.reload()
    const runtimePrompts = ctx.prompts.getRuntimePrompts()

    return tool({
        description: runtimePrompts.compressRange + RANGE_FORMAT_EXTENSION,
        args: buildSchema(ctx.config.compress.maxSummaryLengthHard),
        async execute(args, toolCtx) {
            const topics = normalizeTopics(args as Parameters<typeof normalizeTopics>[0])

            for (const topic of topics) {
                validateArgs(topic)
            }

            const maxLen =
                (args as { summaryMaxChars?: number }).summaryMaxChars ??
                ctx.config.compress.maxSummaryLengthHard
            for (const topic of topics) {
                for (const entry of topic.content) {
                    if (entry.summary.length > maxLen) {
                        throw new Error(
                            `Summary too long (${entry.summary.length} chars, max ${maxLen}).\n1. If this summary is nearly the same size as the original content, it may not be worth compressing — skip it.\n2. Strip noise (failed attempts, verbose outputs) but keep project-critical details (file paths, decisions, exact values).\n3. For important content needing detail, pass summaryMaxChars to increase the limit — don't lose critical info just to fit. Example: add "summaryMaxChars": 6000 to the tool call args.`,
                        )
                    }
                }
            }

            const callId =
                typeof (toolCtx as unknown as { callID?: unknown }).callID === "string"
                    ? (toolCtx as unknown as { callID: string }).callID
                    : undefined

            const { rawMessages, searchContext } = await prepareSession(
                ctx,
                toolCtx,
                `Compress Range: ${topics.map((t) => t.topic).join(" + ")}`,
            )
            checkCompressCooldown(ctx, rawMessages)

            const resolvedPlans = topics.flatMap((topic) =>
                resolveRanges(topic, searchContext, ctx.state),
            )
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

            const notifications: NotificationEntry[] = []
            const preparedPlans: Array<{
                topic: string
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
                    topic: plan.topic,
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
                        topic: preparedPlan.topic,
                        batchTopic: preparedPlan.topic,
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

            recordCompressSuccess(ctx, rawMessages)
            await finalizeSession(
                ctx,
                toolCtx,
                rawMessages,
                notifications,
                topics.length === 1 ? topics[0]!.topic : undefined,
            )

            // Compress input cleanup: handled by stripStaleCompressCalls in
            // lib/messages/prune.ts, called from hooks.ts during message transform.
            // Removes compress tool-call parts from previous turns so the API
            // context doesn't duplicate the summaries already injected as recaps.

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
        if (ref.kind === "compressed-block" && ref.blockId !== undefined && !seen.has(ref.blockId)) {
            seen.add(ref.blockId)
            consumed.push(ref.blockId)
        }
    }
    return consumed
}
