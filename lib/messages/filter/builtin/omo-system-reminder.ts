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

// Pre-compiled module-level regexes (hoisted from per-call construction per review).
// None of these literals contain regex metacharacters, so no escaping needed.
const PAIRED_BLOCK_RE = /<system-reminder>[\s\S]*?<\/system-reminder>\s*<!-- OMO_INTERNAL_INITIATOR -->/g
const LONE_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g
const LONE_MARKER_RE = /<!-- OMO_INTERNAL_INITIATOR -->/g

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

        modified = modified.replace(PAIRED_BLOCK_RE, () => {
            removedBlocks++
            return ""
        })

        modified = modified.replace(LONE_REMINDER_RE, () => {
            removedBlocks++
            return ""
        })

        modified = modified.replace(LONE_MARKER_RE, "")

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

export { OMO_SYSTEM_REMINDER_FILTER }
