import type { SessionState, WithParts } from "../state/types"
import type { PluginConfig } from "../config/types"
import type { Logger } from "../infra/logger"

export interface ToolContext {
    config: PluginConfig
    state: SessionState
    logger: Logger
    messages: WithParts[]
}

export interface BoundaryReference {
    ref: string
    rawId?: string
    index: number
    valid: boolean
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
