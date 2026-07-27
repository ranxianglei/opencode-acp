import assert from "node:assert/strict"
import test from "node:test"
import fc from "fast-check"

import { runTruncateGC, type GCParams } from "../lib/gc/truncate"
import type { CompressionBlock } from "../lib/state/types"
import {
    formatMessageRef,
    parseMessageRef,
    parseBoundaryId,
    assignMessageRefs,
} from "../lib/message-ids"
import type { SessionState, WithParts } from "../lib/state/types"
import { syncCompressionBlocks } from "../lib/messages/sync"
import type { Logger } from "../lib/logger"

const noopLogger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => noopLogger,
} as unknown as Logger

function makeBlock(overrides: Partial<CompressionBlock> = {}): CompressionBlock {
    return {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 1000,
        summaryTokens: 100,
        durationMs: 0,
        topic: "test",
        startId: "m00001",
        endId: "m00005",
        anchorMessageId: "msg-1",
        compressMessageId: "msg-compress",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: ["msg-1"],
        directToolIds: [],
        effectiveMessageIds: ["msg-1"],
        effectiveToolIds: [],
        createdAt: Date.now(),
        summary: "Test summary content",
        survivedCount: 0,
        generation: "young",
        ...overrides,
    }
}

function makeMessage(
    id: string,
    role: "user" | "assistant" = "user",
    text: string = "hello",
): WithParts {
    return {
        info: {
            id,
            role,
            sessionID: "session-1",
            createdAt: new Date().toISOString(),
        } as any,
        parts: [{ type: "text", text }] as any,
    }
}

function makeEmptyState(): SessionState {
    return {
        sessionId: "session-1",
        isSubAgent: false,
        prune: {
            tools: new Map(),
            messages: {
                byMessageId: new Map(),
                blocksById: new Map(),
                activeBlockIds: new Set(),
                activeByAnchorMessageId: new Map(),
                nextBlockId: 1,
                nextRunId: 1,
                markedForCleanup: new Set(),
            },
        },
        nudges: {
            contextLimitAnchors: new Set(),
            turnNudgeAnchors: new Set(),
            iterationNudgeAnchors: new Set(),
            lastPerMessageNudgeTurn: 0,
            lastPerMessageNudgeTokens: undefined,
            lastNudgeShownTokens: undefined,
            lastToolOutputNudgeTokens: undefined,
            lastTier2NudgeTokens: undefined,
            lastTier3NudgeTokens: undefined,
            shouldInjectThisTurn: undefined,
            baselineLocked: false,
        },
        stats: { pruneTokenCounter: 0, totalPruneTokens: 0 },
        messageIds: {
            byRawId: new Map(),
            byRef: new Map(),
            nextRef: 1,
        },
        compressionTiming: { pending: new Map(), completed: [] },
        toolParameters: new Map(),
        manualMode: { enabled: false, pending: null },
    } as unknown as SessionState
}

// === GC TRUNCATE PROPERTY TESTS ===

test("GC property: truncated summary never exceeds maxLength (multiline)", () => {
    fc.assert(
        fc.property(
            fc.record({
                header: fc.string({ minLength: 1, maxLength: 100 }),
                body: fc.string({ minLength: 50, maxLength: 5000 }),
                maxLength: fc.integer({ min: 100, max: 2000 }),
            }),
            ({ header, body, maxLength }) => {
                const summary = header + "\n" + body
                if (summary.length <= maxLength) return

                const block = makeBlock({ summary })
                const params: GCParams = {
                    maxOldGenSummaryLength: maxLength,
                    modelContextLimit: 200000,
                    currentTokens: 100000,
                }

                runTruncateGC([block], params)
                assert.ok(
                    block.summary.length <= maxLength,
                    `GC output ${block.summary.length} > maxLength ${maxLength}`,
                )
            },
        ),
        { numRuns: 200 },
    )
})

test("GC property: inactive blocks are never modified", () => {
    fc.assert(
        fc.property(
            fc.record({
                summary: fc.string({ minLength: 200, maxLength: 5000 }),
                maxLength: fc.integer({ min: 50, max: 100 }),
            }),
            ({ summary, maxLength }) => {
                const original = summary
                const block = makeBlock({ summary, active: false })
                runTruncateGC([block], {
                    maxOldGenSummaryLength: maxLength,
                    modelContextLimit: 200000,
                    currentTokens: 100000,
                })
                assert.equal(block.summary, original)
            },
        ),
        { numRuns: 100 },
    )
})

