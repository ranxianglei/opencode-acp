import { Message as AiMessage } from "@opencode/ai"
import type { ContentPart as AiContentPart, Message as AiMessageValue } from "@opencode/ai"
import type { WithParts } from "../../state"
import type {
    Part,
    PointerKey,
    V2ContentOrigin,
    V2ContextPatch,
    V2OutgoingPointer,
    V2PatchRejected,
    V2PatchRejection,
    V2Projection,
    V2ProvenanceEntry,
    V2PatchResult,
} from "./types"
import {
    aiContent,
    aiMessageId,
    aiRole,
    contentId,
    contentText,
    contentType,
    fingerprintOutgoing,
    hash,
    isAcpOwnedId,
    isRecord,
    projectionMarker,
    stringValue,
} from "./shared"

interface AppliedPatchState {
    /** Latest ACP-created content object for each original pointer. */
    parts: Map<PointerKey, AiContentPart>
    /** Exact output location for every retained original pointer. */
    locations: Map<PointerKey, AppliedPartLocation>
    /** Original pointers intentionally removed by an ACP patch. */
    removed: Set<PointerKey>
    /** Source message IDs intentionally removed by an ACP patch. */
    removedMessageIds: Set<string>
    /** Provider-owned message objects retained by an ACP patch. */
    opaqueMessages: Set<object>
    /** Last successful output snapshot, used to validate replayed ACP results. */
    output: readonly AppliedMessageSnapshot[]
}

interface AppliedPartLocation {
    message: AiMessageValue
    messageIndex: number
    contentIndex: number
    part: AiContentPart
}

interface AppliedMessageSnapshot {
    message: AiMessageValue
    id: string | undefined
    role: string | undefined
    parts: readonly AppliedPartSnapshot[]
}

interface AppliedPartSnapshot {
    part: AiContentPart
    fingerprint?: string
}

interface PartLocation {
    messageIndex: number
    contentIndex: number
    part: AiContentPart
}

/** Indexes built once per patch input instead of repeatedly scanning content. */
interface MessageIndexes {
    byObject: Map<object, number>
    byId: Map<string, number | undefined>
    byPartObject: Map<object, PartLocation>
    byPartId: Map<string, PartLocation | undefined>
}

function partIdKey(part: AiContentPart): string | undefined {
    const type = contentType(part)
    const id = contentId(part)
    return type && id ? `${type}:${id}` : undefined
}

function buildMessageIndexes(messages: readonly AiMessageValue[]): MessageIndexes {
    const byObject = new Map<object, number>()
    const byId = new Map<string, number | undefined>()
    const byPartObject = new Map<object, PartLocation>()
    const byPartId = new Map<string, PartLocation | undefined>()
    for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
        const message = messages[messageIndex]
        if (!message) continue
        byObject.set(message as object, messageIndex)
        const id = aiMessageId(message)
        if (id) {
            if (byId.has(id)) byId.set(id, undefined)
            else byId.set(id, messageIndex)
        }
        const content = aiContent(message)
        for (let contentIndex = 0; contentIndex < content.length; contentIndex++) {
            const part = content[contentIndex]
            if (!part) continue
            const location = { messageIndex, contentIndex, part }
            byPartObject.set(part as object, location)
            const key = partIdKey(part)
            if (key) {
                if (byPartId.has(key)) byPartId.set(key, undefined)
                else byPartId.set(key, location)
            }
        }
    }
    return { byObject, byId, byPartObject, byPartId }
}

function originalMessageIndexes(
    projection: V2Projection,
    currentMessages: readonly AiMessageValue[],
    currentIndexes: MessageIndexes,
    applied: AppliedPatchState | undefined,
): Map<number, number> {
    const result = new Map<number, number>()
    const originalByObject = new Map<object, number>()
    const originalById = new Map<string, number | undefined>()
    for (let index = 0; index < projection.originalMessages.length; index++) {
        const message = projection.originalMessages[index]
        if (!message) continue
        originalByObject.set(message as object, index)
        const id = aiMessageId(message)
        if (id) {
            if (originalById.has(id)) originalById.set(id, undefined)
            else originalById.set(id, index)
        }
    }
    for (let currentIndex = 0; currentIndex < currentMessages.length; currentIndex++) {
        const message = currentMessages[currentIndex]
        if (!message) continue
        const direct = originalByObject.get(message as object)
        if (direct !== undefined) {
            result.set(currentIndex, direct)
            continue
        }
        const id = aiMessageId(message)
        const byId = id ? originalById.get(id) : undefined
        if (byId !== undefined) result.set(currentIndex, byId)
    }
    // Edited role=tool messages are cloned while preserving their part
    // locations.  Recover their original message index from those locations
    // without a full message scan.
    if (applied) {
        for (const [key, location] of applied.locations) {
            const currentIndex = currentIndexes.byObject.get(location.message as object)
            if (currentIndex === undefined) continue
            const originalIndex = Number.parseInt(key.split(":", 1)[0] ?? "", 10)
            if (Number.isInteger(originalIndex)) result.set(currentIndex, originalIndex)
        }
    }
    return result
}

const appliedPatchStates = new WeakMap<object, AppliedPatchState>()

function pointerKey(pointer: V2OutgoingPointer): PointerKey | undefined {
    return pointer.contentIndex === undefined
        ? undefined
        : `${pointer.messageIndex}:${pointer.contentIndex}`
}

function sameAppliedPart(left: AiContentPart, right: AppliedPartSnapshot): boolean {
    return (
        left === right.part && (right.fingerprint === undefined || hash(left) === right.fingerprint)
    )
}

function snapshotAppliedOutput(
    messages: readonly AiMessageValue[],
    opaqueParts: ReadonlySet<object>,
): AppliedMessageSnapshot[] {
    return messages.map((message) => ({
        message,
        id: aiMessageId(message),
        role: aiRole(message),
        parts: aiContent(message).map((part) => ({
            part,
            ...(opaqueParts.has(part as object) ? {} : { fingerprint: hash(part) }),
        })),
    }))
}

/**
 * Replayed ACP results must be the exact prior output objects (a copied array is
 * fine). Compare every message and content position by identity, then use the
 * bounded patchable-content fingerprints to detect in-place edits.
 */
function appliedOutputMatches(
    messages: readonly AiMessageValue[],
    applied: AppliedPatchState,
    indexes = buildMessageIndexes(messages),
): boolean {
    if (messages.length !== applied.output.length) return false
    for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
        const current = messages[messageIndex]
        const expected = applied.output[messageIndex]
        if (!current || !expected) return false
        if (current !== expected.message) return false
        if (aiMessageId(current) !== expected.id || aiRole(current) !== expected.role) return false
        const currentContent = aiContent(current)
        if (currentContent.length !== expected.parts.length) return false
        for (let contentIndex = 0; contentIndex < expected.parts.length; contentIndex++) {
            const currentPart = currentContent[contentIndex]
            const expectedPart = expected.parts[contentIndex]
            if (!currentPart || !expectedPart) return false
            if (!sameAppliedPart(currentPart, expectedPart)) return false
        }
    }
    for (const messageID of applied.removedMessageIds) {
        if (indexes.byId.has(messageID)) return false
    }
    return true
}

