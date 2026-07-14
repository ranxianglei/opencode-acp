import assert from "node:assert/strict"
import test from "node:test"
import { deduplicate } from "../lib/strategies/deduplication"
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
        currentTurn: 1,
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
            batchCleanup: { lowThreshold: "60%", highThreshold: "75%", forceThreshold: "90%" },
        },
        strategies: {
            deduplication: { enabled: true, protectedTools: [] },
            purgeErrors: { enabled: true, turns: 4, protectedTools: [] },
        },
        ...overrides,
    }
}

test("deduplicate does nothing when strategy is disabled", () => {
    const config = makeConfig({
        strategies: {
            ...makeConfig().strategies,
            deduplication: { enabled: false, protectedTools: [] },
        },
    })
    const state = makeState({
        toolIdList: ["t1", "t2"],
        toolParameters: new Map([
            ["t1", { tool: "read", parameters: { filePath: "/a" }, tokenCount: 100, turn: 1 }],
            ["t2", { tool: "read", parameters: { filePath: "/a" }, tokenCount: 100, turn: 2 }],
        ]),
    })
    deduplicate(state, mockLogger, config, [])
    assert.equal(state.prune.tools.size, 0)
    assert.equal(state.stats.totalPruneTokens, 0)
})

test("deduplicate does nothing when toolIdList is empty", () => {
    const config = makeConfig()
    const state = makeState({ toolIdList: [], toolParameters: new Map() })
    deduplicate(state, mockLogger, config, [])
    assert.equal(state.prune.tools.size, 0)
})

test("deduplicate does nothing with a single tool call", () => {
    const config = makeConfig()
    const state = makeState({
        toolIdList: ["t1"],
        toolParameters: new Map([
            ["t1", { tool: "read", parameters: { filePath: "/a" }, tokenCount: 100, turn: 1 }],
        ]),
    })
    deduplicate(state, mockLogger, config, [])
    assert.equal(state.prune.tools.size, 0)
})

test("deduplicate prunes older duplicate tool calls with same name and params", () => {
    const config = makeConfig()
    const state = makeState({
        toolIdList: ["t1", "t2", "t3"],
        toolParameters: new Map([
            ["t1", { tool: "read", parameters: { filePath: "/a" }, tokenCount: 50, turn: 1 }],
            ["t2", { tool: "read", parameters: { filePath: "/a" }, tokenCount: 50, turn: 2 }],
            ["t3", { tool: "read", parameters: { filePath: "/a" }, tokenCount: 50, turn: 3 }],
        ]),
    })
    deduplicate(state, mockLogger, config, [])

    assert.equal(state.prune.tools.size, 2)
    assert.ok(state.prune.tools.has("t1"))
    assert.ok(state.prune.tools.has("t2"))
    assert.ok(!state.prune.tools.has("t3"))
    assert.equal(state.stats.totalPruneTokens, 100)
})

test("deduplicate does not prune tools with different parameters", () => {
    const config = makeConfig()
    const state = makeState({
        toolIdList: ["t1", "t2"],
        toolParameters: new Map([
            ["t1", { tool: "read", parameters: { filePath: "/a" }, tokenCount: 100, turn: 1 }],
            ["t2", { tool: "read", parameters: { filePath: "/b" }, tokenCount: 100, turn: 2 }],
        ]),
    })
    deduplicate(state, mockLogger, config, [])
    assert.equal(state.prune.tools.size, 0)
})

test("deduplicate does not prune tools with different names", () => {
    const config = makeConfig()
    const state = makeState({
        toolIdList: ["t1", "t2"],
        toolParameters: new Map([
            ["t1", { tool: "read", parameters: { filePath: "/a" }, tokenCount: 100, turn: 1 }],
            ["t2", { tool: "write", parameters: { filePath: "/a" }, tokenCount: 100, turn: 2 }],
        ]),
    })
    deduplicate(state, mockLogger, config, [])
    assert.equal(state.prune.tools.size, 0)
})

