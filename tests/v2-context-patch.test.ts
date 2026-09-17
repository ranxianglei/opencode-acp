import "./test-env"
import assert from "node:assert/strict"
import test from "node:test"
import { Message } from "@opencode/ai"
import type { Message as AiMessage, ContentPart } from "@opencode/ai"
import {
    applyV2ContextPatch,
    normalizeV2ProjectedHistory,
    restoreMissingV2OpaqueSources,
    type V2Projection,
} from "../lib/v2/projection"

const model = { id: "model-a", providerID: "provider-a" }

function sourceMessages() {
    return [
        { type: "user", id: "u-1", time: { created: 1 }, text: "keep this request" },
        {
            type: "assistant",
            id: "a-1",
            time: { created: 2 },
            agent: "code",
            model,
            content: [
                { type: "reasoning", text: "old reasoning" },
                { type: "text", text: "historical answer <dcp-message-id>m00001</dcp-message-id>" },
                {
                    type: "tool",
                    id: "call-1",
                    name: "read",
                    executed: false,
                    state: {
                        status: "completed",
                        input: { path: "a.ts" },
                        content: [{ type: "text", text: "tool output" }],
                        time: { start: 2, end: 3 },
                        metadata: { source: "fixture" },
                    },
                },
            ],
        },
        { type: "user", id: "u-2", time: { created: 3 }, text: "latest request" },
    ]
}

function outgoingMessages(): AiMessage[] {
    return [
        Message.make({
            id: "u-1",
            role: "user",
            content: [{ type: "text", text: "keep this request" }],
        }),
        Message.make({
            id: "a-1",
            role: "assistant",
            content: [
                {
                    type: "reasoning",
                    text: "old reasoning",
                    cache: { type: "ephemeral" },
                    providerMetadata: { provider: { trace: "retain" } },
                },
                {
                    type: "text",
                    text: "historical answer <dcp-message-id>m00001</dcp-message-id>",
                    metadata: { source: "history" },
                },
                {
                    type: "tool-call",
                    id: "call-1",
                    name: "read",
                    input: { path: "a.ts" },
                    cache: { type: "ephemeral" },
                    providerMetadata: { provider: { native: "retain" } },
                },
            ],
        }),
        Message.make({
            role: "tool",
            content: [
                {
                    type: "tool-result",
                    id: "call-1",
                    name: "read",
                    result: { type: "text", value: "tool output" },
                    providerMetadata: { provider: { nativeResult: "retain" } },
                },
            ],
        }),
        Message.make({ id: "u-2", role: "user", content: "latest request" }),
        // This host-added message has no projected source and must stay in place.
        Message.make({ id: "host-extra", role: "user", content: "host content" }),
    ]
}

function buildProjection(): { projection: V2Projection; outgoing: AiMessage[] } {
    const outgoing = outgoingMessages()
    const projection = normalizeV2ProjectedHistory(sourceMessages(), outgoing, {
        sessionID: "s",
        agent: "code",
        currentModel: model,
    })
    assert.equal(projection.valid, true)
    return { projection, outgoing }
}

function clonedMessages(projection: V2Projection): ReturnType<typeof structuredClone> {
    return structuredClone(projection.messages)
}

test("applies text/reasoning and representable tool edits without losing provider fields", () => {
    const { projection } = buildProjection()
    const transformed = clonedMessages(projection)
    const assistant = transformed.find((message) => message.info.id === "a-1")!
    const reasoning = assistant.parts.find((part) => part.type === "reasoning")!
    const text = assistant.parts.find((part) => part.type === "text")!
    const tool = assistant.parts.find((part) => part.type === "tool")!
    reasoning.text = "new reasoning"
    text.text = "new historical answer"
    tool.state.input = { path: "b.ts" }
    tool.state.output = "new tool output"

    const result = applyV2ContextPatch(projection, transformed)
    assert.equal(result.accepted, true)
    if (!result.accepted) return
    const assistantOutput = result.messages.find((message) => message.id === "a-1")!
    const reasoningOutput = assistantOutput.content.find((part) => part.type === "reasoning")!
    const textOutput = assistantOutput.content.find((part) => part.type === "text")!
    const callOutput = assistantOutput.content.find((part) => part.type === "tool-call")!
    assert.equal(reasoningOutput.text, "new reasoning")
    assert.equal(textOutput.text, "new historical answer")
    assert.deepEqual(callOutput.input, { path: "b.ts" })
    assert.equal(reasoningOutput.cache.type, "ephemeral")
    assert.deepEqual(reasoningOutput.providerMetadata, { provider: { trace: "retain" } })
    assert.equal(callOutput.cache.type, "ephemeral")
    assert.deepEqual(callOutput.providerMetadata, { provider: { native: "retain" } })
    const resultOutput = result.messages.find((message) => message.role === "tool")!.content[0]
    assert.deepEqual(resultOutput.result, { type: "text", value: "new tool output" })
    assert.deepEqual(resultOutput.providerMetadata, { provider: { nativeResult: "retain" } })
})

