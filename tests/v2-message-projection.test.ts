import "./test-env"
import assert from "node:assert/strict"
import test from "node:test"
import { Message } from "@opencode/ai"
import type { Message as AiMessage } from "@opencode/ai"
import { DateTime } from "effect"
import { Info as SessionMessageInfo } from "@opencode/schema/session-message"
import type { Info as SessionMessageInfoValue } from "@opencode/schema/session-message"
import {
    applyV2ContextPatch,
    normalizeV2ProjectedHistory,
    type V2Projection,
} from "../lib/v2/projection"

const MODEL = { id: "model-a", providerID: "provider-a" }
const SID = "v2-projection-session"

function textPart(text: string, metadata?: Record<string, unknown>) {
    return { type: "text" as const, text, ...(metadata ? { metadata } : {}) }
}

function userSource(
    id: string,
    text: string,
    extra: Record<string, unknown> = {},
): Record<string, unknown> {
    return { type: "user", id, time: { created: 1 }, text, ...extra }
}

function assistantSource(
    id: string,
    content: readonly Record<string, unknown>[],
    model = MODEL,
): Record<string, unknown> {
    return { type: "assistant", id, time: { created: 2 }, agent: "code", model, content }
}

function normalize(projected: readonly unknown[], outgoing: readonly AiMessage[]): V2Projection {
    return normalizeV2ProjectedHistory(projected, outgoing, {
        sessionID: SID,
        agent: "code",
        currentModel: MODEL,
    })
}

function validatePublicMessages(projected: readonly unknown[]): readonly unknown[] {
    for (const message of projected) {
        // The public transport form encodes DateTime values as epoch millis;
        // Info.make validates the corresponding schema/type form without
        // coupling the test to npm's physical dependency layout.
        SessionMessageInfo.make(toSchemaValue(message) as SessionMessageInfoValue)
    }
    return projected
}

function toSchemaValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((entry) => toSchemaValue(entry))
    if (!isRecord(value)) return value

    return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => {
            if (key !== "time" || !isRecord(entry)) return [key, toSchemaValue(entry)]
            return [
                key,
                Object.fromEntries(
                    Object.entries(entry).map(([timeKey, timeValue]) => [
                        timeKey,
                        typeof timeValue === "number"
                            ? DateTime.makeUnsafe(timeValue)
                            : toSchemaValue(timeValue),
                    ]),
                ),
            ]
        }),
    )
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
}