function appliedPartAtLocation(
    messages: readonly AiMessageValue[],
    location: AppliedPartLocation,
    indexes = buildMessageIndexes(messages),
): boolean {
    const message = messages[location.messageIndex]
    if (!message || message !== location.message) return false
    if (indexes.byObject.get(location.message as object) !== location.messageIndex) return false
    const part = aiContent(message)[location.contentIndex]
    return part !== undefined && sameAppliedPart(part, { part: location.part })
}

function locateAppliedPart(
    messages: readonly AiMessageValue[],
    part: AiContentPart,
    indexes = buildMessageIndexes(messages),
): AppliedPartLocation | undefined {
    const location = indexes.byPartObject.get(part as object)
    if (!location) return undefined
    const message = messages[location.messageIndex]
    if (!message) return undefined
    return {
        message,
        messageIndex: location.messageIndex,
        contentIndex: location.contentIndex,
        part,
    }
}

function sourceRemovalHasExactCorrelation(
    projection: V2Projection,
    entry: V2ProvenanceEntry,
    messages: readonly AiMessageValue[],
): boolean {
    for (const messageIndex of entry.outgoingMessageIndices) {
        const message = messages[messageIndex]
        if (message !== projection.originalMessages[messageIndex]) return false
    }
    for (const origin of entry.origins) {
        for (const reference of origin.originalContent ?? []) {
            const message = messages[reference.pointer.messageIndex]
            if (
                reference.pointer.contentIndex === undefined ||
                aiContent(message)[reference.pointer.contentIndex] !== reference.part ||
                (reference.fingerprint !== undefined &&
                    hash(aiContent(message)[reference.pointer.contentIndex]) !==
                        reference.fingerprint)
            ) {
                return false
            }
        }
    }
    return true
}

function finalPartForReference(
    projection: V2Projection,
    messages: readonly AiMessageValue[],
    reference: { pointer: V2OutgoingPointer; part: AiContentPart },
    indexes = buildMessageIndexes(messages),
    applied: AppliedPatchState | undefined,
    finalIndexByCurrent: ReadonlyMap<number, number> | undefined = undefined,
    baseIndexes: MessageIndexes | undefined = undefined,
    baseByOriginal: ReadonlyMap<number, number | undefined> | undefined = undefined,
): AiContentPart | undefined {
    const key = pointerKey(reference.pointer)
    let baseMessageIndex: number | undefined
    if (key && applied) {
        const appliedLocation = applied.locations.get(key)
        if (appliedLocation && baseIndexes)
            baseMessageIndex = baseIndexes.byObject.get(appliedLocation.message as object)
    }

    const originalPart = reference.part
    const finalByIdentity = indexes.byPartObject.get(originalPart as object)
    if (finalByIdentity) return finalByIdentity.part

    baseMessageIndex ??= baseByOriginal?.get(reference.pointer.messageIndex)
    if (baseMessageIndex === undefined || reference.pointer.contentIndex === undefined)
        return undefined
    const finalMessageIndex = finalIndexByCurrent?.get(baseMessageIndex) ?? baseMessageIndex
    const message = messages[finalMessageIndex]
    if (!message) return undefined
    const indexed = aiContent(message)[reference.pointer.contentIndex]
    const originalType = contentType(originalPart)
    const originalPartID = contentId(originalPart)
    if (indexed && contentType(indexed) === originalType) {
        if (!originalPartID || contentId(indexed) === originalPartID) return indexed
    }
    if (originalPartID) {
        const byId = indexes.byPartId.get(`${originalType}:${originalPartID}`)
        if (byId && byId.messageIndex === finalMessageIndex) return byId.part
    }
    return undefined
}

function currentIndexesByOriginal(
    projection: V2Projection,
    messages: readonly AiMessageValue[],
    indexes: MessageIndexes,
    applied?: AppliedPatchState,
): Map<number, number | undefined> {
    const currentToOriginal = originalMessageIndexes(projection, messages, indexes, applied)
    const result = new Map<number, number | undefined>()
    for (const [currentIndex, originalIndex] of currentToOriginal) {
        if (result.has(originalIndex)) result.set(originalIndex, undefined)
        else result.set(originalIndex, currentIndex)
    }
    return result
}

function currentPointerForProjection(
    projection: V2Projection,
    messages: readonly AiMessageValue[],
    pointer: V2OutgoingPointer,
    indexes = buildMessageIndexes(messages),
    applied?: AppliedPatchState,
    currentByOriginal = currentIndexesByOriginal(projection, messages, indexes, applied),
): V2OutgoingPointer {
    let messageIndex = currentByOriginal.get(pointer.messageIndex) ?? -1
    const key = pointerKey(pointer)
    if (key && applied) {
        const appliedLocation = applied.locations.get(key)
        if (appliedLocation && appliedPartAtLocation(messages, appliedLocation, indexes)) {
            return {
                messageIndex: appliedLocation.messageIndex,
                contentIndex: appliedLocation.contentIndex,
            }
        }
    }

    const originalMessage = projection.originalMessages[pointer.messageIndex]
    const originalPart =
        pointer.contentIndex === undefined
            ? undefined
            : aiContent(originalMessage)[pointer.contentIndex]
    if (messageIndex < 0 && originalPart) {
        const partLocation = indexes.byPartObject.get(originalPart as object)
        if (partLocation) messageIndex = partLocation.messageIndex
    }
    return {
        // Never fall back to the original array index: a prior removal may
        // have shifted every later message, and using that stale index can
        // delete or edit an unrelated message on replay.
        messageIndex,
        contentIndex: pointer.contentIndex,
    }
}

function originalPartsForOrigin(
    projection: V2Projection,
    origin: V2ContentOrigin,
): AiContentPart[] {
    const references = origin.originalContent ?? []
    if (references.length > 0) return references.map((reference) => reference.part)
    return origin.outgoing.flatMap((pointer) => {
        if (pointer.contentIndex === undefined) return []
        const part = aiContent(projection.originalMessages[pointer.messageIndex])[
            pointer.contentIndex
        ]
        return part ? [part] : []
    })
}

function reject(code: V2PatchRejection["code"], message: string): V2PatchRejected {
    return { accepted: false, ok: false, rejection: { code, message } }
}

function transformedMessageId(message: WithParts): string | undefined {
    return isRecord(message.info) ? stringValue(message.info.id) : undefined
}

function transformedPartState(part: Part): Record<string, unknown> | undefined {
    const value: unknown = part
    if (!isRecord(value)) return undefined
    return isRecord(value.state) ? value.state : undefined
}

function stateStatus(part: Part): string | undefined {
    return stringValue(transformedPartState(part)?.status)
}

function stateInput(part: Part): unknown {
    return transformedPartState(part)?.input
}

function stateOutput(part: Part): string | undefined {
    return stringValue(transformedPartState(part)?.output)
}

function cloneAiMessage(
    message: AiMessageValue,
    content: readonly AiContentPart[],
): AiMessageValue {
    return Object.assign(Object.create(Object.getPrototypeOf(message)), message, {
        content: [...content],
    }) as AiMessageValue
}

function cloneAiContent(part: AiContentPart, update: Record<string, unknown>): AiContentPart {
    return { ...part, ...update } as AiContentPart
}

function setContentPart(
    originals: readonly AiMessageValue[],
    replacements: Map<number, AiMessageValue>,
    pointer: V2OutgoingPointer,
    update: Record<string, unknown>,
): void {
    if (pointer.contentIndex === undefined) return
    const message = replacements.get(pointer.messageIndex) ?? originals[pointer.messageIndex]
    if (!message) return
    const content = [...aiContent(message)] as AiContentPart[]
    const part = content[pointer.contentIndex]
    if (!part) return
    content[pointer.contentIndex] = cloneAiContent(part, update)
    replacements.set(pointer.messageIndex, cloneAiMessage(message, content))
}

