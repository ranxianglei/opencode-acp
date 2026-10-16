/**
 * [Issue #485] Sticky emergency truncation.
 *
 * The emergency guards (`truncateLargeToolOutputs` + `enforceContextBudget`)
 * operate on a fresh pristine copy of `output.messages` every request and
 * gate on the LAST assistant's reported usage — which reflects the
 * *truncated* request, not the pristine one. A session hovering at the guard
 * threshold therefore oscillates: truncate (A→B) → smaller usage → no
 * truncation next request (full A restored) → cache miss → over budget
 * again. Every flip invalidates the provider prefix cache from that message
 * onward, and with opencode auto-retrying on a busy backend the churn can
 * take down the serving cluster.
 *
 * Stickiness makes the guard decision one-way: the first time a guard
 * truncates (or clears) a tool output, the result is frozen in
 * `state.stickyTruncations` keyed by tool call ID and replayed verbatim on
 * every later request BEFORE the guards run. A→B→B→B — the truncated form
 * never grows back. The full content stays in the session store (and on
 * disk), so nothing is lost; the wire view is simply stable.
 */

import { extractCompletedToolOutput } from "../token-utils"
import type { Logger } from "../logger"
import type { SessionState, WithParts } from "../state"

type ToolPartLike = {
    type: string
    callID?: unknown
    state?: { output?: unknown; time?: { compacted?: boolean } }
}

function collectToolParts(messages: WithParts[]): ToolPartLike[] {
    const parts: ToolPartLike[] = []
    for (const message of messages) {
        const messageParts = Array.isArray((message as { parts?: unknown }).parts)
            ? ((message as { parts: unknown[] }).parts as unknown[])
            : []
        for (const part of messageParts) {
            if ((part as ToolPartLike)?.type === "tool") {
                parts.push(part as ToolPartLike)
            }
        }
    }
    return parts
}

/**
 * Replay frozen truncations onto the request copy, and prune entries whose
 * call no longer exists in the projected view. Returns the number of map
 * entries deleted this call (prunes) so the caller can persist deletions —
 * every other save trigger in the transform hook fires earlier.
 *
 * [#485 review] Compacted parts (`state.time.compacted`, opencode native
 * compaction) are never replayed onto: the guards cannot legitimately
 * truncate them, so any frozen entry predating a compaction must not
 * re-inflate old content over the compacted placeholder. They still count
 * as `seen` so genuinely vanished calls get pruned.
 *
 * [#485 review] Prune-on-vanish is intentionally coarse: a call absent from
 * ONE request's projected view (content-based filter, mid-abort partial
 * fetch) is treated like a deleted call and unfrozen. That is self-healing —
 * if the call reappears pristine and a guard truncates it again, the new
 * form is re-frozen — at the cost of a single pristine flip in that rare
 * window.
 *
 * [#485 review] Replayed values are wire-only. If a provider legitimately
 * reuses a callID for genuinely new output (not observed), the replay would
 * mask the new content on the wire until the entry is pruned; the session
 * store always keeps the authoritative full output.
 */
export function applyStickyTruncations(
    state: SessionState,
    messages: WithParts[],
    logger: Logger,
): number {
    const frozen = state.stickyTruncations
    if (Object.keys(frozen).length === 0) return 0

    let replayed = 0
    let pruned = 0
    const seen = new Set<string>()
    for (const part of collectToolParts(messages)) {
        const callID = typeof part.callID === "string" ? part.callID : undefined
        if (!callID) continue
        seen.add(callID)
        const recorded = frozen[callID]
        if (recorded === undefined) continue
        if (!part.state) continue // stateless part — cannot be a guard candidate
        if (part.state.time?.compacted) continue // native compaction wins
        // [#485 review] Overwrite non-string outputs too: the guards
        // stringify before truncating, so the frozen form is a string while
        // the pristine per-request copy is whatever the store holds. Skipping
        // non-strings would let the exact A→B→A flip survive for that shape.
        if (part.state.output === recorded) continue
        part.state.output = recorded
        replayed++
    }

    for (const callID of Object.keys(frozen)) {
        if (!seen.has(callID)) {
            delete frozen[callID]
            pruned++
        }
    }

    if (replayed > 0) {
        logger.debug("Sticky truncation: replayed frozen tool outputs", {
            replayed,
            frozen: Object.keys(frozen).length,
        })
    }
    return pruned
}

/**
 * Snapshot callID → output for every completed tool part. Non-string
 * outputs are stringified via `extractCompletedToolOutput` — the same
 * normalization the guards use before truncating — so a guard turning an
 * object output into a truncated string is detected as a change and frozen.
 * Compacted parts are skipped: `extractCompletedToolOutput` reports their
 * placeholder while `state.output` still holds the full string, which would
 * otherwise read as a guard change and freeze the FULL output into state.
 */
export function snapshotToolOutputs(messages: WithParts[]): Map<string, string> {
    const snapshot = new Map<string, string>()
    for (const part of collectToolParts(messages)) {
        const callID = typeof part.callID === "string" ? part.callID : undefined
        if (!callID) continue
        if (part.state?.time?.compacted) continue
        const content = extractCompletedToolOutput(part)
        if (content === undefined) continue
        snapshot.set(callID, content)
    }
    return snapshot
}

/**
 * Freeze any output the guards changed since `before`: a changed output is
 * either a fresh truncation or a phase-2 clear — both must stick. Compacted
 * parts never reach this loop's freeze path (skipped by the snapshot; guards
 * skip them too). Returns the number of entries frozen so the caller can
 * persist immediately (every other save trigger in the transform hook fires
 * EARLIER, so a quiet session would otherwise reach disk only via an
 * unrelated later save).
 */
export function recordStickyTruncations(
    state: SessionState,
    messages: WithParts[],
    before: Map<string, string>,
    logger: Logger,
): number {
    let recorded = 0
    for (const part of collectToolParts(messages)) {
        const callID = typeof part.callID === "string" ? part.callID : undefined
        if (!callID) continue
        if (typeof part.state?.output !== "string") continue
        const prior = before.get(callID)
        if (prior === undefined || prior === part.state.output) continue
        if (state.stickyTruncations[callID] === part.state.output) continue
        state.stickyTruncations[callID] = part.state.output
        recorded++
    }
    if (recorded > 0) {
        logger.info("Sticky truncation: froze truncated tool outputs", { recorded })
    }
    return recorded
}
