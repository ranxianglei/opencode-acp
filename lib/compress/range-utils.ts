import type { Logger } from "../logger"
import type { CompressionBlock, SessionState } from "../state"
import type { PluginConfig } from "../config"
import { countMessageCharacters } from "../token-utils"
import {
    filterLastUserMessage,
    filterProtectedRecentMessages,
    filterProtectedToolMessages,
} from "./protected-content"
import { resolveAnchorMessageId, resolveBoundaryIds, resolveSelection } from "./search"
import type {
    BoundaryReference,
    CompressRangeEntry,
    CompressRangeToolArgs,
    InjectedSummaryResult,
    ParsedBlockPlaceholder,
    ResolvedRangeCompression,
    SearchContext,
} from "./types"

const BLOCK_PLACEHOLDER_REGEX = /\(b(\d+)\)|\{block_(\d+)\}/gi

export function validateArgs(args: CompressRangeToolArgs): void {
    const hasTopLevelTopic = typeof args.topic === "string" && args.topic.trim().length > 0

    if (!Array.isArray(args.content) || args.content.length === 0) {
        throw new Error("content is required and must be a non-empty array")
    }

    for (let index = 0; index < args.content.length; index++) {
        const entry = args.content[index]
        const prefix = `content[${index}]`

        if (typeof entry?.startId !== "string" || entry.startId.trim().length === 0) {
            throw new Error(`${prefix}.startId is required and must be a non-empty string`)
        }

        if (typeof entry?.endId !== "string" || entry.endId.trim().length === 0) {
            throw new Error(`${prefix}.endId is required and must be a non-empty string`)
        }

        if (typeof entry?.summary !== "string" || entry.summary.trim().length === 0) {
            throw new Error(`${prefix}.summary is required and must be a non-empty string`)
        }

        const hasEntryTopic = typeof entry?.topic === "string" && entry.topic.trim().length > 0
        if (!hasEntryTopic && !hasTopLevelTopic) {
            throw new Error(
                `${prefix} needs a topic — provide ${prefix}.topic or the top-level topic`,
            )
        }
    }
}

export function resolveRanges(
    args: CompressRangeToolArgs,
    searchContext: SearchContext,
    state: SessionState,
    logger?: { warn(message: string, data?: any): void },
    options?: { includeTokenAccounting?: boolean },
): ResolvedRangeCompression[] {
    return args.content.map((entry, index) => {
        const normalizedEntry = {
            topic:
                typeof entry.topic === "string" && entry.topic.trim().length > 0
                    ? entry.topic.trim()
                    : undefined,
            startId: entry.startId.trim(),
            endId: entry.endId.trim(),
            summary: entry.summary,
        }

        const { startReference, endReference } = resolveBoundaryIds(
            searchContext,
            state,
            normalizedEntry.startId,
            normalizedEntry.endId,
            logger,
        )
        const selection = resolveSelection(searchContext, startReference, endReference, options)

        return {
            index,
            entry: normalizedEntry,
            selection,
            anchorMessageId: resolveAnchorMessageId(startReference),
        }
    })
}

export function validateNonOverlapping(plans: ResolvedRangeCompression[]): void {
    const sortedPlans = [...plans].sort(
        (left, right) =>
            left.selection.startReference.rawIndex - right.selection.startReference.rawIndex ||
            left.selection.endReference.rawIndex - right.selection.endReference.rawIndex ||
            left.index - right.index,
    )

    const issues: string[] = []

    for (let index = 1; index < sortedPlans.length; index++) {
        const previous = sortedPlans[index - 1]
        const current = sortedPlans[index]
        if (!previous || !current) {
            continue
        }

        if (current.selection.startReference.rawIndex > previous.selection.endReference.rawIndex) {
            continue
        }

        issues.push(
            `content[${previous.index}] (${previous.entry.startId}..${previous.entry.endId}) overlaps content[${current.index}] (${current.entry.startId}..${current.entry.endId}). Overlapping ranges cannot be compressed in the same batch.`,
        )
    }

    if (issues.length > 0) {
        throw new Error(
            issues.length === 1 ? issues[0] : issues.map((issue) => `- ${issue}`).join("\n"),
        )
    }
}

export interface ExecutableRangePlansResult {
    plans: ResolvedRangeCompression[]
    totalChars: number
}

/**
 * Resolve and apply the exact range execution boundaries used by compression.
 * The order here is load-bearing: tool-pair expansion happens during resolve,
 * before the later soft filters are applied.
 */
