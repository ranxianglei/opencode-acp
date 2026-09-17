import "./test-env"
import assert from "node:assert/strict"
import test from "node:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Message, SystemPart } from "@opencode/ai"
import type { PluginConfig } from "../lib/config"
import { createCompressRangeToolDefinition } from "../lib/compress"
import { createV2ContextHandler } from "../lib/v2/context"
import { createV2Host, type V2Context, type V2HostAdapter } from "../lib/v2/host"
import { createV2Tool } from "../lib/v2/tools"
import { Logger } from "../lib/logger"
import { PromptStore } from "../lib/prompts/store"
import {
    cloneSessionState,
    createSessionState,
    saveSessionState,
    SessionStateRegistry,
    type CompressionBlock,
    type SessionState,
    type WithParts,
} from "../lib/state"

const modelA = { id: "model-a", providerID: "provider-a" }
const modelB = { id: "model-b", providerID: "provider-b" }

function makeNativeCompactionFixture(id: string) {
    const expectedContent = [
        {
            type: "compaction" as const,
            provider: "provider-a",
            text: "native provider checkpoint",
        },
    ] as const
    const expectedProviderMetadata = {
        "provider-a": {
            checkpoint: { responseID: "native-summary", sequence: 7 },
        },
    } as const
    const expectedNative = {
        "provider-a": {
            checkpoint: { encrypted: false, source: "fixture" },
        },
    } as const
    return {
        expectedContent,
        expectedProviderMetadata,
        expectedNative,
        message: Message.make({
            id,
            role: "user",
            content: expectedContent,
            providerMetadata: expectedProviderMetadata,
            native: expectedNative,
        }),
    }
}

function config(storagePath: string, debug = false): PluginConfig {
    return {
        enabled: true,
        autoUpdate: false,
        debug,
        logLevel: "silent",
        allowSubAgents: true,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        storagePath,
        commands: { enabled: true, protectedTools: [] },
        experimental: { customPrompts: false },
        protectedFilePatterns: [],
        compress: {
            mode: "message",
            permission: "allow",
            showCompression: false,
            summaryBuffer: true,
            candidates: false,
            maxContextLimit: 90_000,
            minContextLimit: 80_000,
            contextLimitFallback: 128_000,
            nudgeFrequency: 5,
            minNudgeContextPercent: 5,
            nudgeGrowthTokens: 50_000,
            toolOutputNudgeThreshold: 5_000,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: [],
            protectTags: false,
            protectUserMessages: false,
            maxSummaryLengthHard: 20_000,
            minCompressRange: 5_000,
            minNudgeGrowthRatio: 0.45,
            minNudgeGrowthFloor: 5_000,
            emergencyThresholdPercent: "98%",
            maxVisibleSegments: 50,
            keepEmbedMaxChars: 2_000,
            lastSegmentSoftBlock: true,
            preserveRecentMessages: 5,
            preserveRecentTokens: 5_000,
            preserveLastUserMessage: true,
            reasoning: { drop: true, threshold: 2048 },
            completionReserveTokens: 32_768,
        },
        gc: {
            algorithm: "truncate",
            promotionThreshold: 5,
            maxBlockAge: 15,
            maxOldGenSummaryLength: 3000,
            majorGcThresholdPercent: "100%",
            batchCleanup: { lowThreshold: "60%", highThreshold: "75%", forceThreshold: "90%" },
        },
        qualityGate: {
            enabled: false,
            algorithm: "rouge-recall-v1",
            algorithms: {
                "rouge-recall-v1": {
                    layer1MinChars: 200,
                    layer1MinRetentionPct: 5,
                    layer2MaxRougeF1: 0.05,
                    layer2MaxTop20Recall: 0.2,
                },
            },
        },
        messageFilters: {
            enabled: false,
            filters: {
                "omo-system-reminder": { enabled: true },
                "omo-todo-continuation": { enabled: true },
                "omo-context": { enabled: true },
                "omo-task-directive": { enabled: true },
                "omo-mode-injection": { enabled: true },
            },
        },
    }
}

function seedActiveCompactionBlock(
    state: SessionState,
    messageID: string,
    blockId = 1,
): CompressionBlock {
    const block: CompressionBlock = {
        blockId,
        runId: blockId,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 1,
        effectiveCompressedTokens: 1,
        summaryTokens: 1,
        durationMs: 0,
        mode: "range",
        tier: 1,
        topic: "opaque compaction fixture",
        startId: messageID,
        endId: messageID,
        anchorMessageId: messageID,
        compressMessageId: "opaque-before",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [messageID],
        directToolIds: [],
        effectiveMessageIds: [messageID],
        effectiveToolIds: [],
        createdAt: 1,
        summary: "opaque compaction fixture",
        survivedCount: 0,
        generation: "young",
    }
    state.prune.messages.blocksById.set(block.blockId, block)
    state.prune.messages.activeBlockIds.add(block.blockId)
    state.prune.messages.activeByAnchorMessageId.set(block.anchorMessageId, block.blockId)
    state.prune.messages.byMessageId.set(messageID, {
        tokenCount: block.compressedTokens,
        allBlockIds: [block.blockId],
        activeBlockIds: [block.blockId],
    })
    state.prune.messages.nextBlockId = blockId + 1
    state.prune.messages.nextRunId = blockId + 1
    state.prune.messages.membershipsVerified = true
    return block
}

