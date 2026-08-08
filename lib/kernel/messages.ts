import type { CoreMessage } from "acp-kernel"
export type { CoreMessage } from "acp-kernel"
import type { WithParts } from "../state"

// Projection between OpenCode's SDK shape (WithParts = { info, parts[] }) and
// acp-kernel's CoreMessage.
//
// OpenCode Part kinds: text { type,text,ignored? }, tool { type,tool,callID,
// state:{status,input?,output?,error?} }, reasoning { type,text }.
//
// A completed OpenCode tool part spans BOTH a tool-call and its tool-result, so
// it projects to TWO CoreMessages sharing the same toolCallId — required so the
// kernel's protected-tool pairing (Bug 39) and tool-pair boundary adjustment can
// match call↔result. Tool result ids use the "#result" suffix.

type AnyPart = {
    type?: string
    text?: string
    tool?: string
    callID?: string
    state?: {
        status?: string
        input?: unknown
        output?: unknown
        error?: string | { message?: string }
    }
}

function stringifyContent(value: unknown): string {
    if (value === undefined || value === null) return ""
    if (typeof value === "string") return value
    try {
        return JSON.stringify(value)
    } catch {
        return String(value)
    }
}

function extractText(parts: AnyPart[]): string {
    let text = ""
    for (const part of parts) {
        if (part.type === "text" && typeof part.text === "string") {
            text = text ? `${text}\n${part.text}` : part.text
        }
    }
    return text
}

function toolResultText(part: AnyPart): string {
    const state = part.state
    if (!state) return ""
    if (state.status === "error") {
        const err = state.error
        return typeof err === "string" ? err : err?.message ?? "tool error"
    }
    if (state.output !== undefined && state.output !== null) {
        return stringifyContent(state.output)
    }
    return ""
}

export function withPartsToCoreMessages(messages: WithParts[]): CoreMessage[] {
    const out: CoreMessage[] = []
    for (const message of messages) {
        const id = message.info.id
        const role = message.info.role
        const parts = message.parts as AnyPart[]

        if (role === "user") {
            const text = extractText(parts)
            if (text.length > 0) out.push({ id, role: "user", contentType: "text", text })
            continue
        }

        if (role === "assistant") {
            const toolParts = parts.filter((p) => p.type === "tool" && typeof p.callID === "string")
            const reasoningText = parts
                .filter((p) => p.type === "reasoning" && typeof p.text === "string")
                .map((p) => p.text as string)
                .join("\n")
            const textBody = extractText(parts)

            if (toolParts.length === 0) {
                if (textBody.length > 0) out.push({ id, role: "assistant", contentType: "text", text: textBody })
                if (reasoningText.length > 0) out.push({ id, role: "assistant", contentType: "reasoning", text: reasoningText })
                continue
            }

            for (const part of toolParts) {
                const callID = part.callID as string
                const inputText = part.state?.input !== undefined ? stringifyContent(part.state.input) : ""
                out.push({
                    id: `${id}#${callID}`,
                    role: "assistant",
                    contentType: "tool-call",
                    toolName: part.tool,
                    toolCallId: callID,
                    text: inputText,
                })
                if (part.state?.status === "completed" || part.state?.status === "error") {
                    out.push({
                        id: `${id}#${callID}#result`,
                        role: "tool",
                        contentType: "tool-result",
                        toolName: part.tool,
                        toolCallId: callID,
                        text: toolResultText(part),
                    })
                }
            }
            if (reasoningText.length > 0) out.push({ id, role: "assistant", contentType: "reasoning", text: reasoningText })
            continue
        }

        const text = extractText(parts)
        if (text.length > 0) {
            out.push({ id, role: role === "system" ? "system" : "user", contentType: "text", text })
        }
    }
    return out
}

const ACP_TAG = /<acp\s[^>]*>m\d{1,5}<\/acp>\n?/g
const ACP_TAG_LEADING = /^<acp\s[^>]*>m\d{1,5}<\/acp>\n?/

function extractTag(core: CoreMessage): string | null {
    const match = (core.text ?? "").match(ACP_TAG_LEADING)
    return match ? match[0].replace(/\n?$/, "") : null
}

// Reconstruct the OpenCode message list from the kernel's surviving CoreMessage
// output. Survival order comes from coreOut. Ref tags are extracted from the
// kernel's render-refs output (burned into core.text) — not from messageRefs —
// because split assistant messages (baseId#callID) carry per-split refs that
// only exist on the core, not on the base raw id. Multi-call assistant
// messages are rebuilt keeping only surviving callIDs. Assistant text/reasoning
// messages are NOT tagged (the model echoes tags on its own output — pai-acp).
export interface ReconstructionResult {
    messages: WithParts[]
    survivingIds: string[]
}

export function reconstructMessages(
    coreOut: CoreMessage[],
    originalById: Map<string, WithParts>,
): ReconstructionResult {
    const out: WithParts[] = []
    const survivingIds: string[] = []
    const emittedBase = new Set<string>()

    for (const core of coreOut) {
        if (core.id.startsWith("acp_summary_")) continue

        const hashIdx = core.id.indexOf("#")
        const baseId = hashIdx < 0 ? core.id : core.id.substring(0, hashIdx)
        if (emittedBase.has(baseId)) continue
        emittedBase.add(baseId)

        const original = originalById.get(baseId)
        if (!original) continue

        const tag = extractTag(core)
        if (hashIdx < 0) {
            out.push(applyRefTag(original, tag))
            survivingIds.push(baseId)
            continue
        }

        const survivingCallIds = new Set(
            coreOut
                .filter((c) => c.id.startsWith(`${baseId}#`) && !c.id.startsWith("acp_summary_"))
                .map((c) => c.toolCallId)
                .filter((cid): cid is string => typeof cid === "string"),
        )
        const filteredParts = ((original.parts as AnyPart[]).filter((part) => {
            if (part.type === "tool" && typeof part.callID === "string") return survivingCallIds.has(part.callID)
            return true
        })) as WithParts["parts"]
        out.push(applyRefTag({ info: original.info, parts: filteredParts }, tag))
        survivingIds.push(baseId)
    }

    return { messages: out, survivingIds }
}

function applyRefTag(message: WithParts, tag: string | null): WithParts {
    if (!tag) return message
    const hasTool = (message.parts as AnyPart[]).some((p) => p.type === "tool")
    if (message.info.role === "assistant" && !hasTool) return message
    return patchTag(message, tag)
}

function patchTag(original: WithParts, tag: string): WithParts {
    const parts = (original.parts as AnyPart[]).map((p) => ({ ...p }))
    for (const p of parts) {
        if (p.type === "text" && typeof p.text === "string") {
            p.text = p.text.replace(ACP_TAG, "").replace(/\n+$/, "")
        }
    }
    for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i]!
        if (p.type === "text" && typeof p.text === "string") {
            p.text = p.text.length > 0 ? `${p.text}\n\n${tag}` : tag
            return { info: original.info, parts: parts as WithParts["parts"] }
        }
    }
    parts.push({ type: "text", text: tag })
    return { info: original.info, parts: parts as WithParts["parts"] }
}
