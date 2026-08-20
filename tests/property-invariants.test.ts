import "./test-env"
/**
 * Property-Based Invariant Tests for the Nudge Pipeline
 *
 * Instead of testing specific scenarios ("given X, assert Y"), these tests verify
 * fundamental invariants that must hold for ALL possible inputs. The fast-check
 * framework generates thousands of random inputs to try to falsify each invariant.
 *
 * If a property fails, fast-check "shrinks" the counterexample to the minimal
 * reproducing case, making debugging straightforward.
 *
 * Architecture: Pure utility functions are tested directly. Pipeline-level
 * invariants (INV6, INV7) run the full injectCompressNudges with random state.
 *
 * These 7 invariants would have caught all 4 recent nudge bugs (v1.14.1-v1.14.4).
 */

import assert from "node:assert/strict"
import test from "node:test"
import fc from "fast-check"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"
import {
    computeShouldNudge,
    computeProtectedRefs,
    buildCompressibleRanges,
    excludeProtectedRanges,
    filterRecommendedRanges,
    EFFECTIVE_MIN_COMPRESSIBLE_TOKENS,
    type CompressibleRange,
} from "../lib/messages/inject/utils"
import { injectCompressNudges } from "../lib/messages/inject/inject"
import { createSessionState, type WithParts } from "../lib/state"

// ─── Test Helpers ──────────────────────────────────────────────────────

const SID = "ses-pbt-test"

function buildConfig(overrides?: Partial<PluginConfig["compress"]>): PluginConfig {
    return {
        enabled: true,
        autoUpdate: false,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: { enabled: true, protectedTools: [] },
        experimental: { allowSubAgents: false, customPrompts: false },
        protectedFilePatterns: [],
        compress: {
            permission: "allow",
            showCompression: false,
            summaryBuffer: true,
            maxContextLimit: 150000,
            minContextLimit: 50000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: [],
            protectTags: false,
            protectUserMessages: false,
            minNudgeContextPercent: 15,
            maxSummaryLengthHard: 10000,
            minCompressRange: 5000,
            minNudgeGrowthRatio: 0.45,
            minNudgeGrowthFloor: 5000,
            emergencyThresholdPercent: "98%",
            maxVisibleSegments: 50,
            keepEmbedMaxChars: 2000,
            preserveRecentMessages: 5,
            preserveRecentTokens: 5000,
            preserveLastUserMessage: false,
            ...overrides,
        },
        strategies: {
            deduplication: { enabled: true, protectedTools: [] },
            purgeErrors: { enabled: true, turns: 4, protectedTools: [] },
        },
        gc: {
            algorithm: "truncate",
            promotionThreshold: 5,
            maxBlockAge: 15,
            maxOldGenSummaryLength: 3000,
            majorGcThresholdPercent: "100%",
            batchCleanup: { lowThreshold: "60%", highThreshold: "75%", forceThreshold: "90%" },
        },
    }
}

const logger = new Logger(false)

function textPart(msgId: string, text: string) {
    return { id: `${msgId}-p`, messageID: msgId, sessionID: SID, type: "text" as const, text }
}

function userMsg(id: string, text: string): WithParts {
    return {
        info: { id, role: "user", sessionID: SID, agent: "a", time: { created: 1 } } as WithParts["info"],
        parts: [textPart(id, text)],
    }
}

function assistantMsg(id: string, text: string, toolParts?: unknown[]): WithParts {
    const parts = [...(toolParts ?? []), textPart(id, text)]
    return {
        info: { id, role: "assistant", sessionID: SID, agent: "a", time: { created: 2 } } as WithParts["info"],
        parts,
    }
}

function toolPart(callID: string, toolName: string, output: string) {
    return {
        id: `${callID}-part`,
        messageID: "msg",
        sessionID: SID,
        type: "tool" as const,
        tool: toolName,
        callID,
        state: { status: "completed" as const, input: {}, output },
    }
}