function host(
    projectedBySession: Map<string, readonly unknown[]>,
    models: readonly { providerId: string; modelId: string; contextLimit?: number }[],
    parentBySession = new Map<string, string | undefined>(),
    notificationMessages: string[] = [],
): V2HostAdapter {
    const projectedContext = async (sessionID: string) => projectedBySession.get(sessionID) ?? []
    const sessions = {
        get: async (sessionID: string) => ({
            id: sessionID,
            parentID: parentBySession.get(sessionID),
        }),
        messages: async (sessionID: string): Promise<WithParts[]> => [],
        parentMessages: async (sessionID: string): Promise<WithParts[]> => [],
    }
    return {
        sessions,
        models: { list: async () => models },
        notices: { send: async () => {} },
        notifications: {
            notify: (input) => {
                notificationMessages.push(input.message)
            },
        },
        projectedContext,
        directory: "/tmp/opencode-v2-context",
    }
}

function context(
    sessionID: string,
    model: { id: string; providerID: string },
    messages: ReturnType<typeof Message.make>[],
) {
    return {
        sessionID,
        agent: "code",
        model,
        system: [],
        messages,
    }
}

function runHandler(
    projected: readonly unknown[],
    outgoing: ReturnType<typeof Message.make>[],
    selectedModel = modelA,
    inventory = [
        { providerId: "provider-a", modelId: "model-a", contextLimit: 100_000 },
        { providerId: "provider-b", modelId: "model-b", contextLimit: 200_000 },
    ],
) {
    const storage = mkdtempSync(join(tmpdir(), "acp-v2-context-"))
    const logger = new Logger(false)
    const cfg = config(storage)
    const registry = new SessionStateRegistry(logger, "/tmp/opencode-v2-context")
    const prompts = new PromptStore(logger, "/tmp/opencode-v2-context")
    const projectedBySession = new Map<string, readonly unknown[]>([["session", projected]])
    const adapter = host(projectedBySession, inventory)
    const handler = createV2ContextHandler(adapter, registry, logger, cfg, prompts, {
        global: undefined,
        agents: {},
    })
    return {
        storage,
        registry,
        adapter,
        config: cfg,
        logger,
        prompts,
        event: context("session", selectedModel, outgoing),
        handler,
    }
}

test("V2 host uses direct Promise session/catalog response shapes for child and parent history", async () => {
    const contextCalls: string[] = []
    const getCalls: string[] = []
    const history = new Map<string, readonly unknown[]>([
        [
            "child",
            [{ type: "user", id: "child-user", time: { created: 1 }, text: "child request" }],
        ],
        [
            "parent",
            [
                { type: "user", id: "parent-user", time: { created: 1 }, text: "parent request" },
                {
                    type: "assistant",
                    id: "parent-assistant",
                    time: { created: 2 },
                    agent: "code",
                    model: modelA,
                    content: [
                        {
                            type: "tool",
                            id: "parent-call",
                            name: "read",
                            state: {
                                status: "running",
                                input: { path: "a.ts" },
                                time: { start: 2 },
                                metadata: { source: "fixture" },
                            },
                        },
                    ],
                },
            ],
        ],
    ])
    const apiContext = {
        location: { directory: "/workspace/direct-api" },
        session: {
            get: async ({ sessionID }: { sessionID: string }) => {
                getCalls.push(sessionID)
                return { id: sessionID, parentID: sessionID === "child" ? "parent" : undefined }
            },
            context: async ({ sessionID }: { sessionID: string }) => {
                contextCalls.push(sessionID)
                return history.get(sessionID) ?? []
            },
        },
        catalog: {
            model: {
                list: async () => ({
                    location: {
                        directory: "/workspace/direct-api",
                        project: {
                            id: "project",
                            directory: "/workspace/direct-api",
                            canonical: "project",
                        },
                    },
                    data: [
                        {
                            id: "model-a",
                            modelID: "provider-model-a",
                            providerID: "provider-a",
                            limit: { context: 123_456, output: 4096 },
                        },
                    ],
                }),
            },
        },
    } as unknown as V2Context
    const adapter = createV2Host(apiContext)

    const child = await adapter.sessions.get("child")
    assert.deepEqual(child, { id: "child", parentID: "parent" })
    const childMessages = await adapter.sessions.messages("child")
    assert.equal(childMessages[0]?.info.id, "child-user")
    assert.equal(childMessages[0]?.info.sessionID, "child")

    const parentMessages = await adapter.sessions.parentMessages("parent")
    assert.deepEqual(
        parentMessages.map((message) => message.info.id),
        ["parent-user", "parent-assistant"],
    )
    assert.equal(
        parentMessages[1]?.parts.find((part) => part.type === "tool")?.callID,
        "parent-call",
    )

    const inventory = await adapter.models.list()
    assert.deepEqual(inventory, [
        { providerId: "provider-a", modelId: "model-a", contextLimit: 123_456 },
    ])
    assert.deepEqual(getCalls, ["child"])
    assert.deepEqual(contextCalls, ["child", "parent"])
})

test("primary V2 context hook patches messages then appends a structured system part", async () => {
    const projected = [
        { type: "user", id: "user-1", time: { created: 1 }, text: "request" },
        {
            type: "assistant",
            id: "assistant-1",
            time: { created: 2 },
            agent: "code",
            model: modelA,
            content: [{ type: "text", text: "answer" }],
        },
    ]
    const outgoing = [
        Message.make({ id: "user-1", role: "user", content: "request" }),
        Message.make({ id: "assistant-1", role: "assistant", content: "answer" }),
    ]
    const run = runHandler(projected, outgoing)
    await run.handler(run.event)
    try {
        assert.equal(run.event.messages[0]?.id, "user-1")
        assert.match(run.event.messages[0]?.content[0]?.text ?? "", /request/)
        assert.equal(run.event.messages[1]?.id, "assistant-1")
        assert.match(run.event.messages[1]?.content[0]?.text ?? "", /answer/)
        assert.equal(run.event.system.length, 1)
        assert.equal(run.event.system[0]?.type, "text")
        assert.match(run.event.system[0]?.text ?? "", /decompress/i)
        assert.equal(run.registry.get("session")?.modelContextLimit, 100_000)
    } finally {
        rmSync(run.storage, { recursive: true, force: true })
    }
})

