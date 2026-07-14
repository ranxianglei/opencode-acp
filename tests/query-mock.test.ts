import assert from "node:assert/strict"
import test from "node:test"
import {
    isMessageCompacted,
    countTurns,
    findLastCompactionTimestamp,
} from "../lib/state/utils"
import {
    isProtectedUserMessage,
    getLastUserMessage,
    isIgnoredUserMessage,
} from "../lib/messages/query"
import type { SessionState, WithParts, PrunedMessageEntry } from "../lib/state/types"
import type { PluginConfig } from "../lib/config"

// --- Factory functions for mock data ---

let nextId = 1
function nextMsgId(): string {
    return `msg-${nextId++}`
}

const SID = "session-1"

interface MockMessageOptions {
    id?: string
    role?: "user" | "assistant"
    created?: number
    summary?: boolean
    parts?: any[]
}

function makeMessage(opts: MockMessageOptions = {}): WithParts {
    const id = opts.id ?? nextMsgId()
    const role = opts.role ?? "assistant"
    return {
        info: {
            id,
            sessionID: SID,
            role,
            time: { created: opts.created ?? 1000 },
            ...(role === "assistant"
                ? {
                      parentID: "parent-1",
                      modelID: "test-model",
                      providerID: "test-provider",
                      mode: "normal",
                      agent: "test",
                      path: { cwd: "/", root: "/" },
                      summary: opts.summary ?? false,
                      cost: 0,
                      tokens: {
                          input: 0,
                          output: 0,
                          reasoning: 0,
                          cache: { read: 0, write: 0 },
                      },
                  }
                : {
                      agent: "test",
                      model: { providerID: "test-provider", modelID: "test-model" },
                  }),
        } as any,
        parts: opts.parts ?? [],
    }
}

function makeStepStartPart(): any {
    return { type: "step-start", id: `part-${nextId++}`, sessionID: SID, messageID: "m" }
}

function makeTextPart(text: string, ignored = false): any {
    return { type: "text", text, ignored, id: `part-${nextId++}`, sessionID: SID, messageID: "m" }
}

function makeState(overrides: Partial<SessionState> = {}): SessionState {
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
                blocksById: new Map(),
                activeBlockIds: new Set<number>(),
                activeByAnchorMessageId: new Map(),
                nextBlockId: 1,
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
        subAgentResultCache: new Map(),
        toolIdList: [],
        messageIds: { byRawId: new Map(), byRef: new Map(), nextRef: 1 },
        lastCompaction: 0,
        currentTurn: 0,
        modelContextLimit: undefined,
        systemPromptTokens: undefined,
        ...overrides,
    }
}

function makeConfig(overrides: Partial<PluginConfig> = {}): PluginConfig {
    return {
        enabled: true,
        autoUpdate: true,
        debug: false,
        pruneNotification: "detailed",
        pruneNotificationType: "chat",
        commands: { enabled: true, protectedTools: [] },
        manualMode: { enabled: false, automaticStrategies: true },
        turnProtection: { enabled: false, turns: 4 },
        experimental: { allowSubAgents: false, customPrompts: false },
        protectedFilePatterns: [],
        compress: {
            mode: "range",
            permission: "allow",
            showCompression: true,
            summaryBuffer: true,
            maxContextLimit: "55%",
            minContextLimit: "45%",
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: [],
            protectTags: false,
            protectUserMessages: false,
        },
        strategies: {
            deduplication: { enabled: true, protectedTools: [] },
            purgeErrors: { enabled: true, turns: 4, protectedTools: [] },
        },
        ...overrides,
    }
}

// --- Tests for isMessageCompacted ---

test("isMessageCompacted returns false for message without info", () => {
    const state = makeState({ lastCompaction: 1000 })
    const msg = { info: null as any, parts: [] }
    assert.equal(isMessageCompacted(state, msg as any), false)
})

test("isMessageCompacted returns false when lastCompaction is 0", () => {
    const state = makeState({ lastCompaction: 0 })
    const msg = makeMessage({ created: 500 })
    assert.equal(isMessageCompacted(state, msg), false)
})

test("isMessageCompacted returns true when created < lastCompaction", () => {
    const state = makeState({ lastCompaction: 2000 })
    const msg = makeMessage({ created: 1500 })
    assert.equal(isMessageCompacted(state, msg), true)
})

test("isMessageCompacted returns false when created >= lastCompaction", () => {
    const state = makeState({ lastCompaction: 2000 })
    const msg = makeMessage({ created: 2500 })
    assert.equal(isMessageCompacted(state, msg), false)
})