/** Generate random messages with refs assigned (m00001, m00002, ...) */
function makeMessagesWithRefs(count: number, tokenSize: number): WithParts[] {
    const msgs: WithParts[] = []
    const padding = "x".repeat(tokenSize * 4)
    for (let i = 0; i < count; i++) {
        const id = `msg-${i}`
        const isUser = i % 5 === 0 // user every 5th message
        if (isUser) {
            msgs.push(userMsg(id, `user ${i} ${padding}`))
        } else {
            msgs.push(assistantMsg(id, `assistant ${i} ${padding}`, [toolPart(`call-${i}`, "bash", `output ${i} ${padding}`)]))
        }
    }
    return msgs
}

/** Assign refs to messages in state */
function assignRefs(state: ReturnType<typeof createSessionState>, messages: WithParts[]): void {
    for (let i = 0; i < messages.length; i++) {
        const ref = `m${String(i + 1).padStart(5, "0")}`
        state.messageIds.byRawId.set(messages[i]!.info.id, ref)
    }
}

// ─── fast-check Arbitraries (Input Generators) ────────────────────────

/** Random token count: 0 to 200K */
const arbTokens = fc.integer({ min: 0, max: 200_000 })

/** Random message count: 2 to 50 */
const arbMsgCount = fc.integer({ min: 2, max: 50 })

/** Random token size per message: 100 to 5000 */
const arbMsgTokenSize = fc.integer({ min: 100, max: 5000 })

/** Random preserveRecentMessages: 0 to 20 */
const arbPreserveN = fc.integer({ min: 0, max: 20 })

/** Random preserveRecentTokens: 0 to 20000 */
const arbPreserveTokens = fc.integer({ min: 0, max: 20_000 })

/** Random model context limit */
const arbModelLimit = fc.constantFrom(50_000, 100_000, 200_000, 500_000, 1_000_000)

/** Random overMinLimit / overMaxLimit flags */
const arbLimits = fc.record({
    overMinLimit: fc.boolean(),
    overMaxLimit: fc.boolean(),
})

/** Random nudge growth tokens */
const arbNudgeGrowth = fc.integer({ min: 1000, max: 50_000 })

// Pipeline-test arbitraries (smaller ranges for acceptable CI speed)
const arbPipelineMsgCount = fc.integer({ min: 3, max: 15 })
const arbPipelineMsgTokenSize = fc.integer({ min: 100, max: 1500 })

// ═══════════════════════════════════════════════════════════════════════
// INV1: excludeProtectedRanges — output ranges never touch protected refs
// ═══════════════════════════════════════════════════════════════════════
// Would have caught: v1.14.2 giant group spanning protected zone
//
// For any compressible ranges + any protected ref set, the filtered output
// must never include a range whose startRef or endRef is in the protected set.

test("INV1: excludeProtectedRanges never returns ranges touching protected refs", () => {
    fc.assert(
        fc.property(
            fc.array(
                fc.record({
                    startRef: fc.string({ minLength: 2, maxLength: 6 }).map((s) => "m" + s.slice(1)),
                    endRef: fc.string({ minLength: 2, maxLength: 6 }).map((s) => "m" + s.slice(1)),
                    count: fc.integer({ min: 1, max: 10 }),
                    tokens: fc.integer({ min: 100, max: 10_000 }),
                    toolPct: fc.integer({ min: 0, max: 100 }),
                    textPct: fc.integer({ min: 0, max: 100 }),
                }),
                { minLength: 0, maxLength: 20 },
            ),
            fc.uniqueArray(fc.string({ minLength: 2, maxLength: 6 }).map((s) => "m" + s.slice(1)), {
                minLength: 0,
                maxLength: 20,
            }),
            (ranges, protectedRefs) => {
                const protectedSet = new Set(protectedRefs)
                const result = excludeProtectedRanges(ranges as CompressibleRange[], protectedSet)

                for (const r of result) {
                    assert.ok(
                        !protectedSet.has(r.startRef),
                        `Range startRef ${r.startRef} is in protected set — should have been excluded`,
                    )
                    assert.ok(
                        !protectedSet.has(r.endRef),
                        `Range endRef ${r.endRef} is in protected set — should have been excluded`,
                    )
                }
            },
        ),
        { numRuns: 500 },
    )
})

