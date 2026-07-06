import assert from "node:assert/strict"
import test from "node:test"
import { createAcpStatusTool } from "../lib/compress/status"
import type { ToolContext } from "../lib/compress/types"
import type { CompressionBlock, PrunedMessageEntry, SessionState } from "../lib/state/types"

const SID = "session-acp-status-test"

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

function makeToolContext(activeIds: number[], blocks: Map<number, CompressionBlock>): ToolContext {
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

async function runStatus(
    activeIds: number[],
    blocks: Map<number, CompressionBlock>,
    args: { mode?: string; sort?: string; limit?: number } = {},
): Promise<string> {
    const ctx = makeToolContext(activeIds, blocks)
    const statusTool = createAcpStatusTool(ctx)
    return statusTool.execute(args as any, {} as any)
}

test("acp_status: empty state returns no-blocks message", async () => {
    const result = await runStatus([], new Map())
    assert.equal(result, "No compressed blocks. Context is fully visible.")
})

test("acp_status: single block shows correct header with summary and original sizes", async () => {
    const blocks = blocksMap(makeBlock({ blockId: 1, summaryTokens: 750, compressedTokens: 5000, topic: "My topic" }))
    const result = await runStatus([1], blocks)

    assert.match(result, /ACP Status — 1 active compressed block \(750 summary, 5\.0K original compressed\)/)
    assert.match(result, /b1/)
    assert.match(result, /"My topic"/)
})

test("acp_status: plural header for multiple blocks", async () => {
    const blocks = blocksMap(
        makeBlock({ blockId: 1, summaryTokens: 750, compressedTokens: 5000 }),
        makeBlock({ blockId: 2, summaryTokens: 300, compressedTokens: 2000 }),
    )
    const result = await runStatus([1, 2], blocks)

    assert.match(result, /2 active compressed blocks/)
    assert.match(result, /1\.1K summary/)
})

test("acp_status: block with no topic shows (no topic)", async () => {
    const blocks = blocksMap(makeBlock({ blockId: 1, topic: "", batchTopic: "" }))
    const result = await runStatus([1], blocks)

    assert.match(result, /\(no topic\)/)
})

test("acp_status: summary row shows compressed→summary size pair", async () => {
    const blocks = blocksMap(
        makeBlock({ blockId: 1, summaryTokens: 500, compressedTokens: 800 }),
        makeBlock({ blockId: 2, summaryTokens: 2000, compressedTokens: 15000 }),
    )
    const result = await runStatus([1, 2], blocks)

    assert.match(result, /800→500/)
    assert.match(result, /15\.0K→2\.0K/)
})

test("acp_status: summary row shows mNNNNN–mNNNNN range from startId/endId", async () => {
    const blocks = blocksMap(
        makeBlock({ blockId: 1, startId: "m00010", endId: "m00025" }),
    )
    const result = await runStatus([1], blocks)

    assert.match(result, /m00010–m00025/)
})

test("acp_status: range shows single ID when startId === endId", async () => {
    const blocks = blocksMap(
        makeBlock({ blockId: 1, startId: "m00005", endId: "m00005" }),
    )
    const result = await runStatus([1], blocks)

    assert.match(result, /m00005/)
    assert.doesNotMatch(result, /m00005–m00005/)
})

test("acp_status: idWidth based on displayed blocks, not activeIds", async () => {
    const blocks = blocksMap(
        makeBlock({ blockId: 1, summaryTokens: 100, compressedTokens: 500 }),
    )
    const result = await runStatus([1, 99], blocks)

    assert.match(result, /b1/)
    assert.doesNotMatch(result, /b99/)
})

test("acp_status: includes usage hint at end", async () => {
    const blocks = blocksMap(makeBlock({ blockId: 1 }))
    const result = await runStatus([1], blocks)

    assert.match(result, /Use decompress/)
    assert.match(result, /search_context/)
})

test("acp_status: default sort is recent (newest createdAt first)", async () => {
    const now = Date.now()
    const blocks = blocksMap(
        makeBlock({ blockId: 1, createdAt: now - 10_000, topic: "older" }),
        makeBlock({ blockId: 2, createdAt: now - 1_000, topic: "newer" }),
    )
    const result = await runStatus([1, 2], blocks)

    const olderPos = result.indexOf("older")
    const newerPos = result.indexOf("newer")
    assert.ok(newerPos < olderPos, "newer block should appear before older block")
})

test("acp_status: sort=size orders largest compressedTokens first", async () => {
    const blocks = blocksMap(
        makeBlock({ blockId: 1, compressedTokens: 500, topic: "small" }),
        makeBlock({ blockId: 2, compressedTokens: 50_000, topic: "large" }),
    )
    const result = await runStatus([1, 2], blocks, { sort: "size" })

    const smallPos = result.indexOf("small")
    const largePos = result.indexOf("large")
    assert.ok(largePos < smallPos, "largest block should appear first")
    assert.match(result, /sorted by size/)
})

test("acp_status: sort=age orders highest survivedCount first", async () => {
    const blocks = blocksMap(
        makeBlock({ blockId: 1, survivedCount: 1, topic: "young" }),
        makeBlock({ blockId: 2, survivedCount: 14, topic: "old" }),
    )
    const result = await runStatus([1, 2], blocks, { sort: "age" })

    const youngPos = result.indexOf("young")
    const oldPos = result.indexOf("old")
    assert.ok(oldPos < youngPos, "oldest block should appear first")
    assert.match(result, /sorted by age/)
})

test("acp_status: limit caps the number of shown blocks", async () => {
    const blocks: CompressionBlock[] = []
    for (let i = 1; i <= 5; i++) {
        blocks.push(makeBlock({ blockId: i, topic: `block-${i}` }))
    }
    const map = blocksMap(...blocks)
    const result = await runStatus([1, 2, 3, 4, 5], map, { limit: 2 })

    assert.match(result, /2 of 5 blocks shown/)
    assert.match(result, /3 hidden/)
})

test("acp_status: detailed mode includes survived/generation/effective fields", async () => {
    const blocks = blocksMap(
        makeBlock({
            blockId: 1,
            survivedCount: 3,
            generation: "old",
            effectiveMessageIds: ["a", "b", "c", "d"],
            consumedBlockIds: [2, 3],
        }),
    )
    const result = await runStatus([1], blocks, { mode: "detailed" })

    assert.match(result, /age=3/)
    assert.match(result, /old/)
    assert.match(result, /eff=4/)
    assert.match(result, /nested=\[b2,b3\]/)
})

test("acp_status: summary mode (default) does not include detailed fields", async () => {
    const blocks = blocksMap(
        makeBlock({ blockId: 1, survivedCount: 3, generation: "old" }),
    )
    const result = await runStatus([1], blocks)

    assert.doesNotMatch(result, /age=3/)
    assert.doesNotMatch(result, /eff=/)
})

test("acp_status: invalid mode falls back to summary", async () => {
    const blocks = blocksMap(makeBlock({ blockId: 1, survivedCount: 3 }))
    const result = await runStatus([1], blocks, { mode: "bogus" as any })

    assert.doesNotMatch(result, /age=3/)
})

test("acp_status: invalid sort falls back to recent", async () => {
    const blocks = blocksMap(makeBlock({ blockId: 1 }))
    const result = await runStatus([1], blocks, { sort: "bogus" as any })

    assert.match(result, /sorted by recent/)
})
