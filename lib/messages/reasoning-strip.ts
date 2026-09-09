import type { WithParts } from "../state"
import { getLastUserMessage } from "./query"

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
 * Strip `reasoning` parts from protected-exempt HISTORICAL assistant messages.
 *
 * Protected (compress/skill) messages are excluded from every compression
 * selection at message granularity (`filterProtectedToolMessages`), so they are
 * re-sent every turn with their `reasoning` riding along — a monotonically
 * growing, never-reclaimable floor in the incompressible baseline.
 *
 * This request-time pass removes ONLY the `reasoning` parts from such messages
 * when ALL of the following gates hold (see devlog DESIGN.md):
 *   1. turn-closure: the message is strictly before the last genuine user
 *      message. The current, possibly-open round is never touched — providers
 *      may require replaying the active round's thinking.
 *   2. selector: the message contains a protected tool part (compress/skill).
 *   3. size: the message's total reasoning length exceeds `threshold` chars
 *      (default 0 — strip regardless of size; the cache-protective gate is the
 *      session-size activation gate below, not the per-message size).
 *   4. provider allowlist: only strip when the current request's provider is
 *      on `allowedProviders` (case-insensitive substring; `"*"` = all).
 *      FAIL-CLOSED: unknown/undefined provider or empty list strips nothing.
 *      Closed-turn stripping is only *documented-safe* for a known set of
 *      providers (Anthropic, Gemini); some upstreams (GPT-family via certain
 *      gateways) reject incomplete historical thinking — so unknown providers
 *      must not be touched (issue #368 review).
 *   5. activation: only strip when the request carries at least `minMessages`
 *      messages (default 100). Small sessions keep byte-stable prefixes for
 *      free; the floor this pass reclaims only matters on long sessions.
 *
 * The tool call and every non-reasoning part are preserved. No state/DB writes;
 * deterministic (prefix-cache-stable within a turn).
 *
 * @returns the number of `reasoning` parts removed.
 */
export interface StripProtectedReasoningOptions {
    /** Provider id of the current request (e.g. "anthropic"). Undefined = unknown → fail-closed. */
    providerID?: string
    /** Allowlist entries (case-insensitive substring match). `"*"` = all providers. Undefined = gate disabled (legacy callers); empty list = strip nothing (fail-closed). */
    allowedProviders?: string[]
    /** Activation gate: strip only when `messages.length >= minMessages`. 0/undefined = always. */
    minMessages?: number
}

export function stripProtectedReasoning(
    messages: WithParts[],
    protectedTools: string[],
    threshold: number,
    options?: StripProtectedReasoningOptions,
): number {
    if (protectedTools.length === 0) {
        return 0
    }

    // Gate 4 — provider allowlist (fail-closed). An explicitly provided list
    // gates the pass: no entry matches (or provider unknown / list empty) →
    // strip nothing. `"*"` opts in for every provider.
    const allowedProviders = options?.allowedProviders
    if (allowedProviders !== undefined) {
        if (allowedProviders.length === 0) {
            return 0
        }
        if (!allowedProviders.some((entry) => entry.trim() === "*")) {
            const providerID = options?.providerID
            if (
                providerID === undefined ||
                !allowedProviders.some((entry) =>
                    providerID.toLowerCase().includes(entry.trim().toLowerCase()),
                )
            ) {
                return 0
            }
        }
    }

    // Gate 5 — session-size activation. Below the floor the pass is a no-op so
    // short sessions never pay any prefix-cache churn for it.
    const minMessages = options?.minMessages
    if (minMessages !== undefined && minMessages > 0 && messages.length < minMessages) {
        return 0
    }

    const lastUserMessage = getLastUserMessage(messages)
    if (!lastUserMessage || lastUserMessage.info.role !== "user") {
        return 0
    }

    // Index of the last genuine user message = start of the current round.
    // Only messages strictly before it belong to closed historical turns.
    let lastUserIndex = -1
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i] === lastUserMessage) {
            lastUserIndex = i
            break
        }
    }
    if (lastUserIndex <= 0) {
        return 0
    }

    const protectedSet = new Set(protectedTools)
    let removed = 0

    for (let i = 0; i < lastUserIndex; i++) {
        const message = messages[i]
        if (!message || message.info.role !== "assistant") {
            continue
        }

        const parts = Array.isArray(message.parts) ? message.parts : []
        let hasProtectedTool = false
        let reasoningLength = 0

        for (const part of parts) {
            if (part.type === "tool") {
                if (protectedSet.has(part.tool)) {
                    hasProtectedTool = true
                }
            } else if (part.type === "reasoning") {
                reasoningLength += part.text.length
            }
        }

        if (!hasProtectedTool) {
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
