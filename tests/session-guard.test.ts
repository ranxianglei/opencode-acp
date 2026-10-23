import "./test-env"
/**
 * Tests for [Issue #404]: serialize same-session state initialization and
 * transforms.
 *
 * Covers:
 *   - withSessionGuard FIFO ordering per session (and cross-session independence)
 *   - guard release on rejection
 *   - concurrent getOrCreate coalescing into a single initialization
 *     (the stale-snapshot regression from the issue)
 *   - failed init coalescing semantics (waiters resolve like today)
 *   - read-modify-write safety: a stale transaction cannot overwrite newer
 *     committed state while serialized
 *   - transform-handler wiring: concurrent same-session requests serialize
 *     through the guard (end-to-end, real createChatMessageTransformHandler)
 *   - restoreCompressionState preserves shared compressionTiming identity
 */

import assert from "node:assert/strict"
import test, { beforeEach, afterEach } from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
    SessionStateRegistry,
    createSessionGuard,
    createSessionState,
    saveSessionState,
    type WithParts,
} from "../lib/state"
import { snapshotCompressionState, restoreCompressionState } from "../lib/compress/pipeline"
import { createCompressRangeTool } from "../lib/compress/range"
import { createDecompressTool } from "../lib/compress/decompress"
import { createChatMessageTransformHandler } from "../lib/hooks"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"
import { singletonRegistry } from "./registry-stub"

const MESSAGES: WithParts[] = []

let tempDir: string
let prevData: string | undefined
let prevConfig: string | undefined

beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "acp-guard-"))
    prevData = process.env.XDG_DATA_HOME
    prevConfig = process.env.XDG_CONFIG_HOME
    process.env.XDG_DATA_HOME = tempDir
    process.env.XDG_CONFIG_HOME = tempDir
})

