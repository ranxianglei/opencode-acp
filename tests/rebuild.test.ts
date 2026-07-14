import assert from "node:assert/strict"
import test from "node:test"
import { rebuildCompressionState } from "../lib/state/rebuild"
import { createSessionState } from "../lib/state/state"
import { assignMessageRefs } from "../lib/message-ids"
import { Logger } from "../lib/logger"
import type { PluginConfig } from "../lib/config"
import type { SessionState, WithParts } from "../lib/state/types"

const logger = new Logger(false)

const SID = "session-rebuild-test"

function buildConfig(overrides: Partial<PluginConfig> = {}): PluginConfig {
    const base: PluginConfig = {
        enabled: true,
        autoUpdate: true,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: { enabled: true, protectedTools: [] },
        manualMode: { enabled: false, automaticStrategies: true },
        turnProtection: { enabled: false, turns: 4 },
        experimental: { allowSubAgents: false, customPrompts: false },
        protectedFilePatterns: [],
        compress: {
            mode: "range",
            permission: "allow",
            showCompression: false,
            summaryBuffer: true,
            maxContextLimit: 150000,
            minContextLimit: 50000,
            nudgeFrequency: 5,
            minNudgeContextPercent: 20,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: ["task"],
            protectTags: false,
            protectUserMessages: false,
            maxSummaryLengthHard: 10000,
            minCompressRange: 0,
            maxVisibleSegments: 3,
        },
        strategies: {
            deduplication: { enabled: true, protectedTools: [] },
            purgeErrors: { enabled: true, turns: 4, protectedTools: [] },
        },
    }
    return { ...base, ...overrides }
}

let msgCounter = 0
function nextId(): string {
    return `msg-rebuild-${++msgCounter}`
}

function makeUserMessage(id: string, text: string): WithParts {
    return {
        info: {
            id,
            sessionID: SID,
            role: "user",
            agent: "assistant",
            time: { created: Date.now() },
            model: { providerID: "test-provider", modelID: "test-model" },
        } as WithParts["info"],
        parts: [{ type: "text", text, id: `${id}-p1`, sessionID: SID, messageID: id }],
    }
}

function makeAssistantMessage(id: string, parts: any[]): WithParts {
    return {
        info: {
            id,
            sessionID: SID,
            role: "assistant",
            agent: "test",
            time: { created: Date.now() },
            parentID: "parent-1",
            modelID: "test-model",
            providerID: "test-provider",
            mode: "normal",
            path: { cwd: "/", root: "/" },
            summary: false,
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        } as WithParts["info"],
        parts,
    }
}

function makeTextPart(text: string): any {
    return { type: "text", text }
}

function makeCompressPart(
    callId: string,
    input: any,
): any {
    return {
        type: "tool",
        tool: "compress",
        callID: callId,
        state: {
            status: "completed",
            input,
            output: "Compressed messages into [Compressed conversation section].",
        },
    }
}

function makeToolPart(callId: string, tool: string, input?: any): any {
    return {
        type: "tool",
        tool,
        callID: callId,
        state: { status: "completed", ...(input !== undefined ? { input } : {}) },
    }
}

function freshState(): SessionState {
    msgCounter = 0
    return createSessionState()
}


test("rebuild returns 0 and makes no state changes when no compress parts exist", () => {
    const state = freshState()
    const messages = [
        makeUserMessage(nextId(), "hello"),
        makeAssistantMessage(nextId(), [makeTextPart("hi there")]),
    ]
    const config = buildConfig()

    const result = rebuildCompressionState(state, messages, config, logger)

    assert.equal(result, 0)
    assert.equal(state.prune.messages.blocksById.size, 0)
    assert.equal(state.prune.messages.byMessageId.size, 0)
})

test("rebuild reconstructs a single range compression block from history", () => {
    const state = freshState()
    const id1 = nextId()
    const id2 = nextId()
    const id3 = nextId()
    const id4 = nextId()
    const compressMsgId = nextId()

    const messages: WithParts[] = [
        makeUserMessage(id1, "hello"),
        makeAssistantMessage(id2, [makeTextPart("hi")]),
        makeUserMessage(id3, "do a task"),
        makeAssistantMessage(id4, [makeTextPart("doing it")]),
        makeAssistantMessage(compressMsgId, [
            makeCompressPart("call-1", {
                topic: "Intro chat",
                content: [
                    {
                        startId: "m00001",
                        endId: "m00004",
                        summary: "User greeted and started a task.",
                    },
                ],
            }),
        ]),
    ]

    const config = buildConfig()
    const result = rebuildCompressionState(state, messages, config, logger)

    assert.equal(result, 1, "should create exactly 1 block")
    assert.equal(state.prune.messages.blocksById.size, 1)

    const block = state.prune.messages.blocksById.get(1)!
    assert.equal(block.active, true)
    assert.equal(block.mode, "range")
    assert.equal(block.topic, "Intro chat")
    assert.equal(block.compressMessageId, compressMsgId)
    assert.equal(block.compressCallId, "call-1")
    assert.ok(block.summary.includes("[Compressed conversation section]"))
    assert.ok(block.summary.includes("User greeted and started a task."))

    for (const id of [id1, id2, id3, id4]) {
        const entry = state.prune.messages.byMessageId.get(id)
        assert.ok(entry, `message ${id} should be in byMessageId`)
        assert.ok(entry!.activeBlockIds.includes(1), `message ${id} should have block 1 active`)
    }

    assert.ok(!state.prune.messages.byMessageId.has(compressMsgId))

    assert.equal(state.prune.messages.activeByAnchorMessageId.get(id1), 1)

    assert.equal(state.messageIds.byRawId.get(id1), "m00001")
    assert.equal(state.messageIds.byRawId.get(id4), "m00004")
})

