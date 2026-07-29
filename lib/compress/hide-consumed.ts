import type { SessionState, WithParts } from "../state"
import { hasMeaningfulContent } from "./parts"

/**
 * Hide compress tool-call parts whose blocks have been consumed by another
 * compression (tier escalation or range overlap).
 *
 * This is the compress-as-anchor equivalent of filterCompressedRanges: instead
 * of hiding whole messages covered by active blocks, it hides individual
 * compress tool-call PARTS whose blocks are no longer active. The message shell
 * survives (it may carry other parts); only the consumed compress call disappears.
 *
 * If after removal the message contains only structural parts (step-start,
 * step-finish, reasoning), it is spliced entirely — those carry no useful
 * content once the compress call they wrapped is gone.
 *
 * Block data (full summary, original messages) is preserved in session state and
 * remains recoverable via `decompress`.
 *
 * Returns the number of compress-call parts hidden.
 */
export function hideConsumedCompressCalls(state: SessionState, messages: WithParts[]): number {
    if (state.prune.messages.blocksById.size === 0) {
        return 0
    }

    const consumedMessageIds = new Set<string>()
    for (const block of state.prune.messages.blocksById.values()) {
        if (block.active) continue
        if (block.deactivatedByUser) continue
        if (block.deactivatedByUserDeep) continue
        if (block.deactivatedByBlockId === undefined) continue
        if (!block.compressMessageId) continue
        consumedMessageIds.add(block.compressMessageId)
    }

    if (consumedMessageIds.size === 0) {
        return 0
    }

    let hidden = 0
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i]!
        if (!consumedMessageIds.has(msg.info.id)) continue

        const parts = Array.isArray(msg.parts) ? msg.parts : []
        let changed = false
        const remaining = parts.filter((p) => {
            if (p.type === "tool" && p.tool === "compress") {
                hidden++
                changed = true
                return false
            }
            return true
        })

        if (changed) {
            if (hasMeaningfulContent(remaining)) {
                messages[i] = { ...msg, parts: remaining }
            } else {
                messages.splice(i, 1)
                i--
            }
        }
    }

    return hidden
}
