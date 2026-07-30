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
})
