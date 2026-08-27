import type { PluginConfig } from "../../config"
import { countMessageCharacters } from "../../token-utils"
import { isIgnoredUserMessage, isSyntheticMessage } from "../query"
import type { SessionState, WithParts } from "../../state"
import { computeProtectedRefs } from "./utils"
import { messageContainsProtectedTool } from "../../compress/protected-content"
import { buildSearchContext } from "../../compress/search"
import {
    prepareExecutableRangePlans,
    type ExecutableRangePlansResult,
} from "../../compress/range-utils"

export type CompressionCandidateKind = "micro" | "episode"

export type CandidateOmissionReason =
    | "missing-reference"
    | "synthetic-or-ignored"
    | "active-compression"
    | "protected-tool-or-file"
    | "recent-protection"
    | "below-minimum"
    | "executor-selection-drift"
    | "executor-rejected"

export interface CompressionCandidate {
    kind: CompressionCandidateKind
    startRef: string
    endRef: string
    messageCount: number
    retainedChars: number
    estimatedTokens: number
    toolPct: number
    textPct: number
    label: string
    sourceMessageIds: string[]
}

export interface CandidateOmission {
    kind: CompressionCandidateKind
    startRef?: string
    endRef?: string
    reason: CandidateOmissionReason
}

export interface CompressionCandidatePlan {
    candidates: CompressionCandidate[]
    omitted: CandidateOmission[]
    truncatedCount: number
}

interface AtomicUnit {
    startIndex: number
    endIndex: number
    messages: WithParts[]
    sourceMessageIds: string[]
    startRef: string
    endRef: string
    retainedChars: number
    estimatedTokens: number
    isTool: boolean
    toolNames: string[]
    toolMessageCount: number
    textMessageCount: number
}

interface CandidateDraft {
    kind: CompressionCandidateKind
    units: AtomicUnit[]
}

function partToolNames(message: WithParts): string[] {
    const names = new Set<string>()
    for (const part of message.parts ?? []) {
        if (part.type === "tool" && part.tool !== "compress") {
            names.add(part.tool)
        }
    }
    return [...names]
}

function hasNonCompressTool(message: WithParts): boolean {
    return partToolNames(message).length > 0
}

function collectToolSpans(messages: WithParts[]): Array<{ startIndex: number; endIndex: number }> {
    const spansByCallId = new Map<string, { startIndex: number; endIndex: number }>()

    for (let index = 0; index < messages.length; index++) {
        const message = messages[index]
        if (!message) continue

        const callIds = new Set<string>()
        for (const part of message.parts ?? []) {
            if (part.type !== "tool" || part.tool === "compress" || !part.callID) continue
            callIds.add(part.callID)
        }

        for (const callID of callIds) {
            const existing = spansByCallId.get(callID)
            if (existing) {
                existing.endIndex = index
            } else {
                spansByCallId.set(callID, { startIndex: index, endIndex: index })
            }
        }
    }

    return [...spansByCallId.values()].sort(
        (left, right) => left.startIndex - right.startIndex || left.endIndex - right.endIndex,
    )
}

function mergeOverlappingSpans(
    messages: WithParts[],
    spans: Array<{ startIndex: number; endIndex: number }>,
): Array<{ startIndex: number; endIndex: number }> {
    const merged: Array<{ startIndex: number; endIndex: number }> = []

    for (const span of spans) {
        const last = merged[merged.length - 1]
        if (last && span.startIndex <= last.endIndex) {
            last.endIndex = Math.max(last.endIndex, span.endIndex)
        } else {
            merged.push({ ...span })
        }
    }

    const result: Array<{ startIndex: number; endIndex: number }> = []
    let spanIndex = 0
    let index = 0
    while (index < messages.length) {
        while (spanIndex < merged.length && merged[spanIndex]!.endIndex < index) {
            spanIndex++
        }
        const span = merged[spanIndex]
        if (span?.startIndex === index) {
            result.push(span)
            index = span.endIndex + 1
            continue
        }
        result.push({ startIndex: index, endIndex: index })
        index++
    }

    return result
}