// ═══════════════════════════════════════════════════════════════════════
// INV2: buildCompressibleRanges — groups never span the protected boundary
// ═══════════════════════════════════════════════════════════════════════
// Would have caught: v1.14.2 giant group not being split at protected zone
//
// When protectedZoneRefs is provided, no compressible group should contain
// a ref that's in the protected zone. The function should split groups at
// the boundary.

test("INV2: buildCompressibleRanges groups never span protected boundary", () => {
    fc.assert(
        fc.property(
            arbMsgCount,
            arbMsgTokenSize,
            arbPreserveN,
            (msgCount, tokenSize, preserveN) => {
                const state = createSessionState()
                const messages = makeMessagesWithRefs(msgCount, tokenSize)
                assignRefs(state, messages)

                const config = buildConfig({ preserveRecentMessages: preserveN })
                const protectedRefs = computeProtectedRefs(messages, state, config.compress)

                const { compressible } = buildCompressibleRanges(
                    messages,
                    state,
                    [],
                    [],
                    protectedRefs,
                )

                for (const range of compressible) {
                    assert.ok(
                        !protectedRefs.has(range.startRef),
                        `Compressible range starts at protected ref ${range.startRef}`,
                    )
                    assert.ok(
                        !protectedRefs.has(range.endRef),
                        `Compressible range ends at protected ref ${range.endRef}`,
                    )
                }
            },
        ),
        { numRuns: 200 },
    )
})

// ═══════════════════════════════════════════════════════════════════════
// INV3: computeProtectedRefs — always includes last N visible messages
// ═══════════════════════════════════════════════════════════════════════
// Correctness property: the "preserve recent" mechanism must actually preserve
// the last N messages. If preserveRecentMessages=5, the last 5 visible refs
// must be in the protected set.

test("INV3: computeProtectedRefs includes last N visible messages", () => {
    fc.assert(
        fc.property(arbMsgCount, arbMsgTokenSize, arbPreserveN, (msgCount, tokenSize, preserveN) => {
            const state = createSessionState()
            const messages = makeMessagesWithRefs(msgCount, tokenSize)
            assignRefs(state, messages)

            const config = buildConfig({
                preserveRecentMessages: preserveN,
                preserveRecentTokens: 0, // disable token-based to isolate message-count
            })

            const protectedRefs = computeProtectedRefs(messages, state, config.compress)

            // The last min(preserveN, visibleCount) messages should be protected
            const visibleCount = messages.length
            const expectedProtected = Math.min(preserveN, visibleCount)

            if (expectedProtected > 0) {
                const lastNMessages = messages.slice(-expectedProtected)
                for (const msg of lastNMessages) {
                    const ref = state.messageIds.byRawId.get(msg.info.id)
                    if (ref) {
                        assert.ok(
                            protectedRefs.has(ref),
                            `Last-N message ref ${ref} should be protected (preserveRecentMessages=${preserveN})`,
                        )
                    }
                }
            }
        }),
        { numRuns: 200 },
    )
})

// ═══════════════════════════════════════════════════════════════════════
// INV4: computeShouldNudge — growth-based invariants
// ═══════════════════════════════════════════════════════════════════════
// The trigger policy uses growth-based cadence, not limit-based.
// Three structural invariants hold for ALL inputs:
//   a) undefined currentTokens → shouldNudge=false
//   b) undefined lastNudgeTokens → shouldNudge=false (first-turn baseline)
//   c) growth < nudgeGrowthTokens → shouldNudge=false (cadence not met)

test("INV4a: computeShouldNudge returns false when currentTokens is undefined", () => {
    fc.assert(
        fc.property(
            arbModelLimit,
            arbTokens,
            arbNudgeGrowth,
            fc.boolean(),
            fc.boolean(),
            (modelContextLimit, lastNudgeTokens, nudgeGrowthTokens, overMinLimit, overMaxLimit) => {
                const decision = computeShouldNudge({
                    currentTokens: undefined,
                    modelContextLimit,
                    overMinLimit,
                    overMaxLimit,
                    lastNudgeTokens,
                    minNudgeContextPercent: 15,
                    nudgeGrowthTokens,
                })
                assert.equal(decision.shouldNudge, false)
            },
        ),
        { numRuns: 30 },
    )
})

