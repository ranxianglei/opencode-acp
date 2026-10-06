import "./test-env"
import assert from "node:assert/strict"
import test from "node:test"
import * as fs from "fs/promises"
import { existsSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import type { WithParts } from "../lib/state"
import { createSessionState } from "../lib/state"
import { Logger } from "../lib/logger"
import { saveSessionState, loadSessionState } from "../lib/state/persistence"
import { ensureSessionInitialized } from "../lib/state"
import {
    PAYLOAD_FLOOR_TOKENS,
    RELAY_INFLATION_RATIO,
    estimatePayloadTokens,
    resolveCurrentUsage,
} from "../lib/usage-sanity"

const SID = "ses-usage-sanity"

function textPart(msgId: string, text: string) {
    return { id: `${msgId}-p`, messageID: msgId, sessionID: SID, type: "text" as const, text }
}

function userMsg(id: string, text: string): WithParts {
    return {
        info: {
            id,
            role: "user",
            sessionID: SID,
            agent: "a",
            time: { created: 1 },
        } as WithParts["info"],
        parts: [textPart(id, text)],
    }
}

function assistantMsg(id: string, text: string): WithParts {
    return {
        info: {
            id,
            role: "assistant",
            sessionID: SID,
            agent: "a",
            time: { created: 2 },
        } as WithParts["info"],
        parts: [textPart(id, text)],
    }
}

function assistantMsgWithTokens(
    id: string,
    text: string,
    tokens: { input: number; output: number },
): WithParts {
    return {
        info: {
            id,
            role: "assistant",
            sessionID: SID,
            agent: "a",
            time: { created: 2 },
            tokens,
        } as WithParts["info"],
        parts: [textPart(id, text)],
    }
}

function spyLogger() {
    const warnings: Array<{ msg: string; data?: any }> = []
    const logger = {
        warn: (msg: string, data?: any) => warnings.push({ msg, data }),
    } as unknown as Logger
    return { logger, warnings }
}

// Payload baseline used across multi-turn tests:
// user 8_000 chars + assistant 16_000 chars → (8_000+16_000)/4 = 6_000 est tokens
const USER_TEXT = "u".repeat(8_000)
const ASSISTANT_TEXT = "a".repeat(16_000)

function freshState(): ReturnType<typeof createSessionState> & { systemPromptTokens: number } {
    const state = createSessionState()
    state.systemPromptTokens = 1_000
    return state
}

test("estimatePayloadTokens counts chars/4 and skips synthetic + ignored messages", () => {
    const msgs: WithParts[] = [
        userMsg("u1", "x".repeat(8_000)), // 2_000 est
        assistantMsgWithTokens("a1", "y".repeat(4_000), { input: 10, output: 10 }), // 1_000 est
        // synthetic block summary — must be excluded
        {
            info: {
                id: "msg_dcp_summary_42",
                role: "user",
                sessionID: SID,
                time: { created: 3 },
            } as WithParts["info"],
            parts: [{ type: "text" as const, text: "z".repeat(8_000) }],
        },
        // ignored user message (no parts) — must be excluded
        {
            info: {
                id: "u-ignored",
                role: "user",
                sessionID: SID,
                time: { created: 4 },
            } as WithParts["info"],
            parts: [],
        },
    ]
    assert.equal(estimatePayloadTokens(msgs), 3_000)
})

test("first turn without prior record returns reported usage and seeds the record", () => {
    const state = freshState()
    const t1: WithParts[] = [
        userMsg("u1", USER_TEXT),
        assistantMsgWithTokens("a1", ASSISTANT_TEXT, { input: 98_000, output: 2_000 }),
    ]
    // estimated = 6_000 payload + 1_000 system = 7_000; reported = 100_000
    const r1 = resolveCurrentUsage(state, t1)
    assert.equal(r1.tokens, 100_000)
    assert.equal(r1.source, "reported")
    assert.equal(r1.inflationDetected, false)
    assert.deepEqual(state.usageSanity, { reported: 100_000, estimated: 7_000 })
})

test("honest steady state keeps passing reported usage through", () => {
    const state = freshState()
    const t1: WithParts[] = [
        userMsg("u1", USER_TEXT),
        assistantMsgWithTokens("a1", ASSISTANT_TEXT, { input: 98_000, output: 2_000 }),
    ]
    resolveCurrentUsage(state, t1)
    const t2: WithParts[] = [
        userMsg("u1", USER_TEXT),
        assistantMsgWithTokens("a2", ASSISTANT_TEXT, { input: 103_000, output: 2_000 }),
    ]
    // reported 105_000 / 100_000 = 1.05 → no jump → reported stays authoritative
    const r2 = resolveCurrentUsage(state, t2)
    assert.equal(r2.tokens, 105_000)
    assert.equal(r2.source, "reported")
    assert.equal(r2.inflationDetected, false)
})

test("relay inflation jump is re-estimated (issue #476 scenario, measured 1.76x)", () => {
    const state = freshState()
    const { logger, warnings } = spyLogger()
    const t1: WithParts[] = [
        userMsg("u1", USER_TEXT),
        assistantMsgWithTokens("a1", ASSISTANT_TEXT, { input: 98_000, output: 2_000 }),
    ]
    resolveCurrentUsage(state, t1, logger)
    assert.equal(warnings.length, 0, "turn 1 must not warn")

    // Same payload, relay reports 176_000 (1.76x the previous report)
    const t2: WithParts[] = [
        userMsg("u1", USER_TEXT),
        assistantMsgWithTokens("a2", ASSISTANT_TEXT, { input: 174_000, output: 2_000 }),
    ]
    const r2 = resolveCurrentUsage(state, t2, logger)
    assert.equal(r2.inflationDetected, true)
    assert.equal(r2.source, "reestimated")
    assert.equal(r2.tokens, 7_000, "must substitute the estimate for the inflated report")
    assert.equal(warnings.length, 1)
    assert.match(warnings[0]!.msg, /Relay usage inflation detected/)
    assert.equal(warnings[0]!.data?.reportRatio, 1.76)

    // Sustained inflation: relay reports 300_000 next turn (1.70x its own last
    // inflated report) — still caught because the record stores the raw report.
    const t3: WithParts[] = [
        userMsg("u1", USER_TEXT),
        assistantMsgWithTokens("a3", ASSISTANT_TEXT, { input: 298_000, output: 2_000 }),
    ]
    const r3 = resolveCurrentUsage(state, t3, logger)
    assert.equal(r3.inflationDetected, true)
    assert.equal(r3.tokens, 7_000)
    assert.equal(warnings.length, 2)
})

test("legitimate proportional growth is NOT flagged (payload grew with the report)", () => {
    const state = freshState()
    const t1: WithParts[] = [
        userMsg("u1", USER_TEXT),
        assistantMsgWithTokens("a1", ASSISTANT_TEXT, { input: 98_000, output: 2_000 }),
    ]
    resolveCurrentUsage(state, t1)
    // Payload doubled: assistant text 48_000 chars → est (8_000+48_000)/4 = 14_000
    // + 1_000 system = 15_000 (ratio 2.14 > 1.5); report ratio 180/100 = 1.8
    const t2: WithParts[] = [
        userMsg("u1", USER_TEXT),
        assistantMsgWithTokens("a2", "b".repeat(48_000), { input: 178_000, output: 2_000 }),
    ]
    const r2 = resolveCurrentUsage(state, t2)
    assert.equal(r2.inflationDetected, false)
    assert.equal(r2.source, "reported")
    assert.equal(r2.tokens, 180_000)
})

test("sub-floor estimates skip detection (small-session ratio noise)", () => {
    const state = freshState()
    const small = (aid: string, input: number): WithParts[] => [
        userMsg("u1", "s".repeat(4_000)), // 1_000 est
        assistantMsgWithTokens(aid, "t".repeat(4_000), { input, output: 1_000 }), // 1_000 est
    ]
    // estimated = 2_000 + 1_000 system = 3_000 < PAYLOAD_FLOOR_TOKENS
    const r1 = resolveCurrentUsage(state, small("a1", 99_000))
    assert.equal(r1.tokens, 100_000)
    assert.ok(state.usageSanity!.estimated < PAYLOAD_FLOOR_TOKENS)
    const r2 = resolveCurrentUsage(state, small("a2", 999_000))
    assert.equal(r2.inflationDetected, false, "floor guard must skip detection")
    assert.equal(r2.tokens, 1_000_000)
})

test("post-compaction sentinel (reported=0) passes through untouched", () => {
    const state = freshState()
    state.lastCompaction = 100 // newer than every message's time.created (1..2)
    const msgs: WithParts[] = [
        userMsg("u1", USER_TEXT),
        assistantMsgWithTokens("a1", ASSISTANT_TEXT, { input: 98_000, output: 2_000 }),
    ]
    const r = resolveCurrentUsage(state, msgs)
    assert.equal(r.tokens, 0)
    assert.equal(r.source, "reported")
    assert.equal(r.inflationDetected, false)
    assert.equal(state.usageSanity, undefined, "sentinel turn must not record a pair")
})

test("record stores the honest pair every turn so cross-turn comparison stays valid", () => {
    const state = freshState()
    const mk = (aid: string, input: number): WithParts[] => [
        userMsg("u1", USER_TEXT),
        assistantMsgWithTokens(aid, ASSISTANT_TEXT, { input, output: 2_000 }),
    ]
    resolveCurrentUsage(state, mk("a1", 98_000))
    resolveCurrentUsage(state, mk("a2", 174_000)) // inflated turn
    assert.deepEqual(state.usageSanity, { reported: 176_000, estimated: 7_000 })
})

const STORAGE_DIR = join(
    process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
    "opencode",
    "storage",
    "plugin",
    "acp",
)
const PERSIST_SESSION = "test-usage-sanity-persist"

async function cleanupPersistSession(): Promise<void> {
    const filePath = join(STORAGE_DIR, `${PERSIST_SESSION}.json`)
    if (existsSync(filePath)) {
        await fs.unlink(filePath)
    }
}

test("usageSanity survives save/load round-trip", async () => {
    const state = createSessionState()
    state.sessionId = PERSIST_SESSION
    state.usageSanity = { reported: 123_456, estimated: 7_000 }
    await cleanupPersistSession()

    await saveSessionState(state, new Logger(false))
    const loaded = await loadSessionState(PERSIST_SESSION, new Logger(false))
    assert.ok(loaded, "state file must exist after save")
    assert.deepEqual(loaded!.usageSanity, { reported: 123_456, estimated: 7_000 })
    await cleanupPersistSession()
})

test("ensureSessionInitialized restores valid usageSanity and drops corrupted records", async () => {
    const seed = createSessionState()
    seed.sessionId = PERSIST_SESSION
    seed.usageSanity = { reported: 123_456, estimated: 7_000 }
    await cleanupPersistSession()
    await saveSessionState(seed, new Logger(false))

    const fresh = createSessionState()
    await ensureSessionInitialized(null, fresh, PERSIST_SESSION, new Logger(false), [], false)
    assert.deepEqual(fresh.usageSanity, { reported: 123_456, estimated: 7_000 })

    // Corrupt the persisted record → restore must degrade to "no record"
    const filePath = join(STORAGE_DIR, `${PERSIST_SESSION}.json`)
    const doc = JSON.parse(await fs.readFile(filePath, "utf-8"))
    doc.usageSanity = { reported: "garbage", estimated: 7_000 }
    await fs.writeFile(filePath, JSON.stringify(doc), "utf-8")

    const fresh2 = createSessionState()
    await ensureSessionInitialized(null, fresh2, PERSIST_SESSION, new Logger(false), [], false)
    assert.equal(fresh2.usageSanity, undefined, "corrupted record must be dropped")
    await cleanupPersistSession()
})
