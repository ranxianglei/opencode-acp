import assert from "node:assert/strict"
import test from "node:test"
import { createDecompressTool } from "../lib/compress/decompress"
import type { ToolFactoryContext } from "../lib/compress/types"
import { singletonRegistry } from "./registry-stub"
import type {
    CompressionBlock,
    PrunedMessageEntry,
    SessionState,
    WithParts,
} from "../lib/state/types"

// [Issue #446] E2E regressions for the decompress source-availability gate.
// The host history (client.session.messages response) is controllable per test,
// so these exercise the real invariant: a decompression may only commit when the
// originals it claims to restore are actually present in history.

const SID = "session-source-availability-e2e"

function makeMsg(id: string, role: "user" | "assistant", text: string): WithParts {
    return {
        info: {
            id,
            sessionID: SID,
            role,
            time: { created: 1000 },
        },
        parts: [{ type: "text", text }],
    } as unknown as WithParts
}

function makeBlock(overrides: Partial<CompressionBlock> = {}): CompressionBlock {
    return {
        blockId: 5,
        runId: 5,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 1000,
        summaryTokens: 200,
        durationMs: 0,
        mode: "range",
        topic: "test",
        batchTopic: "test",
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
        effectiveMessageIds: ["msg-a"],
        effectiveToolIds: [],
        createdAt: 1000,
        deactivatedAt: undefined,
        deactivatedByBlockId: undefined,
        summary: "Compressed conversation about topic X.",
        survivedCount: 0,
        generation: "young",
        ...overrides,
    }
}

function makeEntry(
    tokenCount: number,
    allBlockIds: number[],
    activeBlockIds: number[],
): PrunedMessageEntry {
    return { tokenCount, allBlockIds, activeBlockIds }
}

function makeState(
    blocks: CompressionBlock[],
    activeIds: number[],
    byMessageId: Map<string, PrunedMessageEntry>,
): SessionState {
    const blocksById = new Map<number, CompressionBlock>()
    for (const b of blocks) blocksById.set(b.blockId, b)
    return {
        sessionId: SID,
        isSubAgent: false,
        compressPermission: "allow",
        qualityGateRetryPending: false,
        prune: {
            tools: new Map(),
            messages: {
                byMessageId,
                blocksById,
                activeBlockIds: new Set(activeIds),
                activeByAnchorMessageId: new Map(),
                nextBlockId: blocks.length + 1,
                nextRunId: blocks.length + 1,
                markedForCleanup: new Set<number>(),
                structureVersion: 1,
                lastSyncedStructureVersion: undefined,
                membershipsVerified: true,
            },
        },
        nudges: {
            contextLimitAnchors: new Set(),
            turnNudgeAnchors: new Set(),
            iterationNudgeAnchors: new Set(),
            lastPerMessageNudgeTurn: 0,
            lastPerMessageNudgeTokens: undefined,
        },
        stats: { pruneTokenCounter: 0, totalPruneTokens: 1000 },
        compressionTiming: {} as any,
        toolParameters: new Map(),
        subAgentResultCache: new Map(),
        toolIdList: [],
        messageIds: { byRawId: new Map(), byRef: new Map(), nextRef: 1 },
        lastCompaction: 0,
        currentTurn: 0,
        modelContextLimit: 100000,
        systemPromptTokens: undefined,
    }
}

interface RunOptions {
    /** Simulate a transient host-history fetch failure (rejecting client). */
    failFetch?: boolean
}

function makeToolContext(state: SessionState, history: WithParts[], options: RunOptions = {}): ToolFactoryContext {
    const noop = () => {}
    return {
        client: {
            session: {
                messages: async () => {
                    if (options.failFetch) {
                        throw new Error("host history fetch failed (transient)")
                    }
                    return { data: history }
                },
            },
        } as any,
        registry: singletonRegistry(state),
        logger: { enabled: false, info: noop, warn: noop, error: noop, debug: noop } as any,
        config: {} as any,
        prompts: { reload: () => {} } as any,
    }
}

