import type { ContentPart as AiContentPart, Message as AiMessageValue } from "@opencode/ai"
import type { WithParts } from "../../state"
import type {
    Draft,
    InternalInfo,
    Part,
    PointerKey,
    SourceRecord,
    V2Projection,
    V2ProjectionOptions,
    V2ProjectionRejection,
    V2ProvenanceEntry,
    V2OutgoingProvenance,
    V2OutgoingPointer,
    V2ProjectionSourceType,
} from "./types"
import * as shared from "./shared"

const {
    aiContent,
    aiToolCallPointer,
    aiToolResultPointer,
    aiMessageId,
    aiRole,
    attachmentLocation,
    attachmentMatches,
    addPointer,
    addReasoningOrigin,
    addTextOrigin,
    isAcpOwnedId,
    isRecord,
    contentCallId,
    contentResultId,
    contentText,
    contentType,
    fingerprintOutgoing,
    fingerprintProjection,
    fingerprintSources,
    hash,
    internalPart,
    internalStepPart,
    internalTextPart,
    makeAssistantInfo,
    makeUserInfo,
    modelForSource,
    newOrigin,
    pointerForText,
    resultIsRepresentable,
    sourceRecord,
    sourceId,
    sourceTime,
    stringValue,
    lowerAttachmentText,
    lowerCompactionText,
    lowerLocationText,
    lowerShellText,
    parseToolInput,
    toolState,
} = shared

function sourceType(type: string): V2ProjectionSourceType {
    switch (type) {
        case "user":
        case "assistant":
        case "synthetic":
        case "system":
        case "skill":
        case "shell":
        case "location-switched":
        case "compaction":
        case "agent-switched":
        case "model-switched":
        case "idle":
            return type
        default:
            return "control"
    }
}

function isControlSource(type: string): boolean {
    return type === "agent-switched" || type === "model-switched" || type === "idle"
}

function isCompactionWithoutOutput(source: SourceRecord): boolean {
    return source.type === "compaction" && source.status !== "completed"
}

function expectedSourceMessage(source: SourceRecord): boolean {
    return !isControlSource(source.type) && !isCompactionWithoutOutput(source)
}

function outgoingById(
    id: string | undefined,
    indicesById: ReadonlyMap<string, readonly number[]>,
    claimed: Set<number>,
): number | undefined {
    if (!id) return undefined
    for (const index of indicesById.get(id) ?? []) {
        if (claimed.has(index)) continue
        claimed.add(index)
        return index
    }
    return undefined
}

function outgoingSystem(
    text: string,
    indicesByText: ReadonlyMap<string, readonly number[]>,
    claimed: Set<number>,
): number | undefined {
    for (const index of indicesByText.get(text) ?? []) {
        if (claimed.has(index)) continue
        claimed.add(index)
        return index
    }
    return undefined
}

function messageInfoForSource(
    draft: Draft,
    sessionID: string,
    options: V2ProjectionOptions,
): InternalInfo {
    const source = draft.source
    const id = draft.normalizedMessageId ?? `v2-source-${draft.sourceIndex}`
    if (draft.sourceType === "assistant" || draft.sourceType === "provider-checkpoint") {
        const info = makeAssistantInfo(source, id, sessionID, options)
        if (draft.providerCheckpoint) {
            const mutableInfo = info as unknown as Record<string, unknown>
            mutableInfo.summary = true
        }
        return info
    }
    if (draft.sourceType === "system") {
        return makeAssistantInfo(source, id, sessionID, options)
    }
    if (draft.sourceType === "compaction") {
        const info = makeAssistantInfo(source, id, sessionID, options)
        const mutable = info as unknown as Record<string, unknown>
        mutable.summary = true
        return info
    }
    const info = makeUserInfo(source, id, sessionID, options)
    return info
}

function sourceOutputIndex(draft: Draft): number | undefined {
    return draft.outgoingMessageIndices.find((index) => index >= 0)
}

