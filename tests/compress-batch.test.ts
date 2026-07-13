import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdirSync } from "node:fs"
import { createCompressRangeTool } from "../lib/compress/range"
import { createSessionState, type WithParts } from "../lib/state"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"

const testDataHome = join(tmpdir(), `opencode-acp-batch-${process.pid}`)
const testConfigHome = join(tmpdir(), `opencode-acp-batch-config-${process.pid}`)

process.env.XDG_DATA_HOME = testDataHome
process.env.XDG_CONFIG_HOME = testConfigHome

mkdirSync(testDataHome, { recursive: true })
mkdirSync(testConfigHome, { recursive: true })

function buildConfig(cooldownOutputs?: number): PluginConfig {
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
            cooldownOutputs,
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
    const roles: Array<{ id: string; role: "user" | "assistant"; text: string }> = [
        { id: "msg-user-1", role: "user", text: "Investigate the auth flow" },
        { id: "msg-assistant-1", role: "assistant", text: "Mapped the login code path" },
        { id: "msg-user-2", role: "user", text: "Now fix the build error" },
        { id: "msg-assistant-2", role: "assistant", text: "Fixed the broken import" },
        { id: "msg-user-3", role: "user", text: "Ship it" },
        { id: "msg-assistant-3", role: "assistant", text: "Committed and pushed" },
    ]
    return roles.map((r, i) => ({
        info: {
            id: r.id,
            role: r.role,
            sessionID,
            agent: "assistant",
            ...(r.role === "user"
                ? {
                      model: { providerID: "anthropic", modelID: "claude-test" },
                  }
                : {}),
            time: { created: i + 1 },
        } as WithParts["info"],
        parts: [textPart(r.id, sessionID, `part-${i + 1}`, r.text)],
    }))
}

function makeToolCtx(sessionID: string, messageID: string) {
    return {
        ask: async () => {},
        metadata: () => {},
        sessionID,
        messageID,
    }
}

function makeTool(state: ReturnType<typeof createSessionState>, config: PluginConfig, rawMessages: WithParts[]) {
    return createCompressRangeTool({
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
}

test("multi-topic batch creates one block per range, each tagged with its own topic, sharing a runId", async () => {
    const sessionID = `ses_batch_multi_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()
    const tool = makeTool(state, buildConfig(2), rawMessages)

    await tool.execute(
        {
            topics: [
                {
                    topic: "Auth Exploration",
                    content: [{ startId: "m00001", endId: "m00002", summary: "Auth flow mapped." }],
                },
                {
                    topic: "Build Fix",
                    content: [{ startId: "m00003", endId: "m00004", summary: "Broken import fixed." }],
                },
            ],
        },
        makeToolCtx(sessionID, "msg-compress-multi"),
    )

    const blocks = Array.from(state.prune.messages.blocksById.values()).sort(
        (a, b) => a.blockId - b.blockId,
    )
    assert.equal(blocks.length, 2)
    assert.equal(blocks[0]?.topic, "Auth Exploration")
    assert.equal(blocks[1]?.topic, "Build Fix")
    assert.equal(blocks[0]?.runId, blocks[1]?.runId)
    assert.equal(blocks[0]?.batchTopic, "Auth Exploration")
    assert.equal(blocks[1]?.batchTopic, "Build Fix")
})

test("legacy single-topic { topic, content } shape is accepted via backward-compat shim", async () => {
    const sessionID = `ses_batch_legacy_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()
    const tool = makeTool(state, buildConfig(2), rawMessages)

    await tool.execute(
        {
            topic: "Legacy Single Topic",
            content: [{ startId: "m00001", endId: "m00002", summary: "Legacy shape worked." }],
        },
        makeToolCtx(sessionID, "msg-compress-legacy"),
    )

    const blocks = Array.from(state.prune.messages.blocksById.values())
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0]?.topic, "Legacy Single Topic")
    assert.equal(blocks[0]?.batchTopic, "Legacy Single Topic")
})

