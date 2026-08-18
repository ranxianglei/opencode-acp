import assert from "node:assert/strict"
import test from "node:test"
import { computeShouldNudge, resolveAdaptiveNudgeGrowth, estimateContextComposition } from "../lib/messages/inject/utils"
import { cacheSystemPromptTokens } from "../lib/ui/utils"
import { estimateSystemPromptTokens } from "../lib/token-utils"
import { countTokens } from "../lib/token-utils"
import type { WithParts } from "../lib/state"

const baseParams = {
    currentTokens: 20_000,
    modelContextLimit: 100_000,
    overMinLimit: false,
    overMaxLimit: false,
    lastNudgeTokens: 20_000 as number | undefined,
    minNudgeContextPercent: 15,
    nudgeGrowthTokens: 6000,
}

test("first observed turn (lastNudgeTokens === undefined) never nudges — baseline establishment", () => {
    const d = computeShouldNudge({
        ...baseParams,
        currentTokens: 50_000,
        modelContextLimit: 100_000,
        lastNudgeTokens: undefined,
        overMaxLimit: true,
    })
    assert.equal(d.shouldNudge, false)
    assert.equal(d.tipsVariant, null)
})

test("first turn does not nudge even at high context or over max", () => {
    const d = computeShouldNudge({
        ...baseParams,
        currentTokens: 90_000,
        modelContextLimit: 100_000,
        lastNudgeTokens: undefined,
        overMaxLimit: true,
        overMinLimit: true,
    })
    assert.equal(d.shouldNudge, false)
})

test("currentTokens undefined returns no-nudge", () => {
    const d = computeShouldNudge({
        ...baseParams,
        currentTokens: undefined,
        lastNudgeTokens: 20_000,
    })
    assert.equal(d.shouldNudge, false)
    assert.equal(d.tipsVariant, null)
})

test("does not re-nudge before growth step reached", () => {
    const d = computeShouldNudge({
        ...baseParams,
        currentTokens: 24_000,
        lastNudgeTokens: 20_000,
    })
    assert.equal(d.shouldNudge, false)
})

test("re-nudges after growth step reached (no contextPct floor)", () => {
    const d = computeShouldNudge({
        ...baseParams,
        currentTokens: 26_500,
        lastNudgeTokens: 20_000,
    })
    assert.equal(d.shouldNudge, true)
    assert.equal(d.tipsVariant, "normal")
})

test("nudge fires at very low contextPct once growth step is met (no 15% floor)", () => {
    const d = computeShouldNudge({
        ...baseParams,
        currentTokens: 7_000,
        modelContextLimit: 1_000_000,
        lastNudgeTokens: 0,
        nudgeGrowthTokens: 6_000,
    })
    assert.equal(d.shouldNudge, true)
    assert.equal(d.tipsVariant, "normal")
})

test("overMaxLimit bypasses frequency gating", () => {
    const d = computeShouldNudge({
        ...baseParams,
        currentTokens: 26_000,
        lastNudgeTokens: 25_000,
        overMaxLimit: true,
    })
    assert.equal(d.shouldNudge, true)
    assert.equal(d.tipsVariant, "maxLimit")
})

test("overMaxLimit nudges regardless of contextPct (legacy floor removed)", () => {
    const d = computeShouldNudge({
        ...baseParams,
        currentTokens: 10_000,
        modelContextLimit: 100_000,
        lastNudgeTokens: 10_000,
        overMaxLimit: true,
    })
    assert.equal(d.shouldNudge, true)
    assert.equal(d.tipsVariant, "maxLimit")
})

test("overMinLimit produces minLimit variant", () => {
    const d = computeShouldNudge({
        ...baseParams,
        currentTokens: 30_000,
        lastNudgeTokens: 0,
        overMinLimit: true,
    })
    assert.equal(d.shouldNudge, true)
    assert.equal(d.tipsVariant, "minLimit")
})

test("overMaxLimit takes precedence over overMinLimit", () => {
    const d = computeShouldNudge({
        ...baseParams,
        currentTokens: 90_000,
        lastNudgeTokens: 0,
        overMinLimit: true,
        overMaxLimit: true,
    })
    assert.equal(d.shouldNudge, true)
    assert.equal(d.tipsVariant, "maxLimit")
})

