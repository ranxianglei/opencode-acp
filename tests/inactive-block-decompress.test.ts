import assert from "node:assert/strict"
import test from "node:test"
import { createDecompressTool } from "../lib/compress/decompress"
import type { ToolContext } from "../lib/compress/types"
import type {
    CompressionBlock,
    PrunedMessageEntry,
    SessionState,
    WithParts,
} from "../lib/state/types"
import { resolveCompressionTarget } from "../lib/commands/compression-targets"
import { findActiveAncestorBlockId } from "../lib/compress/decompress-logic"

const SID = "session-inactive-decompress-e2e"

function makeBlock(overrides: Partial<CompressionBlock> = {}): CompressionBlock {
    return {
        blockId: 1,
        runId: 1,
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
        directMessageIds: ["msg-a", "msg-b"],
        directToolIds: [],
        effectiveMessageIds: ["msg-a", "msg-b"],
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

function makeState(blocks: CompressionBlock[], activeIds: number[]): SessionState {
    const blocksById = new Map<number, CompressionBlock>()
    for (const b of blocks) {
        blocksById.set(b.blockId, b)
    }
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
                blocksById,
                activeBlockIds: new Set<number>(activeIds),
                activeByAnchorMessageId: new Map(),
                nextBlockId: blocks.length + 1,
                nextRunId: blocks.length + 1,
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
        modelContextLimit: 100000,
        systemPromptTokens: undefined,
    }
}

function makeToolContext(state: SessionState): ToolContext {
    const noop = () => {}
    return {
        client: {
            session: {
                messages: async () => ({ data: [] as WithParts[] }),
            },
        } as any,
        state,
        logger: {
            enabled: false,
            info: noop,
            warn: noop,
            error: noop,
            debug: noop,
        } as any,
        config: { manualMode: { enabled: false } } as any,
        prompts: { reload: () => {} } as any,
    }
}

function makeRunContext(): { ask: any; metadata: any; sessionID: string } {
    return {
        ask: async () => {},
        metadata: () => {},
        sessionID: SID,
    }
}

async function runDecompress(
    state: SessionState,
    args: Record<string, unknown>,
): Promise<string> {
    const ctx = makeToolContext(state)
    const tool = createDecompressTool(ctx)
    return tool.execute(args as any, makeRunContext() as any)
}

// --- resolveCompressionTarget returns target for inactive blocks ---

test("resolveCompressionTarget returns target for inactive standalone block", () => {
    const block = makeBlock({ blockId: 5, active: false, deactivatedByUser: false })
    const state = makeState([block], [])
    const target = resolveCompressionTarget(state.prune.messages, 5)
    assert.ok(target !== null)
    assert.equal(target!.displayId, 5)
    assert.equal(target!.blocks.length, 1)
})

test("resolveCompressionTarget returns null for non-existent block", () => {
    const state = makeState([], [])
    const target = resolveCompressionTarget(state.prune.messages, 99)
    assert.equal(target, null)
})

// --- E2E: decompress tool with standalone inactive block ---

test("E2E: decompress tool succeeds for standalone inactive block", async () => {
    const inactiveBlock = makeBlock({
        blockId: 5,
        active: false,
        deactivatedByUser: false,
        parentBlockIds: [],
    })
    const state = makeState([inactiveBlock], [])

    const result = await runDecompress(state, { blockId: "b5" })

    assert.ok(!result.includes("not active"), `should not reject: ${result}`)
    assert.ok(!result.includes("Error"), `should not error: ${result}`)
    assert.match(result, /Decompressed/)
})

test("E2E: decompress tool redirects for consumed block with active parent", async () => {
    const activeParent = makeBlock({ blockId: 10, active: true })
    const consumedBlock = makeBlock({
        blockId: 5,
        active: false,
        parentBlockIds: [10],
    })
    const state = makeState([activeParent, consumedBlock], [10])

    const result = await runDecompress(state, { blockId: "b5" })

    assert.match(result, /nested inside active block/)
    assert.match(result, /Decompress block 10 first/)
})

test("E2E: decompress tool works normally for active block", async () => {
    const activeBlock = makeBlock({ blockId: 1, active: true })
    const state = makeState([activeBlock], [1])

    const result = await runDecompress(state, { blockId: "b1" })

    assert.ok(!result.includes("Error"), `should not error: ${result}`)
    assert.match(result, /Decompressed/)
})

// --- E2E: toFile on inactive block writes summary, not placeholder ---

test("E2E: toFile on inactive block writes block summary", async () => {
    const inactiveBlock = makeBlock({
        blockId: 5,
        active: false,
        summary: "Important compressed content about feature X.",
    })
    const state = makeState([inactiveBlock], [])

    const result = await runDecompress(state, {
        blockId: "b5",
        toFile: "/tmp/test-inactive-block-decompress.txt",
    })

    assert.ok(!result.includes("Error"), `should not error: ${result}`)
    assert.match(result, /written to/)
    assert.ok(
        !result.includes("(no content available)"),
        `should not write placeholder: ${result}`,
    )

    const { readFileSync } = await import("fs")
    const fileContent = readFileSync("/tmp/test-inactive-block-decompress.txt", "utf-8")
    assert.equal(fileContent, "Important compressed content about feature X.")
})

// --- E2E: multi-block scenario (consumed chain) ---

test("E2E: decompress succeeds when all ancestor chain is inactive", async () => {
    const grandchild = makeBlock({
        blockId: 3,
        active: false,
        parentBlockIds: [2],
        summary: "Innermost block summary.",
    })
    const child = makeBlock({
        blockId: 2,
        active: false,
        parentBlockIds: [1],
        consumedBlockIds: [3],
        summary: "Middle block summary.",
    })
    const parent = makeBlock({
        blockId: 1,
        active: false,
        consumedBlockIds: [2],
        summary: "Outermost block summary.",
    })
    const state = makeState([parent, child, grandchild], [])

    const ancestorId = findActiveAncestorBlockId(state.prune.messages, {
        displayId: 3,
        blocks: [grandchild],
    } as any)
    assert.equal(ancestorId, null, "no active ancestor in fully-inactive chain")

    const result = await runDecompress(state, { blockId: "b3" })
    assert.ok(!result.includes("Error"), `should not error: ${result}`)
    assert.match(result, /Decompressed/)
})
