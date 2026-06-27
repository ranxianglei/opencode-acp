import assert from "node:assert/strict"
import test from "node:test"
import { mergeMarkedBlocks, runBatchCleanup } from "../lib-v2/gc/merge"
import { createSessionState } from "../lib-v2/state"
import { wrapCompressedSummary } from "../lib-v2/compress/state"
import { Logger } from "../lib-v2/logger"
import type {
    CompressionBlock,
    PrunedMessageEntry,
    SessionState,
    WithParts,
} from "../lib-v2/state/types"
import type { GCConfig, PluginConfig } from "../lib-v2/config"

function makeBlock(overrides: Partial<CompressionBlock> = {}): CompressionBlock {
    return {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 1000,
        summaryTokens: 100,
        durationMs: 0,
        mode: "range",
        topic: "test",
        batchTopic: "test",
        startId: "m0",
        endId: "m5",
        anchorMessageId: "anchor-1",
        compressMessageId: "comp-1",
        compressCallId: undefined,
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: [],
        effectiveToolIds: [],
        createdAt: 1000,
        deactivatedAt: undefined,
        deactivatedByBlockId: undefined,
        summary: "A short summary.",
        survivedCount: 5,
        generation: "old",
        ...overrides,
    }
}

interface MakeStateOptions {
    modelContextLimit?: number
    marked?: number[]
}

function makeState(blocks: CompressionBlock[], opts: MakeStateOptions = {}): SessionState {
    const state = createSessionState()
    state.modelContextLimit = opts.modelContextLimit

    let maxId = 0
    for (const block of blocks) {
        state.prune.messages.blocksById.set(block.blockId, block)
        if (block.active) {
            state.prune.messages.activeBlockIds.add(block.blockId)
            if (block.anchorMessageId) {
                state.prune.messages.activeByAnchorMessageId.set(block.anchorMessageId, block.blockId)
            }
        }
        if (block.blockId > maxId) maxId = block.blockId
    }
    state.prune.messages.nextBlockId = Math.max(state.prune.messages.nextBlockId, maxId + 1)
    state.prune.messages.nextRunId = Math.max(state.prune.messages.nextRunId, maxId + 1)

    for (const id of opts.marked ?? []) {
        state.prune.messages.markedForCleanup.add(id)
    }

    return state
}

function registerMessage(
    state: SessionState,
    messageId: string,
    blockIds: number[],
    tokenCount = 100,
): PrunedMessageEntry {
    const entry: PrunedMessageEntry = {
        tokenCount,
        allBlockIds: [...blockIds],
        activeBlockIds: [...blockIds],
    }
    state.prune.messages.byMessageId.set(messageId, entry)
    return entry
}

function buildConfig(gcOverrides: Partial<GCConfig> = {}): PluginConfig {
    return {
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
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: [],
            protectTags: false,
            protectUserMessages: false,
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
            batchCleanup: {
                lowThreshold: "60%",
                highThreshold: "75%",
                forceThreshold: "90%",
            },
            ...gcOverrides,
        },
    }
}

function makeAssistantMessage(id: string, totalTokens: number, sessionId = "s1"): WithParts {
    return {
        info: {
            id,
            sessionID: sessionId,
            role: "assistant",
            time: { created: Date.now() },
            parentID: "parent-1",
            modelID: "test-model",
            providerID: "test-provider",
            mode: "normal",
            agent: "code",
            path: { cwd: "/", root: "/" },
            cost: 0,
            tokens: {
                input: 0,
                output: totalTokens,
                reasoning: 0,
                cache: { read: 0, write: 0 },
            },
        },
        parts: [
            { type: "text", text: "ok", id: `${id}-p1`, sessionID: sessionId, messageID: id },
        ],
    }
}

