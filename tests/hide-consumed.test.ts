import { describe, it } from "node:test"
import assert from "node:assert/strict"
import type { SessionState, WithParts } from "../lib/state"
import { hideConsumedCompressCalls } from "../lib/compress/hide-consumed"

function makeBlock(overrides: Record<string, unknown>): Record<string, unknown> {
    return {
        blockId: 0,
        runId: 0,
        active: true,
        deactivatedByUser: false,
        deactivatedByUserDeep: false,
        deactivatedAt: undefined,
        deactivatedByBlockId: undefined,
        compressMessageId: undefined,
        compressCallId: undefined,
        anchorMessageId: "anchor-1",
        summary: "test summary",
        summaryTokens: 10,
        survivedCount: 0,
        generation: "young",
        mode: "range",
        tier: 1,
        topic: "",
        batchTopic: undefined,
        startId: "m00001",
        endId: "m00010",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: [],
        effectiveToolIds: [],
        createdAt: Date.now(),
        durationMs: 0,
        compressedTokens: 0,
        ...overrides,
    }
}

function makeState(blocks: Record<string, unknown>[]): SessionState {
    const blocksById = new Map<number, unknown>()
    const activeBlockIds = new Set<number>()
    for (const b of blocks) {
        blocksById.set(b.blockId as number, b)
        if (b.active) activeBlockIds.add(b.blockId as number)
    }
    return {
        sessionId: "test-session",
        prune: {
            messages: {
                blocksById,
                activeBlockIds,
                byMessageId: new Map(),
                activeByAnchorMessageId: new Map(),
            },
        },
        nudges: {},
        stats: { pruneTokenCounter: 0, totalPruneTokens: 0 },
        messageIds: { byRef: new Map(), byId: new Map(), nextRefId: 1 },
        compressionTiming: { startsByCallId: new Map(), pendingByCallId: new Map() },
        toolParameters: [],
    } as unknown as SessionState
}

