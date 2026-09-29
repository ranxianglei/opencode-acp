import "./test-env"
import assert from "node:assert/strict"
import test from "node:test"
import { z } from "zod"
import type { SharedToolDefinition, ToolFactoryContext, ToolStateRegistry } from "../lib/compress"
import {
    createAcpContextRecapToolDefinition,
    createAcpStatusToolDefinition,
    createCompressRangeToolDefinition,
    createDecompressToolDefinition,
    createSearchContextToolDefinition,
} from "../lib/compress"
import type { HostPermissionRule, HostPermissionSnapshot } from "../lib/host-permissions"
import type { V2HostAdapter } from "../lib/v2/host"
import { createV2Tool, createV2ToolTransform, type V2ToolEditor } from "../lib/v2/tools"
import { Logger } from "../lib/logger"
import { PromptStore } from "../lib/prompts/store"
import {
    cloneSessionState,
    createSessionState,
    type SessionState,
    type WithParts,
} from "../lib/state"
import type { PluginConfig } from "../lib/config"
import { withToolSessionMutation } from "../lib/compress/types"
import { V2OperationTracker } from "../lib/v2/lifecycle"

const sessionID = "v2-tools-session"

function config(
    permission: "allow" | "ask" | "deny" = "allow",
    allowSubAgents = true,
): PluginConfig {
    return {
        enabled: true,
        autoUpdate: false,
        debug: false,
        logLevel: "silent",
        allowSubAgents,
        pruneNotification: "off",
        pruneNotificationType: "toast",
        commands: { enabled: true, protectedTools: [] },
        experimental: { customPrompts: false },
        protectedFilePatterns: [],
        compress: {
            permission,
            showCompression: false,
            summaryBuffer: true,
            candidates: false,
            maxContextLimit: 150000,
            minContextLimit: 50000,
            contextLimitFallback: 128000,
            nudgeFrequency: 5,
            minNudgeContextPercent: 5,
            nudgeGrowthTokens: 5000,
            toolOutputNudgeThreshold: 5000,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: [],
            protectTags: false,
            protectUserMessages: false,
            maxSummaryLengthHard: 20000,
            minCompressRange: 5000,
            minNudgeGrowthRatio: 0.45,
            minNudgeGrowthFloor: 5000,
            emergencyThresholdPercent: "98%",
            maxVisibleSegments: 50,
            keepEmbedMaxChars: 2000,
            preserveRecentMessages: 20,
            preserveRecentTokens: 20000,
            preserveLastUserMessage: true,
            reasoning: { drop: true, threshold: 2048 },
            completionReserveTokens: 32768,
        },
        gc: {
            algorithm: "truncate",
            promotionThreshold: 5,
            maxBlockAge: 15,
            maxOldGenSummaryLength: 3000,
            majorGcThresholdPercent: "100%",
            batchCleanup: { lowThreshold: "60%", highThreshold: "75%", forceThreshold: "90%" },
        },
        qualityGate: { enabled: false, algorithm: "rouge-recall-v1", algorithms: {} },
        messageFilters: { enabled: false, filters: {} },
    }
}

function host(rules: readonly HostPermissionRule[] = []): V2HostAdapter {
    return {
        sessions: {
            get: async () => ({ id: sessionID, parentID: null }),
            messages: async () => [],
            parentMessages: async () => [],
        },
        models: { list: async () => [] },
        notices: { send: async () => {} },
        notifications: { notify: () => {} },
        projectedContext: async () => [],
        directory: "/tmp/v2-tools",
        agentPermissions: async () => rules,
    }
}

function factory(
    state: SessionState,
    rules: readonly HostPermissionRule[] = [],
    permission: "allow" | "ask" | "deny" = "allow",
    allowSubAgents = true,
    compressOverrides: Record<string, unknown> = {},
) {
    const logger = new Logger(false, "silent")
    const adapter = host(rules)
    let guarded = 0
    const registry: ToolStateRegistry = {
        get: () => state,
        withSessionMutation: async (_id, operation) => {
            guarded += 1
            return operation(state)
        },
    }
    const context = {
        host: adapter,
        registry,
        logger,
        config: {
            ...config(permission, allowSubAgents),
            compress: {
                ...config(permission, allowSubAgents).compress,
                ...compressOverrides,
            },
        },
        prompts: new PromptStore(logger, "/tmp/v2-tools", false, false),
    } satisfies ToolFactoryContext
    return {
        adapter,
        context,
        hostPermissions: { global: undefined, agents: {} } satisfies HostPermissionSnapshot,
        guarded: () => guarded,
    }
}