test("fresh V2 patch rejection removes the initialized placeholder and allows a later valid request", async () => {
    const projected = [
        { type: "system", id: "fresh-system", time: { created: 1 }, text: "opaque system" },
        { type: "user", id: "fresh-user", time: { created: 2 }, text: "request" },
    ]
    const originalMessages = [
        Message.make({ role: "system", content: "opaque system" }),
        Message.make({ id: "fresh-user", role: "user", content: "request" }),
    ]
    const run = runHandler(projected, originalMessages, modelA, [])
    const originalSystem = run.event.system
    const originalMessageValues = [...originalMessages]
    const originalSystemValues = [...originalSystem]
    const changedMessages = [
        Message.make({ role: "system", content: "newer opaque system" }),
        originalMessages[1]!,
    ]
    let messageReads = 0
    let debugEffects = 0
    const notifications: string[] = []
    run.logger.saveContext = async () => {
        debugEffects++
    }
    run.adapter.notifications = {
        notify: (input) => {
            notifications.push(input.message)
        },
    }
    Object.defineProperty(run.event, "messages", {
        configurable: true,
        get() {
            messageReads++
            return messageReads === 3 ? changedMessages : originalMessages
        },
        set() {
            throw new Error("rejected patch must not assign event.messages")
        },
    })

    try {
        await run.handler(run.event)

        assert.equal(run.registry.get("session"), undefined)
        assert.equal(run.registry.size, 0)
        assert.strictEqual(run.event.messages, originalMessages)
        assert.deepEqual(run.event.messages, originalMessageValues)
        assert.strictEqual(run.event.system, originalSystem)
        assert.deepEqual(run.event.system, originalSystemValues)
        assert.equal(existsSync(join(run.storage, "session.json")), false)
        assert.equal(debugEffects, 0)
        assert.deepEqual(notifications, [])

        Object.defineProperty(run.event, "messages", {
            configurable: true,
            writable: true,
            value: originalMessages,
        })
        const validEvent = context("session", modelA, [
            Message.make({ role: "system", content: "opaque system" }),
            Message.make({ id: "fresh-user", role: "user", content: "request" }),
        ])
        await run.handler(validEvent)
        assert.ok(run.registry.get("session"))
        assert.equal(validEvent.system.length, 1)
    } finally {
        rmSync(run.storage, { recursive: true, force: true })
    }
})

test("fresh registry commits and accepts a direct compression when history repeats identical system text", async () => {
    const projected = [
        { type: "system", id: "dup-system-1", time: { created: 1 }, text: "shared instruction" },
        { type: "system", id: "dup-system-2", time: { created: 2 }, text: "shared instruction" },
        { type: "user", id: "dup-user", time: { created: 3 }, text: "request" },
    ]
    const outgoing = [
        Message.make({ role: "system", content: "shared instruction" }),
        Message.make({ role: "system", content: "shared instruction" }),
        Message.make({ id: "dup-user", role: "user", content: "request" }),
    ]
    const run = runHandler(projected, outgoing)
    try {
        await run.handler(run.event)

        // Repeated identical system text used to reject the whole projection, so a fresh
        // session never committed; now it must initialize, persist, and inject the ACP prompt.
        assert.ok(run.registry.get("session"))
        assert.equal(existsSync(join(run.storage, "session.json")), true)
        assert.ok(run.event.system.length >= 1)

        const factoryCtx = {
            host: run.adapter,
            registry: run.registry,
            logger: run.logger,
            config: run.config,
            prompts: run.prompts,
        }
        const compressTool = createV2Tool(
            createCompressRangeToolDefinition(factoryCtx),
            factoryCtx,
            run.adapter,
            { global: undefined, agents: {} },
        )
        // A committed session must be reachable by the compress tool; before the fix the
        // rejected projection left no initialized state for this call to act on.
        const toolResult = await compressTool.execute(
            { content: [{ startId: "m99999", endId: "m99999", summary: "not executed" }] },
            {
                sessionID: "session",
                agent: "code",
                messageID: "dup-tool-message",
                id: "dup-tool-call",
                progress: async () => {},
            },
        )
        assert.doesNotMatch(String(toolResult.content), /no initialized state/i)
        assert.ok(run.registry.get("session"))
    } finally {
        rmSync(run.storage, { recursive: true, force: true })
    }
})

test("V2 auxiliary agents skip projection, catalog, state, and effects", async () => {
    for (const agent of ["title", "summary", "compaction"] as const) {
        const run = runHandler(
            [{ type: "user", id: `${agent}-user`, time: { created: 1 }, text: "request" }],
            [Message.make({ id: `${agent}-user`, role: "user", content: "request" })],
            modelA,
            [],
        )
        const projectedCalls: string[] = []
        const catalogCalls: string[] = []
        const notifications: string[] = []
        run.adapter.projectedContext = async (sessionID) => {
            projectedCalls.push(sessionID)
            return []
        }
        run.adapter.models.list = async () => {
            catalogCalls.push("catalog")
            return []
        }
        run.adapter.notifications = {
            notify: (input) => {
                notifications.push(input.message)
            },
        }
        const messages = [Message.make({ id: `${agent}-user`, role: "user", content: "request" })]
        const system = [SystemPart.make("host system")]
        const event = { ...context("session", modelA, messages), agent, system }
        const messageValues = [...event.messages]
        const systemValues = [...event.system]

        try {
            await run.handler(event)
            assert.deepEqual(projectedCalls, [])
            assert.deepEqual(catalogCalls, [])
            assert.equal(run.registry.get("session"), undefined)
            assert.equal(run.registry.size, 0)
            assert.strictEqual(event.messages, messages)
            assert.deepEqual(event.messages, messageValues)
            assert.strictEqual(event.system, system)
            assert.deepEqual(event.system, systemValues)
            assert.deepEqual(notifications, [])
        } finally {
            rmSync(run.storage, { recursive: true, force: true })
        }
    }
})

