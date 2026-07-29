import type { WithParts } from "../state"
import { hasMeaningfulContent } from "./parts"

// Must run AFTER injectCompressNudges: the nudge system needs to see failed
// compress calls for baseline reset (messageHasCompressAttempt). Removing them
// first would reintroduce the issue #216 feedback loop.
//
// Keeps the MOST RECENT failed compress call so the model can retry (e.g. with
// acknowledgeRisk after a quality gate rejection). Older failures are removed
// to prevent context pollution from repeated failures.
export function hideFailedCompressCalls(messages: WithParts[]): number {
    let mostRecentFailedId: string | undefined
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]!
        const parts = msg.parts
        if (!Array.isArray(parts)) continue
        if (
            parts.some(
                (p) =>
                    p.type === "tool" &&
                    p.tool === "compress" &&
                    p.state?.status === "error",
            )
        ) {
            mostRecentFailedId = msg.info.id
            break
        }
    }

    let hidden = 0

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i]!
        if (msg.info.id === mostRecentFailedId) continue

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