test("isMessageCompacted returns true for summary message at exact lastCompaction time", () => {
    const state = makeState({ lastCompaction: 2000 })
    const msg = makeMessage({ role: "assistant", created: 2000, summary: true })
    assert.equal(isMessageCompacted(state, msg), true)
})

test("isMessageCompacted returns false for non-summary message at exact lastCompaction time", () => {
    const state = makeState({ lastCompaction: 2000 })
    const msg = makeMessage({ role: "assistant", created: 2000, summary: false })
    assert.equal(isMessageCompacted(state, msg), false)
})

test("isMessageCompacted returns true when prune entry has activeBlockIds", () => {
    const msg = makeMessage({ created: 2500 })
    const state = makeState({ lastCompaction: 2000 })
    state.prune.messages.byMessageId.set(msg.info.id, {
        tokenCount: 100,
        allBlockIds: [1],
        activeBlockIds: [1],
    })
    assert.equal(isMessageCompacted(state, msg), true)
})

test("isMessageCompacted returns false when prune entry has empty activeBlockIds", () => {
    const msg = makeMessage({ created: 2500 })
    const state = makeState({ lastCompaction: 2000 })
    state.prune.messages.byMessageId.set(msg.info.id, {
        tokenCount: 100,
        allBlockIds: [1],
        activeBlockIds: [],
    })
    assert.equal(isMessageCompacted(state, msg), false)
})

// --- Tests for findLastCompactionTimestamp ---

test("findLastCompactionTimestamp returns 0 for empty array", () => {
    assert.equal(findLastCompactionTimestamp([]), 0)
})

test("findLastCompactionTimestamp returns 0 when no summary messages exist", () => {
    const msgs = [
        makeMessage({ role: "user", created: 100 }),
        makeMessage({ role: "assistant", created: 200, summary: false }),
    ]
    assert.equal(findLastCompactionTimestamp(msgs), 0)
})

test("findLastCompactionTimestamp returns timestamp of single summary message", () => {
    const msgs = [
        makeMessage({ role: "user", created: 100 }),
        makeMessage({ role: "assistant", created: 500, summary: true }),
    ]
    assert.equal(findLastCompactionTimestamp(msgs), 500)
})

test("findLastCompactionTimestamp returns last summary timestamp among multiple", () => {
    const msgs = [
        makeMessage({ role: "assistant", created: 300, summary: true }),
        makeMessage({ role: "user", created: 400 }),
        makeMessage({ role: "assistant", created: 700, summary: true }),
    ]
    assert.equal(findLastCompactionTimestamp(msgs), 700)
})

test("findLastCompactionTimestamp skips non-assistant summary messages", () => {
    const msgs = [
        makeMessage({ role: "user", created: 300 }),
        makeMessage({ role: "assistant", created: 500, summary: true }),
    ]
    assert.equal(findLastCompactionTimestamp(msgs), 500)
})

// --- Tests for countTurns ---

test("countTurns returns 0 for empty array", () => {
    const state = makeState()
    assert.equal(countTurns(state, []), 0)
})

test("countTurns returns 0 when all messages are compacted", () => {
    const state = makeState({ lastCompaction: 2000 })
    const msgs = [
        makeMessage({ role: "assistant", created: 1000, parts: [makeStepStartPart()] }),
        makeMessage({ role: "assistant", created: 1500, parts: [makeStepStartPart()] }),
    ]
    assert.equal(countTurns(state, msgs), 0)
})

test("countTurns counts step-start parts in non-compacted messages", () => {
    const state = makeState({ lastCompaction: 0 })
    const msgs = [
        makeMessage({ role: "assistant", created: 1000, parts: [makeStepStartPart()] }),
        makeMessage({ role: "assistant", created: 1500, parts: [makeStepStartPart(), makeStepStartPart()] }),
    ]
    assert.equal(countTurns(state, msgs), 3)
})

test("countTurns returns 0 when no step-start parts exist", () => {
    const state = makeState({ lastCompaction: 0 })
    const msgs = [
        makeMessage({ role: "assistant", created: 1000, parts: [makeTextPart("hello")] }),
        makeMessage({ role: "user", created: 1500, parts: [makeTextPart("world")] }),
    ]
    assert.equal(countTurns(state, msgs), 0)
})

test("countTurns counts correctly with mixed compacted and non-compacted", () => {
    const state = makeState({ lastCompaction: 2000 })
    const msgs = [
        makeMessage({ role: "assistant", created: 1000, parts: [makeStepStartPart()] }),
        makeMessage({ role: "assistant", created: 1500, parts: [makeStepStartPart()] }),
        makeMessage({ role: "assistant", created: 2500, parts: [makeStepStartPart()] }),
    ]
    assert.equal(countTurns(state, msgs), 1)
})