test("V2 context serializes history projection and commit order per session", async () => {
    const storage = mkdtempSync(join(tmpdir(), "acp-v2-context-atomic-"))
    const logger = new Logger(false, "silent")
    const cfg = config(storage)
    const registry = new SessionStateRegistry(logger, "/tmp/opencode-v2-context")
    const prompts = new PromptStore(logger, "/tmp/opencode-v2-context")
    let calls = 0
    let historyStarted!: () => void
    const firstHistoryStarted = new Promise<void>((resolve) => {
        historyStarted = resolve
    })
    let releaseFirst!: () => void
    const firstBlocked = new Promise<void>((resolve) => {
        releaseFirst = resolve
    })
    const adapter = host(new Map(), [
        { providerId: "provider-a", modelId: "model-a", contextLimit: 100_000 },
    ])
    adapter.projectedContext = async () => {
        calls++
        if (calls === 1) {
            historyStarted()
            await firstBlocked
            return [{ type: "user", id: "atomic-user", time: { created: 1 }, text: "old history" }]
        }
        return [{ type: "user", id: "atomic-user", time: { created: 2 }, text: "new history" }]
    }
    const handler = createV2ContextHandler(adapter, registry, logger, cfg, prompts, {
        global: undefined,
        agents: {},
    })
    const firstEvent = context("atomic-session", modelA, [
        Message.make({ id: "atomic-user", role: "user", content: "old history" }),
    ])
    const secondEvent = context("atomic-session", modelA, [
        Message.make({ id: "atomic-user", role: "user", content: "new history" }),
    ])

    try {
        const firstRequest = handler(firstEvent)
        await firstHistoryStarted
        const secondRequest = handler(secondEvent)
        await Promise.resolve()
        assert.equal(calls, 1)
        releaseFirst()
        await Promise.all([firstRequest, secondRequest])
        assert.equal(calls, 2)
        assert.match(String(secondEvent.messages[0]?.content[0]?.text), /new history/)
    } finally {
        rmSync(storage, { recursive: true, force: true })
    }
})

test("V2 model switches use the selected event model's catalog limit", async () => {
    const projected = [{ type: "user", id: "switch-user", time: { created: 1 }, text: "request" }]
    const outgoing = [Message.make({ id: "switch-user", role: "user", content: "request" })]
    const run = runHandler(projected, outgoing, modelB)
    await run.handler(run.event)
    try {
        const state = run.registry.get("session")
        assert.ok(state)
        assert.equal(state.modelContextLimit, 200_000)
        assert.equal(state.modelProviderID, "provider-b")
        assert.equal(state.modelID, "model-b")
    } finally {
        rmSync(run.storage, { recursive: true, force: true })
    }
})

test("V2 context resolves cached limits after catalog omission/failure without masking a switch", async () => {
    const projected = [{ type: "user", id: "cached-user", time: { created: 1 }, text: "request" }]
    const first = runHandler(
        projected,
        [Message.make({ id: "cached-user", role: "user", content: "request" })],
        modelA,
        [{ providerId: "provider-a", modelId: "model-a", contextLimit: 100_000 }],
    )
    await first.handler(first.event)
    try {
        assert.equal(first.registry.get("session")?.modelContextLimit, 100_000)

        first.adapter.models.list = async () => {
            throw new Error("temporary catalog outage")
        }
        const transientEvent = context("session", modelA, [
            Message.make({ id: "cached-user", role: "user", content: "request" }),
        ])
        await first.handler(transientEvent)
        assert.equal(first.registry.get("session")?.modelContextLimit, 100_000)
        assert.equal(first.registry.get("session")?.modelID, "model-a")

        first.adapter.models.list = async () => []
        const switchedEvent = context("session", modelB, [
            Message.make({ id: "cached-user", role: "user", content: "request" }),
        ])
        await first.handler(switchedEvent)
        const switchedState = first.registry.get("session")
        assert.ok(switchedState)
        assert.equal(switchedState.modelContextLimit, undefined)
        assert.equal(switchedState.modelProviderID, "provider-b")
        assert.equal(switchedState.modelID, "model-b")
    } finally {
        rmSync(first.storage, { recursive: true, force: true })
    }
})

