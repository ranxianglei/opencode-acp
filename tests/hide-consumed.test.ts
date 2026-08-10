import { describe, it } from "node:test"
import assert from "node:assert/strict"
import type { WithParts, SessionState } from "../lib/state"
import { hideConsumedCompressCalls } from "../lib/compress/hide-consumed"
import type { CompressionBlock } from "../lib/state/types"

function makeBlock(overrides: Partial<CompressionBlock> & { blockId: number }): CompressionBlock {
    return {
        blockId: overrides.blockId,
        runId: overrides.runId ?? 1,
        displayId: overrides.displayId ?? `b${overrides.blockId}`,
        active: overrides.active ?? true,
        tier: overrides.tier ?? 1,
        topic: overrides.topic ?? "test",
        summary: overrides.summary ?? "test summary",
        compressMessageId: overrides.compressMessageId ?? "",
        compressCallId: overrides.compressCallId ?? "",
        directMessageIds: overrides.directMessageIds ?? [],
        effectiveMessageIds: overrides.effectiveMessageIds ?? [],
        generation: overrides.generation ?? "young",
        survivedCount: overrides.survivedCount ?? 0,
        createdAt: overrides.createdAt ?? Date.now(),
        compressedTokens: overrides.compressedTokens ?? 100,
        summaryLength: overrides.summaryLength ?? 20,
        deactivatedByBlockId: overrides.deactivatedByBlockId,
        deactivatedByUser: overrides.deactivatedByUser,
        deactivatedByUserDeep: overrides.deactivatedByUserDeep,
        consumedBlockIds: overrides.consumedBlockIds,
        ...overrides,
    } as CompressionBlock
}

function makeState(blocks: CompressionBlock[]): Pick<SessionState, "prune"> {
    const blocksById = new Map<number, CompressionBlock>()
    for (const b of blocks) blocksById.set(b.blockId, b)
    return {
        prune: {
            messages: {
                blocksById,
                byMessageId: new Map(),
                activeBlockIds: blocks.filter((b) => b.active).map((b) => b.blockId),
            },
        },
    } as any
}