test("minNudgeContextPercent param is ignored (legacy, kept for backward compat)", () => {
    const withFloor = computeShouldNudge({
        ...baseParams,
        currentTokens: 7_000,
        modelContextLimit: 100_000,
        lastNudgeTokens: 0,
        minNudgeContextPercent: 15,
    })
    const withoutFloor = computeShouldNudge({
        ...baseParams,
        currentTokens: 7_000,
        modelContextLimit: 100_000,
        lastNudgeTokens: 0,
        minNudgeContextPercent: 0,
    })
    assert.equal(withFloor.shouldNudge, withoutFloor.shouldNudge)
})

test("custom nudgeGrowthTokens respected", () => {
    const tight = computeShouldNudge({
        ...baseParams,
        currentTokens: 22_000,
        lastNudgeTokens: 20_000,
        nudgeGrowthTokens: 1000,
    })
    assert.equal(tight.shouldNudge, true)

    const loose = computeShouldNudge({
        ...baseParams,
        currentTokens: 22_000,
        lastNudgeTokens: 20_000,
        nudgeGrowthTokens: 5000,
    })
    assert.equal(loose.shouldNudge, false)
})

test("regression: post-compress lastNudgeTokens=currentTokens prevents immediate re-nudge", () => {
    const postCompressTokens = 250_000

    const immediate = computeShouldNudge({
        ...baseParams,
        currentTokens: postCompressTokens + 3_000,
        lastNudgeTokens: postCompressTokens,
        nudgeGrowthTokens: 50_000,
    })
    assert.equal(immediate.shouldNudge, false)

    const afterGrowth = computeShouldNudge({
        ...baseParams,
        currentTokens: postCompressTokens + 55_000,
        lastNudgeTokens: postCompressTokens,
        nudgeGrowthTokens: 50_000,
    })
    assert.equal(afterGrowth.shouldNudge, true)
})

test("resolveAdaptiveNudgeGrowth: undefined limit returns floor", () => {
    assert.equal(resolveAdaptiveNudgeGrowth(undefined), 6000)
})

test("resolveAdaptiveNudgeGrowth: zero/negative limit returns floor", () => {
    assert.equal(resolveAdaptiveNudgeGrowth(0), 6000)
    assert.equal(resolveAdaptiveNudgeGrowth(-100), 6000)
})

test("resolveAdaptiveNudgeGrowth: tiny context floored at 6K", () => {
    assert.equal(resolveAdaptiveNudgeGrowth(10_000), 6000)
    assert.equal(resolveAdaptiveNudgeGrowth(50_000), 6000)
    assert.equal(resolveAdaptiveNudgeGrowth(100_000), 6000)
})

test("resolveAdaptiveNudgeGrowth: 128K mainstream model", () => {
    assert.equal(resolveAdaptiveNudgeGrowth(128_000), 6400)
})

test("resolveAdaptiveNudgeGrowth: 200K → 10K", () => {
    assert.equal(resolveAdaptiveNudgeGrowth(200_000), 10_000)
})

test("resolveAdaptiveNudgeGrowth: 1M → 50K (5% exact)", () => {
    assert.equal(resolveAdaptiveNudgeGrowth(1_000_000), 50_000)
})

test("resolveAdaptiveNudgeGrowth: multi-million capped at 50K", () => {
    assert.equal(resolveAdaptiveNudgeGrowth(2_000_000), 50_000)
    assert.equal(resolveAdaptiveNudgeGrowth(10_000_000), 50_000)
})

function mkText(id: string, text: string): WithParts {
    return { info: { id } as any, parts: [{ type: "text", text, id: `${id}-p`, sessionID: "s", messageID: id }] as any }
}

function mkTool(id: string, raw: string): WithParts {
    return { info: { id } as any, parts: [{ type: "tool", tool: raw } as any] }
}

function mkSummary(id: string, text: string): WithParts {
    return { info: { id: `msg_dcp_summary_${id}` } as any, parts: [{ type: "text", text: `[Compressed conversation section]\n${text}` }] as any }
}

