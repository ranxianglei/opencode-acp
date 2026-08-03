import type { WithParts } from "../../state"
import type { Logger } from "../../logger"
import type { MessageFilter, MessageFilterContext, MessageFiltersConfig, FilterResult } from "./types"
import { listMessageFilters } from "./registry"

export interface ApplyResult {
    partsFiltered: number
    partsDropped: number
    partsModified: number
}

export function applyMessageFilters(
    messages: WithParts[],
    config: MessageFiltersConfig | undefined,
    logger: Logger,
    ctx: { sessionId: string; isSubAgent: boolean; modelContextLimit?: number },
): ApplyResult {
    if (!config?.enabled) {
        return { partsFiltered: 0, partsDropped: 0, partsModified: 0 }
    }

    const allFilters = listMessageFilters().filter((f) => {
        const fc = config.filters?.[f.name]
        return fc?.enabled !== false
    })

    if (allFilters.length === 0) {
        return { partsFiltered: 0, partsDropped: 0, partsModified: 0 }
    }

    const result: ApplyResult = { partsFiltered: 0, partsDropped: 0, partsModified: 0 }
    const total = messages.length

    const buildCtx = (text: string, role: string, i: number): MessageFilterContext => ({
        text,
        role,
        sessionId: ctx.sessionId,
        isSubAgent: ctx.isSubAgent,
        messageIndex: i,
        totalMessages: total,
        modelContextLimit: ctx.modelContextLimit,
    })

    const applyDecision = (
        part: { text?: string },
        decision: FilterResult,
        filterName: string,
        i: number,
        originalText: string,
    ): string => {
        result.partsFiltered++
        if (decision.action === "drop") {
            part.text = ""
            result.partsDropped++
            if (decision.reason) {
                logger.debug("Message filter dropped text", {
                    filter: filterName, reason: decision.reason, messageIndex: i, originalLength: originalText.length,
                })
            }
            return ""
        }
        if (decision.action === "modify" && decision.text !== undefined) {
            part.text = decision.text
            result.partsModified++
            if (decision.reason) {
                logger.debug("Message filter modified text", {
                    filter: filterName, reason: decision.reason, messageIndex: i,
                    originalLength: originalText.length, newLength: decision.text.length,
                })
            }
            return decision.text
        }
        return originalText
    }

    // Phase 1: immediate filters (forward pass, chained)
    const immediateFilters = allFilters.filter((f) => !f.keepLastOnly)
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i]
        const role = (msg.info as { role?: string }).role ?? "unknown"
        for (const part of msg.parts ?? []) {
            const text = (part as { text?: string }).text
            if (typeof text !== "string" || text.length === 0) continue
            let current = text
            const filterCtx = buildCtx(current, role, i)
            filterCtx.toolName = (part as { tool?: string }).tool
            for (const filter of immediateFilters) {
                let decision
                try {
                    decision = filter.filter(filterCtx)
                } catch (err) {
                    logger.warn("Message filter threw error", {
                        filter: filter.name,
                        error: err instanceof Error ? err.message : String(err),
                        messageIndex: i,
                    })
                    continue
                }
                if (decision.action === "keep") continue
                current = applyDecision(part as { text?: string }, decision, filter.name, i, current)
                filterCtx.text = current
            }
        }
    }

    // Phase 2: keep-last-only dedup (reverse pass)
    const keepLastFilters = allFilters.filter((f) => f.keepLastOnly)
    for (const filter of keepLastFilters) {
        const fcKeepLast = config.filters?.[filter.name]?.keepLast
        const keepCount = Math.max(1, fcKeepLast ?? filter.keepLast ?? 1)
        let kept = 0
        for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i]
            const role = (msg.info as { role?: string }).role ?? "unknown"
            const parts = msg.parts ?? []
            for (let p = parts.length - 1; p >= 0; p--) {
                const part = parts[p]
                const text = (part as { text?: string }).text
                if (typeof text !== "string" || text.length === 0) continue
                const filterCtx = buildCtx(text, role, i)
                filterCtx.toolName = (part as { tool?: string }).tool
                let decision
                try {
                    decision = filter.filter(filterCtx)
                } catch {
                    continue
                }
                if (decision.action !== "drop" && decision.action !== "modify") continue
                if (kept < keepCount) {
                    kept++
                } else {
                    applyDecision(part as { text?: string }, decision, filter.name, i, text)
                }
            }
        }
    }

    if (result.partsFiltered > 0) {
        logger.info("Message filters applied", {
            filtersRun: allFilters.length,
            partsFiltered: result.partsFiltered,
            partsDropped: result.partsDropped,
            partsModified: result.partsModified,
        })
    }

    return result
}