function v2Context() {
    return {
        sessionID,
        agent: "code",
        messageID: "message-1",
        id: "call-1",
        progress: async () => {},
    }
}

test("V2 registers the five exact tools as direct tools with complete schemas", () => {
    const state = createSessionState()
    state.sessionId = sessionID
    const run = factory(state)
    const added: unknown[] = []
    const editor = { add: (tool: unknown) => added.push(tool) } as unknown as V2ToolEditor
    createV2ToolTransform(run.context, run.adapter, run.hostPermissions)(editor)

    assert.deepEqual(
        added.map((value) => (value as { name: string }).name),
        ["compress", "decompress", "search_context", "acp_status", "acp_context_recap"],
    )
    for (const value of added) {
        const tool = value as { name: string; input: unknown; options?: Record<string, unknown> }
        assert.ok(tool.input)
        assert.deepEqual(tool.options, { codemode: false, permission: tool.name })
    }
})

test("V2 maps IDs, progress metadata, string/object output, and attachments", async () => {
    const state = createSessionState()
    state.sessionId = sessionID
    const run = factory(state)
    const updates: unknown[] = []
    run.adapter.agentPermissions = async () => []
    const schema = z.object({ value: z.string() })
    const definition: SharedToolDefinition<typeof schema> = {
        name: "test",
        description: "test",
        schema,
        inputSchema: schema,
        async execute(_input, context) {
            context.metadata({ title: "running", metadata: { phase: "start" } })
            await context.progress?.({ title: "done", status: "completed" })
            return {
                output: "result",
                metadata: { preserved: true },
                attachments: [
                    {
                        type: "file",
                        mime: "text/plain",
                        url: "file:///tmp/result.txt",
                        filename: "result.txt",
                    },
                ],
            }
        },
    }
    const tool = createV2Tool(definition, run.context, run.adapter, run.hostPermissions)
    const result = await tool.execute(
        { value: "ok" },
        {
            ...v2Context(),
            progress: async (update) => {
                updates.push(update)
            },
        },
    )
    assert.deepEqual(result.content, [
        { type: "text", text: "result" },
        { type: "file", uri: "file:///tmp/result.txt", mime: "text/plain", name: "result.txt" },
    ])
    assert.deepEqual(result.metadata, { preserved: true })
    assert.deepEqual(updates, [
        { title: "running", phase: "start" },
        { title: "done", status: "completed" },
    ])
    assert.equal(run.guarded(), 0)
})

