import type { PluginConfig } from "../config"
import type { WithParts } from "../state"
import { isMessageWithInfo } from "./shape"

export function isSyntheticMessage(message: WithParts): boolean {
    const id = message?.info?.id
    return typeof id === "string" && (id.startsWith("msg_dcp_summary_") || id.startsWith("msg_dcp_text_") || id.startsWith("msg_acp_recap_"))
}

export const getLastUserMessage = (
    messages: WithParts[],
    startIndex?: number,
): WithParts | null => {
    const start = startIndex ?? messages.length - 1
    for (let i = start; i >= 0; i--) {
        const msg = messages[i]
        if (!isMessageWithInfo(msg)) {
            continue
        }
        if (msg.info.role === "user" && !isIgnoredUserMessage(msg) && !isSyntheticMessage(msg)) {
            return msg
        }
    }
    return null
}

export const messageHasCompress = (message: WithParts): boolean => {
    if (!isMessageWithInfo(message)) {
        return false
    }

    if (message.info.role !== "assistant") {
        return false
    }

    const parts = Array.isArray(message.parts) ? message.parts : []
    return parts.some(
        (part) =>
            part.type === "tool" && part.tool === "compress" && part.state?.status === "completed",
    )
}

/**
 * Detects ANY compress tool call — including failed/rejected ones.
 *
 * Used for nudge state management: a failed compress attempt means the model
 * DID respond to the nudge (it tried to compress), so the pending-nudge state
 * should be cleared. Without this, the threshold stays permanently halved
 * after a rejected compress, creating a self-accelerating nudge loop.
 *
 * For priority/state queries that only care about SUCCESSFUL compressions
 * (e.g. message priority classification), use `messageHasCompress` instead.
 */
export const messageHasCompressAttempt = (message: WithParts): boolean => {
    if (!isMessageWithInfo(message)) {
        return false
    }

    if (message.info.role !== "assistant") {
        return false
    }

    const parts = Array.isArray(message.parts) ? message.parts : []
    return parts.some((part) => part.type === "tool" && part.tool === "compress")
}

/**
 * Classifies a compress tool call by its range boundaries to detect whether it is
 * a raw-message capture (T1) or a summary distillation/condensation (T2/T3).
 *
 * Returns `true` ONLY when the call is positively identified as a T1 capture: at
 * least one range boundary is present and NONE of them is a block ref (`bN`). A
 * block-ref boundary means the call consumes existing summaries (T2/T3); those
 * must keep resetting the tier cadence baselines to prevent re-trigger loops
 * (issue #235). A pure message capture (`mNNNNN` boundaries) only ADDS tier-1
 * summaries, so resetting the baselines after every capture is what starves T2
 * distillation (issue #364 P1) — callers skip the reset for these.
 *
 * Returns `false` when any boundary is a block ref OR when no parsable boundary
 * is found (conservative: preserve the loop-prevention reset).
 */
export const isCaptureOnlyCompress = (message: WithParts | undefined): boolean => {
    if (!isMessageWithInfo(message)) {
        return false
    }
    if (message.info.role !== "assistant") {
        return false
    }

    const parts = Array.isArray(message.parts) ? message.parts : []
    let sawBoundary = false
    for (const part of parts) {
        if (!(part.type === "tool" && part.tool === "compress")) {
            continue
        }
        for (const startId of extractCompressBoundaryIds(part.state?.input)) {
            sawBoundary = true
            if (/^b\d+$/i.test(startId)) {
                return false // any block-ref boundary → T2/T3 distillation/condensation
            }
        }
    }
    // >=1 boundary present and none were block refs → pure raw-message T1 capture.
    return sawBoundary
}

/**
 * Extracts the startId/endId boundary refs from a compress tool part's input.
 * The input may arrive as a parsed object or a JSON string; malformed shapes
 * yield an empty list rather than throwing.
 */
function extractCompressBoundaryIds(rawInput: unknown): string[] {
    let content: unknown[] = []
    if (typeof rawInput === "string") {
        try {
            const parsed: unknown = JSON.parse(rawInput)
            const c = (parsed as { content?: unknown })?.content
            content = Array.isArray(c) ? (c as unknown[]) : []
        } catch {
            return []
        }
    } else if (rawInput && typeof rawInput === "object") {
        const c = (rawInput as { content?: unknown }).content
        content = Array.isArray(c) ? (c as unknown[]) : []
    }

    const ids: string[] = []
    for (const entry of content) {
        if (!entry || typeof entry !== "object") {
            continue
        }
        const { startId, endId } = entry as { startId?: unknown; endId?: unknown }
        for (const sid of [startId, endId]) {
            if (typeof sid === "string" && sid.trim() !== "") {
                ids.push(sid.trim())
            }
        }
    }
    return ids
}

export const isIgnoredUserMessage = (message: WithParts): boolean => {
    if (!isMessageWithInfo(message)) {
        return false
    }

    if (message.info.role !== "user") {
        return false
    }

    const parts = Array.isArray(message.parts) ? message.parts : []
    if (parts.length === 0) {
        return true
    }

    for (const part of parts) {
        if (!(part as any).ignored) {
            return false
        }
    }

    return true
}

export function isProtectedUserMessage(_config: PluginConfig, message: WithParts): boolean {
    if (!isMessageWithInfo(message)) {
        return false
    }

    return false
}
