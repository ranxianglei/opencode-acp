import type { MessageFilter, MessageFilterContext, FilterResult } from "../types"

/**
 * OMO mode injection filter.
 *
 * Unlike pure-injection filters (omo-context, omo-task-directive), mode
 * injections are *prepended* to the user's actual message. This filter
 * strips only the injection block(s) and preserves user content.
 */
const XML_MODE_TAGS: Array<{ open: string; close: string }> = [
    { open: "<hyperplan-ultrawork-mode>", close: "</hyperplan-ultrawork-mode>" },
    { open: "<ultrawork-mode>", close: "</ultrawork-mode>" },
]

const BRACKET_MODE_PATTERNS = ["[search-mode]", "[analyze-mode]", "[ultrawork-mode]"]

function stripLeadingModeInjections(text: string): string | null {
    let current = text
    let strippedAny = false

    for (let iter = 0; iter < 5; iter++) {
        current = current.trimStart()
        let matched = false

        for (const { open, close } of XML_MODE_TAGS) {
            if (current.startsWith(open)) {
                const closeIdx = current.indexOf(close)
                if (closeIdx !== -1) {
                    current = current.slice(closeIdx + close.length)
                } else {
                    current = current.slice(open.length)
                }
                matched = true
                break
            }
        }

        if (!matched) {
            for (const pattern of BRACKET_MODE_PATTERNS) {
                if (current.startsWith(pattern)) {
                    current = current.slice(pattern.length)
                    matched = true
                    break
                }
            }
        }

        if (matched) {
            strippedAny = true
        } else {
            break
        }
    }

    return strippedAny ? current.trim() : null
}

const OMO_MODE_FILTER: MessageFilter = {
    name: "omo-mode-injection",
    version: "1.1.0",
    description:
        "Strip OMO mode injection blocks (<ultrawork-mode>...</ultrawork-mode>, [search-mode], etc.) from user messages, preserving user content",

    filter(ctx: MessageFilterContext): FilterResult {
        if (ctx.role !== "user") return { action: "keep" }

        const remaining = stripLeadingModeInjections(ctx.text)
        if (remaining === null) return { action: "keep" }

        if (remaining.length === 0) {
            return { action: "drop", reason: "OMO mode injection (no user content after stripping)" }
        }

        return {
            action: "modify",
            text: remaining,
            reason: "Stripped OMO mode injection block(s), preserved user content",
        }
    },
}

export { OMO_MODE_FILTER }
