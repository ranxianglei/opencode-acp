import type { CompressibleRange } from "../messages/inject/utils"
import { countMessageCharacters } from "../token-utils"
import type { ToolContext, SearchContext } from "./types"

type SmartPlanContext = Pick<ToolContext, "state" | "logger" | "config">
import {
    filterLastUserMessage,
    filterProtectedRecentMessages,
    filterProtectedToolMessages,
} from "./protected-content"
import { resolveRanges } from "./range-utils"

export const SMART_PLAN_TTL_MS = 10 * 60 * 1000

export interface SmartCompressionPlan {
    sessionID: string
    createdAt: number
    structureVersion: number
    startId: string
    endId: string
    exactChars: number
    messageIds: string[]
}

const armedPlans = new Map<string, SmartCompressionPlan>()
const visibleMessageIdsBySession = new Map<string, Set<string>>()

function refNumber(ref: string): number {
    const value = Number.parseInt(ref.slice(1), 10)
    return Number.isFinite(value) ? value : -1
}

/** Merge artificial size/turn splits, but never cross a protected ref gap. */
function mergeAdjacentSafeRanges(ranges: CompressibleRange[]): CompressibleRange[] {
    const merged: CompressibleRange[] = []
    for (const range of ranges.filter((candidate) => !candidate.dangerous)) {
        const previous = merged.at(-1)
        if (previous && refNumber(range.startRef) === refNumber(previous.endRef) + 1) {
            const previousEffective = previous.effectiveTokens ?? previous.tokens
            previous.endRef = range.endRef
            previous.count += range.count
            previous.tokens += range.tokens
            previous.effectiveTokens = previousEffective + (range.effectiveTokens ?? range.tokens)
            continue
        }
        merged.push({ ...range })
    }
    return merged
}

/** Record the exact post-transform messages supplied to the model. */
export function recordVisibleMessages(
    sessionID: string,
    messages: Array<{ info: { id: string } }>,
): void {
    visibleMessageIdsBySession.set(sessionID, new Set(messages.map((message) => message.info.id)))
}

export function getVisibleMessageIds(sessionID: string): ReadonlySet<string> | undefined {
    return visibleMessageIdsBySession.get(sessionID)
}

export function clearSmartPlan(sessionID: string): void {
    armedPlans.delete(sessionID)
}

export function clearSmartPlanSession(sessionID: string): void {
    armedPlans.delete(sessionID)
    visibleMessageIdsBySession.delete(sessionID)
}

export function consumeSmartPlan(sessionID: string): void {
    armedPlans.delete(sessionID)
}

export function getSmartPlan(sessionID: string): SmartCompressionPlan | undefined {
    return armedPlans.get(sessionID)
}

function filteredSelection(
    startId: string,
    endId: string,
    searchContext: SearchContext,
    ctx: SmartPlanContext,
) {
    const [resolved] = resolveRanges(
        {
            topic: "ACP smart plan",
            content: [{ startId, endId, summary: "Pending model-authored summary." }],
        },
        searchContext,
        ctx.state,
        ctx.logger,
    )
    if (!resolved) return undefined
    let selection = filterProtectedToolMessages(
        resolved.selection,
        searchContext,
        ctx.config.compress.protectedTools,
        ctx.config.protectedFilePatterns,
    )
    selection = filterLastUserMessage(selection, searchContext, ctx.state, ctx.config.compress)
    selection = filterProtectedRecentMessages(
        selection,
        searchContext,
        ctx.state,
        ctx.config.compress,
    )
    return selection
}