test("rebuild handles fork: new message IDs but same mNNNNN refs resolve correctly", () => {
    // Simulate a fork: the compress part references m00001-m00003 (position-based refs),
    // but the actual raw IDs are different from the "original" session.
    const state = freshState()
    const forkId1 = "msg_fork_001"
    const forkId2 = "msg_fork_002"
    const forkId3 = "msg_fork_003"
    const forkCompressId = "msg_fork_004"

    const messages: WithParts[] = [
        makeUserMessage(forkId1, "original message content"),
        makeAssistantMessage(forkId2, [makeTextPart("response")]),
        makeUserMessage(forkId3, "another message"),
        makeAssistantMessage(forkCompressId, [
            makeCompressPart("fork-call-1", {
                topic: "Fork recovery",
                content: [
                    {
                        startId: "m00001",
                        endId: "m00003",
                        summary: "Compressed fork messages.",
                    },
                ],
            }),
        ]),
    ]

    const config = buildConfig()
    const result = rebuildCompressionState(state, messages, config, logger)

    assert.equal(result, 1)
    for (const id of [forkId1, forkId2, forkId3]) {
        const entry = state.prune.messages.byMessageId.get(id)
        assert.ok(entry, `fork message ${id} should be compressed`)
        assert.ok(entry!.activeBlockIds.includes(1))
    }
    assert.equal(state.messageIds.byRawId.get(forkId1), "m00001")
    assert.equal(state.messageIds.byRawId.get(forkId3), "m00003")
})

test("rebuild deactivates consumed blocks in nested compression (b1 consumed by b2)", () => {
    const state = freshState()
    const id1 = nextId()
    const id2 = nextId()
    const id3 = nextId()
    const id4 = nextId()
    const firstCompressId = nextId()
    const id6 = nextId()
    const id7 = nextId()
    const secondCompressId = nextId()

    const messages: WithParts[] = [
        makeUserMessage(id1, "msg one"),
        makeAssistantMessage(id2, [makeTextPart("msg two")]),
        makeUserMessage(id3, "msg three"),
        makeAssistantMessage(id4, [makeTextPart("msg four")]),
        // First compress: m00001-m00004 → block b1
        makeAssistantMessage(firstCompressId, [
            makeCompressPart("call-1", {
                topic: "First batch",
                content: [{ startId: "m00001", endId: "m00004", summary: "First four messages." }],
            }),
        ]),
        makeUserMessage(id6, "msg six"),
        makeAssistantMessage(id7, [makeTextPart("msg seven")]),
        // Second compress: b1..m00007 → block b2 (consumes b1)
        makeAssistantMessage(secondCompressId, [
            makeCompressPart("call-2", {
                topic: "Second batch",
                content: [{ startId: "b1", endId: "m00007", summary: "Expanded summary covering all." }],
            }),
        ]),
    ]

    const config = buildConfig()
    const result = rebuildCompressionState(state, messages, config, logger)

    assert.equal(result, 2, "should create 2 blocks")

    const b1 = state.prune.messages.blocksById.get(1)!
    const b2 = state.prune.messages.blocksById.get(2)!

    assert.equal(b1.active, false, "b1 should be inactive after being consumed by b2")
    assert.ok(b1.parentBlockIds.includes(2), "b1 should list b2 as parent")

    assert.equal(b2.active, true, "b2 should be active")

    assert.ok(!state.prune.messages.activeBlockIds.has(1))
    assert.ok(state.prune.messages.activeBlockIds.has(2))

    // b2 reuses id1 as anchor (same position), so id1 should map to b2 now
    assert.equal(state.prune.messages.activeByAnchorMessageId.get(id1), 2)

    for (const id of [id1, id2, id3, id4, id6, id7]) {
        const entry = state.prune.messages.byMessageId.get(id)
        assert.ok(entry, `message ${id} should be in byMessageId`)
    }
})

