import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createSessionState } from "../lib/state"
import type { WithParts, SessionState } from "../lib/state"
import { assignMessageRefs } from "../lib/message-ids"
import { buildStatusReport } from "../lib/compress/status"
import { hideConsumedCompressCalls } from "../lib/compress/hide-consumed"

const SID = "ses-consumed-status"

function makeMsg(
    id: string,
    role: "user" | "assistant",
    text: string,
    toolParts: unknown[] = [],
): WithParts {
    const parts: unknown[] = []
    if (text) parts.push({ type: "text", text })
    for (const tp of toolParts) parts.push(tp)
    return {
        info: { id, role, sessionID: SID, agent: "a", time: { created: 1 } } as never,
        parts,
    } as WithParts
}

function compressToolPart(callID: string, summary: string, input?: unknown): unknown {
    return {
        type: "tool",
        callID,
        tool: "compress",
        state: { status: "completed", input: input ?? { content: [{ summary }] } },
    }
}

function setupRefs(state: SessionState, messages: WithParts[]): void {
    assignMessageRefs(state, messages)
}

describe("acp_status consumed-compress fix", () => {
    it("consumed compress calls not shown as PROTECTED after hideConsumedCompressCalls", () => {
        const state = createSessionState()
        const messages = [
            makeMsg("msg-1", "user", "hello"),
            makeMsg("msg-2", "assistant", "response", [compressToolPart("c-old", "old summary text")]),
            makeMsg("msg-3", "assistant", "normal text"),
            makeMsg("msg-4", "assistant", "active compress", [compressToolPart("c-active", "active summary")]),
        ]
        setupRefs(state, messages)

        const blocksById = new Map()
        blocksById.set(1, {
            blockId: 1,
            runId: 1,
            active: false,
            deactivatedByUser: false,
            deactivatedByUserDeep: false,
            deactivatedByBlockId: 2,
            compressMessageId: "msg-2",
            compressCallId: "c-old",
            tier: 1,
        })
        blocksById.set(2, {
            blockId: 2,
            runId: 2,
            active: true,
            deactivatedByUser: false,
            deactivatedByUserDeep: false,
            compressMessageId: "msg-4",
            compressCallId: "c-active",
            tier: 2,
        })
        const activeBlockIds = new Set([2])
        state.prune = {
            messages: { blocksById, activeBlockIds, byMessageId: new Map(), activeByAnchorMessageId: new Map() },
        } as never

        const beforeFix = buildStatusReport(
            { state, config: { compress: { protectedTools: ["skill", "compress"] } } } as never,
            messages,
            { scope: "uncompressed" },
        )
        assert.ok(
            beforeFix.includes("PROTECTED"),
            "before fix: consumed compress should appear as PROTECTED",
        )

        hideConsumedCompressCalls(state, messages)
        const afterFix = buildStatusReport(
            { state, config: { compress: { protectedTools: ["skill", "compress"] } } } as never,
            messages,
            { scope: "uncompressed" },
        )
        assert.ok(
            afterFix.includes("PROTECTED"),
            "active compress should still be PROTECTED",
        )
        assert.ok(
            !afterFix.includes("old summary text"),
            "after fix: consumed compress summary should not appear in status output",
        )
    })

    it("active compress calls still shown as PROTECTED", () => {
        const state = createSessionState()
        const messages = [
            makeMsg("msg-1", "user", "hello"),
            makeMsg("msg-2", "assistant", "work"),
            makeMsg("msg-3", "assistant", "active compress", [compressToolPart("c-active", "my active summary")]),
        ]
        setupRefs(state, messages)

        const blocksById = new Map()
        blocksById.set(1, {
            blockId: 1,
            runId: 1,
            active: true,
            deactivatedByUser: false,
            deactivatedByUserDeep: false,
            compressMessageId: "msg-3",
            compressCallId: "c-active",
            tier: 1,
        })
        state.prune = {
            messages: { blocksById, activeBlockIds: new Set([1]), byMessageId: new Map(), activeByAnchorMessageId: new Map() },
        } as never

        hideConsumedCompressCalls(state, messages)
        const report = buildStatusReport(
            { state, config: { compress: { protectedTools: ["skill", "compress"] } } } as never,
            messages,
            { scope: "uncompressed" },
        )
        assert.ok(report.includes("PROTECTED"), "active compress should still be PROTECTED")
    })
})