function buildAtomicUnits(
    messages: WithParts[],
    state: SessionState,
): { units: AtomicUnit[]; omissions: CandidateOmission[] } {
    const omissions: CandidateOmission[] = []
    const spans = mergeOverlappingSpans(messages, collectToolSpans(messages))
    const units: AtomicUnit[] = []

    for (const span of spans) {
        const source = messages.slice(span.startIndex, span.endIndex + 1)
        const refs = source.map((message) => state.messageIds.byRawId.get(message.info.id))
        const startRef = refs[0]
        const endRef = refs[refs.length - 1]

        if (!startRef || !endRef) {
            omissions.push({ kind: "micro", startRef, endRef, reason: "missing-reference" })
            continue
        }

        const invalidShape = source.some(
            (message) => isSyntheticMessage(message) || isIgnoredUserMessage(message),
        )
        if (invalidShape) {
            omissions.push({ kind: "micro", startRef, endRef, reason: "synthetic-or-ignored" })
            continue
        }

        const active = source.some((message) => {
            const entry = state.prune.messages.byMessageId.get(message.info.id)
            return entry !== undefined && entry.activeBlockIds.length > 0
        })
        if (active) {
            omissions.push({ kind: "micro", startRef, endRef, reason: "active-compression" })
            continue
        }

        let isTool = false
        const toolNames = new Set<string>()
        let retainedChars = 0
        let toolMessageCount = 0
        let textMessageCount = 0
        for (const message of source) {
            retainedChars += countMessageCharacters(message)
            if (hasNonCompressTool(message)) {
                isTool = true
                toolMessageCount++
            } else {
                textMessageCount++
            }
            for (const toolName of partToolNames(message)) toolNames.add(toolName)
        }

        units.push({
            startIndex: span.startIndex,
            endIndex: span.endIndex,
            messages: source,
            sourceMessageIds: source.map((message) => message.info.id),
            startRef,
            endRef,
            retainedChars,
            estimatedTokens: Math.ceil(retainedChars / 4),
            isTool,
            toolNames: [...toolNames],
            toolMessageCount,
            textMessageCount,
        })
    }

    return { units, omissions }
}

function draftCandidateLabel(kind: CompressionCandidateKind, units: AtomicUnit[]): string {
    if (kind === "episode") return "historical conversation segment"

    const toolNames = [...new Set(units.flatMap((unit) => unit.toolNames))]
    if (toolNames.length > 0) {
        return `${toolNames.slice(0, 3).join("/")} transaction`
    }
    return "large conversation message"
}

function mergeUnits(units: AtomicUnit[]): AtomicUnit {
    const first = units[0]!
    const last = units[units.length - 1]!
    const toolNames = new Set<string>()

    for (const unit of units) {
        for (const toolName of unit.toolNames) toolNames.add(toolName)
    }

    return {
        startIndex: first.startIndex,
        endIndex: last.endIndex,
        messages: units.flatMap((unit) => unit.messages),
        sourceMessageIds: units.flatMap((unit) => unit.sourceMessageIds),
        startRef: first.startRef,
        endRef: last.endRef,
        retainedChars: units.reduce((total, unit) => total + unit.retainedChars, 0),
        estimatedTokens: units.reduce((total, unit) => total + unit.estimatedTokens, 0),
        isTool: units.some((unit) => unit.isTool),
        toolNames: [...toolNames],
        toolMessageCount: units.reduce((total, unit) => total + unit.toolMessageCount, 0),
        textMessageCount: units.reduce((total, unit) => total + unit.textMessageCount, 0),
    }
}

