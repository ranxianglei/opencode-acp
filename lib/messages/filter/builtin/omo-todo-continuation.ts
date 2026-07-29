import type { MessageFilter, MessageFilterContext, FilterResult } from "../types"

const TODO_MARKER = "[SYSTEM DIRECTIVE"
const TODO_CONTINUATION = "TODO CONTINUATION"

const OMO_TODO_FILTER: MessageFilter = {
    name: "omo-todo-continuation",
    version: "1.0.0",
    description: "Keep only the latest OMO TODO CONTINUATION directive, drop earlier occurrences",
    keepLastOnly: true,

    filter(ctx: MessageFilterContext): FilterResult {
        if (ctx.role !== "user") return { action: "keep" }
        if (!ctx.text.includes(TODO_MARKER) || !ctx.text.includes(TODO_CONTINUATION)) {
            return { action: "keep" }
        }
        return { action: "drop", reason: "TODO CONTINUATION directive" }
    },
}

export { OMO_TODO_FILTER }
