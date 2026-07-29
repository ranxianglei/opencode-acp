import type { MessageFilter, MessageFilterContext, FilterResult } from "../types"

const CONTEXT_PREFIX = "[CONTEXT]"

const OMO_CONTEXT_FILTER: MessageFilter = {
    name: "omo-context",
    version: "1.0.0",
    description: "Keep only the latest OMO [CONTEXT] injection, drop earlier occurrences",
    keepLastOnly: true,

    filter(ctx: MessageFilterContext): FilterResult {
        if (ctx.role !== "user") return { action: "keep" }
        const stripped = ctx.text.trimStart()
        if (!stripped.startsWith(CONTEXT_PREFIX) && !stripped.startsWith("CONTEXT:")) {
            return { action: "keep" }
        }
        return { action: "drop", reason: "OMO context injection" }
    },
}

export { OMO_CONTEXT_FILTER }