function removeContentPointers(
    removed: Set<PointerKey>,
    pointers: readonly V2OutgoingPointer[],
): void {
    for (const pointer of pointers) {
        if (pointer.contentIndex !== undefined)
            removed.add(`${pointer.messageIndex}:${pointer.contentIndex}`)
    }
}

function normalizedMessagesById(
    messages: readonly WithParts[],
): Map<string, WithParts> | V2PatchRejected {
    const result = new Map<string, WithParts>()
    for (const message of messages) {
        const id = transformedMessageId(message)
        if (!id) return reject("unknown-origin", "A transformed message has no stable ID")
        if (result.has(id))
            return reject("duplicate-message-id", `Transformed message ID ${id} is duplicated`)
        result.set(id, message)
    }
    return result
}

function transformedPartsByOrigin(message: WithParts): Map<string, Part> | V2PatchRejected {
    const result = new Map<string, Part>()
    for (const part of message.parts ?? []) {
        const key = projectionMarker(part)
        if (!key) continue
        if (result.has(key)) return reject("ambiguous-origin", `Origin ${key} is duplicated`)
        result.set(key, part)
    }
    return result
}

function validateTransformedCallIds(messages: readonly WithParts[]): V2PatchRejected | undefined {
    const callIds = new Set<string>()
    for (const message of messages) {
        for (const part of message.parts ?? []) {
            if (part.type !== "tool") continue
            const callID = stringValue(part.callID)
            if (!callID) continue
            if (callIds.has(callID))
                return reject("duplicate-call-id", `Call ID ${callID} is duplicated`)
            callIds.add(callID)
        }
    }
    return undefined
}

function validateTransformedOrder(
    projection: V2Projection,
    messages: readonly WithParts[],
): V2PatchRejected | undefined {
    const sourceIndexById = new Map(
        projection.entries
            .filter((entry) => entry.normalizedMessageId)
            .map((entry) => [entry.normalizedMessageId!, entry.sourceIndex]),
    )
    const entriesById = new Map<string, V2ProvenanceEntry>()
    for (const entry of projection.entries) {
        if (entry.normalizedMessageId) entriesById.set(entry.normalizedMessageId, entry)
    }
    let previousSourceIndex = -1
    for (const message of messages) {
        const id = transformedMessageId(message)
        if (!id) continue
        const sourceIndex = sourceIndexById.get(id)
        if (sourceIndex !== undefined) {
            if (sourceIndex < previousSourceIndex) {
                return reject("invalid-order", "Transformed source messages are not monotonic")
            }
            previousSourceIndex = sourceIndex
        }
        const entry = entriesById.get(id)
        if (!entry) continue
        const expected = entry.origins.map((origin) => origin.key)
        const expectedPosition = new Map(expected.map((key, index) => [key, index]))
        let expectedIndex = 0
        for (const part of message.parts ?? []) {
            const key = projectionMarker(part)
            if (!key) continue
            const position = expectedPosition.get(key)
            if (position === undefined) continue
            if (position < expectedIndex) {
                return reject("invalid-order", `Origin order changed for message ${id}`)
            }
            expectedIndex = position + 1
        }
    }
    return undefined
}

function validateBaseline(
    projection: V2Projection,
    messages: readonly AiMessageValue[],
    currentIndexes = buildMessageIndexes(messages),
    applied = appliedPatchStates.get(projection),
    appliedContentMatches = applied !== undefined &&
        appliedOutputMatches(messages, applied, currentIndexes),
): V2PatchRejected | undefined {
    if (!projection.valid) {
        return reject(
            "projection-invalid",
            projection.rejection?.message ?? "V2 projection is invalid",
        )
    }
    if (projection.fingerprint !== projection.baselineFingerprint) {
        return reject(
            "fingerprint-mismatch",
            "V2 projection fingerprint was changed after normalization",
        )
    }
    const currentFingerprint = fingerprintOutgoing(messages)
    if (currentFingerprint !== projection.outgoingFingerprint && !appliedContentMatches) {
        return reject(
            "fingerprint-mismatch",
            "Lowered V2 message identities no longer match the projection",
        )
    }
    for (const entry of projection.entries) {
        for (const origin of entry.origins) {
            // A patchable projected origin is safe only when normalization found
            // an exact lowered pointer.  Without this check a same-ID source
            // whose text is "new" could be treated as a no-op against an
            // outgoing "old" message and silently claim correlation.
            if (!origin.opaque && (origin.originalContent?.length ?? 0) === 0) {
                return reject(
                    "fingerprint-mismatch",
                    `Patchable origin ${origin.key} has no exact lowered correlation`,
                )
            }
            for (const reference of origin.originalContent ?? []) {
                const key = pointerKey(reference.pointer)
                if (key === undefined) continue
                if (applied && appliedContentMatches) {
                    const patchedPart = applied.parts.get(key)
                    if (patchedPart !== undefined) {
                        const location = applied.locations.get(key)
                        if (
                            !location ||
                            !appliedPartAtLocation(messages, location, currentIndexes)
                        ) {
                            return reject(
                                origin.opaque ? "opaque-origin" : "fingerprint-mismatch",
                                origin.opaque
                                    ? "Provider-owned opaque content changed before patching"
                                    : "Lowered patchable content changed before patching",
                            )
                        }
                        continue
                    }
                    if (applied.removed.has(key)) continue
                    return reject(
                        origin.opaque ? "opaque-origin" : "fingerprint-mismatch",
                        origin.opaque
                            ? "Provider-owned opaque content has no exact replay correlation"
                            : "Lowered patchable content has no exact replay correlation",
                    )
                }

                const message = messages[reference.pointer.messageIndex]
                const part =
                    reference.pointer.contentIndex === undefined
                        ? undefined
                        : aiContent(message)[reference.pointer.contentIndex]
                if (
                    part !== reference.part ||
                    (reference.fingerprint !== undefined && hash(part) !== reference.fingerprint)
                ) {
                    return reject(
                        origin.opaque ? "opaque-origin" : "fingerprint-mismatch",
                        origin.opaque
                            ? "Provider-owned opaque content changed before patching"
                            : "Lowered patchable content changed before patching",
                    )
                }
            }
        }
    }
    const ids = new Set<string>()
    const calls = new Set<string>()
    const results = new Set<string>()
    const mappedCallIds = new Set(projection.entries.flatMap((entry) => entry.toolCallIds))
    for (const message of messages) {
        const id = aiMessageId(message)
        if (id) {
            if (ids.has(id))
                return reject("duplicate-message-id", `Outgoing message ID ${id} is duplicated`)
            ids.add(id)
        }
        for (const part of aiContent(message)) {
            const type = contentType(part)
            if ((type === "tool-call" || type === "tool-result") && contentId(part)) {
                const callID = contentId(part)!
                if (type === "tool-call") {
                    if (calls.has(callID))
                        return reject("duplicate-call-id", `Call ID ${callID} is duplicated`)
                    calls.add(callID)
                } else if (mappedCallIds.has(callID)) {
                    if (results.has(callID))
                        return reject("duplicate-call-id", `Tool result ID ${callID} is duplicated`)
                    results.add(callID)
                }
            }
        }
    }
    for (const origin of projection.outgoing) {
        if (!origin.opaque && (origin.opaqueContent?.size ?? 0) === 0) continue
        if (applied && appliedContentMatches) {
            if (
                origin.opaqueMessage !== undefined &&
                !applied.opaqueMessages.has(origin.opaqueMessage as object)
            ) {
                return reject(
                    "opaque-origin",
                    "Provider-owned opaque message changed before patching",
                )
            }
        } else {
            const message = messages[origin.messageIndex]
            if (!message) return reject("opaque-origin", "An opaque outgoing message disappeared")
            if (origin.opaqueMessage !== undefined && message !== origin.opaqueMessage) {
                return reject(
                    "opaque-origin",
                    "Provider-owned opaque message changed before patching",
                )
            }
        }
        for (const [contentIndex, originalPart] of origin.opaqueContent ?? []) {
            if (!appliedContentMatches) {
                const message = messages[origin.messageIndex]
                const part = aiContent(message)[contentIndex]
                if (!part || part !== originalPart) {
                    return reject(
                        "opaque-origin",
                        "Provider-owned opaque content changed before patching",
                    )
                }
            }
        }
    }
    return undefined
}

