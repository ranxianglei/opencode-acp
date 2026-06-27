import assert from "node:assert/strict"
import test from "node:test"
import {
    appendProtectedUserMessages,
    appendProtectedPromptInfo,
    extractProtectedPromptInfo,
} from "../lib/compress/protected-content"
import { createSessionState, type WithParts, type CompressionBlock } from "../lib/state"
import type { SearchContext, SelectionResolution } from "../lib/compress/types"

const SID = "ses-protected-test"

function userMsg(id: string, text: string): WithParts {
    return {
        info: { id, role: "user", sessionID: SID, agent: "a", time: { created: 1 } } as WithParts["info"],
        parts: [{ id: `${id}-p`, messageID: id, sessionID: SID, type: "text", text }],
    }
}

function assistantMsg(id: string): WithParts {
    return {
        info: { id, role: "assistant", sessionID: SID, agent: "a", time: { created: 2 } } as WithParts["info"],
        parts: [],
    }
}

function buildSearchContext(messages: WithParts[]): SearchContext {
    const rawMessagesById = new Map<string, WithParts>()
    const rawIndexById = new Map<string, number>()
    messages.forEach((msg, i) => {
        rawMessagesById.set(msg.info.id, msg)
        rawIndexById.set(msg.info.id, i)
    })
    return {
        rawMessages: messages,
        rawMessagesById,
        rawIndexById,
        summaryByBlockId: new Map(),
    }
}

function buildSelection(messageIds: string[]): SelectionResolution {
    return {
        startReference: { type: "message", ref: "m0" },
        endReference: { type: "message", ref: "m0" },
        messageIds,
        messageTokenById: new Map(),
        toolIds: [],
        requiredBlockIds: [],
    }
}

// =====================================================================
// extractProtectedPromptInfo
// =====================================================================

test("extractProtectedPromptInfo extracts content from <protect> tags", () => {
    const text = "Hello <protect>secret info</protect> world"
    const result = extractProtectedPromptInfo(text)
    assert.deepEqual(result, ["secret info"])
})

test("extractProtectedPromptInfo extracts multiple protect tags", () => {
    const text = "<protect>first</protect> middle <protect>second</protect>"
    const result = extractProtectedPromptInfo(text)
    assert.deepEqual(result, ["first", "second"])
})

test("extractProtectedPromptInfo is case-insensitive", () => {
    const text = "<PROTECT>upper</PROTECT> and <Protect>mixed</Protect>"
    const result = extractProtectedPromptInfo(text)
    assert.deepEqual(result, ["upper", "mixed"])
})

test("extractProtectedPromptInfo returns empty for no tags", () => {
    assert.deepEqual(extractProtectedPromptInfo("no tags here"), [])
})

test("extractProtectedPromptInfo handles multiline content", () => {
    const text = "<protect>line1\nline2\nline3</protect>"
    const result = extractProtectedPromptInfo(text)
    assert.deepEqual(result, ["line1\nline2\nline3"])
})

test("extractProtectedPromptInfo trims whitespace", () => {
    const text = "<protect>  padded  </protect>"
    const result = extractProtectedPromptInfo(text)
    assert.deepEqual(result, ["padded"])
})

// =====================================================================
// appendProtectedUserMessages
// =====================================================================

test("appendProtectedUserMessages returns unchanged when disabled", () => {
    const state = createSessionState(SID)
    const messages = [userMsg("m1", "hello")]
    const ctx = buildSearchContext(messages)
    const result = appendProtectedUserMessages("summary", buildSelection(["m1"]), ctx, state, false)
    assert.equal(result, "summary")
})

test("appendProtectedUserMessages appends user message text when enabled", () => {
    const state = createSessionState(SID)
    const messages = [userMsg("m1", "important user input")]
    const ctx = buildSearchContext(messages)
    const result = appendProtectedUserMessages("summary", buildSelection(["m1"]), ctx, state, true)
    assert.ok(result.includes("important user input"))
    assert.ok(result.includes("summary"))
})

test("appendProtectedUserMessages skips already-compressed messages", () => {
    const state = createSessionState(SID)
    state.prune.messages.byMessageId.set("m1", { tokenCount: 100, allBlockIds: [1], activeBlockIds: [1] })
    const messages = [userMsg("m1", "should not appear")]
    const ctx = buildSearchContext(messages)
    const result = appendProtectedUserMessages("summary", buildSelection(["m1"]), ctx, state, true)
    assert.ok(!result.includes("should not appear"))
})

test("appendProtectedUserMessages skips assistant messages", () => {
    const state = createSessionState(SID)
    const messages = [assistantMsg("m1")]
    const ctx = buildSearchContext(messages)
    const result = appendProtectedUserMessages("summary", buildSelection(["m1"]), ctx, state, true)
    assert.equal(result, "summary")
})

test("appendProtectedUserMessages skips messages not in selection", () => {
    const state = createSessionState(SID)
    const messages = [userMsg("m1", "included"), userMsg("m2", "excluded")]
    const ctx = buildSearchContext(messages)
    const result = appendProtectedUserMessages("summary", buildSelection(["m1"]), ctx, state, true)
    assert.ok(result.includes("included"))
    assert.ok(!result.includes("excluded"))
})

// =====================================================================
// appendProtectedPromptInfo
// =====================================================================

test("appendProtectedPromptInfo returns unchanged when disabled", () => {
    const state = createSessionState(SID)
    const messages = [userMsg("m1", "<protect>secret</protect>")]
    const ctx = buildSearchContext(messages)
    const result = appendProtectedPromptInfo("summary", buildSelection(["m1"]), ctx, state, false)
    assert.equal(result, "summary")
})

test("appendProtectedPromptInfo appends protected content when enabled", () => {
    const state = createSessionState(SID)
    const messages = [userMsg("m1", "text <protect>critical data</protect> end")]
    const ctx = buildSearchContext(messages)
    const result = appendProtectedPromptInfo("summary", buildSelection(["m1"]), ctx, state, true)
    assert.ok(result.includes("critical data"))
    assert.ok(result.includes("summary"))
})

test("appendProtectedPromptInfo skips already-compressed messages", () => {
    const state = createSessionState(SID)
    state.prune.messages.byMessageId.set("m1", { tokenCount: 100, allBlockIds: [1], activeBlockIds: [1] })
    const messages = [userMsg("m1", "<protect>should not appear</protect>")]
    const ctx = buildSearchContext(messages)
    const result = appendProtectedPromptInfo("summary", buildSelection(["m1"]), ctx, state, true)
    assert.ok(!result.includes("should not appear"))
})
