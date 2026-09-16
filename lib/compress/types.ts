import type { PluginConfig } from "../config"
import { describeBiliEnvYield, detectBiliEnvYield } from "../bili-proxy"
import type { Logger } from "../logger"
import type { PromptStore } from "../prompts/store"
import type { CompressionBlock, CompressionMode, SessionState, WithParts } from "../state"
import type { SessionStateRegistry } from "../state"

export interface ToolContext {
    client: any
    state: SessionState
    logger: Logger
    config: PluginConfig
    prompts: PromptStore
}

export interface ToolFactoryContext {
    client: any
    registry: SessionStateRegistry
    logger: Logger
    config: PluginConfig
    prompts: PromptStore
}

// [FIX #33] Resolve the caller's per-session state at tool-call time and build a
// ToolContext bound to it. A compress tool can only run after messages.transform
// initialized the session, so the state is guaranteed present.
export function resolveToolContext(
    factoryCtx: ToolFactoryContext,
    sessionID: string,
): ToolContext {
    // [FIX #405] Action-time owner re-check (defense-in-depth for every ACP
    // tool — all five execute() bodies enter through here): the config hook
    // denies the tools once billion-context claims ownership, but the
    // native-mode marker can land after the last config run. No tool may act
    // after the handoff.
    const biliYield = detectBiliEnvYield()
    if (biliYield !== null) {
        throw new Error(
            `ACP is disabled in this process — ${describeBiliEnvYield(biliYield)}. ` +
                "billion-context owns context compression; do not call ACP tools again.",
        )
    }
    const state = factoryCtx.registry.get(sessionID)
    if (!state) {
        throw new Error(
            `ACP: session ${sessionID} has no initialized state. ` +
                "messages.transform must run before a compress tool call.",
        )
    }
    return {
        client: factoryCtx.client,
        state,
        logger: factoryCtx.logger,
        config: factoryCtx.config,
        prompts: factoryCtx.prompts,
    }
}

export interface CompressRangeEntry {
    /** Per-entry topic for batch compression. Falls back to top-level `topic`. */
    topic?: string
    startId: string
    endId: string
    summary: string
}

export interface CompressRangeToolArgs {
    /** Fallback topic for entries without their own. Optional if every entry has one. */
    topic?: string
    content: CompressRangeEntry[]
    summaryMaxChars?: number
    dangerous?: boolean
    acknowledgeRisk?: boolean
}

export interface CompressMessageEntry {
    messageId: string
    topic: string
    summary: string
}

export interface CompressMessageToolArgs {
    topic: string
    content: CompressMessageEntry[]
    summaryMaxChars?: number
    dangerous?: boolean
    acknowledgeRisk?: boolean
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
    /**
     * [Issue #384] Request-scoped boundary lookup (mNNNNN/bN → BoundaryReference),
     * built once per SearchContext instead of once per boundary pair. Optional so
     * hand-built contexts (tests) keep working; resolveBoundaryIds memoizes it lazily.
     */
    boundaryLookup?: Map<string, BoundaryReference>
}

export interface SelectionResolution {
    startReference: BoundaryReference
    endReference: BoundaryReference
    messageIds: string[]
    messageTokenById: Map<string, number>
    toolIds: string[]
    requiredBlockIds: number[]
}

export interface ResolvedMessageCompression {
    entry: CompressMessageEntry
    selection: SelectionResolution
    anchorMessageId: string
}

export interface ResolvedRangeCompression {
    index: number
    entry: CompressRangeEntry
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

export interface AppliedCompressionResult {
    compressedTokens: number
    messageIds: string[]
    newlyCompressedMessageIds: string[]
    newlyCompressedToolIds: string[]
}

export interface CompressionStateInput {
    topic: string
    batchTopic: string | undefined
    startId: string
    endId: string
    mode: CompressionMode
    runId: number
    compressMessageId: string
    compressCallId?: string
    summaryTokens: number
}
