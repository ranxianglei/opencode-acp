import { tool } from "@opencode-ai/plugin"
import type { ToolContext } from "./types"
import { countMessageCharacters, countTokens } from "../token-utils"
import { RANGE_FORMAT_EXTENSION } from "../prompts/extensions/tool"
import { finalizeSession, prepareSession, type NotificationEntry } from "./pipeline"
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

function buildSchema(maxSummaryLengthHard: number) {
    return {
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
                        .describe(
                            "Complete technical summary replacing all content in range. Keep only essential details (conclusions, file paths, decisions, exact values, etc.).",
                        ),
                }),
            )
            .optional()
            .describe(
                "Range mode: one or more contiguous ranges to compress, each with start/end boundaries and a summary",
            ),
        toolType: tool.schema
            .string()
            .optional()
            .describe(
                'Prune mode: remove all old messages of this tool type (e.g. "todowrite", "edit"). Keeps only recent ones. Use for disposable tool outputs.',
            ),
        keepLatest: tool.schema
            .number()
            .optional()
            .describe("Prune mode: how many recent messages to keep (default 3)"),
        summaryMaxChars: tool.schema
            .number()
            .optional()
            .describe(`Override max summary length (default max: ${maxSummaryLengthHard} chars). Use when content is important and needs more detail — don't lose critical info just to fit the limit.`),
    }
}

export function createCompressRangeTool(ctx: ToolContext): ReturnType<typeof tool> {
    ctx.prompts.reload()
    const runtimePrompts = ctx.prompts.getRuntimePrompts()

    return tool({
        description: runtimePrompts.compressRange + RANGE_FORMAT_EXTENSION,
        args: buildSchema(ctx.config.compress.maxSummaryLengthHard),
        async execute(args, toolCtx) {
            const callId =
                typeof (toolCtx as unknown as { callID?: unknown }).callID === "string"
                    ? (toolCtx as unknown as { callID: string }).callID
                    : undefined

            if (typeof args.toolType === "string") {
                return executePruneMode(ctx, toolCtx, { topic: args.topic, toolType: args.toolType, keepLatest: args.keepLatest }, callId)
            }

            const input = args as CompressRangeToolArgs
            validateArgs(input)

            const maxLen = (args as { summaryMaxChars?: number }).summaryMaxChars ?? ctx.config.compress.maxSummaryLengthHard
            for (const entry of input.content) {
                if (entry.summary.length > maxLen) {
                    throw new Error(
                        `Summary too long (${entry.summary.length} chars, max ${maxLen}).\n1. If this summary is nearly the same size as the original content, it may not be worth compressing — skip it.\n2. Strip noise (failed attempts, verbose outputs) but keep project-critical details (file paths, decisions, exact values).\n3. For important content needing detail, pass summaryMaxChars to increase the limit — don't lose critical info just to fit. Example: add "summaryMaxChars": 6000 to the tool call args.`,
                    )
                }
            }

            const { rawMessages, searchContext } = await prepareSession(
                ctx,
                toolCtx,
                `Compress Range: ${input.topic}`,
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

            const runId = allocateRunId(ctx.state)

            for (const preparedPlan of preparedPlans) {
                const blockId = allocateBlockId(ctx.state)
                const storedSummary = wrapCompressedSummary(blockId, preparedPlan.finalSummary)
                const summaryTokens = countTokens(storedSummary)

                const applied = applyCompressionState(
                    ctx.state,
                    {
                        topic: input.topic,
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

            // TODO: compress input cleanup needs OpenCode API support.
            // After execution, the stored tool part's input still contains the full
            // summaries (duplicated in the block). The ToolContext exposes no API to
            // modify stored parts; rawMessages are fetched copies that don't persist;
            // and "tool.execute.after" can only modify output/title/metadata, not
            // input/args. Consider truncating compress tool inputs in the
            // "experimental.chat.messages.transform" hook instead.

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

async function executePruneMode(
    ctx: ToolContext,
    toolCtx: any,
    args: { topic: string; toolType: string; keepLatest?: number },
    callId: string | undefined,
): Promise<string> {
    const keepLatest = args.keepLatest ?? 3
    const { rawMessages, searchContext } = await prepareSession(
        ctx,
        toolCtx,
        `Prune: ${args.topic}`,
    )

    const matchingMessages: Array<{ messageId: string; index: number; tokens: number }> = []
    for (let i = 0; i < rawMessages.length; i++) {
        const msg = rawMessages[i]
        if (!msg) continue
        const msgId = (msg.info as any)?.id || ""
        if (!msgId) continue

        const pruneEntry = ctx.state.prune.messages.byMessageId.get(msgId)
        if (pruneEntry && pruneEntry.activeBlockIds.length > 0) continue

        let hasTool = false
        let tokenCount = 0
        for (const part of msg.parts || []) {
            if (part.type === "tool") {
                const partTool = (part as any)?.tool || ""
                if (partTool === args.toolType) {
                    hasTool = true
                }
            }
            if (part.type === "text") {
                tokenCount += Math.round(((part as any).text || "").length / 4)
            } else if (part.type === "tool") {
                tokenCount += Math.round(JSON.stringify(part).length / 4)
            }
        }

        if (hasTool) {
            matchingMessages.push({ messageId: msgId, index: i, tokens: tokenCount })
        }
    }

    if (matchingMessages.length <= keepLatest) {
        return `Nothing to prune — only ${matchingMessages.length} ${args.toolType} messages visible (keepLatest=${keepLatest}).`
    }

    matchingMessages.sort((a, b) => a.index - b.index)
    const toPrune = matchingMessages.slice(0, matchingMessages.length - keepLatest)

    const firstRef = ctx.state.messageIds.byRawId.get(toPrune[0]!.messageId) || "?"
    const lastRef = ctx.state.messageIds.byRawId.get(toPrune[toPrune.length - 1]!.messageId) || "?"

    const messageTokenById = new Map<string, number>()
    for (const m of toPrune) {
        messageTokenById.set(m.messageId, m.tokens)
    }

    const blockId = allocateBlockId(ctx.state)
    const runId = allocateRunId(ctx.state)

    const summary = `Pruned ${toPrune.length} ${args.toolType} messages (old outputs removed, latest ${keepLatest} kept). Range: ${firstRef}–${lastRef}.`
    const storedSummary = wrapCompressedSummary(blockId, summary)
    const summaryTokens = countTokens(storedSummary)

    applyCompressionState(
        ctx.state,
        {
            topic: args.topic,
            batchTopic: args.topic,
            startId: firstRef,
            endId: lastRef,
            mode: "range",
            runId,
            compressMessageId: toolCtx.messageID,
            compressCallId: callId,
            summaryTokens,
        },
        {
            startReference: { kind: "message", rawIndex: toPrune[0]!.index },
            endReference: { kind: "message", rawIndex: toPrune[toPrune.length - 1]!.index },
            messageIds: toPrune.map((m) => m.messageId),
            messageTokenById,
            toolIds: [],
            requiredBlockIds: [],
        },
        toPrune[0]!.messageId,
        blockId,
        storedSummary,
        [],
        ctx.config.gc,
    )

    await finalizeSession(
        ctx,
        toolCtx,
        rawMessages,
        [{ blockId, runId, summary, summaryTokens }],
        args.topic,
    )

    return `Pruned ${toPrune.length} ${args.toolType} messages (kept latest ${keepLatest}). Range: ${firstRef}–${lastRef}.\nIMPORTANT: This was an automatic context pruning. You MUST continue your previous task exactly where you left off. Do NOT ask the user what to do next.`
}
