import type { MessageFilter, MessageFilterContext, FilterResult } from "../types"

const SYSTEM_REMINDER_OPEN = "<system-reminder>"
const SYSTEM_REMINDER_CLOSE = "</system-reminder>"
const OMO_MARKER = "<!-- OMO_INTERNAL_INITIATOR -->"

// Pre-compiled regexes for stripping OMO system-reminder blocks.
const PAIRED_BLOCK_RE = /<system-reminder>[\s\S]*?<\/system-reminder>\s*<!-- OMO_INTERNAL_INITIATOR -->/g
const LONE_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g
const LONE_MARKER_RE = /<!-- OMO_INTERNAL_INITIATOR -->/g

const OMO_SYSTEM_REMINDER_FILTER: MessageFilter = {
    name: "omo-system-reminder",
    version: "1.3.0",
    description:
        "Keep recent OMO <system-reminder> messages; for older ones, strip blocks but preserve user content",
    keepLastOnly: true,
    keepLast: 2,

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
            return { action: "drop", reason: `Pure OMO system-reminder (${removedBlocks} block(s), no user content)` }
        }

        return {
            action: "modify",
            text: modified,
            reason: `Stripped ${removedBlocks} OMO system-reminder block(s), preserved user content (${modified.length} chars)`,
        }
    },
}

export { OMO_SYSTEM_REMINDER_FILTER }
