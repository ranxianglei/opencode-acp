import "./test-env"
import assert from "node:assert/strict"
import test from "node:test"
import type { SessionState, WithParts, CompressionBlock } from "../lib/state"
import { buildSearchContext, resolveBoundaryIds } from "../lib/compress/search"

// Issue #476 AC4 — on an unresolvable compress boundary, the error must list
// the still-FREE ranges instead of implying a contiguous first–last window
// (consumed blocks leave gaps) or sending the model off to acp_status().

const SID = "ses-boundary-hint"

function makeMessage(id: string, role: "user" | "assistant" = "user"): WithParts {
    return {
        info: {
            id,
            role,
            sessionID: SID,
            agent: "a",
            time: { created: 1 },
        } as WithParts["info"],
        parts: [{ id: `${id}-p`, messageID: id, sessionID: SID, type: "text" as const, text: "x" }],
    }
}

function makeBlock(overrides: Partial<CompressionBlock> = {}): CompressionBlock {
    return {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 100,
        summaryTokens: 20,
        durationMs: 0,
        topic: "test",
        batchTopic: "test",
        startId: "m00003",
        endId: "m00004",
        anchorMessageId: "raw-3",
        compressMessageId: "comp-1",
        compressCallId: undefined,
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: ["raw-3", "raw-4"],
        directToolIds: [],
        effectiveMessageIds: ["raw-3", "raw-4"],
        effectiveToolIds: [],
        createdAt: 1000,
        deactivatedAt: undefined,
        deactivatedByBlockId: undefined,
        summary: "A summary",
        survivedCount: 0,
        generation: "young",
        ...overrides,
    }
}

// state with refs m00001..m0000N mapped to raw-1..raw-N; `visibleRaw` selects
// which messages are still in the outgoing list (the rest are "consumed").
function makeScenario(n: number, visibleRaw: number[], blocks: CompressionBlock[] = []) {
    const byRef = new Map<string, string>()
    const byRawId = new Map<string, string>()
    for (let i = 1; i <= n; i++) {
        const ref = `m${String(i).padStart(5, "0")}`
        const raw = `raw-${i}`
        byRef.set(ref, raw)
        byRawId.set(raw, ref)
    }
    const rawMessages: WithParts[] = visibleRaw.map((i) => makeMessage(`raw-${i}`))
    const state: SessionState = {
        sessionId: SID,
        isSubAgent: false,
        compressPermission: "allow",
        prune: {
            messages: {
                byMessageId: new Map(),
                blocksById: new Map(blocks.map((b) => [b.blockId, b])),
                activeBlockIds: new Set(blocks.map((b) => b.blockId)),
                activeByAnchorMessageId: new Map(),
                nextBlockId: blocks.length + 1,
                nextRunId: 1,
            },
        },
        nudges: {
            contextLimitAnchors: new Set(),
            turnNudgeAnchors: new Set(),
            iterationNudgeAnchors: new Set(),
        },
        stats: { pruneTokenCounter: 0, totalPruneTokens: 0 },
        compressionTiming: {} as any,
        toolParameters: new Map(),
        toolIdList: [],
        messageIds: { byRawId, byRef, nextRef: n + 1 },
        lastCompaction: 0,
        currentTurn: 0,
        modelContextLimit: undefined,
        systemPromptTokens: undefined,
    }
    return { state, rawMessages }
}

function expectError(fn: () => void): string {
    try {
        fn()
    } catch (err) {
        assert.ok(err instanceof Error)
        return err.message
    }
    assert.fail("resolveBoundaryIds should have thrown")
    return ""
}

test("gapped refs: error enumerates the free spans, not a first–last window", () => {
    // m00003/m00004 consumed by block b1 → visible: 1,2,5,6,7
    const { state, rawMessages } = makeScenario(7, [1, 2, 5, 6, 7], [makeBlock()])
    const ctx = buildSearchContext(state, rawMessages)
    const msg = expectError(() => resolveBoundaryIds(ctx, state, "m00003", "m00005"))
    assert.match(msg, /startId m00003 is not available — likely consumed by an existing block\./)
    assert.match(msg, /Free ranges: m00001–m00002, m00005–m00007\./)
    assert.match(msg, /1 active compressed block\./)
    assert.match(msg, /Retry with IDs inside the free ranges\./)
    // The old hint implied continuity ("Current visible: first–last") — gone.
    assert.doesNotMatch(msg, /Current visible:/)
})

test("contiguous refs collapse into a single span", () => {
    const { state, rawMessages } = makeScenario(7, [1, 2, 3, 4, 5, 6, 7])
    const ctx = buildSearchContext(state, rawMessages)
    // endId beyond the last available → clamped, so use an invalid kind to force
    // the error path: request a consumed-only gap scenario via missing ref.
    // Here everything is visible; force failure with a block ref that doesn't exist.
    const msg = expectError(() => resolveBoundaryIds(ctx, state, "b9", "m00001"))
    assert.match(msg, /startId b9 is not available/)
    assert.match(msg, /Free ranges: m00001–m00007\./)
    assert.doesNotMatch(msg, /active compressed block/)
})

test("single visible ref renders as a bare ref, not a degenerate range", () => {
    const { state, rawMessages } = makeScenario(7, [4])
    const ctx = buildSearchContext(state, rawMessages)
    // m00003 is consumed (not visible) and within max index → no clamp → error
    const msg = expectError(() => resolveBoundaryIds(ctx, state, "m00003", "m00004"))
    assert.match(msg, /Free ranges: m00004\./)
})

test("span list is capped at 8 spans with an overflow count", () => {
    // Visible odd refs 1,3,...,19 → ten single-ref spans
    const visible = [1, 3, 5, 7, 9, 11, 13, 15, 17, 19]
    const { state, rawMessages } = makeScenario(19, visible)
    const ctx = buildSearchContext(state, rawMessages)
    const msg = expectError(() => resolveBoundaryIds(ctx, state, "m00002", "m00003"))
    assert.match(
        msg,
        /Free ranges: m00001, m00003, m00005, m00007, m00009, m00011, m00013, m00015 \(\+2 more\)\./,
    )
})

test("regression guard: recovery hint no longer sends the model to acp_status()", () => {
    const { state, rawMessages } = makeScenario(7, [1, 2, 5, 6, 7])
    const ctx = buildSearchContext(state, rawMessages)
    const msg = expectError(() => resolveBoundaryIds(ctx, state, "m00004", "m00006"))
    assert.doesNotMatch(msg, /acp_status\(\)/)
})

test("no visible refs at all: plain issues only, no empty hint fragment", () => {
    const { state, rawMessages } = makeScenario(3, [])
    const ctx = buildSearchContext(state, rawMessages)
    const msg = expectError(() => resolveBoundaryIds(ctx, state, "m00001", "m00002"))
    assert.match(msg, /startId m00001 is not available/)
    assert.doesNotMatch(msg, /Free ranges:/)
    assert.doesNotMatch(msg, /Retry with IDs inside the free ranges\./)
})