test("keeps opaque attachments/system content and uncorrelated host messages while patching safe text", () => {
    const projected = [
        {
            type: "system",
            id: "system-1",
            time: { created: 1 },
            text: "do not rewrite this system message",
        },
        {
            type: "user",
            id: "user-with-file",
            time: { created: 2 },
            text: "safe text",
            files: [
                {
                    data: "image-bytes",
                    mime: "image/png",
                    source: { type: "inline" },
                    name: "image.png",
                },
            ],
        },
    ]
    const attachment: ContentPart = {
        type: "media",
        mediaType: "image/png",
        data: "image-bytes",
        filename: "image.png",
    }
    const outgoing = [
        Message.make({ role: "system", content: "do not rewrite this system message" }),
        Message.make({
            id: "user-with-file",
            role: "user",
            content: [{ type: "text", text: "safe text" }, attachment],
        }),
        Message.make({ id: "uncorrelated", role: "user", content: "survive me" }),
    ]
    const p = normalizeV2ProjectedHistory(projected, outgoing, {
        sessionID: "opaque-session",
        currentModel: model,
    })
    const transformed = clonedMessages(p)
    transformed
        .find((message) => message.info.id === "user-with-file")!
        .parts.find((part) => part.type === "text")!.text = "safe text edited"

    const result = applyV2ContextPatch(p, transformed)
    assert.equal(result.accepted, true)
    if (!result.accepted) return
    assert.equal(result.messages[0].content[0].text, "do not rewrite this system message")
    assert.equal(result.messages[1].content[0].text, "safe text edited")
    assert.strictEqual(result.messages[1].content[1], outgoing[1].content[1])
    assert.equal(result.messages[2].id, "uncorrelated")
})

test("removes tool call/result atomically and inserts deterministic ACP synthetic messages", () => {
    const { projection } = buildProjection()
    const transformed = clonedMessages(projection)
    const assistant = transformed.find((message) => message.info.id === "a-1")!
    assistant.parts = assistant.parts.filter((part) => part.type !== "tool")
    const synthetic = structuredClone(transformed[0])
    synthetic.info.id = "msg_dcp_summary_1234567890abcdef"
    synthetic.parts = [
        {
            id: "prt_dcp_summary_1234567890abcdef",
            sessionID: "s",
            messageID: synthetic.info.id,
            type: "text",
            text: "ACP summary",
        },
    ]
    transformed.push(synthetic)

    const result = applyV2ContextPatch(projection, transformed)
    assert.equal(result.accepted, true)
    if (!result.accepted) return
    assert.equal(
        result.messages.some((message) =>
            message.content.some((part) => part.type === "tool-call" && part.id === "call-1"),
        ),
        false,
    )
    assert.equal(
        result.messages.some((message) => message.role === "tool"),
        false,
    )
    assert.equal(
        result.messages.some((message) => message.id === synthetic.info.id),
        true,
    )
    assert.deepEqual(result.patch.removedCallIds, ["call-1"])
    assert.deepEqual(result.patch.insertedMessageIds, [synthetic.info.id])
})

test("rejects fingerprint and opaque-boundary mismatches without changing the original objects", () => {
    const { projection, outgoing } = buildProjection()
    const transformed = clonedMessages(projection)
    transformed[0].parts[0].text = "edited safely"
    const originalFirst = outgoing[0]
    const fingerprintProjection = { ...projection, fingerprint: "tampered" }
    const fingerprintResult = applyV2ContextPatch(fingerprintProjection, transformed)
    assert.equal(fingerprintResult.accepted, false)
    if (!fingerprintResult.accepted)
        assert.equal(fingerprintResult.rejection.code, "fingerprint-mismatch")
    const systemProjected = [
        { type: "system", id: "sys", time: { created: 1 }, text: "opaque" },
        { type: "user", id: "u", time: { created: 2 }, text: "safe" },
    ]
    const systemOutgoing = [
        Message.make({ role: "system", content: "opaque" }),
        Message.make({ id: "u", role: "user", content: "safe" }),
    ]
    const opaqueProjection = normalizeV2ProjectedHistory(systemProjected, systemOutgoing, {
        sessionID: "opaque",
        currentModel: model,
    })
    const changed = [...systemOutgoing]
    const changedSystem = {
        ...changed[0],
        content: [{ type: "text", text: "changed" }],
    } as AiMessage
    changed[0] = changedSystem
    const opaqueResult = applyV2ContextPatch(
        opaqueProjection,
        [
            {
                ...opaqueProjection.messages[1],
                parts: [{ ...opaqueProjection.messages[1].parts[0], text: "safe 2" }],
            },
        ],
        changed,
    )
    assert.equal(opaqueResult.accepted, false)
    if (!opaqueResult.accepted) assert.equal(opaqueResult.rejection.code, "opaque-origin")
    const attachmentSource = {
        type: "user",
        id: "user-with-file",
        time: { created: 2 },
        text: "safe",
        files: [
            {
                data: "image-bytes",
                mime: "image/png",
                source: { type: "inline" },
                name: "image.png",
            },
        ],
    }
    const attachmentMessage = Message.make({
        id: "user-with-file",
        role: "user",
        content: [
            { type: "text", text: "safe" },
            {
                type: "media" as const,
                mediaType: "image/png",
                data: "image-bytes",
                filename: "image.png",
            },
        ],
    })
    const attachmentProjection = normalizeV2ProjectedHistory(
        [attachmentSource],
        [attachmentMessage],
        { sessionID: "attachment", currentModel: model },
    )
    const attachmentTransformed = clonedMessages(attachmentProjection)
    attachmentTransformed[0].parts[0].text = "safe edited"
    const replacedAttachment = [
        {
            ...attachmentMessage,
            content: attachmentMessage.content.map((part, index) =>
                index === 1 ? { ...part } : part,
            ),
        },
    ] as AiMessage[]
    const attachmentResult = applyV2ContextPatch(
        attachmentProjection,
        attachmentTransformed,
        replacedAttachment,
    )
    assert.equal(attachmentResult.accepted, false)
    if (!attachmentResult.accepted) assert.equal(attachmentResult.rejection.code, "opaque-origin")
    assert.strictEqual(outgoing[0], originalFirst)
})

