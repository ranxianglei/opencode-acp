/**
 * Regression tests for issue #421: V2 native compaction copies the
 * compaction REQUEST's own token usage onto the summary assistant. The old
 * cacheSystemPromptTokens calibration then stored ~653K phantom "system"
 * tokens, driving the hard-guard budget negative (400000 − 653136 − 32768 =
 * −285904) while the real post-compaction wire was far smaller.
 *
 * Fix under test:
 *  - calibrateSystemOverhead skips summary assistants and pre-compaction
 *    usage, and subtracts the full wire-visible prefix (not just the first
 *    user text).
 *  - cacheSystemPromptTokens floors the calibration with a measured
 *    current-wire system count (V2 feeds event.system + rendered prompt).
 *  - resetOnCompaction and mid-session model switches invalidate the cache.
 *  - Status output distinguishes [measured] vs [estimated] overhead.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { cacheSystemPromptTokens } from "../lib/ui/utils"
import { calibrateSystemOverhead, countAllMessageTokens, countTokens } from "../lib/token-utils"
import { resetOnCompaction } from "../lib/state/utils"
import { createSessionState, type SessionState, type WithParts } from "../lib/state"
import type { PluginConfig } from "../lib/config"
import { createChatMessageTransformHandler } from "../lib/hooks"
import { Logger } from "../lib/logger"
import { estimateContextComposition } from "../lib/messages/inject/utils"
import { createTestRegistry } from "./registry-stub"

// ─── Factories ──────────────────────────────────────────────────────────────

const T = 5_000_000 // compaction time marker

// sessionID is required by isMessageWithInfo (lib/messages/shape.ts) — without
// it host-side predicates like isIgnoredUserMessage treat the message as
// malformed and refuse to classify it.
function mkUser(id: string, text: string, created: number): WithParts {
    return {
        info: { id, role: "user", sessionID: "s1", time: { created } } as any,
        parts: [{ type: "text", text }] as any,
    } as WithParts
}

function mkAssistant(
    id: string,
    input: number,
    opts: { summary?: boolean; created?: number; text?: string } = {},
): WithParts {
    return {
        info: {
            id,
            role: "assistant",
            sessionID: "s1",
            summary: opts.summary === true ? true : undefined,
            time: { created: opts.created ?? T },
            tokens: { input, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
        } as any,
        parts: opts.text !== undefined ? ([{ type: "text", text: opts.text }] as any) : ([] as any),
    } as WithParts
}

function mkFreshState(lastCompaction = 0): SessionState {
    const state = createSessionState()
    state.lastCompaction = lastCompaction
    return state
}

/** Post-compaction history shape as projected by lib/v2/projection: the
 * summary assistant carries the compaction request's usage verbatim. */
function postCompactionHistory(): WithParts[] {
    const summaryText = "checkpoint recap: " + "context ".repeat(200)
    return [
        mkAssistant("compaction-1", 653_137, { summary: true, created: T, text: summaryText }),
        mkUser("u-after", "continue", T + 1),
    ]
}

// ─── Calibration guards (the #421 repro) ─────────────────────────────────────

test("calibrateSystemOverhead: compaction summary usage never anchors calibration (#421 repro)", () => {
    const messages = postCompactionHistory()
    assert.equal(calibrateSystemOverhead({ lastCompaction: T }, messages), 0)
})

test("cacheSystemPromptTokens: fresh state right after native compaction stores no phantom overhead (#421 repro)", () => {
    const state = mkFreshState(T)
    cacheSystemPromptTokens(state, postCompactionHistory())
    assert.equal(
        state.systemPromptTokens,
        undefined,
        "no phantom 653136-style estimate may be cached",
    )
    assert.equal(state.systemPromptTokensSource, undefined)
})

test("calibrateSystemOverhead: post-compaction assistant calibrates to actual wire overhead (#421)", () => {
    const WIRE = 17_000
    const [summaryAssistant, user] = postCompactionHistory()
    const prefix = countAllMessageTokens(summaryAssistant) + countTokens("continue")
    const response = mkAssistant("a-after", prefix + WIRE, { created: T + 2 })
    const calibrated = calibrateSystemOverhead({ lastCompaction: T }, [
        summaryAssistant,
        user,
        response,
    ])
    assert.equal(calibrated, WIRE, "residual must equal system+tools, not include the summary text")
    // Hard-guard sanity: usable budget stays nonnegative at the reported limit.
    assert.ok(400_000 - calibrated - 32_768 > 0)
})

test("cacheSystemPromptTokens: reload after compaction recalibrates from the post-compaction anchor (#421)", () => {
    // Simulates a process restart: brand-new transient state, persisted
    // lastCompaction restored, projected history already contains the
    // post-compaction response with usage.
    const WIRE = 17_000
    const [summaryAssistant, user] = postCompactionHistory()
    const prefix = countAllMessageTokens(summaryAssistant) + countTokens("continue")
    const response = mkAssistant("a-after", prefix + WIRE, { created: T + 2 })
    const state = mkFreshState(T)
    cacheSystemPromptTokens(state, [summaryAssistant, user, response])
    assert.equal(state.systemPromptTokens, WIRE)
    assert.equal(state.systemPromptTokensSource, "heuristic")
})