async function runDecompress(
    state: SessionState,
    args: Record<string, unknown>,
    history: WithParts[],
    options: RunOptions = {},
): Promise<string> {
    const ctx = makeToolContext(state, history, options)
    const tool = createDecompressTool(ctx)
    return await (tool.execute as any)(args, {
        ask: async () => {},
        metadata: () => {},
        sessionID: SID,
    })
}

// --- All sources missing (issue #446 repro) ---

test("E2E: aborts when every source message is missing from host history", async () => {
    const block = makeBlock({
        blockId: 5,
        effectiveMessageIds: ["msg-gone"],
        directMessageIds: ["msg-gone"],
    })
    const state = makeState([block], [5], new Map([["msg-gone", makeEntry(100, [5], [5])]]))

    // History contains a different message; msg-gone was removed from host history.
    const result = await runDecompress(state, { blockId: "b5" }, [
        makeMsg("msg-other", "user", "x"),
    ])

    assert.ok(result.startsWith("Error: Cannot decompress b5"), `unexpected result: ${result}`)
    assert.match(result, /1 of 1 source message\(s\) are no longer present/)
    assert.match(result, /Missing: msg-gone\./)
    assert.match(result, /not a transient fetch failure/)

    // No state mutated: block stays active, membership intact, stats untouched.
    assert.equal(block.active, true)
    assert.equal(block.deactivatedByUser, false)
    assert.deepEqual(state.prune.messages.byMessageId.get("msg-gone")!.activeBlockIds, [5])
    assert.equal(state.stats.totalPruneTokens, 1000)
})

test("E2E: missing-source error lists model-facing refs when ref mappings exist", async () => {
    const block = makeBlock({
        blockId: 5,
        effectiveMessageIds: ["msg-gone"],
        directMessageIds: ["msg-gone"],
    })
    const state = makeState([block], [5], new Map([["msg-gone", makeEntry(100, [5], [5])]]))
    // Pre-existing mappings survive assignMessageRefs (lib/message-ids.ts:174-180),
    // so the error must surface the model-facing ref rather than the raw ID.
    state.messageIds.byRawId.set("msg-gone", "m00052")
    state.messageIds.byRef.set("m00052", "msg-gone")

    const result = await runDecompress(state, { blockId: "b5" }, [makeMsg("msg-other", "user", "x")])

    assert.ok(result.startsWith("Error: Cannot decompress b5"), `unexpected result: ${result}`)
    assert.match(result, /Missing: m00052\./)
    assert.equal(block.active, true)
})

test("E2E: aborted decompression does not consume the block — retry with available history succeeds", async () => {
    const block = makeBlock({
        blockId: 5,
        effectiveMessageIds: ["msg-a"],
        directMessageIds: ["msg-a"],
    })
    const state = makeState([block], [5], new Map([["msg-a", makeEntry(100, [5], [5])]]))

    const failed = await runDecompress(state, { blockId: "b5" }, [
        makeMsg("msg-other", "user", "x"),
    ])
    assert.ok(failed.startsWith("Error"), `expected abort: ${failed}`)
    assert.equal(block.active, true)

    const retried = await runDecompress(state, { blockId: "b5" }, [makeMsg("msg-a", "user", "a")])
    assert.ok(!retried.includes("Error"), `retry should succeed: ${retried}`)
    assert.match(retried, /Restored 1 message\(s\)/)
    assert.equal(block.active, false)
    assert.equal(block.deactivatedByUser, true)
})

// --- Partial availability ---

