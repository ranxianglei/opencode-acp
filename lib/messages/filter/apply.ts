import type { WithParts } from "../../state"
import type { Logger } from "../../logger"
import type { MessageFilter, MessageFilterContext, MessageFiltersConfig } from "./types"
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

    const filters = listMessageFilters().filter((f) => {
        const fc = config.filters?.[f.name]
        return fc?.enabled !== false
    })

    if (filters.length === 0) {
        return { partsFiltered: 0, partsDropped: 0, partsModified: 0 }
    }

    const result: ApplyResult = { partsFiltered: 0, partsDropped: 0, partsModified: 0 }
    const total = messages.length

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i]
        const role = (msg.info as { role?: string }).role ?? "unknown"
        const parts = msg.parts ?? []

        for (const part of parts) {
            const text = (part as { text?: string }).text
            if (typeof text !== "string" || text.length === 0) continue

            const filterCtx: MessageFilterContext = {
                text,
                role,
                sessionId: ctx.sessionId,
                isSubAgent: ctx.isSubAgent,
                messageIndex: i,
                totalMessages: total,
                toolName: (part as { tool?: string }).tool,
                modelContextLimit: ctx.modelContextLimit,
            }

            for (const filter of filters) {
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

                result.partsFiltered++
                if (decision.action === "drop") {
                    ;(part as { text?: string }).text = ""
                    result.partsDropped++
                    if (decision.reason) {
                        logger.debug("Message filter dropped text", {
                            filter: filter.name,
                            reason: decision.reason,
                            messageIndex: i,
                            originalLength: text.length,
                        })
                    }
                } else if (decision.action === "modify" && decision.text !== undefined) {
                    ;(part as { text?: string }).text = decision.text
                    result.partsModified++
                    if (decision.reason) {
                        logger.debug("Message filter modified text", {
                            filter: filter.name,
                            reason: decision.reason,
                            messageIndex: i,
                            originalLength: text.length,
                            newLength: decision.text.length,
                        })
                    }
                    filterCtx.text = decision.text
                }
            }
        }
    }

    if (result.partsFiltered > 0) {
        logger.info("Message filters applied", {
            filtersRun: filters.length,
            partsFiltered: result.partsFiltered,
            partsDropped: result.partsDropped,
            partsModified: result.partsModified,
        })
    }

    return result
}