test("deduplicate skips already-pruned tool IDs", () => {
    const config = makeConfig()
    const pruneTools = new Map<string, number>()
    pruneTools.set("t1", 100)

    const state = makeState({
        toolIdList: ["t1", "t2"],
        prune: {
            ...makeState().prune,
            tools: pruneTools,
        },
        toolParameters: new Map([
            ["t1", { tool: "read", parameters: { filePath: "/a" }, tokenCount: 100, turn: 1 }],
            ["t2", { tool: "read", parameters: { filePath: "/a" }, tokenCount: 100, turn: 2 }],
        ]),
    })
    deduplicate(state, mockLogger, config, [])

    assert.ok(!state.prune.tools.has("t2"))
})

test("deduplicate skips tools in protectedTools list", () => {
    const config = makeConfig({
        strategies: {
            ...makeConfig().strategies,
            deduplication: { enabled: true, protectedTools: ["task"] },
        },
    })
    const state = makeState({
        toolIdList: ["t1", "t2"],
        toolParameters: new Map([
            ["t1", { tool: "task", parameters: { prompt: "do thing" }, tokenCount: 200, turn: 1 }],
            ["t2", { tool: "task", parameters: { prompt: "do thing" }, tokenCount: 200, turn: 2 }],
        ]),
    })
    deduplicate(state, mockLogger, config, [])
    assert.equal(state.prune.tools.size, 0)
})

test("deduplicate skips tools with missing metadata", () => {
    const config = makeConfig()
    const state = makeState({
        toolIdList: ["t1", "t2"],
        toolParameters: new Map([
            ["t2", { tool: "read", parameters: { filePath: "/a" }, tokenCount: 100, turn: 2 }],
        ]),
    })
    deduplicate(state, mockLogger, config, [])
    assert.equal(state.prune.tools.size, 0)
})

test("deduplicate does nothing in manual mode without automaticStrategies", () => {
    const config = makeConfig({
        manualMode: { enabled: true, automaticStrategies: false },
    })
    const state = makeState({
        manualMode: "active",
        toolIdList: ["t1", "t2"],
        toolParameters: new Map([
            ["t1", { tool: "read", parameters: { filePath: "/a" }, tokenCount: 100, turn: 1 }],
            ["t2", { tool: "read", parameters: { filePath: "/a" }, tokenCount: 100, turn: 2 }],
        ]),
    })
    deduplicate(state, mockLogger, config, [])
    assert.equal(state.prune.tools.size, 0)
})

test("deduplicate runs in manual mode when automaticStrategies is true", () => {
    const config = makeConfig({
        manualMode: { enabled: true, automaticStrategies: true },
    })
    const state = makeState({
        manualMode: "active",
        toolIdList: ["t1", "t2"],
        toolParameters: new Map([
            ["t1", { tool: "read", parameters: { filePath: "/a" }, tokenCount: 100, turn: 1 }],
            ["t2", { tool: "read", parameters: { filePath: "/a" }, tokenCount: 100, turn: 2 }],
        ]),
    })
    deduplicate(state, mockLogger, config, [])
    assert.equal(state.prune.tools.size, 1)
    assert.ok(state.prune.tools.has("t1"))
})

test("deduplicate handles groups of different signatures independently", () => {
    const config = makeConfig()
    const state = makeState({
        toolIdList: ["t1", "t2", "t3", "t4"],
        toolParameters: new Map([
            ["t1", { tool: "read", parameters: { filePath: "/a" }, tokenCount: 50, turn: 1 }],
            ["t2", { tool: "read", parameters: { filePath: "/a" }, tokenCount: 50, turn: 2 }],
            ["t3", { tool: "read", parameters: { filePath: "/b" }, tokenCount: 50, turn: 1 }],
            ["t4", { tool: "read", parameters: { filePath: "/b" }, tokenCount: 50, turn: 2 }],
        ]),
    })
    deduplicate(state, mockLogger, config, [])
    assert.equal(state.prune.tools.size, 2)
    assert.ok(state.prune.tools.has("t1"))
    assert.ok(state.prune.tools.has("t3"))
    assert.equal(state.stats.totalPruneTokens, 100)
})