test("normalizes every public source category and derives assistant step markers", () => {
    const projected = [
        { type: "agent-switched", id: "msg_control-agent", time: { created: 0 }, agent: "code" },
        { type: "model-switched", id: "msg_control-model", time: { created: 0 }, model: MODEL },
        {
            type: "system",
            id: "msg_sys-1",
            time: { created: 1 },
            text: "operator system text",
        },
        userSource("msg_u-1", "user text", {
            skills: [{ id: "skill-1", name: "guide", text: "skill text" }],
            files: [
                {
                    data: Buffer.from("plain file").toString("base64"),
                    mime: "text/plain",
                    source: { type: "inline" },
                    name: "notes.txt",
                    description: "notes",
                },
                {
                    data: "aW1hZ2UtZGF0YQ==",
                    mime: "image/png",
                    source: { type: "inline" },
                    name: "screen.png",
                },
                {
                    data: "cGRmLWRhdGE=",
                    mime: "application/pdf",
                    source: { type: "uri", uri: "https://example.test/doc.pdf" },
                    name: "doc.pdf",
                },
                {
                    data: Buffer.from("src/main.ts").toString("base64"),
                    mime: "application/x-directory",
                    source: { type: "uri", uri: "file:///workspace/src" },
                    name: "src",
                },
            ],
        }),
        {
            type: "skill",
            id: "msg_skill-message",
            time: { created: 2 },
            skill: "skill-1",
            name: "guide",
            text: "resolved skill body",
        },
        {
            type: "shell",
            id: "msg_shell-1",
            time: { created: 3 },
            shellID: "sh_shell-1",
            command: "git status",
            status: "exited",
            output: { output: "clean", cursor: 5, size: 5, truncated: false },
        },
        {
            type: "location-switched",
            id: "msg_location-1",
            time: { created: 4 },
            location: { directory: "/workspace" },
        },
        { type: "synthetic", id: "msg_host-synthetic", time: { created: 5 }, text: "host notice" },
        assistantSource("msg_a-1", [
            { type: "reasoning", text: "private reasoning" },
            { type: "text", text: "assistant answer" },
        ]),
        { type: "idle", id: "msg_idle-1", time: { created: 6 }, outcome: "succeeded" },
    ]

    const attachmentMetadata = (file: Record<string, unknown>) => ({
        attachment: {
            source: file.source,
            name: file.name,
            description: file.description,
        },
    })
    const outgoing = [
        Message.make({
            role: "system",
            content: [textPart("operator system text")],
        }),
        Message.make({
            id: "msg_u-1",
            role: "user",
            content: [
                textPart("skill text"),
                textPart("user text"),
                textPart(
                    "\n\nAttached file: notes.txt\nDescription: notes\n\nplain file",
                    attachmentMetadata((projected[3] as Record<string, unknown>).files[0]),
                ),
                {
                    type: "media" as const,
                    mediaType: "image/png",
                    data: "aW1hZ2UtZGF0YQ==",
                    filename: "screen.png",
                },
                {
                    type: "media" as const,
                    mediaType: "application/pdf",
                    data: "cGRmLWRhdGE=",
                    filename: "doc.pdf",
                },
                textPart(
                    "\n\nAttached directory: file:///workspace/src\n\nsrc/main.ts",
                    attachmentMetadata((projected[3] as Record<string, unknown>).files[3]),
                ),
            ],
        }),
        Message.make({ id: "msg_skill-message", role: "user", content: "resolved skill body" }),
        Message.make({
            id: "msg_shell-1",
            role: "user",
            content:
                "The following shell command was executed by the user:\n\nCommand:\ngit status\n\nOutput:\nclean",
        }),
        Message.make({
            id: "msg_location-1",
            role: "user",
            content: "The working directory has been changed to /workspace.",
        }),
        Message.make({ id: "msg_host-synthetic", role: "user", content: "host notice" }),
        Message.make({
            id: "msg_a-1",
            role: "assistant",
            content: [
                { type: "reasoning", text: "private reasoning" },
                textPart("assistant answer"),
            ],
        }),
    ]

    const projection = normalize(validatePublicMessages(projected), outgoing)
    assert.equal(projection.valid, true)
    assert.deepEqual(
        projection.messages.map((message) => message.info.id),
        [
            "msg_sys-1",
            "msg_u-1",
            "msg_skill-message",
            "msg_shell-1",
            "msg_location-1",
            "msg_host-synthetic",
            "msg_a-1",
        ],
    )
    const assistant = projection.messages.find((message) => message.info.id === "msg_a-1")
    assert.ok(assistant)
    assert.equal(assistant.parts[0]?.type, "step-start")
    assert.equal(assistant.parts[1]?.type, "reasoning")
    assert.equal(assistant.parts[2]?.type, "text")
    const userEntry = projection.entries.find((entry) => entry.sourceMessageId === "msg_u-1")
    assert.ok(userEntry)
    assert.equal(userEntry.origins.filter((origin) => origin.kind === "attachment").length, 4)
    assert.equal(
        userEntry.origins
            .filter((origin) => origin.kind === "attachment")
            .every((origin) => origin.opaque),
        true,
    )
    assert.equal(projection.entries.find((entry) => entry.sourceType === "system")?.protected, true)
    assert.equal(
        projection.entries.some((entry) => entry.sourceType === "control"),
        false,
    )
})