function mkAssistantWithTokens(input: number, cacheRead = 0, cacheWrite = 0): WithParts {
    return {
        info: { id: "a1", role: "assistant", tokens: { input, output: 100, cache: { read: cacheRead, write: cacheWrite } } } as any,
        parts: [{ type: "text", text: "ok", id: "a1-p", sessionID: "s", messageID: "a1" }] as any,
    }
}

test("estimateSystemPromptTokens: assistant input minus first user text", () => {
    const userText = "Hello, please help me with a task."
    const input = 10_000
    const messages = [
        { info: { id: "u1", role: "user" } as any, parts: [{ type: "text", text: userText }] as any },
        mkAssistantWithTokens(input),
    ]
    const sys = estimateSystemPromptTokens(messages)
    assert.ok(sys > 0, "system tokens should be positive")
    assert.equal(sys, input - countTokens(userText))
})

test("estimateSystemPromptTokens: returns 0 when no assistant token data", () => {
    const messages = [mkText("u1", "hello")]
    assert.equal(estimateSystemPromptTokens(messages), 0)
})

test("estimateSystemPromptTokens: handles cache.read and cache.write", () => {
    const messages = [
        { info: { id: "u1", role: "user" } as any, parts: [{ type: "text", text: "hi" }] as any },
        mkAssistantWithTokens(5000, 3000, 2000),
    ]
    const sys = estimateSystemPromptTokens(messages)
    assert.ok(sys > 0)
    assert.equal(sys, 10_000 - countTokens("hi"))
})

test("estimateContextComposition: systemTokens from assistant data included in total", () => {
    const msgs = [
        { info: { id: "u1", role: "user" } as any, parts: [{ type: "text", text: "hello" }] as any },
        mkAssistantWithTokens(8000),
        mkText("m1", "x".repeat(400)),
    ]
    const c = estimateContextComposition(msgs)
    assert.ok(c.systemTokens > 0, "system tokens should be computed from assistant data")
    assert.equal(c.total, c.systemTokens + c.toolTokens + c.summaryTokens + c.messageTokens)
})

test("estimateContextComposition: empty messages returns zeros", () => {
    const c = estimateContextComposition([])
    assert.equal(c.toolTokens, 0)
    assert.equal(c.codeTokens, 0)
    assert.equal(c.summaryTokens, 0)
    assert.equal(c.messageTokens, 0)
    assert.equal(c.total, 0)
    assert.deepEqual(c.largestRanges, [])
})

test("estimateContextComposition: pure text message counted in messageTokens", () => {
    const msg = mkText("m1", "x".repeat(400))
    const c = estimateContextComposition([msg])
    assert.equal(c.toolTokens, 0)
    assert.equal(c.codeTokens, 0)
    assert.equal(c.summaryTokens, 0)
    assert.equal(c.messageTokens, 100)
    assert.equal(c.total, 100)
})

test("estimateContextComposition: tool part counted in toolTokens", () => {
    const msg = mkTool("m1", '{"x":"y"}')
    const c = estimateContextComposition([msg])
    const expectedTool = Math.round(JSON.stringify({ type: "tool", tool: '{"x":"y"}' }).length / 4)
    assert.equal(c.toolTokens, expectedTool)
    assert.equal(c.messageTokens, 0)
    assert.equal(c.total, c.toolTokens)
})

test("estimateContextComposition: summary message counted in summaryTokens not messageTokens", () => {
    const summaryText = "x".repeat(400)
    const msg = mkSummary("b0", summaryText)
    const c = estimateContextComposition([msg])
    const expectedSummary = Math.round(("[Compressed conversation section]\n" + summaryText).length / 4)
    assert.equal(c.summaryTokens, expectedSummary)
    assert.equal(c.messageTokens, 0)
    assert.equal(c.total, c.summaryTokens)
})

test("estimateContextComposition: code blocks counted in codeTokens (subset of messageTokens)", () => {
    const code = "```\nconst x = 1\nconst y = 2\n```"
    const msg = mkText("m1", code)
    const c = estimateContextComposition([msg])
    assert.ok(c.codeTokens > 0, "code tokens should be detected")
    assert.ok(c.messageTokens >= c.codeTokens, "messageTokens includes code")
    assert.equal(c.total, c.messageTokens)
})