function sourceOutputMessageIndices(draft: Draft): number[] {
    return [...new Set(draft.outgoingMessageIndices)].sort((left, right) => left - right)
}

function buildProviderCheckpoint(
    draft: Draft,
    sessionID: string,
    options: V2ProjectionOptions,
    messages: readonly AiMessageValue[],
): void {
    if (!draft.normalizedMessageId) return
    const parts: Part[] = []
    let sequence = 0
    for (const messageIndex of draft.outgoingMessageIndices) {
        const message = messages[messageIndex]
        const rendered = aiContent(message)
            .map((part) => {
                if (contentType(part) === "text") return contentText(part) ?? ""
                if (contentType(part) === "reasoning") return contentText(part) ?? ""
                if (contentType(part) === "tool-call") {
                    return `[tool call ${contentCallId(part) ?? "unknown"}]`
                }
                if (contentType(part) === "tool-result")
                    return `[tool result ${contentResultId(part) ?? "unknown"}]`
                if (contentType(part) === "media") return "[media attachment]"
                return `[${contentType(part) ?? "provider content"}]`
            })
            .join("\n")
        const key = `source:${draft.sourceIndex}:checkpoint:${sequence++}`
        const origin = newOrigin(draft, key, "text", true)
        origin.normalizedText = rendered
        for (let contentIndex = 0; contentIndex < aiContent(message).length; contentIndex++) {
            addPointer(origin, { messageIndex, contentIndex }, messages)
        }
        draft.origins.push(origin)
        parts.push(internalTextPart(sessionID, draft.normalizedMessageId, key, rendered, true))
    }
    draft.normalized = {
        info: messageInfoForSource(draft, sessionID, options),
        parts,
    }
}