export function prepareExecutableRangePlans(
    args: CompressRangeToolArgs | CompressRangeEntry,
    searchContext: SearchContext,
    state: SessionState,
    config: PluginConfig,
    logger?: Logger,
    options?: { includeTokenAccounting?: boolean },
): ExecutableRangePlansResult {
    const normalizedArgs: CompressRangeToolArgs =
        "content" in args
            ? args
            : {
                  content: [args],
              }
    const resolvedPlans = resolveRanges(normalizedArgs, searchContext, state, logger, options)
    validateNonOverlapping(resolvedPlans)

    const plans = resolvedPlans
        .map((plan) => ({
            ...plan,
            selection: filterProtectedToolMessages(
                plan.selection,
                searchContext,
                config.compress.protectedTools,
                config.protectedFilePatterns,
            ),
        }))
        .map((plan) => ({
            ...plan,
            selection: filterLastUserMessage(plan.selection, searchContext, state, config.compress),
        }))
        .map((plan) => ({
            ...plan,
            selection: filterProtectedRecentMessages(
                plan.selection,
                searchContext,
                state,
                config.compress,
            ),
        }))
        .filter((plan) => plan.selection.messageIds.length > 0)

    if (plans.length === 0) {
        throw new Error(
            "All selected messages were filtered out (protected tool outputs and/or the last user message). They must remain in visible context.",
        )
    }

    const counted = new Set<string>()
    let totalChars = 0
    for (const plan of plans) {
        for (const messageId of plan.selection.messageIds) {
            if (counted.has(messageId)) continue
            counted.add(messageId)
            const rawMessage = searchContext.rawMessagesById.get(messageId)
            if (rawMessage) totalChars += countMessageCharacters(rawMessage)
        }
    }

    if (config.compress.minCompressRange > 0 && totalChars < config.compress.minCompressRange) {
        throw new Error(
            `Range too small (${totalChars} chars, min ${config.compress.minCompressRange}). Not worth compressing — overhead exceeds savings.`,
        )
    }

    return { plans, totalChars }
}

export function parseBlockPlaceholders(summary: string): ParsedBlockPlaceholder[] {
    const placeholders: ParsedBlockPlaceholder[] = []
    const regex = new RegExp(BLOCK_PLACEHOLDER_REGEX)

    let match: RegExpExecArray | null
    while ((match = regex.exec(summary)) !== null) {
        const full = match[0]
        const blockIdPart = match[1] || match[2]
        const parsed = Number.parseInt(blockIdPart, 10)
        if (!Number.isInteger(parsed)) {
            continue
        }

        placeholders.push({
            raw: full,
            blockId: parsed,
            startIndex: match.index,
            endIndex: match.index + full.length,
        })
    }

    return placeholders
}

export function validateSummaryPlaceholders(
    placeholders: ParsedBlockPlaceholder[],
    requiredBlockIds: number[],
    startReference: BoundaryReference,
    endReference: BoundaryReference,
    summaryByBlockId: Map<number, CompressionBlock>,
    logger: Logger,
): number[] {
    const boundaryOptionalIds = new Set<number>()
    if (startReference.kind === "compressed-block") {
        if (startReference.blockId === undefined) {
            throw new Error("Failed to map boundary matches back to raw messages")
        }
        boundaryOptionalIds.add(startReference.blockId)
    }
    if (endReference.kind === "compressed-block") {
        if (endReference.blockId === undefined) {
            throw new Error("Failed to map boundary matches back to raw messages")
        }
        boundaryOptionalIds.add(endReference.blockId)
    }

    const strictRequiredIds = requiredBlockIds.filter((id) => !boundaryOptionalIds.has(id))
    const requiredSet = new Set(requiredBlockIds)
    const keptPlaceholderIds = new Set<number>()
    const validPlaceholders: ParsedBlockPlaceholder[] = []

    for (const placeholder of placeholders) {
        const isKnown = summaryByBlockId.has(placeholder.blockId)
        const isRequired = requiredSet.has(placeholder.blockId)
        const isDuplicate = keptPlaceholderIds.has(placeholder.blockId)

        if (isKnown && isRequired && !isDuplicate) {
            validPlaceholders.push(placeholder)
            keptPlaceholderIds.add(placeholder.blockId)
        }
    }

    placeholders.length = 0
    placeholders.push(...validPlaceholders)

    const missingIds = strictRequiredIds.filter((id) => !keptPlaceholderIds.has(id))
    // [Plan B] Missing placeholders are non-fatal: the compress pipeline
    // auto-detects every consumed block in range, so the model no longer
    // needs to manually list (bN) placeholders in its summary.
    if (missingIds.length > 0) {
        logger.warn(
            `compress summary omitted placeholders for required blocks: ${missingIds
                .map((id) => `b${id}`)
                .join(", ")}. They will be auto-attached as consumed blocks.`,
        )
    }
    return missingIds
}

export function injectBlockPlaceholders(
    summary: string,
    _placeholders: ParsedBlockPlaceholder[],
    _summaryByBlockId: Map<number, CompressionBlock>,
    _startReference: BoundaryReference,
    _endReference: BoundaryReference,
): InjectedSummaryResult {
    return {
        expandedSummary: summary,
        consumedBlockIds: [],
    }
}

export function appendMissingBlockSummaries(
    summary: string,
    _missingBlockIds: number[],
    _summaryByBlockId: Map<number, CompressionBlock>,
    consumedBlockIds: number[],
): InjectedSummaryResult {
    return {
        expandedSummary: summary,
        consumedBlockIds: [...consumedBlockIds],
    }
}
