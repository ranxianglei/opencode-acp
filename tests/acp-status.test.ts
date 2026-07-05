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

async function runStatus(activeIds: number[], blocks: Map<number, CompressionBlock>): Promise<string> {
    const ctx = makeToolContext(activeIds, blocks)
    const statusTool = createAcpStatusTool(ctx)
    return statusTool.execute({}, {} as any)
}

test("acp_status: empty state returns no-blocks message", async () => {
    const result = await runStatus([], new Map())
    assert.equal(result, "No compressed blocks. Context is fully visible.")
})

test("acp_status: single block shows correct header and row", async () => {
    const blocks = blocksMap(makeBlock({ blockId: 1, summaryTokens: 750, compressedTokens: 5000, topic: "My topic" }))
    const result = await runStatus([1], blocks)

    assert.match(result, /ACP Status — 1 active compressed block \(750 summary tokens/)
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
    assert.match(result, /1\.1K summary tokens/)
})

test("acp_status: block with no topic shows (no topic)", async () => {
    const blocks = blocksMap(makeBlock({ blockId: 1, topic: "", batchTopic: "" }))
    const result = await runStatus([1], blocks)

    assert.match(result, /\(no topic\)/)
})

test("acp_status: token formatting — <1000 plain, >=1000 compact", async () => {
    const blocks = blocksMap(
        makeBlock({ blockId: 1, summaryTokens: 500, compressedTokens: 800 }),
        makeBlock({ blockId: 2, summaryTokens: 2000, compressedTokens: 15000 }),
    )
    const result = await runStatus([1, 2], blocks)

    assert.match(result, /500t/)
    assert.match(result, /2\.0Kt/)
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
