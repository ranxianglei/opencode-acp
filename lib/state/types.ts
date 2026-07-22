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

export interface CompressionBlock {
    blockId: number
    runId: number
    active: boolean
    deactivatedByUser: boolean
    compressedTokens: number
    summaryTokens: number
    durationMs: number
    mode?: CompressionMode
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
    tools: Map<string, number>
    messages: PruneMessagesState
}

export interface PendingManualTrigger {
    sessionId: string
    prompt: string
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
}

export interface SessionState {
    sessionId: string | null
    isSubAgent: boolean
    manualMode: false | "active" | "compress-pending"
    compressPermission: "ask" | "allow" | "deny" | undefined
    pendingManualTrigger: PendingManualTrigger | null
    prune: Prune
    nudges: Nudges
    stats: SessionStats
    compressionTiming: CompressionTimingState
    toolParameters: Map<string, ToolParameterEntry>
    subAgentResultCache: Map<string, string>
    toolIdList: string[]
    messageIds: MessageIdState
    lastCompaction: number
    currentTurn: number
    modelContextLimit: number | undefined
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
