import assert from "node:assert/strict"
import test from "node:test"
import { purgeErrors } from "../lib/strategies/purge-errors"
import type { SessionState, WithParts } from "../lib/state/types"
import type { PluginConfig } from "../lib/config"
import type { Logger } from "../lib/logger"

const mockLogger: Logger = { debug: () => {}, warn: () => {}, info: () => {} } as any

function makeState(overrides: Partial<SessionState> = {}): SessionState {
    return {
        sessionId: "s1",
        isSubAgent: false,
        manualMode: false,
        compressPermission: "allow",
        pendingManualTrigger: null,
        prune: {
            tools: new Map(),
            messages: {
                byMessageId: new Map(),
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
        currentTurn: 10,
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
        gc: {
            algorithm: "truncate",
            promotionThreshold: 5,
            maxBlockAge: 15,
            maxOldGenSummaryLength: 3000,
            majorGcThresholdPercent: "100%",
        },
        strategies: {
            deduplication: { enabled: true, protectedTools: [] },
            purgeErrors: { enabled: true, turns: 4, protectedTools: [] },
        },
        ...overrides,
    }
}

test("purgeErrors does nothing when strategy is disabled", () => {
    const config = makeConfig({
        strategies: {
            ...makeConfig().strategies,
            purgeErrors: { enabled: false, turns: 4, protectedTools: [] },
        },
    })
    const state = makeState({
        toolIdList: ["t1"],
        toolParameters: new Map([
            ["t1", { tool: "read", parameters: { filePath: "/a" }, tokenCount: 100, turn: 1, status: "error" }],
        ]),
    })
    purgeErrors(state, mockLogger, config, [])
    assert.equal(state.prune.tools.size, 0)
    assert.equal(state.stats.totalPruneTokens, 0)
})

test("purgeErrors does nothing when toolIdList is empty", () => {
    const config = makeConfig()
    const state = makeState({ toolIdList: [] })
    purgeErrors(state, mockLogger, config, [])
    assert.equal(state.prune.tools.size, 0)
})

test("purgeErrors does nothing when no error tools exist", () => {
    const config = makeConfig()
    const state = makeState({
        toolIdList: ["t1"],
        toolParameters: new Map([
            ["t1", { tool: "read", parameters: { filePath: "/a" }, tokenCount: 100, turn: 1, status: "completed" }],
        ]),
    })
    purgeErrors(state, mockLogger, config, [])
    assert.equal(state.prune.tools.size, 0)
})

test("purgeErrors does not prune error tools that are not old enough", () => {
    const config = makeConfig({
        strategies: {
            ...makeConfig().strategies,
            purgeErrors: { enabled: true, turns: 5, protectedTools: [] },
        },
    })
    const state = makeState({
        currentTurn: 6,
        toolIdList: ["t1"],
        toolParameters: new Map([
            ["t1", { tool: "read", parameters: { filePath: "/a" }, tokenCount: 100, turn: 3, status: "error" }],
        ]),
    })
    purgeErrors(state, mockLogger, config, [])
    assert.equal(state.prune.tools.size, 0)
})

test("purgeErrors prunes error tools old enough", () => {
    const config = makeConfig({
        strategies: {
            ...makeConfig().strategies,
            purgeErrors: { enabled: true, turns: 3, protectedTools: [] },
        },
    })
    const state = makeState({
        currentTurn: 10,
        toolIdList: ["t1"],
        toolParameters: new Map([
            ["t1", { tool: "read", parameters: { filePath: "/a" }, tokenCount: 200, turn: 5, status: "error" }],
        ]),
    })
    purgeErrors(state, mockLogger, config, [])
    assert.equal(state.prune.tools.size, 1)
    assert.ok(state.prune.tools.has("t1"))
    assert.equal(state.stats.totalPruneTokens, 200)
})

test("purgeErrors skips tools in protectedTools list", () => {
    const config = makeConfig({
        strategies: {
            ...makeConfig().strategies,
            purgeErrors: { enabled: true, turns: 3, protectedTools: ["task"] },
        },
    })
    const state = makeState({
        currentTurn: 10,
        toolIdList: ["t1"],
        toolParameters: new Map([
            ["t1", { tool: "task", parameters: { prompt: "do thing" }, tokenCount: 300, turn: 2, status: "error" }],
        ]),
    })
    purgeErrors(state, mockLogger, config, [])
    assert.equal(state.prune.tools.size, 0)
})

test("purgeErrors skips already-pruned tool IDs", () => {
    const config = makeConfig({
        strategies: {
            ...makeConfig().strategies,
            purgeErrors: { enabled: true, turns: 3, protectedTools: [] },
        },
    })
    const pruneTools = new Map<string, number>()
    pruneTools.set("t1", 100)

    const state = makeState({
        currentTurn: 10,
        toolIdList: ["t1"],
        prune: {
            ...makeState().prune,
            tools: pruneTools,
        },
        toolParameters: new Map([
            ["t1", { tool: "read", parameters: { filePath: "/a" }, tokenCount: 200, turn: 2, status: "error" }],
        ]),
    })
    purgeErrors(state, mockLogger, config, [])
    assert.equal(state.prune.tools.size, 1)
    assert.equal(state.prune.tools.get("t1"), 100)
    assert.equal(state.stats.totalPruneTokens, 0)
})

test("purgeErrors only prunes old errors from mixed status tools", () => {
    const config = makeConfig({
        strategies: {
            ...makeConfig().strategies,
            purgeErrors: { enabled: true, turns: 3, protectedTools: [] },
        },
    })
    const state = makeState({
        currentTurn: 10,
        toolIdList: ["t1", "t2", "t3"],
        toolParameters: new Map([
            ["t1", { tool: "read", parameters: { filePath: "/a" }, tokenCount: 100, turn: 5, status: "error" }],
            ["t2", { tool: "read", parameters: { filePath: "/b" }, tokenCount: 100, turn: 5, status: "completed" }],
            ["t3", { tool: "read", parameters: { filePath: "/c" }, tokenCount: 100, turn: 9, status: "error" }],
        ]),
    })
    purgeErrors(state, mockLogger, config, [])

    assert.equal(state.prune.tools.size, 1)
    assert.ok(state.prune.tools.has("t1"))
    assert.ok(!state.prune.tools.has("t2"))
    assert.ok(!state.prune.tools.has("t3"))
})

test("purgeErrors handles exact turn boundary correctly", () => {
    const config = makeConfig({
        strategies: {
            ...makeConfig().strategies,
            purgeErrors: { enabled: true, turns: 4, protectedTools: [] },
        },
    })
    const state = makeState({
        currentTurn: 8,
        toolIdList: ["t1"],
        toolParameters: new Map([
            ["t1", { tool: "read", parameters: { filePath: "/a" }, tokenCount: 100, turn: 4, status: "error" }],
        ]),
    })
    purgeErrors(state, mockLogger, config, [])
    assert.equal(state.prune.tools.size, 1)
    assert.ok(state.prune.tools.has("t1"))
})

test("purgeErrors does nothing in manual mode without automaticStrategies", () => {
    const config = makeConfig({
        manualMode: { enabled: true, automaticStrategies: false },
    })
    const state = makeState({
        manualMode: "active",
        currentTurn: 10,
        toolIdList: ["t1"],
        toolParameters: new Map([
            ["t1", { tool: "read", parameters: { filePath: "/a" }, tokenCount: 100, turn: 2, status: "error" }],
        ]),
    })
    purgeErrors(state, mockLogger, config, [])
    assert.equal(state.prune.tools.size, 0)
})

test("purgeErrors runs in manual mode when automaticStrategies is true", () => {
    const config = makeConfig({
        manualMode: { enabled: true, automaticStrategies: true },
    })
    const state = makeState({
        manualMode: "active",
        currentTurn: 10,
        toolIdList: ["t1"],
        toolParameters: new Map([
            ["t1", { tool: "read", parameters: { filePath: "/a" }, tokenCount: 100, turn: 2, status: "error" }],
        ]),
    })
    purgeErrors(state, mockLogger, config, [])
    assert.equal(state.prune.tools.size, 1)
})

test("purgeErrors skips tools with missing metadata", () => {
    const config = makeConfig()
    const state = makeState({
        currentTurn: 10,
        toolIdList: ["t1"],
        toolParameters: new Map(),
    })
    purgeErrors(state, mockLogger, config, [])
    assert.equal(state.prune.tools.size, 0)
})
