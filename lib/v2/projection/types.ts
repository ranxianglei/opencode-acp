import type { ContentPart as AiContentPart, Message as AiMessageValue } from "@opencode/ai"
import type { WithParts } from "../../state"

/** The model selected for the request currently being assembled by OpenCode. */
export interface V2ProjectionModel {
    id: string
    providerID: string
    variant?: string
}

export interface V2ProjectionOptions {
    sessionID?: string
    agent?: string
    directory?: string
    currentModel?: V2ProjectionModel
}

export type V2ProjectionSourceType =
    | "user"
    | "assistant"
    | "synthetic"
    | "system"
    | "skill"
    | "shell"
    | "location-switched"
    | "compaction"
    | "agent-switched"
    | "model-switched"
    | "idle"
    | "control"
    | "acp-synthetic"
    | "provider-checkpoint"

export type V2ProjectionOriginKind = "text" | "reasoning" | "attachment" | "tool"

export interface V2OutgoingPointer {
    messageIndex: number
    contentIndex?: number
}

export interface V2OriginalContentReference {
    pointer: V2OutgoingPointer
    /** Exact lowered content object observed during normalization. */
    part: AiContentPart
    /** Frozen value fingerprint for patchable content (opaque content uses identity). */
    fingerprint?: string
}

export interface V2ContentOrigin {
    key: string
    normalizedMessageId: string
    sourceMessageId?: string
    kind: V2ProjectionOriginKind
    callId?: string
    outgoing: V2OutgoingPointer[]
    /** Alias kept explicit for callers that need output-span terminology. */
    outputSpans: V2OutgoingPointer[]
    /** Provider/cache fields retained verbatim by a patch. */
    protectedFields: string[]
    /** References for every lowered patchable or opaque content origin. */
    originalContent: V2OriginalContentReference[]
    call?: V2OutgoingPointer
    result?: V2OutgoingPointer
    opaque: boolean
    representableInput?: boolean
    representableOutput?: boolean
    normalizedText?: string
    /** Bounded comparison fingerprint for potentially large tool input. */
    normalizedInputHash?: string
    normalizedOutput?: string
    normalizedError?: string
    normalizedToolName?: string
}

export interface V2ProvenanceEntry {
    /** The exact public SessionMessage.Info value used for this entry. */
    source?: unknown
    normalizedMessageId?: string
    sourceMessageId?: string
    sourceIndex: number
    sourceType: V2ProjectionSourceType
    status?: string
    outgoingMessageIndices: number[]
    origins: V2ContentOrigin[]
    toolCallIds: string[]
    opaque: boolean
    protected: boolean
    protectedFields?: string[]
    /** Source removal is safe only when the origin is exact and unambiguous. */
    allowSourceRemoval: boolean
    /**
     * Native provider compaction checkpoint. When `outgoingMessageIndices` is
     * empty this entry discloses an unsupported window: the checkpoint is
     * visible in the public context but absent from the outgoing (model-aware)
     * request — for example an incompatible model switch excluded it and
     * re-expanded the original transcript, or the direct-tool view has no
     * outgoing history at all. ACP then renders the entry from source
     * compaction data (summary + recent context) and keeps every uncorrelated
     * outgoing message as its own opaque host entry instead of inferring
     * ownership from array position. Residual limitation: when exactly one
     * candidate sits in the window ACP claims it as the decoded checkpoint, so
     * a single re-expanded original is indistinguishable from it positionally.
     */
    providerCheckpoint?: boolean
}

export interface V2OutgoingProvenance {
    messageIndex: number
    message: AiMessageValue
    sourceMessageId?: string
    normalizedMessageId?: string
    opaque: boolean
    owned: boolean
    opaqueMessage?: AiMessageValue
    opaqueContent?: Map<number, AiContentPart>
}

export interface V2ProjectionRejection {
    code: "duplicate-source-id" | "duplicate-normalized-id" | "duplicate-call-id" | "invalid-source"
    message: string
    sourceIndex?: number
}

export interface V2Projection {
    /** ACP's existing engine input. These objects are never sent to OpenCode. */
    messages: WithParts[]
    /** Source-message and content-level provenance for validated patching. */
    entries: V2ProvenanceEntry[]
    /** Read-only naming aliases for consumers that call this a sidecar. */
    provenance: V2ProvenanceEntry[]
    sidecar: {
        entries: V2ProvenanceEntry[]
        outgoing: V2OutgoingProvenance[]
    }
    outgoing: V2OutgoingProvenance[]
    /** Snapshot references used to build the replacement array. */
    originalMessages: readonly AiMessageValue[]
    fingerprint: string
    baselineFingerprint: string
    /** Structural fingerprint of lowered IDs/order/tool identities only. */
    outgoingFingerprint: string
    sourceFingerprint: string
    sessionID: string
    valid: boolean
    rejection?: V2ProjectionRejection
}

export interface V2PatchRejection {
    code:
        | "projection-invalid"
        | "fingerprint-mismatch"
        | "duplicate-message-id"
        | "duplicate-call-id"
        | "unknown-origin"
        | "opaque-origin"
        | "ambiguous-origin"
        | "invalid-order"
        | "invalid-tool-pair"
        | "invalid-insertion"
        | "invalid-schema"
    message: string
}

export interface V2ContextPatch {
    removedMessageIds: string[]
    removedCallIds: string[]
    editedMessageIds: string[]
    editedCallIds: string[]
    insertedMessageIds: string[]
}

export interface V2PatchAccepted {
    accepted: true
    ok: true
    messages: AiMessageValue[]
    patch: V2ContextPatch
}

export interface V2PatchRejected {
    accepted: false
    ok: false
    rejection: V2PatchRejection
}

export type V2PatchResult = V2PatchAccepted | V2PatchRejected

export type SourceRecord = Record<string, unknown> & { type: string }
export type Part = WithParts["parts"][number]
export type InternalInfo = WithParts["info"]
export type PointerKey = string

export interface Draft {
    source: SourceRecord
    sourceIndex: number
    sourceType: V2ProjectionSourceType
    sourceMessageId?: string
    normalizedMessageId?: string
    status?: string
    outgoingMessageIndices: number[]
    origins: V2ContentOrigin[]
    toolCallIds: string[]
    opaque: boolean
    protected: boolean
    allowSourceRemoval: boolean
    providerCheckpoint?: boolean
    /** Set on provider-checkpoint drafts whose entire outgoing window was
     *  reserved to correlated sources: the checkpoint decoded nothing into
     *  this view and must not emit a normalized message (issue #456). */
    whollyReserved?: boolean
    normalized?: WithParts
    owned: boolean
}

export interface MutableOrigin extends V2ContentOrigin {
    normalizedMessageId: string
}
