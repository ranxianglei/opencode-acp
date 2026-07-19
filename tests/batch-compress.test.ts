import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdirSync } from "node:fs"
import { createCompressRangeTool } from "../lib/compress/range"
import { validateArgs } from "../lib/compress/range-utils"
import { createSessionState, type WithParts } from "../lib/state"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"
import type { CompressRangeToolArgs } from "../lib/compress/types"

const testDataHome = join(tmpdir(), `opencode-dcp-tests-${process.pid}`)
const testConfigHome = join(tmpdir(), `opencode-dcp-config-tests-${process.pid}`)

process.env.XDG_DATA_HOME = testDataHome
process.env.XDG_CONFIG_HOME = testConfigHome

mkdirSync(testDataHome, { recursive: true })
mkdirSync(testConfigHome, { recursive: true })

function buildConfig(): PluginConfig {
    return {
        enabled: true,
        autoUpdate: true,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: {
            enabled: true,
            protectedTools: [],
        },
        manualMode: {
            enabled: false,
            automaticStrategies: true,
        },
        turnProtection: {
            enabled: false,
            turns: 4,
        },
        experimental: {
            allowSubAgents: true,
            customPrompts: false,
        },
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
            lastSegmentSoftBlock: false,
        },
        strategies: {
            deduplication: {
                enabled: true,
                protectedTools: [],
            },
            purgeErrors: {
                enabled: true,
                turns: 4,
                protectedTools: [],
            },
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
    return {
        id,
        messageID,
        sessionID,
        type: "text" as const,
        text,
    }
}

function buildBatchMessages(sessionID: string): WithParts[] {
    const messages: WithParts[] = []
    for (let i = 1; i <= 6; i++) {
        const isUser = i % 2 === 1
        messages.push({
            info: {
                id: `msg-${i}`,
                role: isUser ? "user" : "assistant",
                sessionID,
                ...(isUser
                    ? { model: { providerID: "anthropic", modelID: "claude-test" } }
                    : {}),
                time: { created: i },
            } as WithParts["info"],
            parts: [textPart(`msg-${i}`, sessionID, `part-${i}`, `Message ${i} content`)],
        })
    }
    return messages
}

function buildToolCtx(sessionID: string, state: ReturnType<typeof createSessionState>) {
    return {
        client: {
            session: {
                messages: async () => ({ data: buildBatchMessages(sessionID) }),
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
    } as any
}


test("validateArgs: per-entry topics, no top-level topic — valid", () => {
    const args: CompressRangeToolArgs = {
        content: [
            { topic: "Exploration", startId: "m00001", endId: "m00003", summary: "..." },
            { topic: "Bug Hunt", startId: "m00004", endId: "m00006", summary: "..." },
        ],
    }
    assert.doesNotThrow(() => validateArgs(args))
})

test("validateArgs: top-level topic only, no per-entry topics — valid (backward compat)", () => {
    const args: CompressRangeToolArgs = {
        topic: "Shared topic",
        content: [
            { startId: "m00001", endId: "m00003", summary: "..." },
            { startId: "m00004", endId: "m00006", summary: "..." },
        ],
    }
    assert.doesNotThrow(() => validateArgs(args))
})

test("validateArgs: mixed — some entries have topic, others use fallback", () => {
    const args: CompressRangeToolArgs = {
        topic: "Fallback topic",
        content: [
            { topic: "Specific", startId: "m00001", endId: "m00003", summary: "..." },
            { startId: "m00004", endId: "m00006", summary: "..." },
        ],
    }
    assert.doesNotThrow(() => validateArgs(args))
})

test("validateArgs: no topic at all — entry without topic and no fallback", () => {
    const args = {
        content: [
            { startId: "m00001", endId: "m00003", summary: "..." },
        ],
    }
    assert.throws(
        () => validateArgs(args as CompressRangeToolArgs),
        /content\[0\] needs a topic/,
    )
})

test("validateArgs: one entry without topic in a no-topical batch", () => {
    const args = {
        content: [
            { topic: "First", startId: "m00001", endId: "m00003", summary: "..." },
            { startId: "m00004", endId: "m00006", summary: "..." },
        ],
    }
    assert.throws(
        () => validateArgs(args as CompressRangeToolArgs),
        /content\[1\] needs a topic/,
    )
})

test("validateArgs: empty top-level topic with entry lacking topic", () => {
    const args = {
        topic: "   ",
        content: [{ startId: "m00001", endId: "m00003", summary: "..." }],
    }
    assert.throws(
        () => validateArgs(args as CompressRangeToolArgs),
        /content\[0\] needs a topic/,
    )
})


test("batch compress: each entry creates a block with its own topic", async () => {
    const sessionID = `ses_batch_topics_${Date.now()}`
    const state = createSessionState()
    const tool = createCompressRangeTool(buildToolCtx(sessionID, state))

    await tool.execute(
        {
            content: [
                {
                    topic: "Exploration",
                    startId: "m00001",
                    endId: "m00002",
                    summary: "Explored the codebase structure and module dependencies.",
                },
                {
                    topic: "Bug Hunt",
                    startId: "m00003",
                    endId: "m00004",
                    summary: "Found the root cause of the compression bug.",
                },
            ],
        },
        {
            ask: async () => {},
            metadata: () => {},
            sessionID,
            messageID: "msg-compress",
        } as any,
    )

    const blocks = [...state.prune.messages.blocksById.values()]
    assert.equal(blocks.length, 2, "should create 2 blocks")
    assert.equal(blocks[0]!.topic, "Exploration")
    assert.equal(blocks[1]!.topic, "Bug Hunt")
})

test("batch compress: backward compat — entries without topic use top-level", async () => {
    const sessionID = `ses_batch_fallback_${Date.now()}`
    const state = createSessionState()
    const tool = createCompressRangeTool(buildToolCtx(sessionID, state))

    await tool.execute(
        {
            topic: "Shared topic",
            content: [
                {
                    startId: "m00001",
                    endId: "m00002",
                    summary: "First range summary.",
                },
                {
                    startId: "m00003",
                    endId: "m00004",
                    summary: "Second range summary.",
                },
            ],
        },
        {
            ask: async () => {},
            metadata: () => {},
            sessionID,
            messageID: "msg-compress",
        } as any,
    )

    const blocks = [...state.prune.messages.blocksById.values()]
    assert.equal(blocks.length, 2, "should create 2 blocks")
    assert.equal(blocks[0]!.topic, "Shared topic")
    assert.equal(blocks[1]!.topic, "Shared topic")
})

test("batch compress: mixed — entry topic overrides top-level fallback", async () => {
    const sessionID = `ses_batch_mixed_${Date.now()}`
    const state = createSessionState()
    const tool = createCompressRangeTool(buildToolCtx(sessionID, state))

    await tool.execute(
        {
            topic: "Fallback",
            content: [
                {
                    topic: "Override",
                    startId: "m00001",
                    endId: "m00002",
                    summary: "First range with explicit topic.",
                },
                {
                    startId: "m00003",
                    endId: "m00004",
                    summary: "Second range using fallback.",
                },
            ],
        },
        {
            ask: async () => {},
            metadata: () => {},
            sessionID,
            messageID: "msg-compress",
        } as any,
    )

    const blocks = [...state.prune.messages.blocksById.values()]
    assert.equal(blocks.length, 2, "should create 2 blocks")
    assert.equal(blocks[0]!.topic, "Override", "entry topic should override top-level")
    assert.equal(blocks[1]!.topic, "Fallback", "entry without topic should use fallback")
})

test("batch compress: no top-level topic, all entries have own — blocks get entry topics", async () => {
    const sessionID = `ses_batch_notopical_${Date.now()}`
    const state = createSessionState()
    const tool = createCompressRangeTool(buildToolCtx(sessionID, state))

    await tool.execute(
        {
            content: [
                {
                    topic: "Auth",
                    startId: "m00001",
                    endId: "m00002",
                    summary: "Auth implementation details.",
                },
                {
                    topic: "Deploy",
                    startId: "m00003",
                    endId: "m00004",
                    summary: "Deployment configuration.",
                },
                {
                    topic: "Test",
                    startId: "m00005",
                    endId: "m00006",
                    summary: "Test suite results.",
                },
            ],
        },
        {
            ask: async () => {},
            metadata: () => {},
            sessionID,
            messageID: "msg-compress",
        } as any,
    )

    const blocks = [...state.prune.messages.blocksById.values()]
    assert.equal(blocks.length, 3, "should create 3 blocks")
    const topics = blocks.map((b) => b.topic)
    assert.deepEqual(topics, ["Auth", "Deploy", "Test"])
})
