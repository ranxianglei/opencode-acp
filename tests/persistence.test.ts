import assert from "node:assert/strict"
import test from "node:test"
import * as fs from "fs/promises"
import { existsSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import { Logger } from "../lib/logger"
import { saveSessionState, loadSessionState } from "../lib/state/persistence"
import { createSessionState } from "../lib/state"

const logger = new Logger(false)
const STORAGE_DIR = join(
    process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
    "opencode",
    "storage",
    "plugin",
    "acp",
)
const TEST_SESSION = "test-persistence-roundtrip"

async function cleanup(): Promise<void> {
    const filePath = join(STORAGE_DIR, `${TEST_SESSION}.json`)
    if (existsSync(filePath)) {
        await fs.unlink(filePath)
    }
}

test("saveSessionState writes JSON file to disk", async () => {
    await cleanup()
    const state = createSessionState()
    state.sessionId = TEST_SESSION
    state.stats.totalPruneTokens = 500
    state.prune.tools.set("call-1", 1)

    await saveSessionState(state, logger)

    const filePath = join(STORAGE_DIR, `${TEST_SESSION}.json`)
    assert.ok(existsSync(filePath), "state file should exist")
    const content = JSON.parse(await fs.readFile(filePath, "utf-8"))
    assert.equal(content.stats.totalPruneTokens, 500)
    assert.equal(content.prune.tools["call-1"], 1)
    await cleanup()
})

test("loadSessionState returns null for nonexistent session", async () => {
    const result = await loadSessionState("nonexistent-session-xyz", logger)
    assert.equal(result, null)
})

test("saveSessionState skips when sessionId is empty", async () => {
    const state = createSessionState()
    await saveSessionState(state, logger)
    const filePath = join(STORAGE_DIR, `.json`)
    assert.ok(!existsSync(filePath), "should not create file for empty sessionId")
})

test("loadSessionState round-trips saved state", async () => {
    await cleanup()
    const state = createSessionState()
    state.sessionId = TEST_SESSION
    state.stats.totalPruneTokens = 999
    state.prune.tools.set("tool-a", 1)
    state.prune.tools.set("tool-b", 2)
    state.nudges.contextLimitAnchors.add("anchor-1")
    state.nudges.contextLimitAnchors.add("anchor-2")

    await saveSessionState(state, logger)
    const loaded = await loadSessionState(TEST_SESSION, logger)

    assert.ok(loaded, "loaded state should not be null")
    assert.equal(loaded!.stats.totalPruneTokens, 999)
    assert.equal(loaded!.prune.tools!["tool-a"], 1)
    assert.equal(loaded!.prune.tools!["tool-b"], 2)
    assert.ok(loaded!.nudges.contextLimitAnchors.includes("anchor-1"))
    assert.ok(loaded!.nudges.contextLimitAnchors.includes("anchor-2"))
    await cleanup()
})

test("loadSessionState returns null for corrupted JSON", async () => {
    await cleanup()
    const filePath = join(STORAGE_DIR, `${TEST_SESSION}.json`)
    await fs.mkdir(STORAGE_DIR, { recursive: true })
    await fs.writeFile(filePath, "{ invalid json }", "utf-8")

    const result = await loadSessionState(TEST_SESSION, logger)
    assert.equal(result, null, "corrupted JSON should return null")
    await cleanup()
})

test("loadSessionState returns null for missing required fields", async () => {
    await cleanup()
    const filePath = join(STORAGE_DIR, `${TEST_SESSION}.json`)
    await fs.mkdir(STORAGE_DIR, { recursive: true })
    await fs.writeFile(filePath, JSON.stringify({ someField: "no prune/stats" }), "utf-8")

    const result = await loadSessionState(TEST_SESSION, logger)
    assert.equal(result, null, "missing required fields should return null")
    await cleanup()
})

test("loadSessionState deduplicates malformed anchor entries", async () => {
    await cleanup()
    const filePath = join(STORAGE_DIR, `${TEST_SESSION}.json`)
    await fs.mkdir(STORAGE_DIR, { recursive: true })
    const state = {
        prune: { tools: {}, messages: { byMessageId: {}, blocksById: {} } },
        nudges: {
            contextLimitAnchors: ["a", "a", "b", 123 as any, null as any],
            turnNudgeAnchors: ["x", "x"],
        },
        stats: { pruneTokenCounter: 0, totalPruneTokens: 0 },
        lastUpdated: new Date().toISOString(),
    }
    await fs.writeFile(filePath, JSON.stringify(state), "utf-8")

    const result = await loadSessionState(TEST_SESSION, logger)
    assert.ok(result)
    const anchors = result!.nudges.contextLimitAnchors
    assert.ok(anchors.includes("a"))
    assert.ok(anchors.includes("b"))
    assert.ok(!anchors.includes(123 as any))
    const uniqueA = anchors.filter((x) => x === "a")
    assert.equal(uniqueA.length, 1, "duplicates should be removed")
    await cleanup()
})