test("E2E: partial availability aborts and lists only the missing IDs", async () => {
    const block = makeBlock({
        blockId: 5,
        effectiveMessageIds: ["msg-a", "msg-b"],
        directMessageIds: ["msg-a", "msg-b"],
    })
    const state = makeState(
        [block],
        [5],
        new Map([
            ["msg-a", makeEntry(100, [5], [5])],
            ["msg-b", makeEntry(50, [5], [5])],
        ]),
    )

    const result = await runDecompress(state, { blockId: "b5" }, [
        makeMsg("msg-a", "user", "a"),
        makeMsg("msg-other", "user", "x"),
    ])

    assert.ok(result.startsWith("Error: Cannot decompress b5"), `unexpected result: ${result}`)
    assert.match(result, /1 of 2 source message\(s\) are no longer present/)
    const missingList = result.match(/Missing: ([^.]+)\./)?.[1] ?? ""
    assert.equal(missingList, "msg-b")

    // Nothing committed despite one source being available.
    assert.equal(block.active, true)
    assert.deepEqual(state.prune.messages.byMessageId.get("msg-a")!.activeBlockIds, [5])
    assert.deepEqual(state.prune.messages.byMessageId.get("msg-b")!.activeBlockIds, [5])
    assert.equal(state.stats.totalPruneTokens, 1000)
})

// --- Complete availability (happy path still works) ---

test("E2E: complete availability succeeds with correct restored count, stats, and preview", async () => {
    const block = makeBlock({
        blockId: 5,
        effectiveMessageIds: ["msg-a", "msg-b"],
        directMessageIds: ["msg-a", "msg-b"],
    })
    const state = makeState(
        [block],
        [5],
        new Map([
            ["msg-a", makeEntry(100, [5], [5])],
            ["msg-b", makeEntry(50, [5], [5])],
        ]),
    )

    const result = await runDecompress(state, { blockId: "b5" }, [
        makeMsg("msg-a", "user", "alpha content"),
        makeMsg("msg-b", "user", "beta content"),
    ])

    assert.ok(!result.includes("Error"), `should not error: ${result}`)
    assert.match(result, /Decompressed block b5\. Restored 2 message\(s\)/)
    assert.match(result, /RESTORED CONTENT/)
    assert.match(result, /alpha content/)
    assert.match(result, /beta content/)

    assert.equal(block.active, false)
    assert.equal(block.deactivatedByUser, true)
    assert.deepEqual(state.prune.messages.byMessageId.get("msg-a")!.activeBlockIds, [])
    assert.deepEqual(state.prune.messages.byMessageId.get("msg-b")!.activeBlockIds, [])
    assert.equal(state.stats.totalPruneTokens, 850)
})

// --- Nested blocks: one-tier semantics ---

function nestedFixture(): { state: SessionState; t1: CompressionBlock; t2: CompressionBlock } {
    const t1 = makeBlock({
        blockId: 2,
        runId: 2,
        active: false,
        createdAt: 900,
        effectiveMessageIds: ["msg-a", "msg-b"],
        directMessageIds: ["msg-a", "msg-b"],
        summary: "T1 summary of inner messages.",
    })
    const t2 = makeBlock({
        blockId: 5,
        runId: 5,
        active: true,
        consumedBlockIds: [2],
        effectiveMessageIds: ["msg-a", "msg-b", "msg-c", "msg-d", "msg-e"],
        directMessageIds: ["msg-c", "msg-d", "msg-e"],
    })
    const state = makeState(
        [t1, t2],
        [5],
        new Map([
            ["msg-a", makeEntry(10, [2, 5], [5])],
            ["msg-b", makeEntry(10, [2, 5], [5])],
            ["msg-c", makeEntry(10, [5], [5])],
            ["msg-d", makeEntry(10, [5], [5])],
            ["msg-e", makeEntry(10, [5], [5])],
        ]),
    )
    return { state, t1, t2 }
}

