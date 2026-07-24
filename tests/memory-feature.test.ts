import assert from "node:assert/strict"
import test from "node:test"
import {
    recordMemory,
    forgetMemory,
    listMemories,
    getForgottenMemoryMessageIds,
    formatMemoryId,
} from "../lib/memory/state"
import { filterProtectedToolMessages } from "../lib/compress/protected-content"
import { SYSTEM } from "../lib/prompts/system"
import { createSessionState } from "../lib/state/state"
import type { SessionState, WithParts } from "../lib/state/types"
import type { SelectionResolution, SearchContext } from "../lib/compress/types"
import type { Logger } from "../lib/logger"

const mockLogger: Logger = { debug: () => {}, warn: () => {}, info: () => {} } as any

function makeState(): SessionState {
    return createSessionState()
}

test("formatMemoryId pads to 3 digits", () => {
    assert.equal(formatMemoryId(1), "mem_001")
    assert.equal(formatMemoryId(7), "mem_007")
    assert.equal(formatMemoryId(42), "mem_042")
    assert.equal(formatMemoryId(100), "mem_100")
    assert.equal(formatMemoryId(1000), "mem_1000")
})

test("recordMemory creates entry with sequential id and increments nextId", () => {
    const state = makeState()
    const e1 = recordMemory(state, "msg_a", "constraint", mockLogger)
    assert.equal(e1.id, "mem_001")
    assert.equal(e1.topic, "constraint")
    assert.equal(e1.messageId, "msg_a")
    assert.equal(e1.forgotten, false)
    assert.equal(state.memories.nextId, 2)

    const e2 = recordMemory(state, "msg_b", "decision", mockLogger)
    assert.equal(e2.id, "mem_002")
    assert.equal(e2.messageId, "msg_b")
    assert.equal(state.memories.nextId, 3)
})

test("recordMemory stores entry retrievable from state.memories.entries", () => {
    const state = makeState()
    const entry = recordMemory(state, "msg_x", "goal", mockLogger)
    const stored = state.memories.entries.get("mem_001")
    assert.ok(stored)
    assert.equal(stored!.id, entry.id)
    assert.equal(stored!.messageId, "msg_x")
})

test("forgetMemory returns false for unknown id", () => {
    const state = makeState()
    assert.equal(forgetMemory(state, "mem_999"), false)
})

test("forgetMemory marks entry forgotten and returns true", () => {
    const state = makeState()
    recordMemory(state, "msg_a", "topic", mockLogger)
    assert.equal(forgetMemory(state, "mem_001"), true)
    const entry = state.memories.entries.get("mem_001")
    assert.ok(entry)
    assert.equal(entry!.forgotten, true)
})

test("listMemories returns entries sorted by createdAt ascending", () => {
    const state = makeState()
    recordMemory(state, "msg_a", "first", mockLogger)
    recordMemory(state, "msg_b", "second", mockLogger)
    const list = listMemories(state)
    assert.equal(list.length, 2)
    assert.equal(list[0]!.topic, "first")
    assert.equal(list[1]!.topic, "second")
})

test("getForgottenMemoryMessageIds returns messageIds of forgotten entries only", () => {
    const state = makeState()
    recordMemory(state, "msg_active", "topic", mockLogger)
    recordMemory(state, "msg_forgotten", "topic2", mockLogger)
    forgetMemory(state, "mem_002")
    const ids = getForgottenMemoryMessageIds(state)
    assert.equal(ids.size, 1)
    assert.ok(ids.has("msg_forgotten"))
    assert.ok(!ids.has("msg_active"))
})

test("getForgottenMemoryMessageIds is defensive when state.memories is undefined", () => {
    const state = makeState()
    ;(state as any).memories = undefined
    const ids = getForgottenMemoryMessageIds(state)
    assert.equal(ids.size, 0)
})

function makeToolMessage(id: string, toolName: string, callID: string): WithParts {
    return {
        info: { id, role: "assistant", sessionID: "s1", time: 0 } as any,
        parts: [{ type: "tool", tool: toolName, callID, state: {} } as any],
    }
}

function makeSelection(messageIds: string[]): SelectionResolution {
    return {
        startReference: { kind: "message", rawIndex: 0 },
        endReference: { kind: "message", rawIndex: 0 },
        messageIds,
        messageTokenById: new Map(messageIds.map((id) => [id, 100])),
        toolIds: [],
        requiredBlockIds: [],
    }
}

function makeSearchContext(messages: WithParts[]): SearchContext {
    const map = new Map<string, WithParts>()
    const idx = new Map<string, number>()
    messages.forEach((m, i) => {
        map.set(m.info.id, m)
        idx.set(m.info.id, i)
    })
    return {
        rawMessages: messages,
        rawMessagesById: map,
        rawIndexById: idx,
        summaryByBlockId: new Map(),
    }
}

test("filterProtectedToolMessages excludes memory tool messages from selection", () => {
    const memMsg = makeToolMessage("m1", "memory", "call_1")
    const plainMsg = makeToolMessage("m2", "bash", "call_2")
    const search = makeSearchContext([memMsg, plainMsg])
    const sel = makeSelection(["m1", "m2"])
    const result = filterProtectedToolMessages(sel, search, ["memory"])
    assert.deepEqual(result.messageIds, ["m2"])
})