// === GC BUG DISCOVERY TESTS ===

test("BUG: single-line summary GC output exceeds maxLength by 19 chars", () => {
    const summary = "x".repeat(500)
    const maxLength = 100
    const block = makeBlock({ summary })

    runTruncateGC([block], {
        maxOldGenSummaryLength: maxLength,
        modelContextLimit: 200000,
        currentTokens: 100000,
    })

    const marker = "\n...\n[GC truncated]"
    assert.equal(marker.length, 19, "Marker string is 19 chars, not 20")
    assert.equal(block.summary.length, maxLength + marker.length)
    assert.ok(block.summary.length > maxLength)
})

test("BUG: long header causes massive GC output overrun", () => {
    const summary = "x".repeat(300) + "\nshort body\n\nfooter"
    const maxLength = 50
    const block = makeBlock({ summary })

    runTruncateGC([block], {
        maxOldGenSummaryLength: maxLength,
        modelContextLimit: 200000,
        currentTokens: 100000,
    })

    assert.ok(
        block.summary.length > maxLength * 2,
        `Expected output to be much larger than maxLength. Got ${block.summary.length}`,
    )
})

test("BUG: barely-over-maxLength summary silently fails truncation", () => {
    const maxLength = 100
    const summary = "x".repeat(maxLength + 10)
    const block = makeBlock({ summary })

    const result = runTruncateGC([block], {
        maxOldGenSummaryLength: maxLength,
        modelContextLimit: 200000,
        currentTokens: 100000,
    })

    assert.equal(result.compactedBlocks, 0, "GC should not report compaction (bug)")
    assert.equal(block.summary, summary, "Block summary should be unchanged (bug)")
    assert.ok(block.summary.length > maxLength, "Summary still exceeds maxLength")
})

test("GC: empty summary is not modified", () => {
    const block = makeBlock({ summary: "" })
    const result = runTruncateGC([block], {
        maxOldGenSummaryLength: 100,
        modelContextLimit: 200000,
        currentTokens: 100000,
    })
    assert.equal(result.compactedBlocks, 0)
    assert.equal(block.summary, "")
})

test("GC: summary exactly at maxLength is not modified", () => {
    const maxLength = 200
    const summary = "x".repeat(maxLength)
    const block = makeBlock({ summary })
    const result = runTruncateGC([block], {
        maxOldGenSummaryLength: maxLength,
        modelContextLimit: 200000,
        currentTokens: 100000,
    })
    assert.equal(result.compactedBlocks, 0)
    assert.equal(block.summary, summary)
})

test("BUG: multiline truncation output is 1 char short (off-by-one in marker size)", () => {
    const summary = "Header line\n" + "x".repeat(1000) + "\n\nfooter"
    const maxLength = 200
    const block = makeBlock({ summary })

    runTruncateGC([block], {
        maxOldGenSummaryLength: maxLength,
        modelContextLimit: 200000,
        currentTokens: 100000,
    })

    assert.equal(block.summary.length, maxLength - 1, "Output is maxLength-1, not maxLength")
    assert.ok(block.summary.startsWith("Header line"))
    assert.ok(block.summary.includes("[GC truncated]"))
})

// === MESSAGE IDS PROPERTY TESTS ===

test("MessageIDs property: bidirectional consistency after assignment", () => {
    fc.assert(
        fc.property(
            fc.array(
                fc.record({
                    id: fc.string({ minLength: 1, maxLength: 50 }).filter(
                        (s) => !s.startsWith("msg_dcp_"),
                    ),
                    role: fc.constantFrom("user", "assistant"),
                }),
                { minLength: 1, maxLength: 50 },
            ),
            (rawMessages) => {
                const state = makeEmptyState()
                const messages = rawMessages.map((m) => makeMessage(m.id, m.role))

                assignMessageRefs(state, messages)

                for (const [rawId, ref] of state.messageIds.byRawId) {
                    assert.equal(state.messageIds.byRef.get(ref), rawId)
                }
                for (const [ref, rawId] of state.messageIds.byRef) {
                    assert.equal(state.messageIds.byRawId.get(rawId), ref)
                }

                const refs = [...state.messageIds.byRef.keys()]
                assert.equal(refs.length, new Set(refs).size, "Duplicate refs")
            },
        ),
        { numRuns: 50 },
    )
})