function buildDrafts(
    units: AtomicUnit[],
    minChars: number,
    state: SessionState,
    config: PluginConfig,
    protectedRefs: Set<string>,
): { drafts: CandidateDraft[]; omissions: CandidateOmission[] } {
    const drafts: CandidateDraft[] = []
    const omissions: CandidateOmission[] = []
    const residual: AtomicUnit[] = []

    for (const unit of units) {
        const recentProtected = unit.sourceMessageIds.some((id) =>
            protectedRefs.has(state.messageIds.byRawId.get(id) ?? ""),
        )
        const protectedToolOrFile = unit.messages.some((message) =>
            messageContainsProtectedTool(
                message,
                config.compress.protectedTools,
                config.protectedFilePatterns,
            ),
        )
        if (recentProtected || protectedToolOrFile) {
            if (residual.length > 0) {
                const merged = mergeUnits(residual)
                if (merged.retainedChars >= minChars) {
                    drafts.push({ kind: "episode", units: [...residual] })
                }
                residual.length = 0
            }
            omissions.push({
                kind: unit.retainedChars >= minChars ? "micro" : "episode",
                startRef: unit.startRef,
                endRef: unit.endRef,
                reason: recentProtected ? "recent-protection" : "protected-tool-or-file",
            })
            continue
        }
        if (unit.retainedChars > 0 && (minChars <= 0 || unit.retainedChars >= minChars)) {
            drafts.push({ kind: "micro", units: [unit] })
        } else if (minChars > 0 && unit.retainedChars > 0) {
            residual.push(unit)
        }
    }

    let episode: AtomicUnit[] = []
    const flushEpisode = () => {
        if (episode.length === 0) return
        const merged = mergeUnits(episode)
        if (merged.retainedChars >= minChars) {
            drafts.push({ kind: "episode", units: [...episode] })
        }
        episode = []
    }

    for (let index = 0; index < residual.length; index++) {
        const unit = residual[index]!
        const previous = residual[index - 1]
        if (previous && unit.startIndex !== previous.endIndex + 1) flushEpisode()
        episode.push(unit)
    }
    flushEpisode()

    return { drafts, omissions }
}

function compareIds(left: string, right: string): number {
    const leftNumber = Number.parseInt(left.slice(1), 10)
    const rightNumber = Number.parseInt(right.slice(1), 10)
    return leftNumber - rightNumber || left.localeCompare(right)
}

function candidateDraftRange(draft: CandidateDraft): AtomicUnit {
    return mergeUnits(draft.units)
}

function selectionMatchesSource(
    result: ExecutableRangePlansResult,
    sourceMessageIds: string[],
    unit: AtomicUnit,
): boolean {
    if (result.plans.length !== 1) return false
    const plan = result.plans[0]
    if (!plan) return false

    if (
        plan.selection.startReference.rawIndex !== unit.startIndex ||
        plan.selection.endReference.rawIndex !== unit.endIndex
    ) {
        return false
    }

    if (plan.selection.messageIds.length !== sourceMessageIds.length) return false
    return plan.selection.messageIds.every((id, index) => id === sourceMessageIds[index])
}

function validateDraft(
    draft: CandidateDraft,
    unit: AtomicUnit,
    messages: WithParts[],
    state: SessionState,
    config: PluginConfig,
    protectedRefs: Set<string>,
    prepared?: ExecutableRangePlansResult,
): { candidate: CompressionCandidate } | { omission: CandidateOmission } {
    const source = messages.slice(unit.startIndex, unit.endIndex + 1)
    if (
        source.some((message) =>
            protectedRefs.has(state.messageIds.byRawId.get(message.info.id) ?? ""),
        )
    ) {
        return {
            omission: {
                kind: draft.kind,
                startRef: unit.startRef,
                endRef: unit.endRef,
                reason: "recent-protection",
            },
        }
    }

    if (
        source.some((message) =>
            messageContainsProtectedTool(
                message,
                config.compress.protectedTools,
                config.protectedFilePatterns,
            ),
        )
    ) {
        return {
            omission: {
                kind: draft.kind,
                startRef: unit.startRef,
                endRef: unit.endRef,
                reason: "protected-tool-or-file",
            },
        }
    }

    if (
        config.compress.minCompressRange > 0 &&
        unit.retainedChars < config.compress.minCompressRange
    ) {
        return {
            omission: {
                kind: draft.kind,
                startRef: unit.startRef,
                endRef: unit.endRef,
                reason: "below-minimum",
            },
        }
    }

    try {
        let result = prepared
        if (!result) {
            const searchContext = buildSearchContext(state, messages)
            result = prepareExecutableRangePlans(
                {
                    content: [
                        {
                            topic: draftCandidateLabel(draft.kind, draft.units),
                            startId: unit.startRef,
                            endId: unit.endRef,
                            summary: "candidate",
                        },
                    ],
                },
                searchContext,
                state,
                config,
            )
        }

        if (!selectionMatchesSource(result, unit.sourceMessageIds, unit)) {
            return {
                omission: {
                    kind: draft.kind,
                    startRef: unit.startRef,
                    endRef: unit.endRef,
                    reason: "executor-selection-drift",
                },
            }
        }

        return {
            candidate: {
                kind: draft.kind,
                startRef: unit.startRef,
                endRef: unit.endRef,
                messageCount: unit.sourceMessageIds.length,
                retainedChars: unit.retainedChars,
                estimatedTokens: unit.estimatedTokens,
                toolPct: Math.round((unit.toolMessageCount / unit.sourceMessageIds.length) * 100),
                textPct: Math.round((unit.textMessageCount / unit.sourceMessageIds.length) * 100),
                label: draftCandidateLabel(draft.kind, draft.units),
                sourceMessageIds: [...unit.sourceMessageIds],
            },
        }
    } catch {
        return {
            omission: {
                kind: draft.kind,
                startRef: unit.startRef,
                endRef: unit.endRef,
                reason: "executor-rejected",
            },
        }
    }
}