afterEach(() => {
    if (prevData === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = prevData
    if (prevConfig === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = prevConfig
    rmSync(tempDir, { recursive: true, force: true })
})

test("withSessionGuard serializes same-session tasks in FIFO order", async () => {
    const guard = createSessionGuard()
    const order: string[] = []
    const run = (id: string, holdMs: number) =>
        guard("s1", async () => {
            order.push(`start-${id}`)
            await new Promise((r) => setTimeout(r, holdMs))
            order.push(`end-${id}`)
        })
    await Promise.all([run("A", 30), run("B", 5), run("C", 1)])
    assert.deepEqual(order, ["start-A", "end-A", "start-B", "end-B", "start-C", "end-C"])
})

test("withSessionGuard does not block other sessions", async () => {
    const guard = createSessionGuard()
    let s1Finished = false
    const t1 = guard("s1", async () => {
        await new Promise((r) => setTimeout(r, 60))
        s1Finished = true
    })
    await new Promise((r) => setTimeout(r, 10))
    // s2 must not wait behind s1's long task.
    const t2 = guard("s2", async () => "ok")
    assert.equal(await t2, "ok")
    assert.equal(s1Finished, false)
    await t1
    assert.equal(s1Finished, true)
})

test("withSessionGuard releases the lock when fn rejects and passes the value through", async () => {
    const guard = createSessionGuard()
    await assert.rejects(guard("s", async () => {
        throw new Error("boom")
    }), /boom/)
    assert.equal(await guard("s", async () => 42), 42)
    assert.equal(await guard("s", () => 7), 7)
})

test("concurrent getOrCreate coalesces into one initialization (stale-snapshot regression)", async () => {
    // Seed persisted state so partial initialization is observable: a caller
    // that early-returns before loadSessionState completes sees no limit.
    const logger = new Logger(false)
    const seed = createSessionState()
    seed.sessionId = "session-x"
    seed.modelContextLimit = 200000
    await saveSessionState(seed, logger)

    let sessionGets = 0
    const client = {
        session: {
            get: async () => {
                sessionGets++
                await new Promise((r) => setTimeout(r, 25))
                return { data: { parentID: null } }
            },
        },
    }

    const registry = new SessionStateRegistry(new Logger(false))
    // Capture what the second caller observes AT RETURN time — the pre-fix
    // early-return handed out the state before loadSessionState finished, so
    // this read saw the pre-load snapshot (undefined limit).
    let bLimitAtReturn: number | undefined
    const pA = registry.getOrCreate(client, "session-x", MESSAGES)
    const pB = registry.getOrCreate(client, "session-x", MESSAGES).then((s) => {
        bLimitAtReturn = s.modelContextLimit
        return s
    })
    const pC = registry.getOrCreate(client, "session-x", MESSAGES)
    const [a, b, c] = await Promise.all([pA, pB, pC])

    assert.equal(a, b)
    assert.equal(b, c)
    assert.equal(sessionGets, 1)
    // Every waiter must observe the fully initialized state, not a snapshot
    // taken before the persisted data was loaded.
    assert.equal(bLimitAtReturn, 200000)
    assert.equal(a.modelContextLimit, 200000)
    assert.equal(b.modelContextLimit, 200000)
    assert.equal(c.modelContextLimit, 200000)
})

test("failed init coalesces: all waiters resolve with the same partially-initialized state", async () => {
    const client = {
        session: {
            get: async () => {
                throw new Error("host down")
            },
        },
    }
    const registry = new SessionStateRegistry(new Logger(false))
    const results = await Promise.allSettled([
        registry.getOrCreate(client, "s-fail", MESSAGES),
        registry.getOrCreate(client, "s-fail", MESSAGES),
    ])
    assert.equal(results[0].status, "fulfilled")
    assert.equal(results[1].status, "fulfilled")
    const a = (results[0] as PromiseFulfilledResult<ReturnType<SessionStateRegistry["getOrCreate"]>>).value
    const b = (results[1] as PromiseFulfilledResult<ReturnType<SessionStateRegistry["getOrCreate"]>>).value
    assert.equal(a, b)
    // sessionId is assigned synchronously at init start (pre-existing semantics).
    assert.equal(a.sessionId, "s-fail")
})

test("serialized read-modify-write: stale transaction cannot clobber newer committed state", async () => {
    const guard = createSessionGuard()
    const state = { value: 0 }
    const persistLog: number[] = []
    const persist = () => {
        persistLog.push(state.value)
    }

    // T_old snapshots, does slow work, then commits snapshot+1.
    const tOld = guard("s", async () => {
        const snap = state.value
        await new Promise((r) => setTimeout(r, 40))
        state.value = snap + 1
        persist()
    })
    // T_new queues behind T_old and does its own read-modify-write.
    const tNew = guard("s", async () => {
        state.value = state.value * 10 + 5
        persist()
    })
    await Promise.all([tOld, tNew])

    // Serialized order: old commits 0+1=1, then new reads 1 → 15.
    // An unsynchronized interleaving could persist [5, 1] (stale last write).
    assert.deepEqual(persistLog, [1, 15])
    assert.equal(state.value, 15)
})

test("restoreCompressionState preserves the shared compressionTiming object identity", async () => {
    const state = createSessionState()
    const timingBefore = state.compressionTiming
    assert.ok(timingBefore !== null)

    const snapshot = snapshotCompressionState(state)
    state.prune.messages.activeBlockIds.add(99)
    restoreCompressionState(state, snapshot)

    assert.equal(state.prune.messages.activeBlockIds.size, 0)
    assert.equal(state.compressionTiming, timingBefore)
})

test("concurrent transforms on one session serialize through the guard (wiring regression)", async () => {
    // End-to-end wiring check for [Issue #404]: two chat-message-transform
    // requests for the SAME session must not interleave their
    // init→mutate→persist sections. Pre-fix, the second request's getOrCreate
    // hit the sessionId fast path mid-init and ran its pipeline concurrently
    // on partially initialized state (stale-snapshot corruption). We observe
    // guard acquisition order through the registry seam: serialized handlers
    // produce strictly nested enter/exit pairs; unsynchronized ones interleave
    // (or, before the guard existed, never acquire at all).
    const logger = new Logger(false)
    const seed = createSessionState()
    seed.sessionId = "session-wire"
    seed.modelContextLimit = 200000
    // [FIX #312] A persisted limit only survives the transform's reconciliation
    // when its model identity matches the request; seed the pair like a real
    // session so the loaded value is what we assert on.
    seed.modelProviderID = "test-provider"
    seed.modelID = "test-model"
    await saveSessionState(seed, logger)

    const client = {
        session: {
            get: async () => {
                // Hold the init window open so concurrent requests genuinely
                // overlap (pre-fix interleaving requires this window).
                await new Promise((r) => setTimeout(r, 25))
                return { data: { parentID: null } }
            },
        },
    }

    const config: PluginConfig = {
        enabled: true,
        autoUpdate: true,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: { enabled: true, protectedTools: [] },
        experimental: { allowSubAgents: false, customPrompts: false },
        protectedFilePatterns: [],
        compress: {
            mode: "message",
            permission: "allow",
            showCompression: false,
            summaryBuffer: true,
            candidates: true,
            maxContextLimit: 150000,
            minContextLimit: 50000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: ["task"],
            protectTags: false,
            protectUserMessages: false,
            reasoning: { drop: true, threshold: 2048 },
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

    const registry = new SessionStateRegistry(logger)
    const events: string[] = []
    const originalGuard = registry.withSessionGuard
    // Markers are pushed INSIDE the locked fn: "enter" means the task actually
    // started running under the lock (not merely arrived at the FIFO queue), so
    // strictly nested pairs prove serialization while interleave proves overlap.
    registry.withSessionGuard = <T>(sessionId: string, fn: () => Promise<T> | T): Promise<T> =>
        originalGuard(sessionId, async (): Promise<T> => {
            events.push(`enter:${sessionId}`)
            try {
                return await fn()
            } finally {
                events.push(`exit:${sessionId}`)
            }
        })

    const handler = createChatMessageTransformHandler(
        client,
        registry,
        logger,
        config,
        prompts,
        hostPermissions,
    )

    const mkMessages = (): WithParts[] => [
        {
            info: {
                id: "u1",
                sessionID: "session-wire",
                role: "user",
                agent: "assistant",
                model: { providerID: "test-provider", modelID: "test-model" },
                time: { created: Date.now() },
            } as WithParts["info"],
            parts: [
                {
                    type: "text",
                    text: "hello",
                    id: "u1-p1",
                    sessionID: "session-wire",
                    messageID: "u1",
                },
            ],
        },
        {
            info: {
                id: "a1",
                sessionID: "session-wire",
                role: "assistant",
                agent: "assistant",
                parentID: "parent-placeholder",
                modelID: "test-model",
                providerID: "test-provider",
                mode: "normal",
                path: { cwd: "/", root: "/" },
                summary: false,
                cost: 0,
                tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
                time: { created: Date.now() },
            } as WithParts["info"],
            parts: [
                {
                    type: "step-start",
                    id: "a1-ss",
                    sessionID: "session-wire",
                    messageID: "a1",
                },
                {
                    type: "text",
                    text: "hi there",
                    id: "a1-p1",
                    sessionID: "session-wire",
                    messageID: "a1",
                },
            ],
        },
        {
            info: {
                id: "u2",
                sessionID: "session-wire",
                role: "user",
                agent: "assistant",
                model: { providerID: "test-provider", modelID: "test-model" },
                time: { created: Date.now() },
            } as WithParts["info"],
            parts: [
                {
                    type: "text",
                    text: "again",
                    id: "u2-p1",
                    sessionID: "session-wire",
                    messageID: "u2",
                },
            ],
        },
    ]

    await Promise.all([handler({}, { messages: mkMessages() }), handler({}, { messages: mkMessages() })])

    // Same-session work ran strictly serially (nested pairs, no overlap). An
    // unsynchronized pre-fix interleave would look like enter,enter,exit,exit —
    // or produce no events at all before the guard existed.
    assert.deepEqual(events, [
        "enter:session-wire",
        "exit:session-wire",
        "enter:session-wire",
        "exit:session-wire",
    ])
    // Both requests observed fully initialized state (persisted limit loaded),
    // and refs were assigned for the shared input.
    const state = registry.get("session-wire")
    assert.ok(state)
    assert.equal(state.modelContextLimit, 200000)
    assert.equal(state.messageIds.byRef.get("m00001"), "u1")
    assert.equal(state.messageIds.byRef.get("m00003"), "u2")
})

test("[Issue #410] an abandoned compress permission prompt does not wedge the session", async () => {
    // Regression for #410: PR #408 wraps the whole compress/decompress execute() in
    // withSessionGuard. When the body's first step is the interactive toolCtx.ask()
    // permission prompt, a host that abandons the tool execution (session deleted /
    // turn aborted / continuation dropped) leaves ask() unsettled — and pre-fix the
    // guard was held ACROSS that await, so the per-session chain never released and
    // every later same-session operation hung forever. The fix moves ask() OUTSIDE the
    // guard; this asserts a subsequent same-session op still acquires the guard and
    // completes. Verified to FAIL on pre-fix code (ask inside the guard) and PASS post-fix.
    const sessionID = "ses_abandoned_ask"
    const rawMessages: WithParts[] = [
        {
            info: {
                id: "m-a1",
                role: "user",
                sessionID,
                agent: "assistant",
                model: { providerID: "anthropic", modelID: "claude-test" },
                time: { created: 1 },
            } as WithParts["info"],
            parts: [{ id: "p1", messageID: "m-a1", sessionID, type: "text" as const, text: "first" }],
        },
        {
            info: {
                id: "m-a2",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
            } as WithParts["info"],
            parts: [{ id: "p2", messageID: "m-a2", sessionID, type: "text" as const, text: "second" }],
        },
    ]

    const state = createSessionState()
    state.sessionId = sessionID
    const logger = new Logger(false)
    const registry = singletonRegistry(state)

    const tool = createCompressRangeTool({
        client: {
            session: {
                messages: async () => ({ data: rawMessages }),
                get: async () => ({ data: { parentID: null } }),
            },
        },
        registry,
        logger,
        config: {
            enabled: true,
            debug: false,
            pruneNotification: "off",
            pruneNotificationType: "chat",
            commands: { enabled: true, protectedTools: [] },
            experimental: { allowSubAgents: true, customPrompts: false },
            protectedFilePatterns: [],
            compress: {
                permission: "allow",
                showCompression: false,
                maxContextLimit: 150000,
                minContextLimit: 50000,
                nudgeFrequency: 5,
                iterationNudgeThreshold: 15,
                nudgeForce: "soft",
                protectedTools: [],
                protectTags: false,
                protectUserMessages: false,
                lastSegmentSoftBlock: false,
            },
            gc: {
                algorithm: "truncate",
                promotionThreshold: 5,
                maxBlockAge: 15,
                maxOldGenSummaryLength: 3000,
                majorGcThresholdPercent: "100%",
                batchCleanup: { lowThreshold: "60%", highThreshold: "75%", forceThreshold: "90%" },
            },
        } as unknown as PluginConfig,
        prompts: {
            reload() {},
            getRuntimePrompts() {
                return { compressRange: "", compressMessage: "" }
            },
        },
    } as any)

    // The host abandons the tool execution while the permission dialog is open:
    // ask() is entered but never settles (no resolve, no reject).
    let askEntered = false
    const toolCtx = {
        ask: async () => {
            askEntered = true
            return new Promise<void>(() => {})
        },
        metadata: () => {},
        sessionID,
        messageID: "msg-compress",
    }

    void tool.execute(
        { topic: "abandoned", content: [{ startId: "m00001", endId: "m00002", summary: "captured" }] },
        toolCtx as any,
    )

    // Let the abandoned execution reach its permission step.
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(askEntered, true, "abandoned execution must have reached the permission prompt")

    // A subsequent same-session operation (transforms / tools / event-hook saves all
    // funnel through withSessionGuard) must still acquire the guard and finish. Pre-fix
    // this awaited the abandoned execution's never-settling ask() forever and timed out.
    let nextCompleted = false
    const outcome = await Promise.race([
        registry
            .withSessionGuard(sessionID, async () => {
                nextCompleted = true
                return "ok"
            })
            .then(() => "completed"),
        new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 300)),
    ])

    assert.equal(outcome, "completed", "same-session op must complete despite the abandoned tool execution")
    assert.equal(nextCompleted, true)
})

test("[Issue #410] an abandoned decompress permission prompt does not wedge the session", async () => {
    // Mirror of the compress-range regression above for the second fixed code path
    // (lib/compress/decompress.ts). Same mechanism: the interactive ask() now runs
    // OUTSIDE withSessionGuard, so a host that abandons the call before it settles
    // never acquires the lock and a concurrent same-session op still completes.
    // Config mirrors tests/compress-range.test.ts buildConfig() (complete incl. gc);
    // kept inline to stay consistent with this file's other wiring tests.
    const sessionID = "ses_abandoned_ask_decompress"
    const rawMessages: WithParts[] = [
        {
            info: {
                id: "m-d1",
                role: "user",
                sessionID,
                agent: "assistant",
                model: { providerID: "anthropic", modelID: "claude-test" },
                time: { created: 1 },
            } as WithParts["info"],
            parts: [{ id: "dp1", messageID: "m-d1", sessionID, type: "text" as const, text: "first" }],
        },
        {
            info: {
                id: "m-d2",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
            } as WithParts["info"],
            parts: [{ id: "dp2", messageID: "m-d2", sessionID, type: "text" as const, text: "second" }],
        },
    ]

    const state = createSessionState()
    state.sessionId = sessionID
    const logger = new Logger(false)
    const registry = singletonRegistry(state)

    const tool = createDecompressTool({
        client: {
            session: {
                messages: async () => ({ data: rawMessages }),
                get: async () => ({ data: { parentID: null } }),
            },
        },
        registry,
        logger,
        config: {
            enabled: true,
            debug: false,
            pruneNotification: "off",
            pruneNotificationType: "chat",
            commands: { enabled: true, protectedTools: [] },
            experimental: { allowSubAgents: true, customPrompts: false },
            protectedFilePatterns: [],
            compress: {
                permission: "allow",
                showCompression: false,
                maxContextLimit: 150000,
                minContextLimit: 50000,
                nudgeFrequency: 5,
                iterationNudgeThreshold: 15,
                nudgeForce: "soft",
                protectedTools: [],
                protectTags: false,
                protectUserMessages: false,
                lastSegmentSoftBlock: false,
            },
            gc: {
                algorithm: "truncate",
                promotionThreshold: 5,
                maxBlockAge: 15,
                maxOldGenSummaryLength: 3000,
                majorGcThresholdPercent: "100%",
                batchCleanup: { lowThreshold: "60%", highThreshold: "75%", forceThreshold: "90%" },
            },
        } as unknown as PluginConfig,
        prompts: {
            reload() {},
            getRuntimePrompts() {
                return { compressRange: "", compressMessage: "" }
            },
        },
    } as any)

    let askEntered = false
    const toolCtx = {
        ask: async () => {
            askEntered = true
            return new Promise<void>(() => {})
        },
        metadata: () => {},
        sessionID,
        messageID: "msg-decompress",
    }

    void tool.execute({ blockId: "b0" }, toolCtx as any)

    await new Promise((r) => setTimeout(r, 30))
    assert.equal(askEntered, true, "abandoned execution must have reached the permission prompt")

    let nextCompleted = false
    const outcome = await Promise.race([
        registry
            .withSessionGuard(sessionID, async () => {
                nextCompleted = true
                return "ok"
            })
            .then(() => "completed"),
        new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 300)),
    ])

    assert.equal(outcome, "completed", "same-session op must complete despite the abandoned tool execution")
    assert.equal(nextCompleted, true)
})