test("MessageIDs: parse/format round-trip", () => {
    fc.assert(
        fc.property(fc.integer({ min: 1, max: 99999 }), (index) => {
            assert.equal(parseMessageRef(formatMessageRef(index)), index)
        }),
        { numRuns: 200 },
    )
})

test("MessageIDs: parseBoundaryId edge cases", () => {
    assert.notEqual(parseBoundaryId("m00001"), null)
    assert.notEqual(parseBoundaryId("m99999"), null)
    assert.notEqual(parseBoundaryId("b1"), null)
    assert.equal(parseBoundaryId("m0"), null)
    assert.equal(parseBoundaryId("b0"), null)
    assert.equal(parseBoundaryId(""), null)
    assert.equal(parseBoundaryId("xyz"), null)
    assert.equal(parseBoundaryId("m100000"), null)
})

// === SYNC EDGE CASES ===

test("Sync: consumed blocks become inactive, consumer stays active", () => {
    const numBlocks = 10
    const state = makeEmptyState()

    for (let i = 1; i <= numBlocks; i++) {
        state.prune.messages.blocksById.set(
            i,
            makeBlock({
                blockId: i,
                anchorMessageId: `msg-${i}`,
                consumedBlockIds: i > 1 ? [i - 1] : [],
                createdAt: 1000 + i,
                active: true,
            }),
        )
        state.prune.messages.activeBlockIds.add(i)
    }

    const messages: WithParts[] = []
    for (let i = 1; i <= numBlocks; i++) {
        messages.push(makeMessage(`msg-${i}`))
    }

    syncCompressionBlocks(state, noopLogger, messages)

    for (let i = 1; i < numBlocks; i++) {
        assert.equal(state.prune.messages.blocksById.get(i)!.active, false)
    }
    assert.equal(state.prune.messages.blocksById.get(numBlocks)!.active, true)
})

test("Sync: activeBlockIds matches block.active flags", () => {
    const state = makeEmptyState()

    for (let i = 1; i <= 5; i++) {
        state.prune.messages.blocksById.set(
            i,
            makeBlock({
                blockId: i,
                active: i % 2 === 0,
                anchorMessageId: `msg-${i}`,
                createdAt: i * 1000,
            }),
        )
        if (i % 2 === 0) state.prune.messages.activeBlockIds.add(i)
    }

    const messages = [1, 2, 3, 4, 5].map((i) => makeMessage(`msg-${i}`))
    syncCompressionBlocks(state, noopLogger, messages)

    for (const [blockId, block] of state.prune.messages.blocksById) {
        assert.equal(
            state.prune.messages.activeBlockIds.has(blockId),
            block.active,
            `Mismatch for block ${blockId}`,
        )
    }
})

test("Sync: self-consuming block doesn't crash", () => {
    const state = makeEmptyState()
    state.prune.messages.blocksById.set(
        1,
        makeBlock({ blockId: 1, consumedBlockIds: [1], anchorMessageId: "msg-1" }),
    )
    state.prune.messages.activeBlockIds.add(1)

    syncCompressionBlocks(state, noopLogger, [makeMessage("msg-1")])

    assert.ok(state.prune.messages.blocksById.has(1))
})

test("Sync: empty messages array doesn't crash", () => {
    const state = makeEmptyState()
    state.prune.messages.blocksById.set(
        1,
        makeBlock({ blockId: 1, anchorMessageId: "msg-1" }),
    )
    state.prune.messages.activeBlockIds.add(1)

    syncCompressionBlocks(state, noopLogger, [])

    assert.ok(state.prune.messages.blocksById.has(1))
    assert.ok(!state.prune.messages.activeByAnchorMessageId.has("msg-1"))
})

// === GC EDGE CASES ===

test("GC: summary with only newlines doesn't crash", () => {
    const summary = "\n\n\n\n\n".repeat(100)
    const block = makeBlock({ summary })

    runTruncateGC([block], {
        maxOldGenSummaryLength: 50,
        modelContextLimit: 200000,
        currentTokens: 100000,
    })

    assert.ok(block.summary.length > 0)
})