export function planCompressionCandidates(
    messages: WithParts[],
    state: SessionState,
    config: PluginConfig,
): CompressionCandidatePlan {
    const protectedRefs = computeProtectedRefs(messages, state, config.compress)
    const { units, omissions } = buildAtomicUnits(messages, state)
    const minChars = config.compress.minCompressRange ?? 5000
    const draftResult = buildDrafts(units, minChars, state, config, protectedRefs)
    const drafts = draftResult.drafts
    const candidates: CompressionCandidate[] = []
    const allOmissions = [...omissions, ...draftResult.omissions]

    let batchResult: ExecutableRangePlansResult | undefined
    try {
        const searchContext = buildSearchContext(state, messages)
        const entries = drafts.map((draft) => {
            const unit = candidateDraftRange(draft)
            return {
                topic: draftCandidateLabel(draft.kind, draft.units),
                startId: unit.startRef,
                endId: unit.endRef,
                summary: "candidate",
            }
        })
        if (entries.length > 0) {
            batchResult = prepareExecutableRangePlans(
                { content: entries },
                searchContext,
                state,
                config,
                undefined,
                { includeTokenAccounting: false },
            )
        }
    } catch {
        // Fall back to per-draft validation below. A batch can fail because a
        // stale or expanded boundary overlaps another draft even when the
        // remaining candidates are independently safe.
    }

    for (let draftIndex = 0; draftIndex < drafts.length; draftIndex++) {
        const draft = drafts[draftIndex]!
        const unit = candidateDraftRange(draft)
        const preparedPlan = batchResult?.plans.find((plan) => plan.index === draftIndex)
        const prepared = batchResult
            ? {
                  plans: preparedPlan ? [preparedPlan] : [],
                  totalChars: preparedPlan ? unit.retainedChars : 0,
              }
            : undefined
        const validated = validateDraft(
            draft,
            unit,
            messages,
            state,
            config,
            protectedRefs,
            prepared,
        )
        if ("candidate" in validated) {
            candidates.push(validated.candidate)
        } else {
            allOmissions.push(validated.omission)
        }
    }

    candidates.sort((left, right) => {
        return (
            right.estimatedTokens - left.estimatedTokens ||
            (left.kind === "micro" ? -1 : 1) - (right.kind === "micro" ? -1 : 1) ||
            compareIds(left.startRef, right.startRef) ||
            compareIds(left.endRef, right.endRef)
        )
    })

    const maxCandidates = 12
    const bounded = candidates.slice(0, maxCandidates)
    return {
        candidates: bounded,
        omitted: allOmissions,
        truncatedCount: Math.max(0, candidates.length - bounded.length),
    }
}

export function formatCompressionCandidates(plan: CompressionCandidatePlan): string {
    if (plan.candidates.length === 0) return ""

    const fmt = (value: number): string =>
        value >= 1000 ? `${(value / 1000).toFixed(1)}K` : String(value)

    const lines = plan.candidates.map((candidate) => {
        const range = `${candidate.startRef}–${candidate.endRef}`
        return `  ${candidate.kind.toUpperCase().padEnd(7)} ${range}  ${candidate.messageCount} msg${candidate.messageCount === 1 ? "" : "s"}  ${fmt(candidate.estimatedTokens)} tokens  ${candidate.label}`
    })

    const suffix =
        plan.truncatedCount > 0
            ? `\n  ...${plan.truncatedCount} additional candidate${plan.truncatedCount === 1 ? "" : "s"} omitted`
            : ""
    return `COMPRESSION CANDIDATES (independent; batchable)\n${lines.join("\n")}${suffix}`
}