test("correlates executed and separate role-tool results by call ID", () => {
    const projected = [
        userSource("msg_u-2", "request"),
        assistantSource("msg_a-2", [
            {
                type: "tool",
                id: "executed-call",
                name: "provider_tool",
                executed: true,
                state: {
                    status: "completed",
                    input: { value: 1 },
                    content: [{ type: "text", text: "provider output" }],
                    time: { start: 2, end: 3 },
                    metadata: { source: "provider" },
                },
                providerState: { checkpoint: "call" },
                providerResultState: { checkpoint: "result" },
                time: { created: 2 },
            },
            {
                type: "tool",
                id: "host-call",
                name: "host_tool",
                executed: false,
                state: {
                    status: "completed",
                    input: { value: 2 },
                    content: [{ type: "text", text: "host output" }],
                    time: { start: 2, end: 3 },
                    metadata: { source: "host" },
                },
                providerState: { checkpoint: "call" },
                providerResultState: { checkpoint: "result" },
                time: { created: 2 },
            },
        ]),
    ]
    const outgoing = [
        Message.make({ id: "msg_u-2", role: "user", content: "request" }),
        Message.make({
            id: "msg_a-2",
            role: "assistant",
            content: [
                {
                    type: "tool-call" as const,
                    id: "executed-call",
                    name: "provider_tool",
                    input: { value: 1 },
                    providerExecuted: true,
                    providerMetadata: { provider: { checkpoint: "keep" } },
                },
                {
                    type: "tool-result" as const,
                    id: "executed-call",
                    name: "provider_tool",
                    result: { type: "text" as const, value: "provider output" },
                    providerExecuted: true,
                },
                {
                    type: "tool-call" as const,
                    id: "host-call",
                    name: "host_tool",
                    input: { value: 2 },
                },
            ],
        }),
        Message.make({
            role: "tool",
            content: [
                {
                    type: "tool-result" as const,
                    id: "host-call",
                    name: "host_tool",
                    result: { type: "text" as const, value: "host output" },
                },
            ],
        }),
    ]
    const projection = normalize(validatePublicMessages(projected), outgoing)
    assert.equal(projection.valid, true)
    const entry = projection.entries.find((candidate) => candidate.sourceMessageId === "msg_a-2")
    assert.ok(entry)
    assert.deepEqual(entry.toolCallIds, ["executed-call", "host-call"])
    const executed = entry.origins.find((origin) => origin.callId === "executed-call")
    const separate = entry.origins.find((origin) => origin.callId === "host-call")
    assert.deepEqual(executed?.call, { messageIndex: 1, contentIndex: 0 })
    assert.deepEqual(executed?.result, { messageIndex: 1, contentIndex: 1 })
    assert.deepEqual(separate?.result, { messageIndex: 2, contentIndex: 0 })
    assert.equal(executed?.representableOutput, true)
    assert.equal(separate?.representableOutput, true)
})

test("rejects duplicate source/call IDs before a context patch can mutate output", () => {
    const projected = [
        userSource("duplicate", "one"),
        userSource("duplicate", "two"),
        assistantSource("assistant", [
            { type: "tool", id: "same-call", name: "a", state: { status: "running", input: {} } },
            { type: "tool", id: "same-call", name: "b", state: { status: "running", input: {} } },
        ]),
    ]
    const outgoing = [
        Message.make({ id: "duplicate", role: "user", content: "one" }),
        Message.make({
            id: "assistant",
            role: "assistant",
            content: [
                { type: "tool-call" as const, id: "same-call", name: "a", input: {} },
                { type: "tool-call" as const, id: "same-call", name: "b", input: {} },
            ],
        }),
    ]
    const projection = normalize(projected, outgoing)
    assert.equal(projection.valid, false)
    assert.equal(projection.rejection?.code, "duplicate-source-id")
    const result = applyV2ContextPatch(projection, projection.messages)
    assert.equal(result.accepted, false)
    if (!result.accepted) assert.equal(result.rejection.code, "projection-invalid")
})