test("rebuild handles message-mode compression", () => {
    const state = freshState()
    const id1 = nextId()
    const id2 = nextId()
    const compressMsgId = nextId()

    const messages: WithParts[] = [
        makeUserMessage(id1, "message to compress individually"),
        makeAssistantMessage(id2, [makeTextPart("another individual message")]),
        makeAssistantMessage(compressMsgId, [
            makeCompressPart("call-msg-1", {
                topic: "Individual summaries",
                content: [
                    { messageId: "m00001", topic: "Msg 1", summary: "Summary of msg 1." },
                    { messageId: "m00002", topic: "Msg 2", summary: "Summary of msg 2." },
                ],
            }),
        ]),
    ]

    const config = buildConfig({ compress: { ...buildConfig().compress, mode: "message" } })
    const result = rebuildCompressionState(state, messages, config, logger)

    assert.equal(result, 2, "should create 2 message-mode blocks")

    const b1 = state.prune.messages.blocksById.get(1)!
    const b2 = state.prune.messages.blocksById.get(2)!

    assert.equal(b1.mode, "message")
    assert.equal(b2.mode, "message")
    assert.equal(b1.runId, b2.runId, "both blocks share the same runId")

    assert.ok(state.prune.messages.byMessageId.get(id1)?.activeBlockIds.includes(1))
    assert.ok(state.prune.messages.byMessageId.get(id2)?.activeBlockIds.includes(2))
})

test("rebuild excludes protected tool messages from compression (Bug 39 parity)", () => {
    const state = freshState()
    const userMsgId = nextId()
    const protectedToolMsgId = nextId()
    const normalMsgId = nextId()
    const compressMsgId = nextId()

    const messages: WithParts[] = [
        makeUserMessage(userMsgId, "user message"),
        // Message containing a protected tool call (task)
        makeAssistantMessage(protectedToolMsgId, [
            makeToolPart("task-call-1", "task", { prompt: "do something" }),
        ]),
        makeAssistantMessage(normalMsgId, [makeTextPart("normal assistant message")]),
        makeAssistantMessage(compressMsgId, [
            makeCompressPart("call-1", {
                topic: "With protected tool",
                content: [
                    {
                        startId: "m00001",
                        endId: "m00003",
                        summary: "Compressed range including protected tool.",
                    },
                ],
            }),
        ]),
    ]

    const config = buildConfig({
        compress: { ...buildConfig().compress, protectedTools: ["task"] },
    })
    const result = rebuildCompressionState(state, messages, config, logger)

    assert.equal(result, 1)

    assert.ok(state.prune.messages.byMessageId.get(userMsgId)?.activeBlockIds.includes(1))
    assert.ok(state.prune.messages.byMessageId.get(normalMsgId)?.activeBlockIds.includes(1))

    // protectedToolMsgId should NOT be compressed (hard-excluded by Bug 39)
    const protectedEntry = state.prune.messages.byMessageId.get(protectedToolMsgId)
    assert.ok(
        !protectedEntry || !protectedEntry.activeBlockIds.includes(1),
        "protected tool message should not be in the compression block",
    )
})

test("rebuild gracefully skips malformed compress invocations", () => {
    const state = freshState()
    const id1 = nextId()
    const id2 = nextId()
    const malformedCompressId = nextId()
    const validCompressId = nextId()

    const messages: WithParts[] = [
        makeUserMessage(id1, "message one"),
        makeAssistantMessage(id2, [makeTextPart("message two")]),
        // Malformed: missing content array
        makeAssistantMessage(malformedCompressId, [
            makeCompressPart("call-bad", { topic: "Bad" }),
        ]),
        // Valid compress
        makeAssistantMessage(validCompressId, [
            makeCompressPart("call-good", {
                topic: "Good batch",
                content: [{ startId: "m00001", endId: "m00002", summary: "Valid summary." }],
            }),
        ]),
    ]

    const config = buildConfig()
    const result = rebuildCompressionState(state, messages, config, logger)

    assert.equal(result, 1)
    assert.ok(state.prune.messages.byMessageId.get(id1)?.activeBlockIds.includes(1))
})

test("rebuild skips compress parts that are not completed", () => {
    const state = freshState()
    const id1 = nextId()
    const pendingCompressId = nextId()

    const messages: WithParts[] = [
        makeUserMessage(id1, "hello"),
        makeAssistantMessage(pendingCompressId, [
            {
                type: "tool",
                tool: "compress",
                callID: "call-pending",
                state: {
                    status: "running",
                    input: {
                        topic: "Pending",
                        content: [{ startId: "m00001", endId: "m00001", summary: "..." }],
                    },
                },
            },
        ]),
    ]

    const config = buildConfig()
    const result = rebuildCompressionState(state, messages, config, logger)

    assert.equal(result, 0, "should not rebuild from non-completed compress parts")
    assert.equal(state.prune.messages.blocksById.size, 0)
})

test("rebuild assigns refs idempotently — safe to call assignMessageRefs again after", () => {
    const state = freshState()
    const id1 = nextId()
    const id2 = nextId()
    const compressId = nextId()

    const messages: WithParts[] = [
        makeUserMessage(id1, "msg"),
        makeAssistantMessage(id2, [makeTextPart("reply")]),
        makeAssistantMessage(compressId, [
            makeCompressPart("call-1", {
                topic: "Test",
                content: [{ startId: "m00001", endId: "m00002", summary: "Summary." }],
            }),
        ]),
    ]

    const config = buildConfig()
    rebuildCompressionState(state, messages, config, logger)

    const assigned = assignMessageRefs(state, messages)
    assert.equal(assigned, 0, "assignMessageRefs should not re-assign existing refs")
    assert.equal(state.messageIds.byRawId.get(id1), "m00001")
})