test("E2E: one-tier nested decompress succeeds when only direct raws remain (consumed tier shielded)", async () => {
    const { state, t1, t2 } = nestedFixture()

    // Host history lost the consumed tier's raws (msg-a/msg-b) but kept b5's
    // direct raws. One-tier semantics reactivates b2, so msg-a/msg-b stay hidden
    // under it and must NOT be required sources.
    const result = await runDecompress(state, { blockId: "b5" }, [
        makeMsg("msg-c", "user", "c"),
        makeMsg("msg-d", "user", "d"),
        makeMsg("msg-e", "user", "e"),
    ])

    assert.ok(!result.includes("Error"), `should not error: ${result}`)
    assert.match(result, /Restored 3 message\(s\)/)
    assert.match(result, /Also restored nested block\(s\): b2\./)

    assert.equal(t2.active, false)
    assert.equal(t2.deactivatedByUser, true)
    assert.equal(t1.active, true, "consumed tier must be reactivated by sync")
    assert.equal(t1.deactivatedByUser, false)
    // Shielded messages remain covered by the reactivated tier.
    assert.deepEqual(state.prune.messages.byMessageId.get("msg-a")!.activeBlockIds, [2])
    assert.deepEqual(state.prune.messages.byMessageId.get("msg-c")!.activeBlockIds, [])
    // Stats reflect only the 3 verified restored raws (3 x 10 tokens).
    assert.equal(state.stats.totalPruneTokens, 970)
})

test("E2E: full nested decompress aborts when consumed-tier raws are missing", async () => {
    const { state, t1, t2 } = nestedFixture()

    // full:true deep-deactivates b2, so its raws become required sources.
    const result = await runDecompress(state, { blockId: "b5", full: true }, [
        makeMsg("msg-c", "user", "c"),
        makeMsg("msg-d", "user", "d"),
        makeMsg("msg-e", "user", "e"),
    ])

    assert.ok(result.startsWith("Error: Cannot decompress b5"), `unexpected result: ${result}`)
    assert.match(result, /2 of 5 source message\(s\) are no longer present/)
    const missingList = result.match(/Missing: ([^.]+)\./)?.[1] ?? ""
    assert.equal(missingList, "msg-a, msg-b")

    // Nothing committed: both tiers keep their liveness, no deep-deactivation.
    assert.equal(t2.active, true)
    assert.equal(t2.deactivatedByUser, false)
    assert.equal(t1.active, false)
    assert.equal(t1.deactivatedByUserDeep, undefined, "no deep-deactivation may have been committed")
    assert.equal(state.stats.totalPruneTokens, 1000)
})

test("E2E: full nested decompress succeeds when all raws are present", async () => {
    const { state, t1, t2 } = nestedFixture()

    const result = await runDecompress(state, { blockId: "b5", full: true }, [
        makeMsg("msg-a", "user", "a"),
        makeMsg("msg-b", "user", "b"),
        makeMsg("msg-c", "user", "c"),
        makeMsg("msg-d", "user", "d"),
        makeMsg("msg-e", "user", "e"),
    ])

    assert.ok(!result.includes("Error"), `should not error: ${result}`)
    assert.match(result, /Restored 5 message\(s\)/)

    assert.equal(t2.active, false)
    assert.equal(t2.deactivatedByUser, true)
    assert.equal(t1.active, false)
    assert.equal(t1.deactivatedByUserDeep, true, "full mode must deep-deactivate consumed tiers")
    for (const id of ["msg-a", "msg-b", "msg-c", "msg-d", "msg-e"]) {
        assert.deepEqual(state.prune.messages.byMessageId.get(id)!.activeBlockIds, [])
    }
    // Stats reflect all 5 verified restored raws (5 x 10 tokens).
    assert.equal(state.stats.totalPruneTokens, 950)
})

// --- Transient fetch failure vs missing sources (acceptance criterion 6) ---

test("E2E: transient host-fetch failure rejects before commit — distinct from missing-source abort", async () => {
    const block = makeBlock({
        blockId: 5,
        effectiveMessageIds: ["msg-a"],
        directMessageIds: ["msg-a"],
    })
    const state = makeState([block], [5], new Map([["msg-a", makeEntry(100, [5], [5])]]))

    // A throwing host fetch is a transient failure: it must reject out of the tool
    // call via prepareDecompressSession — never be misclassified as a missing-source
    // abort string, and never mutate state.
    await assert.rejects(
        runDecompress(state, { blockId: "b5" }, [makeMsg("msg-a", "user", "a")], { failFetch: true }),
        /host history fetch failed/,
    )

    assert.equal(block.active, true)
    assert.equal(block.deactivatedByUser, false)
})
