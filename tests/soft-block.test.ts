import assert from "node:assert/strict"
import test from "node:test"
import { createCompressRangeTool } from "../lib/compress/range"
import { createSessionState, type WithParts } from "../lib/state"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"

const testDataHome = `/tmp/opencode-dcp-softblock-${process.pid}`
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
        manualMode: { enabled: false, automaticStrategies: true },
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
        },
        strategies: {
            deduplication: { enabled: true, protectedTools: [] },
            purgeErrors: { enabled: true, turns: 4, protectedTools: [] },
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

function buildMessages(sessionID: string): WithParts[] {
    return [
        {
            info: {
                id: "msg-user-1",
                role: "user",
                sessionID,
                agent: "assistant",
                model: { providerID: "anthropic", modelID: "claude-test" },
                time: { created: 1 },
            } as WithParts["info"],
            parts: [textPart("msg-user-1", sessionID, "p1", "x".repeat(6000))],
        },
        {
            info: {
                id: "msg-assistant-1",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
            } as WithParts["info"],
            parts: [textPart("msg-assistant-1", sessionID, "p2", "x".repeat(6000))],
        },
        {
            info: {
                id: "msg-user-2",
                role: "user",
                sessionID,
                agent: "assistant",
                model: { providerID: "anthropic", modelID: "claude-test" },
                time: { created: 3 },
            } as WithParts["info"],
            parts: [textPart("msg-user-2", sessionID, "p3", "x".repeat(6000))],
        },
    ]
}

function createTool(state: any, rawMessages: WithParts[], sessionID: string) {
    return createCompressRangeTool({
        client: {
            session: {
                messages: async () => ({ data: rawMessages }),
                get: async () => ({ data: { parentID: null } }),
            },
        },
        state,
        logger: new Logger(false),
        config: buildConfig(),
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

test("soft-block: first attempt to compress last segment throws confirmation error", async () => {
    const sessionID = `ses_softblock_1_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()
    const tool = createTool(state, rawMessages, sessionID)

    await assert.rejects(
        () =>
            tool.execute(
                {
                    topic: "Test",
                    content: [
                        {
                            startId: "m00001",
                            endId: "m00003",
                            summary: "x".repeat(2000),
                        },
                    ],
                },
                { ...toolCtx, sessionID },
            ),
        (err: Error) => {
            assert.ok(
                err.message.includes("most recent message"),
                `error should mention most recent message, got: ${err.message}`,
            )
            return true
        },
    )
    assert.ok(
        state.nudges.lastSegmentConfirmAttempts.has("msg-user-2"),
        "lastSegmentConfirmAttempts should contain the last message id after first attempt",
    )
})

test("soft-block: second attempt (same last message) succeeds", async () => {
    const sessionID = `ses_softblock_2_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()
    const tool = createTool(state, rawMessages, sessionID)

    await assert.rejects(
        () =>
            tool.execute(
                {
                    topic: "Test",
                    content: [{ startId: "m00001", endId: "m00003", summary: "x".repeat(2000) }],
                },
                { ...toolCtx, sessionID },
            ),
    )

    const result = await tool.execute(
        {
            topic: "Test",
            content: [{ startId: "m00001", endId: "m00003", summary: "x".repeat(2000) }],
        },
        { ...toolCtx, sessionID },
    )
    assert.ok(
        typeof result === "string" && result.includes("Compressed"),
        "second attempt should succeed",
    )
})

test("soft-block: range not covering last message is not blocked", async () => {
    const sessionID = `ses_softblock_3_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()
    const tool = createTool(state, rawMessages, sessionID)

    const result = await tool.execute(
        {
            topic: "Test",
            content: [{ startId: "m00001", endId: "m00002", summary: "x".repeat(2000) }],
        },
        { ...toolCtx, sessionID },
    )
    assert.ok(
        typeof result === "string" && result.includes("Compressed"),
        "range not covering last message should succeed without confirmation",
    )
    assert.equal(
        state.nudges.lastSegmentConfirmAttempts.size,
        0,
        "no confirm attempts recorded when last message not in range",
    )
})

test("soft-block: disabled via config does not block", async () => {
    const sessionID = `ses_softblock_4_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()
    const config = buildConfig()
    config.compress.lastSegmentSoftBlock = false
    const tool = createCompressRangeTool({
        client: {
            session: {
                messages: async () => ({ data: rawMessages }),
                get: async () => ({ data: { parentID: null } }),
            },
        },
        state,
        logger: new Logger(false),
        config,
        prompts: {
            reload() {},
            getRuntimePrompts() {
                return { compressRange: "", compressMessage: "" }
            },
        },
    } as any)

    const result = await tool.execute(
        {
            topic: "Test",
            content: [{ startId: "m00001", endId: "m00003", summary: "x".repeat(2000) }],
        },
        { ...toolCtx, sessionID },
    )
    assert.ok(
        typeof result === "string" && result.includes("Compressed"),
        "soft-block disabled → compress succeeds without confirmation",
    )
})

test("soft-block: new last message after compression triggers fresh confirmation", async () => {
    const sessionID = `ses_softblock_5_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()

    const tool1 = createTool(state, rawMessages, sessionID)

    await assert.rejects(
        () =>
            tool1.execute(
                {
                    topic: "Test",
                    content: [{ startId: "m00001", endId: "m00003", summary: "x".repeat(2000) }],
                },
                { ...toolCtx, sessionID },
            ),
    )

    await tool1.execute(
        {
            topic: "Test",
            content: [{ startId: "m00001", endId: "m00003", summary: "x".repeat(2000) }],
        },
        { ...toolCtx, sessionID },
    )

    assert.equal(
        state.nudges.lastSegmentConfirmAttempts.size,
        1,
        "confirm set has one entry after successful compression of last segment",
    )
})
