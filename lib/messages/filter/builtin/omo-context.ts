import type { MessageFilter, MessageFilterContext, FilterResult } from "../types"

const OMO_MARKER = "<!-- OMO_INTERNAL_INITIATOR -->"

const OMO_CONTEXT_FILTER: MessageFilter = {
    name: "omo-context",
    version: "1.0.0",
    description: "Keep only the latest OMO [CONTEXT] injection, drop earlier occurrences",
    keepLastOnly: true,

    filter(ctx: MessageFilterContext): FilterResult {
        if (ctx.role !== "user") return { action: "keep" }
        if (!ctx.text.includes(OMO_MARKER)) return { action: "keep" }
        const stripped = ctx.text.trimStart()
        if (!stripped.startsWith("[CONTEXT]") && !stripped.startsWith("CONTEXT:")) {
            return { action: "keep" }
        }
        return { action: "drop", reason: "OMO context injection" }
    },
}

export { OMO_CONTEXT_FILTER }