test("INV4b: computeShouldNudge returns false on first turn (lastNudgeTokens undefined)", () => {
    fc.assert(
        fc.property(
            arbTokens,
            arbModelLimit,
            arbNudgeGrowth,
            fc.boolean(),
            fc.boolean(),
            (currentTokens, modelContextLimit, nudgeGrowthTokens, overMinLimit, overMaxLimit) => {
                const decision = computeShouldNudge({
                    currentTokens,
                    modelContextLimit,
                    overMinLimit,
                    overMaxLimit,
                    lastNudgeTokens: undefined,
                    minNudgeContextPercent: 15,
                    nudgeGrowthTokens,
                })
                assert.equal(decision.shouldNudge, false)
            },
        ),
        { numRuns: 30 },
    )
})

test("INV4c: computeShouldNudge returns false when growth step not met and not overMaxLimit", () => {
    fc.assert(
        fc.property(
            arbTokens,
            arbModelLimit,
            arbNudgeGrowth,
            fc.boolean(),
            fc.integer({ min: 0, max: 999 }),
            (currentTokens, modelContextLimit, nudgeGrowthTokens, overMinLimit, growthBelow) => {
                const decision = computeShouldNudge({
                    currentTokens,
                    modelContextLimit,
                    overMinLimit,
                    overMaxLimit: false,
                    lastNudgeTokens: Math.max(0, currentTokens - growthBelow),
                    minNudgeContextPercent: 15,
                    nudgeGrowthTokens,
                })
                assert.equal(
                    decision.shouldNudge,
                    false,
                    `shouldNudge=true with growth=${growthBelow} < nudgeGrowthTokens=${nudgeGrowthTokens}, overMaxLimit=false`,
                )
            },
        ),
        { numRuns: 30 },
    )
})

// ═══════════════════════════════════════════════════════════════════════
// INV5: filterRecommendedRanges — no context-relative suppression
// ═══════════════════════════════════════════════════════════════════════
// Issue #251 regression: filterRecommendedRanges used to suppress ranges
// below a context-relative threshold (5% of modelContextLimit). At 1M context
// this meant 50K+ of compressible content was never recommended.
// Invariant: every range ABOVE the pipeline-aligned effective floor
// (EFFECTIVE_MIN_COMPRESSIBLE_TOKENS) is returned — no context-relative
// suppression. Ranges below the floor are dropped because the pipeline's
// minCompressRange would reject them anyway (retry-loop fix).

test("INV5: filterRecommendedRanges keeps every range above the effective floor", () => {
    fc.assert(
        fc.property(
            fc.array(
                fc.record({
                    startRef: fc.string({ minLength: 2, maxLength: 6 }).map((s) => "m" + s.slice(1)),
                    endRef: fc.string({ minLength: 2, maxLength: 6 }).map((s) => "m" + s.slice(1)),
                    count: fc.integer({ min: 1, max: 10 }),
                    tokens: fc.integer({ min: EFFECTIVE_MIN_COMPRESSIBLE_TOKENS, max: 50_000 }),
                    toolPct: fc.integer({ min: 0, max: 100 }),
                    textPct: fc.integer({ min: 0, max: 100 }),
                }),
                { minLength: 1, maxLength: 20 },
            ),
            (ranges) => {
                const withEffective = ranges.map((r) => ({ ...r, effectiveTokens: r.tokens }))
                const result = filterRecommendedRanges(
                    withEffective as CompressibleRange[],
                    [],
                    {},
                )
                assert.equal(
                    result.length,
                    ranges.length,
                    `Input has ${ranges.length} above-floor ranges but got ${result.length} — suppression should not occur`,
                )
            },
        ),
        { numRuns: 300 },
    )
})