test("V2 transaction restores shared timing maps exactly after inactivity or failure", async () => {
    const state = createSessionState()
    state.sessionId = sessionID
    state.compressionTiming.startsByCallId.set("original-start", 10)
    state.compressionTiming.startsByCallId.set("original-removed", 11)
    state.compressionTiming.pendingByCallId.set("original-pending", {
        messageId: "message-1",
        callId: "call-1",
        durationMs: 20,
    })
    const run = factory(state)
    const schema = z.object({})

    const mutateTiming = async (
        _input: unknown,
        context: Parameters<SharedToolDefinition["execute"]>[1],
    ) =>
        withToolSessionMutation(run.context, context, async (toolContext) => {
            toolContext.state.compressionTiming.startsByCallId.set("original-start", 99)
            toolContext.state.compressionTiming.startsByCallId.delete("original-removed")
            toolContext.state.compressionTiming.startsByCallId.set("speculative-start", 30)
            const pending = toolContext.state.compressionTiming.pendingByCallId
            pending.get("original-pending")!.durationMs = 88
            pending.delete("original-pending")
            pending.set("speculative-pending", {
                messageId: "speculative-message",
                callId: "speculative-call",
                durationMs: 40,
            })
            if (context.callID === "blocked-call") {
                await new Promise<void>((resolve) => {
                    blockedRelease = resolve
                    blockedStarted()
                })
            }
            if (context.callID === "throwing-call") throw new Error("timing failure")
            return "done"
        })

    let blockedRelease = () => {}
    let blockedStarted = () => {}
    const started = new Promise<void>((resolve) => {
        blockedStarted = resolve
    })
    const tracker = new V2OperationTracker()
    const definition: SharedToolDefinition<typeof schema> = {
        name: "timing-test",
        description: "timing-test",
        schema,
        inputSchema: schema,
        execute: mutateTiming,
    }
    const starts = state.compressionTiming.startsByCallId
    const pending = state.compressionTiming.pendingByCallId
    const timing = state.compressionTiming
    const originalPending = pending.get("original-pending")
    const beforeStarts = [...starts.entries()]
    const beforePending = [...pending.entries()].map(([key, value]) => [key, { ...value }] as const)
    const blockedTool = createV2Tool(
        definition,
        run.context,
        run.adapter,
        run.hostPermissions,
        () => true,
        tracker,
    )
    const blockedResult = blockedTool.execute({}, { ...v2Context(), id: "blocked-call" })
    await started
    tracker.deactivate()
    blockedRelease()
    const inactiveResult = await blockedResult

    assert.match(String(inactiveResult.content), /shutting down/i)
    assert.strictEqual(state.compressionTiming, timing)
    assert.strictEqual(state.compressionTiming.startsByCallId, starts)
    assert.strictEqual(state.compressionTiming.pendingByCallId, pending)
    assert.strictEqual(pending.get("original-pending"), originalPending)
    assert.deepEqual([...starts.entries()], beforeStarts)
    assert.deepEqual([...pending.entries()], beforePending)

    const throwingTracker = new V2OperationTracker()
    const throwingTool = createV2Tool(
        definition,
        run.context,
        run.adapter,
        run.hostPermissions,
        () => true,
        throwingTracker,
    )
    const throwingResult = await throwingTool.execute({}, { ...v2Context(), id: "throwing-call" })

    assert.match(String(throwingResult.content), /timing-test failed/i)
    assert.strictEqual(state.compressionTiming, timing)
    assert.strictEqual(state.compressionTiming.startsByCallId, starts)
    assert.strictEqual(state.compressionTiming.pendingByCallId, pending)
    assert.strictEqual(pending.get("original-pending"), originalPending)
    assert.deepEqual([...starts.entries()], beforeStarts)
    assert.deepEqual([...pending.entries()], beforePending)
})

test("V2 deny and ask return safe results before state acquisition or mutation", async () => {
    let executed = 0
    const state = createSessionState()
    state.sessionId = sessionID
    const schema = z.object({})
    const definition: SharedToolDefinition<typeof schema> = {
        name: "test",
        description: "test",
        schema,
        inputSchema: schema,
        async execute() {
            executed += 1
            return "unexpected"
        },
    }

    for (const [permission, rules, expected] of [
        ["deny", [], /disabled/i],
        ["allow", [{ action: "test", resource: "*", effect: "deny" }], /disabled/i],
        ["ask", [], /allow.*deny/i],
    ] as const) {
        const run = factory(state, rules, permission)
        const before = cloneSessionState(state)
        const result = await createV2Tool(
            definition,
            run.context,
            run.adapter,
            run.hostPermissions,
        ).execute({}, v2Context())
        assert.match(String(result.content), expected)
        assert.equal(run.guarded(), 0)
        assert.deepEqual(cloneSessionState(state), before)
    }
    assert.equal(executed, 0)
})

test("V2 direct tools fail closed for child sessions before acquiring state", async () => {
    let executed = 0
    const state = createSessionState()
    state.sessionId = sessionID
    const run = factory(state, [], "allow", false)
    run.adapter.sessions.get = async () => ({ id: sessionID, parentID: "parent-session" })
    const schema = z.object({})
    const definition: SharedToolDefinition<typeof schema> = {
        name: "test",
        description: "test",
        schema,
        inputSchema: schema,
        async execute() {
            executed++
            return "unexpected"
        },
    }
    const before = cloneSessionState(state)
    const result = await createV2Tool(
        definition,
        run.context,
        run.adapter,
        run.hostPermissions,
    ).execute({}, v2Context())

    assert.match(String(result.content), /child session/i)
    assert.equal(executed, 0)
    assert.equal(run.guarded(), 0)
    assert.deepEqual(cloneSessionState(state), before)
})