test("completed V2 compaction resets transient state while retaining active compression blocks", async () => {
    const initial = runHandler(
        [{ type: "user", id: "before", time: { created: 1 }, text: "before" }],
        [Message.make({ id: "before", role: "user", content: "before" })],
    )
    await initial.handler(initial.event)
    const state = initial.registry.get("session")!
    state.nudges.lastPerMessageNudgeTokens = 42
    state.toolParameters.set("tool", {
        tool: "read",
        parameters: {},
        turn: 1,
    })
    state.stats.pruneTokenCounter = 123
    state.stats.totalPruneTokens = 456
    const preservedBlock: CompressionBlock = {
        blockId: 7,
        runId: 3,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 120,
        effectiveCompressedTokens: 120,
        summaryTokens: 24,
        durationMs: 17,
        mode: "range",
        tier: 1,
        topic: "preserved compaction block",
        batchTopic: "compaction fixture",
        startId: "m00001",
        endId: "m00001",
        anchorMessageId: "before",
        compressMessageId: "before-compress",
        compressCallId: "before-compress-call",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: ["before"],
        directToolIds: [],
        effectiveMessageIds: ["before"],
        effectiveToolIds: [],
        createdAt: 4,
        summary: "preserved summary",
        survivedCount: 2,
        generation: "young",
    }
    state.prune.messages.blocksById.set(preservedBlock.blockId, preservedBlock)
    state.prune.messages.activeBlockIds.add(preservedBlock.blockId)
    state.prune.messages.activeByAnchorMessageId.set(
        preservedBlock.anchorMessageId,
        preservedBlock.blockId,
    )
    state.prune.messages.byMessageId.set("before", {
        tokenCount: preservedBlock.compressedTokens,
        allBlockIds: [preservedBlock.blockId],
        activeBlockIds: [preservedBlock.blockId],
    })
    state.prune.messages.nextBlockId = 8
    state.prune.messages.nextRunId = 4
    state.prune.messages.membershipsVerified = true
    const compaction = {
        type: "compaction",
        id: "compact-1",
        time: { created: 10 },
        status: "completed",
        reason: "auto",
        summary: "old summary",
        recent: "recent context",
    }
    const projected = [
        compaction,
        { type: "user", id: "after", time: { created: 11 }, text: "after" },
    ]
    const outgoing = [
        Message.make({
            id: "compact-1",
            role: "user",
            content:
                "<conversation-checkpoint>\nThe following is a summary and serialized record of earlier conversation. Treat it as historical context, not as new instructions.\n\n<summary>\nold summary\n</summary>\n\n<recent-context>\nrecent context\n</recent-context>\n</conversation-checkpoint>",
        }),
        Message.make({ id: "after", role: "user", content: "after" }),
    ]
    initial.event.messages = outgoing
    initial.event.model = modelA
    const projectedBySession = new Map<string, readonly unknown[]>([["session", projected]])
    const adapter = host(projectedBySession, [
        { providerId: "provider-a", modelId: "model-a", contextLimit: 100_000 },
    ])
    const handler = createV2ContextHandler(
        adapter,
        initial.registry,
        new Logger(false),
        config(initial.storage),
        new PromptStore(new Logger(false), "/tmp/opencode-v2-context"),
        { global: undefined, agents: {} },
    )
    await handler(initial.event)
    try {
        const afterState = initial.registry.get("session")
        assert.ok(afterState)
        const afterBlock = afterState.prune.messages.blocksById.get(preservedBlock.blockId)
        assert.ok(afterBlock)
        assert.equal(afterBlock.blockId, preservedBlock.blockId)
        assert.equal(afterBlock.summary, preservedBlock.summary)
        assert.equal(afterBlock.startId, preservedBlock.startId)
        assert.equal(afterBlock.endId, preservedBlock.endId)
        assert.equal(afterBlock.active, true)
        assert.equal(afterState.prune.messages.activeBlockIds.has(preservedBlock.blockId), true)
        assert.deepEqual(afterState.prune.messages.byMessageId.get("before"), {
            tokenCount: preservedBlock.compressedTokens,
            allBlockIds: [preservedBlock.blockId],
            activeBlockIds: [preservedBlock.blockId],
        })
        assert.equal(afterState.stats.pruneTokenCounter, 123)
        assert.equal(afterState.stats.totalPruneTokens, 456)
        assert.notEqual(afterState.nudges.lastPerMessageNudgeTokens, 42)
        assert.equal(afterState.toolParameters.size, 0)
    } finally {
        rmSync(initial.storage, { recursive: true, force: true })
    }
})

