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
import { Logger } from "../lib/logger"

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