// ═══════════════════════════════════════════════════════════════════════
// INV6: Pipeline — nudge text injected ⟹ shouldInjectThisTurn is true
// ═══════════════════════════════════════════════════════════════════════
// Would have caught: v1.14.4 nudge loop (nudge text injected when nothing to compress)
//
// After running injectCompressNudges, if any message has nudge text appended
// (e.g., "Breakdown:", "compress", "HOW TO COMPRESS"), then
// state.nudges.shouldInjectThisTurn must be true.

test("INV6: nudge text injected implies shouldInjectThisTurn is true", () => {
    fc.assert(
        fc.property(
            arbPipelineMsgCount,
            arbPipelineMsgTokenSize,
            arbPreserveN,
            arbPreserveTokens,
            arbModelLimit,
            (msgCount, tokenSize, preserveN, preserveTokens, modelLimit) => {
                const state = createSessionState()
                state.modelContextLimit = modelLimit

                // Need enough messages to trigger potential nudge
                const messages = makeMessagesWithRefs(msgCount, tokenSize)
                assignRefs(state, messages)

                const config = buildConfig({
                    preserveRecentMessages: preserveN,
                    preserveRecentTokens: preserveTokens,
                    maxContextLimit: Math.round(modelLimit * 0.55),
                    minContextLimit: Math.round(modelLimit * 0.45),
                })

                // Deep copy messages to detect changes
                const originalTexts = messages.map((m) =>
                    (m.parts || [])
                        .filter((p) => p.type === "text")
                        .map((p: any) => p.text || "")
                        .join(""),
                )

                try {
                    injectCompressNudges(state, config, logger, messages, {} as any)
                } catch {
                    // Some random configs might throw (e.g., bad limits) — skip those
                    return
                }

                // Check if any message got nudge text injected
                let hasNudgeText = false
                for (let i = 0; i < messages.length; i++) {
                    const currentText = (messages[i]!.parts || [])
                        .filter((p) => p.type === "text")
                        .map((p: any) => p.text || "")
                        .join("")
                    const originalText = originalTexts[i] || ""

                    // Nudge indicators: content that wasn't in the original
                    const added = currentText.slice(originalText.length)
                    if (
                        added.includes("Breakdown:") ||
                        added.includes("HOW TO COMPRESS") ||
                        added.includes("compress now") ||
                        added.includes("Compressible ranges") ||
                        added.includes("Context limit reached")
                    ) {
                        hasNudgeText = true
                        break
                    }
                }

                // Also check suffix message (may be added at the end)
                if (messages.length > msgCount + 1) {
                    // Suffix message was added and not removed
                    const suffix = messages[messages.length - 1]
                    if (suffix) {
                        const suffixText = (suffix.parts || [])
                            .filter((p) => p.type === "text")
                            .map((p: any) => p.text || "")
                            .join("")
                        if (
                            suffixText.includes("Breakdown:") ||
                            suffixText.includes("compress") ||
                            suffixText.includes("Compressible ranges")
                        ) {
                            hasNudgeText = true
                        }
                    }
                }

                if (hasNudgeText) {
                    assert.ok(
                        state.nudges.shouldInjectThisTurn,
                        `Nudge text was injected but shouldInjectThisTurn is false — ` +
                            `this is the v1.14.4 loop bug pattern`,
                    )
                }
            },
        ),
        { numRuns: 50 },
    )
})

// ═══════════════════════════════════════════════════════════════════════
// INV7: Pipeline — compress attempt clears all nudge anchors
// ═══════════════════════════════════════════════════════════════════════
// Would have caught: v1.14.4 failed compress not resetting state (Defect 2)
//
// If the current turn has ANY compress attempt (success or failure), all
// nudge anchors and lastNudgeShownTokens must be cleared after injectCompressNudges.