describe("hideConsumedCompressCalls", () => {
    it("hides consumed T1 compress call when T2 consumes it (previous turn)", () => {
        const b1 = makeBlock({
            blockId: 1,
            active: false,
            deactivatedByBlockId: 4,
            compressMessageId: "msg-t1-compress",
            compressCallId: "call-t1",
            tier: 1,
        })
        const b4 = makeBlock({
            blockId: 4,
            active: true,
            compressMessageId: "msg-t2-compress",
            compressCallId: "call-t4",
            tier: 2,
        })

        const state = makeState([b1, b4])
        const messages: WithParts[] = [
            { info: { id: "msg-user-1", role: "user" } as any, parts: [{ type: "text", text: "Hi" }] },
            {
                info: { id: "msg-t1-compress", role: "assistant" } as any,
                parts: [
                    { type: "text", text: "Compressing" },
                    { type: "tool", tool: "compress", callID: "call-t1", state: { status: "completed" } },
                ],
            },
            {
                info: { id: "msg-t2-compress", role: "assistant" } as any,
                parts: [{ type: "tool", tool: "compress", callID: "call-t4", state: { status: "completed" } }],
            },
            { info: { id: "msg-user-2", role: "user" } as any, parts: [{ type: "text", text: "Next" }] },
        ]

        const hidden = hideConsumedCompressCalls(state as SessionState, messages)

        assert.equal(hidden, 1)
        const t1Msg = messages.find((m) => m.info.id === "msg-t1-compress")!
        assert.equal(
            t1Msg.parts.filter((p: any) => p.type === "tool" && p.tool === "compress").length,
            0,
        )
    })

    it("hides consumed T1 compress call even when it is AFTER lastUserIdx (same-turn T1+T2)", () => {
        const b1 = makeBlock({
            blockId: 1,
            active: false,
            deactivatedByBlockId: 4,
            compressMessageId: "msg-t1-compress",
            compressCallId: "call-t1",
            tier: 1,
        })
        const b4 = makeBlock({
            blockId: 4,
            active: true,
            compressMessageId: "msg-t2-compress",
            compressCallId: "call-t4",
            tier: 2,
        })

        const state = makeState([b1, b4])
        const messages: WithParts[] = [
            { info: { id: "msg-user-1", role: "user" } as any, parts: [{ type: "text", text: "Hi" }] },
            {
                info: { id: "msg-t1-compress", role: "assistant" } as any,
                parts: [{ type: "tool", tool: "compress", callID: "call-t1", state: { status: "completed" } }],
            },
            {
                info: { id: "msg-t2-compress", role: "assistant" } as any,
                parts: [{ type: "tool", tool: "compress", callID: "call-t4", state: { status: "completed" } }],
            },
        ]

        const hidden = hideConsumedCompressCalls(state as SessionState, messages)

        assert.equal(hidden, 1, "consumed T1 compress call should be hidden")
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

    it("does NOT hide active T1 compress call", () => {
        const b1 = makeBlock({
            blockId: 1,
            active: true,
            compressMessageId: "msg-t1-compress",
            compressCallId: "call-t1",
            tier: 1,
        })

        const state = makeState([b1])
        const messages: WithParts[] = [
            { info: { id: "msg-user-1", role: "user" } as any, parts: [{ type: "text", text: "Hi" }] },
            {
                info: { id: "msg-t1-compress", role: "assistant" } as any,
                parts: [{ type: "tool", tool: "compress", callID: "call-t1", state: { status: "completed" } }],
            },
            { info: { id: "msg-user-2", role: "user" } as any, parts: [{ type: "text", text: "Next" }] },
        ]

        const hidden = hideConsumedCompressCalls(state as SessionState, messages)

        assert.equal(hidden, 0)
        assert.ok(messages.find((m) => m.info.id === "msg-t1-compress"))
    })

    it("preserves non-compress parts when hiding consumed compress call", () => {
        const b1 = makeBlock({
            blockId: 1,
            active: false,
            deactivatedByBlockId: 4,
            compressMessageId: "msg-t1-compress",
            compressCallId: "call-t1",
            tier: 1,
        })
        const b4 = makeBlock({
            blockId: 4,
            active: true,
            compressMessageId: "msg-t2-compress",
            compressCallId: "call-t4",
            tier: 2,
        })

        const state = makeState([b1, b4])
        const messages: WithParts[] = [
            { info: { id: "msg-user-1", role: "user" } as any, parts: [{ type: "text", text: "Hi" }] },
            {
                info: { id: "msg-t1-compress", role: "assistant" } as any,
                parts: [
                    { type: "text", text: "Let me compress" },
                    { type: "tool", tool: "compress", callID: "call-t1", state: { status: "completed" } },
                    { type: "tool", tool: "bash", state: { status: "completed" } },
                ],
            },
            { info: { id: "msg-user-2", role: "user" } as any, parts: [{ type: "text", text: "Next" }] },
        ]

        const hidden = hideConsumedCompressCalls(state as SessionState, messages)

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
            compressCallId: "call-t1",
            tier: 1,
        })
        const b4 = makeBlock({
            blockId: 4,
            active: true,
            compressMessageId: "msg-t2-compress",
            compressCallId: "call-t4",
            tier: 2,
        })

        const state = makeState([b1, b4])
        const messages: WithParts[] = [
            { info: { id: "msg-user-1", role: "user" } as any, parts: [{ type: "text", text: "Hi" }] },
            {
                info: { id: "msg-t1-compress", role: "assistant" } as any,
                parts: [
                    { type: "reasoning", text: "I need to compress the early messages..." },
                    { type: "tool", tool: "compress", callID: "call-t1", state: { status: "completed" } },
                    { type: "step-finish", reason: "stop" },
                ],
            },
            { info: { id: "msg-user-2", role: "user" } as any, parts: [{ type: "text", text: "Next" }] },
        ]

        const hidden = hideConsumedCompressCalls(state as SessionState, messages)

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
            compressCallId: "call-t1",
            tier: 1,
        })
        const b4 = makeBlock({
            blockId: 4,
            active: true,
            compressMessageId: "msg-t2-compress",
            compressCallId: "call-t4",
            tier: 2,
        })

        const state = makeState([b1, b4])
        const messages: WithParts[] = [
            { info: { id: "msg-user-1", role: "user" } as any, parts: [{ type: "text", text: "Hi" }] },
            {
                info: { id: "msg-t1-compress", role: "assistant" } as any,
                parts: [
                    { type: "reasoning", text: "Analyzing context usage..." },
                    { type: "tool", tool: "compress", callID: "call-t1", state: { status: "completed" } },
                ],
            },
            { info: { id: "msg-user-2", role: "user" } as any, parts: [{ type: "text", text: "Next" }] },
        ]

        const hidden = hideConsumedCompressCalls(state as SessionState, messages)

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
            compressCallId: "call-t1",
            tier: 1,
        })
        const b4 = makeBlock({
            blockId: 4,
            active: true,
            compressMessageId: "msg-t2-compress",
            compressCallId: "call-t4",
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
                    { type: "tool", tool: "compress", callID: "call-t1", state: { status: "completed" } },
                    { type: "step-finish", reason: "stop" },
                ],
            },
            { info: { id: "msg-user-2", role: "user" } as any, parts: [{ type: "text", text: "Next" }] },
        ]

        const hidden = hideConsumedCompressCalls(state as SessionState, messages)

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
            compressCallId: "call-t1",
            tier: 1,
        })
        const b4 = makeBlock({
            blockId: 4,
            active: true,
            compressMessageId: "msg-t2-compress",
            compressCallId: "call-t4",
            tier: 2,
        })

        const state = makeState([b1, b4])
        const messages: WithParts[] = [
            { info: { id: "msg-user-1", role: "user" } as any, parts: [{ type: "text", text: "Hi" }] },
            {
                info: { id: "msg-t1-compress", role: "assistant" } as any,
                parts: [
                    { type: "reasoning", text: "I need to compress..." },
                    { type: "tool", tool: "compress", callID: "call-t1", state: { status: "completed" } },
                    { type: "tool", tool: "bash", state: { status: "completed" } },
                    { type: "step-finish", reason: "stop" },
                ],
            },
            { info: { id: "msg-user-2", role: "user" } as any, parts: [{ type: "text", text: "Next" }] },
        ]

        const hidden = hideConsumedCompressCalls(state as SessionState, messages)

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
            compressCallId: "call-t1",
            tier: 1,
        })
        const b4 = makeBlock({
            blockId: 4,
            active: true,
            compressMessageId: "msg-t2-compress",
            compressCallId: "call-t4",
            tier: 2,
        })

        const state = makeState([b1, b4])
        const messages: WithParts[] = [
            { info: { id: "msg-user-1", role: "user" } as any, parts: [{ type: "text", text: "Hi" }] },
            {
                info: { id: "msg-t1-compress", role: "assistant" } as any,
                parts: [
                    { type: "step-start" },
                    { type: "tool", tool: "compress", callID: "call-t1", state: { status: "completed" } },
                    { type: "step-finish", reason: "stop" },
                ],
            },
            { info: { id: "msg-user-2", role: "user" } as any, parts: [{ type: "text", text: "Next" }] },
        ]

        const hidden = hideConsumedCompressCalls(state as SessionState, messages)

        assert.equal(hidden, 1)
        assert.equal(
            messages.find((m) => m.info.id === "msg-t1-compress"),
            undefined,
            "step-start + step-finish orphan should be spliced",
        )
    })

    it("keeps last 2 orphaned (failed) compress calls, hides older ones", () => {
        const b1 = makeBlock({
            blockId: 1,
            active: true,
            compressMessageId: "msg-good-compress",
            compressCallId: "call-good",
            tier: 1,
        })

        const state = makeState([b1])
        const messages: WithParts[] = [
            { info: { id: "msg-user-1", role: "user" } as any, parts: [{ type: "text", text: "Hi" }] },
            {
                info: { id: "msg-fail-1", role: "assistant" } as any,
                parts: [
                    { type: "text", text: "Trying compress..." },
                    { type: "tool", tool: "compress", callID: "call-fail-1", state: { status: "error" } },
                ],
            },
            {
                info: { id: "msg-fail-2", role: "assistant" } as any,
                parts: [
                    { type: "text", text: "Retry..." },
                    { type: "tool", tool: "compress", callID: "call-fail-2", state: { status: "error" } },
                ],
            },
            {
                info: { id: "msg-fail-3", role: "assistant" } as any,
                parts: [
                    { type: "text", text: "Retry..." },
                    { type: "tool", tool: "compress", callID: "call-fail-3", state: { status: "error" } },
                ],
            },
            {
                info: { id: "msg-good-compress", role: "assistant" } as any,
                parts: [{ type: "tool", tool: "compress", callID: "call-good", state: { status: "completed" } }],
            },
            { info: { id: "msg-user-2", role: "user" } as any, parts: [{ type: "text", text: "Next" }] },
        ]

        const hidden = hideConsumedCompressCalls(state as SessionState, messages)

        assert.equal(hidden, 1)
        const fail1Msg = messages.find((m) => m.info.id === "msg-fail-1")!
        assert.ok(fail1Msg, "message with text survives")
        assert.equal(
            fail1Msg.parts.filter((p: any) => p.type === "tool" && p.tool === "compress").length,
            0,
            "oldest orphaned compress part removed",
        )
        assert.ok(messages.find((m) => m.info.id === "msg-fail-2"), "2nd-last orphaned kept")
        assert.ok(messages.find((m) => m.info.id === "msg-fail-3"), "last orphaned kept")
        assert.ok(messages.find((m) => m.info.id === "msg-good-compress"), "active block kept")
    })

    it("hides all orphaned compress calls beyond the last 2", () => {
        const state = makeState([])
        const messages: WithParts[] = [
            { info: { id: "msg-user-1", role: "user" } as any, parts: [{ type: "text", text: "Hi" }] },
            ...Array.from({ length: 5 }, (_, i) => ({
                info: { id: `msg-fail-${i}`, role: "assistant" } as any,
                parts: [
                    { type: "tool", tool: "compress", callID: `call-fail-${i}`, state: { status: "error" } },
                ],
            })),
            { info: { id: "msg-user-2", role: "user" } as any, parts: [{ type: "text", text: "Next" }] },
        ]

        const hidden = hideConsumedCompressCalls(state as SessionState, messages)

        assert.equal(hidden, 3, "5 orphaned - 2 kept = 3 hidden")
        assert.equal(messages.length, 4, "user + 2 kept + user = 4 messages")
    })

    it("batched compress: rewrites kept part to drop consumed sibling entries (issue #288)", () => {
        const b5 = makeBlock({
            blockId: 5,
            active: true,
            compressMessageId: "msg-batch",
            compressCallId: "call-batch",
            startId: "m5",
            endId: "m6",
            tier: 1,
        })
        const b8 = makeBlock({
            blockId: 8,
            active: false,
            deactivatedByBlockId: 9,
            compressMessageId: "msg-batch",
            compressCallId: "call-batch",
            startId: "m8",
            endId: "m9",
            tier: 1,
        })
        const b9 = makeBlock({
            blockId: 9,
            active: true,
            compressMessageId: "msg-t2",
            compressCallId: "call-t2",
            tier: 2,
        })

        const state = makeState([b5, b8, b9])
        const messages: WithParts[] = [
            { info: { id: "msg-user-1", role: "user" } as any, parts: [{ type: "text", text: "Hi" }] },
            {
                info: { id: "msg-batch", role: "assistant" } as any,
                parts: [
                    {
                        type: "tool",
                        tool: "compress",
                        callID: "call-batch",
                        state: {
                            status: "completed",
                            input: {
                                content: [
                                    { startId: "m5", endId: "m6", summary: "live entry summary" },
                                    { startId: "m8", endId: "m9", summary: "consumed entry summary" },
                                ],
                            },
                        },
                    },
                ],
            },
            {
                info: { id: "msg-t2", role: "assistant" } as any,
                parts: [{ type: "tool", tool: "compress", callID: "call-t2", state: { status: "completed" } }],
            },
        ]

        const hidden = hideConsumedCompressCalls(state as SessionState, messages)

        assert.equal(hidden, 0, "kept batch is not fully removed")
        const batchMsg = messages.find((m) => m.info.id === "msg-batch")!
        assert.ok(batchMsg, "batch tool-call message survives (one live sibling)")
        const part = batchMsg.parts.find((p: any) => p.type === "tool" && p.tool === "compress") as any
        assert.ok(part, "compress part kept")
        const content = part.state.input.content
        assert.equal(content.length, 1, "consumed entry dropped, live entry retained")
        assert.equal(content[0].startId, "m5", "retained entry is the live block's range")
        assert.equal(content[0].summary, "live entry summary")
    })

    it("batched compress: no rewrite when all sibling blocks are live", () => {
        const b5 = makeBlock({
            blockId: 5,
            active: true,
            compressMessageId: "msg-batch",
            compressCallId: "call-batch",
            startId: "m5",
            endId: "m6",
        })
        const b8 = makeBlock({
            blockId: 8,
            active: true,
            compressMessageId: "msg-batch",
            compressCallId: "call-batch",
            startId: "m8",
            endId: "m9",
        })

        const state = makeState([b5, b8])
        const messages: WithParts[] = [
            { info: { id: "msg-user-1", role: "user" } as any, parts: [{ type: "text", text: "Hi" }] },
            {
                info: { id: "msg-batch", role: "assistant" } as any,
                parts: [
                    {
                        type: "tool",
                        tool: "compress",
                        callID: "call-batch",
                        state: {
                            status: "completed",
                            input: {
                                content: [
                                    { startId: "m5", endId: "m6", summary: "S1" },
                                    { startId: "m8", endId: "m9", summary: "S2" },
                                ],
                            },
                        },
                    },
                ],
            },
        ]

        const hidden = hideConsumedCompressCalls(state as SessionState, messages)

        assert.equal(hidden, 0)
        const part = messages
            .find((m) => m.info.id === "msg-batch")!
            .parts.find((p: any) => p.type === "tool" && p.tool === "compress") as any
        assert.equal(part.state.input.content.length, 2, "both live entries retained, no rewrite")
    })

    it("batched compress: fully removed when all sibling blocks consumed", () => {
        const b5 = makeBlock({
            blockId: 5,
            active: false,
            deactivatedByBlockId: 9,
            compressMessageId: "msg-batch",
            compressCallId: "call-batch",
            startId: "m5",
            endId: "m6",
        })
        const b8 = makeBlock({
            blockId: 8,
            active: false,
            deactivatedByBlockId: 9,
            compressMessageId: "msg-batch",
            compressCallId: "call-batch",
            startId: "m8",
            endId: "m9",
        })
        const b9 = makeBlock({
            blockId: 9,
            active: true,
            compressMessageId: "msg-t2",
            compressCallId: "call-t2",
            tier: 2,
        })

        const state = makeState([b5, b8, b9])
        const messages: WithParts[] = [
            { info: { id: "msg-user-1", role: "user" } as any, parts: [{ type: "text", text: "Hi" }] },
            {
                info: { id: "msg-batch", role: "assistant" } as any,
                parts: [
                    { type: "text", text: "Batching" },
                    {
                        type: "tool",
                        tool: "compress",
                        callID: "call-batch",
                        state: {
                            status: "completed",
                            input: {
                                content: [
                                    { startId: "m5", endId: "m6", summary: "S1" },
                                    { startId: "m8", endId: "m9", summary: "S2" },
                                ],
                            },
                        },
                    },
                ],
            },
        ]

        const hidden = hideConsumedCompressCalls(state as SessionState, messages)

        assert.equal(hidden, 1, "fully-consumed batch dropped")
        const batchMsg = messages.find((m) => m.info.id === "msg-batch")!
        assert.ok(batchMsg, "message survives via text part")
        assert.equal(
            batchMsg.parts.filter((p: any) => p.type === "tool" && p.tool === "compress").length,
            0,
            "no compress part remains",
        )
    })
})