test("calibrateSystemOverhead: pre-compaction assistants are stale anchors even without summary flag (#421)", () => {
    const oldAssistant = mkAssistant("a-old", 900_000, { created: T - 100 })
    const user = mkUser("u-after", "continue", T + 1)
    assert.equal(calibrateSystemOverhead({ lastCompaction: T }, [oldAssistant, user]), 0)
    // Without a recorded boundary the same message still calibrates (legacy behavior
    // preserved). The anchor sits at index 0, so nothing was wire-visible before its
    // prompt — "continue" arrived later and must NOT be subtracted.
    assert.equal(calibrateSystemOverhead({}, [oldAssistant, user]), 900_000)
})

test("calibrateSystemOverhead: subtracts full wire-visible prefix, not just first user text (#421)", () => {
    const earlyUser = mkUser("u1", "earlier question", 1)
    const earlyTool = {
        info: { id: "t1", role: "user", time: { created: 2 } } as any,
        parts: [
            {
                type: "tool",
                tool: "bash",
                callID: "c1",
                state: { status: "completed", input: {}, output: { text: "o".repeat(800) } },
            },
        ],
    } as unknown as WithParts
    const lateUser = mkUser("u2", "follow up", 3)
    const assistant = mkAssistant("a1", 50_000, { created: 4 })
    const expectedPrefix =
        countAllMessageTokens(earlyUser) +
        countAllMessageTokens(earlyTool) +
        countAllMessageTokens(lateUser)
    assert.equal(
        calibrateSystemOverhead({}, [earlyUser, earlyTool, lateUser, assistant]),
        50_000 - expectedPrefix,
    )
})

test("calibrateSystemOverhead: ignored user parts and ACP-owned notices are not wire-visible (#421)", () => {
    const ignored = {
        info: { id: "u-ig", role: "user", sessionID: "s1", time: { created: 1 } } as any,
        parts: [{ type: "text", text: "h".repeat(400), ignored: true }] as any,
    } as WithParts
    const noticeId = `msg_acp_notice_${"ab12cd34ef56ab78"}`
    const notice = {
        info: { id: noticeId, role: "user", sessionID: "s1", time: { created: 2 } } as any,
        parts: [{ type: "text", text: "n".repeat(400) }] as any,
    } as WithParts
    const realUser = mkUser("u1", "first task", 3)
    const assistant = mkAssistant("a1", 10_000, { created: 4 })
    assert.equal(
        calibrateSystemOverhead({}, [ignored, notice, realUser, assistant]),
        10_000 - countTokens("first task"),
    )
})

// ─── Measured floor (V2 current-wire accounting) ────────────────────────────

test("cacheSystemPromptTokens: measured current-wire tokens act as floor when no anchor exists yet (#421)", () => {
    const state = mkFreshState(T)
    cacheSystemPromptTokens(state, postCompactionHistory(), 17_000)
    assert.equal(state.systemPromptTokens, 17_000)
    assert.equal(state.systemPromptTokensSource, "measured")
})

test("cacheSystemPromptTokens: heuristic residual wins over a smaller measurement (#421)", () => {
    const state = mkFreshState(0)
    cacheSystemPromptTokens(
        state,
        [mkUser("u1", "first task", 1), mkAssistant("a1", 10_000, { created: 2 })],
        5_000,
    )
    assert.equal(state.systemPromptTokens, 10_000 - countTokens("first task"))
    assert.equal(state.systemPromptTokensSource, "heuristic")
})

test("cacheSystemPromptTokens: no anchor and no measurement keeps undefined (#421)", () => {
    const state = mkFreshState(T)
    cacheSystemPromptTokens(state, [mkUser("u1", "continue", T + 1)])
    assert.equal(state.systemPromptTokens, undefined)
    assert.equal(state.systemPromptTokensSource, undefined)
})

// ─── #255 compatibility (no false clearing) ─────────────────────────────────

test("cacheSystemPromptTokens: normal first turn still calibrates exactly as before (#255 compat)", () => {
    const state = mkFreshState(0)
    cacheSystemPromptTokens(state, [
        mkUser("u1", "first task", 1),
        mkAssistant("a1", 10_000, { created: 2 }),
    ])
    assert.equal(state.systemPromptTokens, 10_000 - countTokens("first task"))
    assert.equal(state.systemPromptTokensSource, "heuristic")
})

test("cacheSystemPromptTokens: stable positive cache survives later calls even with measured arg (#255, #421)", () => {
    const state = mkFreshState(0)
    state.systemPromptTokens = 12_345
    cacheSystemPromptTokens(state, postCompactionHistory(), 999_999)
    assert.equal(state.systemPromptTokens, 12_345, "stable cache must not be overwritten")
})

// ─── Invalidation paths ─────────────────────────────────────────────────────

