import type { PluginConfig } from "../config/types"
import type { BlockGeneration, CompressionMode, ManualModeState } from "../config/types"
import type { Message, Part } from "@opencode-ai/sdk/v2"

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

export interface NudgeState {
    contextLimitAnchors: Set<string>
    turnAnchors: Set<string>
    iterationAnchors: Set<string>
    lastNudgeTurn: number
}

export interface MessageIdMapping {
    byRawId: Map<string, string>
    byRef: Map<string, string>
    nextRefIndex: number
}

export interface CompressionTimingEntry {
    messageId: string
    callId: string
    durationMs: number
}

export interface CompressionTimingState {
    startsByCallId: Map<string, number>
    pendingByCallId: Map<string, CompressionTimingEntry>
}

export interface PendingManualTrigger {
    sessionId: string
    prompt: string
}

export interface SessionState {
    sessionId: string | null
    modelContextLimit: number | undefined
    isSubAgent: boolean
    lastCompaction: number
    currentTurn: number
    compressPermission?: "ask" | "allow" | "deny" | null

    prune: Prune
    nudges: NudgeState
    stats: SessionStats
    messageIds: MessageIdMapping
    compressionTiming: CompressionTimingState
    toolParameters: Map<string, ToolParameterEntry>
    subagentResults: Map<string, string>
    manualMode: ManualModeState
    pendingManualTrigger: PendingManualTrigger | null
}