test("records running, completed, failed, and provider-checkpoint compaction provenance", () => {
    const checkpoint = Message.make({
        id: "checkpoint-message",
        role: "assistant",
        content: [{ type: "text", text: "decoded provider checkpoint" }],
        providerMetadata: { provider: { opaque: true } },
    })
    const projected = [
        {
            type: "compaction",
            id: "msg_running-compaction",
            time: { created: 1 },
            status: "running",
            reason: "auto",
            summary: "pending",
            recent: "pending",
        },
        {
            type: "compaction",
            id: "msg_completed-compaction",
            time: { created: 2 },
            status: "completed",
            reason: "auto",
            summary: "summary",
            recent: "recent",
            providerContext: {
                version: 1,
                provenance: {
                    providerID: "provider-a",
                    provider: "provider-a",
                    modelID: "model-a",
                    route: "responses",
                    protocol: "openai-responses",
                    endpoint: "https://provider.example/v1/responses",
                },
                messages: [],
            },
            providerState: { checkpoint: "compaction" },
        },
        {
            type: "compaction",
            id: "msg_failed-compaction",
            time: { created: 3 },
            status: "failed",
            reason: "manual",
            error: { type: "error", message: "failed" },
        },
    ]
    const projection = normalize(validatePublicMessages(projected), [checkpoint])
    assert.equal(projection.valid, true)
    assert.equal(projection.messages.length, 1)
    assert.equal(
        projection.entries.find((entry) => entry.status === "running")?.normalizedMessageId,
        undefined,
    )
    assert.equal(
        projection.entries.find((entry) => entry.status === "failed")?.normalizedMessageId,
        undefined,
    )
    const providerEntry = projection.entries.find(
        (entry) => entry.sourceMessageId === "msg_completed-compaction",
    )
    assert.ok(providerEntry)
    assert.equal(providerEntry.sourceType, "provider-checkpoint")
    assert.equal(providerEntry.protected, true)
    assert.equal(providerEntry.outgoingMessageIndices[0], 0)
})

