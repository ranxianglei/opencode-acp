import type { SessionState, WithParts } from "../state"
import { hasMeaningfulContent } from "./parts"

const KEEP_LAST_ORPHANED = 2

export function hideConsumedCompressCalls(state: SessionState, messages: WithParts[]): number {

    const activeCallIds = new Set<string>()
    const allBlockCallIds = new Set<string>()
    for (const block of state.prune.messages.blocksById.values()) {
        if (block.compressCallId) {
            allBlockCallIds.add(block.compressCallId)
            if (block.active && !block.deactivatedByUser && !block.deactivatedByUserDeep) {
                activeCallIds.add(block.compressCallId)
            }
        }
    }

    const lastOrphanedCallIds: string[] = []
    for (let i = messages.length - 1; i >= 0 && lastOrphanedCallIds.length < KEEP_LAST_ORPHANED; i--) {
        const parts = Array.isArray(messages[i]?.parts) ? messages[i]!.parts : []
        for (let j = parts.length - 1; j >= 0 && lastOrphanedCallIds.length < KEEP_LAST_ORPHANED; j--) {
            const p = parts[j]!
            if (p.type === "tool" && p.tool === "compress" && p.callID && !allBlockCallIds.has(p.callID)) {
                lastOrphanedCallIds.push(p.callID)
            }
        }
    }

    const keepCallIds = new Set([...activeCallIds, ...lastOrphanedCallIds])

    let hidden = 0
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i]!
        const parts = Array.isArray(msg.parts) ? msg.parts : []
        let changed = false
        const remaining = parts.filter((p) => {
            if (p.type === "tool" && p.tool === "compress") {
                if (p.callID && keepCallIds.has(p.callID)) return true
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
