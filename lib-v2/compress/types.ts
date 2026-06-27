import type { SessionState, WithParts, CompressionBlock } from "../state/types"
import type { CompressionMode } from "../config/types"
import type { PluginConfig } from "../config/types"
import type { Logger } from "../infra/logger"

export interface ToolContext {
    config: PluginConfig
    state: SessionState
    logger: Logger
    messages: WithParts[]
}

export interface BoundaryReference {
    kind: "message" | "compressed-block"
    rawIndex: number
    messageId?: string
    blockId?: number
    anchorMessageId?: string
}

export interface SearchContext {
    rawMessages: WithParts[]
    rawMessagesById: Map<string, WithParts>
    rawIndexById: Map<string, number>
    summaryByBlockId: Map<number, CompressionBlock>
}

export interface SelectionResolution {
    startReference: BoundaryReference
    endReference: BoundaryReference
    messageIds: string[]
    messageTokenById: Map<string, number>
    toolIds: string[]
    requiredBlockIds: number[]
}

export interface CompressionStateInput {
    topic: string
    batchTopic: string
    startId: string
    endId: string
    mode: CompressionMode
    runId: number
    compressMessageId: string
    compressCallId?: string
    summaryTokens: number
}

export interface AppliedCompressionResult {
    compressedTokens: number
    messageIds: string[]
    newlyCompressedMessageIds: string[]
    newlyCompressedToolIds: string[]
}

export interface CompressRangeEntry {
    startId: string
    endId: string
    summary: string
    topic?: string
}

export interface CompressRangeToolArgs {
    topic: string
    content: CompressRangeEntry[]
}

export interface CompressMessageEntry {
    messageId: string
    topic: string
    summary: string
}

export interface CompressMessageToolArgs {
    topic: string
    content: CompressMessageEntry[]
}

export interface ResolvedRangeCompression {
    index: number
    entry: CompressRangeEntry
    selection: SelectionResolution
    anchorMessageId: string
}

export interface ResolvedMessageCompression {
    entry: CompressMessageEntry
    selection: SelectionResolution
    anchorMessageId: string
}

export interface ResolvedMessageCompressionsResult {
    plans: ResolvedMessageCompression[]
    skippedIssues: string[]
    skippedCount: number
}

export interface ParsedBlockPlaceholder {
    raw: string
    blockId: number
    startIndex: number
    endIndex: number
}

export interface InjectedSummaryResult {
    expandedSummary: string
    consumedBlockIds: number[]
}

export interface NotificationEntry {
    blockId: number
    runId: number
    summary: string
    summaryTokens: number
}

export interface PromptStore {
    reload(): void
    getRuntimePrompts(): {
        system: string
        compressRange: string
        compressMessage: string
        contextLimitNudge: string
        turnNudge: string
        iterationNudge: string
    }
}

export interface RangeInput {
    startId: string
    endId: string
    summary: string
    topic?: string
}

export interface MessageInput {
    ids: string[]
    summary: string
    topic?: string
}

export interface CompressionResult {
    blockIds: number[]
    compressedTokens: number
    summaryTokens: number
    errors: string[]
}

export interface ResolvedRange {
    startIndex: number
    endIndex: number
    messageIds: string[]
    toolIds: string[]
    nestedBlockIds: number[]
}

export interface ResolvedMessage {
    messageId: string
    index: number
    valid: boolean
}

export type CompressMode = "range" | "message"

export interface V1ToolContext {
    client: any
    state: SessionState
    logger: Logger
    config: PluginConfig
    prompts: PromptStore
}

export type { CompressionBlock, CompressionMode }
