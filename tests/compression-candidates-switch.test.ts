/**
 * compress.candidates switch tests (PR #341 opt-in gating).
 *
 * §5.7.1 compliance:
 * - Multi-turn: the growth-cycle test calls injectCompressNudges twice in the
 *   same test sharing one SessionState.
 * - Side-effect assertions: asserts both nudge text presence AND
 *   lastPerMessageNudgeTokens after each call.
 * - Production config: the growth-cycle test uses preserveRecentMessages: 20
 *   (production default).
 * - Growth cycle: baseline → growth → nudge → new baseline → growth → nudge.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { injectCompressNudges } from "../lib/messages/inject/inject"
import { buildStatusReport } from "../lib/compress/status"
import { assignMessageRefs } from "../lib/message-ids"
import { createSessionState, type WithParts, type SessionState } from "../lib/state"
import { Logger } from "../lib/logger"
import type { PluginConfig } from "../lib/config"

const SID = "ses_switch_test"

function config(overrides: Partial<PluginConfig["compress"]> = {}): PluginConfig {
    return {
        enabled: true,
        autoUpdate: false,
        debug: false,
        logLevel: "silent",
        allowSubAgents: true,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: { enabled: true, protectedTools: [] },
        experimental: { allowSubAgents: true, customPrompts: false },
        protectedFilePatterns: [],
        compress: {
            mode: "range",
            permission: "allow",
            showCompression: false,
            summaryBuffer: true,
            candidates: overrides.candidates ?? false,
            maxContextLimit: 150000,
            minContextLimit: 50000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: [],
            protectTags: false,
            protectUserMessages: false,
            lastSegmentSoftBlock: false,
            preserveRecentMessages: overrides.preserveRecentMessages ?? 0,
            minCompressRange: 100,
            nudgeGrowthTokens: overrides.nudgeGrowthTokens ?? 1000,
            minNudgeGrowthFloor: overrides.minNudgeGrowthFloor ?? 100,
            minNudgeGrowthRatio: overrides.minNudgeGrowthRatio ?? 0.1,
            minNudgeContextPercent: 0,
            reasoning: { drop: "off", threshold: 0 },
        },
        gc: {
            algorithm: "truncate",
            promotionThreshold: 5,
            maxBlockAge: 15,
            maxOldGenSummaryLength: 3000,
            majorGcThresholdPercent: "100%",
            batchCleanup: { lowThreshold: "60%", highThreshold: "75%", forceThreshold: "90%" },
        },
        qualityGate: { enabled: false, algorithm: "rouge-recall-v1", algorithms: {} },
        messageFilters: { enabled: false, filters: {} },
    }
}

function textMessage(id: string, role: "user" | "assistant", text: string): WithParts {
    return {
        info: {
            id,
            role,
            sessionID: SID,
            agent: "test",
            time: { created: 1 },
            ...(role === "user" ? { model: { providerID: "test", modelID: "test" } } : {}),
        } as WithParts["info"],
        parts: [{ id: `${id}-part`, messageID: id, sessionID: SID, type: "text", text } as any],
    }
}

function toolMessage(
    id: string,
    role: "user" | "assistant",
    callID: string,
    tool: string,
    output: string,
): WithParts {
    return {
        info: {
            id,
            role,
            sessionID: SID,
            agent: "test",
            time: { created: 1 },
            ...(role === "user" ? { model: { providerID: "test", modelID: "test" } } : {}),
        } as WithParts["info"],
        parts: [
            {
                id: `${id}-part`,
                messageID: id,
                sessionID: SID,
                type: "tool",
                tool,
                callID,
                state: { status: "completed", input: {}, output },
            } as any,
        ],
    }
}

function setup(messages: WithParts[]): SessionState {
    const state = createSessionState()
    state.sessionId = SID
    assignMessageRefs(state, messages)
    return state
}

function setTokens(message: WithParts, input: number, output = 100): void {
    ;(message.info as any).tokens = {
        input,
        output,
        reasoning: 0,
        cache: { read: 0, write: 0 },
    }
}

function suffixTextOf(messages: WithParts[]): string {
    const suffix = messages[messages.length - 1]
    return (
        suffix?.parts
            .filter((part) => part.type === "text")
            .map((part) => (part as any).text)
            .join("\n") ?? ""
    )
}

function buildHistory(): WithParts[] {
    const messages: WithParts[] = [textMessage("u0", "user", "start")]
    for (let i = 0; i < 8; i++) {
        messages.push(toolMessage(`t${i}`, "assistant", `c${i}`, "bash", "o".repeat(4000)))
        setTokens(messages[messages.length - 1]!, 3000, 200)
    }
    messages.push(textMessage("tail", "assistant", "current work"))
    setTokens(messages[messages.length - 1]!, 3000, 200)
    return messages
}

test("default (candidates off) nudge renders legacy ranges, never MICRO/EPISODE", () => {
    const messages = buildHistory()
    const state = setup(messages)
    state.modelContextLimit = 100_000
    state.nudges.lastPerMessageNudgeTokens = 1000

    injectCompressNudges(
        state,
        config({ minContextLimit: 100, maxContextLimit: 90_000 }),
        new Logger(false),
        messages,
        {} as any,
    )

    assert.equal(state.nudges.shouldInjectThisTurn, true)
    const text = suffixTextOf(messages)
    assert.match(text, /Compress all ranges in one call/)
    assert.match(text, /m\d+–m\d+/)
    assert.doesNotMatch(text, /MICRO/)
    assert.doesNotMatch(text, /EPISODE/)
    assert.doesNotMatch(text, /You may batch selected independent candidates/)
    // Side-effect assertion (#207 anti-regression): a growth nudge without a
    // compression must NOT advance the baseline — otherwise the nudge starves.
    // Baseline only re-establishes when context actually shrinks (compression).
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 1000)
})

test("opt-in (candidates on) nudge renders MICRO/EPISODE candidates", () => {
    const messages = buildHistory()
    const state = setup(messages)
    state.modelContextLimit = 100_000
    state.nudges.lastPerMessageNudgeTokens = 1000

    injectCompressNudges(
        state,
        config({ candidates: true, minContextLimit: 100, maxContextLimit: 90_000 }),
        new Logger(false),
        messages,
        {} as any,
    )

    assert.equal(state.nudges.shouldInjectThisTurn, true)
    const text = suffixTextOf(messages)
    assert.match(text, /MICRO|EPISODE/)
    assert.match(text, /You may batch selected independent candidates/)
    assert.doesNotMatch(text, /Compress all ranges in one call/)
})

test("default (candidates off) acp_status scope:uncompressed shows ranges, not candidates", () => {
    const messages = buildHistory()
    const state = setup(messages)

    const status = buildStatusReport(
        { state, config: config({ minContextLimit: 100 }) },
        messages.slice(0, -1),
    )
    assert.match(status, /COMPRESSIBLE RANGES/i)
    assert.doesNotMatch(status, /^\s+(MICRO|EPISODE)\s/m)
})

test("opt-in (candidates on) acp_status scope:uncompressed shows candidates", () => {
    const messages = buildHistory()
    const state = setup(messages)

    const status = buildStatusReport(
        { state, config: config({ candidates: true, minContextLimit: 100 }) },
        messages.slice(0, -1),
    )
    assert.match(status, /^\s+(MICRO|EPISODE)\s/m)
})

test("growth cycle with preserveRecentMessages=20 (production config): off-mode nudges fire, baseline resets, and fire again", () => {
    // >20 messages so the preserve-recent-20 window still leaves a
    // compressible head — the production nothingToCompress scenario (#207).
    const messages: WithParts[] = [textMessage("u0", "user", "start")]
    for (let i = 0; i < 25; i++) {
        messages.push(toolMessage(`t${i}`, "assistant", `c${i}`, "bash", "o".repeat(4000)))
        setTokens(messages[messages.length - 1]!, 2500, 200)
    }
    messages.push(textMessage("tail", "assistant", "current work"))
    // Tail usage record represents the whole current context size (~65K of a
    // 100K limit, under the 95% maxContextLimit ceiling). Capture by reference:
    // injectCompressNudges appends a synthetic suffix message after it.
    const tail = messages[messages.length - 1]!
    setTokens(tail, 65_000, 200)
    const state = setup(messages)
    state.modelContextLimit = 100_000
    const cfg = config({
        preserveRecentMessages: 20,
        minContextLimit: 100,
        maxContextLimit: 95_000,
        nudgeGrowthTokens: 1000,
        minNudgeGrowthFloor: 100,
        minNudgeGrowthRatio: 0.1,
    })

    // Turn 1 — no baseline yet: inject establishes it, no nudge fires.
    injectCompressNudges(state, cfg, new Logger(false), messages, {} as any)
    assert.equal(state.nudges.shouldInjectThisTurn, false)
    assert.ok(state.nudges.lastPerMessageNudgeTokens !== undefined)
    const baseline = state.nudges.lastPerMessageNudgeTokens

    // Turn 2 — growth past threshold: nudge fires with legacy range text.
    state.nudges.lastPerMessageNudgeTokens = 50_000
    injectCompressNudges(state, cfg, new Logger(false), messages, {} as any)
    assert.equal(state.nudges.shouldInjectThisTurn, true)
    const turn2Text = suffixTextOf(messages)
    assert.match(turn2Text, /Compress all ranges in one call/)
    assert.doesNotMatch(turn2Text, /MICRO|EPISODE/)

    // Simulate the model actually compressing: context shrinks (usage record
    // of the newest message now reflects the smaller post-compress context).
    setTokens(tail, 45_000, 200)
    state.nudges.lastPerMessageNudgeTokens = undefined
    state.nudges.lastNudgeShownTokens = undefined
    state.nudges.shouldInjectThisTurn = false

    // Turn 3 — post-compression: new baseline establishes, no nudge yet.
    injectCompressNudges(state, cfg, new Logger(false), messages, {} as any)
    assert.equal(state.nudges.shouldInjectThisTurn, false)
    assert.ok(state.nudges.lastPerMessageNudgeTokens !== undefined)
    assert.ok(state.nudges.lastPerMessageNudgeTokens < 50_000) // new, lower baseline

    // Turn 4 — renewed growth past threshold: nudge fires again.
    state.nudges.lastPerMessageNudgeTokens = 38_000
    injectCompressNudges(state, cfg, new Logger(false), messages, {} as any)
    assert.equal(state.nudges.shouldInjectThisTurn, true)
    assert.match(suffixTextOf(messages), /Compress all ranges in one call/)
})
