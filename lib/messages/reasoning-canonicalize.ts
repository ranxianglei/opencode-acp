import type { WithParts } from "../state"

type MessagePart = WithParts["parts"][number]
type TextPart = Extract<MessagePart, { type: "text" }>

// Canonical tag form = one of the demoted-thinking FORMS in billion-context's
// kernel (kernel/src/wire/demoted-thinking.ts): the kernel recovers
// <thinking>\n{R}\n</thinking>\n{T} back into the split (reasoning + text)
// cores BEFORE identity derivation, so a wire carrying this exact shape mints
// byte-identical ids to the split form. Keep in lockstep with that list.
const CANONICAL_OPEN = "\x3cthinking\x3e\n"
const CANONICAL_CLOSE = "\n\x3c/thinking\x3e"

/**
 * [#482] Pin the wire shape of historical thinking (billion-context#3301).
 *
 * The host serializer decides, per request, which field carries replayed
 * reasoning based on the CURRENT model-metadata table — a choice that is not
 * stored with the message. When the table refreshes, every historical
 * assistant message with thinking re-serializes into a different shape, its
 * content-hash identity changes, and downstream compression ledgers can no
 * longer match folded history.
 *
 * This request-time pass removes that variable at the last controllable
 * boundary before serialization: for every assistant message carrying
 * non-empty reasoning parts, the reasoning parts and the text parts are
 * folded into ONE synthesized text part in the canonical tagged form
 * `<thinking>\n{all R joined}\n</thinking>\n{all T joined}`. After the fold
 * no reasoning part survives, so the host serializer's output is
 * byte-deterministic regardless of metadata-table state, host version or
 * provider config.
 *
 * Join semantics mirror the host's own lowerAssistantMessage (reasoning parts
 * concatenated with "", text parts concatenated with ""), so the canonical
 * shape mints exactly the ids the split form minted — existing ledgers align
 * with zero aliases.
 *
 * Deterministic and idempotent: a second run sees no reasoning parts and
 * changes nothing, so prefix-cache bytes move exactly once. Non-reasoning
 * parts (tool, file, ...) pass through in original order; the synthesized
 * part takes the slot of the first folded part and reuses its id. No
 * state/DB writes. Known boundary: providers requiring structured thinking
 * replay semantics (Anthropic native thinking blocks, Gemini thoughtSignature)
 * lose the structured field — openai-compat lanes are unaffected.
 *
 * @returns the number of assistant messages whose parts were rewritten.
 */
export function canonicalizeReasoningShape(messages: WithParts[]): number {
    let normalized = 0

    for (const message of messages) {
        if (!message || message.info.role !== "assistant") {
            continue
        }

        const parts = Array.isArray(message.parts) ? message.parts : []

        let allReasoning = ""
        for (const part of parts) {
            if (part.type === "reasoning") {
                allReasoning += part.text
            }
        }
        if (allReasoning.length === 0) {
            continue
        }

        let allText = ""
        for (const part of parts) {
            if (part.type === "text") {
                allText += part.text
            }
        }

        const merged =
            allText.length > 0
                ? `${CANONICAL_OPEN}${allReasoning}${CANONICAL_CLOSE}\n${allText}`
                : `${CANONICAL_OPEN}${allReasoning}${CANONICAL_CLOSE}`

        const rebuilt: MessagePart[] = []
        let placed = false
        const placeMerged = (carrier: { id: string }): void => {
            if (placed) {
                return
            }
            placed = true
            const part: TextPart = {
                id: carrier.id,
                sessionID: message.info.sessionID,
                messageID: message.info.id,
                type: "text",
                text: merged,
            }
            rebuilt.push(part)
        }

        for (const part of parts) {
            if (part.type === "reasoning") {
                placeMerged(part)
                continue
            }
            if (part.type === "text") {
                placeMerged(part)
                continue
            }
            rebuilt.push(part)
        }

        message.parts = rebuilt
        normalized++
    }

    return normalized
}
