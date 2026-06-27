import type { SessionState, ToolParameterEntry } from "./types"

export function cacheToolParameters(
    state: SessionState,
    callId: string,
    entry: ToolParameterEntry,
): void {
    state.toolParameters.set(callId, entry)
}

export function getCachedToolParameters(
    state: SessionState,
    callId: string,
): ToolParameterEntry | undefined {
    return state.toolParameters.get(callId)
}

export function getAllCachedParameters(state: SessionState): Map<string, ToolParameterEntry> {
    return new Map(state.toolParameters)
}

export function clearToolCache(state: SessionState): void {
    state.toolParameters.clear()
}

export function removeCachedEntry(state: SessionState, callId: string): boolean {
    return state.toolParameters.delete(callId)
}
