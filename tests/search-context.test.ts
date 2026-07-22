import assert from "node:assert/strict"
import test from "node:test"
import { createSearchContextTool } from "../lib/compress/search"
import type { ToolContext } from "../lib/compress/types"
import type { CompressionBlock, PrunedMessageEntry, SessionState } from "../lib/state/types"

// --- Factory helpers ---

const SID = "session-search-context-test"

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
        createdAt: 1000,
        deactivatedAt: undefined,
        deactivatedByBlockId: undefined,
        summary: "a summary",
        survivedCount: 0,
        generation: "young",
        ...overrides,
    }
}

function makeState(blocks: Map<number, CompressionBlock>): SessionState {
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
                activeBlockIds: new Set<number>(),
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
            toolIdList: [],
        messageIds: { byRawId: new Map(), byRef: new Map(), nextRef: 1 },
        lastCompaction: 0,
        currentTurn: 0,
        modelContextLimit: undefined,
        systemPromptTokens: undefined,
    }
}

function makeToolContext(blocks: Map<number, CompressionBlock>): ToolContext {
    return {
        client: {},
        state: makeState(blocks),
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

async function runSearch(
    blocks: Map<number, CompressionBlock>,
    query: string,
    limit?: number,
    deep?: boolean,
): Promise<string> {
    const ctx = makeToolContext(blocks)
    const searchTool = createSearchContextTool(ctx)
    return searchTool.execute({ query, limit, deep }, {} as any)
}

interface ParsedHit {
    blockId: number
    relevance: number
    label: string
}

const HIT_LINE_REGEX = /📦 \[b(\d+)\] ⭐* \(([\d.]+)\) "(.*?)"/g

function parseHits(output: string): ParsedHit[] {
    const hits: ParsedHit[] = []
    for (const m of output.matchAll(HIT_LINE_REGEX)) {
        hits.push({
            blockId: Number(m[1]),
            relevance: Number(m[2]),
            label: m[3],
        })
    }
    return hits
}

// --- Tests ---

test("topic match: query matching a block topic returns a result", async () => {
    const blocks = blocksMap(
        makeBlock({
            blockId: 1,
            topic: "decoder accuracy improvements",
            summary: "unrelated text",
        }),
    )

    const output = await runSearch(blocks, "decoder")

    const hits = parseHits(output)
    assert.equal(hits.length, 1, "expected exactly one hit for topic match")
    assert.equal(hits[0].blockId, 1)
    assert.equal(hits[0].label, "decoder accuracy improvements")
    // Single topic occurrence → 0.15 relevance.
    assert.equal(hits[0].relevance, 0.15)
})

test("summary match: query matching summary text returns a result", async () => {
    // Single summary occurrence = 0.04 (< MIN_RELEVANCE 0.10), so we need
    // at least 3 occurrences to cross the threshold (3 * 0.04 = 0.12).
    const blocks = blocksMap(
        makeBlock({
            blockId: 2,
            topic: "totally unrelated topic",
            summary: "fix the decoder, the decoder was broken, decoder again",
        }),
    )

    const output = await runSearch(blocks, "decoder")

    const hits = parseHits(output)
    assert.equal(hits.length, 1, "expected one hit from summary-only match")
    assert.equal(hits[0].blockId, 2)
    // 3 summary occurrences → min(3 * 0.04, 0.20) = 0.12
    assert.equal(hits[0].relevance, 0.12)
})

test("relevance ordering: higher-scoring blocks appear before lower-scoring ones", async () => {
    const blocks = blocksMap(
        // 1 occurrence → 0.15
        makeBlock({ blockId: 1, topic: "alpha", summary: "noise" }),
        // 3 occurrences → min(3 * 0.15, 0.45) = 0.45
        makeBlock({ blockId: 2, topic: "alpha alpha alpha", summary: "noise" }),
        // 2 occurrences → min(2 * 0.15, 0.45) = 0.30
        makeBlock({ blockId: 3, topic: "alpha alpha", summary: "noise" }),
    )

    const output = await runSearch(blocks, "alpha")

    const hits = parseHits(output)
    assert.equal(hits.length, 3)
    // Descending relevance: 0.45, 0.30, 0.15
    assert.equal(hits[0].blockId, 2)
    assert.equal(hits[0].relevance, 0.45)
    assert.equal(hits[1].blockId, 3)
    assert.equal(hits[1].relevance, 0.3)
    assert.equal(hits[2].blockId, 1)
    assert.equal(hits[2].relevance, 0.15)
    // Sanity: strictly descending
    assert.ok(hits[0].relevance > hits[1].relevance)
    assert.ok(hits[1].relevance > hits[2].relevance)
})

test("minimum threshold: weak summary match (below 0.10) is excluded", async () => {
    // Single summary occurrence → 0.04, below MIN_RELEVANCE (0.10).
    const blocks = blocksMap(
        makeBlock({
            blockId: 1,
            topic: "nothing relevant here",
            summary: "foo appears once",
        }),
    )

    const output = await runSearch(blocks, "foo")

    assert.match(output, /No matches found for "foo"/)
    assert.equal(parseHits(output).length, 0)
})

test("result limit: more than 10 matches return only top 10", async () => {
    // 15 blocks, each with 3 topic occurrences → 0.45 each. All match,
    // so the only thing under test is the limit cap, not ranking.
    const blockList: CompressionBlock[] = []
    for (let i = 1; i <= 15; i++) {
        blockList.push(
            makeBlock({
                blockId: i,
                topic: "match match match",
                summary: "irrelevant",
            }),
        )
    }
    const blocks = blocksMap(...blockList)

    const output = await runSearch(blocks, "match")

    const hits = parseHits(output)
    assert.equal(hits.length, 10, "expected exactly 10 hits (default limit)")
    // Header should report 15 total matches but only 10 shown.
    assert.match(output, /Found 15 matches/)
    assert.match(output, /showing top 10/)
})

test("empty results: query matching nothing returns the no-matches message", async () => {
    const blocks = blocksMap(
        makeBlock({ blockId: 1, topic: "alpha beta", summary: "gamma delta" }),
    )

    const output = await runSearch(blocks, "nonexistent")

    assert.equal(parseHits(output).length, 0)
    assert.equal(output, 'No matches found for "nonexistent". Try different keywords.')
})

test("multi-keyword phrase bonus: phrase query outscores single-keyword query", async () => {
    // Same block scored two ways:
    //   query "alpha beta" → base 0.38 (topic 0.30 + summary 0.08),
    //     ×1.2 all-terms bonus = 0.456, +0.25 phrase bonus = 0.706
    //   query "alpha" alone → 0.15 (topic) + 0.04 (summary) = 0.19
    // The phrase score (0.706) can only be reached with the phrase bonus,
    // since without it the score would be 0.456.
    const blocks = blocksMap(
        makeBlock({
            blockId: 1,
            topic: "alpha beta",
            summary: "alpha beta content",
        }),
    )

    const phraseOutput = await runSearch(blocks, "alpha beta")
    const singleOutput = await runSearch(blocks, "alpha")

    const phraseHits = parseHits(phraseOutput)
    const singleHits = parseHits(singleOutput)

    assert.equal(phraseHits.length, 1)
    assert.equal(singleHits.length, 1)
    assert.ok(
        phraseHits[0].relevance > 0.6,
        `phrase score ${phraseHits[0].relevance} should exceed 0.6 (requires phrase bonus)`,
    )
    assert.ok(
        phraseHits[0].relevance > singleHits[0].relevance,
        "phrase query should outscore single-keyword query on the same block",
    )
    // Exact expected phrase score: 0.38 * 1.2 + 0.25 = 0.706
    assert.equal(phraseHits[0].relevance, 0.71)
    assert.equal(singleHits[0].relevance, 0.19)
})

test("inactive blocks are skipped during search", async () => {
    const blocks = blocksMap(
        makeBlock({ blockId: 1, active: true, topic: "visible match", summary: "x" }),
        makeBlock({ blockId: 2, active: false, topic: "visible match", summary: "x" }),
    )

    const output = await runSearch(blocks, "visible")

    const hits = parseHits(output)
    assert.equal(hits.length, 1, "only the active block should be searched")
    assert.equal(hits[0].blockId, 1)
})

test("custom limit parameter is honored", async () => {
    const blockList: CompressionBlock[] = []
    for (let i = 1; i <= 6; i++) {
        blockList.push(
            makeBlock({ blockId: i, topic: "match match match", summary: "x" }),
        )
    }
    const blocks = blocksMap(...blockList)

    const output = await runSearch(blocks, "match", 3)

    const hits = parseHits(output)
    assert.equal(hits.length, 3, "custom limit=3 must cap results")
    assert.match(output, /Found 6 matches/)
    assert.match(output, /showing top 3/)
})

test("empty query returns an error message", async () => {
    const blocks = blocksMap(makeBlock({ blockId: 1 }))
    const output = await runSearch(blocks, "   ")
    assert.match(output, /Error: query is required/)
})