// --- Tests for isProtectedUserMessage ---

test("isProtectedUserMessage returns false when mode is range", () => {
    const config = makeConfig({
        compress: { ...makeConfig().compress, mode: "range", protectUserMessages: true },
    })
    const msg = makeMessage({ role: "user" })
    assert.equal(isProtectedUserMessage(config, msg), false)
})

test("isProtectedUserMessage returns false when protectUserMessages is false", () => {
    const config = makeConfig({
        compress: { ...makeConfig().compress, mode: "message", protectUserMessages: false },
    })
    const msg = makeMessage({ role: "user" })
    assert.equal(isProtectedUserMessage(config, msg), false)
})

test("isProtectedUserMessage returns false for assistant message", () => {
    const config = makeConfig({
        compress: { ...makeConfig().compress, mode: "message", protectUserMessages: true },
    })
    const msg = makeMessage({ role: "assistant" })
    assert.equal(isProtectedUserMessage(config, msg), false)
})

test("isProtectedUserMessage returns false for ignored user message", () => {
    const config = makeConfig({
        compress: { ...makeConfig().compress, mode: "message", protectUserMessages: true },
    })
    const msg = makeMessage({
        role: "user",
        parts: [{ type: "text", text: "ignored", ignored: true }],
    })
    assert.equal(isProtectedUserMessage(config, msg), false)
})

test("isProtectedUserMessage returns true for valid protected user message", () => {
    const config = makeConfig({
        compress: { ...makeConfig().compress, mode: "message", protectUserMessages: true },
    })
    const msg = makeMessage({
        role: "user",
        parts: [makeTextPart("hello world")],
    })
    assert.equal(isProtectedUserMessage(config, msg), true)
})

// --- Tests for getLastUserMessage ---

test("getLastUserMessage returns null when no user messages", () => {
    const msgs = [
        makeMessage({ role: "assistant", parts: [makeTextPart("hi")] }),
        makeMessage({ role: "assistant", parts: [makeTextPart("there")] }),
    ]
    assert.equal(getLastUserMessage(msgs), null)
})

test("getLastUserMessage returns null when only ignored user messages", () => {
    const msgs = [
        makeMessage({
            role: "user",
            parts: [{ type: "text", text: "ignored", ignored: true }],
        }),
    ]
    assert.equal(getLastUserMessage(msgs), null)
})

test("getLastUserMessage finds the last non-ignored user message", () => {
    const userMsg1 = makeMessage({ role: "user", parts: [makeTextPart("first")] })
    const userMsg2 = makeMessage({ role: "user", parts: [makeTextPart("second")] })
    const msgs = [userMsg1, makeMessage({ role: "assistant" }), userMsg2]
    assert.equal(getLastUserMessage(msgs), userMsg2)
})

test("getLastUserMessage respects startIndex boundary", () => {
    const userMsg1 = makeMessage({ role: "user", parts: [makeTextPart("first")] })
    const userMsg2 = makeMessage({ role: "user", parts: [makeTextPart("second")] })
    const msgs = [userMsg1, userMsg2, makeMessage({ role: "assistant" })]
    assert.equal(getLastUserMessage(msgs, 1), userMsg2)
})

test("getLastUserMessage skips messages without info", () => {
    const userMsg = makeMessage({ role: "user", parts: [makeTextPart("hello")] })
    const msgs = [{ info: null as any, parts: [] }, userMsg]
    assert.equal(getLastUserMessage(msgs), userMsg)
})

// --- Tests for isIgnoredUserMessage ---

test("isIgnoredUserMessage returns false for non-user message", () => {
    const msg = makeMessage({ role: "assistant" })
    assert.equal(isIgnoredUserMessage(msg), false)
})

test("isIgnoredUserMessage returns true for user message with empty parts", () => {
    const msg = makeMessage({ role: "user", parts: [] })
    assert.equal(isIgnoredUserMessage(msg), true)
})

test("isIgnoredUserMessage returns true for user message with all ignored parts", () => {
    const msg = makeMessage({
        role: "user",
        parts: [
            { type: "text", text: "a", ignored: true },
            { type: "text", text: "b", ignored: true },
        ],
    })
    assert.equal(isIgnoredUserMessage(msg), true)
})

test("isIgnoredUserMessage returns false for user message with some non-ignored parts", () => {
    const msg = makeMessage({
        role: "user",
        parts: [
            { type: "text", text: "a", ignored: true },
            { type: "text", text: "b" },
        ],
    })
    assert.equal(isIgnoredUserMessage(msg), false)
})

test("isIgnoredUserMessage returns false for message without info", () => {
    assert.equal(isIgnoredUserMessage({ info: null as any, parts: [] } as any), false)
})
