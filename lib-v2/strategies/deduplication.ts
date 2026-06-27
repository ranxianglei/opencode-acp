import type { SessionState, WithParts } from "../state/types"
import type { PluginConfig } from "../config/types"
import type { Logger } from "../infra/logger"

function isToolNameProtected(toolName: string, protectedTools: string[]): boolean {
    if (!Array.isArray(protectedTools)) return false
    if (protectedTools.length === 0) return false
    if (protectedTools.includes(toolName)) return true
    return protectedTools.some((pattern) => {
        if (!pattern.includes("*")) return false
        const regexStr = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
        return new RegExp(`^${regexStr}$`).test(toolName)
    })
}

function getFilePathsFromParameters(toolName: string, input: unknown): string[] {
    if (!input || typeof input !== "object") return []
    const obj = input as Record<string, unknown>
    const paths: string[] = []
    for (const key of ["filePath", "path", "file", "fileName"]) {
        const v = obj[key]
        if (typeof v === "string") paths.push(v)
    }
    return paths
}

function isFilePathProtected(filePaths: string[], patterns: string[]): boolean {
    if (!patterns || patterns.length === 0) return false
    for (const fp of filePaths) {
        for (const pattern of patterns) {
            if (!pattern) continue
            if (pattern.includes("*")) {
                const regexStr = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
                if (new RegExp(`^${regexStr}$`).test(fp)) return true
            } else if (fp === pattern || fp.includes(pattern)) {
                return true
            }
        }
    }
    return false
}

function createToolSignature(tool: string, parameters?: any): string {
    if (!parameters) {
        return tool
    }
    const normalized = normalizeParameters(parameters)
    const sorted = sortObjectKeys(normalized)
    return `${tool}::${JSON.stringify(sorted)}`
}

function normalizeParameters(params: any): any {
    if (typeof params !== "object" || params === null) return params
    if (Array.isArray(params)) return params

    const normalized: any = {}
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) {
            normalized[key] = value
        }
    }
    return normalized
}

function sortObjectKeys(obj: any): any {
    if (typeof obj !== "object" || obj === null) return obj
    if (Array.isArray(obj)) return obj.map(sortObjectKeys)

    const sorted: any = {}
    for (const key of Object.keys(obj).sort()) {
        sorted[key] = sortObjectKeys(obj[key])
    }
    return sorted
}

function getTotalToolTokens(state: SessionState, toolIds: string[]): number {
    let total = 0
    for (const id of toolIds) {
        const entry = state.toolParameters.get(id)
        if (entry && typeof entry.tokenCount === "number") {
            total += entry.tokenCount
        }
    }
    return total
}

export function deduplicate(
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    _messages: WithParts[],
): number {
    if (state.manualMode && !config.manualMode.automaticStrategies) {
        return 0
    }

    if (!config.strategies.deduplication.enabled) {
        return 0
    }

    const allToolIds = state.toolIdList
    if (allToolIds.length === 0) {
        return 0
    }

    const unprunedIds = allToolIds.filter((id) => !state.prune.tools.has(id))

    if (unprunedIds.length === 0) {
        return 0
    }

    const protectedTools = config.strategies.deduplication.protectedTools

    const signatureMap = new Map<string, string[]>()

    for (const id of unprunedIds) {
        const metadata = state.toolParameters.get(id)
        if (!metadata) {
            continue
        }

        if (isToolNameProtected(metadata.tool, protectedTools)) {
            continue
        }

        const filePaths = getFilePathsFromParameters(metadata.tool, metadata.parameters)
        if (isFilePathProtected(filePaths, config.protectedFilePatterns)) {
            continue
        }

        const signature = createToolSignature(metadata.tool, metadata.parameters)
        if (!signatureMap.has(signature)) {
            signatureMap.set(signature, [])
        }
        const ids = signatureMap.get(signature)
        if (ids) {
            ids.push(id)
        }
    }

    const newPruneIds: string[] = []

    for (const [, ids] of signatureMap.entries()) {
        if (ids.length > 1) {
            const idsToRemove = ids.slice(0, -1)
            newPruneIds.push(...idsToRemove)
        }
    }

    state.stats.totalPruneTokens += getTotalToolTokens(state, newPruneIds)

    if (newPruneIds.length > 0) {
        for (const id of newPruneIds) {
            const entry = state.toolParameters.get(id)
            state.prune.tools.set(id, entry?.tokenCount ?? 0)
        }
        logger.debug(`Marked ${newPruneIds.length} duplicate tool calls for pruning`)
    }

    return newPruneIds.length
}