describe("hideConsumedCompressCalls", () => {
    it("hides T1 compress call when T2 consumes it (previous turn)", () => {
        const b1 = makeBlock({
            blockId: 1,
            active: false,
            deactivatedByBlockId: 4,
            compressMessageId: "msg-t1-compress",
            tier: 1,
        })
        const b4 = makeBlock({
            blockId: 4,
            active: true,
            compressMessageId: "msg-t2-compress",
            tier: 2,
        })

        const state = makeState([b1, b4])
        const messages: WithParts[] = [
            { info: { id: "msg-user-1", role: "user" } as any, parts: [{ type: "text", text: "Hi" }] },
            {
                info: { id: "msg-t1-compress", role: "assistant" } as any,
                parts: [
                    { type: "text", text: "Compressing" },
                    { type: "tool", tool: "compress", state: { status: "completed" } },
                ],
            },
            {
                info: { id: "msg-t2-compress", role: "assistant" } as any,
                parts: [{ type: "tool", tool: "compress", state: { status: "completed" } }],
            },
            { info: { id: "msg-user-2", role: "user" } as any, parts: [{ type: "text", text: "Next" }] },
        ]

        const hidden = hideConsumedCompressCalls(state, messages)

        assert.equal(hidden, 1)
        const t1Msg = messages.find((m) => m.info.id === "msg-t1-compress")!
        assert.equal(
            t1Msg.parts.filter((p: any) => p.type === "tool" && p.tool === "compress").length,
            0,
        )
    })

    it("hides T1 compress call even when it is AFTER lastUserIdx (same-turn T1+T2)", () => {
        const b1 = makeBlock({
            blockId: 1,
            active: false,
            deactivatedByBlockId: 4,
            compressMessageId: "msg-t1-compress",
            tier: 1,
        })
        const b4 = makeBlock({
            blockId: 4,
            active: true,
            compressMessageId: "msg-t2-compress",
            tier: 2,
        })

        const state = makeState([b1, b4])
        const messages: WithParts[] = [
            { info: { id: "msg-user-1", role: "user" } as any, parts: [{ type: "text", text: "Hi" }] },
            {
                info: { id: "msg-t1-compress", role: "assistant" } as any,
                parts: [{ type: "tool", tool: "compress", state: { status: "completed" } }],
            },
            {
                info: { id: "msg-t2-compress", role: "assistant" } as any,
                parts: [{ type: "tool", tool: "compress", state: { status: "completed" } }],
            },
        ]

        const hidden = hideConsumedCompressCalls(state, messages)

        assert.equal(hidden, 1, "T1 compress call after lastUserIdx should be hidden")
        assert.equal(
            messages.find((m) => m.info.id === "msg-t1-compress"),
            undefined,
            "T1-only-compress message should be entirely removed",
        )
        assert.ok(
            messages.find((m) => m.info.id === "msg-t2-compress"),
            "T2 compress call (active block) should survive",
        )
    })

    it("does NOT hide T1 compress call when T1 is still active", () => {
        const b1 = makeBlock({
            blockId: 1,
            active: true,
            compressMessageId: "msg-t1-compress",
            tier: 1,
        })

        const state = makeState([b1])
        const messages: WithParts[] = [
            { info: { id: "msg-user-1", role: "user" } as any, parts: [{ type: "text", text: "Hi" }] },
            {
                info: { id: "msg-t1-compress", role: "assistant" } as any,
                parts: [{ type: "tool", tool: "compress", state: { status: "completed" } }],
            },
            { info: { id: "msg-user-2", role: "user" } as any, parts: [{ type: "text", text: "Next" }] },
        ]

        const hidden = hideConsumedCompressCalls(state, messages)

        assert.equal(hidden, 0)
        assert.ok(messages.find((m) => m.info.id === "msg-t1-compress"))
    })

    it("preserves non-compress parts when hiding compress call", () => {
        const b1 = makeBlock({
            blockId: 1,
            active: false,
            deactivatedByBlockId: 4,
            compressMessageId: "msg-t1-compress",
            tier: 1,
        })
        const b4 = makeBlock({
            blockId: 4,
            active: true,
            compressMessageId: "msg-t2-compress",
            tier: 2,
        })

        const state = makeState([b1, b4])
        const messages: WithParts[] = [
            { info: { id: "msg-user-1", role: "user" } as any, parts: [{ type: "text", text: "Hi" }] },
            {
                info: { id: "msg-t1-compress", role: "assistant" } as any,
                parts: [
                    { type: "text", text: "Let me compress" },
                    { type: "tool", tool: "compress", state: { status: "completed" } },
                    { type: "tool", tool: "bash", state: { status: "completed" } },
                ],
            },
            { info: { id: "msg-user-2", role: "user" } as any, parts: [{ type: "text", text: "Next" }] },
        ]

        const hidden = hideConsumedCompressCalls(state, messages)

        assert.equal(hidden, 1)
        const t1Msg = messages.find((m) => m.info.id === "msg-t1-compress")!
        assert.equal(t1Msg.parts.length, 2, "text and bash parts should survive")
        assert.equal(
            t1Msg.parts.filter((p: any) => p.type === "tool" && p.tool === "compress").length,
            0,
        )
    })

    it("splices message when only reasoning + step-finish remain after compress removal", () => {
        const b1 = makeBlock({
            blockId: 1,
            active: false,
            deactivatedByBlockId: 4,
            compressMessageId: "msg-t1-compress",
            tier: 1,
        })
        const b4 = makeBlock({
            blockId: 4,
            active: true,
            compressMessageId: "msg-t2-compress",
            tier: 2,
        })

        const state = makeState([b1, b4])
        const messages: WithParts[] = [
            { info: { id: "msg-user-1", role: "user" } as any, parts: [{ type: "text", text: "Hi" }] },
            {
                info: { id: "msg-t1-compress", role: "assistant" } as any,
                parts: [
                    { type: "reasoning", text: "I need to compress the early messages..." },
                    { type: "tool", tool: "compress", state: { status: "completed" } },
                    { type: "step-finish", reason: "stop" },
                ],
            },
            { info: { id: "msg-user-2", role: "user" } as any, parts: [{ type: "text", text: "Next" }] },
        ]

        const hidden = hideConsumedCompressCalls(state, messages)

        assert.equal(hidden, 1)
        assert.equal(
            messages.find((m) => m.info.id === "msg-t1-compress"),
            undefined,
            "structural-only orphan should be spliced entirely",
        )
    })

    it("splices message when only reasoning remains after compress removal", () => {
        const b1 = makeBlock({
            blockId: 1,
            active: false,
            deactivatedByBlockId: 4,
            compressMessageId: "msg-t1-compress",
            tier: 1,
        })
        const b4 = makeBlock({
            blockId: 4,
            active: true,
            compressMessageId: "msg-t2-compress",
            tier: 2,
        })

        const state = makeState([b1, b4])
        const messages: WithParts[] = [
            { info: { id: "msg-user-1", role: "user" } as any, parts: [{ type: "text", text: "Hi" }] },
            {
                info: { id: "msg-t1-compress", role: "assistant" } as any,
                parts: [
                    { type: "reasoning", text: "Analyzing context usage..." },
                    { type: "tool", tool: "compress", state: { status: "completed" } },
                ],
            },
            { info: { id: "msg-user-2", role: "user" } as any, parts: [{ type: "text", text: "Next" }] },
        ]

        const hidden = hideConsumedCompressCalls(state, messages)

        assert.equal(hidden, 1)
        assert.equal(
            messages.find((m) => m.info.id === "msg-t1-compress"),
            undefined,
            "reasoning-only orphan should be spliced entirely",
        )
    })

    it("preserves message when text accompanies reasoning after compress removal", () => {
        const b1 = makeBlock({
            blockId: 1,
            active: false,
            deactivatedByBlockId: 4,
            compressMessageId: "msg-t1-compress",
            tier: 1,
        })
        const b4 = makeBlock({
            blockId: 4,
            active: true,
            compressMessageId: "msg-t2-compress",
            tier: 2,
        })

        const state = makeState([b1, b4])
        const messages: WithParts[] = [
            { info: { id: "msg-user-1", role: "user" } as any, parts: [{ type: "text", text: "Hi" }] },
            {
                info: { id: "msg-t1-compress", role: "assistant" } as any,
                parts: [
                    { type: "reasoning", text: "I need to compress..." },
                    { type: "text", text: "Compressing early messages" },
                    { type: "tool", tool: "compress", state: { status: "completed" } },
                    { type: "step-finish", reason: "stop" },
                ],
            },
            { info: { id: "msg-user-2", role: "user" } as any, parts: [{ type: "text", text: "Next" }] },
        ]

        const hidden = hideConsumedCompressCalls(state, messages)

        assert.equal(hidden, 1)
        const t1Msg = messages.find((m) => m.info.id === "msg-t1-compress")!
        assert.ok(t1Msg, "message with text should survive")
        assert.equal(t1Msg.parts.length, 3, "reasoning + text + step-finish remain")
        assert.equal(
            t1Msg.parts.filter((p: any) => p.type === "tool" && p.tool === "compress").length,
            0,
        )
    })

    it("preserves message when non-compress tool accompanies structural parts", () => {
        const b1 = makeBlock({
            blockId: 1,
            active: false,
            deactivatedByBlockId: 4,
            compressMessageId: "msg-t1-compress",
            tier: 1,
        })
        const b4 = makeBlock({
            blockId: 4,
            active: true,
            compressMessageId: "msg-t2-compress",
            tier: 2,
        })

        const state = makeState([b1, b4])
        const messages: WithParts[] = [
            { info: { id: "msg-user-1", role: "user" } as any, parts: [{ type: "text", text: "Hi" }] },
            {
                info: { id: "msg-t1-compress", role: "assistant" } as any,
                parts: [
                    { type: "reasoning", text: "I need to compress..." },
                    { type: "tool", tool: "compress", state: { status: "completed" } },
                    { type: "tool", tool: "bash", state: { status: "completed" } },
                    { type: "step-finish", reason: "stop" },
                ],
            },
            { info: { id: "msg-user-2", role: "user" } as any, parts: [{ type: "text", text: "Next" }] },
        ]

        const hidden = hideConsumedCompressCalls(state, messages)

        assert.equal(hidden, 1)
        const t1Msg = messages.find((m) => m.info.id === "msg-t1-compress")!
        assert.ok(t1Msg, "message with bash tool should survive")
        assert.equal(
            t1Msg.parts.filter((p: any) => p.type === "tool" && p.tool === "compress").length,
            0,
        )
    })

    it("splices message when only step-start + step-finish remain after compress removal", () => {
        const b1 = makeBlock({
            blockId: 1,
            active: false,
            deactivatedByBlockId: 4,
            compressMessageId: "msg-t1-compress",
            tier: 1,
        })
        const b4 = makeBlock({
            blockId: 4,
            active: true,
            compressMessageId: "msg-t2-compress",
            tier: 2,
        })

        const state = makeState([b1, b4])
        const messages: WithParts[] = [
            { info: { id: "msg-user-1", role: "user" } as any, parts: [{ type: "text", text: "Hi" }] },
            {
                info: { id: "msg-t1-compress", role: "assistant" } as any,
                parts: [
                    { type: "step-start" },
                    { type: "tool", tool: "compress", state: { status: "completed" } },
                    { type: "step-finish", reason: "stop" },
                ],
            },
            { info: { id: "msg-user-2", role: "user" } as any, parts: [{ type: "text", text: "Next" }] },
        ]

        const hidden = hideConsumedCompressCalls(state, messages)

        assert.equal(hidden, 1)
        assert.equal(
            messages.find((m) => m.info.id === "msg-t1-compress"),
            undefined,
            "step-start + step-finish orphan should be spliced",
        )
    })
})