test("estimateContextComposition: total = system + tool + summary + message (no assistant data → system=0)", () => {
    const msgs = [
        mkText("m1", "hello world"),
        mkTool("m2", '{"a":1}'),
        mkSummary("b0", "recap text"),
        mkText("m3", "```\ncode\n```"),
    ]
    const c = estimateContextComposition(msgs)
    assert.equal(c.total, c.toolTokens + c.summaryTokens + c.messageTokens)
})

test("estimateContextComposition: largestRanges excludes summaries", () => {
    const msgs = [
        mkText("m1", "x".repeat(2400)),
        mkSummary("b0", "y".repeat(4000)),
    ]
    const c = estimateContextComposition(msgs)
    assert.equal(c.largestRanges.length, 1)
    assert.equal(c.largestRanges[0].ref, "?")
})

test("estimateContextComposition: largestToolRanges separate from largestCodeRanges", () => {
    const codeMsg = mkText("m1", "```\n" + "x".repeat(2400) + "\n```")
    const toolMsg = mkTool("m2", '{"big":"' + "x".repeat(2400) + '"}')
    const c = estimateContextComposition([codeMsg, toolMsg])
    assert.ok(c.largestToolRanges.length >= 1)
    assert.ok(c.largestCodeRanges.length >= 1)
})

test("estimateContextComposition: largestMessageRanges excludes messages with code", () => {
    const codeMsg = mkText("m1", "```\ncode\n```")
    const textMsg = mkText("m2", "x".repeat(2400))
    const c = estimateContextComposition([codeMsg, textMsg])
    assert.equal(c.largestMessageRanges.length, 1)
    assert.equal(c.largestMessageRanges[0].ref, "?")
})

test("estimateContextComposition: resolves ref from state.messageIds.byRawId", () => {
    const msg = mkText("raw-id-1", "x".repeat(2400))
    const state = { messageIds: { byRawId: new Map([["raw-id-1", "m00001"]]), byRef: new Map(), nextRef: 2 } } as any
    const c = estimateContextComposition([msg], state)
    assert.equal(c.largestRanges[0].ref, "m00001")
})

function mkCompress(id: string, summary: string): WithParts {
    return {
        info: { id } as any,
        parts: [
            {
                type: "tool",
                tool: "compress",
                callID: "call-1",
                state: {
                    status: "completed",
                    input: { topic: "test topic", content: [{ startId: "m001", endId: "m002", summary }] },
                },
            } as any,
        ] as any,
    }
}

test("estimateContextComposition: compress tool summary counted in summaryTokens not toolTokens", () => {
    const summaryText = "x".repeat(4000)
    const msg = mkCompress("m1", summaryText)
    const c = estimateContextComposition([msg])
    const expectedSummary = Math.round(summaryText.length / 4)
    assert.ok(c.summaryTokens >= expectedSummary, `summaryTokens ${c.summaryTokens} should include summary text (${expectedSummary})`)
    assert.ok(c.toolTokens < expectedSummary, `toolTokens ${c.toolTokens} should be less than summary text`)
    assert.equal(c.total, c.toolTokens + c.summaryTokens + c.messageTokens)
})

test("estimateContextComposition: compress tool structural overhead counted in toolTokens", () => {
    const summaryText = "x".repeat(4000)
    const msg = mkCompress("m1", summaryText)
    const c = estimateContextComposition([msg])
    assert.ok(c.toolTokens > 0, "compress tool structural overhead should be counted as toolTokens")
    const toolBreakdown = c.toolTypeBreakdown.find((t) => t.tool === "compress")
    assert.ok(toolBreakdown, "compress should appear in toolTypeBreakdown")
    assert.ok(toolBreakdown!.tokens > 0, "compress breakdown should have tokens")
})