test("repeated patching is idempotent and preserves empty uncorrelated messages", () => {
    const { projection } = buildProjection()
    const transformed = clonedMessages(projection)
    transformed.find((message) => message.info.id === "u-2")!.parts[0].text = "latest edited"
    const first = applyV2ContextPatch(projection, transformed)
    assert.equal(first.accepted, true)
    if (!first.accepted) return
    const second = applyV2ContextPatch(projection, transformed, first.messages)
    assert.equal(second.accepted, true)
    if (!second.accepted) return
    assert.deepEqual(second.messages, first.messages)
    assert.equal(
        second.messages.some((message) => message.id === "host-extra"),
        true,
    )
})

test("rejects a same-ID replacement of patchable lowered content", () => {
    const { projection, outgoing } = buildProjection()
    const transformed = clonedMessages(projection)
    transformed.find((message) => message.info.id === "u-2")!.parts[0].text = "edited request"

    const replaced = outgoing.map((message) => {
        if (message.id !== "u-2") return message
        return Message.make({ id: "u-2", role: "user", content: "provider replaced text" })
    })
    const result = applyV2ContextPatch(projection, transformed, replaced)
    assert.equal(result.accepted, false)
    if (!result.accepted) assert.equal(result.rejection.code, "fingerprint-mismatch")
})

test("rejects same-ID replacement of an uncorrelated provider message", () => {
    const { projection, outgoing } = buildProjection()
    const replacement = [...outgoing]
    replacement[4] = Message.make({ id: "host-extra", role: "user", content: "replaced host" })
    const result = applyV2ContextPatch(projection, projection.messages, replacement)
    assert.equal(result.accepted, false)
    if (!result.accepted) assert.equal(result.rejection.code, "opaque-origin")
})

test("repeated patching accepts ACP-owned output objects after an insertion", () => {
    const { projection } = buildProjection()
    const transformed = clonedMessages(projection)
    const assistant = transformed.find((message) => message.info.id === "a-1")!
    assistant.parts = assistant.parts.filter((part) => part.type !== "tool")
    const synthetic = structuredClone(transformed[0])
    synthetic.info.id = "msg_dcp_summary_abcdefabcdefabcd"
    synthetic.parts = [
        {
            id: "prt_dcp_summary_abcdefabcdefabcd",
            sessionID: "s",
            messageID: synthetic.info.id,
            type: "text",
            text: "ACP summary",
        },
    ]
    transformed.push(synthetic)

    const first = applyV2ContextPatch(projection, transformed)
    assert.equal(first.accepted, true)
    if (!first.accepted) return
    const second = applyV2ContextPatch(projection, transformed, first.messages)
    assert.equal(second.accepted, true)
})

test("rejects a repeated patch after a part is reordered within its message", () => {
    const { projection } = buildProjection()
    const transformed = clonedMessages(projection)
    transformed.find((message) => message.info.id === "u-2")!.parts[0].text = "edited request"

    const first = applyV2ContextPatch(projection, transformed)
    assert.equal(first.accepted, true)
    if (!first.accepted) return

    const assistant = first.messages.find((message) => message.id === "a-1")!
    assistant.content = [...assistant.content].reverse()
    const repeated = applyV2ContextPatch(projection, transformed, first.messages)

    assert.equal(repeated.accepted, false)
    if (!repeated.accepted) assert.equal(repeated.rejection.code, "fingerprint-mismatch")
})