function buildNormalizedSource(
    draft: Draft,
    sessionID: string,
    options: V2ProjectionOptions,
    messages: readonly AiMessageValue[],
): void {
    if (!draft.normalizedMessageId) return
    if (draft.providerCheckpoint) {
        buildProviderCheckpoint(draft, sessionID, options, messages)
        return
    }

    const source = draft.source
    const info = messageInfoForSource(draft, sessionID, options)
    const parts: Part[] = []
    const outputIndex = sourceOutputIndex(draft)
    const cursors = new Map<number, number>()
    const claimedContent = new Set<PointerKey>()
    let sequence = 0

    const textPart = (text: string, opaque: boolean): Part => {
        const pointer = pointerForText(outputIndex, text, messages, cursors, claimedContent)
        return addTextOrigin(
            draft,
            text,
            opaque,
            pointer ? [pointer] : [],
            sequence++,
            sessionID,
            messages,
        )
    }

    switch (source.type) {
        case "user": {
            const files = Array.isArray(source.files) ? source.files : []
            // Reserve all lowering-derived attachment content before matching
            // ordinary user/skill text. Otherwise a user sentence identical to
            // `Attached file: ...` could steal an opaque media origin.
            const attachmentPointers = new Map<number, V2OutgoingPointer[]>()
            if (outputIndex !== undefined) {
                const outputParts = aiContent(messages[outputIndex])
                files.forEach((fileValue, fileIndex) => {
                    if (!isRecord(fileValue)) return
                    const pointers: V2OutgoingPointer[] = []
                    for (let contentIndex = 0; contentIndex < outputParts.length; contentIndex++) {
                        const pointerKey = `${outputIndex}:${contentIndex}`
                        if (
                            claimedContent.has(pointerKey) ||
                            !attachmentMatches(outputParts[contentIndex], fileValue)
                        ) {
                            continue
                        }
                        claimedContent.add(pointerKey)
                        pointers.push({ messageIndex: outputIndex, contentIndex })
                    }
                    const location = attachmentLocation(fileValue)
                    if (
                        location &&
                        ((stringValue(fileValue.mime) ?? "").startsWith("image/") ||
                            fileValue.mime === "application/pdf")
                    ) {
                        const locationText = `Attached file: ${location}`
                        for (
                            let contentIndex = 0;
                            contentIndex < outputParts.length;
                            contentIndex++
                        ) {
                            const pointerKey = `${outputIndex}:${contentIndex}`
                            if (
                                claimedContent.has(pointerKey) ||
                                contentType(outputParts[contentIndex]) !== "text" ||
                                contentText(outputParts[contentIndex]) !== locationText
                            ) {
                                continue
                            }
                            claimedContent.add(pointerKey)
                            pointers.push({ messageIndex: outputIndex, contentIndex })
                            break
                        }
                    }
                    attachmentPointers.set(fileIndex, pointers)
                })
            }
            const skills = Array.isArray(source.skills) ? source.skills : []
            for (const skill of skills) {
                if (!isRecord(skill) || typeof skill.text !== "string") continue
                parts.push(textPart(skill.text, false))
            }
            const text = stringValue(source.text) ?? ""
            if (text !== "") parts.push(textPart(text, false))
            files.forEach((fileValue, fileIndex) => {
                if (!isRecord(fileValue)) return
                const pointers = attachmentPointers.get(fileIndex) ?? []
                const attachment = addTextOrigin(
                    draft,
                    lowerAttachmentText(fileValue),
                    true,
                    pointers,
                    sequence++,
                    sessionID,
                    messages,
                )
                const origin = draft.origins[draft.origins.length - 1]
                origin.kind = "attachment"
                parts.push(attachment)
            })
            break
        }
        case "skill":
            parts.push(textPart(stringValue(source.text) ?? "", false))
            break
        case "synthetic":
            parts.push(textPart(stringValue(source.text) ?? "", !draft.owned))
            break
        case "system":
            parts.push(textPart(stringValue(source.text) ?? "", true))
            break
        case "shell":
            if (isRecord(source.metadata) && source.metadata.background === true) break
            parts.push(textPart(lowerShellText(source), true))
            break
        case "location-switched":
            parts.push(textPart(lowerLocationText(source), true))
            break
        case "compaction":
            parts.push(textPart(lowerCompactionText(source), true))
            break
        case "assistant": {
            parts.push(internalStepPart(sessionID, draft.normalizedMessageId, draft.sourceIndex))
            const content = Array.isArray(source.content) ? source.content : []
            const usedPointers = new Set<PointerKey>()
            for (const itemValue of content) {
                if (!isRecord(itemValue)) continue
                if (itemValue.type === "text") {
                    const text = stringValue(itemValue.text) ?? ""
                    if (text === "") continue
                    const pointer = pointerForText(
                        outputIndex,
                        text,
                        messages,
                        cursors,
                        claimedContent,
                    )
                    const key = `source:${draft.sourceIndex}:part:${sequence++}`
                    const origin = newOrigin(draft, key, "text", false)
                    origin.normalizedText = text
                    if (pointer) addPointer(origin, pointer, messages)
                    draft.origins.push(origin)
                    parts.push(
                        internalTextPart(sessionID, draft.normalizedMessageId, key, text, false),
                    )
                    continue
                }
                if (itemValue.type === "reasoning") {
                    const text = stringValue(itemValue.text) ?? ""
                    if (text === "") continue
                    const pointer = pointerForText(
                        outputIndex,
                        text,
                        messages,
                        cursors,
                        claimedContent,
                        ["text", "reasoning"],
                    )
                    parts.push(
                        addReasoningOrigin(
                            draft,
                            text,
                            pointer ? [pointer] : [],
                            sequence++,
                            sessionID,
                            messages,
                        ),
                    )
                    continue
                }
                if (itemValue.type !== "tool") continue
                const callID = stringValue(itemValue.id)
                const name = stringValue(itemValue.name) ?? "tool"
                if (!callID) {
                    draft.opaque = true
                    draft.protected = true
                    draft.allowSourceRemoval = false
                    continue
                }
                draft.toolCallIds.push(callID)
                const call = aiToolCallPointer(
                    draft.outgoingMessageIndices,
                    callID,
                    messages,
                    usedPointers,
                )
                const result = aiToolResultPointer(
                    draft.outgoingMessageIndices,
                    callID,
                    messages,
                    usedPointers,
                    itemValue.executed !== true,
                )
                const normalizedTool = toolState(itemValue)
                const key = `source:${draft.sourceIndex}:part:${sequence++}`
                const origin = newOrigin(draft, key, "tool", normalizedTool.opaqueResult)
                origin.callId = callID
                origin.normalizedToolName = name
                origin.call = call
                origin.result = result
                origin.representableInput = call !== undefined
                origin.representableOutput = resultIsRepresentable(result, messages)
                if (normalizedTool.output !== undefined)
                    origin.normalizedOutput = normalizedTool.output
                if (normalizedTool.error !== undefined)
                    origin.normalizedError = normalizedTool.error
                // Keep only a bounded fingerprint for potentially large tool
                // inputs; the raw input remains available in the normalized
                // working part when a representable edit is required.
                origin.normalizedInputHash = hash(normalizedTool.state.input)
                if (call) addPointer(origin, call, messages)
                if (result) addPointer(origin, result, messages)
                draft.origins.push(origin)
                parts.push(
                    internalPart({
                        id: `v2-part-${hash(key).slice(0, 16)}`,
                        sessionID,
                        messageID: draft.normalizedMessageId,
                        type: "tool",
                        callID,
                        tool: name,
                        state: normalizedTool.state,
                        __acpOrigin: key,
                        __acpOpaque: normalizedTool.opaqueResult,
                    }),
                )
            }
            break
        }
        default:
            parts.push(textPart(String(source.text ?? source.type), true))
            draft.opaque = true
            draft.protected = true
            break
    }

    // Match OpenCode lowering for empty user/background-shell messages: no
    // provider message is emitted, so they must not create a phantom ACP turn.
    draft.normalized = parts.length > 0 ? { info, parts } : undefined
}

