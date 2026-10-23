import assert from "node:assert/strict"
import test from "node:test"
import { createSessionState, type WithParts } from "../lib/state"
import { assignMessageRefs } from "../lib/message-ids"
import { buildSearchContext } from "../lib/compress/search"
import {
    SMART_PLAN_TTL_MS,
    armBestSmartPlan,
    clearSmartPlan,
    clearSmartPlanSession,
    getSmartPlan,
    recordVisibleMessages,
    validateSmartPlan,
} from "../lib/compress/smart-plan"

function message(id: string, role: "user" | "assistant", text: string, created: number): WithParts {
    return {
        info: { id, role, sessionID: "smart-plan-test", time: { created } } as WithParts["info"],
        parts: [{ type: "text", text } as any],
    }
}

function context(minCompressRange = 10) {
    const state = createSessionState()
    state.sessionId = "smart-plan-test"
    const messages = [
        message("a", "assistant", "A".repeat(20), 1),
        message("b", "assistant", "B".repeat(40), 2),
        message("c", "user", "latest request", 3),
    ]
    assignMessageRefs(state, messages)
    return {
        state,
        messages,
        search: buildSearchContext(state, messages),
        ctx: {
            state,
            config: {
                protectedFilePatterns: [],
                compress: {
                    minCompressRange,
                    protectedTools: [],
                    protectUserMessages: false,
                    preserveRecentMessages: 0,
                    preserveRecentTokens: 0,
                    preserveLastUserMessage: true,
                    lastSegmentSoftBlock: false,
                },
            },
            logger: { warn() {}, debug() {} },
        } as any,
    }
}

test("smart plan selects the oldest eligible range using exact effective characters", () => {
    const { ctx, search } = context()
    const plan = armBestSmartPlan(
        "smart-plan-test",
        [
            {
                startRef: "m00002",
                endRef: "m00003",
                count: 2,
                tokens: 20,
                effectiveTokens: 10,
                toolPct: 0,
                textPct: 100,
            },
            {
                startRef: "m00001",
                endRef: "m00001",
                count: 1,
                tokens: 5,
                effectiveTokens: 5,
                toolPct: 0,
                textPct: 100,
            },
        ],
        search,
        ctx,
        undefined,
        100,
    )
    assert.equal(plan?.startId, "m00001")
    assert.equal(plan?.endId, "m00001")
    assert.equal(plan?.exactChars, 20)
})

test("smart plan excludes dangerous and exact-under-minimum candidates", () => {
    const { ctx, search } = context(30)
    const plan = armBestSmartPlan(
        "smart-plan-test",
        [
            {
                startRef: "m00001",
                endRef: "m00001",
                count: 1,
                tokens: 5,
                effectiveTokens: 5,
                toolPct: 0,
                textPct: 100,
            },
            {
                startRef: "m00002",
                endRef: "m00002",
                count: 1,
                tokens: 10,
                effectiveTokens: 10,
                toolPct: 0,
                textPct: 100,
                dangerous: true,
            },
        ],
        search,
        ctx,
    )
    assert.equal(plan, undefined)
    assert.equal(getSmartPlan("smart-plan-test"), undefined)
})

test("smart plan rejects altered bounds, stale structure, and expiry", () => {
    const { ctx, search } = context()
    const arm = (now: number) =>
        armBestSmartPlan(
            "smart-plan-test",
            [
                {
                    startRef: "m00001",
                    endRef: "m00001",
                    count: 1,
                    tokens: 5,
                    effectiveTokens: 5,
                    toolPct: 0,
                    textPct: 100,
                },
            ],
            search,
            ctx,
            undefined,
            now,
        )!

    let plan = arm(100)
    assert.throws(
        () =>
            validateSmartPlan(
                "smart-plan-test",
                "m00002",
                plan.endId,
                plan.messageIds,
                plan.exactChars,
                0,
                101,
            ),
        /does not match/,
    )
    assert.doesNotThrow(() =>
        validateSmartPlan(
            "smart-plan-test",
            plan.startId,
            plan.endId,
            plan.messageIds,
            plan.exactChars,
            0,
            101,
        ),
    )

    plan = arm(200)
    assert.throws(
        () =>
            validateSmartPlan(
                "smart-plan-test",
                plan.startId,
                plan.endId,
                plan.messageIds,
                plan.exactChars,
                1,
                201,
            ),
        /stale/,
    )

    plan = arm(300)
    assert.throws(
        () =>
            validateSmartPlan(
                "smart-plan-test",
                plan.startId,
                plan.endId,
                plan.messageIds,
                plan.exactChars,
                0,
                300 + SMART_PLAN_TTL_MS + 1,
            ),
        /expired/,
    )
    clearSmartPlan("smart-plan-test")
})

test("smart plan chooses oldest safe visible range", () => {
    const { ctx, search, messages } = context()
    recordVisibleMessages("smart-plan-test", messages.slice(0, 2))
    const plan = armBestSmartPlan(
        "smart-plan-test",
        [
            {
                startRef: "m00001",
                endRef: "m00001",
                count: 1,
                tokens: 5,
                effectiveTokens: 5,
                toolPct: 0,
                textPct: 100,
            },
            {
                startRef: "m00002",
                endRef: "m00002",
                count: 1,
                tokens: 10,
                effectiveTokens: 10,
                toolPct: 0,
                textPct: 100,
            },
        ],
        search,
        ctx,
        new Set(["a", "b"]),
    )
    assert.equal(plan?.startId, "m00001")
})

test("smart plan merges adjacent artificial splits to satisfy an 80K floor", () => {
    const { state, messages, ctx } = context(80_000)
    messages[0].parts = [{ type: "text", text: "A".repeat(45_000) } as any]
    messages[1].parts = [{ type: "text", text: "B".repeat(45_000) } as any]
    const rebuilt = buildSearchContext(state, messages)
    const plan = armBestSmartPlan(
        "smart-plan-test",
        [
            {
                startRef: "m00001",
                endRef: "m00001",
                count: 1,
                tokens: 11_250,
                effectiveTokens: 11_250,
                toolPct: 0,
                textPct: 100,
            },
            {
                startRef: "m00002",
                endRef: "m00002",
                count: 1,
                tokens: 11_250,
                effectiveTokens: 11_250,
                toolPct: 0,
                textPct: 100,
            },
            {
                startRef: "m00003",
                endRef: "m00003",
                count: 1,
                tokens: 3,
                effectiveTokens: 0,
                toolPct: 0,
                textPct: 100,
                dangerous: true,
            },
        ],
        rebuilt,
        ctx,
    )
    assert.equal(plan?.startId, "m00001")
    assert.equal(plan?.endId, "m00002")
    assert.equal(plan?.exactChars, 90_000)
    clearSmartPlanSession("smart-plan-test")
    assert.equal(getSmartPlan("smart-plan-test"), undefined)
})

test("smart plan refuses ranges outside the model-visible snapshot", () => {
    const { ctx, search } = context()
    const plan = armBestSmartPlan(
        "smart-plan-test",
        [
            {
                startRef: "m00001",
                endRef: "m00001",
                count: 1,
                tokens: 5,
                effectiveTokens: 5,
                toolPct: 0,
                textPct: 100,
            },
        ],
        search,
        ctx,
        new Set(["b"]),
    )
    assert.equal(plan, undefined)
})