test("rejects a repeated patch after a part moves across messages", () => {
    const { projection } = buildProjection()
    const transformed = clonedMessages(projection)
    transformed.find((message) => message.info.id === "u-2")!.parts[0].text = "edited request"

    const first = applyV2ContextPatch(projection, transformed)
    assert.equal(first.accepted, true)
    if (!first.accepted) return

    const firstUser = first.messages.find((message) => message.id === "u-1")!
    const secondUser = first.messages.find((message) => message.id === "u-2")!
    const [moved] = secondUser.content.splice(0, 1)
    if (!moved) return
    firstUser.content.push(moved)
    const repeated = applyV2ContextPatch(projection, transformed, first.messages)

    assert.equal(repeated.accepted, false)
    if (!repeated.accepted) assert.equal(repeated.rejection.code, "fingerprint-mismatch")
})

test("rejects an in-place mutation of a prior ACP output before replay", () => {
    const { projection } = buildProjection()
    const transformed = clonedMessages(projection)
    const first = applyV2ContextPatch(projection, transformed)
    assert.equal(first.accepted, true)
    if (!first.accepted) return

    first.messages.find((message) => message.id === "u-1")!.content[0]!.text = "newer same-ID text"
    const repeated = applyV2ContextPatch(projection, transformed, first.messages)

    assert.equal(repeated.accepted, false)
    if (!repeated.accepted) assert.equal(repeated.rejection.code, "fingerprint-mismatch")
})

test("rejects source removal when a newer same-ID outgoing message has no exact correlation", () => {
    const { projection, outgoing } = buildProjection()
    const transformed = clonedMessages(projection).filter((message) => message.info.id !== "u-1")
    const replacement = outgoing.map((message) =>
        message.id === "u-1"
            ? Message.make({ id: "u-1", role: "user", content: "newer provider content" })
            : message,
    )

    const result = applyV2ContextPatch(projection, transformed, replacement)

    assert.equal(result.accepted, false)
    if (!result.accepted) assert.equal(result.rejection.code, "fingerprint-mismatch")
})

test("repeated removal remains idempotent after tool-pair deletion", () => {
    const { projection } = buildProjection()
    const transformed = clonedMessages(projection)
    const assistant = transformed.find((message) => message.info.id === "a-1")!
    assistant.parts = assistant.parts.filter((part) => part.type !== "tool")

    const first = applyV2ContextPatch(projection, transformed)
    assert.equal(first.accepted, true)
    if (!first.accepted) return
    const second = applyV2ContextPatch(projection, transformed, first.messages)
    assert.equal(second.accepted, true)
    if (!second.accepted) return
    assert.deepEqual(second.messages, first.messages)

    const copiedArray = [...first.messages]
    const third = applyV2ContextPatch(projection, transformed, copiedArray)
    assert.equal(third.accepted, true)
})

test("repeating a source removal after the array shifts retains every later message", () => {
    const projected = [
        { type: "user", id: "u1", time: { created: 1 }, text: "first" },
        { type: "user", id: "u2", time: { created: 2 }, text: "second" },
        { type: "user", id: "u3", time: { created: 3 }, text: "third" },
    ]
    const outgoing = projected.map((source) =>
        Message.make({ id: source.id, role: "user", content: source.text }),
    )
    const projection = normalizeV2ProjectedHistory(projected, outgoing, {
        sessionID: "shifted-removal",
        currentModel: model,
    })
    const transformed = structuredClone(projection.messages).filter(
        (message) => message.info.id !== "u1",
    )

    const first = applyV2ContextPatch(projection, transformed)
    assert.equal(first.accepted, true)
    if (!first.accepted) return
    const repeated = applyV2ContextPatch(projection, transformed, first.messages)

    assert.equal(repeated.accepted, true)
    if (!repeated.accepted) return
    assert.deepEqual(
        repeated.messages.map((message) => message.id),
        ["u2", "u3"],
    )
})

test("rejects duplicate outgoing message IDs before deriving a patch", () => {
    const outgoing = [
        Message.make({ id: "duplicate", role: "user", content: "same" }),
        Message.make({ id: "duplicate", role: "user", content: "same" }),
    ]
    const projection = normalizeV2ProjectedHistory(
        [{ type: "user", id: "duplicate", time: { created: 1 }, text: "same" }],
        outgoing,
        { sessionID: "duplicate-outgoing", currentModel: model },
    )

    const result = applyV2ContextPatch(projection, projection.messages)
    assert.equal(result.accepted, false)
    if (!result.accepted) assert.equal(result.rejection.code, "projection-invalid")
})

test("rejects a same-ID projected text whose lowered outgoing value differs", () => {
    const projection = normalizeV2ProjectedHistory(
        [{ type: "user", id: "same-id", time: { created: 1 }, text: "new" }],
        [Message.make({ id: "same-id", role: "user", content: "old" })],
        { sessionID: "mismatched-correlation", currentModel: model },
    )

    assert.equal(projection.valid, false)
    const result = applyV2ContextPatch(projection, projection.messages)
    assert.equal(result.accepted, false)
    if (!result.accepted) assert.equal(result.rejection.code, "projection-invalid")
})