function makeDraft(source: SourceRecord, sourceIndex: number, options: V2ProjectionOptions): Draft {
    const type = sourceType(source.type)
    const sourceMessageId = sourceId(source, sourceIndex)
    const owned = type === "synthetic" && isAcpOwnedId(sourceMessageId)
    const providerCheckpoint =
        type === "compaction" && source.status === "completed" && isRecord(source.providerContext)
    const opaque =
        type === "system" ||
        type === "shell" ||
        type === "location-switched" ||
        type === "compaction" ||
        (type === "synthetic" && !owned) ||
        providerCheckpoint
    return {
        source,
        sourceIndex,
        sourceType: providerCheckpoint ? "provider-checkpoint" : owned ? "acp-synthetic" : type,
        sourceMessageId,
        normalizedMessageId:
            expectedSourceMessage(source) && sourceMessageId ? sourceMessageId : undefined,
        status: stringValue(source.status),
        outgoingMessageIndices: [],
        origins: [],
        toolCallIds: [],
        opaque,
        protected: opaque,
        allowSourceRemoval:
            owned ||
            type === "user" ||
            type === "assistant" ||
            type === "skill" ||
            type === "shell" ||
            type === "location-switched",
        providerCheckpoint,
        owned,
    }
}

function claimCheckpointRanges(
    drafts: Draft[],
    messages: readonly AiMessageValue[],
    claimed: Set<number>,
): void {
    const checkpoints = drafts.filter((draft) => draft.providerCheckpoint)
    for (const checkpoint of checkpoints) {
        const previous = drafts
            .filter((draft) => draft.sourceIndex < checkpoint.sourceIndex)
            .flatMap((draft) => draft.outgoingMessageIndices)
            .filter((index) => index >= 0)
            .sort((left, right) => right - left)[0]
        const next = drafts
            .filter((draft) => draft.sourceIndex > checkpoint.sourceIndex)
            .flatMap((draft) => draft.outgoingMessageIndices)
            .filter((index) => index >= 0)
            .sort((left, right) => left - right)[0]
        const start = previous === undefined ? 0 : previous + 1
        const end = next === undefined ? messages.length : next
        for (let index = start; index < end; index++) {
            if (!claimed.has(index)) {
                claimed.add(index)
                checkpoint.outgoingMessageIndices.push(index)
            }
        }
    }
}