function outputCallIds(messages: readonly AiMessageValue[]): Set<string> {
    const ids = new Set<string>()
    for (const message of messages) {
        for (const part of aiContent(message)) {
            if (contentType(part) === "tool-call" && contentId(part)) ids.add(contentId(part)!)
        }
    }
    return ids
}

function outputResultIds(messages: readonly AiMessageValue[]): Set<string> {
    const ids = new Set<string>()
    for (const message of messages) {
        for (const part of aiContent(message)) {
            if (contentType(part) === "tool-result" && contentId(part)) ids.add(contentId(part)!)
        }
    }
    return ids
}

/**
 * ACP-authored content parts always carry a deterministic part id
 * (`prt_dcp_text_*` / `prt_dcp_summary_*`, minted in lib/messages/utils.ts).
 * Provider-owned parts never use these prefixes, so this reliably separates
 * "a part ACP wrote" from "a provider part ACP merely carried through".
 */
export function isAcpAuthoredPartId(id: string | undefined): boolean {
    if (!id) return false
    return id.startsWith("prt_dcp_text_") || id.startsWith("prt_dcp_summary_")
}

/**
 * Delta validation for an ACP-cloned host message.
 *
 * A clone mixes provider-owned parts (media, provider metadata, tool results)
 * with text parts ACP authored. Public `AiMessage.make` cannot validate such a
 * clone: @opencode/ai >= 2.0.18 models media as an Asset-instance nominal type
 * only the host's own module copy satisfies, so ACP's copy rejects valid host
 * data and rolls the whole patch back (issue #455). Validate only ACP-authored
 * parts: every ACP part id must carry a well-formed text payload. Provider
 * parts are trusted-valid and left untouched.
 *
 * Exported for a focused unit test (T1.4); also the defense-in-depth backstop
 * for the assembled outgoing message.
 */
export function validateAcpAuthoredParts(message: AiMessageValue): V2PatchRejected | undefined {
    for (const part of aiContent(message)) {
        const partId = contentId(part)
        if (!isAcpAuthoredPartId(partId)) continue
        if (contentType(part) !== "text" || contentText(part) === undefined) {
            return reject(
                "invalid-schema",
                `ACP-authored part ${partId} is not a well-formed text part`,
            )
        }
    }
    return undefined
}

// Exported for focused unit tests of the protective invariants that survive the
// #455 fix (duplicate-message-id, duplicate-call-id, invalid-tool-pair); the
// curated lib/v2/projection.ts barrel deliberately does not re-export it.
export function validateFinalMessages(
    messages: readonly AiMessageValue[],
    mappedCallIds: ReadonlySet<string>,
    removedCallIds: ReadonlySet<string>,
    authored: ReadonlySet<object>,
): V2PatchRejected | undefined {
    const ids = new Set<string>()
    const calls = outputCallIds(messages)
    const results = outputResultIds(messages)
    const resultCounts = new Map<string, number>()
    for (const message of messages) {
        const id = aiMessageId(message)
        if (id) {
            if (ids.has(id))
                return reject("duplicate-message-id", `Final message ID ${id} is duplicated`)
            ids.add(id)
        }
        // Only ACP-authored outgoing messages are validated here. Provider-owned
        // messages ACP never touched are passed through untouched; running
        // AiMessage.make over them validates host-owned data (e.g. @opencode/ai
        // 2.0.18 Media.Asset instances) against a nominal identity ACP's own
        // module copy cannot satisfy, which rejects valid live messages and rolls
        // the whole patch back (issue #455).
        if (authored.has(message)) {
            if (isAcpOwnedId(id)) {
                // Fully ACP-composed insertion (see makeInsertedMessage): every
                // part is ACP-authored text, so the public schema validator applies.
                try {
                    AiMessage.make(message)
                } catch (error) {
                    return reject(
                        "invalid-schema",
                        `Final V2 message schema is invalid: ${error instanceof Error ? error.message : String(error)}`,
                    )
                }
            } else {
                // ACP-cloned host message: nominal validation would trip over the
                // provider parts ACP did not author. Validate only ACP's own parts.
                const deltaError = validateAcpAuthoredParts(message)
                if (deltaError) return deltaError
            }
        }
        for (const part of aiContent(message)) {
            if (contentType(part) !== "tool-result") continue
            const resultID = contentId(part)
            if (!resultID || !mappedCallIds.has(resultID)) continue
            const count = (resultCounts.get(resultID) ?? 0) + 1
            resultCounts.set(resultID, count)
            if (count > 1) {
                return reject("duplicate-call-id", `Tool result ID ${resultID} is duplicated`)
            }
        }
    }
    for (const callID of mappedCallIds) {
        if (removedCallIds.has(callID)) {
            if (calls.has(callID) || results.has(callID)) {
                return reject(
                    "invalid-tool-pair",
                    `Removed call ${callID} still has a call or result`,
                )
            }
        }
    }
    for (const callID of results) {
        if (mappedCallIds.has(callID) && !calls.has(callID)) {
            return reject("invalid-tool-pair", `Mapped tool result ${callID} has no call`)
        }
    }
    return undefined
}

function sourceOrderIsMonotonic(
    projection: V2Projection,
    retainedEntries: readonly V2ProvenanceEntry[],
): V2PatchRejected | undefined {
    let previous = -1
    for (const entry of retainedEntries) {
        const indices = entry.outgoingMessageIndices
            .filter((index) => index >= 0)
            .sort((a, b) => a - b)
        if (indices.length === 0) continue
        if (indices[0] < previous) {
            return reject(
                "invalid-order",
                "Retained source messages no longer have monotonic lowered order",
            )
        }
        previous = indices[indices.length - 1]
    }
    void projection
    return undefined
}

function nearestInsertionIndex(
    transformedIndex: number,
    currentLength: number,
    nearestRetainedBefore: readonly number[],
    nearestRetainedAfter: readonly number[],
): number {
    const before = nearestRetainedBefore[transformedIndex]
    if (before !== undefined && before >= 0) return before + 1
    const after = nearestRetainedAfter[transformedIndex]
    if (after !== undefined && after >= 0) return after
    return currentLength
}