test("rejects a tool origin whose projected input/output values differ from lowering", () => {
    const projected = [
        {
            type: "assistant",
            id: "tool-source",
            time: { created: 1 },
            model,
            content: [
                {
                    type: "tool",
                    id: "tool-call",
                    name: "read",
                    executed: false,
                    state: {
                        status: "completed",
                        input: { path: "new.ts" },
                        content: [{ type: "text", text: "new output" }],
                    },
                },
            ],
        },
    ]
    const outgoing = [
        Message.make({
            id: "tool-source",
            role: "assistant",
            content: [
                { type: "tool-call", id: "tool-call", name: "read", input: { path: "old.ts" } },
            ],
        }),
        Message.make({
            role: "tool",
            content: [
                {
                    type: "tool-result",
                    id: "tool-call",
                    name: "read",
                    result: { type: "text", value: "old output" },
                },
            ],
        }),
    ]
    const projection = normalizeV2ProjectedHistory(projected, outgoing, {
        sessionID: "mismatched-tool-correlation",
        currentModel: model,
    })
    assert.equal(projection.valid, false)
    const result = applyV2ContextPatch(projection, projection.messages)
    assert.equal(result.accepted, false)
    if (!result.accepted) assert.equal(result.rejection.code, "projection-invalid")
})

test("accepts a genuine same-ID correlation and preserves its lowered object", () => {
    const outgoing = [Message.make({ id: "same-id-valid", role: "user", content: "old" })]
    const projection = normalizeV2ProjectedHistory(
        [{ type: "user", id: "same-id-valid", time: { created: 1 }, text: "old" }],
        outgoing,
        { sessionID: "valid-correlation", currentModel: model },
    )
    const result = applyV2ContextPatch(projection, structuredClone(projection.messages))

    assert.equal(result.accepted, true)
    if (result.accepted) assert.strictEqual(result.messages[0], outgoing[0])
})

test("replaying an ACP-owned part insertion does not duplicate the inserted content", () => {
    const { projection } = buildProjection()
    const transformed = clonedMessages(projection)
    transformed
        .find((message) => message.info.id === "u-2")!
        .parts.push({
            id: "prt_dcp_text_abcdefabcdefabcd",
            sessionID: "s",
            messageID: "u-2",
            type: "text",
            text: "ACP nudge",
        })

    const first = applyV2ContextPatch(projection, transformed)
    assert.equal(first.accepted, true)
    if (!first.accepted) return
    const repeated = applyV2ContextPatch(projection, transformed, first.messages)

    assert.equal(repeated.accepted, true)
    if (!repeated.accepted) return
    const u2 = repeated.messages.find((message) => message.id === "u-2")!
    assert.equal(
        u2.content.filter((part) => part.type === "text" && part.text === "ACP nudge").length,
        1,
    )
})

test("patches a realistic tool-heavy history with bounded provenance fingerprints", () => {
    const projected: Record<string, unknown>[] = []
    const outgoing: AiMessage[] = []
    const pairCount = 400
    for (let index = 0; index < pairCount; index++) {
        const userID = `large-user-${index}`
        const assistantID = `large-assistant-${index}`
        const callID = `large-call-${index}`
        const userText = `History request ${index}: ${"detail ".repeat(8)}`
        const toolOutput = `Tool result ${index}: ${"output detail ".repeat(8)}`
        projected.push({
            type: "user",
            id: userID,
            time: { created: index * 3 + 1 },
            text: userText,
        })
        projected.push({
            type: "assistant",
            id: assistantID,
            time: { created: index * 3 + 2 },
            model,
            content: [
                {
                    type: "tool",
                    id: callID,
                    name: "read",
                    executed: false,
                    state: {
                        status: "completed",
                        input: { path: `src/file-${index}.ts` },
                        content: [{ type: "text", text: toolOutput }],
                    },
                },
            ],
        })
        outgoing.push(
            Message.make({ id: userID, role: "user", content: userText }),
            Message.make({
                id: assistantID,
                role: "assistant",
                content: [
                    {
                        type: "tool-call",
                        id: callID,
                        name: "read",
                        input: { path: `src/file-${index}.ts` },
                    },
                ],
            }),
            Message.make({
                role: "tool",
                content: [
                    {
                        type: "tool-result",
                        id: callID,
                        name: "read",
                        result: { type: "text", value: toolOutput },
                    },
                ],
            }),
        )
    }
    const projection = normalizeV2ProjectedHistory(projected, outgoing, {
        sessionID: "large-history",
        currentModel: model,
    })
    assert.equal(projection.valid, true)
    assert.equal(
        projection.entries.filter((entry) => entry.toolCallIds.length > 0).length,
        pairCount,
    )
    assert.equal(
        projection.entries
            .flatMap((entry) => entry.origins)
            .filter((origin) => origin.kind === "tool")
            .every((origin) => origin.result !== undefined),
        true,
    )
    assert.ok(
        projection.entries
            .flatMap((entry) => entry.origins)
            .filter((origin) => !origin.opaque)
            .every((origin) =>
                origin.originalContent.every(
                    (reference) =>
                        reference.fingerprint === undefined || reference.fingerprint.length === 64,
                ),
            ),
    )

    const started = Date.now()
    const result = applyV2ContextPatch(projection, structuredClone(projection.messages))
    const elapsed = Date.now() - started
    assert.equal(result.accepted, true)
    // This is deliberately a generous smoke bound rather than a benchmark;
    // correlation correctness and bounded fingerprints are the deterministic
    // assertions, while the pre-indexed path must not regress catastrophically.
    assert.ok(elapsed < 30_000, `large history patch took ${elapsed}ms`)
})