function sourceOutputMessageRoleIsValid(
    draft: Draft,
    messages: readonly AiMessageValue[],
): boolean {
    if (draft.outgoingMessageIndices.length === 0) return true
    if (draft.providerCheckpoint) return true
    const first = messages[draft.outgoingMessageIndices[0]]
    if (draft.source.type === "assistant") return aiRole(first) === "assistant"
    if (draft.source.type === "system") return aiRole(first) === "system"
    return aiRole(first) === "user"
}

function loweredToolCorrelationIsExact(
    origin: V2ProvenanceEntry["origins"][number],
    outgoing: readonly AiMessageValue[],
): boolean {
    if (origin.kind !== "tool" || origin.opaque) return true
    if (origin.normalizedInputHash !== undefined) {
        if (!origin.call || origin.call.contentIndex === undefined) return false
        const callPart = aiContent(outgoing[origin.call.messageIndex])[origin.call.contentIndex]
        const callInput = isRecord(callPart)
            ? (callPart as unknown as Record<string, unknown>).input
            : undefined
        if (hash(callInput) !== origin.normalizedInputHash) return false
    }
    if (origin.normalizedOutput !== undefined) {
        if (!origin.result || origin.result.contentIndex === undefined) return false
        const resultPart = aiContent(outgoing[origin.result.messageIndex])[
            origin.result.contentIndex
        ]
        const resultRecord = isRecord(resultPart)
            ? (resultPart as unknown as Record<string, unknown>).result
            : undefined
        if (!isRecord(resultRecord) || resultRecord.type !== "text") return false
        if (stringValue(resultRecord.value) !== origin.normalizedOutput) return false
    }
    return true
}

/**
 * Normalize V2 SessionMessage.Info values for ACP's existing WithParts engine.
 *
 * The second argument is the already-lowered @opencode/ai transcript from the
 * V2 context hook. It is intentionally treated as immutable source material;
 * the returned `messages` are an algorithm-only projection and are never sent
 * back to OpenCode wholesale.
 */
