import type { WithParts } from "./state/types"
import { countTokensSync, getCurrentTokenUsage as _getCurrentTokenUsage } from "./infra/token-counter"

export const COMPACTED_TOOL_OUTPUT_PLACEHOLDER =
    "[Output removed to save context - information superseded or no longer needed]"

export const PRUNED_TOOL_ERROR_INPUT_REPLACEMENT = "[input removed due to failed tool call]"
export const PRUNED_QUESTION_INPUT_REPLACEMENT = "[questions removed - see output for user's answers]"

export function getCurrentTokenUsage(
    state: { modelContextLimit?: number; stats: { pruneTokenCounter: number; totalPruneTokens: number } },
    messages: WithParts[],
): number {
    return _getCurrentTokenUsage(state, messages)
}

export function extractCompletedToolOutput(part: any): string | null {
    if (!part || part.type !== "tool") return null
    if (part.state?.status !== "completed") return null
    if (typeof part.state?.output !== "string") return null
    return part.state.output
}

export function extractToolContent(part: any): string {
    if (!part) return ""
    if (part.type === "text" && typeof part.text === "string") return part.text
    if (part.type === "tool") return extractCompletedToolOutput(part) ?? ""
    if (part.type === "reasoning" && typeof part.text === "string") return part.text
    return ""
}

export function countToolTokens(part: any): number {
    return countTokensSync(extractToolContent(part))
}

export function countAllMessageTokens(messages: WithParts[]): number {
    let total = 0
    for (const msg of messages) {
        const parts = Array.isArray(msg.parts) ? msg.parts : []
        for (const part of parts as any[]) {
            total += countTokensSync(extractToolContent(part))
        }
    }
    return total
}

export function estimateTokensBatch(texts: string[]): number[] {
    return texts.map((t) => countTokensSync(t))
}