test("mergeMarkedBlocks: merges 2 blocks → creates new block, deactivates sources, updates indexes", () => {
    const block1 = makeBlock({
        blockId: 1,
        runId: 1,
        anchorMessageId: "anchor-1",
        summary: wrapCompressedSummary(1, "Body of block one"),
        summaryTokens: 50,
        effectiveMessageIds: ["m1", "m2"],
        effectiveToolIds: ["t1"],
    })
    const block2 = makeBlock({
        blockId: 2,
        runId: 2,
        anchorMessageId: "anchor-2",
        summary: wrapCompressedSummary(2, "Body of block two"),
        summaryTokens: 60,
        effectiveMessageIds: ["m3"],
        effectiveToolIds: ["t2"],
    })
    const state = makeState([block1, block2], { marked: [1, 2] })
    registerMessage(state, "m1", [1])
    registerMessage(state, "m2", [1])
    registerMessage(state, "m3", [2])

    const newId = state.prune.messages.nextBlockId
    const result = mergeMarkedBlocks(state, [1, 2], 3000)

    assert.equal(result.mergedCount, 2)
    assert.ok(result.savedTokens >= 0)

    const merged = state.prune.messages.blocksById.get(newId)
    assert.ok(merged, "merged block created")
    assert.equal(merged!.active, true)
    assert.equal(merged!.generation, "old")
    assert.ok(state.prune.messages.activeBlockIds.has(newId))

    assert.equal(block1.active, false)
    assert.equal(block2.active, false)
    assert.equal(block1.deactivatedByBlockId, newId)
    assert.equal(block2.deactivatedByBlockId, newId)
    assert.equal(state.prune.messages.activeBlockIds.has(1), false)
    assert.equal(state.prune.messages.activeBlockIds.has(2), false)

    assert.ok(merged!.summary.includes("Body of block one"))
    assert.ok(merged!.summary.includes("Body of block two"))

    assert.deepEqual(
        [...merged!.effectiveMessageIds].sort(),
        ["m1", "m2", "m3"],
    )
    assert.deepEqual(
        [...merged!.effectiveToolIds].sort(),
        ["t1", "t2"],
    )

    const entryM1 = state.prune.messages.byMessageId.get("m1")!
    assert.ok(!entryM1.activeBlockIds.includes(1))
    assert.ok(entryM1.activeBlockIds.includes(newId))
    assert.ok(entryM1.allBlockIds.includes(newId))

    assert.equal(
        state.prune.messages.activeByAnchorMessageId.get("anchor-1"),
        newId,
    )
    assert.equal(state.prune.messages.activeByAnchorMessageId.has("anchor-2"), false)

    assert.equal(state.prune.messages.markedForCleanup.size, 0)
})

test("mergeMarkedBlocks: merges 3 blocks with overlapping effectiveMessageIds → union correct", () => {
    const block1 = makeBlock({
        blockId: 1,
        anchorMessageId: "a1",
        summary: wrapCompressedSummary(1, "block one body"),
        effectiveMessageIds: ["m1", "m2"],
    })
    const block2 = makeBlock({
        blockId: 2,
        runId: 2,
        anchorMessageId: "a2",
        summary: wrapCompressedSummary(2, "block two body"),
        effectiveMessageIds: ["m2", "m3"],
    })
    const block3 = makeBlock({
        blockId: 3,
        runId: 3,
        anchorMessageId: "a3",
        summary: wrapCompressedSummary(3, "block three body"),
        effectiveMessageIds: ["m3", "m4"],
    })
    const state = makeState([block1, block2, block3])

    const newId = state.prune.messages.nextBlockId
    const result = mergeMarkedBlocks(state, [3, 1, 2], 3000)

    assert.equal(result.mergedCount, 3)
    const merged = state.prune.messages.blocksById.get(newId)!
    assert.equal(merged.effectiveMessageIds.length, 4)
    for (const id of ["m1", "m2", "m3", "m4"]) {
        assert.ok(merged.effectiveMessageIds.includes(id), `union should include ${id}`)
    }
})

test("mergeMarkedBlocks: single block (< 2) → noop", () => {
    const block1 = makeBlock({ blockId: 1 })
    const state = makeState([block1])
    const result = mergeMarkedBlocks(state, [1], 3000)
    assert.equal(result.mergedCount, 0)
    assert.equal(result.savedTokens, 0)
    assert.equal(block1.active, true)
})

test("mergeMarkedBlocks: empty array → noop", () => {
    const block1 = makeBlock({ blockId: 1 })
    const block2 = makeBlock({ blockId: 2, runId: 2 })
    const state = makeState([block1, block2])
    const result = mergeMarkedBlocks(state, [], 3000)
    assert.equal(result.mergedCount, 0)
    assert.equal(result.savedTokens, 0)
})

test("mergeMarkedBlocks: inactive block in input → filtered out", () => {
    const block1 = makeBlock({ blockId: 1, active: true })
    const block2 = makeBlock({ blockId: 2, runId: 2, active: false })
    const state = makeState([block1, block2])
    const result = mergeMarkedBlocks(state, [1, 2], 3000)
    assert.equal(result.mergedCount, 0)
    assert.equal(result.savedTokens, 0)
    assert.equal(block1.active, true)
})

