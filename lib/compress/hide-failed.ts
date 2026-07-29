import type { WithParts } from "../state"

// Must run AFTER injectCompressNudges: the nudge system needs to see failed
// compress calls for baseline reset (messageHasCompressAttempt). Removing them
// first would reintroduce the issue #216 feedback loop.
export function hideFailedCompressCalls(messages: WithParts[]): number {
    let hidden = 0

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i]!
        const parts = Array.isArray(msg.parts) ? msg.parts : []
        if (parts.length === 0) continue

        let changed = false
        const remaining = parts.filter((p) => {
            if (
                p.type === "tool" &&
                p.tool === "compress" &&
                p.state?.status === "error"
            ) {
                hidden++
                changed = true
                return false
            }
            return true
        })

        if (changed) {
            if (remaining.length > 0) {
                messages[i] = { ...msg, parts: remaining }
            } else {
                messages.splice(i, 1)
                i--
            }
        }
    }

    return hidden
}
