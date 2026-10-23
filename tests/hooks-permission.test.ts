import "./test-env"
import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import {
    createChatMessageTransformHandler,
    createCommandExecuteHandler,
    createEventHandler,
    createTextCompleteHandler,
} from "../lib/hooks"
import { Logger } from "../lib/logger"
import {
    createSessionState,
    ensureSessionInitialized,
    saveSessionState,
    type WithParts,
} from "../lib/state"
import { createTestRegistry } from "./registry-stub"

function buildConfig(permission: "allow" | "ask" | "deny" = "allow"): PluginConfig {
    return {
        enabled: true,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: {
            enabled: true,
            protectedTools: [],
        },
        experimental: {
            allowSubAgents: false,
            customPrompts: false,
        },
        protectedFilePatterns: [],
        compress: {
            mode: "message",
            permission,
            showCompression: false,
            maxContextLimit: 150000,
            minContextLimit: 50000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: ["task"],
            protectTags: false,
            protectUserMessages: false,
        },
        gc: {
            algorithm: "truncate",
            promotionThreshold: 5,
            maxBlockAge: 15,
            maxOldGenSummaryLength: 3000,
            majorGcThresholdPercent: "100%",
            batchCleanup: { lowThreshold: "60%", highThreshold: "75%", forceThreshold: "90%" },
        },
    }
}

function buildMessage(id: string, role: "user" | "assistant", text: string): WithParts {
    return {
        info: {
            id,
            role,
            sessionID: "session-1",
            agent: "assistant",
            time: { created: 1 },
        } as WithParts["info"],
        parts: [
            {
                id: `${id}-part`,
                messageID: id,
                sessionID: "session-1",
                type: "text",
                text,
            },
        ],
    }
}

test("chat message transform strips hallucinated tags even when compress is denied", async () => {
    const state = createSessionState()
    const logger = new Logger(false)
    const config = buildConfig("deny")
    const handler = createChatMessageTransformHandler(
        { session: { get: async () => ({}) } } as any,
        createTestRegistry(state),
        logger,
        config,
        {
            reload() {},
            getRuntimePrompts() {
                return {} as any
            },
        } as any,
        { global: undefined, agents: {} },
    )
    const output = {
        messages: [buildMessage("assistant-1", "assistant", "alpha <dcp>beta</dcp> omega")],
    }

    await handler({}, output)

    assert.equal(output.messages[0]?.parts[0]?.type, "text")
    assert.equal((output.messages[0]?.parts[0] as any).text, "alpha  omega")
})

test("chat message transform drops messages without info instead of crashing", async () => {
    const state = createSessionState()
    const logger = new Logger(false)
    const config = buildConfig("deny")
    const handler = createChatMessageTransformHandler(
        { session: { get: async () => ({}) } } as any,
        createTestRegistry(state),
        logger,
        config,
        {
            reload() {},
            getRuntimePrompts() {
                return {} as any
            },
        } as any,
        { global: undefined, agents: {} },
    )
    const output = {
        messages: [
            {
                role: "user",
                time: 1,
                parts: [
                    {
                        type: "text",
                        text: "Carica le skill di laravel",
                    },
                ],
            } as any,
        ],
    }

    await handler({}, output as any)

    assert.equal(state.sessionId, null)
    assert.equal(output.messages.length, 0)
})

test("command execute works even when effective permission resolves to deny (informational commands)", async () => {
    let sessionMessagesCalls = 0
    const output = { parts: [] as any[] }
    const handler = createCommandExecuteHandler(
        {
            session: {
                messages: async () => {
                    sessionMessagesCalls += 1
                    return { data: [] }
                },
            },
        } as any,
        createTestRegistry(createSessionState()),
        new Logger(false),
        buildConfig("deny"),
        "/tmp",
        { global: undefined, agents: {} },
    )

    // /acp (no args) now shows compression status — works regardless of compress permission.
    // Since #398 the abort is deterministic: only a throw stops opencode from sending
    // the arguments to the model, so the hook MUST reject with the sentinel.
    await expectAbortedAfterNotification(handler, "", "dcp")

    assert.equal(sessionMessagesCalls, 1)
})

// Minimal shape of the session.prompt call ACP sends for ignored notifications
// (see sendIgnoredMessage in lib/ui/notification.ts).
type IgnoredPromptCall = {
    path: { id: string }
    body: { noReply?: boolean; parts?: Array<{ type: string; text: string; ignored?: boolean }> }
}

