import assert from "node:assert/strict"
import test from "node:test"
import { createCompressRangeTool } from "../lib/compress/range"
import { createSessionState, type WithParts } from "../lib/state"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"
import { singletonRegistry } from "./registry-stub"

const testDataHome = `/tmp/opencode-dcp-dangerous-${process.pid}`
process.env.XDG_DATA_HOME = testDataHome

import { mkdirSync } from "fs"
mkdirSync(testDataHome, { recursive: true })

function buildConfig(): PluginConfig {
    return {
        enabled: true,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: { enabled: true, protectedTools: [] },
        manualMode: { enabled: false },
        turnProtection: { enabled: false, turns: 4 },
        experimental: { allowSubAgents: false, customPrompts: false },
        protectedFilePatterns: [],
        autoUpdate: true,
        compress: {
            mode: "range",
            permission: "allow",
            showCompression: false,
            maxContextLimit: 150000,
            minContextLimit: 50000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: [],
            protectTags: false,
            protectUserMessages: false,
            lastSegmentSoftBlock: true,
            preserveRecentMessages: 20,
            preserveRecentTokens: 20000,
            preserveLastUserMessage: true,
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

function textPart(messageID: string, sessionID: string, id: string, text: string) {
    return { id, messageID, sessionID, type: "text" as const, text }
}

function buildMessages(sessionID: string, count = 50): WithParts[] {
    const msgs: WithParts[] = []
    for (let i = 1; i <= count; i++) {
        const role = i % 2 === 1 ? "user" : "assistant"
        msgs.push({
            info: {
                id: `msg-${i}`,
                role,
                sessionID,
                agent: "assistant",
                ...(role === "user" ? { model: { providerID: "anthropic", modelID: "claude-test" } } : {}),
                time: { created: i },
            } as WithParts["info"],
            parts: [textPart(`msg-${i}`, sessionID, `p${i}`, "x".repeat(2000))],
        })
    }
    return msgs
}

function createTool(state: any, rawMessages: WithParts[], sessionID: string, configOverrides?: Partial<PluginConfig>) {
    const config = { ...buildConfig(), ...configOverrides }
    return createCompressRangeTool({
        client: {
            session: {
                messages: async () => ({ data: rawMessages }),
                get: async () => ({ data: { parentID: null } }),
            },
        },
        registry: singletonRegistry(state),
        logger: new Logger(false),
        config,
        prompts: {
            reload() {},
            getRuntimePrompts() {
                return { compressRange: "", compressMessage: "" }
            },
        },
    } as any)
}

const toolCtx = {
    ask: async () => {},
    metadata: () => {},
    messageID: "msg-compress",
}

const ref = (n: number) => `m${String(n).padStart(5, "0")}`

test("protected: compressing recent messages fails without dangerous", async () => {
    const sessionID = `ses_protected_1_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()
    const tool = createTool(state, rawMessages, sessionID)

    await assert.rejects(
        () =>
            tool.execute(
                {
                    topic: "Test",
                    content: [
                        { startId: ref(25), endId: ref(30), summary: "x".repeat(2000) },
                    ],
                },
                { ...toolCtx, sessionID },
            ),
        (err: Error) => {
            assert.ok(err.message.includes("protected"), `error should mention protected, got: ${err.message}`)
            return true
        },
    )
})

test("protected: compressing recent messages WITH dangerous: true succeeds", async () => {
    const sessionID = `ses_protected_2_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()
    const tool = createTool(state, rawMessages, sessionID)

    const result = await tool.execute(
        {
            topic: "Test",
            content: [{ startId: ref(25), endId: ref(30), summary: "x".repeat(2000) }],
            dangerous: true,
        },
        { ...toolCtx, sessionID },
    )
    assert.ok(typeof result === "string" && result.includes("Compressed"), "dangerous: true should succeed")
})

test("protected: compressing old messages (outside 20-msg window) succeeds without dangerous", async () => {
    const sessionID = `ses_protected_3_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()
    const tool = createTool(state, rawMessages, sessionID)

    const result = await tool.execute(
        {
            topic: "Test",
            content: [{ startId: ref(1), endId: ref(5), summary: "x".repeat(2000) }],
        },
        { ...toolCtx, sessionID },
    )
    assert.ok(typeof result === "string" && result.includes("Compressed"), "old range should succeed without dangerous")
})

test("protected: lastSegmentSoftBlock disabled bypasses protection entirely", async () => {
    const sessionID = `ses_protected_4_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()
    const tool = createTool(state, rawMessages, sessionID, {
        compress: { ...buildConfig().compress, lastSegmentSoftBlock: false },
    })

    const result = await tool.execute(
        {
            topic: "Test",
            content: [{ startId: ref(25), endId: ref(30), summary: "x".repeat(2000) }],
        },
        { ...toolCtx, sessionID },
    )
    assert.ok(typeof result === "string" && result.includes("Compressed"), "disabled protection should succeed")
})

test("protected: error message mentions protected message IDs", async () => {
    const sessionID = `ses_protected_5_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()
    const tool = createTool(state, rawMessages, sessionID)

    await assert.rejects(
        () =>
            tool.execute(
                {
                    topic: "Test",
                    content: [{ startId: ref(28), endId: ref(30), summary: "x".repeat(2000) }],
                },
                { ...toolCtx, sessionID },
            ),
        (err: Error) => {
            assert.ok(err.message.includes("msg-28"), "error should reference a protected message id")
            return true
        },
    )
})

test("protected: last user message is always protected even outside message window", async () => {
    const sessionID = `ses_protected_6_${Date.now()}`
    const rawMessages = buildMessages(sessionID, 30)
    const state = createSessionState()
    const tool = createTool(state, rawMessages, sessionID, {
        compress: {
            ...buildConfig().compress,
            preserveRecentMessages: 1,
            preserveRecentTokens: 100,
            preserveLastUserMessage: true,
        },
    })

    await assert.rejects(
        () =>
            tool.execute(
                {
                    topic: "Test",
                    content: [{ startId: ref(28), endId: ref(29), summary: "x".repeat(2000) }],
                },
                { ...toolCtx, sessionID },
            ),
        (err: Error) => {
            assert.ok(err.message.includes("msg-29"), `should be blocked by user message protection: ${err.message}`)
            return true
        },
    )
})

test("protected: custom preserveRecentMessages=5 only protects last 5", async () => {
    const sessionID = `ses_protected_7_${Date.now()}`
    const rawMessages = buildMessages(sessionID, 30)
    const state = createSessionState()
    const tool = createTool(state, rawMessages, sessionID, {
        compress: {
            ...buildConfig().compress,
            preserveRecentMessages: 5,
            preserveRecentTokens: 100,
            preserveLastUserMessage: false,
        },
    })

    const result = await tool.execute(
        {
            topic: "Test",
            content: [{ startId: ref(1), endId: ref(20), summary: "x".repeat(2000) }],
        },
        { ...toolCtx, sessionID },
    )
    assert.ok(typeof result === "string" && result.includes("Compressed"), "range ending before last 5 should succeed")
})

test("protected: lastSegmentSoftBlock=true with preserveRecentMessages=0 disables message-count protection", async () => {
    const sessionID = `ses_protected_8_${Date.now()}`
    const rawMessages = buildMessages(sessionID, 30)
    const state = createSessionState()
    const tool = createTool(state, rawMessages, sessionID, {
        compress: {
            ...buildConfig().compress,
            preserveRecentMessages: 0,
            preserveRecentTokens: 0,
            preserveLastUserMessage: false,
        },
    })

    const result = await tool.execute(
        {
            topic: "Test",
            content: [{ startId: ref(25), endId: ref(30), summary: "x".repeat(2000) }],
        },
        { ...toolCtx, sessionID },
    )
    assert.ok(typeof result === "string" && result.includes("Compressed"), "no protection should allow recent compression")
})