function buildNearestRetainedBoundaries(
    projection: V2Projection,
    transformed: readonly WithParts[],
    retainedIds: ReadonlySet<string>,
    currentByOriginal: ReadonlyMap<number, number | undefined>,
    removedMessages: ReadonlySet<number>,
    entriesById: ReadonlyMap<string, V2ProvenanceEntry>,
): { before: number[]; after: number[] } {
    const currentIndexById = new Map<string, number | undefined>()
    for (const id of retainedIds) {
        const entry = entriesById.get(id)
        let first: number | undefined
        let last: number | undefined
        for (const originalIndex of entry?.outgoingMessageIndices ?? []) {
            const currentIndex = currentByOriginal.get(originalIndex)
            if (currentIndex === undefined || removedMessages.has(currentIndex)) continue
            first = first === undefined ? currentIndex : Math.min(first, currentIndex)
            last = last === undefined ? currentIndex : Math.max(last, currentIndex)
        }
        currentIndexById.set(id, last ?? first)
    }

    const before = new Array<number>(transformed.length).fill(-1)
    let latest = -1
    for (let index = 0; index < transformed.length; index++) {
        before[index] = latest
        const id = transformedMessageId(transformed[index])
        const currentIndex = id ? currentIndexById.get(id) : undefined
        if (currentIndex !== undefined) latest = Math.max(latest, currentIndex)
    }

    const after = new Array<number>(transformed.length).fill(-1)
    let next = -1
    for (let index = transformed.length - 1; index >= 0; index--) {
        after[index] = next
        const id = transformedMessageId(transformed[index])
        const currentIndex = id ? currentIndexById.get(id) : undefined
        if (currentIndex !== undefined)
            next = next < 0 ? currentIndex : Math.min(next, currentIndex)
    }
    void projection
    return { before, after }
}

function makeInsertedMessage(message: WithParts): AiMessageValue | V2PatchRejected {
    const id = transformedMessageId(message)
    if (!id || !isAcpOwnedId(id)) {
        return reject("invalid-insertion", "Only ACP-owned deterministic IDs may be inserted")
    }
    const role = isRecord(message.info) && message.info.role === "assistant" ? "assistant" : "user"
    const parts = (message.parts ?? [])
        .filter((part) => part.type === "text")
        .map((part) => ({ type: "text" as const, text: stringValue(part.text) ?? "" }))
    if (parts.length === 0) return reject("invalid-insertion", `ACP insertion ${id} has no text`)
    try {
        return AiMessage.make({ id, role, content: parts })
    } catch (error) {
        return reject(
            "invalid-insertion",
            `ACP insertion ${id} is not a valid @opencode/ai message: ${error instanceof Error ? error.message : String(error)}`,
        )
    }
}

/**
 * Compare the original algorithm projection with its transformed copy and
 * apply only representable edits to the original provider-ready messages.
 *
 * This function never mutates `projection.originalMessages` or the input array.
 * It returns a complete replacement array on success and a typed rejection on
 * ambiguity/fingerprint/opaque-boundary failure.
 */
