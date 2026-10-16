import type { WithParts } from "../state"
import { getLastUserMessage } from "./query"

type MessagePart = WithParts["parts"][number]
type TextPart = Extract<MessagePart, { type: "text" }>
type ReasoningPart = Extract<MessagePart, { type: "reasoning" }>

// Type-predicate filters: plain Array.prototype.filter does not narrow the
// element type, so these collect reasoning/text parts as their concrete
// variants (both expose .text) rather than the full Part union.
const isReasoningWithText = (part: MessagePart): part is ReasoningPart =>
    part.type === "reasoning" && typeof part.text === "string"
const isTextWithText = (part: MessagePart): part is TextPart =>
    part.type === "text" && typeof part.text === "string"

/**
 * Mirrors opencode's differentModel handling by preserving part content while
 * dropping provider metadata on assistant parts that came from a different
 * model/provider than the current turn's user message.
 */
export function stripStaleMetadata(messages: WithParts[]): void {
    const lastUserMessage = getLastUserMessage(messages)
    if (lastUserMessage?.info.role !== "user") {
        return
    }

    const modelID = lastUserMessage.info.model.modelID
    const providerID = lastUserMessage.info.model.providerID

    messages.forEach((message) => {
        if (message.info.role !== "assistant") {
            return
        }

        // [FIX Bug 8] Guard against undefined modelID/providerID
        const msgModelID = (message.info as any).modelID
        const msgProviderID = (message.info as any).providerID
        if (msgModelID === modelID && msgProviderID === providerID) {
            return
        }

        message.parts = message.parts.map((part) => {
            if (part.type !== "text" && part.type !== "tool" && part.type !== "reasoning") {
                return part
            }

            if (!("metadata" in part)) {
                return part
            }

            const { metadata: _metadata, ...rest } = part
            return rest
        })
    })
}

/**
 * Drop `reasoning` parts from HISTORICAL `compress` tool-call messages (#368).
 *
 * `compress` tool-call messages are hard-excluded from every compression
 * selection (Bug 39) and therefore re-sent every request, with their
 * `reasoning` riding along — a monotonically growing floor that compression
 * can never reclaim. This request-time pass removes ONLY the `reasoning`
 * parts from such messages when BOTH gates hold:
 *
 *   1. turn-closure: the message is strictly before the last genuine user
 *      message. The current, possibly-open round is never touched — providers
 *      may require replaying the active round's thinking.
 *   2. per-message size: the message's total reasoning length EXCEEDS
 *      `threshold` chars (owner decision: single-thinking size — small
 *      thinkings are left alone; only oversized ones are dropped; not
 *      accumulated). `threshold: 0` drops unconditionally.
 *
 * The tool call and every non-reasoning part are preserved. Only messages
 * carrying a `compress` tool part are selected (NOT other protected tools).
 * No state/DB writes; deterministic (prefix-cache-stable within a turn).
 *
 * @returns the number of `reasoning` parts removed.
 */
export function dropCompressReasoning(messages: WithParts[], threshold: number): number {
    const lastUserMessage = getLastUserMessage(messages)
    if (!lastUserMessage || lastUserMessage.info.role !== "user") {
        return 0
    }

    // Index of the last genuine user message = start of the current round.
    // Only messages strictly before it belong to closed historical turns.
    const lastUserIndex = messages.lastIndexOf(lastUserMessage)
    if (lastUserIndex <= 0) {
        return 0
    }

    let removed = 0

    for (let i = 0; i < lastUserIndex; i++) {
        const message = messages[i]
        if (!message || message.info.role !== "assistant") {
            continue
        }

        const parts = Array.isArray(message.parts) ? message.parts : []
        let hasCompressTool = false
        let reasoningLength = 0

        for (const part of parts) {
            if (part.type === "tool" && part.tool === "compress") {
                hasCompressTool = true
            } else if (part.type === "reasoning") {
                reasoningLength += part.text.length
            }
        }

        if (!hasCompressTool) {
            continue
        }
        if (reasoningLength <= threshold) {
            continue
        }

        const filtered = parts.filter((part) => part.type !== "reasoning")
        if (filtered.length === parts.length) {
            continue
        }
        message.parts = filtered
        removed += parts.length - filtered.length
    }

    return removed
}