test("normalizes valid tool lifecycle states and preserves provider/file result data", () => {
    const projected = [
        userSource("msg_tools-user", "run the tools"),
        assistantSource("msg_tools-assistant", [
            {
                type: "tool",
                id: "running-call",
                name: "running",
                executed: false,
                state: {
                    status: "running",
                    input: { path: "a.ts" },
                    metadata: { phase: "running" },
                },
                providerState: { cursor: "run" },
                time: { created: 1 },
            },
            {
                type: "tool",
                id: "streaming-call",
                name: "streaming",
                executed: false,
                state: {
                    status: "streaming",
                    input: '{"path":"b.ts"}',
                },
                providerState: { cursor: "stream" },
                time: { created: 2 },
            },
            {
                type: "tool",
                id: "error-call",
                name: "error-tool",
                executed: false,
                state: {
                    status: "error",
                    input: { path: "c.ts" },
                    error: { type: "ToolError", message: "provider failed" },
                    content: [{ type: "text", text: "provider failed" }],
                },
                providerResultState: { retryable: true },
                time: { created: 3, ran: 4, completed: 5 },
            },
            {
                type: "tool",
                id: "file-call",
                name: "file-tool",
                executed: false,
                state: {
                    status: "completed",
                    input: { path: "out.txt" },
                    content: [
                        {
                            type: "file",
                            uri: "file:///tmp/out.txt",
                            mime: "text/plain",
                            name: "out.txt",
                        },
                    ],
                    metadata: { phase: "file" },
                },
                providerState: { cursor: "file" },
                providerResultState: { checksum: "abc" },
                time: { created: 5, ran: 6, completed: 7 },
            },
        ]),
    ]
    const outgoing = [
        Message.make({ id: "msg_tools-user", role: "user", content: "run the tools" }),
        Message.make({
            id: "msg_tools-assistant",
            role: "assistant",
            content: [
                {
                    type: "tool-call" as const,
                    id: "running-call",
                    name: "running",
                    input: { path: "a.ts" },
                    providerMetadata: { provider: { state: "running" } },
                },
                {
                    type: "tool-call" as const,
                    id: "streaming-call",
                    name: "streaming",
                    input: { path: "b.ts" },
                    providerMetadata: { provider: { state: "streaming" } },
                },
                {
                    type: "tool-call" as const,
                    id: "error-call",
                    name: "error-tool",
                    input: { path: "c.ts" },
                    providerMetadata: { provider: { state: "error" } },
                },
                {
                    type: "tool-call" as const,
                    id: "file-call",
                    name: "file-tool",
                    input: { path: "out.txt" },
                    providerMetadata: { provider: { state: "file" } },
                },
            ],
        }),
        Message.make({
            role: "tool",
            content: [
                {
                    type: "tool-result" as const,
                    id: "error-call",
                    name: "error-tool",
                    result: { type: "error" as const, value: "provider failed" },
                    providerMetadata: { provider: { resultState: { retryable: true } } },
                },
            ],
        }),
        Message.make({
            role: "tool",
            content: [
                {
                    type: "tool-result" as const,
                    id: "file-call",
                    name: "file-tool",
                    result: {
                        type: "content" as const,
                        value: [
                            {
                                type: "file" as const,
                                uri: "file:///tmp/out.txt",
                                mime: "text/plain",
                                name: "out.txt",
                            },
                        ],
                    },
                    providerMetadata: { provider: { resultState: { checksum: "abc" } } },
                },
            ],
        }),
    ]

    const projection = normalize(validatePublicMessages(projected), outgoing)
    assert.equal(projection.valid, true)
    const entry = projection.entries.find(
        (candidate) => candidate.sourceMessageId === "msg_tools-assistant",
    )
    assert.ok(entry)
    assert.deepEqual(entry.toolCallIds, [
        "running-call",
        "streaming-call",
        "error-call",
        "file-call",
    ])
    assert.equal(
        entry.origins.find((origin) => origin.callId === "running-call")?.normalizedInputHash
            ?.length,
        64,
    )
    assert.equal(entry.origins.find((origin) => origin.callId === "error-call")?.opaque, true)
    assert.equal(entry.origins.find((origin) => origin.callId === "file-call")?.opaque, true)
    const normalizedTools = entry.origins
        .filter((origin) => origin.kind === "tool")
        .map((origin) =>
            projection.messages[1]?.parts.find((part) => part.__acpOrigin === origin.key),
        )
    assert.deepEqual(
        normalizedTools.map((part) => part?.state?.status),
        ["running", "pending", "error", "completed"],
    )

    const result = applyV2ContextPatch(projection, structuredClone(projection.messages))
    assert.equal(result.accepted, true)
    if (!result.accepted) return
    const errorResult = result.messages
        .flatMap((message) => message.content)
        .find((part) => part.type === "tool-result" && part.id === "error-call")
    const fileResult = result.messages
        .flatMap((message) => message.content)
        .find((part) => part.type === "tool-result" && part.id === "file-call")
    assert.deepEqual(errorResult?.result, {
        type: "error",
        value: "provider failed",
    })
    assert.deepEqual(fileResult?.result, {
        type: "content",
        value: [
            {
                type: "file",
                uri: "file:///tmp/out.txt",
                mime: "text/plain",
                name: "out.txt",
            },
        ],
    })
    assert.deepEqual(
        result.messages
            .flatMap((message) => message.content)
            .find((part) => part.type === "tool-call" && part.id === "running-call")
            ?.providerMetadata,
        { provider: { state: "running" } },
    )
})

function switchCheckpoint(id: string): Record<string, unknown> {
    return {
        type: "compaction",
        id,
        time: { created: 1 },
        status: "completed",
        reason: "auto",
        summary: "earlier work summary",
        recent: "recent context tail",
        providerContext: {
            version: 1,
            provenance: {
                providerID: "provider-a",
                provider: "provider-a",
                modelID: "model-b",
                route: "responses",
                protocol: "openai-responses",
                endpoint: "https://provider.example/v1/responses",
            },
            messages: [],
        },
    }
}