test("resetOnCompaction: clears cached system overhead and provenance (#421)", () => {
    const state = createSessionState()
    state.systemPromptTokens = 5_000
    state.systemPromptTokensSource = "measured"
    resetOnCompaction(state)
    assert.equal(state.systemPromptTokens, undefined)
    assert.equal(state.systemPromptTokensSource, undefined)
})

// ─── Model-switch invalidation (full transform pipeline) ────────────────────

const SID = "session-421-model-switch"

function buildConfig(): PluginConfig {
    return {
        enabled: true,
        autoUpdate: false,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: { enabled: true, protectedTools: [] },
        allowSubAgents: false,
        experimental: { customPrompts: false },
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
    }
}

let modelSwitchMsgCounter = 0
function msUser(id: string, text: string, providerID: string, modelID: string): WithParts {
    return {
        info: {
            id,
            sessionID: SID,
            role: "user",
            agent: "assistant",
            time: { created: Date.now() + ++modelSwitchMsgCounter },
            model: { providerID, modelID },
        } as WithParts["info"],
        parts: [{ type: "text", text, id: `${id}-p1`, sessionID: SID, messageID: id }],
    }
}

function msAssistant(id: string, text: string): WithParts {
    return {
        info: {
            id,
            sessionID: SID,
            role: "assistant",
            agent: "assistant",
            parentID: "parent-placeholder",
            modelID: "model-a",
            providerID: "prov-a",
            mode: "normal",
            path: { cwd: "/", root: "/" },
            summary: false,
            cost: 0,
            tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: Date.now() },
        } as WithParts["info"],
        parts: [
            { type: "step-start", id: `${id}-ss`, sessionID: SID, messageID: id },
            { type: "text", text, id: `${id}-p1`, sessionID: SID, messageID: id },
        ],
    }
}

test("runMessageTransform: mid-session model switch invalidates cached system overhead (#421)", async () => {
    const state = createSessionState()
    state.sessionId = SID
    const logger = new Logger(false)
    const config = buildConfig()
    const client = { session: { get: async () => ({ data: { parentID: null } }) } }
    const prompts = {
        reload() {},
        getRuntimePrompts() {
            return {
                system: "ACP system",
                compressRange: "compress range",
                compressMessage: "compress message",
                contextLimitNudge: "nudge",
                turnNudge: "turn nudge",
                iterationNudge: "iteration nudge",
                manualExtension: "",
                subagentExtension: "",
            }
        },
    }
    const hostPermissions = { global: undefined, agents: {} }
    const registry = createTestRegistry(state)
    // Resolved catalog limits make runMessageTransform adopt requestModel into
    // state.modelID on every turn (transform.ts branch-1); without them the
    // one-shot else-branch leaves modelID stuck after the first switch.
    registry.recordModelLimit("prov-a", "model-a", 400_000)
    registry.recordModelLimit("prov-b", "model-b", 400_000)
    const handler = createChatMessageTransformHandler(
        client as any,
        registry,
        logger as any,
        config,
        prompts as any,
        hostPermissions as any,
    )

    // Turn 1 on model-a: initial calibration happens.
    const turnA: WithParts[] = [
        msUser("u1", "first task", "prov-a", "model-a"),
        msAssistant("a1", "Hi"),
    ]
    await handler({} as any, { messages: turnA } as any)
    assert.equal(state.modelID, "model-a")

    // Pin a stale value, then switch to model-b.
    state.systemPromptTokens = 999_999
    state.systemPromptTokensSource = "heuristic"
    const turnB: WithParts[] = [...turnA, msUser("u2", "switched models", "prov-b", "model-b")]
    await handler({} as any, { messages: turnB } as any)
    assert.equal(state.modelID, "model-b")
    assert.notEqual(
        state.systemPromptTokens,
        999_999,
        "stale pre-switch calibration must not survive a model switch",
    )
})

// ─── estimateContextComposition live fallback (#421 sibling) ────────────────

test("estimateContextComposition: live fallback honors compaction boundary when cache empty", () => {
    // After resetOnCompaction invalidates the cache (and before the next
    // transform re-caches it), estimateContextComposition falls back to a live
    // estimate. That fallback must pass state.lastCompaction, otherwise a
    // pre-compaction assistant (created before T, carrying the large pre-
    // compaction request usage) becomes the calibration anchor and the stale
    // overhead resurfaces in nudge/context-usage math.
    const state = mkFreshState(T)
    assert.equal(state.systemPromptTokens, undefined)
    const WIRE = 17_000
    const STALE = 300_000 // pre-compaction request usage carried by an old assistant
    const staleAssistant = mkAssistant("a-stale", STALE, { created: T - 2 })
    const user = mkUser("u-after", "continue", T + 1)
    const prefix = countAllMessageTokens(staleAssistant) + countTokens("continue")
    const response = mkAssistant("a-after", prefix + WIRE, { created: T + 2 })
    const composition = estimateContextComposition([staleAssistant, user, response], state)
    assert.equal(composition.systemTokens, WIRE)
    assert.notEqual(
        composition.systemTokens,
        STALE,
        "pre-compaction assistant usage must never calibrate the live fallback",
    )
})
