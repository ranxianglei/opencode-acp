import type { Part } from "@opencode-ai/sdk/v2"
import type { CompressionBlock, SessionState, WithParts } from "../state"
import { hasMeaningfulContent } from "./parts"

const KEEP_LAST_ORPHANED = 2

function isLiveBlock(block: CompressionBlock): boolean {
    return block.active && !block.deactivatedByUser && !block.deactivatedByUserDeep
}

/**
 * Blocks record the same `startId`/`endId` refs as the `content[]` entry that
 * created them (see `lib/compress/range.ts`), so this pair maps an entry to its
 * block within a batched call.
 */
function rangeKey(startId: string, endId: string): string {
    return `${startId}::${endId}`
}

/**
 * Filter a kept compress part's range-mode `content[]` to entries whose block
 * is still live. Returns a shallow clone with rewritten `state.input.content`
 * when entries were dropped, else `null` (all entries live, input isn't a
 * filterable batch, or matching missed — in which case the part is left intact
 * rather than risk dropping a live summary). Never mutates the original part.
 */
function rewriteCompressInput(part: Part, liveKeys: Set<string>): Part | null {
    if (part.type !== "tool") return null
    const state = part.state
    const input = state?.input
    if (!input || typeof input !== "object") return null
    const content = (input as { content?: unknown }).content
    if (!Array.isArray(content) || content.length === 0) return null

    const kept = content.filter((entry): entry is Record<string, unknown> => {
        if (!entry || typeof entry !== "object") return false
        const s = typeof entry.startId === "string" ? entry.startId : ""
        const e = typeof entry.endId === "string" ? entry.endId : ""
        return liveKeys.has(rangeKey(s, e))
    })

    if (kept.length === content.length || kept.length === 0) return null

    return {
        ...part,
        state: { ...state!, input: { ...input, content: kept } },
    }
}

/**
 * Hide compress tool calls whose blocks have all been consumed by a higher-tier
 * distillation, and for batched calls where only some sibling blocks are
 * consumed, rewrite the surviving tool part to carry only the still-live
 * entries' summaries.
 *
 * Decided per-block, not per-callID: a single batched `compress` call (multiple
 * `content[]` entries) creates multiple blocks sharing one `compressCallId`.
 * Keying on the callId (1:N) lets one live sibling rescue consumed batch-mates,
 * permanently leaking their summary text — unreclaimable because `compress` is
 * in the default protected-tools list. See upstream issue #288.
 */
export function hideConsumedCompressCalls(state: SessionState, messages: WithParts[]): number {
    const allBlockCallIds = new Set<string>()
    const liveRangeKeysByCallId = new Map<string, Set<string>>()
    const activeCallIds = new Set<string>()
    for (const block of state.prune.messages.blocksById.values()) {
        if (!block.compressCallId) continue
        allBlockCallIds.add(block.compressCallId)
        if (!isLiveBlock(block)) continue
        activeCallIds.add(block.compressCallId)
        let keys = liveRangeKeysByCallId.get(block.compressCallId)
        if (!keys) {
            keys = new Set<string>()
            liveRangeKeysByCallId.set(block.compressCallId, keys)
        }
        keys.add(rangeKey(block.startId, block.endId))
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
        const remaining: Part[] = []
        for (const p of parts) {
            if (p.type === "tool" && p.tool === "compress") {
                if (!p.callID || !keepCallIds.has(p.callID)) {
                    hidden++
                    changed = true
                    continue
                }
                const liveKeys = liveRangeKeysByCallId.get(p.callID)
                if (liveKeys && liveKeys.size > 0) {
                    const rewritten = rewriteCompressInput(p, liveKeys)
                    if (rewritten) {
                        remaining.push(rewritten)
                        changed = true
                        continue
                    }
                }
                remaining.push(p)
            } else {
                remaining.push(p)
            }
        }

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
