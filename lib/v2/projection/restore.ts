import type { WithParts } from "../../state"
import { isAcpOwnedNoticeId, isRecord, stringValue } from "./shared"
import type { V2Projection, V2ProvenanceEntry } from "./types"

export interface V2OpaqueSourceRestorationAccepted {
    accepted: true
    ok: true
    messages: WithParts[]
    restoredMessageIds: string[]
}

export interface V2OpaqueSourceRestorationRejected {
    accepted: false
    ok: false
    reason: string
}

export type V2OpaqueSourceRestorationResult =
    V2OpaqueSourceRestorationAccepted | V2OpaqueSourceRestorationRejected

function normalizedMessageId(message: WithParts): string | undefined {
    return isRecord(message.info) ? stringValue(message.info.id) : undefined
}

function rejectsMissingNormalizedSource(entry: V2ProvenanceEntry): boolean {
    if (entry.normalizedMessageId) return false
    if (entry.sourceType === "acp-synthetic" || isAcpOwnedNoticeId(entry.sourceMessageId)) {
        return false
    }
    // Running and failed compactions intentionally have no algorithm projection;
    // they cannot have been dropped from the transformed projection.
    if (entry.sourceType === "compaction" && entry.status !== "completed") return false
    // A wholly-reserved provider checkpoint intentionally emits no algorithm
    // projection: its entire outgoing window was reserved to correlated sources
    // (issue #456), so there is no message that could have been dropped and
    // nothing to restore.
    if (entry.providerCheckpoint) return false
    return (
        entry.sourceType !== "control" &&
        entry.sourceType !== "agent-switched" &&
        entry.sourceType !== "model-switched" &&
        entry.sourceType !== "idle"
    )
}

function reject(reason: string): V2OpaqueSourceRestorationRejected {
    return { accepted: false, ok: false, reason }
}

/**
 * Restore protected opaque sources removed by the shared ACP transform.
 *
 * The normalized messages are algorithm input only, so every restoration is a
 * clone. Existing transformed messages are retained verbatim: this helper must
 * not overwrite edits to patchable sources or provider-owned values.
 */
export function restoreMissingV2OpaqueSources(
    projection: Pick<V2Projection, "entries" | "messages">,
    transformed: readonly WithParts[],
): V2OpaqueSourceRestorationResult {
    const entriesById = new Map<string, V2ProvenanceEntry>()
    const sourceIndexById = new Map<string, number>()
    const sourceIndexes = new Map<number, string>()

    for (const entry of projection.entries) {
        const id = entry.normalizedMessageId
        if (!id) {
            if (
                entry.opaque &&
                !entry.allowSourceRemoval &&
                rejectsMissingNormalizedSource(entry)
            ) {
                return reject(
                    `Opaque source ${entry.sourceMessageId ?? entry.sourceIndex} has no normalized source message`,
                )
            }
            continue
        }
        if (entriesById.has(id)) return reject(`Normalized source message ${id} is ambiguous`)
        if (!Number.isInteger(entry.sourceIndex) || entry.sourceIndex < 0) {
            return reject(`Normalized source message ${id} has an invalid source order`)
        }
        const priorID = sourceIndexes.get(entry.sourceIndex)
        if (priorID !== undefined && priorID !== id) {
            return reject(`Normalized source order ${entry.sourceIndex} is ambiguous`)
        }
        entriesById.set(id, entry)
        sourceIndexById.set(id, entry.sourceIndex)
        sourceIndexes.set(entry.sourceIndex, id)
    }

    const normalizedById = new Map<string, WithParts>()
    for (const message of projection.messages) {
        const id = normalizedMessageId(message)
        if (!id) continue
        if (normalizedById.has(id)) return reject(`Normalized source message ${id} is ambiguous`)
        normalizedById.set(id, message)
    }

    const presentIds = new Set<string>()
    let previousSourceIndex = -1
    for (const message of transformed) {
        const id = normalizedMessageId(message)
        if (!id) continue
        const sourceIndex = sourceIndexById.get(id)
        if (sourceIndex === undefined) continue
        if (presentIds.has(id)) return reject(`Transformed source message ${id} is duplicated`)
        if (sourceIndex < previousSourceIndex) {
            return reject("Transformed source messages have ambiguous order")
        }
        presentIds.add(id)
        previousSourceIndex = sourceIndex
    }

    const protectedEntries = [...entriesById.values()]
        .filter(
            (entry) =>
                entry.opaque &&
                !entry.allowSourceRemoval &&
                entry.sourceType !== "acp-synthetic" &&
                !isAcpOwnedNoticeId(entry.sourceMessageId),
        )
        .sort((left, right) => left.sourceIndex - right.sourceIndex)

    const missingEntries = protectedEntries.filter(
        (entry) => !presentIds.has(entry.normalizedMessageId!),
    )
    const lastSourcePosition = transformed.reduce((last, message, index) => {
        const id = normalizedMessageId(message)
        return id && sourceIndexById.has(id) ? index : last
    }, -1)
    const result: WithParts[] = []
    const restoredMessageIds: string[] = []
    let missingIndex = 0

    const appendRestored = (
        entry: V2ProvenanceEntry,
    ): V2OpaqueSourceRestorationRejected | undefined => {
        const id = entry.normalizedMessageId!
        if (presentIds.has(id)) return undefined

        const source = normalizedById.get(id)
        if (!source) return reject(`Opaque source ${id} has no normalized source message`)
        if (entry.outgoingMessageIndices.length === 0) {
            // A provider checkpoint with no outgoing correlation is absent from
            // this request by definition (incompatible model switch or direct
            // view): the outgoing history already carries its information as
            // re-expanded host-owned originals, and the patcher accepts an
            // absent uncorrelated entry. Restoring it would fabricate a message
            // the host never sent, so skip instead of rejecting the whole patch.
            if (entry.providerCheckpoint) return undefined
            return reject(`Opaque source ${id} has no exact lowered correlation`)
        }

        let clone: WithParts
        try {
            clone = structuredClone(source) as WithParts
        } catch (error) {
            return reject(
                `Opaque source ${id} could not be cloned: ${error instanceof Error ? error.message : String(error)}`,
            )
        }
        result.push(clone)
        presentIds.add(id)
        restoredMessageIds.push(id)
        return undefined
    }

    const appendMissingBefore = (
        sourceIndex: number,
    ): V2OpaqueSourceRestorationRejected | undefined => {
        while (
            missingIndex < missingEntries.length &&
            missingEntries[missingIndex]!.sourceIndex < sourceIndex
        ) {
            const entry = missingEntries[missingIndex]!
            const rejection = appendRestored(entry)
            if (rejection) return rejection
            missingIndex++
        }
        return undefined
    }

    for (let index = 0; index < transformed.length; index++) {
        const message = transformed[index]!
        const id = normalizedMessageId(message)
        const sourceIndex = id ? sourceIndexById.get(id) : undefined
        if (sourceIndex !== undefined) {
            const rejection = appendMissingBefore(sourceIndex)
            if (rejection) return rejection
        }
        result.push(message)
        if (index === lastSourcePosition) {
            const rejection = appendMissingBefore(Number.POSITIVE_INFINITY)
            if (rejection) return rejection
        }
    }
    if (lastSourcePosition < 0) {
        const rejection = appendMissingBefore(Number.POSITIVE_INFINITY)
        if (rejection) return rejection
    }

    return { accepted: true, ok: true, messages: result, restoredMessageIds }
}