test("mergeMarkedBlocks: markedForCleanup only clears merged IDs (not all)", () => {
    const block1 = makeBlock({ blockId: 1, anchorMessageId: "a1", summary: wrapCompressedSummary(1, "one") })
    const block2 = makeBlock({ blockId: 2, runId: 2, anchorMessageId: "a2", summary: wrapCompressedSummary(2, "two") })
    const block3 = makeBlock({ blockId: 3, runId: 3, anchorMessageId: "a3", summary: wrapCompressedSummary(3, "three") })
    const state = makeState([block1, block2, block3], { marked: [1, 2, 3] })

    mergeMarkedBlocks(state, [1, 2], 3000)

    assert.equal(state.prune.messages.markedForCleanup.has(1), false)
    assert.equal(state.prune.messages.markedForCleanup.has(2), false)
    assert.equal(state.prune.messages.markedForCleanup.has(3), true)
    assert.equal(state.prune.messages.markedForCleanup.size, 1)
})

test("mergeMarkedBlocks: new merged block has generation old and survivedCount 0", () => {
    const block1 = makeBlock({
        blockId: 1,
        anchorMessageId: "a1",
        summary: wrapCompressedSummary(1, "one"),
        survivedCount: 9,
        generation: "old",
    })
    const block2 = makeBlock({
        blockId: 2,
        runId: 2,
        anchorMessageId: "a2",
        summary: wrapCompressedSummary(2, "two"),
        survivedCount: 7,
        generation: "old",
    })
    const state = makeState([block1, block2])

    const newId = state.prune.messages.nextBlockId
    mergeMarkedBlocks(state, [1, 2], 3000)

    const merged = state.prune.messages.blocksById.get(newId)!
    assert.equal(merged.generation, "old")
    assert.equal(merged.survivedCount, 0)
})

test("mergeMarkedBlocks: reports saved tokens as reduction from source summaries", () => {
    const longBody = "x".repeat(4000)
    const block1 = makeBlock({
        blockId: 1,
        anchorMessageId: "a1",
        summary: wrapCompressedSummary(1, longBody),
        summaryTokens: 1000,
    })
    const block2 = makeBlock({
        blockId: 2,
        runId: 2,
        anchorMessageId: "a2",
        summary: wrapCompressedSummary(2, longBody),
        summaryTokens: 1000,
    })
    const state = makeState([block1, block2])

    const result = mergeMarkedBlocks(state, [1, 2], 3000)
    assert.equal(result.mergedCount, 2)
    assert.ok(result.savedTokens > 0, "truncation should free tokens")
})

const logger = new Logger(false)

test("runBatchCleanup: below low threshold (50%) → noop tier 0", () => {
    const blocks = [
        makeBlock({ blockId: 1, anchorMessageId: "a1", summary: wrapCompressedSummary(1, "one") }),
        makeBlock({ blockId: 2, runId: 2, anchorMessageId: "a2", summary: wrapCompressedSummary(2, "two") }),
    ]
    const state = makeState(blocks, { modelContextLimit: 1000, marked: [1, 2] })
    const messages: WithParts[] = [makeAssistantMessage("a1", 500)]

    const result = runBatchCleanup(state, buildConfig(), logger, messages)
    assert.equal(result.tier, 0)
    assert.equal(result.action, "none")
    assert.equal(result.mergedCount, 0)
    assert.equal(state.prune.messages.activeBlockIds.size, 2)
})

test("runBatchCleanup: at low threshold (60%) with marked blocks → tier 1 nudge", () => {
    const blocks = [
        makeBlock({ blockId: 1, anchorMessageId: "a1", summary: wrapCompressedSummary(1, "one") }),
        makeBlock({ blockId: 2, runId: 2, anchorMessageId: "a2", summary: wrapCompressedSummary(2, "two") }),
    ]
    const state = makeState(blocks, { modelContextLimit: 1000, marked: [1, 2] })
    const messages: WithParts[] = [makeAssistantMessage("a1", 600)]

    const result = runBatchCleanup(state, buildConfig(), logger, messages)
    assert.equal(result.tier, 1)
    assert.equal(result.action, "nudge")
    assert.equal(result.mergedCount, 0)
    assert.ok(result.nudgeText, "nudge text should be provided")
    assert.ok(result.nudgeText!.includes("b1"))
    assert.ok(result.nudgeText!.includes("b2"))
    assert.equal(state.prune.messages.activeBlockIds.size, 2)
})

test("runBatchCleanup: at high threshold (75%) with >= 2 marked blocks → tier 2 merge", () => {
    const blocks = [
        makeBlock({ blockId: 1, anchorMessageId: "a1", summary: wrapCompressedSummary(1, "one") }),
        makeBlock({ blockId: 2, runId: 2, anchorMessageId: "a2", summary: wrapCompressedSummary(2, "two") }),
    ]
    const state = makeState(blocks, { modelContextLimit: 1000, marked: [1, 2] })
    const messages: WithParts[] = [makeAssistantMessage("a1", 750)]

    const result = runBatchCleanup(state, buildConfig(), logger, messages)
    assert.equal(result.tier, 2)
    assert.equal(result.action, "merge")
    assert.equal(result.mergedCount, 2)
    assert.ok(result.savedTokens >= 0)
    assert.equal(state.prune.messages.markedForCleanup.size, 0)
    assert.equal(state.prune.messages.activeBlockIds.size, 1)
})