/**
 * Pin the wire form of historical thinking (#482).
 *
 * The host decides, at request time, which field a stored assistant message's
 * thinking goes into based on the CURRENT model metadata table (v1
 * `capabilities.interleaved`). That choice is not persisted with the message,
 * so a metadata-table refresh re-serializes the same stored message into a
 * different wire form, invalidating every content-hash-derived id downstream
 * (billion-context's compression ledger can no longer recognize already-folded
 * content → context re-bloats → re-compression; observed ~986 mismatches in a
 * flagship session ≈ 2× the count of thinking messages).
 *
 * This request-time pass removes that degree of freedom: for every assistant
 * message it merges ALL `reasoning` parts into ONE `text` part using a fixed
 * marker form, leaving ZERO reasoning parts behind. With no reasoning parts
 * present the host has nothing to interleave, so the serialized bytes are
 * independent of the metadata table / interleaved flag / provider config.
 *
 * Marker form (byte-deterministic):
 *   `<thinking>\n{R}\n</thinking>`           when the message has no text
 *   `<thinking>\n{R}\n</thinking>\n{T}`      when it also has text
 * where R = all reasoning texts joined with "" and T = all text texts joined
 * with "". The empty-string join matches opencode's lowerAssistantMessage
 * (both text and reasoning are `.join("")` there), so the billion-context
 * kernel — which recognizes `<thinking>…</thinking>` as one of its demoted-
 * thinking FORMS and splits it back before minting — produces an id identical
 * to the split form. Existing ledgers align exactly, zero aliases.
 *
 * Idempotent: after one run the message carries no reasoning parts, so a
 * second run is a no-op → prefix-cache stable (the wire changes only once).
 * Stateless, deterministic, no DB writes. Non-reasoning/non-text parts
 * (tool/file/image/step) keep their positions. Runs AFTER #368's drop pass.
 *
 * Known boundary: direct providers needing structured thinking replay
 * (Anthropic native thinking block / Gemini thoughtSignature) lose their
 * structured field — such lanes need separate evaluation. The global kill-
 * switch is `compress.reasoning.normalize` (a per-lane switch may follow).
 *
 * @returns the number of assistant messages rewritten.
 */
export function normalizeThinkingForm(messages: WithParts[]): number {
    let normalized = 0

    for (const message of messages) {
        if (!message || message.info.role !== "assistant") {
            continue
        }

        const parts = Array.isArray(message.parts) ? message.parts : []
        const reasoningParts = parts.filter(isReasoningWithText)
        if (reasoningParts.length === 0) {
            continue // idempotent: nothing to normalize
        }

        const R = reasoningParts.map((part) => part.text).join("")
        const textParts = parts.filter(isTextWithText)
        const T = textParts.map((part) => part.text).join("")
        const mergedText = `<thinking>\n${R}\n</thinking>` + (T.length > 0 ? `\n${T}` : "")

        // Reuse the first text part's identity when present (keeps its id and
        // any non-content fields); otherwise build a fresh, stable part id.
        const donor: TextPart | undefined = textParts[0]

        const newParts: MessagePart[] = []
        let inserted = false
        for (const part of parts) {
            if (part.type === "reasoning" || part.type === "text") {
                if (!inserted) {
                    if (donor) {
                        newParts.push({ ...donor, text: mergedText })
                    } else {
                        newParts.push({
                            id: `${message.info.id}-acp-think`,
                            sessionID: message.info.sessionID,
                            messageID: message.info.id,
                            type: "text",
                            text: mergedText,
                        })
                    }
                    inserted = true
                }
                // subsequent reasoning/text parts are folded away
                continue
            }
            newParts.push(part)
        }
        // Defensive: reasoningParts.length > 0 guarantees a reasoning/text slot
        // was hit above, but keep the invariant explicit.
        if (!inserted) {
            newParts.unshift({
                id: `${message.info.id}-acp-think`,
                sessionID: message.info.sessionID,
                messageID: message.info.id,
                type: "text",
                text: mergedText,
            })
        }

        message.parts = newParts
        normalized++
    }

    return normalized
}