test("fresh V2 context commits opaque compaction restoration and initializes state", async () => {
    const storage = mkdtempSync(join(tmpdir(), "acp-v2-fresh-opaque-"))
    const seedLogger = new Logger(false, "silent")
    const cfg = config(storage)
    const seededState = createSessionState()
    seededState.sessionId = "session"
    seededState.storageDir = storage
    seededState.stats.pruneTokenCounter = 41
    seededState.stats.totalPruneTokens = 82
    const seededBlock = seedActiveCompactionBlock(seededState, "fresh-opaque-compaction", 7)
    await saveSessionState(seededState, seedLogger)
    const stateFile = join(storage, "session.json")
    const persistedBefore = readFileSync(stateFile, "utf8")

    const logger = new Logger(false, "silent")
    const registry = new SessionStateRegistry(logger, "/tmp/opencode-v2-context")
    const prompts = new PromptStore(logger, "/tmp/opencode-v2-context")
    const noticeID = "msg_acp_notice_abcdef0123456789"
    const compaction = {
        type: "compaction",
        id: "fresh-opaque-compaction",
        time: { created: 2 },
        status: "completed",
        reason: "auto",
        summary: "native summary",
        recent: "native recent",
        providerState: { responseId: "native-summary" },
    }
    const staleAssistantText = "assistant <dcp-message-id>m00001</dcp-message-id>"
    const projected = [
        { type: "user", id: "opaque-before", time: { created: 1 }, text: "before" },
        {
            type: "synthetic",
            id: noticeID,
            time: { created: 1.5 },
            text: "command output",
            metadata: { acpOwned: true },
        },
        compaction,
        {
            type: "assistant",
            id: "fresh-opaque-assistant",
            time: { created: 3 },
            agent: "code",
            model: modelA,
            content: [{ type: "text", text: staleAssistantText }],
        },
    ]
    const adapter = host(new Map([["session", projected]]), [
        { providerId: "provider-a", modelId: "model-a", contextLimit: 100_000 },
    ])
    const handler = createV2ContextHandler(adapter, registry, logger, cfg, prompts, {
        global: undefined,
        agents: {},
    })
    const nativeFixture = makeNativeCompactionFixture("fresh-opaque-compaction")
    const nativeCompaction = nativeFixture.message
    const event = context("session", modelA, [
        Message.make({ id: "opaque-before", role: "user", content: "before" }),
        Message.make({ id: noticeID, role: "user", content: "command output" }),
        nativeCompaction,
        Message.make({
            id: "fresh-opaque-assistant",
            role: "assistant",
            content: staleAssistantText,
        }),
    ])

    try {
        assert.equal(registry.get("session"), undefined)
        await handler(event)

        const state = registry.get("session")
        assert.ok(state)
        assert.notEqual(readFileSync(stateFile, "utf8"), persistedBefore)
        assert.equal(state.lastCompaction, 2)
        assert.equal(state.modelContextLimit, 100_000)
        assert.equal(state.stats.pruneTokenCounter, 41)
        assert.equal(state.stats.totalPruneTokens, 82)
        const recoveredBlock = state.prune.messages.blocksById.get(seededBlock.blockId)
        assert.ok(recoveredBlock)
        assert.equal(recoveredBlock.summary, seededBlock.summary)
        assert.equal(recoveredBlock.active, true)

        const restoredCompaction = event.messages.find(
            (message) => message.id === "fresh-opaque-compaction",
        )
        assert.strictEqual(restoredCompaction, nativeCompaction)
        assert.strictEqual(restoredCompaction?.content[0], nativeCompaction.content[0])
        assert.deepEqual(restoredCompaction?.content, nativeFixture.expectedContent)
        assert.deepEqual(
            restoredCompaction?.providerMetadata,
            nativeFixture.expectedProviderMetadata,
        )
        assert.deepEqual(restoredCompaction?.native, nativeFixture.expectedNative)
        assert.equal(
            event.messages.some((message) => message.id === noticeID),
            false,
        )
        const sanitizedAssistant = event.messages.find(
            (message) => message.id === "fresh-opaque-assistant",
        )?.content[0]?.text
        assert.match(sanitizedAssistant ?? "", /^assistant /)
        assert.equal(sanitizedAssistant?.includes("m00001"), false)
        assert.equal(event.system.length, 1)

        const factoryCtx = {
            host: adapter,
            registry,
            logger,
            config: cfg,
            prompts,
        }
        const compressTool = createV2Tool(
            createCompressRangeToolDefinition(factoryCtx),
            factoryCtx,
            adapter,
            { global: undefined, agents: {} },
        )
        const toolResult = await compressTool.execute(
            {
                content: [{ startId: "m99999", endId: "m99999", summary: "not executed" }],
            },
            {
                sessionID: "session",
                agent: "code",
                messageID: "fresh-opaque-tool-message",
                id: "fresh-opaque-tool-call",
                progress: async () => {},
            },
        )
        assert.doesNotMatch(String(toolResult.content), /no initialized state/i)
    } finally {
        rmSync(storage, { recursive: true, force: true })
    }
})

test("V2 restores a dropped opaque compaction source before committing context state", async () => {
    const run = runHandler(
        [{ type: "user", id: "opaque-before", time: { created: 1 }, text: "before" }],
        [Message.make({ id: "opaque-before", role: "user", content: "before" })],
    )
    await run.handler(run.event)

    const state = run.registry.get("session")
    assert.ok(state)
    const compactBlock = seedActiveCompactionBlock(state, "opaque-compaction")

    const noticeID = "msg_acp_notice_0123456789abcdef"
    const compaction = {
        type: "compaction",
        id: "opaque-compaction",
        time: { created: 2 },
        status: "completed",
        reason: "auto",
        summary: "native summary",
        recent: "native recent",
        providerState: { responseId: "native-summary" },
    }
    const staleAssistantText = "assistant <dcp-message-id>m00001</dcp-message-id>"
    run.adapter.projectedContext = async () => [
        { type: "user", id: "opaque-before", time: { created: 1 }, text: "before" },
        {
            type: "synthetic",
            id: noticeID,
            time: { created: 1.5 },
            text: "command output",
            metadata: { acpOwned: true },
        },
        compaction,
        {
            type: "assistant",
            id: "opaque-assistant",
            time: { created: 3 },
            agent: "code",
            model: modelA,
            content: [{ type: "text", text: staleAssistantText }],
        },
    ]

    const nativeFixture = makeNativeCompactionFixture("opaque-compaction")
    const nativeCompaction = nativeFixture.message
    const event = context("session", modelA, [
        Message.make({ id: "opaque-before", role: "user", content: "before" }),
        Message.make({ id: noticeID, role: "user", content: "command output" }),
        nativeCompaction,
        Message.make({ id: "opaque-assistant", role: "assistant", content: staleAssistantText }),
    ])

    try {
        await run.handler(event)

        assert.equal(
            event.messages.some((message) => message.id === "opaque-compaction"),
            true,
        )
        const restoredCompaction = event.messages.find(
            (message) => message.id === "opaque-compaction",
        )
        assert.strictEqual(restoredCompaction, nativeCompaction)
        assert.strictEqual(restoredCompaction?.content[0], nativeCompaction.content[0])
        assert.deepEqual(restoredCompaction?.content, nativeFixture.expectedContent)
        assert.deepEqual(
            restoredCompaction?.providerMetadata,
            nativeFixture.expectedProviderMetadata,
        )
        assert.deepEqual(restoredCompaction?.native, nativeFixture.expectedNative)
        assert.equal(
            event.messages.some((message) => message.id === noticeID),
            false,
        )
        const sanitizedAssistant = event.messages.find(
            (message) => message.id === "opaque-assistant",
        )?.content[0]?.text
        assert.match(sanitizedAssistant ?? "", /^assistant /)
        assert.equal(sanitizedAssistant?.includes("m00001"), false)
        assert.equal(event.system.length, 1)
        assert.ok(run.registry.get("session"))
        assert.equal(existsSync(join(run.storage, "session.json")), true)

        const factoryCtx = {
            host: run.adapter,
            registry: run.registry,
            logger: run.logger,
            config: run.config,
            prompts: run.prompts,
        }
        const compressTool = createV2Tool(
            createCompressRangeToolDefinition(factoryCtx),
            factoryCtx,
            run.adapter,
            { global: undefined, agents: {} },
        )
        const toolResult = await compressTool.execute(
            {
                content: [{ startId: "m99999", endId: "m99999", summary: "not executed" }],
            },
            {
                sessionID: "session",
                agent: "code",
                messageID: "opaque-tool-message",
                id: "opaque-tool-call",
                progress: async () => {},
            },
        )
        assert.doesNotMatch(String(toolResult.content), /no initialized state/i)
    } finally {
        rmSync(run.storage, { recursive: true, force: true })
    }
})

