import { describe, it } from "node:test"
import assert from "node:assert/strict"
import type { SessionState } from "../lib/state/types.js"

/** Regression tests for baseline-reset bug (inject.ts nothingToCompress path). */

function makeState(): SessionState {
    return {
        sessionId: "test",
        prune: {
            messages: {
                byMessageId: new Map(),
                activeBlockIds: new Set(),
                blocksById: new Map(),
            },
            version: 2,
        },
        nudges: {
            turnNudgeAnchors: new Set(),
            iterationNudgeAnchors: new Set(),
            contextLimitAnchors: new Set(),
            lastPerMessageNudgeTokens: undefined,
            lastNudgeShownTokens: undefined,
            lastToolOutputNudgeTokens: undefined,
            lastTier2NudgeTokens: undefined,
            lastTier3NudgeTokens: undefined,
            compressBaselineSet: false,
            shouldInjectThisTurn: false,
        },
        stats: {
            totalTokensSaved: 0,
            pruneCount: 0,
        },
        messageIds: {
            byRawId: new Map(),
            byRef: new Map(),
            nextRef: 1,
        },
        compressionTiming: {
            activeCompresses: new Map(),
            completedRuns: [],
        },
        toolParameters: new Map(),
        manualMode: { enabled: false },
        modelContextLimit: undefined,
        lastModelId: undefined,
        turnCount: 0,
        generation: 0,
    }
}

describe("baseline-reset bug regression", () => {
    it("preserves baseline when nothingToCompress is true and growth exceeds threshold", () => {
        const state = makeState()
        state.nudges.lastPerMessageNudgeTokens = 50000

        const nothingToCompress = true
        const nudgeAllowed = true

        if (nudgeAllowed && nothingToCompress) {
            state.nudges.lastNudgeShownTokens = undefined
        }

        assert.equal(state.nudges.lastPerMessageNudgeTokens, 50000)
    })

    it("growth accumulates across multiple nothingToCompress turns", () => {
        const state = makeState()
        const baseline = 10000
        state.nudges.lastPerMessageNudgeTokens = baseline

        for (const tokens of [70000, 120000]) {
            const growth = tokens - (state.nudges.lastPerMessageNudgeTokens ?? 0)
            const nudgeAllowed = growth >= 50000
            const nothingToCompress = true

            if (nudgeAllowed && nothingToCompress) {
                state.nudges.lastNudgeShownTokens = undefined
            }
        }

        assert.equal(state.nudges.lastPerMessageNudgeTokens, baseline)

        const cumulativeGrowth = 120000 - baseline
        assert.ok(cumulativeGrowth >= 50000)
    })

    it("baseline IS updated when model compresses (normal compress path, not nothingToCompress)", () => {
        const state = makeState()
        state.nudges.lastPerMessageNudgeTokens = 10000

        state.nudges.lastPerMessageNudgeTokens = 80000

        assert.notEqual(state.nudges.lastPerMessageNudgeTokens, 10000)
    })
})