function createCommandHarness(permission: string = "allow") {
    let sessionMessagesCalls = 0
    const prompts: IgnoredPromptCall[] = []
    const client = {
        session: {
            messages: async () => {
                sessionMessagesCalls += 1
                return { data: [] }
            },
            prompt: async (args: IgnoredPromptCall) => {
                prompts.push(args)
                return {}
            },
        },
    }
    const handler = createCommandExecuteHandler(
        client as any,
        createTestRegistry(createSessionState()),
        new Logger(false),
        buildConfig(permission),
        "/tmp",
        { global: undefined, agents: {} },
    )
    return { handler, prompts, calls: () => sessionMessagesCalls }
}

// Regression guard for #398 (reverts PR #297): opencode's Plugin.trigger only
// aborts a command when the hook THROWS — a normal return lets opencode append
// the raw arguments to the empty command template and send them to the model
// ("/acp status" leaked a user message "status", triggering a spurious ~40K-token
// model call). Every handled /acp branch MUST reject with
// __DCP_CONTEXT_HANDLED__ after delivering its ignored notification.
async function expectAbortedAfterNotification(
    handler: ReturnType<typeof createCommandExecuteHandler>,
    args: string,
    command: string = "acp",
): Promise<void> {
    await assert.rejects(
        () => handler({ command, sessionID: "session-1", arguments: args }, { parts: [] }),
        (e: unknown) => e instanceof Error && e.message === "__DCP_CONTEXT_HANDLED__",
    )
}

test("command execute aborts every handled /acp branch by throwing (regression guard #398)", async () => {
    // Each form must reject with __DCP_CONTEXT_HANDLED__ AND have delivered its
    // ignored notification first (proves the branch ran, then aborted — not swallowed).
    for (const args of ["stats", "status", "", "context", "help", "export --stdout"]) {
        const { handler, prompts, calls } = createCommandHarness()
        await expectAbortedAfterNotification(handler, args)
        assert.ok(
            prompts.length >= 1,
            `/acp ${args || "(bare)"} should send its ignored notification before aborting`,
        )
        assert.equal(prompts[0].body.noReply, true)
        assert.equal(prompts[0].body.parts[0].ignored, true)
        assert.equal(prompts[0].path.id, "session-1")
        assert.equal(calls(), 1, `/acp ${args || "(bare)"} should fetch session messages exactly once`)
    }
})

test("command execute passes through non-acp commands without throwing", async () => {
    const { handler } = createCommandHarness()
    await assert.doesNotReject(
        () => handler({ command: "other", sessionID: "session-1", arguments: "" }, { parts: [] }),
    )
})

test("text complete strips hallucinated metadata tags", async () => {
    const state = createSessionState()
    state.sessionId = "session-1"
    const handler = createTextCompleteHandler(createTestRegistry(state), new Logger(false))
    const output = {
        text: 'alpha<dcp-message-id tokens="1" type="text">m00001</dcp-message-id>omega',
    }

    await handler({ sessionID: "session-1", messageID: "message-1", partID: "part-1" }, output)

    assert.equal(output.text, "alphaomega")
})

