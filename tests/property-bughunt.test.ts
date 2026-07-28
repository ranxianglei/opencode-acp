import assert from "node:assert/strict"
import test from "node:test"
import fc from "fast-check"

import type { CompressionBlock } from "../lib/state/types"
import {
    formatMessageRef,
    parseMessageRef,
    parseBoundaryId,
    assignMessageRefs,
} from "../lib/message-ids"
import type { SessionState, WithParts } from "../lib/state/types"
import { syncCompressionBlocks } from "../lib/messages/sync"
import { prune } from "../lib/messages/prune"
import type { Logger } from "../lib/logger"
import type { PluginConfig } from "../lib/config"

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

const noopConfig = {
    enabled: true,
    compress: { showCompression: false },
} as unknown as PluginConfig

function markCompressed(state: SessionState, messageIds: string[], blockId: number) {
    for (const id of messageIds) {
        const entry = state.prune.messages.byMessageId.get(id) ?? {
            tokenCount: 100,
            allBlockIds: [],
            activeBlockIds: [],
        }
        entry.allBlockIds = [...new Set([...entry.allBlockIds, blockId])]
        entry.activeBlockIds = [...entry.allBlockIds]
        state.prune.messages.byMessageId.set(id, entry)
    }
}

test("Prune: compressed messages are removed, uncompressed survive", () => {
    const state = makeEmptyState()
    const messages = [
        makeMessage("msg-1", "user", "first user"),
        makeMessage("msg-2", "assistant", "response"),
        makeMessage("msg-3", "user", "second user"),
        makeMessage("msg-4", "assistant", "response 2"),
    ]

    markCompressed(state, ["msg-2", "msg-3"], 1)

    prune(state, noopLogger, noopConfig, messages)

    const survivingIds = messages.map((m) => m.info.id)
    assert.ok(survivingIds.includes("msg-1"), "First user must survive")
    assert.ok(!survivingIds.includes("msg-2"), "Compressed msg-2 should be removed")
    assert.ok(!survivingIds.includes("msg-3"), "Compressed msg-3 should be removed")
    assert.ok(survivingIds.includes("msg-4"), "Uncompressed msg-4 must survive")
})

test("Prune: first user message survives even when compressed", () => {
    const state = makeEmptyState()
    const messages = [
        makeMessage("msg-1", "user", "first user"),
        makeMessage("msg-2", "assistant", "response"),
    ]

    markCompressed(state, ["msg-1"], 1)

    prune(state, noopLogger, noopConfig, messages)

    assert.equal(messages.length, 2, "Both survive: msg-1 forced + msg-2 uncompressed")
    assert.equal(messages[0]!.info.id, "msg-1")
})

test("Prune: all compressed + no user messages = empty result", () => {
    const state = makeEmptyState()
    const messages = [
        makeMessage("msg-1", "assistant", "response"),
        makeMessage("msg-2", "assistant", "response 2"),
    ]

    markCompressed(state, ["msg-1", "msg-2"], 1)

    prune(state, noopLogger, noopConfig, messages)

    assert.equal(messages.length, 0, "All messages removed — no user to preserve")
})

test("Prune property: uncompressed messages always survive", () => {
    fc.assert(
        fc.property(
            fc.array(
                fc.record({
                    id: fc.string({ minLength: 1, maxLength: 20 }).map((s) => `msg-${s}`),
                    role: fc.constantFrom("user", "assistant"),
                    compressed: fc.boolean(),
                }),
                { minLength: 1, maxLength: 20 },
            ),
            (specs) => {
                const state = makeEmptyState()
                const messages = specs.map((s) => makeMessage(s.id, s.role, "text"))

                const compressedIds = specs.filter((s) => s.compressed).map((s) => s.id)
                if (compressedIds.length > 0) {
                    markCompressed(state, compressedIds, 1)
                }

                prune(state, noopLogger, noopConfig, messages)

                const survivingIds = new Set(messages.map((m) => m.info.id))

                for (const spec of specs) {
                    if (!spec.compressed) {
                        assert.ok(
                            survivingIds.has(spec.id),
                            `Uncompressed ${spec.id} should survive`,
                        )
                    }
                }

                const firstUser = specs.find((s) => s.role === "user")
                if (firstUser) {
                    assert.ok(
                        survivingIds.has(firstUser.id),
                        "First user message must always survive",
                    )
                }
            },
        ),
        { numRuns: 50 },
    )
})
