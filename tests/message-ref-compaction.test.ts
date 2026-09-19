import assert from "node:assert/strict"
import test from "node:test"
import { assignMessageRefs, repairNonMonotonicMessageRefs } from "../lib/message-ids"
import { createSessionState, type WithParts } from "../lib/state"
import { resetOnCompaction } from "../lib/state/utils"

function message(id: string, created: number): WithParts {
    return {
        info: { id, role: "assistant", sessionID: "ses-ref-repair", time: { created } } as any,
        parts: [{ type: "text", text: id }] as any,
    }
}

test("native compaction preserves the message-ref high-water mark", () => {
    const state = createSessionState()
    assignMessageRefs(state, [message("old-1", 1), message("old-2", 2)])

    resetOnCompaction(state)
    assignMessageRefs(state, [message("old-1", 1), message("old-2", 2), message("new-3", 3)])

    assert.equal(state.messageIds.byRawId.get("new-3"), "m00003")
    assert.equal(state.messageIds.nextRef, 4)
})

test("legacy mixed alias epochs are repaired in chronological order", () => {
    const state = createSessionState()
    const messages = [
        message("hidden-0", 0),
        message("old-1", 1),
        message("old-2", 2),
        message("new-3", 3),
    ]
    state.messageIds.byRawId = new Map([
        ["hidden-0", "m02077"],
        ["old-1", "m02078"],
        ["old-2", "m02079"],
        ["new-3", "m00003"],
    ])
    state.messageIds.byRef = new Map([
        ["m02077", "hidden-0"],
        ["m02078", "old-1"],
        ["m02079", "old-2"],
        ["m00003", "new-3"],
    ])
    state.messageIds.nextRef = 4
    state.prune.messages.blocksById.set(1, {
        blockId: 1,
        active: true,
        startId: "m02078",
        endId: "m00003",
        directMessageIds: ["hidden-0", "old-1", "new-3"],
        effectiveMessageIds: ["hidden-0", "old-1", "new-3"],
    } as any)

    assert.equal(repairNonMonotonicMessageRefs(state, messages), true)
    assert.deepEqual(
        messages.map((item) => state.messageIds.byRawId.get(item.info.id)),
        ["m00001", "m00002", "m00003", "m00004"],
    )
    const block = state.prune.messages.blocksById.get(1)!
    assert.equal(block.startId, "m00001")
    assert.equal(block.endId, "m00004")
    assert.equal(state.messageIds.byRawId.get("hidden-0"), "m00001")
    assert.equal(state.messageIds.nextRef, 5)
})