test("event hook attaches durations to matching blocks by message and call id", async () => {
    const state = createSessionState()
    state.sessionId = "session-1"
    const handler = createEventHandler(createTestRegistry(state), new Logger(false))
    const originalNow = Date.now
    Date.now = () => 100

    try {
        await handler({
            event: {
                type: "message.part.updated",
                properties: {
                    part: {
                        type: "tool",
                        tool: "compress",
                        callID: "call-1",
                        messageID: "message-1",
                        sessionID: "session-1",
                        state: {
                            status: "pending",
                            input: {},
                            raw: "",
                        },
                    },
                },
            },
        })

        await handler({
            event: {
                type: "message.part.updated",
                properties: {
                    part: {
                        type: "tool",
                        tool: "compress",
                        callID: "call-2",
                        messageID: "message-1",
                        sessionID: "session-1",
                        state: {
                            status: "pending",
                            input: {},
                            raw: "",
                        },
                    },
                },
            },
        })

        await handler({
            event: {
                type: "message.part.updated",
                properties: {
                    part: {
                        type: "tool",
                        tool: "compress",
                        callID: "call-1",
                        messageID: "message-1",
                        sessionID: "session-1",
                        state: {
                            status: "running",
                            input: {},
                            time: { start: 325 },
                        },
                    },
                },
            },
        })

        await handler({
            event: {
                type: "message.part.updated",
                properties: {
                    part: {
                        type: "tool",
                        tool: "compress",
                        callID: "call-2",
                        messageID: "message-1",
                        sessionID: "session-1",
                        state: {
                            status: "running",
                            input: {},
                            time: { start: 410 },
                        },
                    },
                },
            },
        })
        state.prune.messages.blocksById.set(1, {
            blockId: 1,
            runId: 1,
            active: true,
            deactivatedByUser: false,
            compressedTokens: 0,
            summaryTokens: 0,
            durationMs: 0,
            mode: "message",
            topic: "one",
            batchTopic: "one",
            startId: "m00001",
            endId: "m00001",
            anchorMessageId: "msg-a",
            compressMessageId: "message-1",
            compressCallId: "call-1",
            includedBlockIds: [],
            consumedBlockIds: [],
            parentBlockIds: [],
            directMessageIds: [],
            directToolIds: [],
            effectiveMessageIds: ["msg-a"],
            effectiveToolIds: [],
            createdAt: 1,
            summary: "a",
        })
        state.prune.messages.blocksById.set(2, {
            blockId: 2,
            runId: 2,
            active: true,
            deactivatedByUser: false,
            compressedTokens: 0,
            summaryTokens: 0,
            durationMs: 0,
            mode: "message",
            topic: "two",
            batchTopic: "two",
            startId: "m00002",
            endId: "m00002",
            anchorMessageId: "msg-b",
            compressMessageId: "message-1",
            compressCallId: "call-2",
            includedBlockIds: [],
            consumedBlockIds: [],
            parentBlockIds: [],
            directMessageIds: [],
            directToolIds: [],
            effectiveMessageIds: ["msg-b"],
            effectiveToolIds: [],
            createdAt: 2,
            summary: "b",
        })

        await handler({
            event: {
                type: "message.part.updated",
                properties: {
                    part: {
                        type: "tool",
                        tool: "compress",
                        callID: "call-2",
                        messageID: "message-1",
                        sessionID: "session-1",
                        state: {
                            status: "completed",
                            input: {},
                            output: "done",
                            title: "",
                            metadata: {},
                            time: { start: 410, end: 500 },
                        },
                    },
                },
            },
        })

        await handler({
            event: {
                type: "message.part.updated",
                properties: {
                    part: {
                        type: "tool",
                        tool: "compress",
                        callID: "call-1",
                        messageID: "message-1",
                        sessionID: "session-1",
                        state: {
                            status: "completed",
                            input: {},
                            output: "done",
                            title: "",
                            metadata: {},
                            time: { start: 325, end: 500 },
                        },
                    },
                },
            },
        })
    } finally {
        Date.now = originalNow
    }

    assert.equal(state.prune.messages.blocksById.get(1)?.durationMs, 225)
    assert.equal(state.prune.messages.blocksById.get(2)?.durationMs, 310)
})

test("event hook falls back to completed runtime when running duration missing", async () => {
    const state = createSessionState()
    state.sessionId = "session-1"
    const handler = createEventHandler(createTestRegistry(state), new Logger(false))

    state.prune.messages.blocksById.set(1, {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        summaryTokens: 0,
        durationMs: 0,
        mode: "message",
        topic: "one",
        batchTopic: "one",
        startId: "m00001",
        endId: "m00001",
        anchorMessageId: "msg-a",
        compressMessageId: "message-1",
        compressCallId: "call-3",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: ["msg-a"],
        effectiveToolIds: [],
        createdAt: 1,
        summary: "a",
    })

    await handler({
        event: {
            type: "message.part.updated",
            properties: {
                part: {
                    type: "tool",
                    tool: "compress",
                    callID: "call-3",
                    messageID: "message-1",
                    sessionID: "session-1",
                    state: {
                        status: "completed",
                        input: {},
                        output: "done",
                        title: "",
                        metadata: {},
                        time: { start: 500, end: 940 },
                    },
                },
            },
        },
    })

    assert.equal(state.prune.messages.blocksById.get(1)?.durationMs, 440)
})

