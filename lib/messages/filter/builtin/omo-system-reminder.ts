import type { MessageFilter, MessageFilterContext, FilterResult } from "../types"

/**
 * OMO (Oh My OpenCode) system-reminder filter.
 *
 * Strips `<system-reminder>` blocks injected by the OMO plugin framework.
 * These blocks contain background task notifications, todo continuation
 * directives, and other ephemeral metadata that accumulates as user messages.
 *
 * Each block looks like:
 * <system-reminder>
 * [BACKGROUND TASK COMPLETED]
 * ...
 * </system-reminder>
 * <!-- OMO_INTERNAL_INITIATOR -->
 *
 * By default, this filter strips ALL such blocks. Users can disable it
 * per-session via config if they need to see OMO notifications.
 */

const SYSTEM_REMINDER_OPEN = "<system-reminder>"
const SYSTEM_REMINDER_CLOSE = "</system-reminder>"
const OMO_MARKER = "<!-- OMO_INTERNAL_INITIATOR -->"

const OMO_SYSTEM_REMINDER_FILTER: MessageFilter = {
    name: "omo-system-reminder",
    version: "1.0.0",
    description: "Strip OMO <system-reminder> blocks and OMO_INTERNAL_INITIATOR markers from user messages",

    filter(ctx: MessageFilterContext): FilterResult {
        if (ctx.role !== "user") return { action: "keep" }
        if (!ctx.text.includes(SYSTEM_REMINDER_OPEN) && !ctx.text.includes(OMO_MARKER)) {
            return { action: "keep" }
        }

        let modified = ctx.text
        let removedBlocks = 0

        const openRegex = new RegExp(
            `${escapeRegex(SYSTEM_REMINDER_OPEN)}[\\s\\S]*?${escapeRegex(SYSTEM_REMINDER_CLOSE)}\\s*${escapeRegex(OMO_MARKER)}`,
            "g",
        )
        modified = modified.replace(openRegex, (_match) => {
            removedBlocks++
            return ""
        })

        const loneReminderRegex = new RegExp(
            `${escapeRegex(SYSTEM_REMINDER_OPEN)}[\\s\\S]*?${escapeRegex(SYSTEM_REMINDER_CLOSE)}`,
            "g",
        )
        modified = modified.replace(loneReminderRegex, (_match) => {
            removedBlocks++
            return ""
        })

        const loneMarkerRegex = new RegExp(escapeRegex(OMO_MARKER), "g")
        modified = modified.replace(loneMarkerRegex, "")

        modified = modified.replace(/\n{3,}/g, "\n\n").trim()

        if (modified.length === 0) {
            return { action: "drop", reason: `Stripped ${removedBlocks} OMO system-reminder block(s)` }
        }

        if (modified !== ctx.text) {
            return {
                action: "modify",
                text: modified,
                reason: `Stripped ${removedBlocks} OMO system-reminder block(s)`,
            }
        }

        return { action: "keep" }
    },
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export { OMO_SYSTEM_REMINDER_FILTER }
