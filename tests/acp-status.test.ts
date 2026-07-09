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

function makeMockClient(messages: any[] = []): any {
    return {
        session: {
            messages: async () => ({ data: messages }),
        },
    }
}

function makeToolContext(
    activeIds: number[],
    blocks: Map<number, CompressionBlock>,
    client?: any,
): ToolContext {
    return {
        client: client ?? {},
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
    args: { scope?: string; tool?: string; sort?: string; limit?: number } = {},
    client?: any,
): Promise<string> {
    const ctx = makeToolContext(activeIds, blocks, client)
    const statusTool = createAcpStatusTool(ctx)
    return statusTool.execute(args as any, { sessionID: SID } as any)
}

test("acp_status: empty state returns no-blocks message", async () => {
    const result = await runStatus([], new Map())
    assert.match(result, /No compressed blocks/)
})

test("acp_status: single block shows correct header with summary and original sizes", async () => {
    const blocks = blocksMap(makeBlock({ blockId: 1, summaryTokens: 750, compressedTokens: 5000, topic: "My topic" }))
    const result = await runStatus([1], blocks)

    assert.match(result, /COMPRESSED BLOCKS/)
    assert.match(result, /b1/)
    assert.match(result, /"My topic"/)
})

test("acp_status: plural header for multiple blocks", async () => {
    const blocks = blocksMap(
        makeBlock({ blockId: 1, summaryTokens: 750, compressedTokens: 5000 }),
        makeBlock({ blockId: 2, summaryTokens: 300, compressedTokens: 2000 }),
    )
    const result = await runStatus([1, 2], blocks)

    assert.match(result, /2 active/)
    assert.match(result, /1\.1K summary/)
})

test("acp_status: block with no topic shows (no topic)", async () => {
    const blocks = blocksMap(makeBlock({ blockId: 1, topic: "", batchTopic: "" }))
    const result = await runStatus([1], blocks)

    assert.match(result, /\(no topic\)/)
})

test("acp_status: overview shows compressed→summary size pair", async () => {
    const blocks = blocksMap(
        makeBlock({ blockId: 1, summaryTokens: 500, compressedTokens: 800 }),
        makeBlock({ blockId: 2, summaryTokens: 2000, compressedTokens: 15000 }),
    )
    const result = await runStatus([1, 2], blocks)

    assert.match(result, /800→500/)
    assert.match(result, /15\.0K→2\.0K/)
})

test("acp_status: overview shows mNNNNN–mNNNNN range from startId/endId", async () => {
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

test("acp_status: overview includes drill-down hint", async () => {
    const blocks = blocksMap(makeBlock({ blockId: 1 }))
    const result = await runStatus([1], blocks)

    assert.match(result, /Drill down/)
    assert.match(result, /scope/)
})

test("acp_status: scope=compressed shows detailed block info", async () => {
    const blocks = blocksMap(
        makeBlock({
            blockId: 1,
            survivedCount: 3,
            generation: "old",
            effectiveMessageIds: ["a", "b", "c", "d"],
            consumedBlockIds: [2, 3],
        }),
    )
    const result = await runStatus([1], blocks, { scope: "compressed" })

    assert.match(result, /COMPRESSED/)
    assert.match(result, /age=3/)
    assert.match(result, /old/)
    assert.match(result, /eff=4/)
    assert.match(result, /nested=\[b2,b3\]/)
})

test("acp_status: scope=compressed sort=size orders largest first", async () => {
    const blocks = blocksMap(
        makeBlock({ blockId: 1, compressedTokens: 500, topic: "small" }),
        makeBlock({ blockId: 2, compressedTokens: 50_000, topic: "large" }),
    )
    const result = await runStatus([1, 2], blocks, { scope: "compressed", sort: "size" })

    const smallPos = result.indexOf("small")
    const largePos = result.indexOf("large")
    assert.ok(largePos < smallPos, "largest block should appear first")
    assert.match(result, /Sorted by size/)
})

test("acp_status: scope=compressed sort=age orders highest survivedCount first", async () => {
    const blocks = blocksMap(
        makeBlock({ blockId: 1, survivedCount: 1, topic: "alpha-topic" }),
        makeBlock({ blockId: 2, survivedCount: 14, topic: "beta-topic" }),
    )
    const result = await runStatus([1, 2], blocks, { scope: "compressed", sort: "age" })

    const alphaPos = result.indexOf("alpha-topic")
    const betaPos = result.indexOf("beta-topic")
    assert.ok(betaPos < alphaPos, "highest survivedCount block should appear first")
})

test("acp_status: scope=compressed sort=time orders oldest createdAt first", async () => {
    const now = Date.now()
    const blocks = blocksMap(
        makeBlock({ blockId: 1, createdAt: now - 10_000, topic: "older" }),
        makeBlock({ blockId: 2, createdAt: now - 1_000, topic: "newer" }),
    )
    const result = await runStatus([1, 2], blocks, { scope: "compressed", sort: "time" })

    const olderPos = result.indexOf("older")
    const newerPos = result.indexOf("newer")
    assert.ok(olderPos < newerPos, "oldest block should appear first")
})

test("acp_status: scope=compressed limit caps shown blocks", async () => {
    const blocks: CompressionBlock[] = []
    for (let i = 1; i <= 5; i++) {
        blocks.push(makeBlock({ blockId: i, topic: `block-${i}` }))
    }
    const map = blocksMap(...blocks)
    const result = await runStatus([1, 2, 3, 4, 5], map, { scope: "compressed", limit: 2 })

    assert.match(result, /2 of 5 shown/)
})

test("acp_status: scope=compressed includes decompress hint", async () => {
    const blocks = blocksMap(makeBlock({ blockId: 1 }))
    const result = await runStatus([1], blocks, { scope: "compressed" })

    assert.match(result, /Use decompress/)
    assert.match(result, /search_context/)
})

test("acp_status: scope=uncompressed shows message list header", async () => {
    const mockMsgs = [
        { info: { id: "raw-1", role: "assistant" }, parts: [{ type: "text", text: "hello world" }] },
    ]
    const mockClient = makeMockClient(mockMsgs)
    const state = makeState([], new Map())
    state.messageIds.byRawId.set("raw-1", "m00001")
    const ctx: ToolContext = {
        client: mockClient,
        state,
        logger: { enabled: false } as any,
        config: {} as any,
        prompts: { reload: () => {} } as any,
    }
    const statusTool = createAcpStatusTool(ctx)
    const result = await statusTool.execute({ scope: "uncompressed" } as any, { sessionID: SID } as any)

    assert.match(result, /UNCOMPRESSED/)
    assert.match(result, /Sorted by/)
})

test("acp_status: scope=uncompressed with tool filter shows filter in header", async () => {
    const mockMsgs = [
        {
            info: { id: "raw-1", role: "assistant" },
            parts: [{ type: "tool", tool: "bash", state: { input: { command: "ls" } } }],
        },
    ]
    const mockClient = makeMockClient(mockMsgs)
    const state = makeState([], new Map())
    state.messageIds.byRawId.set("raw-1", "m00001")
    const ctx: ToolContext = {
        client: mockClient,
        state,
        logger: { enabled: false } as any,
        config: {} as any,
        prompts: { reload: () => {} } as any,
    }
    const statusTool = createAcpStatusTool(ctx)
    const result = await statusTool.execute({ scope: "uncompressed", tool: "bash" } as any, { sessionID: SID } as any)

    assert.match(result, /UNCOMPRESSED — bash:/)
})

test("acp_status: invalid scope falls back to overview", async () => {
    const blocks = blocksMap(makeBlock({ blockId: 1 }))
    const result = await runStatus([1], blocks, { scope: "bogus" as any })

    assert.match(result, /COMPRESSED BLOCKS/)
    assert.match(result, /Drill down/)
})

test("acp_status: invalid sort falls back to size", async () => {
    const blocks = blocksMap(makeBlock({ blockId: 1 }))
    const result = await runStatus([1], blocks, { scope: "compressed", sort: "bogus" as any })

    assert.match(result, /Sorted by size/)
})