test("event hook queues duration updates until the matching session is loaded", async () => {
    const logger = new Logger(false)
    const targetSessionId = `session-target-${process.pid}-${Date.now()}`
    const otherSessionId = `session-other-${process.pid}-${Date.now()}`
    const persistedState = createSessionState()
    persistedState.sessionId = targetSessionId
    persistedState.prune.messages.blocksById.set(1, {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        summaryTokens: 0,
        durationMs: 0,
        mode: "message",
        topic: "one",
        batchTopic: "one",
        startId: "m00001",
        endId: "m00001",
        anchorMessageId: "msg-a",
        compressMessageId: "message-1",
        compressCallId: "call-remote",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: ["msg-a"],
        effectiveToolIds: [],
        createdAt: 1,
        summary: "a",
    })
    await saveSessionState(persistedState, logger)

    const liveState = createSessionState()
    liveState.sessionId = otherSessionId
    const handler = createEventHandler(createTestRegistry(liveState), logger)

    await handler({
        event: {
            type: "message.part.updated",
            properties: {
                sessionID: targetSessionId,
                part: {
                    type: "tool",
                    tool: "compress",
                    callID: "call-remote",
                    messageID: "message-1",
                    state: {
                        status: "pending",
                        input: {},
                        raw: "",
                    },
                },
            },
            time: 100,
        },
    })

    await handler({
        event: {
            type: "message.part.updated",
            properties: {
                sessionID: targetSessionId,
                part: {
                    type: "tool",
                    tool: "compress",
                    callID: "call-remote",
                    messageID: "message-1",
                    state: {
                        status: "completed",
                        input: {},
                        output: "done",
                        title: "",
                        metadata: {},
                        time: { start: 350, end: 500 },
                    },
                },
            },
        },
    })

    assert.equal(liveState.compressionTiming.pendingByCallId.has("message-1:call-remote"), true)
    assert.equal(liveState.compressionTiming.startsByCallId.has("message-1:call-remote"), false)

    await ensureSessionInitialized(
        {
            session: {
                get: async () => ({ data: { parentID: null } }),
            },
        } as any,
        liveState,
        targetSessionId,
        logger,
        [
            {
                info: {
                    id: "msg-user-1",
                    role: "user",
                    sessionID: targetSessionId,
                    agent: "assistant",
                    time: { created: 1 },
                } as WithParts["info"],
                parts: [],
            },
        ],
        false,
    )

    assert.equal(liveState.prune.messages.blocksById.get(1)?.durationMs, 250)
    assert.equal(liveState.compressionTiming.pendingByCallId.has("message-1:call-remote"), false)
})

test("event hook keeps same call id distinct across message ids", async () => {
    const state = createSessionState()
    state.sessionId = "session-1"
    const handler = createEventHandler(createTestRegistry(state), new Logger(false))

    state.prune.messages.blocksById.set(1, {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        summaryTokens: 0,
        durationMs: 0,
        mode: "message",
        topic: "one",
        batchTopic: "one",
        startId: "m00001",
        endId: "m00001",
        anchorMessageId: "msg-a",
        compressMessageId: "message-1",
        compressCallId: "shared-call",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: ["msg-a"],
        effectiveToolIds: [],
        createdAt: 1,
        summary: "a",
    })
    state.prune.messages.blocksById.set(2, {
        blockId: 2,
        runId: 2,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        summaryTokens: 0,
        durationMs: 0,
        mode: "message",
        topic: "two",
        batchTopic: "two",
        startId: "m00002",
        endId: "m00002",
        anchorMessageId: "msg-b",
        compressMessageId: "message-2",
        compressCallId: "shared-call",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: ["msg-b"],
        effectiveToolIds: [],
        createdAt: 2,
        summary: "b",
    })

    await handler({
        event: {
            type: "message.part.updated",
            properties: {
                part: {
                    type: "tool",
                    tool: "compress",
                    callID: "shared-call",
                    messageID: "message-1",
                    sessionID: "session-1",
                    state: {
                        status: "pending",
                        input: {},
                        raw: "",
                    },
                },
            },
            time: 100,
        },
    })

    await handler({
        event: {
            type: "message.part.updated",
            properties: {
                part: {
                    type: "tool",
                    tool: "compress",
                    callID: "shared-call",
                    messageID: "message-2",
                    sessionID: "session-1",
                    state: {
                        status: "pending",
                        input: {},
                        raw: "",
                    },
                },
            },
            time: 200,
        },
    })

    await handler({
        event: {
            type: "message.part.updated",
            properties: {
                part: {
                    type: "tool",
                    tool: "compress",
                    callID: "shared-call",
                    messageID: "message-2",
                    sessionID: "session-1",
                    state: {
                        status: "completed",
                        input: {},
                        output: "done",
                        title: "",
                        metadata: {},
                        time: { start: 350, end: 500 },
                    },
                },
            },
        },
    })

    await handler({
        event: {
            type: "message.part.updated",
            properties: {
                part: {
                    type: "tool",
                    tool: "compress",
                    callID: "shared-call",
                    messageID: "message-1",
                    sessionID: "session-1",
                    state: {
                        status: "completed",
                        input: {},
                        output: "done",
                        title: "",
                        metadata: {},
                        time: { start: 450, end: 700 },
                    },
                },
            },
        },
    })

    assert.equal(state.prune.messages.blocksById.get(1)?.durationMs, 350)
    assert.equal(state.prune.messages.blocksById.get(2)?.durationMs, 150)
})