test("restores missing protected opaque sources in source order without duplicating existing ones", () => {
    const projected = [
        { type: "user", id: "ordered-user-0", time: { created: 0 }, text: "first" },
        { type: "system", id: "ordered-system", time: { created: 1 }, text: "system" },
        { type: "user", id: "ordered-user-1", time: { created: 2 }, text: "middle" },
        {
            type: "compaction",
            id: "ordered-compaction",
            time: { created: 3 },
            status: "completed",
            summary: "summary",
            recent: "recent",
        },
        {
            type: "synthetic",
            id: "ordered-foreign-synthetic",
            time: { created: 4 },
            text: "foreign synthetic",
            metadata: { nested: { value: "original" } },
        },
        { type: "user", id: "ordered-user-2", time: { created: 5 }, text: "last" },
    ]
    const outgoing = [
        Message.make({ id: "ordered-user-0", role: "user", content: "first" }),
        Message.make({ role: "system", content: "system" }),
        Message.make({ id: "ordered-user-1", role: "user", content: "middle" }),
        Message.make({ id: "ordered-compaction", role: "user", content: "checkpoint" }),
        Message.make({
            id: "ordered-foreign-synthetic",
            role: "user",
            content: "foreign synthetic",
        }),
        Message.make({ id: "ordered-user-2", role: "user", content: "last" }),
    ]
    const projection = normalizeV2ProjectedHistory(projected, outgoing, {
        sessionID: "ordered-opaque",
        currentModel: model,
    })
    assert.equal(projection.valid, true)

    const existingCompaction = projection.messages.find(
        (message) => message.info.id === "ordered-compaction",
    )!
    const synthetic = structuredClone(projection.messages[0]!)
    synthetic.info.id = "msg_dcp_summary_0123456789abcdef"
    synthetic.parts = [
        {
            id: "prt_dcp_summary_0123456789abcdef",
            sessionID: "ordered-opaque",
            messageID: "msg_dcp_summary_0123456789abcdef",
            type: "text",
            text: "ACP summary",
        },
    ]
    const transformed = [
        projection.messages.find((message) => message.info.id === "ordered-user-0")!,
        projection.messages.find((message) => message.info.id === "ordered-user-1")!,
        existingCompaction,
        synthetic,
        projection.messages.find((message) => message.info.id === "ordered-user-2")!,
    ]

    const result = restoreMissingV2OpaqueSources(projection, transformed)
    assert.equal(result.accepted, true)
    if (!result.accepted) return
    assert.deepEqual(
        result.messages.map((message) => message.info.id),
        [
            "ordered-user-0",
            "ordered-system",
            "ordered-user-1",
            "ordered-compaction",
            "msg_dcp_summary_0123456789abcdef",
            "ordered-foreign-synthetic",
            "ordered-user-2",
        ],
    )
    assert.deepEqual(result.restoredMessageIds, ["ordered-system", "ordered-foreign-synthetic"])
    assert.equal(
        result.messages.filter((message) => message.info.id === "ordered-compaction").length,
        1,
    )
    assert.strictEqual(result.messages[3], existingCompaction)
    assert.strictEqual(result.messages[4], synthetic)

    const restoredSystem = result.messages[1]!
    const originalSystem = projection.messages.find(
        (message) => message.info.id === "ordered-system",
    )!
    assert.notStrictEqual(restoredSystem, originalSystem)
    assert.notStrictEqual(restoredSystem.parts, originalSystem.parts)
    restoredSystem.parts[0]!.text = "restoration copy"
    assert.equal(originalSystem.parts[0]!.text, "system")

    const restoredForeign = result.messages.find(
        (message) => message.info.id === "ordered-foreign-synthetic",
    )!
    const originalForeign = projection.messages.find(
        (message) => message.info.id === "ordered-foreign-synthetic",
    )!
    const restoredMetadata = (restoredForeign.info as { metadata?: Record<string, unknown> })
        .metadata
    const originalMetadata = (originalForeign.info as { metadata?: Record<string, unknown> })
        .metadata
    const restoredNested = restoredMetadata?.nested as Record<string, unknown>
    restoredNested.value = "changed in restoration"
    assert.equal((originalMetadata?.nested as Record<string, unknown>).value, "original")
})