test("keeps re-expanded originals uncorrelated when an incompatible model switch drops the checkpoint", () => {
    const projected = [
        switchCheckpoint("msg_switch-compaction"),
        userSource("msg_after-switch", "continue after the switch"),
    ]
    const originalUser = Message.make({
        id: "msg_original-user",
        role: "user",
        content: [{ type: "text", text: "original user request" }],
    })
    const originalAssistant = Message.make({
        id: "msg_original-assistant",
        role: "assistant",
        content: [{ type: "text", text: "original assistant reply" }],
    })
    const nextUser = Message.make({
        id: "msg_after-switch",
        role: "user",
        content: [{ type: "text", text: "continue after the switch" }],
    })
    const projection = normalize(validatePublicMessages(projected), [
        originalUser,
        originalAssistant,
        nextUser,
    ])
    assert.equal(projection.valid, true)
    const providerEntry = projection.entries.find(
        (entry) => entry.sourceMessageId === "msg_switch-compaction",
    )
    assert.ok(providerEntry)
    assert.equal(providerEntry.sourceType, "provider-checkpoint")
    assert.equal(providerEntry.providerCheckpoint, true)
    assert.equal(providerEntry.protected, true)
    // Two unclaimed candidates in the window mean the re-expanded originals;
    // claiming either by position would swallow host-owned content.
    assert.deepEqual(providerEntry.outgoingMessageIndices, [])
    const checkpointPart = projection.messages
        .flatMap((message) => message.parts ?? [])
        .find((part) => part.__acpOrigin === "source:0:checkpoint:source")
    assert.ok(checkpointPart)
    assert.equal(checkpointPart.__acpOpaque, true)
    const checkpointText = stringValue(checkpointPart.text)
    assert.ok(checkpointText.includes("<conversation-checkpoint>"))
    assert.ok(checkpointText.includes("earlier work summary"))
    assert.ok(checkpointText.includes("recent context tail"))
    assert.equal(projection.outgoing.length, 3)
    assert.equal(projection.outgoing[0].opaque, true)
    assert.equal(projection.outgoing[0].sourceMessageId, undefined)
    assert.equal(projection.outgoing[0].opaqueMessage, originalUser)
    assert.equal(projection.outgoing[1].opaque, true)
    assert.equal(projection.outgoing[1].opaqueMessage, originalAssistant)
    const afterEntry = projection.entries.find(
        (entry) => entry.sourceMessageId === "msg_after-switch",
    )
    assert.deepEqual(afterEntry?.outgoingMessageIndices, [2])

    const result = applyV2ContextPatch(projection, structuredClone(projection.messages))
    assert.equal(result.accepted, true)
    if (!result.accepted) return
    // The no-op transform keeps every outgoing message object-identical and
    // never injects the uncorrelated checkpoint into the request.
    assert.equal(result.messages.length, 3)
    assert.equal(result.messages[0], originalUser)
    assert.equal(result.messages[1], originalAssistant)
    assert.equal(result.messages[2], nextUser)
})

test("keeps claiming the single decoded checkpoint message in the compatible view", () => {
    const projected = [
        switchCheckpoint("msg_compat-checkpoint"),
        userSource("msg_compat-next", "next question"),
    ]
    const decoded = Message.make({
        id: "msg_decoded-checkpoint",
        role: "assistant",
        content: [{ type: "text", text: "decoded provider checkpoint" }],
    })
    const nextUser = Message.make({
        id: "msg_compat-next",
        role: "user",
        content: [{ type: "text", text: "next question" }],
    })
    const projection = normalize(validatePublicMessages(projected), [decoded, nextUser])
    assert.equal(projection.valid, true)
    const providerEntry = projection.entries.find(
        (entry) => entry.sourceMessageId === "msg_compat-checkpoint",
    )
    assert.ok(providerEntry)
    assert.deepEqual(providerEntry.outgoingMessageIndices, [0])
    const rendered = projection.messages
        .flatMap((message) => message.parts ?? [])
        .filter((part) => stringValue(part.__acpOrigin)?.startsWith("source:0:checkpoint:"))
    assert.equal(rendered.length, 1)
    assert.equal(stringValue(rendered[0]?.text), "decoded provider checkpoint")

    const result = applyV2ContextPatch(projection, structuredClone(projection.messages))
    assert.equal(result.accepted, true)
    if (!result.accepted) return
    assert.equal(result.messages.length, 2)
    assert.equal(result.messages[0], decoded)
    assert.equal(result.messages[1], nextUser)
})