test("V2 sanitation is outbound-only for historical assistant text", async () => {
    const stale = "assistant <dcp-message-id>m00001</dcp-message-id>"
    const projected = [
        { type: "user", id: "sanitize-user", time: { created: 1 }, text: "request" },
        {
            type: "assistant",
            id: "sanitize-assistant",
            time: { created: 2 },
            agent: "code",
            model: modelA,
            content: [{ type: "text", text: stale }],
        },
    ]
    const outgoing = [
        Message.make({ id: "sanitize-user", role: "user", content: "request" }),
        Message.make({ id: "sanitize-assistant", role: "assistant", content: stale }),
    ]
    const run = runHandler(projected, outgoing)
    await run.handler(run.event)
    try {
        assert.match(run.event.messages[1]?.content[0]?.text ?? "", /^assistant /)
        assert.equal(run.event.messages[1]?.content[0]?.text.includes("m00001"), false)
        assert.equal((projected[1] as Record<string, unknown>).content[0].text, stale)
        const stateFile = join(run.storage, "session.json")
        assert.equal(readFileSync(stateFile, "utf8").includes(stale), false)
    } finally {
        rmSync(run.storage, { recursive: true, force: true })
    }
})

test("V2 ACP-owned command notices stay in history but never reach outbound context", async () => {
    const noticeID = "msg_acp_notice_0123456789abcdef"
    const projected = [
        {
            type: "synthetic",
            id: noticeID,
            time: { created: 1 },
            text: "[ACP Status] command output",
            metadata: { acpOwned: true },
        },
        { type: "user", id: "notice-user", time: { created: 2 }, text: "continue" },
    ]
    const outgoing = [
        Message.make({ id: noticeID, role: "user", content: "[ACP Status] command output" }),
        Message.make({ id: "notice-user", role: "user", content: "continue" }),
    ]
    const run = runHandler(projected, outgoing)
    await run.handler(run.event)
    try {
        assert.equal(
            run.event.messages.some((message) => message.id === noticeID),
            false,
        )
        assert.equal(
            run.event.messages.some((message) => message.id === "notice-user"),
            true,
        )
    } finally {
        rmSync(run.storage, { recursive: true, force: true })
    }
})

test("V2 denied agent permissions suppress the ACP prompt and nudges", async () => {
    const projected = [{ type: "user", id: "denied-user", time: { created: 1 }, text: "request" }]
    const run = runHandler(projected, [
        Message.make({ id: "denied-user", role: "user", content: "request" }),
    ])
    run.adapter.agentPermissions = async () => [{ action: "*", resource: "*", effect: "deny" }]
    await run.handler(run.event)
    try {
        assert.equal(run.registry.get("session")?.compressPermission, "deny")
        assert.equal(run.event.system.length, 0)
        assert.equal(
            run.event.messages.some((message) =>
                message.content.some(
                    (part) => part.type === "text" && /compress tool/i.test(part.text),
                ),
            ),
            false,
        )
    } finally {
        rmSync(run.storage, { recursive: true, force: true })
    }
})

test("V2 ambiguous opaque restoration rolls back live state, event, persistence, and deferred effects", async () => {
    const storage = mkdtempSync(join(tmpdir(), "acp-v2-rejection-"))
    const logger = new Logger(false, "silent")
    const cfg = config(storage, true)
    const registry = new SessionStateRegistry(logger, "/tmp/opencode-v2-context")
    const prompts = new PromptStore(logger, "/tmp/opencode-v2-context")
    const notifications: string[] = []
    const deferredEffects: string[] = []
    const projectedBySession = new Map<string, readonly unknown[]>([
        ["session", [{ type: "user", id: "initial", time: { created: 1 }, text: "initial" }]],
    ])
    const adapter = host(
        projectedBySession,
        [{ providerId: "provider-a", modelId: "model-a", contextLimit: 100_000 }],
        new Map(),
        notifications,
    )
    logger.saveContext = async () => {
        deferredEffects.push("debug-context")
    }
    const handler = createV2ContextHandler(adapter, registry, logger, cfg, prompts, {
        global: undefined,
        agents: {},
    })
    await handler(
        context("session", modelA, [
            Message.make({ id: "initial", role: "user", content: "initial" }),
        ]),
    )

    try {
        const state = registry.get("session")
        assert.ok(state)
        const block: CompressionBlock = {
            blockId: 1,
            runId: 1,
            active: true,
            deactivatedByUser: false,
            compressedTokens: 10,
            summaryTokens: 2,
            durationMs: 0,
            topic: "rollback",
            startId: "system-source",
            endId: "system-source",
            anchorMessageId: "system-source",
            compressMessageId: "system-source",
            includedBlockIds: [],
            consumedBlockIds: [],
            parentBlockIds: [],
            directMessageIds: ["system-source"],
            directToolIds: [],
            effectiveMessageIds: ["system-source"],
            effectiveToolIds: [],
            createdAt: 1,
            summary: "rollback",
            survivedCount: 0,
        }
        state.prune.messages.blocksById.set(1, block)
        state.prune.messages.activeBlockIds.add(1)
        state.prune.messages.activeByAnchorMessageId.set("system-source", 1)
        state.prune.messages.byMessageId.set("system-source", {
            tokenCount: 10,
            allBlockIds: [1],
            activeBlockIds: [1],
        })
        state.prune.messages.membershipsVerified = true
        state.prune.messages.structureVersion = 1
        state.prune.messages.lastSyncedStructureVersion = 0
        state.nudges.lastPerMessageNudgeTokens = 77
        await saveSessionState(state, logger)
        const persistedBefore = readFileSync(join(storage, "session.json"), "utf8")
        const stateBefore = cloneSessionState(state)
        notifications.length = 0
        deferredEffects.length = 0

        projectedBySession.set("session", [
            { type: "system", id: "system-source", time: { created: 2 }, text: "opaque system" },
            { type: "user", id: "after-rejection", time: { created: 3 }, text: "safe user" },
        ])
        const event = context("session", modelA, [
            // The changed opaque source has no exact lowered correlation; the
            // restoration helper must fail closed rather than inventing one.
            Message.make({ role: "system", content: "newer opaque system" }),
            Message.make({ id: "after-rejection", role: "user", content: "safe user" }),
        ])
        const eventMessagesBefore = event.messages
        const eventSystemBefore = event.system
        const eventMessageValues = [...event.messages]
        const eventSystemValues = [...event.system]

        await handler(event)

        assert.strictEqual(event.messages, eventMessagesBefore)
        assert.deepEqual(event.messages, eventMessageValues)
        assert.strictEqual(event.system, eventSystemBefore)
        assert.deepEqual(event.system, eventSystemValues)
        assert.deepEqual(cloneSessionState(state), stateBefore)
        assert.equal(readFileSync(join(storage, "session.json"), "utf8"), persistedBefore)
        assert.deepEqual(notifications, [])
        assert.deepEqual(deferredEffects, [])
    } finally {
        rmSync(storage, { recursive: true, force: true })
    }
})