export function armBestSmartPlan(
    sessionID: string,
    ranges: CompressibleRange[],
    searchContext: SearchContext,
    ctx: SmartPlanContext,
    visibleMessageIds?: ReadonlySet<string>,
    now = Date.now(),
    targetChars = ctx.config.compress.minCompressRange,
): SmartCompressionPlan | undefined {
    const candidates: Array<SmartCompressionPlan & { rawStart: number }> = []
    for (const range of mergeAdjacentSafeRanges(ranges)) {
        const selection = filteredSelection(range.startRef, range.endRef, searchContext, ctx)
        if (!selection || selection.messageIds.length === 0) continue
        if (visibleMessageIds && !selection.messageIds.every((id) => visibleMessageIds.has(id)))
            continue
        let exactChars = 0
        for (const messageId of selection.messageIds) {
            const message = searchContext.rawMessagesById.get(messageId)
            if (message) exactChars += countMessageCharacters(message)
        }
        if (
            ctx.config.compress.minCompressRange > 0 &&
            exactChars < ctx.config.compress.minCompressRange
        ) {
            continue
        }
        candidates.push({
            sessionID,
            createdAt: now,
            structureVersion: ctx.state.prune.messages.structureVersion ?? 0,
            startId: range.startRef,
            endId: range.endRef,
            exactChars,
            messageIds: [...selection.messageIds],
            rawStart: selection.startReference.rawIndex,
        })
    }

    // Prefer the oldest span that reaches the requested reclaim target. If no
    // span can reach it, take the largest available span so a late nudge makes
    // maximum progress toward the next native-compaction watermark.
    const sufficient = candidates.filter((candidate) => candidate.exactChars >= targetChars)
    const pool = sufficient.length > 0 ? sufficient : candidates
    pool.sort((a, b) =>
        sufficient.length > 0
            ? a.rawStart - b.rawStart || b.exactChars - a.exactChars
            : b.exactChars - a.exactChars || a.rawStart - b.rawStart,
    )
    const best = pool[0]
    if (!best) {
        clearSmartPlan(sessionID)
        return undefined
    }
    const { rawStart: _rawStart, ...plan } = best
    armedPlans.set(sessionID, plan)
    return plan
}

export function validateSmartPlan(
    sessionID: string,
    startId: string,
    endId: string,
    messageIds: string[],
    exactChars: number,
    structureVersion: number,
    now = Date.now(),
): SmartCompressionPlan {
    const plan = armedPlans.get(sessionID)
    const preflight =
        'Use the exact SMART PLAN range from the latest ACP nudge, or call acp_status({scope:"uncompressed"}) to refresh it.'
    if (!plan) throw new Error(`No smart compression plan is armed. ${preflight}`)
    if (now - plan.createdAt > SMART_PLAN_TTL_MS) {
        clearSmartPlan(sessionID)
        throw new Error(`Smart compression plan expired. ${preflight}`)
    }
    if (plan.structureVersion !== structureVersion) {
        clearSmartPlan(sessionID)
        throw new Error(
            `Smart compression plan is stale because compression state changed. ${preflight}`,
        )
    }
    if (plan.startId !== startId || plan.endId !== endId) {
        throw new Error(
            `Range does not match the armed smart plan (${plan.startId}-${plan.endId}). Do not sort, merge, or batch ranges.`,
        )
    }
    const idsMatch =
        plan.messageIds.length === messageIds.length &&
        plan.messageIds.every((id, i) => id === messageIds[i])
    const charsDiff = Math.abs(plan.exactChars - exactChars)
    const charsMatch =
        charsDiff === 0 || charsDiff <= 300 || charsDiff / Math.max(plan.exactChars, 1) < 0.02
    if (!idsMatch || !charsMatch) {
        clearSmartPlan(sessionID)
        throw new Error(
            `Smart compression plan no longer resolves to the armed messages. ${preflight}`,
        )
    }
    const visibleMessageIds = getVisibleMessageIds(sessionID)
    if (visibleMessageIds && !plan.messageIds.every((id) => visibleMessageIds.has(id))) {
        clearSmartPlan(sessionID)
        throw new Error(
            `Smart compression plan moved outside the model's visible context. ${preflight}`,
        )
    }
    return plan
}