test("renders the provider checkpoint from source data when the direct view has no outgoing history", () => {
    const projected = [
        switchCheckpoint("msg_direct-checkpoint"),
        userSource("msg_direct-after", "direct question"),
    ]
    const projection = normalize(validatePublicMessages(projected), [])
    // The direct view with non-checkpoint sources is rejected upstream; pin
    // the disclosed unsupported window so it stays visible to readers.
    assert.equal(projection.valid, false)
    if (projection.rejection) assert.equal(projection.rejection.code, "invalid-source")
    const providerEntry = projection.entries.find(
        (entry) => entry.sourceMessageId === "msg_direct-checkpoint",
    )
    assert.ok(providerEntry)
    assert.equal(providerEntry.sourceType, "provider-checkpoint")
    assert.deepEqual(providerEntry.outgoingMessageIndices, [])
    // The direct-tool view must still expose the checkpoint's summary and
    // recent context instead of normalizing it to zero parts.
    const checkpointPart = projection.messages
        .flatMap((message) => message.parts ?? [])
        .find((part) => part.__acpOrigin === "source:0:checkpoint:source")
    assert.ok(checkpointPart)
    assert.equal(checkpointPart.__acpOpaque, true)
    const checkpointText = stringValue(checkpointPart.text)
    assert.ok(checkpointText.includes("<conversation-checkpoint>"))
    assert.ok(checkpointText.includes("earlier work summary"))
    assert.ok(checkpointText.includes("recent context tail"))
    assert.equal(projection.messages.length, 2)
})

function providerCheckpointSource(id: string): Record<string, unknown> {
    return {
        type: "compaction",
        id,
        time: { created: 3 },
        status: "completed",
        reason: "auto",
        summary: "summary",
        recent: "recent",
        providerContext: {
            version: 1,
            provenance: {
                providerID: "provider-a",
                provider: "provider-a",
                modelID: "model-a",
                route: "responses",
                protocol: "openai-responses",
                endpoint: "https://provider.example/v1/responses",
            },
            messages: [],
        },
    }
}

function hostToolSource(id: string, callID: string): Record<string, unknown>[] {
    return [
        {
            type: "tool",
            id: callID,
            name: "host_tool",
            executed: false,
            state: {
                status: "completed",
                input: { value: 1 },
                content: [{ type: "text", text: "tool output" }],
                time: { start: 2, end: 3 },
                metadata: { source: "host" },
            },
            time: { created: 2 },
        },
    ]
}