test("filterProtectedToolMessages keeps memory message when unprotectedMessageIds covers it", () => {
    const memMsg = makeToolMessage("m1", "memory", "call_1")
    const plainMsg = makeToolMessage("m2", "bash", "call_2")
    const search = makeSearchContext([memMsg, plainMsg])
    const sel = makeSelection(["m1", "m2"])
    const result = filterProtectedToolMessages(
        sel,
        search,
        ["memory"],
        [],
        new Set(["m1"]),
    )
    assert.deepEqual(result.messageIds, ["m1", "m2"])
})

test("filterProtectedToolMessages unprotects only forgotten memory messages", () => {
    const forgotten = makeToolMessage("m1", "memory", "call_1")
    const active = makeToolMessage("m3", "memory", "call_3")
    const plain = makeToolMessage("m2", "bash", "call_2")
    const search = makeSearchContext([forgotten, plain, active])
    const sel = makeSelection(["m1", "m2", "m3"])
    const result = filterProtectedToolMessages(
        sel,
        search,
        ["memory"],
        [],
        new Set(["m1"]),
    )
    assert.ok(result.messageIds.includes("m1"))
    assert.ok(result.messageIds.includes("m2"))
    assert.ok(!result.messageIds.includes("m3"))
})

test("SYSTEM prompt includes MEMORY section from cc-alg MEMORY_GUIDELINES", () => {
    assert.ok(SYSTEM.includes("MEMORY"), "system prompt should mention MEMORY")
    assert.ok(
        SYSTEM.includes("memory"),
        "system prompt should reference the memory tool",
    )
    assert.ok(
        SYSTEM.includes("record"),
        "system prompt should guide recording memories",
    )
})

test("SYSTEM prompt lists memory tool in TOOLS section", () => {
    assert.ok(
        SYSTEM.includes("`memory`"),
        "system prompt should list the memory tool in backticks",
    )
})

test("SYSTEM prompt marks memory as protected in WHEN NOT TO COMPRESS", () => {
    assert.ok(
        SYSTEM.includes("skill` and `memory"),
        "WHEN NOT TO COMPRESS should list memory as protected alongside skill",
    )
})

test("SYSTEM prompt lists six context-management tools", () => {
    assert.ok(
        SYSTEM.includes("six context-management tools"),
        "tool count should be six now that memory is added",
    )
})

test("integration: record → filterProtectedToolMessages → active memory survives", () => {
    const state = makeState()
    const memMsg = makeToolMessage("msg_mem", "memory", "call_mem")
    const plainMsg = makeToolMessage("msg_plain", "bash", "call_plain")
    const search = makeSearchContext([memMsg, plainMsg])

    recordMemory(state, "msg_mem", "constraint", mockLogger)

    const sel = makeSelection(["msg_mem", "msg_plain"])
    const forgotten = getForgottenMemoryMessageIds(state)
    assert.equal(forgotten.size, 0, "no forgotten memories yet")

    const result = filterProtectedToolMessages(sel, search, ["memory"], [], forgotten)
    assert.ok(
        !result.messageIds.includes("msg_mem"),
        "active memory message should survive (excluded from compress selection)",
    )
    assert.ok(
        result.messageIds.includes("msg_plain"),
        "non-protected message should remain compressible",
    )
})

test("integration: forget → filterProtectedToolMessages → forgotten memory consumed", () => {
    const state = makeState()
    const memMsg = makeToolMessage("msg_mem", "memory", "call_mem")
    const plainMsg = makeToolMessage("msg_plain", "bash", "call_plain")
    const search = makeSearchContext([memMsg, plainMsg])

    const entry = recordMemory(state, "msg_mem", "constraint", mockLogger)
    forgetMemory(state, entry.id)

    const sel = makeSelection(["msg_mem", "msg_plain"])
    const forgotten = getForgottenMemoryMessageIds(state)
    assert.equal(forgotten.size, 1)
    assert.ok(forgotten.has("msg_mem"))

    const result = filterProtectedToolMessages(sel, search, ["memory"], [], forgotten)
    assert.ok(
        result.messageIds.includes("msg_mem"),
        "forgotten memory message should be consumable (in compress selection)",
    )
    assert.ok(
        result.messageIds.includes("msg_plain"),
        "non-protected message should remain compressible",
    )
})

test("persistence: memories serialize and deserialize correctly", () => {
    const state = makeState()
    recordMemory(state, "msg_a", "topic1", mockLogger)
    recordMemory(state, "msg_b", "topic2", mockLogger)
    forgetMemory(state, "mem_001")

    const serialized = {
        entries: Array.from(state.memories.entries.entries()).map(([id, entry]) => [
            id,
            { ...entry },
        ]),
        nextId: state.memories.nextId,
    }

    const reloaded = createSessionState()
    reloaded.memories.entries = new Map(
        (serialized.entries as Array<[string, any]>).map(([id, entry]) => [
            id,
            { ...entry },
        ]),
    )
    reloaded.memories.nextId = serialized.nextId

    assert.equal(reloaded.memories.entries.size, 2)
    assert.equal(reloaded.memories.nextId, 3)

    const e1 = reloaded.memories.entries.get("mem_001")
    assert.ok(e1)
    assert.equal(e1!.forgotten, true)
    assert.equal(e1!.topic, "topic1")

    const e2 = reloaded.memories.entries.get("mem_002")
    assert.ok(e2)
    assert.equal(e2!.forgotten, false)
    assert.equal(e2!.topic, "topic2")
})
