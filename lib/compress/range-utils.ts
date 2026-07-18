import type { Logger } from "../logger"
import type { CompressionBlock, SessionState } from "../state"
import { resolveAnchorMessageId, resolveBoundaryIds, resolveSelection } from "./search"
import type {
    BoundaryReference,
    CompressRangeToolArgs,
    InjectedSummaryResult,
    ParsedBlockPlaceholder,
    ResolvedRangeCompression,
    SearchContext,
} from "./types"

const BLOCK_PLACEHOLDER_REGEX = /\(b(\d+)\)|\{block_(\d+)\}/gi

export function validateArgs(args: CompressRangeToolArgs): void {
    const hasTopLevelTopic =
        typeof args.topic === "string" && args.topic.trim().length > 0

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

        const hasEntryTopic =
            typeof entry?.topic === "string" && entry.topic.trim().length > 0
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
        )
        const selection = resolveSelection(searchContext, startReference, endReference)

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

