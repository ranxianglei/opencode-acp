import assert from "node:assert/strict"
import test from "node:test"
import { createAcpContextRecapTool } from "../lib/compress/recap"
import type { ToolContext } from "../lib/compress/types"
import type { CompressionBlock, PrunedMessageEntry, SessionState } from "../lib/state/types"

const SID = "session-recap-test"

function makeBlock(overrides: Partial<CompressionBlock> = {}): CompressionBlock {
    return {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 100,
        summaryTokens: 20,
        durationMs: 0,
        mode: "range",
        topic: "test topic",
        batchTopic: "test topic",
        startId: "m00001",
        endId: "m00003",
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
        createdAt: Date.now() - 60_000,
        deactivatedAt: undefined,
        deactivatedByBlockId: undefined,
        summary: "a summary",
        survivedCount: 0,
        generation: "young",
        ...overrides,
    }
}

function makeState(activeIds: number[], blocks: Map<number, CompressionBlock>): SessionState {
    return {
        sessionId: SID,
        isSubAgent: false,
        manualMode: false,
        compressPermission: "allow",
        pendingManualTrigger: null,
        prune: {
            tools: new Map(),
            messages: {
                byMessageId: new Map<string, PrunedMessageEntry>(),
                blocksById: blocks,
                activeBlockIds: new Set<number>(activeIds),
                activeByAnchorMessageId: new Map(),
                nextBlockId: 1,
                nextRunId: 1,
                markedForCleanup: new Set<number>(),
            },
        },
        nudges: {
            contextLimitAnchors: new Set(),
            turnNudgeAnchors: new Set(),
            iterationNudgeAnchors: new Set(),
            lastPerMessageNudgeTurn: 0,
            lastPerMessageNudgeTokens: undefined,
        },
        stats: { pruneTokenCounter: 0, totalPruneTokens: 0 },
        compressionTiming: {} as any,
        toolParameters: new Map(),
        subAgentResultCache: new Map(),
        toolIdList: [],
        messageIds: { byRawId: new Map(), byRef: new Map(), nextRef: 1 },
        lastCompaction: 0,
        currentTurn: 0,
        modelContextLimit: undefined,
        systemPromptTokens: undefined,
    }
}

function makeToolContext(
    activeIds: number[],
    blocks: Map<number, CompressionBlock>,
): ToolContext {
    return {
        client: {},
        state: makeState(activeIds, blocks),
        logger: { enabled: false } as any,
        config: {} as any,
        prompts: { reload: () => {} } as any,
    }
}

function blocksMap(...blocks: CompressionBlock[]): Map<number, CompressionBlock> {
    const map = new Map<number, CompressionBlock>()
    for (const b of blocks) {
        map.set(b.blockId, b)
    }
    return map
}

async function runRecap(
    activeIds: number[],
    blocks: Map<number, CompressionBlock>,
    args: { blockId?: number } = {},
): Promise<string> {
    const ctx = makeToolContext(activeIds, blocks)
    const recapTool = createAcpContextRecapTool(ctx)
    return recapTool.execute(args as any, { sessionID: SID } as any)
}

test("recap: no active blocks returns message", async () => {
    const result = await runRecap([], new Map())
    assert.match(result, /No active compression blocks/)
})

test("recap: list view shows message count instead of mNNNNN refs", async () => {
    const blocks = blocksMap(
        makeBlock({ blockId: 1, effectiveMessageIds: ["a", "b", "c"], summary: "Summary one" }),
    )
    const result = await runRecap([1], blocks)

    assert.match(result, /3 messages/)
    assert.match(result, /Summary one/)
    assert.ok(!/\bm\d{5}\b/.test(result), "list view should not contain mNNNNN refs")
})

test("recap: list view singular form for single message", async () => {
    const blocks = blocksMap(
        makeBlock({ blockId: 1, effectiveMessageIds: ["a"], summary: "Single" }),
    )
    const result = await runRecap([1], blocks)

    assert.match(result, /1 message\b/)
    assert.ok(!/1 messages/.test(result), "should use singular '1 message' not '1 messages'")
})

test("recap: single block view shows message count in footer", async () => {
    const blocks = blocksMap(
        makeBlock({ blockId: 1, effectiveMessageIds: ["a", "b", "c", "d"], summary: "Block content" }),
    )
    const result = await runRecap([1], blocks, { blockId: 1 })

    assert.match(result, /4 messages/)
    assert.match(result, /Block content/)
    assert.ok(!/\bm\d{5}\b/.test(result), "single block view should not contain mNNNNN refs")
})

test("recap: single block view singular form", async () => {
    const blocks = blocksMap(
        makeBlock({ blockId: 1, effectiveMessageIds: ["x"], summary: "Solo" }),
    )
    const result = await runRecap([1], blocks, { blockId: 1 })

    assert.match(result, /1 message\b/)
})

test("recap: empty effectiveMessageIds shows dash", async () => {
    const blocks = blocksMap(
        makeBlock({ blockId: 1, effectiveMessageIds: [], summary: "Ghost block" }),
    )
    const result = await runRecap([1], blocks, { blockId: 1 })

    assert.match(result, /—/)
    assert.ok(!/\bm\d{5}\b/.test(result), "should not contain mNNNNN refs even with empty coverage")
})

test("recap: nonexistent blockId returns error with active block list", async () => {
    const blocks = blocksMap(makeBlock({ blockId: 1 }))
    const result = await runRecap([1], blocks, { blockId: 99 })

    assert.match(result, /not found/)
    assert.match(result, /b1/)
})

test("recap: inactive block returns deactivation message", async () => {
    const blocks = blocksMap(
        makeBlock({ blockId: 1 }),
        makeBlock({ blockId: 2, active: false }),
    )
    const result = await runRecap([1], blocks, { blockId: 2 })

    assert.match(result, /inactive/)
})

test("recap: list view truncates long summaries to 200 chars", async () => {
    const longSummary = "x".repeat(300)
    const blocks = blocksMap(
        makeBlock({ blockId: 1, effectiveMessageIds: ["a"], summary: longSummary }),
    )
    const result = await runRecap([1], blocks)

    assert.ok(result.includes("..."), "truncated summary should end with ellipsis")
    assert.ok(
        result.includes("x".repeat(200)),
        "should contain first 200 chars of summary",
    )
})