test("V2 direct tools fail closed when parent lookup errors", async () => {
    const state = createSessionState()
    state.sessionId = sessionID
    const run = factory(state, [], "allow", false)
    run.adapter.sessions.get = async () => {
        throw new Error("session lookup unavailable")
    }
    const schema = z.object({})
    const definition: SharedToolDefinition<typeof schema> = {
        name: "test",
        description: "test",
        schema,
        inputSchema: schema,
        async execute() {
            return "unexpected"
        },
    }
    const result = await createV2Tool(
        definition,
        run.context,
        run.adapter,
        run.hostPermissions,
    ).execute({}, v2Context())
    assert.match(String(result.content), /verify the session parent/i)
    assert.equal(run.guarded(), 0)
})

test("V2 ordered agent rules let a later allow override only a matching deny", async () => {
    let executed = 0
    const state = createSessionState()
    state.sessionId = sessionID
    const schema = z.object({})
    const definition: SharedToolDefinition<typeof schema> = {
        name: "test",
        description: "test",
        schema,
        inputSchema: schema,
        async execute() {
            executed += 1
            return "allowed"
        },
    }
    const run = factory(state, [
        { action: "*", resource: "*", effect: "deny" },
        { action: "test", resource: "*", effect: "allow" },
    ])
    const result = await createV2Tool(
        definition,
        run.context,
        run.adapter,
        run.hostPermissions,
    ).execute({}, v2Context())
    assert.equal(result.content, "allowed")
    assert.equal(executed, 1)
    assert.equal(run.guarded(), 0)
})

test("V2 agent allow overrides ACP ask, while ACP deny remains authoritative", async () => {
    let executed = 0
    const state = createSessionState()
    state.sessionId = sessionID
    const schema = z.object({})
    const definition: SharedToolDefinition<typeof schema> = {
        name: "test",
        description: "test",
        schema,
        inputSchema: schema,
        async execute() {
            executed += 1
            return "allowed"
        },
    }

    const askRun = factory(state, [{ action: "test", resource: "*", effect: "allow" }], "ask")
    const allowed = await createV2Tool(
        definition,
        askRun.context,
        askRun.adapter,
        askRun.hostPermissions,
    ).execute({}, v2Context())
    assert.equal(allowed.content, "allowed")

    const denyRun = factory(state, [{ action: "test", resource: "*", effect: "allow" }], "deny")
    const denied = await createV2Tool(
        definition,
        denyRun.context,
        denyRun.adapter,
        denyRun.hostPermissions,
    ).execute({}, v2Context())
    assert.match(String(denied.content), /disabled/i)
    assert.equal(executed, 1)
})