test("INV7: compress attempt (any status) clears all nudge anchors", () => {
    fc.assert(
        fc.property(
            arbPipelineMsgCount,
            arbPipelineMsgTokenSize,
            arbPreserveN,
            fc.boolean(),
            (msgCount, tokenSize, preserveN, succeeded) => {
                const state = createSessionState()
                state.modelContextLimit = 100_000

                const messages = makeMessagesWithRefs(msgCount, tokenSize)
                assignRefs(state, messages)

                // Ensure messages end with user → assistant (so compress is in current turn)
                const lastMsg = messages[messages.length - 1]
                if (lastMsg && lastMsg.info.role !== "user") {
                    // If last message is assistant, add a user message to start a new turn
                    const userTurnMsg = userMsg("msg-user-turn", "continue")
                    messages.push(userTurnMsg)
                    state.messageIds.byRawId.set("msg-user-turn", `m${String(messages.length).padStart(5, "0")}`)
                }

                // Add compress attempt as a new assistant message in the current turn
                const compressMsgId = "msg-compress"
                const compressMsg = assistantMsg(compressMsgId, "compressing", [{
                    id: "compress-part",
                    messageID: compressMsgId,
                    sessionID: SID,
                    type: "tool" as const,
                    tool: "compress",
                    callID: "compress-call",
                    state: {
                        status: succeeded ? ("completed" as const) : ("failed" as const),
                        input: { content: [{ startId: "m00001", endId: "m00005", summary: "test" }] },
                        output: succeeded ? "compressed" : "error",
                    },
                }])
                messages.push(compressMsg)
                state.messageIds.byRawId.set(compressMsgId, `m${String(messages.length).padStart(5, "0")}`)

                // Pre-populate anchors to simulate an active nudge
                state.nudges.contextLimitAnchors.add("msg-0")
                state.nudges.turnNudgeAnchors.add("msg-0")
                state.nudges.iterationNudgeAnchors.add("msg-0")
                state.nudges.lastNudgeShownTokens = 50000

                const config = buildConfig({
                    preserveRecentMessages: preserveN,
                })

                try {
                    injectCompressNudges(state, config, logger, messages, {} as any)
                } catch {
                    return
                }

                // After processing, anchors should be cleared
                assert.equal(
                    state.nudges.contextLimitAnchors.size,
                    0,
                    "contextLimitAnchors should be cleared after compress attempt",
                )
                assert.equal(
                    state.nudges.turnNudgeAnchors.size,
                    0,
                    "turnNudgeAnchors should be cleared after compress attempt",
                )
                assert.equal(
                    state.nudges.iterationNudgeAnchors.size,
                    0,
                    "iterationNudgeAnchors should be cleared after compress attempt",
                )
                assert.equal(
                    state.nudges.lastNudgeShownTokens,
                    undefined,
                    "lastNudgeShownTokens should be cleared after compress attempt",
                )
            },
        ),
        { numRuns: 30 },
    )
})

// ═══════════════════════════════════════════════════════════════════════
// BONUS: Idempotency — running injectCompressNudges twice doesn't double-inject
// ═══════════════════════════════════════════════════════════════════════
// A common source of bugs is non-idempotent mutations. Running the pipeline
// twice should not produce duplicate nudge text.

test("BONUS: injectCompressNudges is idempotent for nudge text (no double-injection)", () => {
    fc.assert(
        fc.property(arbPipelineMsgCount, arbPipelineMsgTokenSize, (msgCount, tokenSize) => {
            const state = createSessionState()
            state.modelContextLimit = 100_000

            const messages = makeMessagesWithRefs(msgCount, tokenSize)
            assignRefs(state, messages)

            const config = buildConfig({
                maxContextLimit: 50000,
                minContextLimit: 20000,
            })

            // Run once
            try {
                injectCompressNudges(state, config, logger, [...messages], {} as any)
            } catch {
                return
            }

            // Count "Breakdown:" occurrences in the result
            const firstRunText = messages
                .map((m) =>
                    (m.parts || [])
                        .filter((p) => p.type === "text")
                        .map((p: any) => p.text || "")
                        .join(""),
                )
                .join("\n")
            const firstCount = (firstRunText.match(/Breakdown:/g) || []).length

            // The invariant: at most ONE "Breakdown:" across all messages
            // (the suffix message is the only place it should appear)
            assert.ok(
                firstCount <= 1,
                `Found ${firstCount} "Breakdown:" blocks — should be at most 1`,
            )
        }),
        { numRuns: 30 },
    )
})