export function normalizeV2ProjectedHistory(
    projected: readonly unknown[],
    outgoingOrOptions: readonly AiMessageValue[] | V2ProjectionOptions = [],
    options: V2ProjectionOptions = {},
): V2Projection {
    const outgoing = Array.isArray(outgoingOrOptions)
        ? outgoingOrOptions
        : ([] as readonly AiMessageValue[])
    const projectionOptions: V2ProjectionOptions = Array.isArray(outgoingOrOptions)
        ? options
        : ((outgoingOrOptions as V2ProjectionOptions | undefined) ?? options)
    const sessionID = projectionOptions.sessionID ?? "v2-session"
    const sourceFingerprint = fingerprintSources(projected)
    const outgoingFingerprint = fingerprintOutgoing(outgoing)
    const baselineFingerprint = fingerprintProjection(sourceFingerprint, outgoingFingerprint)
    const claimedMessages = new Set<number>()
    const drafts: Draft[] = []
    const sourceIds = new Map<string, number[]>()
    let rejection: V2ProjectionRejection | undefined

    // Duplicate lowered message IDs make index-based replay ambiguous.  Reject
    // them before any patch can be attempted rather than letting one object
    // silently shadow another in the provenance maps.
    const outgoingIds = new Set<string>()
    const outgoingIndicesById = new Map<string, number[]>()
    const outgoingSystemIndicesByText = new Map<string, number[]>()
    const outgoingRoleToolResultIndicesByCallId = new Map<string, number[]>()
    for (let messageIndex = 0; messageIndex < outgoing.length; messageIndex++) {
        const id = aiMessageId(outgoing[messageIndex])
        if (id) {
            if (outgoingIds.has(id)) {
                rejection = rejection ?? {
                    code: "invalid-source",
                    message: `Lowered outgoing message ID ${id} occurs more than once`,
                    sourceIndex: messageIndex,
                }
            }
            outgoingIds.add(id)
            const indices = outgoingIndicesById.get(id) ?? []
            indices.push(messageIndex)
            outgoingIndicesById.set(id, indices)
        }
        if (
            aiRole(outgoing[messageIndex]) === "system" &&
            aiContent(outgoing[messageIndex]).length === 1 &&
            contentType(aiContent(outgoing[messageIndex])[0]) === "text"
        ) {
            const text = contentText(aiContent(outgoing[messageIndex])[0])
            if (text !== undefined) {
                const indices = outgoingSystemIndicesByText.get(text) ?? []
                indices.push(messageIndex)
                outgoingSystemIndicesByText.set(text, indices)
            }
        }
        if (aiRole(outgoing[messageIndex]) === "tool") {
            for (const part of aiContent(outgoing[messageIndex])) {
                if (contentType(part) !== "tool-result") continue
                const callID = contentResultId(part)
                if (!callID) continue
                const indices = outgoingRoleToolResultIndicesByCallId.get(callID) ?? []
                if (indices[indices.length - 1] !== messageIndex) indices.push(messageIndex)
                outgoingRoleToolResultIndicesByCallId.set(callID, indices)
            }
        }
    }

    for (let sourceIndex = 0; sourceIndex < projected.length; sourceIndex++) {
        const source = sourceRecord(projected[sourceIndex])
        if (!source) {
            rejection ??= {
                code: "invalid-source",
                message: `Projected message ${sourceIndex} has no valid type`,
                sourceIndex,
            }
            continue
        }
        const id = sourceId(source, sourceIndex)
        if (!id && source.type !== "system") {
            rejection ??= {
                code: "invalid-source",
                message: `Projected ${source.type} message ${sourceIndex} has no stable ID`,
                sourceIndex,
            }
        }
        if (id && source.type !== "system") {
            const ids = sourceIds.get(id) ?? []
            ids.push(sourceIndex)
            sourceIds.set(id, ids)
            if (ids.length > 1) {
                rejection ??= {
                    code: "duplicate-source-id",
                    message: `Projected source message ID ${id} occurs more than once`,
                    sourceIndex,
                }
            }
        }
        drafts.push(makeDraft(source, sourceIndex, projectionOptions))
    }

    for (const draft of drafts) {
        if (!expectedSourceMessage(draft.source)) continue
        const id = draft.sourceMessageId
        let mapped: number | undefined
        if (draft.providerCheckpoint) {
            continue
        }
        if (draft.source.type === "system") {
            // Repeated identical system text is a valid host sequence: OpenCode
            // lowers each record in order without preserving its ID, so N identical
            // records yield N identical ID-less messages. Correlate by ordered
            // occurrence (k-th projected -> k-th unclaimed lowered match), never by
            // rejecting on multiple candidates. An unmatched record stays opaque and
            // unmapped; ownership is never guessed and no system message is dropped.
            mapped = outgoingSystem(
                stringValue(draft.source.text) ?? "",
                outgoingSystemIndicesByText,
                claimedMessages,
            )
        } else {
            mapped = outgoingById(id, outgoingIndicesById, claimedMessages)
        }
        if (mapped !== undefined) draft.outgoingMessageIndices.push(mapped)
    }

    claimCheckpointRanges(drafts, outgoing, claimedMessages)

    // Unexecuted V2 tool entries lower to a separate role=tool Message without a
    // top-level ID. It must be correlated by result ID, never by array position.
    // Claiming is done after checkpoint regions so decoded provider messages are
    // kept opaque rather than accidentally attributed to an assistant call.
    const claimedContent = new Set<PointerKey>()
    for (const draft of drafts) {
        if (draft.source.type !== "assistant") continue
        const content = Array.isArray(draft.source.content) ? draft.source.content : []
        for (const itemValue of content) {
            if (!isRecord(itemValue) || itemValue.type !== "tool") continue
            const callID = stringValue(itemValue.id)
            if (!callID) continue
            const executed = itemValue.executed === true
            if (executed) continue
            const roleToolResultIndices = outgoingRoleToolResultIndicesByCallId.get(callID) ?? []
            const result = aiToolResultPointer(
                [
                    ...draft.outgoingMessageIndices,
                    ...roleToolResultIndices.filter((index) => !claimedMessages.has(index)),
                ],
                callID,
                outgoing,
                claimedContent,
                true,
            )
            if (result && !draft.outgoingMessageIndices.includes(result.messageIndex)) {
                draft.outgoingMessageIndices.push(result.messageIndex)
                claimedMessages.add(result.messageIndex)
            }
        }
    }

    for (const draft of drafts) {
        if (!draft.normalizedMessageId) continue
        if (!sourceOutputMessageRoleIsValid(draft, outgoing)) {
            // Keep the objects available for the patcher, but make the projection
            // fail closed instead of guessing which lowered message was intended.
            rejection ??= {
                code: "invalid-source",
                message: `Lowered role for projected ${draft.sourceType} ${draft.sourceMessageId ?? draft.sourceIndex} is ambiguous`,
                sourceIndex: draft.sourceIndex,
            }
        }
        buildNormalizedSource(draft, sessionID, projectionOptions, outgoing)
    }

    const normalizedEntries: V2ProvenanceEntry[] = []
    const normalizedMessages: WithParts[] = []
    const normalizedIds = new Set<string>()
    for (const draft of drafts) {
        if (!draft.normalized || !draft.normalizedMessageId) {
            // Controls and non-completed compactions intentionally do not enter
            // the algorithm projection, but their source/status still belongs in
            // the sidecar so callers can account for the complete Info union.
            normalizedEntries.push({
                source: draft.source,
                sourceMessageId: draft.sourceMessageId,
                sourceIndex: draft.sourceIndex,
                sourceType: draft.sourceType,
                status: draft.status,
                outgoingMessageIndices: sourceOutputMessageIndices(draft),
                origins: draft.origins,
                toolCallIds: [...new Set(draft.toolCallIds)],
                opaque: draft.opaque,
                protected: draft.protected,
                protectedFields: [
                    ...new Set(draft.origins.flatMap((origin) => origin.protectedFields)),
                ],
                allowSourceRemoval: draft.allowSourceRemoval,
                providerCheckpoint: draft.providerCheckpoint,
            })
            continue
        }
        if (normalizedIds.has(draft.normalizedMessageId)) {
            rejection ??= {
                code: "duplicate-normalized-id",
                message: `Normalized message ID ${draft.normalizedMessageId} occurs more than once`,
                sourceIndex: draft.sourceIndex,
            }
        }
        normalizedIds.add(draft.normalizedMessageId)
        for (const origin of draft.origins) {
            origin.normalizedMessageId = draft.normalizedMessageId
        }
        normalizedMessages.push(draft.normalized)
        normalizedEntries.push({
            source: draft.source,
            normalizedMessageId: draft.normalizedMessageId,
            sourceMessageId: draft.sourceMessageId,
            sourceIndex: draft.sourceIndex,
            sourceType: draft.sourceType,
            status: draft.status,
            outgoingMessageIndices: sourceOutputMessageIndices(draft),
            origins: draft.origins,
            toolCallIds: [...new Set(draft.toolCallIds)],
            opaque: draft.opaque,
            protected: draft.protected,
            protectedFields: [
                ...new Set(draft.origins.flatMap((origin) => origin.protectedFields)),
            ],
            allowSourceRemoval: draft.allowSourceRemoval,
            providerCheckpoint: draft.providerCheckpoint,
        })
    }

    const projectedCallIds = new Set<string>()
    for (const entry of normalizedEntries) {
        for (const callID of entry.toolCallIds) {
            if (projectedCallIds.has(callID)) {
                rejection ??= {
                    code: "duplicate-call-id",
                    message: `Projected tool call ID ${callID} occurs more than once`,
                }
            }
            projectedCallIds.add(callID)
        }
    }

    for (const entry of normalizedEntries) {
        for (const origin of entry.origins) {
            if (!origin.opaque && origin.originalContent.length === 0) {
                rejection ??= {
                    code: "invalid-source",
                    message: `Patchable origin ${origin.key} has no exact lowered outgoing match`,
                    sourceIndex: entry.sourceIndex,
                }
            }
            if (!loweredToolCorrelationIsExact(origin, outgoing)) {
                rejection ??= {
                    code: "invalid-source",
                    message: `Tool origin ${origin.key} has no exact lowered input/output match`,
                    sourceIndex: entry.sourceIndex,
                }
            }
        }
    }

    const ownerByOutgoingIndex = new Map<number, Draft>()
    for (const draft of drafts) {
        for (const messageIndex of draft.outgoingMessageIndices) {
            if (!ownerByOutgoingIndex.has(messageIndex))
                ownerByOutgoingIndex.set(messageIndex, draft)
        }
    }

    const outgoingProvenance: V2OutgoingProvenance[] = outgoing.map((message, messageIndex) => {
        const owner = ownerByOutgoingIndex.get(messageIndex)
        const opaqueContent = new Map<number, AiContentPart>()
        let opaqueMessage: AiMessageValue | undefined
        if (owner) {
            if (owner.opaque) opaqueMessage = message
            for (const origin of owner.origins) {
                if (!origin.opaque) continue
                for (const pointer of origin.outgoing) {
                    if (
                        pointer.messageIndex === messageIndex &&
                        pointer.contentIndex !== undefined
                    ) {
                        const part = aiContent(message)[pointer.contentIndex]
                        if (part) opaqueContent.set(pointer.contentIndex, part)
                    }
                }
            }
            // A provider may add content that has no lossless projected origin
            // (for example a file result extension or an extra text segment).
            // Keep every such part opaque without changing the provenance of
            // ordinary projected origins in the same message.
            if (!owner.opaque) {
                const referenced = new Set(
                    owner.origins.flatMap((origin) =>
                        origin.outgoing
                            .filter((pointer) => pointer.messageIndex === messageIndex)
                            .map((pointer) => pointer.contentIndex),
                    ),
                )
                for (
                    let contentIndex = 0;
                    contentIndex < aiContent(message).length;
                    contentIndex++
                ) {
                    if (referenced.has(contentIndex)) continue
                    const part = aiContent(message)[contentIndex]
                    if (part) opaqueContent.set(contentIndex, part)
                }
            }
        } else {
            // Uncorrelated host messages are provider-owned by definition. The
            // prior structural fingerprint only compared their shape, allowing
            // a same-ID replacement to slip through before patching.
            opaqueMessage = message
            aiContent(message).forEach((part, contentIndex) => {
                opaqueContent.set(contentIndex, part)
            })
        }
        return {
            messageIndex,
            message,
            sourceMessageId: owner?.sourceMessageId,
            normalizedMessageId: owner?.normalizedMessageId,
            opaque: owner?.opaque === true || owner === undefined,
            owned: owner?.owned === true || isAcpOwnedId(aiMessageId(message)),
            opaqueMessage,
            opaqueContent,
        }
    })

    const fingerprint = fingerprintProjection(sourceFingerprint, outgoingFingerprint)
    return {
        messages: normalizedMessages,
        entries: normalizedEntries,
        provenance: normalizedEntries,
        sidecar: { entries: normalizedEntries, outgoing: outgoingProvenance },
        outgoing: outgoingProvenance,
        originalMessages: [...outgoing],
        fingerprint,
        baselineFingerprint,
        outgoingFingerprint,
        sourceFingerprint,
        sessionID,
        valid: rejection === undefined,
        rejection,
    }
}

export const normalizeV2Messages = normalizeV2ProjectedHistory
