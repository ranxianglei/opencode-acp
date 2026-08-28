import assert from "node:assert/strict"
import test from "node:test"

import { createSessionState } from "../lib/state"
import type { SessionState, WithParts } from "../lib/state/types"
import type { PluginConfig } from "../lib/config"
import type { Logger } from "../lib/logger"
import {
    DEFAULT_COMPLETION_RESERVE_TOKENS,
    enforceContextBudget,
    estimateWireTokens,
    resolveContextWindow,
} from "../lib/messages/enforce-budget"

const noopLogger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => noopLogger,
} as unknown as Logger

const warnState: { warnings: string[] } = { warnings: [] }
const warnLogger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (msg: string) => {
        warnState.warnings.push(msg)
    },
    error: () => {},
    child: () => noopLogger,
} as unknown as Logger

// ~45 chars / ~12 tokens of mixed prose so token counts track chars/4
// regardless of tokenizer run-length behavior on repeated characters.
const FILLER = "The quick brown fox jumps over the lazy dog. ".repeat(20)

function makeConfig(overrides: {
    modelContextLimit?: number
    maxContextLimit?: number | `${number}%`
    reserve?: number
    protectedTools?: string[]
} = {}): { config: PluginConfig; state: SessionState } {
    const state = createSessionState()
    state.sessionId = "session-budget"
    if (overrides.modelContextLimit !== undefined) {
        state.modelContextLimit = overrides.modelContextLimit
    }
    const config = {
        enabled: true,
        autoUpdate: false,
        debug: false,
        pruneNotification: "off" as const,
        pruneNotificationType: "chat" as const,
        commands: { enabled: true, protectedTools: [] as string[] },
        experimental: { allowSubAgents: false, customPrompts: false },
        protectedFilePatterns: [] as string[],
        compress: {
            permission: "allow" as const,
            showCompression: false,
            summaryBuffer: true,
            maxContextLimit: 150000 as number | `${number}%`,
            minContextLimit: 50000 as number | `${number}%`,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft" as const,
            protectedTools: overrides.protectedTools ?? ([] as string[]),
            protectTags: false,
            protectUserMessages: false,
        },
        strategies: {
            deduplication: { enabled: true, protectedTools: [] as string[] },
            purgeErrors: { enabled: true, turns: 4, protectedTools: [] as string[] },
        },
        gc: {
            algorithm: "truncate" as const,
            promotionThreshold: 5,
            maxBlockAge: 15,
            maxOldGenSummaryLength: 3000,
            majorGcThresholdPercent: "100%" as const,
            batchCleanup: {
                lowThreshold: "60%" as const,
                highThreshold: "75%" as const,
                forceThreshold: "90%" as const,
            },
        },
    } as unknown as PluginConfig
    if (overrides.maxContextLimit !== undefined) {
        config.compress.maxContextLimit = overrides.maxContextLimit
    }
    if (overrides.reserve !== undefined) {
        config.compress.completionReserveTokens = overrides.reserve
    }
    return { config, state }
}

let idCounter = 0
function nextId(prefix: string): string {
    idCounter++
    return `${prefix}-${idCounter}`
}

function makeUserText(id: string, text: string): WithParts {
    return {
        info: {
            id,
            role: "user",
            sessionID: "session-budget",
            time: { created: Date.now() },
        } as any,
        parts: [{ type: "text", text }] as any,
    }
}

function makeAssistantText(id: string, text: string): WithParts {
    return {
        info: {
            id,
            role: "assistant",
            sessionID: "session-budget",
            time: { created: Date.now() },
        } as any,
        parts: [{ type: "text", text }] as any,
    }
}

function makeAssistantWithTokens(id: string, input: number, output = 100): WithParts {
    return {
        info: {
            id,
            role: "assistant",
            sessionID: "session-budget",
            time: { created: Date.now() },
            tokens: { input, output, reasoning: 0, cache: { read: 0, write: 0 } },
        } as any,
        parts: [{ type: "text", text: "ok" }] as any,
    }
}

function makeToolMessage(id: string, output: string, tool = "bash"): WithParts {
    return {
        info: {
            id,
            role: "user",
            sessionID: "session-budget",
            time: { created: Date.now() },
        } as any,
        parts: [
            {
                type: "tool",
                tool,
                state: { status: "completed", output, input: {}, time: {} },
            },
        ] as any,
    }
}

test("resolveContextWindow: uses modelContextLimit", () => {
    const { state } = makeConfig({ modelContextLimit: 200000 })
    assert.equal(resolveContextWindow(state), 200000)
})