test("estimateContextComposition: compress with multiple content entries sums all summaries", () => {
    const summary1 = "a".repeat(2000)
    const summary2 = "b".repeat(3000)
    const msg = {
        info: { id: "m1" } as any,
        parts: [
            {
                type: "tool",
                tool: "compress",
                callID: "call-1",
                state: {
                    status: "completed",
                    input: {
                        topic: "multi",
                        content: [
                            { startId: "m001", endId: "m002", summary: summary1 },
                            { startId: "m003", endId: "m004", summary: summary2 },
                        ],
                    },
                },
            } as any,
        ] as any,
    } as WithParts
    const c = estimateContextComposition([msg])
    const expectedSummary = Math.round((summary1.length + summary2.length) / 4)
    assert.ok(c.summaryTokens >= expectedSummary, `summaryTokens ${c.summaryTokens} should include both summaries (${expectedSummary})`)
})

test("estimateContextComposition: compress tool without state.input falls back to toolTokens", () => {
    const msg = {
        info: { id: "m1" } as any,
        parts: [{ type: "tool", tool: "compress", callID: "call-1" } as any] as any,
    } as WithParts
    const c = estimateContextComposition([msg])
    assert.equal(c.summaryTokens, 0)
    assert.ok(c.toolTokens > 0, "compress without input should be all toolTokens")
    assert.equal(c.total, c.toolTokens)
})

test("estimateContextComposition: non-compress tools unaffected by summary classification", () => {
    const msg = mkTool("m1", '{"data":"' + "x".repeat(4000) + '"}')
    const c = estimateContextComposition([msg])
    assert.equal(c.summaryTokens, 0, "non-compress tools should not produce summaryTokens")
    const expectedTool = Math.round(JSON.stringify({ type: "tool", tool: { data: "x".repeat(4000) } }).length / 4)
    assert.ok(c.toolTokens > 0)
    assert.equal(c.total, c.toolTokens)
})

test("estimateContextComposition: prefers cached state.systemPromptTokens over degraded estimate (#255)", () => {
    const userText = "later turn user message"
    const messages = [
        {
            info: { id: "u2", role: "user" } as any,
            parts: [{ type: "text", text: userText }] as any,
        },
        mkAssistantWithTokens(200_000),
    ]
    const state = {
        systemPromptTokens: 10_000,
        messageIds: { byRawId: new Map(), byRef: new Map(), nextRef: 2 },
    } as any
    const c = estimateContextComposition(messages, state)
    assert.equal(c.systemTokens, 10_000, "systemTokens must come from cached state, not the degraded estimate")
    assert.equal(c.total, 10_000 + c.toolTokens + c.summaryTokens + c.messageTokens)
})

test("estimateContextComposition: falls back to fresh estimate when cache is undefined (#255)", () => {
    const userText = "later turn user message"
    const messages = [
        {
            info: { id: "u2", role: "user" } as any,
            parts: [{ type: "text", text: userText }] as any,
        },
        mkAssistantWithTokens(200_000),
    ]
    const state = {
        systemPromptTokens: undefined,
        messageIds: { byRawId: new Map(), byRef: new Map(), nextRef: 2 },
    } as any
    const c = estimateContextComposition(messages, state)
    assert.equal(c.systemTokens, 200_000 - countTokens(userText))
})

test("cacheSystemPromptTokens: does not overwrite stable positive cache with degraded estimate (#255)", () => {
    const state = { systemPromptTokens: 10_000 } as any
    const degraded = [
        {
            info: { id: "u2", role: "user" } as any,
            parts: [{ type: "text", text: "later turn user message" }] as any,
        },
        mkAssistantWithTokens(200_000),
    ]
    cacheSystemPromptTokens(state, degraded)
    assert.equal(state.systemPromptTokens, 10_000, "stable cache must survive degraded message arrays")
})

test("cacheSystemPromptTokens: writes initial estimate when cache is undefined (#255)", () => {
    const state = { systemPromptTokens: undefined } as any
    const firstTurn = [
        {
            info: { id: "u1", role: "user" } as any,
            parts: [{ type: "text", text: "first task" }] as any,
        },
        mkAssistantWithTokens(10_000),
    ]
    cacheSystemPromptTokens(state, firstTurn)
    assert.equal(state.systemPromptTokens, 10_000 - countTokens("first task"))
})

test("cacheSystemPromptTokens: keeps undefined when no reliable assistant token data (#255)", () => {
    const state = { systemPromptTokens: undefined } as any
    cacheSystemPromptTokens(state, [mkText("u1", "no assistant yet")])
    assert.equal(state.systemPromptTokens, undefined)
})

