/**
 * Tests for the real SessionStateRegistry (not the test stub).
 *
 * Covers the acceptance criteria from devlog/2026-07-24_per-session-state/REQ.md:
 *   - getOrCreate idempotency
 *   - per-session isolation of modelContextLimit (the #33 fix)
 *   - shared compressionTiming across sessions
 *   - soft-cap eviction + reload from persisted JSON
 */

import assert from "node:assert/strict"
import test, { beforeEach, afterEach } from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { SessionStateRegistry, saveSessionState, type WithParts } from "../lib/state"
import { Logger } from "../lib/logger"

function makeClient(): any {
    return { session: { get: async () => ({ data: { parentID: null } }) } }
}

const MESSAGES: WithParts[] = []
const MANUAL_MODE = false

let tempDir: string
let prevData: string | undefined
let prevConfig: string | undefined

beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "acp-registry-"))
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

test("getOrCreate is idempotent: same sessionId returns the same state without re-init", async () => {
    const registry = new SessionStateRegistry(new Logger(false))
    const first = await registry.getOrCreate(makeClient(), "session-1", MESSAGES, MANUAL_MODE)
    assert.equal(first.sessionId, "session-1")
    first.modelContextLimit = 200000

    const second = await registry.getOrCreate(makeClient(), "session-1", MESSAGES, MANUAL_MODE)
    assert.equal(second, first)
    assert.equal(second.modelContextLimit, 200000)
    assert.equal(registry.size, 1)
})

test("per-session isolation: modelContextLimit set on session A survives session B init", async () => {
    const registry = new SessionStateRegistry(new Logger(false))
    const a = await registry.getOrCreate(makeClient(), "session-A", MESSAGES, MANUAL_MODE)
    a.modelContextLimit = 200000

    const b = await registry.getOrCreate(makeClient(), "session-B", MESSAGES, MANUAL_MODE)

    assert.notEqual(a, b)
    assert.equal(a.modelContextLimit, 200000)
    assert.equal(b.modelContextLimit, undefined)
    assert.equal(registry.size, 2)
})

test("compressionTiming is the same shared object across all sessions", async () => {
    const registry = new SessionStateRegistry(new Logger(false))
    const a = await registry.getOrCreate(makeClient(), "session-A", MESSAGES, MANUAL_MODE)
    const b = await registry.getOrCreate(makeClient(), "session-B", MESSAGES, MANUAL_MODE)

    assert.equal(a.compressionTiming, registry.compressionTiming)
    assert.equal(b.compressionTiming, registry.compressionTiming)

    a.compressionTiming.startsByCallId.set("message-1:call-1", 100)
    assert.equal(b.compressionTiming.startsByCallId.get("message-1:call-1"), 100)
})

test("soft-cap eviction drops the oldest session; reload restores persisted modelContextLimit", async () => {
    const logger = new Logger(false)
    const registry = new SessionStateRegistry(logger)

    const first = await registry.getOrCreate(makeClient(), "session-0", MESSAGES, MANUAL_MODE)
    first.modelContextLimit = 200000
    await saveSessionState(first, logger)

    for (let i = 1; i <= 32; i++) {
        await registry.getOrCreate(makeClient(), `session-${i}`, MESSAGES, MANUAL_MODE)
    }

    assert.equal(registry.get("session-0"), undefined)
    assert.equal(registry.size, 32)

    const reloaded = await registry.getOrCreate(makeClient(), "session-0", MESSAGES, MANUAL_MODE)
    assert.equal(reloaded.modelContextLimit, 200000)
})