export function applyV2ContextPatch(
    projection: V2Projection,
    transformed: readonly WithParts[],
    currentMessages: readonly AiMessageValue[] = projection.originalMessages,
): V2PatchResult {
    try {
        const currentIndexes = buildMessageIndexes(currentMessages)
        const appliedState = appliedPatchStates.get(projection)
        const appliedOutput =
            appliedState !== undefined &&
            appliedOutputMatches(currentMessages, appliedState, currentIndexes)
        const baselineError = validateBaseline(
            projection,
            currentMessages,
            currentIndexes,
            appliedState,
            appliedOutput,
        )
        if (baselineError) return baselineError
        const currentByOriginal = currentIndexesByOriginal(
            projection,
            currentMessages,
            currentIndexes,
            appliedOutput ? appliedState : undefined,
        )
        const currentToOriginal = originalMessageIndexes(
            projection,
            currentMessages,
            currentIndexes,
            appliedOutput ? appliedState : undefined,
        )
        const entriesById = new Map<string, V2ProvenanceEntry>()
        for (const entry of projection.entries) {
            if (entry.normalizedMessageId) entriesById.set(entry.normalizedMessageId, entry)
        }
        const projectionMessagesById = new Map<string, WithParts>()
        const projectionPartsByMessageId = new Map<string, Map<string, Part>>()
        for (const message of projection.messages) {
            const id = transformedMessageId(message)
            if (!id) continue
            projectionMessagesById.set(id, message)
            const partsByOrigin = new Map<string, Part>()
            for (const part of message.parts ?? []) {
                const key = projectionMarker(part)
                if (key) partsByOrigin.set(key, part)
            }
            projectionPartsByMessageId.set(id, partsByOrigin)
        }
        const transformedMap = normalizedMessagesById(transformed)
        if ("accepted" in transformedMap) return transformedMap
        const transformedCallError = validateTransformedCallIds(transformed)
        if (transformedCallError) return transformedCallError
        const transformedOrderError = validateTransformedOrder(projection, transformed)
        if (transformedOrderError) return transformedOrderError

        const sourceEntries = projection.entries.filter((entry) => entry.normalizedMessageId)
        const knownSourceIds = new Set(sourceEntries.map((entry) => entry.normalizedMessageId!))
        const removedMessages = new Set<number>()
        const removedContent = new Set<PointerKey>()
        const removedCurrentContent = new Set<PointerKey>()
        const removedContentParts = new Set<AiContentPart>()
        const replacements = new Map<number, AiMessageValue>()
        const removedMessageIds: string[] = []
        const removedCallIds: string[] = []
        const editedMessageIds = new Set<string>()
        const editedCallIds = new Set<string>()
        const mappedCallIds = new Set<string>()
        const removedMessageIdSet = new Set<string>()
        const originsByCallId = new Map<string, V2ContentOrigin[]>()
        const removedCallIdSet = new Set<string>()

        for (const entry of sourceEntries) {
            for (const origin of entry.origins) {
                if (!origin.callId) continue
                const origins = originsByCallId.get(origin.callId) ?? []
                origins.push(origin)
                originsByCallId.set(origin.callId, origins)
            }
        }

        const markCurrentContentRemoved = (pointer: V2OutgoingPointer): void => {
            if (pointer.contentIndex === undefined) return
            const currentPointer = currentPointerForProjection(
                projection,
                currentMessages,
                pointer,
                currentIndexes,
                appliedOutput ? appliedState : undefined,
                currentByOriginal,
            )
            const currentMessage = currentMessages[currentPointer.messageIndex]
            if (!currentMessage || currentPointer.contentIndex === undefined) return
            const currentPart = aiContent(currentMessage)[currentPointer.contentIndex]
            if (!currentPart) return
            removedCurrentContent.add(
                `${currentPointer.messageIndex}:${currentPointer.contentIndex}`,
            )
        }

        for (const entry of sourceEntries) {
            const normalizedId = entry.normalizedMessageId!
            for (const callID of entry.toolCallIds) mappedCallIds.add(callID)
            const transformedMessage = transformedMap.get(normalizedId)
            if (!transformedMessage) {
                if (entry.outgoingMessageIndices.length === 0) continue
                if (!entry.allowSourceRemoval || (entry.opaque && entry.providerCheckpoint)) {
                    return reject(
                        "opaque-origin",
                        `Cannot remove opaque source message ${entry.sourceMessageId ?? normalizedId}`,
                    )
                }
                if (
                    !appliedOutput &&
                    !sourceRemovalHasExactCorrelation(projection, entry, currentMessages)
                ) {
                    return reject(
                        entry.opaque ? "opaque-origin" : "fingerprint-mismatch",
                        `Cannot remove source message ${entry.sourceMessageId ?? normalizedId} without an exact lowered correlation`,
                    )
                }
                for (const originalIndex of entry.outgoingMessageIndices) {
                    const currentIndex = currentByOriginal.get(originalIndex)
                    if (currentIndex !== undefined) removedMessages.add(currentIndex)
                }
                removedMessageIds.push(entry.sourceMessageId ?? normalizedId)
                removedMessageIdSet.add(entry.sourceMessageId ?? normalizedId)
                for (const origin of entry.origins) {
                    removeContentPointers(removedContent, origin.outgoing)
                    for (const pointer of origin.outgoing) markCurrentContentRemoved(pointer)
                    for (const part of originalPartsForOrigin(projection, origin)) {
                        removedContentParts.add(part)
                    }
                }
                for (const callID of entry.toolCallIds) {
                    removedCallIds.push(callID)
                    removedCallIdSet.add(callID)
                }
                continue
            }
            if (appliedOutput && appliedState?.removedMessageIds.has(normalizedId)) {
                return reject(
                    "fingerprint-mismatch",
                    `Cannot restore source message ${normalizedId} without a new lowered correlation`,
                )
            }

            const originalNormalized = projectionMessagesById.get(normalizedId)
            if (
                originalNormalized &&
                isRecord(originalNormalized.info) &&
                isRecord(transformedMessage.info) &&
                originalNormalized.info.role !== transformedMessage.info.role
            ) {
                return reject(
                    "ambiguous-origin",
                    `Role changed for normalized message ${normalizedId}`,
                )
            }
            const originalPartsByOrigin = new Map<string, V2ContentOrigin>()
            for (const origin of entry.origins) originalPartsByOrigin.set(origin.key, origin)
            const transformedPartsResult = transformedPartsByOrigin(transformedMessage)
            if ("accepted" in transformedPartsResult) return transformedPartsResult
            const transformedParts = transformedPartsResult
            for (const origin of entry.origins) {
                const transformedPart = transformedParts.get(origin.key)
                if (
                    transformedPart &&
                    appliedOutput &&
                    origin.outgoing.some((pointer) => {
                        const key = pointerKey(pointer)
                        return key !== undefined && appliedState?.removed.has(key) === true
                    })
                ) {
                    return reject(
                        "fingerprint-mismatch",
                        `Cannot restore removed content origin ${origin.key} without a new lowered correlation`,
                    )
                }
                if (!transformedPart) {
                    if (origin.kind === "tool" && origin.callId) {
                        removeContentPointers(removedContent, origin.outgoing)
                        for (const pointer of origin.outgoing) markCurrentContentRemoved(pointer)
                        for (const part of originalPartsForOrigin(projection, origin)) {
                            removedContentParts.add(part)
                        }
                        removedCallIds.push(origin.callId)
                        removedCallIdSet.add(origin.callId)
                        continue
                    }
                    if (origin.opaque) {
                        return reject("opaque-origin", `Opaque origin ${origin.key} was removed`)
                    }
                    removeContentPointers(removedContent, origin.outgoing)
                    for (const pointer of origin.outgoing) markCurrentContentRemoved(pointer)
                    for (const part of originalPartsForOrigin(projection, origin)) {
                        removedContentParts.add(part)
                    }
                    continue
                }
                if (origin.kind === "tool") {
                    const transformedValue: unknown = transformedPart
                    const transformedTool = isRecord(transformedValue)
                        ? stringValue(transformedValue.tool)
                        : undefined
                    const transformedCallID = isRecord(transformedValue)
                        ? stringValue(transformedValue.callID)
                        : undefined
                    if (
                        transformedTool !== origin.normalizedToolName ||
                        transformedCallID !== origin.callId
                    ) {
                        return reject(
                            "ambiguous-origin",
                            `Tool ${origin.callId ?? "unknown"} identity changed`,
                        )
                    }
                    const status = stateStatus(transformedPart)
                    if (!status) {
                        return reject(
                            "unknown-origin",
                            `Tool ${origin.callId ?? "unknown"} has no valid state`,
                        )
                    }
                    if (
                        status !==
                        stateStatus(
                            projectionPartsByMessageId.get(normalizedId)?.get(origin.key) ??
                                transformedPart,
                        )
                    ) {
                        // A status transition changes whether lowering emits a
                        // result. ACP cannot synthesize provider state safely.
                        return reject(
                            "ambiguous-origin",
                            `Tool ${origin.callId ?? "unknown"} changed state`,
                        )
                    }
                    const input = stateInput(transformedPart)
                    if (origin.normalizedInputHash === undefined) {
                        return reject(
                            "unknown-origin",
                            `Tool ${origin.callId ?? "unknown"} has no bounded input fingerprint`,
                        )
                    }
                    const inputMatches = hash(input) === origin.normalizedInputHash
                    if (!inputMatches && !origin.call) {
                        return reject(
                            "ambiguous-origin",
                            `Tool ${origin.callId ?? "unknown"} has no lowered call`,
                        )
                    }
                    if (origin.call && !inputMatches) {
                        setContentPart(
                            currentMessages,
                            replacements,
                            currentPointerForProjection(
                                projection,
                                currentMessages,
                                origin.call,
                                currentIndexes,
                                appliedOutput ? appliedState : undefined,
                                currentByOriginal,
                            ),
                            {
                                input: isRecord(input) ? input : {},
                            },
                        )
                        editedCallIds.add(origin.callId ?? "")
                    }
                    const output = stateOutput(transformedPart)
                    if (
                        origin.normalizedOutput !== undefined &&
                        output !== origin.normalizedOutput
                    ) {
                        if (!origin.result || !origin.representableOutput) {
                            return reject(
                                "opaque-origin",
                                `Tool result ${origin.callId ?? "unknown"} is opaque`,
                            )
                        }
                        const resultPointer = currentPointerForProjection(
                            projection,
                            currentMessages,
                            origin.result,
                            currentIndexes,
                            appliedOutput ? appliedState : undefined,
                            currentByOriginal,
                        )
                        const resultMessage =
                            replacements.get(resultPointer.messageIndex) ??
                            currentMessages[resultPointer.messageIndex]
                        const resultPart =
                            resultPointer.contentIndex === undefined
                                ? undefined
                                : aiContent(resultMessage)[resultPointer.contentIndex]
                        const resultValue =
                            resultPart === undefined
                                ? undefined
                                : (resultPart as unknown as Record<string, unknown>).result
                        if (!isRecord(resultValue)) {
                            return reject(
                                "opaque-origin",
                                `Tool result ${origin.callId ?? "unknown"} is unavailable`,
                            )
                        }
                        setContentPart(currentMessages, replacements, resultPointer, {
                            result: { ...resultValue, value: output ?? "" },
                        })
                        editedCallIds.add(origin.callId ?? "")
                    }
                    const transformedError = stringValue(
                        transformedPartState(transformedPart)?.error,
                    )
                    if (
                        origin.normalizedError !== undefined &&
                        transformedError !== origin.normalizedError
                    ) {
                        return reject(
                            "opaque-origin",
                            `Tool error ${origin.callId ?? "unknown"} is opaque`,
                        )
                    }
                    continue
                }
                const transformedText = contentText(transformedPart)
                if (transformedText === undefined) {
                    return reject("unknown-origin", `Origin ${origin.key} no longer has text`)
                }
                if (origin.opaque) {
                    if (transformedText !== origin.normalizedText) {
                        return reject("opaque-origin", `Opaque origin ${origin.key} was changed`)
                    }
                    continue
                }
                if (transformedText === origin.normalizedText) continue
                if (origin.outgoing.length !== 1 || origin.outgoing[0].contentIndex === undefined) {
                    return reject(
                        "ambiguous-origin",
                        `Text origin ${origin.key} has no unique lowered part`,
                    )
                }
                setContentPart(
                    currentMessages,
                    replacements,
                    currentPointerForProjection(
                        projection,
                        currentMessages,
                        origin.outgoing[0],
                        currentIndexes,
                        appliedOutput ? appliedState : undefined,
                        currentByOriginal,
                    ),
                    { text: transformedText },
                )
                editedMessageIds.add(normalizedId)
            }

            // ACP nudge/id parts are deliberately not source origins. They may
            // be inserted into a known message as ACP-owned text with a stable
            // part ID so exact replay remains idempotent.
            const sourceOriginKeys = new Set(originalPartsByOrigin.keys())
            for (const part of transformedMessage.parts ?? []) {
                const key = projectionMarker(part)
                if (key && sourceOriginKeys.has(key)) continue
                if (part.type === "step-start" || part.type === "step-finish") continue
                if (
                    part.type !== "text" ||
                    !stringValue(part.text) ||
                    !isAcpAuthoredPartId(stringValue(part.id))
                ) {
                    return reject(
                        "unknown-origin",
                        `Transformed part in ${normalizedId} has no provenance`,
                    )
                }
                if (entry.opaque) continue
                const target = entry.outgoingMessageIndices
                    .map((index) => currentByOriginal.get(index))
                    .find(
                        (index): index is number =>
                            index !== undefined && !removedMessages.has(index),
                    )
                if (target === undefined)
                    return reject("invalid-insertion", `No target for ACP part ${part.id}`)
                const targetMessage = replacements.get(target) ?? currentMessages[target]
                if (!targetMessage)
                    return reject("invalid-insertion", `No target for ACP part ${part.id}`)
                const content = [...aiContent(targetMessage)] as AiContentPart[]
                const existingPartIndexById = new Map<string, number>()
                for (let contentIndex = 0; contentIndex < content.length; contentIndex++) {
                    const existingId = contentId(content[contentIndex])
                    if (existingId) existingPartIndexById.set(existingId, contentIndex)
                }
                const insertedPartId = stringValue(part.id)
                const existingPartIndex = insertedPartId
                    ? existingPartIndexById.get(insertedPartId)
                    : undefined
                if (existingPartIndex !== undefined) {
                    const existingPart = content[existingPartIndex]
                    if (contentType(existingPart) !== "text") {
                        return reject(
                            "invalid-insertion",
                            `ACP part ${part.id} collides with non-text content`,
                        )
                    }
                    if (contentText(existingPart) === part.text) continue
                    content[existingPartIndex] = {
                        ...existingPart,
                        text: part.text,
                    } as AiContentPart
                    replacements.set(target, cloneAiMessage(targetMessage, content))
                    editedMessageIds.add(normalizedId)
                    continue
                }
                let insertionIndex = content.length
                if (aiRole(targetMessage) === "assistant") {
                    const firstTool = entry.origins
                        .filter((origin) => origin.kind === "tool" && origin.call !== undefined)
                        .map(
                            (origin) =>
                                currentPointerForProjection(
                                    projection,
                                    currentMessages,
                                    origin.call!,
                                    currentIndexes,
                                    appliedOutput ? appliedState : undefined,
                                    currentByOriginal,
                                ).contentIndex,
                        )
                        .filter((index): index is number => index !== undefined)
                        .sort((left, right) => left - right)[0]
                    if (firstTool !== undefined) insertionIndex = firstTool
                }
                content.splice(insertionIndex, 0, {
                    type: "text",
                    text: part.text,
                    id: insertedPartId,
                } as AiContentPart)
                replacements.set(target, cloneAiMessage(targetMessage, content))
                editedMessageIds.add(normalizedId)
            }
        }

        const retainedIds = new Set<string>()
        for (const entry of sourceEntries) {
            if (transformedMap.has(entry.normalizedMessageId!))
                retainedIds.add(entry.normalizedMessageId!)
        }
        const sourceOrderError = sourceOrderIsMonotonic(
            projection,
            sourceEntries.filter((entry) => retainedIds.has(entry.normalizedMessageId!)),
        )
        if (sourceOrderError) return sourceOrderError

        const insertionBoundaries = buildNearestRetainedBoundaries(
            projection,
            transformed,
            retainedIds,
            currentByOriginal,
            removedMessages,
            entriesById,
        )
        const insertions: Array<{ index: number; message: AiMessageValue; order: number }> = []
        for (let transformedIndex = 0; transformedIndex < transformed.length; transformedIndex++) {
            const message = transformed[transformedIndex]
            const id = transformedMessageId(message)
            if (!id || knownSourceIds.has(id)) continue
            const inserted = makeInsertedMessage(message)
            if ("accepted" in inserted) {
                // Internal-only helper messages must not reach the patch layer.
                if (
                    message.parts.every(
                        (part) => part.type === "step-start" || part.type === "step-finish",
                    )
                ) {
                    continue
                }
                return inserted
            }
            const existingIndex = currentIndexes.byId.get(id)
            if (existingIndex !== undefined) {
                const originalIndex = currentToOriginal.get(existingIndex)
                const existingOwner =
                    originalIndex === undefined ? undefined : projection.outgoing[originalIndex]
                if (!existingOwner?.owned && !isAcpOwnedId(id)) {
                    return reject(
                        "invalid-insertion",
                        `ACP insertion ID ${id} collides with host content`,
                    )
                }
                replacements.set(existingIndex, inserted)
                editedMessageIds.add(id)
                continue
            }
            const index = nearestInsertionIndex(
                transformedIndex,
                currentMessages.length,
                insertionBoundaries.before,
                insertionBoundaries.after,
            )
            insertions.push({ index, message: inserted, order: transformedIndex })
        }

        for (const [messageIndex, message] of replacements) {
            if (removedMessages.has(messageIndex)) continue
            // In a repeated patch an ACP insertion can occupy an index that
            // belonged to a host message in the original lowered array after
            // an earlier source removal. It is still safe to replace that
            // position because the insertion ID is ACP-owned.
            if (isAcpOwnedId(aiMessageId(message))) continue
            const originalIndex = currentToOriginal.get(messageIndex)
            const opaqueOrigin =
                originalIndex === undefined ? undefined : projection.outgoing[originalIndex]
            if (
                opaqueOrigin?.opaqueMessage !== undefined &&
                message !== opaqueOrigin.opaqueMessage
            ) {
                return reject("opaque-origin", "A replacement changed provider-owned content")
            }
            for (const [contentIndex, originalPart] of opaqueOrigin?.opaqueContent ?? []) {
                const candidate = aiContent(message)[contentIndex]
                if (!candidate || candidate !== originalPart) {
                    return reject("opaque-origin", "A replacement changed provider-owned content")
                }
            }
        }

        // Remove content only after all source comparisons have succeeded. A
        // call and its role=tool result are always removed together.
        for (const callID of removedCallIdSet) {
            const pointers = originsByCallId.get(callID)?.flatMap((origin) => origin.outgoing) ?? []
            removeContentPointers(removedContent, pointers)
            for (const pointer of pointers) markCurrentContentRemoved(pointer)
        }
        const removedCurrentMessageIndices = new Set<number>()
        for (const key of removedCurrentContent) {
            const separator = key.indexOf(":")
            const messageIndex = Number.parseInt(key.slice(0, separator), 10)
            if (Number.isInteger(messageIndex)) removedCurrentMessageIndices.add(messageIndex)
        }
        for (const [messageIndex, message] of currentMessages.entries()) {
            const messageID = aiMessageId(message)
            if (
                removedMessages.has(messageIndex) ||
                (messageID && removedMessageIdSet.has(messageID))
            )
                continue
            const baseMessage = replacements.get(messageIndex) ?? message
            const content = aiContent(baseMessage)
            const kept = content.filter(
                (part, contentIndex) =>
                    !removedContentParts.has(part) &&
                    !removedCurrentContent.has(`${messageIndex}:${contentIndex}`),
            )
            if (kept.length !== content.length)
                replacements.set(messageIndex, cloneAiMessage(baseMessage, kept))
        }

        const finalMessages: AiMessageValue[] = []
        const insertionByIndex = new Map<
            number,
            Array<{ message: AiMessageValue; order: number }>
        >()
        for (const insertion of insertions) {
            const list = insertionByIndex.get(insertion.index) ?? []
            list.push({ message: insertion.message, order: insertion.order })
            insertionByIndex.set(insertion.index, list)
        }
        for (const [index, list] of insertionByIndex) {
            if (index === 0) {
                list.sort((left, right) => left.order - right.order)
            }
        }
        const appendAt = (index: number) => {
            const pending = insertionByIndex.get(index)
            if (!pending) return
            pending.sort((left, right) => left.order - right.order)
            finalMessages.push(...pending.map((entry) => entry.message))
        }
        appendAt(0)
        for (let index = 0; index < currentMessages.length; index++) {
            if (!removedMessages.has(index)) {
                const message = replacements.get(index) ?? currentMessages[index]
                const hadRemovedContent =
                    removedCurrentMessageIndices.has(index) ||
                    aiContent(message).some((part) => removedContentParts.has(part))
                // Empty uncorrelated host messages are outside ACP ownership and
                // must survive. A mapped message emptied by an explicit ACP
                // call/content removal can be omitted safely.
                if (aiContent(message).length > 0 || !hadRemovedContent) finalMessages.push(message)
            }
            appendAt(index + 1)
        }

        // Every ACP-authored outgoing message is either a replacement (an ACP edit
        // of a host message, or an insertion occupying an existing slot) or a fresh
        // insertion. Provider messages ACP never touched stay put and are excluded
        // on purpose so validateFinalMessages skips their nominal re-validation
        // (see issue #455).
        const authoredMessages = new Set<object>([
            ...replacements.values(),
            ...insertions.map((entry) => entry.message),
        ])
        const finalError = validateFinalMessages(
            finalMessages,
            mappedCallIds,
            new Set(removedCallIds),
            authoredMessages,
        )
        if (finalError) return finalError
        const previousApplied = appliedPatchStates.get(projection)
        const finalIndexes = buildMessageIndexes(finalMessages)
        const finalIndexByCurrent = new Map<number, number>()
        for (let currentIndex = 0; currentIndex < currentMessages.length; currentIndex++) {
            if (removedMessages.has(currentIndex)) continue
            const currentMessage = replacements.get(currentIndex) ?? currentMessages[currentIndex]
            if (!currentMessage) continue
            const finalIndex = finalIndexes.byObject.get(currentMessage as object)
            if (finalIndex !== undefined) finalIndexByCurrent.set(currentIndex, finalIndex)
        }
        const opaqueOutputParts = new Set<object>()
        for (const origin of projection.outgoing) {
            if (origin.opaqueMessage !== undefined) {
                for (const part of aiContent(origin.opaqueMessage)) {
                    opaqueOutputParts.add(part as object)
                }
            }
            for (const part of origin.opaqueContent?.values() ?? []) {
                opaqueOutputParts.add(part as object)
            }
        }
        const nextApplied: AppliedPatchState = {
            parts: new Map(),
            locations: new Map(),
            removed: new Set(previousApplied?.removed),
            removedMessageIds: new Set(previousApplied?.removedMessageIds),
            opaqueMessages: new Set(previousApplied?.opaqueMessages),
            output: [],
        }
        for (const messageID of removedMessageIds) nextApplied.removedMessageIds.add(messageID)
        for (const entry of projection.entries) {
            for (const origin of entry.origins) {
                for (const reference of origin.originalContent ?? []) {
                    const key = pointerKey(reference.pointer)
                    if (key === undefined) continue
                    if (
                        removedContent.has(key) ||
                        removedMessages.has(
                            currentByOriginal.get(reference.pointer.messageIndex) ?? -1,
                        ) ||
                        (origin.kind === "tool" &&
                            origin.callId !== undefined &&
                            removedCallIdSet.has(origin.callId))
                    ) {
                        nextApplied.removed.add(key)
                        nextApplied.parts.delete(key)
                        nextApplied.locations.delete(key)
                        continue
                    }
                    const part = finalPartForReference(
                        projection,
                        finalMessages,
                        reference,
                        finalIndexes,
                        previousApplied,
                        finalIndexByCurrent,
                        currentIndexes,
                        currentByOriginal,
                    )
                    if (part !== undefined) {
                        const location = locateAppliedPart(finalMessages, part, finalIndexes)
                        if (location) {
                            nextApplied.parts.set(key, part)
                            nextApplied.locations.set(key, location)
                        }
                    }
                }
            }
        }
        for (const origin of projection.outgoing) {
            if (origin.opaqueMessage !== undefined) {
                nextApplied.opaqueMessages.add(origin.opaqueMessage as object)
            }
            for (const [contentIndex, part] of origin.opaqueContent ?? []) {
                const key = `${origin.messageIndex}:${contentIndex}`
                if (nextApplied.removed.has(key)) continue
                const location = locateAppliedPart(finalMessages, part, finalIndexes)
                if (location) {
                    nextApplied.parts.set(key, part)
                    nextApplied.locations.set(key, location)
                }
            }
        }
        nextApplied.output = snapshotAppliedOutput(finalMessages, opaqueOutputParts)
        appliedPatchStates.set(projection, nextApplied)
        return {
            accepted: true,
            ok: true,
            messages: finalMessages,
            patch: {
                removedMessageIds,
                removedCallIds: [...new Set(removedCallIds)],
                editedMessageIds: [...editedMessageIds].filter(Boolean),
                editedCallIds: [...editedCallIds].filter(Boolean),
                insertedMessageIds: insertions.map((entry) => aiMessageId(entry.message) ?? ""),
            },
        }
    } catch (error) {
        return reject(
            "invalid-schema",
            `V2 context patch failed closed: ${error instanceof Error ? error.message : String(error)}`,
        )
    }
}

/** Alias used by callers that describe the operation as patch derivation. */
export const deriveV2ContextPatch = applyV2ContextPatch
export const patchV2Messages = applyV2ContextPatch