test("resolveContextWindow: no window without modelContextLimit (absolute maxContextLimit is a soft threshold, not a window)", () => {
    const { state } = makeConfig({ maxContextLimit: 100000 })
    assert.equal(resolveContextWindow(state), undefined)
})

test("resolveContextWindow: no window with percentage maxContextLimit", () => {
    const { state } = makeConfig({ maxContextLimit: "70%" })
    assert.equal(resolveContextWindow(state), undefined)
})

test("estimateWireTokens: base usage plus additions after last assistant", () => {
    const { state } = makeConfig({ modelContextLimit: 200000 })
    const messages: WithParts[] = [
        makeUserText(nextId("u"), "hello"),
        makeAssistantWithTokens(nextId("a"), 9000, 100),
        makeUserText(nextId("u"), "follow-up question"),
    ]
    const est = estimateWireTokens(state, messages)
    assert.ok(est >= 9100, `expected >= 9100, got ${est}`)
    assert.ok(est < 9300, `expected < 9300, got ${est}`)
})

test("estimateWireTokens: fallback sums content plus system prompt", () => {
    const { state } = makeConfig({ modelContextLimit: 200000 })
    state.systemPromptTokens = 500
    const messages: WithParts[] = [
        makeUserText(nextId("u"), FILLER.repeat(2)),
        makeAssistantText(nextId("a"), FILLER.repeat(2)),
    ]
    const est = estimateWireTokens(state, messages)
    assert.ok(est >= 500, `expected >= 500, got ${est}`)
})

test("enforceContextBudget: no-op when window unknown", () => {
    const { config, state } = makeConfig({ maxContextLimit: "70%" })
    const messages: WithParts[] = [makeUserText(nextId("u"), FILLER.repeat(100))]
    const result = enforceContextBudget(state, config, noopLogger, messages)
    assert.equal(result, undefined)
})

test("enforceContextBudget: no-op when under budget", () => {
    const { config, state } = makeConfig({ modelContextLimit: 200000, reserve: 32768 })
    const big = makeToolMessage(nextId("t"), FILLER.repeat(100))
    const messages: WithParts[] = [
        makeUserText(nextId("u"), "hello"),
        big,
        makeAssistantWithTokens(nextId("a"), 50000),
        makeUserText(nextId("u"), "next"),
    ]
    const before = big.parts[0].state.output
    const result = enforceContextBudget(state, config, noopLogger, messages)
    assert.ok(result)
    assert.equal(result!.applied, false)
    assert.equal(big.parts[0].state.output, before)
})

test("enforceContextBudget: truncates largest old tool outputs until under budget", () => {
    const { config, state } = makeConfig({ modelContextLimit: 100000, reserve: 1000 })
    const t1 = makeToolMessage(nextId("t"), FILLER.repeat(130))
    const messages: WithParts[] = [
        makeUserText(nextId("u"), "hello"),
        t1,
        makeAssistantWithTokens(nextId("a"), 5000),
        makeUserText(nextId("u"), "mid"),
        makeAssistantWithTokens(nextId("a2"), 99500),
        makeUserText(nextId("u"), "next"),
    ]
    const result = enforceContextBudget(state, config, noopLogger, messages)
    assert.ok(result)
    assert.equal(result!.applied, true)
    assert.ok(result!.truncatedCount >= 1, `expected truncation, got ${JSON.stringify(result)}`)
    assert.ok(result!.finalEstimate <= result!.budget, "final estimate must fit budget")
    assert.ok(String(t1.parts[0].state.output).includes("[truncated for context space"))
})

test("enforceContextBudget: never touches the last 3 messages or the first user message", () => {
    const { config, state } = makeConfig({ modelContextLimit: 100000, reserve: 1000 })
    const firstUser = makeUserText(nextId("u"), "original task " + FILLER.repeat(60))
    const old = makeToolMessage(nextId("t"), FILLER.repeat(130))
    const recent = makeToolMessage(nextId("t"), FILLER.repeat(30))
    const messages: WithParts[] = [
        firstUser,
        old,
        makeAssistantWithTokens(nextId("a"), 5000),
        makeUserText(nextId("u"), "mid"),
        makeAssistantWithTokens(nextId("a2"), 99500),
        makeUserText(nextId("u"), "next"),
        recent,
    ]
    const firstUserBefore = firstUser.parts[0].text
    const recentBefore = recent.parts[0].state.output
    const result = enforceContextBudget(state, config, noopLogger, messages)
    assert.ok(result)
    assert.equal(firstUser.parts[0].text, firstUserBefore)
    assert.equal(recent.parts[0].state.output, recentBefore)
    assert.ok(String(old.parts[0].state.output).includes("[truncated for context space"))
})

