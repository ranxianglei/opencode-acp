import type { CompressionTimingState } from "../compress/timing"
import { Message, Part } from "@opencode-ai/sdk/v2"

export interface WithParts {
    info: Message
    parts: Part[]
}

export type ToolStatus = "pending" | "running" | "completed" | "error"

export interface ToolParameterEntry {
    tool: string
    parameters: any
    status?: ToolStatus
    error?: string
    turn: number
    tokenCount?: number
}

export interface SessionStats {
    pruneTokenCounter: number
    totalPruneTokens: number
}

export interface PrunedMessageEntry {
    tokenCount: number
    allBlockIds: number[]
    activeBlockIds: number[]
}

export type CompressionMode = "range" | "message"

export type BlockGeneration = "young" | "old"

export type CompressionTier = 1 | 2 | 3

export interface CompressionBlock {
    blockId: number
    runId: number
    active: boolean
    deactivatedByUser: boolean
    deactivatedByUserDeep?: boolean
    compressedTokens: number
    /**
     * Total tokens this block represents, including tokens from consumed
     * blocks. For tier 1 blocks: equals compressedTokens. For tier 2+:
     * compressedTokens + sum of consumed blocks' effectiveCompressedTokens.
     * Undefined on old state files — callers should fall back to compressedTokens.
     */
    effectiveCompressedTokens?: number
    summaryTokens: number
    durationMs: number
    mode?: CompressionMode
    tier?: CompressionTier
    topic: string
    batchTopic?: string
    startId: string
    endId: string
    anchorMessageId: string
    compressMessageId: string
    compressCallId?: string
    includedBlockIds: number[]
    consumedBlockIds: number[]
    parentBlockIds: number[]
    directMessageIds: string[]
    directToolIds: string[]
    effectiveMessageIds: string[]
    effectiveToolIds: string[]
    createdAt: number
    deactivatedAt?: number
    deactivatedByBlockId?: number
    summary: string
    survivedCount: number
    generation?: BlockGeneration
}

export interface PruneMessagesState {
    byMessageId: Map<string, PrunedMessageEntry>
    blocksById: Map<number, CompressionBlock>
    activeBlockIds: Set<number>
    activeByAnchorMessageId: Map<string, number>
    nextBlockId: number
    nextRunId: number
    markedForCleanup: Set<number>
}

export interface Prune {
    messages: PruneMessagesState
}

export interface MessageIdState {
    byRawId: Map<string, string>
    byRef: Map<string, string>
    nextRef: number
}

export interface Nudges {
    contextLimitAnchors: Set<string>
    turnNudgeAnchors: Set<string>
    iterationNudgeAnchors: Set<string>
    lastPerMessageNudgeTurn: number
    lastPerMessageNudgeTokens: number | undefined
    lastNudgeShownTokens: number | undefined
    lastToolOutputNudgeTokens: number | undefined
    lastTier2NudgeTokens: number | undefined
    lastTier3NudgeTokens: number | undefined
    /** Set by injectCompressNudges; read by system prompt handler next turn (1-turn lag). Undefined = first turn. */
    shouldInjectThisTurn: boolean | undefined
    /**
     * Lock flag: prevents baseline leak after compress.
     *
     * When compress is detected in the current turn, the baseline is set to
     * currentTokens ONLY on the first transform (before continuation work
     * inflates it). Subsequent transforms in the same turn skip the update.
     * Reset to false when compress is NOT in the current turn.
     */
    compressBaselineSet: boolean
    /**
     * Tracks the message ID of the last processed compress call.
     *
     * Prevents the early-return in injectCompressNudges from firing repeatedly
     * for the SAME compress call. In autonomous sessions (single user message),
     * a compress stays in the turn forever — without this tracking, the nudge
     * system would NEVER evaluate again after the first compress.
     *
     * NOT persisted — transient by design. On restart it's undefined, causing
     * one extra early-return on the first call, then normal behavior resumes.
     */
    lastProcessedCompressMessageId: string | undefined
}

export interface SessionState {
    sessionId: string | null
    isSubAgent: boolean
    compressPermission: "ask" | "allow" | "deny" | undefined
    prune: Prune
    nudges: Nudges
    stats: SessionStats
    compressionTiming: CompressionTimingState
    toolParameters: Map<string, ToolParameterEntry>
    toolIdList: string[]
    messageIds: MessageIdState
    lastCompaction: number
    currentTurn: number
    modelContextLimit: number | undefined
    /**
     * Model identity that `modelContextLimit` was captured for. Together with
     * `modelID`, lets the messages transform detect a model switch BEFORE the
     * system.transform hook refreshes the limit (it fires later in the same
     * turn), so a stale limit is never used for threshold math (issue #312).
     */
    modelProviderID?: string
    modelID?: string
    systemPromptTokens: number | undefined
    /**
     * Transient flag (NOT persisted): set to true when a compress call is rejected
     * by the pre-commit quality gate. The model must retry with `acknowledgeRisk: true`
     * to bypass quality on the retry. Consumed (reset to false) on use.
     *
     * Lifecycle:
     * - Quality fails → flag = true → rejection error returned
     * - Retry with acknowledgeRisk:true + flag=true → accepted, flag = false
     * - acknowledgeRisk:true + flag=false → error "no rejection pending, remove parameter"
     * - Normal call (no acknowledgeRisk) → quality runs normally
     */
    qualityGateRetryPending: boolean
}
