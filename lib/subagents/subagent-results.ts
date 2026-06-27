import type { SessionState } from "../state/types"
import type { Logger } from "../infra/logger"

export function cacheSubagentResult(
    state: SessionState,
    taskId: string,
    result: string,
    logger: Logger,
): void {
    logger.debug("Caching subagent result", { taskId, resultLength: result.length })
    state.subAgentResultCache.set(taskId, result)
}

export function getCachedSubagentResult(
    state: SessionState,
    taskId: string,
): string | undefined {
    return state.subAgentResultCache.get(taskId)
}

export function hasCachedResult(state: SessionState, taskId: string): boolean {
    return state.subAgentResultCache.has(taskId)
}

export function clearSubagentCache(state: SessionState): void {
    state.subAgentResultCache.clear()
}