test("enforceContextBudget: skips protected tools and compress summaries", () => {
    const { config, state } = makeConfig({
        modelContextLimit: 100000,
        reserve: 1000,
        protectedTools: ["bash"],
    })
    const other = makeToolMessage(nextId("t"), FILLER.repeat(130), "grep")
    const protectedTool = makeToolMessage(nextId("t"), FILLER.repeat(130), "bash")
    const summary = makeToolMessage(nextId("t"), FILLER.repeat(130), "compress")
    const messages: WithParts[] = [
        makeUserText(nextId("u"), "hello"),
        other,
        protectedTool,
        summary,
        makeAssistantWithTokens(nextId("a"), 99500),
        makeUserText(nextId("u"), "next"),
    ]
    const result = enforceContextBudget(state, config, noopLogger, messages)
    assert.ok(result)
    assert.equal(protectedTool.parts[0].state.output, FILLER.repeat(130))
    assert.equal(summary.parts[0].state.output, FILLER.repeat(130))
    assert.ok(String(other.parts[0].state.output).includes("[truncated for context space"))
})

test("enforceContextBudget: clears oldest outputs when truncation alone cannot fit", () => {
    const { config, state } = makeConfig({ modelContextLimit: 100000, reserve: 1000 })
    const outputs: WithParts[] = []
    for (let i = 0; i < 10; i++) {
        outputs.push(makeToolMessage(nextId("t"), FILLER.repeat(20)))
    }
    const messages: WithParts[] = [
        makeUserText(nextId("u"), "hello"),
        ...outputs,
        makeAssistantWithTokens(nextId("a"), 130000),
        makeUserText(nextId("u"), "next"),
    ]
    const result = enforceContextBudget(state, config, noopLogger, messages)
    assert.ok(result)
    assert.equal(result!.applied, true)
    assert.ok(result!.clearedCount >= 1, `expected clearing, got ${JSON.stringify(result)}`)
    assert.ok(result!.finalEstimate <= result!.budget, "final estimate must fit budget")
    assert.equal(outputs[0].parts[0].state.output, "[Old tool result content cleared]")
})

test("enforceContextBudget: idempotent on second run", () => {
    const { config, state } = makeConfig({ modelContextLimit: 100000, reserve: 1000 })
    const t1 = makeToolMessage(nextId("t"), FILLER.repeat(130))
    const bigAssistant = makeAssistantWithTokens(nextId("a2"), 99500)
    const messages: WithParts[] = [
        makeUserText(nextId("u"), "hello"),
        t1,
        makeAssistantWithTokens(nextId("a"), 5000),
        makeUserText(nextId("u"), "mid"),
        bigAssistant,
        makeUserText(nextId("u"), "next"),
    ]
    const first = enforceContextBudget(state, config, noopLogger, messages)
    assert.ok(first!.applied)
    const afterFirst = String(t1.parts[0].state.output)
    ;(bigAssistant.info as any).tokens.input = 70000
    const second = enforceContextBudget(state, config, noopLogger, messages)
    assert.equal(afterFirst, String(t1.parts[0].state.output))
    assert.ok(second)
    assert.equal(second!.applied, false)
    assert.equal(second!.truncatedCount, 0)
})

test("enforceContextBudget: warns when still over budget after all pruning", () => {
    const { config, state } = makeConfig({ modelContextLimit: 100000, reserve: 1000 })
    const hugeUser = makeUserText(nextId("u"), FILLER.repeat(400))
    const messages: WithParts[] = [
        hugeUser,
        makeAssistantWithTokens(nextId("a"), 99500),
        makeUserText(nextId("u"), "next"),
    ]
    warnState.warnings.length = 0
    const result = enforceContextBudget(state, config, warnLogger, messages)
    assert.ok(result)
    assert.equal(result!.applied, false)
    assert.ok(
        warnState.warnings.some((w) => w.includes("still over budget")),
        `expected over-budget warning, got ${JSON.stringify(warnState.warnings)}`,
    )
})

test("enforceContextBudget: default reserve covers opencode's 32000 max_tokens fallback", () => {
    assert.ok(DEFAULT_COMPLETION_RESERVE_TOKENS >= 32000)
})