test("V2 resolves host rules per real tool name so one tool's rule never leaks (issue #459)", async () => {
    const names = ["compress", "decompress", "search_context", "acp_status", "acp_context_recap"]
    const schema = z.object({})

    const makeTool = (toolName: string) => {
        const definition: SharedToolDefinition<typeof schema> = {
            name: toolName,
            description: toolName,
            schema,
            inputSchema: schema,
            async execute() {
                return `executed:${toolName}`
            },
        }
        return async (rules: readonly HostPermissionRule[]) => {
            const state = createSessionState()
            state.sessionId = sessionID
            const run = factory(state, rules)
            return await createV2Tool(
                definition,
                run.context,
                run.adapter,
                run.hostPermissions,
            ).execute({}, v2Context())
        }
    }

    // A deny targeting `compress` must not silence any other ACP tool.
    for (const toolName of names) {
        const result = await makeTool(toolName)([
            { action: "compress", resource: "*", effect: "deny" },
        ])
        if (toolName === "compress") {
            assert.match(String(result.content), /disabled/i)
            assert.deepEqual(result.metadata, {
                acpPermission: "deny",
                permission: "compress",
                actionable: "choose allow or deny",
            })
        } else {
            assert.equal(result.content, `executed:${toolName}`)
        }
    }

    // Conversely, a deny targeting any other tool must not block compress.
    for (const toolName of names.filter((value) => value !== "compress")) {
        const blocked = await makeTool(toolName)([
            { action: toolName, resource: "*", effect: "deny" },
        ])
        assert.match(String(blocked.content), /disabled/i)
        assert.equal(blocked.metadata?.permission, toolName)
        const compressResult = await makeTool("compress")([
            { action: toolName, resource: "*", effect: "deny" },
        ])
        assert.equal(compressResult.content, "executed:compress")
    }

    // Granular `ask` fails closed for the targeted tool only; the other
    // read-only tools keep executing instead of inheriting the refusal.
    for (const toolName of names) {
        const result = await makeTool(toolName)([
            { action: "compress", resource: "*", effect: "ask" },
        ])
        if (toolName === "compress") {
            assert.match(String(result.content), /interactive permission/i)
            assert.match(String(result.content), /`compress` permission/i)
            assert.equal(result.metadata?.acpPermission, "ask")
        } else {
            assert.equal(result.content, `executed:${toolName}`)
        }
    }
    const askStatusRules = [{ action: "acp_status", resource: "*", effect: "ask" }]
    assert.match(
        String((await makeTool("acp_status")(askStatusRules)).content),
        /`acp_status` permission/i,
    )
    assert.equal((await makeTool("compress")(askStatusRules)).content, "executed:compress")

    // Reverse granularity: denying only compress leaves the four read-only
    // tools allowed (ordered last-match: the specific rule comes last).
    for (const toolName of names) {
        const result = await makeTool(toolName)([
            { action: "*", resource: "*", effect: "allow" },
            { action: "compress", resource: "*", effect: "deny" },
        ])
        if (toolName === "compress") {
            assert.match(String(result.content), /disabled/i)
        } else {
            assert.equal(result.content, `executed:${toolName}`)
        }
    }
})

test("actual ACP definitions retain their exact V2 names", () => {
    const state = createSessionState()
    state.sessionId = sessionID
    const run = factory(state)
    assert.deepEqual(
        [
            createCompressRangeToolDefinition(run.context),
            createDecompressToolDefinition(run.context),
            createSearchContextToolDefinition(run.context),
            createAcpStatusToolDefinition(run.context),
            createAcpContextRecapToolDefinition(run.context),
        ].map((definition) => definition.name),
        ["compress", "decompress", "search_context", "acp_status", "acp_context_recap"],
    )
})

test("V2 compress applies model overrides from state when normalized history has blank identifiers", async () => {
    const state = createSessionState()
    state.sessionId = sessionID
    state.modelProviderID = "provider"
    state.modelID = "model"
    const run = factory(state, [], "allow", true, {
        providers: {
            provider: {
                models: {
                    model: { minCompressRange: 1000 },
                },
            },
        },
        minCompressRange: 2000,
        preserveLastUserMessage: false,
        preserveRecentMessages: 0,
        preserveRecentTokens: 0,
    })
    const history: WithParts = {
        info: {
            id: "history-user",
            sessionID,
            role: "user",
            agent: "code",
            model: { providerID: "", modelID: "" },
            time: { created: 1 },
        } as WithParts["info"],
        parts: [
            {
                type: "text",
                id: "history-user-part",
                sessionID,
                messageID: "history-user",
                text: "x".repeat(1500),
            },
        ],
    }
    run.adapter.sessions.messages = async () => [history]
    const definition = createCompressRangeToolDefinition(run.context)

    const result = await definition.execute(
        {
            topic: "short range",
            content: [
                {
                    startId: "m00001",
                    endId: "m00001",
                    summary: "summary",
                },
            ],
        },
        {
            sessionID,
            messageID: "message-1",
            callID: "call-1",
            ask: async () => {},
            metadata: () => {},
            permission: "allow",
        },
    )
    assert.match(String(result), /Compressed 1 messages/)
    assert.equal(state.prune.messages.blocksById.size, 1)
})

test("V2 delegates actual ACP execution to the shared single session guard", async () => {
    const state = createSessionState()
    state.sessionId = sessionID
    const run = factory(state)
    const tool = createV2Tool(
        createAcpContextRecapToolDefinition(run.context),
        run.context,
        run.adapter,
        run.hostPermissions,
    )
    const result = await tool.execute({}, v2Context())
    assert.match(String(result.content), /No active compression blocks/)
    assert.equal(run.guarded(), 1)
})