test("keeps correlated tool results out of provider-checkpoint claims", () => {
    const projectedBase = [
        userSource("msg_u-456", "run it"),
        assistantSource("msg_a-456", hostToolSource("msg_a-456", "call-456")),
    ]
    const outgoing = [
        Message.make({ id: "msg_u-456", role: "user", content: "run it" }),
        Message.make({
            id: "msg_a-456",
            role: "assistant",
            content: [
                {
                    type: "tool-call" as const,
                    id: "call-456",
                    name: "host_tool",
                    input: { value: 1 },
                },
            ],
        }),
        Message.make({
            role: "tool",
            content: [
                {
                    type: "tool-result" as const,
                    id: "call-456",
                    name: "host_tool",
                    result: { type: "text" as const, value: "tool output" },
                },
            ],
        }),
    ]

    // Control: without providerContext the compaction is a plain source and
    // the role=tool result correlates to the assistant call directly.
    const plain = normalize(
        validatePublicMessages([
            ...projectedBase,
            { ...providerCheckpointSource("msg_c-plain"), providerContext: undefined },
        ]),
        outgoing,
    )
    assert.equal(plain.valid, true)
    const plainOrigin = plain.entries
        .find((entry) => entry.sourceMessageId === "msg_a-456")
        ?.origins.find((origin) => origin.callId === "call-456")
    assert.deepEqual(plainOrigin?.result, { messageIndex: 2, contentIndex: 0 })
    assert.equal(plainOrigin?.originalContent.length, 2)

    // With providerContext the checkpoint must not swallow the correlated
    // role=tool result; exact correlation stays valid for the session.
    const projection = normalize(
        validatePublicMessages([...projectedBase, providerCheckpointSource("msg_c-456")]),
        outgoing,
    )
    assert.equal(projection.valid, true)
    const assistantEntry = projection.entries.find((entry) => entry.sourceMessageId === "msg_a-456")
    assert.ok(assistantEntry)
    assert.deepEqual(assistantEntry.outgoingMessageIndices, [1, 2])
    const origin = assistantEntry.origins.find((candidate) => candidate.callId === "call-456")
    assert.ok(origin)
    assert.deepEqual(origin.result, { messageIndex: 2, contentIndex: 0 })
    assert.equal(origin.originalContent.length, 2)

    // The checkpoint window consisted solely of the reserved result, so the
    // checkpoint decoded nothing: disclosed structurally, no normalized turn.
    const checkpointEntry = projection.entries.find(
        (entry) => entry.sourceMessageId === "msg_c-456",
    )
    assert.ok(checkpointEntry)
    assert.equal(checkpointEntry.sourceType, "provider-checkpoint")
    assert.equal(checkpointEntry.providerCheckpoint, true)
    assert.deepEqual(checkpointEntry.outgoingMessageIndices, [])
    assert.equal(checkpointEntry.normalizedMessageId, undefined)
    assert.deepEqual(checkpointEntry.origins, [])
    assert.equal(projection.messages.length, 2)

    // ACP stays alive: the patch accepts and keeps every outgoing message,
    // including the tool result, object-identical.
    const result = applyV2ContextPatch(projection, structuredClone(projection.messages))
    assert.equal(result.accepted, true)
    if (!result.accepted) return
    assert.equal(result.messages.length, 3)
    for (let index = 0; index < outgoing.length; index++) {
        assert.equal(result.messages[index], outgoing[index])
    }
})

test("lets a provider checkpoint claim its tool-free remainder beside a reserved result", () => {
    const projected = [
        userSource("msg_u-457", "run it"),
        assistantSource("msg_a-457", hostToolSource("msg_a-457", "call-457")),
        providerCheckpointSource("msg_c-457"),
    ]
    const outgoing = [
        Message.make({ id: "msg_u-457", role: "user", content: "run it" }),
        Message.make({
            id: "msg_a-457",
            role: "assistant",
            content: [
                {
                    type: "tool-call" as const,
                    id: "call-457",
                    name: "host_tool",
                    input: { value: 1 },
                },
            ],
        }),
        Message.make({
            role: "tool",
            content: [
                {
                    type: "tool-result" as const,
                    id: "call-457",
                    name: "host_tool",
                    result: { type: "text" as const, value: "tool output" },
                },
            ],
        }),
        Message.make({
            id: "msg_decoded-457",
            role: "assistant",
            content: [{ type: "text", text: "decoded provider checkpoint" }],
        }),
    ]
    const projection = normalize(validatePublicMessages(projected), outgoing)
    assert.equal(projection.valid, true)
    const assistantEntry = projection.entries.find((entry) => entry.sourceMessageId === "msg_a-457")
    assert.ok(assistantEntry)
    assert.deepEqual(assistantEntry.outgoingMessageIndices, [1, 2])
    const origin = assistantEntry.origins.find((candidate) => candidate.callId === "call-457")
    assert.ok(origin)
    assert.deepEqual(origin.result, { messageIndex: 2, contentIndex: 0 })
    assert.equal(origin.originalContent.length, 2)
    // The reserved result stays with the assistant; the checkpoint keeps the
    // tool-free remainder of its window.
    const checkpointEntry = projection.entries.find(
        (entry) => entry.sourceMessageId === "msg_c-457",
    )
    assert.ok(checkpointEntry)
    assert.deepEqual(checkpointEntry.outgoingMessageIndices, [3])
    const rendered = projection.messages
        .flatMap((message) => message.parts ?? [])
        .filter((part) => stringValue(part.__acpOrigin)?.startsWith("source:2:checkpoint:"))
    assert.equal(rendered.length, 1)
    assert.equal(stringValue(rendered[0]?.text), "decoded provider checkpoint")
})

function stringValue(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined
}