test("ranges overlapping across different topics are rejected globally", async () => {
    const sessionID = `ses_batch_overlap_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()
    const tool = makeTool(state, buildConfig(2), rawMessages)

    await assert.rejects(
        tool.execute(
            {
                topics: [
                    {
                        topic: "Topic A",
                        content: [{ startId: "m00001", endId: "m00003", summary: "Spans A." }],
                    },
                    {
                        topic: "Topic B",
                        content: [{ startId: "m00002", endId: "m00004", summary: "Spans B." }],
                    },
                ],
            },
            makeToolCtx(sessionID, "msg-compress-overlap"),
        ),
        /Overlapping ranges cannot be compressed in the same batch/,
    )

    assert.equal(state.prune.messages.blocksById.size, 0)
})

test("cooldown blocks a second compress when too few new assistant outputs exist", async () => {
    const sessionID = `ses_batch_cooldown_block_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()
    // Pin sessionId so prepareSession's ensureSessionInitialized is a no-op and doesn't reset state.
    state.sessionId = sessionID
    // Simulate a prior compress that happened at the current assistant-output count (delta would be 0).
    state.nudges.lastCompressAssistantCount = 3
    const tool = makeTool(state, buildConfig(2), rawMessages)

    await assert.rejects(
        tool.execute(
            {
                topics: [
                    {
                        topic: "Should Be Blocked",
                        content: [{ startId: "m00005", endId: "m00006", summary: "Blocked by cooldown." }],
                    },
                ],
            },
            makeToolCtx(sessionID, "msg-compress-blocked"),
        ),
        /Frequent compression blocked/,
    )

    assert.equal(state.prune.messages.blocksById.size, 0)
})

test("cooldown allows compress when enough new assistant outputs have appeared", async () => {
    const sessionID = `ses_batch_cooldown_allow_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()
    // Pin sessionId so prepareSession's ensureSessionInitialized is a no-op and doesn't reset state.
    state.sessionId = sessionID
    // Prior compress was 2 assistant outputs ago (3 now - 1 then = delta 2 >= cooldown 2).
    state.nudges.lastCompressAssistantCount = 1
    const tool = makeTool(state, buildConfig(2), rawMessages)

    await tool.execute(
        {
            topics: [
                {
                    topic: "Allowed After Threshold",
                    content: [{ startId: "m00001", endId: "m00002", summary: "Passed cooldown." }],
                },
            ],
        },
        makeToolCtx(sessionID, "msg-compress-allowed"),
    )

    assert.equal(state.prune.messages.blocksById.size, 1)
    assert.equal(state.nudges.lastCompressAssistantCount, 3)
})

test("manual mode (compress-pending) bypasses the cooldown", async () => {
    const sessionID = `ses_batch_cooldown_manual_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()
    // Pin sessionId so prepareSession's ensureSessionInitialized is a no-op and doesn't reset state.
    state.sessionId = sessionID
    state.nudges.lastCompressAssistantCount = 3
    state.manualMode = "compress-pending"
    const tool = makeTool(state, buildConfig(2), rawMessages)

    await tool.execute(
        {
            topics: [
                {
                    topic: "Manual Bypass",
                    content: [{ startId: "m00001", endId: "m00002", summary: "Manual trigger." }],
                },
            ],
        },
        makeToolCtx(sessionID, "msg-compress-manual"),
    )

    assert.equal(state.prune.messages.blocksById.size, 1)
})

test("cooldown disabled when cooldownOutputs is 0", async () => {
    const sessionID = `ses_batch_cooldown_disabled_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()
    state.nudges.lastCompressAssistantCount = 3
    const tool = makeTool(state, buildConfig(0), rawMessages)

    await tool.execute(
        {
            topics: [
                {
                    topic: "Cooldown Off",
                    content: [{ startId: "m00001", endId: "m00002", summary: "No rate limit." }],
                },
            ],
        },
        makeToolCtx(sessionID, "msg-compress-disabled"),
    )

    assert.equal(state.prune.messages.blocksById.size, 1)
})

test("missing both topics and legacy fields throws a clear guidance error", async () => {
    const sessionID = `ses_batch_missing_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()
    const tool = makeTool(state, buildConfig(2), rawMessages)

    await assert.rejects(
        tool.execute({ summaryMaxChars: 5000 } as any, makeToolCtx(sessionID, "msg-compress-missing")),
        /Provide `topics`/,
    )

    assert.equal(state.prune.messages.blocksById.size, 0)
})