test("fails closed when protected opaque provenance is missing or out of order", () => {
    const projected = [
        { type: "system", id: "ambiguous-system", time: { created: 0 }, text: "system" },
        { type: "user", id: "ambiguous-user", time: { created: 1 }, text: "user" },
    ]
    const outgoing = [
        Message.make({ role: "system", content: "system" }),
        Message.make({ id: "ambiguous-user", role: "user", content: "user" }),
    ]
    const projection = normalizeV2ProjectedHistory(projected, outgoing, {
        sessionID: "ambiguous-opaque",
        currentModel: model,
    })
    assert.equal(projection.valid, true)

    const missingSource = restoreMissingV2OpaqueSources(
        {
            ...projection,
            messages: projection.messages.filter(
                (message) => message.info.id !== "ambiguous-system",
            ),
        },
        [projection.messages.find((message) => message.info.id === "ambiguous-user")!],
    )
    assert.equal(missingSource.accepted, false)
    if (!missingSource.accepted) assert.match(missingSource.reason, /no normalized source message/)

    const reversed = restoreMissingV2OpaqueSources(projection, [...projection.messages].reverse())
    assert.equal(reversed.accepted, false)
    if (!reversed.accepted) assert.match(reversed.reason, /ambiguous order/)
})

test("restores multiple opaque sources in order from an empty transformed sequence", () => {
    const projected = [
        {
            type: "compaction",
            id: "empty-compaction-1",
            time: { created: 1 },
            status: "completed",
            summary: "one",
            recent: "one",
        },
        {
            type: "compaction",
            id: "empty-compaction-2",
            time: { created: 2 },
            status: "completed",
            summary: "two",
            recent: "two",
        },
    ]
    const outgoing = [
        Message.make({ id: "empty-compaction-1", role: "user", content: "one" }),
        Message.make({ id: "empty-compaction-2", role: "user", content: "two" }),
    ]
    const projection = normalizeV2ProjectedHistory(projected, outgoing, {
        sessionID: "empty-opaque",
        currentModel: model,
    })
    assert.equal(projection.valid, true)

    const result = restoreMissingV2OpaqueSources(projection, [])
    assert.equal(result.accepted, true)
    if (!result.accepted) return
    assert.deepEqual(
        result.messages.map((message) => message.info.id),
        ["empty-compaction-1", "empty-compaction-2"],
    )
})

test("rejects missing lowered correlation, duplicate transformed IDs, and duplicate source order", () => {
    const opaqueProjected = [
        { type: "system", id: "correlation-system", time: { created: 1 }, text: "expected system" },
        { type: "user", id: "correlation-user", time: { created: 2 }, text: "user" },
    ]
    const correlationProjection = normalizeV2ProjectedHistory(
        opaqueProjected,
        [
            Message.make({ role: "system", content: "different system" }),
            Message.make({ id: "correlation-user", role: "user", content: "user" }),
        ],
        { sessionID: "missing-correlation", currentModel: model },
    )
    assert.equal(correlationProjection.valid, true)
    const missingCorrelation = restoreMissingV2OpaqueSources(correlationProjection, [])
    assert.equal(missingCorrelation.accepted, false)
    if (!missingCorrelation.accepted)
        assert.match(missingCorrelation.reason, /exact lowered correlation/)

    const duplicateTransformed = restoreMissingV2OpaqueSources(correlationProjection, [
        correlationProjection.messages[1]!,
        correlationProjection.messages[1]!,
    ])
    assert.equal(duplicateTransformed.accepted, false)
    if (!duplicateTransformed.accepted)
        assert.match(duplicateTransformed.reason, /transformed source message .* duplicated/i)

    const entries = correlationProjection.entries.map((entry) =>
        entry.sourceMessageId === "correlation-user"
            ? { ...entry, sourceIndex: correlationProjection.entries[0]!.sourceIndex }
            : entry,
    )
    const duplicateOrder = restoreMissingV2OpaqueSources({ ...correlationProjection, entries }, [])
    assert.equal(duplicateOrder.accepted, false)
    if (!duplicateOrder.accepted) assert.match(duplicateOrder.reason, /source order .* ambiguous/i)
})

test("maps repeated identical system text by ordered occurrence without rejecting", () => {
    const projected = [
        { type: "system", id: "repeated-a", time: { created: 1 }, text: "same instruction" },
        { type: "system", id: "repeated-b", time: { created: 2 }, text: "same instruction" },
    ]
    const outgoing = [
        Message.make({ role: "system", content: "same instruction" }),
        Message.make({ role: "system", content: "same instruction" }),
    ]
    const projection = normalizeV2ProjectedHistory(projected, outgoing, {
        sessionID: "repeated-system",
        currentModel: model,
    })
    assert.equal(projection.valid, true)
    assert.equal(projection.rejection, undefined)
    const byId = (id: string) => projection.entries.find((entry) => entry.sourceMessageId === id)!
    // The k-th projected record claims the k-th unclaimed lowered match in lowering order.
    assert.deepEqual(byId("repeated-a").outgoingMessageIndices, [0])
    assert.deepEqual(byId("repeated-b").outgoingMessageIndices, [1])
    assert.equal(byId("repeated-a").opaque, true)
    assert.equal(byId("repeated-b").opaque, true)
})