test("runBatchCleanup: at high threshold (75%) with 1 marked block → noop (< 2)", () => {
    const blocks = [
        makeBlock({ blockId: 1, anchorMessageId: "a1", summary: wrapCompressedSummary(1, "one") }),
        makeBlock({ blockId: 2, runId: 2, anchorMessageId: "a2", summary: wrapCompressedSummary(2, "two") }),
    ]
    const state = makeState(blocks, { modelContextLimit: 1000, marked: [1] })
    const messages: WithParts[] = [makeAssistantMessage("a1", 750)]

    const result = runBatchCleanup(state, buildConfig(), logger, messages)
    assert.equal(result.tier, 0)
    assert.equal(result.action, "none")
    assert.equal(result.mergedCount, 0)
    assert.equal(state.prune.messages.activeBlockIds.size, 2)
})

test("runBatchCleanup: at force threshold (90%) with >= 2 old-gen blocks → tier 3 force merge", () => {
    const blocks = [
        makeBlock({
            blockId: 1,
            anchorMessageId: "a1",
            summary: wrapCompressedSummary(1, "one"),
            generation: "old",
        }),
        makeBlock({
            blockId: 2,
            runId: 2,
            anchorMessageId: "a2",
            summary: wrapCompressedSummary(2, "two"),
            generation: "old",
        }),
    ]
    const state = makeState(blocks, { modelContextLimit: 1000 })
    const messages: WithParts[] = [makeAssistantMessage("a1", 900)]

    const result = runBatchCleanup(state, buildConfig(), logger, messages)
    assert.equal(result.tier, 3)
    assert.equal(result.action, "merge")
    assert.equal(result.mergedCount, 2)
    assert.equal(state.prune.messages.activeBlockIds.size, 1)
})

test("runBatchCleanup: modelContextLimit undefined → noop", () => {
    const blocks = [
        makeBlock({ blockId: 1, anchorMessageId: "a1", summary: wrapCompressedSummary(1, "one") }),
        makeBlock({ blockId: 2, runId: 2, anchorMessageId: "a2", summary: wrapCompressedSummary(2, "two") }),
    ]
    const state = makeState(blocks, { modelContextLimit: undefined, marked: [1, 2] })
    const messages: WithParts[] = [makeAssistantMessage("a1", 999999)]

    const result = runBatchCleanup(state, buildConfig(), logger, messages)
    assert.equal(result.tier, 0)
    assert.equal(result.action, "none")
    assert.equal(result.mergedCount, 0)
})

test("runBatchCleanup: tier ordering — force takes precedence over high and low at 95%", () => {
    const blocks = [
        makeBlock({
            blockId: 1,
            anchorMessageId: "a1",
            summary: wrapCompressedSummary(1, "one"),
            generation: "old",
        }),
        makeBlock({
            blockId: 2,
            runId: 2,
            anchorMessageId: "a2",
            summary: wrapCompressedSummary(2, "two"),
            generation: "old",
        }),
    ]
    const state = makeState(blocks, { modelContextLimit: 1000, marked: [1, 2] })
    const messages: WithParts[] = [makeAssistantMessage("a1", 950)]

    const result = runBatchCleanup(state, buildConfig(), logger, messages)
    assert.equal(result.tier, 3, "force tier must win over high/low when usage >= 90%")
    assert.equal(result.action, "merge")
})

test("runBatchCleanup: high tier requires marked blocks, old-gen alone does not trigger it", () => {
    const blocks = [
        makeBlock({
            blockId: 1,
            anchorMessageId: "a1",
            summary: wrapCompressedSummary(1, "one"),
            generation: "old",
        }),
        makeBlock({
            blockId: 2,
            runId: 2,
            anchorMessageId: "a2",
            summary: wrapCompressedSummary(2, "two"),
            generation: "old",
        }),
    ]
    const state = makeState(blocks, { modelContextLimit: 1000 })
    const messages: WithParts[] = [makeAssistantMessage("a1", 800)]

    const result = runBatchCleanup(state, buildConfig(), logger, messages)
    assert.equal(result.tier, 0, "without marks, high tier should not fire for unmarked old-gen blocks")
    assert.equal(result.action, "none")
})
