import type { MessageFilter, MessageFilterContext, FilterResult } from "../types"

const SYSTEM_REMINDER_OPEN = "<system-reminder>"
const OMO_MARKER = "<!-- OMO_INTERNAL_INITIATOR -->"

const OMO_SYSTEM_REMINDER_FILTER: MessageFilter = {
    name: "omo-system-reminder",
    version: "1.2.0",
    description: "Keep only the 2 most recent OMO <system-reminder> messages, drop older ones",
    keepLastOnly: true,
    keepLast: 2,

    filter(ctx: MessageFilterContext): FilterResult {
        if (ctx.role !== "user") return { action: "keep" }
        if (!ctx.text.includes(SYSTEM_REMINDER_OPEN) && !ctx.text.includes(OMO_MARKER)) {
            return { action: "keep" }
        }
        return { action: "drop", reason: "OMO system-reminder match (keepLast dedup)" }
    },
}

export { OMO_SYSTEM_REMINDER_FILTER }