test("preserves per-text occurrence order for interleaved repeated system messages", () => {
    const projected = [
        { type: "system", id: "interleave-alpha-1", time: { created: 1 }, text: "alpha" },
        { type: "system", id: "interleave-beta-1", time: { created: 2 }, text: "beta" },
        { type: "system", id: "interleave-alpha-2", time: { created: 3 }, text: "alpha" },
    ]
    const outgoing = [
        Message.make({ role: "system", content: "alpha" }),
        Message.make({ role: "system", content: "beta" }),
        Message.make({ role: "system", content: "alpha" }),
    ]
    const projection = normalizeV2ProjectedHistory(projected, outgoing, {
        sessionID: "interleaved-system",
        currentModel: model,
    })
    assert.equal(projection.valid, true)
    assert.equal(projection.rejection, undefined)
    const byId = (id: string) => projection.entries.find((entry) => entry.sourceMessageId === id)!
    // The second "alpha" must map to the second lowered alpha, never the first.
    assert.deepEqual(byId("interleave-alpha-1").outgoingMessageIndices, [0])
    assert.deepEqual(byId("interleave-beta-1").outgoingMessageIndices, [1])
    assert.deepEqual(byId("interleave-alpha-2").outgoingMessageIndices, [2])
})

test("keeps extra host-added system messages unclaimed without rejecting", () => {
    const projected = [
        { type: "system", id: "host-projected", time: { created: 1 }, text: "shared text" },
    ]
    const outgoing = [
        Message.make({ role: "system", content: "shared text" }),
        Message.make({ role: "system", content: "shared text" }),
    ]
    const projection = normalizeV2ProjectedHistory(projected, outgoing, {
        sessionID: "host-extra-system",
        currentModel: model,
    })
    // One projected record against two identical lowered messages previously rejected on
    // multiple candidates; it must claim the first match and leave the host-added duplicate
    // unclaimed rather than guess ownership.
    assert.equal(projection.valid, true)
    assert.equal(projection.rejection, undefined)
    const entry = projection.entries.find((e) => e.sourceMessageId === "host-projected")!
    assert.deepEqual(entry.outgoingMessageIndices, [0])
    assert.equal(entry.opaque, true)
    // The unclaimed duplicate must land provider-owned: fully opaque, not attributed
    // to any projected source, never editable by ACP patches.
    const extra = projection.outgoing[1]!
    assert.equal(extra.opaque, true)
    assert.equal(extra.owned, false)
    assert.equal(extra.sourceMessageId, undefined)
    assert.equal(extra.opaqueMessage, outgoing[1])
})

test("leaves host-added foreign system messages unclaimed when projected text differs", () => {
    const projected = [
        { type: "system", id: "foreign-projected", time: { created: 1 }, text: "projected text" },
    ]
    const outgoing = [
        Message.make({ role: "system", content: "projected text" }),
        Message.make({ role: "system", content: "host-added text" }),
    ]
    const projection = normalizeV2ProjectedHistory(projected, outgoing, {
        sessionID: "host-foreign-system",
        currentModel: model,
    })
    assert.equal(projection.valid, true)
    assert.equal(projection.rejection, undefined)
    const entry = projection.entries.find((e) => e.sourceMessageId === "foreign-projected")!
    assert.deepEqual(entry.outgoingMessageIndices, [0])
    // The foreign host message stays provider-owned and opaque, not attributed to
    // the projected source.
    const extra = projection.outgoing[1]!
    assert.equal(extra.opaque, true)
    assert.equal(extra.owned, false)
    assert.equal(extra.sourceMessageId, undefined)
})

test("still rejects ambiguous patchable sources that lack an exact lowered correlation", () => {
    const projected = [
        { type: "system", id: "guard-system", time: { created: 1 }, text: "system" },
        { type: "user", id: "guard-user", time: { created: 2 }, text: "user request" },
    ]
    const outgoing = [
        Message.make({ role: "system", content: "system" }),
        // No lowered counterpart exists for the patchable user source, so ACP must refuse
        // to guess rather than silently drop or mis-edit it.
    ]
    const projection = normalizeV2ProjectedHistory(projected, outgoing, {
        sessionID: "guard-reject",
        currentModel: model,
    })
    assert.equal(projection.valid, false)
    assert.ok(projection.rejection)
    if (projection.rejection)
        assert.match(projection.rejection.message, /no exact lowered outgoing match/i)
})
