import type { SessionState, WithParts } from "./state/types"
import type { Part } from "@opencode-ai/sdk/v2"
import {
    countTokensSync,
    estimateTokensBatch,
    extractCompletedToolOutput,
    extractToolContent,
    countToolTokens,
    countAllMessageTokens,
    getTotalToolTokens,
    getCurrentTokenUsage,
    getCurrentParams,
    COMPACTED_TOOL_OUTPUT_PLACEHOLDER,
} from "./infra/token-counter"

export {
    countTokensSync as countTokens,
    estimateTokensBatch,
    extractCompletedToolOutput,
    extractToolContent,
    countToolTokens,
    countAllMessageTokens,
    getTotalToolTokens,
    getCurrentTokenUsage,
    getCurrentParams,
    COMPACTED_TOOL_OUTPUT_PLACEHOLDER,
}

export const PRUNED_TOOL_ERROR_INPUT_REPLACEMENT = "[input removed due to failed tool call]"
export const PRUNED_QUESTION_INPUT_REPLACEMENT = "[questions removed - see output for user's answers]"

export type { Part, SessionState, WithParts }