test("V2 context does not hydrate permissions after an awaited lookup crosses unload", async () => {
    const run = runHandler(
        [{ type: "user", id: "preflight-user", time: { created: 1 }, text: "request" }],
        [Message.make({ id: "preflight-user", role: "user", content: "request" })],
        modelA,
        [],
    )
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
        release = resolve
    })
    let started!: () => void
    const startedSignal = new Promise<void>((resolve) => {
        started = resolve
    })
    let active = true
    run.adapter.agentPermissions = async () => {
        started()
        await gate
        return [{ action: "*", resource: "*", effect: "allow" }]
    }
    const permissions = { global: undefined, agents: {}, v2Agents: {} }
    const handler = createV2ContextHandler(
        run.adapter,
        run.registry,
        run.logger,
        run.config,
        run.prompts,
        permissions,
        () => active,
    )
    const event = context("session", modelA, [
        Message.make({ id: "preflight-user", role: "user", content: "request" }),
    ])
    const originalMessages = event.messages
    const pending = handler(event)
    await startedSignal
    active = false
    release()
    await pending

    try {
        assert.deepEqual(permissions.v2Agents, {})
        assert.equal(run.registry.get("session"), undefined)
        assert.equal(run.registry.resolveModelLimit(modelA.providerID, modelA.id), undefined)
        assert.strictEqual(event.messages, originalMessages)
        assert.equal(event.system.length, 0)
    } finally {
        rmSync(run.storage, { recursive: true, force: true })
    }
})

test("V2 context does not record a catalog result after unload", async () => {
    const run = runHandler(
        [{ type: "user", id: "catalog-user", time: { created: 1 }, text: "request" }],
        [Message.make({ id: "catalog-user", role: "user", content: "request" })],
        modelA,
        [],
    )
    run.adapter.agentPermissions = undefined
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
        release = resolve
    })
    let started!: () => void
    const startedSignal = new Promise<void>((resolve) => {
        started = resolve
    })
    let active = true
    run.adapter.models.list = async () => {
        started()
        await gate
        return [{ providerId: modelA.providerID, modelId: modelA.id, contextLimit: 123_456 }]
    }
    const handler = createV2ContextHandler(
        run.adapter,
        run.registry,
        run.logger,
        run.config,
        run.prompts,
        { global: undefined, agents: {}, v2Agents: {} },
        () => active,
    )
    const pending = handler(
        context("catalog-session", modelA, [
            Message.make({ id: "catalog-user", role: "user", content: "request" }),
        ]),
    )
    await startedSignal
    active = false
    release()
    await pending

    try {
        assert.equal(run.registry.resolveModelLimit(modelA.providerID, modelA.id), undefined)
        assert.equal(run.registry.get("catalog-session"), undefined)
    } finally {
        rmSync(run.storage, { recursive: true, force: true })
    }
})

test("V2 context restores event messages and system when synchronous external commit throws", async () => {
    const run = runHandler(
        [{ type: "user", id: "commit-error-user", time: { created: 1 }, text: "request" }],
        [Message.make({ id: "commit-error-user", role: "user", content: "request" })],
    )
    const event = run.event
    const originalMessages = event.messages
    const originalSystem = event.system
    let attempted = false
    Object.defineProperty(event, "messages", {
        configurable: true,
        get: () => originalMessages,
        set: () => {
            attempted = true
            throw new Error("host refused context replacement")
        },
    })

    try {
        await run.handler(event)
        assert.equal(attempted, true)
        assert.equal(run.registry.get("session"), undefined)
        assert.strictEqual(event.messages, originalMessages)
        assert.deepEqual(event.messages, [originalMessages[0]])
        assert.strictEqual(event.system, originalSystem)
        assert.deepEqual(event.system, [])
    } finally {
        rmSync(run.storage, { recursive: true, force: true })
    }
})
