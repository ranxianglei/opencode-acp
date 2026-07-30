import type { MessageFilter, MessageFilterContext, FilterResult } from "../types"

const MODE_PATTERNS = ["[search-mode]", "[analyze-mode]", "<ultrawork-mode>", "[ultrawork-mode]"]

const OMO_MODE_FILTER: MessageFilter = {
    name: "omo-mode-injection",
    version: "1.0.0",
    description: "Strip OMO mode injection blocks ([search-mode], [analyze-mode], <ultrawork-mode>)",

    filter(ctx: MessageFilterContext): FilterResult {
        if (ctx.role !== "user") return { action: "keep" }
        const stripped = ctx.text.trimStart()
        const isModeInjection = MODE_PATTERNS.some((p) => stripped.startsWith(p))
        if (!isModeInjection) return { action: "keep" }

        return { action: "drop", reason: "OMO mode injection" }
    },
}

export { OMO_MODE_FILTER }
