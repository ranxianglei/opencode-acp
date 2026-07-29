import type { MessageFilter, MessageFilterContext, FilterResult } from "../types"

const OMO_TASK_FILTER: MessageFilter = {
    name: "omo-task-directive",
    version: "1.0.0",
    description: "Keep only the latest OMO TASK directive, drop earlier occurrences",
    keepLastOnly: true,

    filter(ctx: MessageFilterContext): FilterResult {
        if (ctx.role !== "user") return { action: "keep" }
        const stripped = ctx.text.trimStart()
        if (!stripped.startsWith("TASK:") && !stripped.startsWith("## TASK")) {
            return { action: "keep" }
        }
        return { action: "drop", reason: "OMO task directive" }
    },
}

export { OMO_TASK_FILTER }
