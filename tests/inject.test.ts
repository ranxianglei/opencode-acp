import assert from "node:assert/strict"
import test from "node:test"
import * as fs from "fs/promises"
import { existsSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"
import { injectMessageIds, injectCompressNudges } from "../lib/messages/inject/inject"
import { createSyntheticUserMessage } from "../lib/messages/utils"
import { createSessionState, ensureSessionInitialized, type WithParts } from "../lib/state"
import { saveSessionState, loadSessionState } from "../lib/state/persistence"
import { formatMessageIdTag } from "../lib/message-ids"

function buildConfig(mode: "message" | "range" = "range"): PluginConfig {
    return {
        enabled: true,
        autoUpdate: true,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: { enabled: true, protectedTools: [] },
        manualMode: { enabled: false, automaticStrategies: true },
        turnProtection: { enabled: false, turns: 4 },
        experimental: { allowSubAgents: false, customPrompts: false },
        protectedFilePatterns: [],
        compress: {
            mode, permission: "allow", showCompression: false, summaryBuffer: true,
            maxContextLimit: 150000, minContextLimit: 50000,
            nudgeFrequency: 5, iterationNudgeThreshold: 15, nudgeForce: "soft",
            protectedTools: [], protectTags: false, protectUserMessages: false,
            minNudgeContextPercent: 15, maxSummaryLengthHard: 10000,
            minCompressRange: 5000, minNudgeGrowthRatio: 0.45,
            minNudgeGrowthFloor: 5000, emergencyThresholdPercent: "98%",
            maxVisibleSegments: 50, keepEmbedMaxChars: 2000,
        },
        strategies: {
            deduplication: { enabled: true, protectedTools: [] },
            purgeErrors: { enabled: true, turns: 4, protectedTools: [] },
        },
        gc: { algorithm: "truncate", promotionThreshold: 5, maxBlockAge: 15, maxOldGenSummaryLength: 3000, majorGcThresholdPercent: "100%", batchCleanup: { lowThreshold: "60%", highThreshold: "75%", forceThreshold: "90%" } },
    }
}

const SID = "ses-inject-test"

const STORAGE_DIR = join(
    process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
    "opencode",
    "storage",
    "plugin",
    "acp",
)
const PERSIST_SESSION = "test-inject-nudge-persist"

async function cleanupPersistSession(): Promise<void> {
    const filePath = join(STORAGE_DIR, `${PERSIST_SESSION}.json`)
    if (existsSync(filePath)) {
        await fs.unlink(filePath)
    }
}

function textPart(msgId: string, text: string) {
    return { id: `${msgId}-p`, messageID: msgId, sessionID: SID, type: "text" as const, text }
}

function userMsg(id: string, text: string): WithParts {
    return {
        info: { id, role: "user", sessionID: SID, agent: "a", time: { created: 1 } } as WithParts["info"],
        parts: [textPart(id, text)],
    }
}

function assistantMsg(id: string, text: string, toolParts?: any[]): WithParts {
    const parts = [...(toolParts ?? []), textPart(id, text)]
    return {
        info: { id, role: "assistant", sessionID: SID, agent: "a", time: { created: 2 } } as WithParts["info"],
        parts,
    }
}

function toolPart(callID: string, output: string) {
    return {
        id: `${callID}-part`, messageID: "msg", sessionID: SID,
        type: "tool" as const, tool: "bash", callID,
        state: { status: "completed" as const, input: {}, output },
    }
}

function compressToolPart(callID: string, output: string) {
    return {
        id: `${callID}-part`, messageID: "msg", sessionID: SID,
        type: "tool" as const, tool: "compress", callID,
        state: { status: "completed" as const, input: {}, output },
    }
}

function assistantMsgWithTokens(
    id: string,
    text: string,
    tokens: { input: number; output: number },
    toolParts?: any[],
): WithParts {
    const parts = [...(toolParts ?? []), textPart(id, text)]
    return {
        info: {
            id, role: "assistant", sessionID: SID, agent: "a", time: { created: 2 },
            tokens,
        } as WithParts["info"],
        parts,
    }
}

const logger = new Logger(false)

test("injectMessageIds tags user messages with ref", () => {
    const state = createSessionState()
    state.messageIds.byRawId.set("u1", "m00001")
    const messages = [userMsg("u1", "hello")]
    injectMessageIds(state, buildConfig(), messages)
    const text = messages[0]!.parts[0] as any
    assert.ok(text.text.includes("m00001"), "user message should have m00001 ref")
})

test("injectMessageIds tags assistant tool outputs with ref", () => {
    const state = createSessionState()
    state.messageIds.byRawId.set("a1", "m00002")
    const messages = [assistantMsg("a1", "response", [toolPart("call-1", "tool output")])]
    injectMessageIds(state, buildConfig(), messages)
    const tool = messages[0]!.parts.find((p: any) => p.type === "tool") as any
    assert.ok(tool.state.output.includes("m00002"), "tool output should have m00002 ref")
})

test("injectMessageIds skips messages without refs", () => {
    const state = createSessionState()
    const messages = [userMsg("u1", "no ref assigned")]
    injectMessageIds(state, buildConfig(), messages)
    const text = messages[0]!.parts[0] as any
    assert.ok(!text.text.includes("m0"), "message without ref should not be tagged")
})

test("injectMessageIds assigns BLOCKED to protected user messages", () => {
    const state = createSessionState()
    state.messageIds.byRawId.set("u1", "m00001")
    const config = buildConfig("message")
    config.compress.protectUserMessages = true
    const messages = [userMsg("u1", "protected content")]
    injectMessageIds(state, config, messages)
    const text = messages[0]!.parts[0] as any
    assert.ok(text.text.includes("BLOCKED"), "protected message should have BLOCKED ref")
    assert.ok(!text.text.includes("m00001"), "protected message should NOT have the actual ref")
})

test("injectMessageIds adds tag to assistant text when no tool parts exist", () => {
    const state = createSessionState()
    state.messageIds.byRawId.set("a1", "m00003")
    const messages = [assistantMsg("a1", "just text, no tools")]
    injectMessageIds(state, buildConfig(), messages)
    const textPartResult = messages[0]!.parts.find((p: any) => p.type === "text") as any
    assert.ok(textPartResult.text.includes("m00003"), "assistant text should have ref when no tools")
})

test("injectCompressNudges does nothing when permission is deny", () => {
    const state = createSessionState()
    const config = buildConfig()
    config.compress.permission = "deny"
    const messages = [userMsg("u1", "hello")]
    const originalLength = messages.length
    injectCompressNudges(state, config, logger, messages, {} as any)
    assert.equal(messages.length, originalLength, "no messages should be added when permission denied")
})

test("injectCompressNudges does nothing when manualMode is active", () => {
    const state = createSessionState()
    state.manualMode = "active"
    const messages = [userMsg("u1", "hello")]
    const originalLength = messages.length
    injectCompressNudges(state, buildConfig(), logger, messages, {} as any)
    assert.equal(messages.length, originalLength, "no messages should be added in manual mode")
})

test("injectCompressNudges clears anchors when compress tool is detected", () => {
    const state = createSessionState()
    state.nudges.contextLimitAnchors.add("anchor-1")
    state.nudges.turnNudgeAnchors.add("anchor-2")
    state.nudges.iterationNudgeAnchors.add("anchor-3")
    const messages: WithParts[] = [
        userMsg("u1", "hello"),
        {
            info: { id: "a1", role: "assistant", sessionID: SID, agent: "a", time: { created: 2 } } as WithParts["info"],
            parts: [{
                id: "a1-tool", messageID: "a1", sessionID: SID,
                type: "tool", tool: "compress", callID: "compress-1",
                state: { status: "completed", input: {}, output: "done" },
            }],
        },
    ]
    injectCompressNudges(state, buildConfig(), logger, messages, {} as any)
    assert.equal(state.nudges.contextLimitAnchors.size, 0, "contextLimitAnchors should be cleared")
    assert.equal(state.nudges.turnNudgeAnchors.size, 0, "turnNudgeAnchors should be cleared")
    assert.equal(state.nudges.iterationNudgeAnchors.size, 0, "iterationNudgeAnchors should be cleared")
})

test("stale compress from previous turn does NOT clobber baseline (restart fix)", () => {
    const state = createSessionState()
    state.modelContextLimit = 1_000_000
    state.nudges.lastPerMessageNudgeTokens = 240_000
    const config = buildConfig()
    config.compress.maxContextLimit = 300_000
    const messages: WithParts[] = [
        userMsg("u1", "hello"),
        assistantMsgWithTokens("a1", "done", { input: 200_000, output: 50_000 }, [
            compressToolPart("c1", "compressed"),
        ]),
        userMsg("u2", "next question"),
    ]
    injectCompressNudges(state, config, logger, messages, {} as any)
    assert.notEqual(
        state.nudges.lastPerMessageNudgeTokens,
        undefined,
        "stale compress must not reset baseline to undefined",
    )
    assert.equal(
        state.nudges.contextLimitAnchors.size,
        0,
        "anchors must not be cleared by stale compress",
    )
})

test("compress in current turn sets baseline to compress-calling assistant's currentTokens", () => {
    const state = createSessionState()
    state.modelContextLimit = 1_000_000
    state.nudges.lastPerMessageNudgeTokens = 200_000
    state.nudges.lastNudgeShownTokens = 200_000
    state.nudges.contextLimitAnchors.add("anchor-1")
    const config = buildConfig()
    const messages: WithParts[] = [
        userMsg("u1", "hello"),
        assistantMsgWithTokens("a1", "done", { input: 200_000, output: 50_000 }, [
            compressToolPart("c1", "compressed"),
        ]),
    ]
    injectCompressNudges(state, config, logger, messages, {} as any)
    assert.equal(
        state.nudges.lastPerMessageNudgeTokens,
        250_000,
        "current-turn compress sets baseline to compress-calling assistant's currentTokens (input+output)",
    )
    assert.equal(state.nudges.compressBaselineSet, true, "lock must be set to prevent leak from continuation work")
    assert.equal(state.nudges.contextLimitAnchors.size, 0, "anchors must be cleared")
})

test("compress followed by continuation assistant sets baseline to continuation tokens (issue #23)", () => {
    const state = createSessionState()
    state.modelContextLimit = 1_000_000
    state.nudges.lastPerMessageNudgeTokens = 200_000
    state.nudges.lastNudgeShownTokens = 200_000
    state.nudges.contextLimitAnchors.add("anchor-1")
    const config = buildConfig()
    const messages: WithParts[] = [
        userMsg("u1", "hello"),
        assistantMsgWithTokens("a1", "compressing", { input: 200_000, output: 50_000 }, [
            compressToolPart("c1", "compressed"),
        ]),
        assistantMsgWithTokens("a2", "now continuing the task", { input: 150_000, output: 1_000 }),
    ]
    injectCompressNudges(state, config, logger, messages, {} as any)
    assert.equal(
        state.nudges.lastPerMessageNudgeTokens,
        151_000,
        "compress detected in current turn — baseline set to latest assistant currentTokens",
    )
    assert.equal(state.nudges.contextLimitAnchors.size, 0, "anchors must be cleared")
})

test("formatMessageIdTag produces dcp-message-id tag", () => {
    const tag = formatMessageIdTag("m00001")
    assert.ok(tag.includes("m00001"))
    assert.ok(tag.includes("dcp-message-id"))
})

// OpenCode's SessionPrompt.ensureTitle treats a user message as "real" only when
// NOT all of its parts are synthetic (opencode prompt.ts:
//   m.info.role === "user" && !m.parts.every(p => "synthetic" in p && p.synthetic)
// ) and bails out unless the conversation contains EXACTLY one real user message.
// ACP's compress-nudge suffix message is created via createSyntheticUserMessage and
// pushed as a second user message; if it counted as real, title generation would
// never be scheduled. This test locks the contract: the suffix message must be
// all-synthetic so ensureTitle still sees exactly one real user message.
const isOpenCodeRealUserMessage = (m: WithParts): boolean =>
    m.info.role === "user" && !m.parts.every((p) => "synthetic" in p && (p as { synthetic?: unknown }).synthetic === true)

test("createSyntheticUserMessage produces an all-synthetic user message that ensureTitle does not count as real", () => {
    const base = userMsg("u1", "hello")
    const synthetic = createSyntheticUserMessage(base, "")

    assert.ok(
        synthetic.parts.every((p) => "synthetic" in p && (p as { synthetic?: unknown }).synthetic === true),
        "every part of a createSyntheticUserMessage result must carry synthetic:true",
    )
    assert.equal(isOpenCodeRealUserMessage(synthetic), false, "synthetic user message must NOT be a 'real' user message")
    assert.equal(isOpenCodeRealUserMessage(base), true, "a plain user message must still be 'real'")

    const conversation = [base, synthetic]
    assert.equal(
        conversation.filter(isOpenCodeRealUserMessage).length,
        1,
        "after ACP injects its suffix message the conversation must still have exactly one real user message (ensureTitle precondition)",
    )
})

test("injectCompressNudges: after compress, baseline set to compress-calling assistant's currentTokens", () => {
    const state = createSessionState()
    state.modelContextLimit = 1_000_000
    state.nudges.lastNudgeShownTokens = 200_000
    const config = buildConfig()
    config.compress.maxContextLimit = 800_000
    config.compress.minContextLimit = 550_000
    const messages: WithParts[] = [
        userMsg("u1", "hello"),
        assistantMsgWithTokens("a1", "done", { input: 200_000, output: 50_000 }, [
            compressToolPart("c1", "compressed"),
        ]),
    ]
    injectCompressNudges(state, config, logger, messages, {} as any)

    assert.equal(
        state.nudges.lastPerMessageNudgeTokens,
        250_000,
        "baseline set to compress-calling assistant's currentTokens (input+output) — prevents leak from continuation work",
    )
    assert.equal(state.nudges.compressBaselineSet, true, "lock must be set")
})

test("injectCompressNudges: post-compress baseline then small growth does NOT re-nudge", () => {
    const state = createSessionState()
    state.modelContextLimit = 1_000_000
    const config = buildConfig()
    config.compress.maxContextLimit = 800_000
    config.compress.minContextLimit = 550_000

    // Turn 1: compress detected → baseline set to 250K (200K input + 50K output)
    state.nudges.lastNudgeShownTokens = 200_000
    const turn1: WithParts[] = [
        userMsg("u1", "hello"),
        assistantMsgWithTokens("a1", "done", { input: 200_000, output: 50_000 }, [
            compressToolPart("c1", "compressed"),
        ]),
    ]
    injectCompressNudges(state, config, logger, turn1, {} as any)
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 250_000)

    // Turn 2: small growth (253K - 250K = 3K < 50K threshold) → no nudge
    const turn2: WithParts[] = [
        userMsg("u2", "next"),
        assistantMsgWithTokens("a2", "response", { input: 247_000, output: 6_000 }),
    ]
    injectCompressNudges(state, config, logger, turn2, {} as any)

    assert.equal(
        state.nudges.shouldInjectThisTurn,
        false,
        "3K growth from compress baseline — should NOT nudge",
    )
})

test("injectCompressNudges: post-compress baseline then large growth DOES nudge", () => {
    const state = createSessionState()
    state.modelContextLimit = 1_000_000
    const config = buildConfig()
    config.compress.maxContextLimit = 800_000
    config.compress.minContextLimit = 550_000

    // Turn 1: compress → baseline set to 250K
    state.nudges.lastNudgeShownTokens = 200_000
    const turn1: WithParts[] = [
        userMsg("u1", "hello"),
        assistantMsgWithTokens("a1", "done", { input: 200_000, output: 50_000 }, [
            compressToolPart("c1", "compressed"),
        ]),
    ]
    injectCompressNudges(state, config, logger, turn1, {} as any)

    // Turn 2: 55K growth (305K - 250K) >= 50K threshold → nudge fires
    const turn2: WithParts[] = [
        userMsg("u2", "next"),
        assistantMsgWithTokens("a2", "baseline", { input: 250_000, output: 55_000 }),
    ]
    injectCompressNudges(state, config, logger, turn2, {} as any)
    assert.equal(
        state.nudges.shouldInjectThisTurn,
        true,
        "55K growth from compress baseline (250K→305K, >50K threshold) — should nudge",
    )
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 250_000, "baseline NOT updated after nudge — only compress resets")
})

test("nudge threshold halves after first nudge without compress (issue #23)", () => {
    const state = createSessionState()
    state.modelContextLimit = 1_000_000
    state.nudges.lastPerMessageNudgeTokens = 100_000
    const config = buildConfig()
    config.compress.maxContextLimit = 800_000
    config.compress.minContextLimit = 200_000

    const messages1: WithParts[] = [
        userMsg("u1", "hello"),
        assistantMsgWithTokens("a1", "done", { input: 100_000, output: 50_000 }),
    ]
    injectCompressNudges(state, config, logger, messages1, {} as any)
    assert.equal(state.nudges.shouldInjectThisTurn, true, "50K growth >= 50K threshold → first nudge")
    assert.equal(state.nudges.lastNudgeShownTokens, 150_000, "lastNudgeShownTokens set to currentTokens")

    const messages2: WithParts[] = [
        userMsg("u2", "more"),
        assistantMsgWithTokens("a2", "work", { input: 160_000, output: 5_000 }),
    ]
    injectCompressNudges(state, config, logger, messages2, {} as any)
    assert.equal(state.nudges.shouldInjectThisTurn, false, "15K growth from lastShown < 25K (halved) → no nudge")

    const messages3: WithParts[] = [
        userMsg("u3", "more"),
        assistantMsgWithTokens("a3", "work", { input: 170_000, output: 5_000 }),
    ]
    injectCompressNudges(state, config, logger, messages3, {} as any)
    assert.equal(state.nudges.shouldInjectThisTurn, true, "25K growth from lastShown >= 25K (halved) → nudge fires")
    assert.equal(state.nudges.lastNudgeShownTokens, 175_000)
})

test("voluntary compress (no nudge shown) does NOT reset baseline", () => {
    const state = createSessionState()
    state.modelContextLimit = 1_000_000
    state.nudges.lastPerMessageNudgeTokens = 50_000
    // lastNudgeShownTokens is undefined — no nudge was shown
    const config = buildConfig()
    const messages: WithParts[] = [
        userMsg("u1", "hello"),
        assistantMsgWithTokens("a1", "done", { input: 80_000, output: 10_000 }, [
            compressToolPart("c1", "compressed"),
        ]),
    ]
    injectCompressNudges(state, config, logger, messages, {} as any)
    assert.equal(
        state.nudges.lastPerMessageNudgeTokens,
        50_000,
        "voluntary compress does NOT reset baseline — growth tracking continues from original baseline",
    )
    assert.equal(state.nudges.compressBaselineSet, false, "lock NOT set for voluntary compress")
})

test("nudge threshold restores to full after compress (issue #23)", () => {
    const state = createSessionState()
    state.modelContextLimit = 1_000_000
    state.nudges.lastPerMessageNudgeTokens = 100_000
    state.nudges.lastNudgeShownTokens = 150_000
    const config = buildConfig()
    config.compress.maxContextLimit = 800_000
    config.compress.minContextLimit = 200_000

    const messages: WithParts[] = [
        userMsg("u1", "hello"),
        assistantMsgWithTokens("a1", "done", { input: 100_000, output: 50_000 }, [
            compressToolPart("c1", "compressed"),
        ]),
    ]
    injectCompressNudges(state, config, logger, messages, {} as any)
    assert.equal(state.nudges.lastNudgeShownTokens, undefined, "compress resets lastNudgeShownTokens")
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 150_000, "compress sets baseline to post-compression currentTokens")
})

test("injectCompressNudges persists new nudge baseline to disk when a growth nudge fires without anchor changes (#60)", async () => {
    await cleanupPersistSession()

    // Seed disk with a stale baseline, as left by a prior session before restart.
    const seed = createSessionState()
    seed.sessionId = PERSIST_SESSION
    seed.nudges.lastPerMessageNudgeTokens = 200_000
    await saveSessionState(seed, logger)

    // Simulate the post-restart in-memory state: stale baseline loaded back.
    const state = createSessionState()
    state.sessionId = PERSIST_SESSION
    state.modelContextLimit = 1_000_000
    const loaded = await loadSessionState(PERSIST_SESSION, logger)
    state.nudges.lastPerMessageNudgeTokens = loaded!.nudges.lastPerMessageNudgeTokens

    const config = buildConfig()
    config.compress.maxContextLimit = 800_000
    config.compress.minContextLimit = 200_000

    // Last message is an assistant turn → turnNudgeAnchors block skipped (isLastMessageUser=false);
    // only one message after the user → iterationNudgeAnchors skipped (< iterationNudgeThreshold);
    // no tool parts → toolOutput reminder skipped. So anchorsChanged stays false.
    // Growth = 255K - 200K = 55K >= 50K adaptive threshold → shouldNudge=true.
    const messages: WithParts[] = [
        userMsg("u1", "hello"),
        assistantMsgWithTokens("a1", "response", { input: 200_000, output: 55_000 }),
    ]

    injectCompressNudges(state, config, logger, messages, {} as any)

    assert.equal(state.nudges.shouldInjectThisTurn, true, "growth nudge should fire (55K >= 50K adaptive)")
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 200_000, "baseline NOT updated after nudge — nudges repeat until compress")

    // saveSessionState is fire-and-forget inside injectCompressNudges (.catch(()=>{})); flush before reload.
    await new Promise((resolve) => setTimeout(resolve, 50))

    const reloaded = await loadSessionState(PERSIST_SESSION, logger)
    assert.ok(reloaded, "state must be persisted when a nudge fires")
    assert.equal(
        reloaded!.nudges.lastPerMessageNudgeTokens,
        200_000,
        "baseline unchanged on disk — nudges repeat every turn until model actually compresses",
    )
    await cleanupPersistSession()
})

test("E2E: nudge survives compress → restart → growth (issue #23)", async () => {
    await cleanupPersistSession()

    const state = createSessionState()
    state.sessionId = PERSIST_SESSION
    state.modelContextLimit = 1_000_000
    const config = buildConfig()
    config.compress.maxContextLimit = 800_000
    config.compress.minContextLimit = 200_000

    // Turn 1: model calls compress → baseline set to 250K (200K+50K)
    state.nudges.lastNudgeShownTokens = 200_000
    const turn1: WithParts[] = [
        userMsg("u1", "hello"),
        assistantMsgWithTokens("a1", "done", { input: 200_000, output: 50_000 }, [
            compressToolPart("c1", "compressed"),
        ]),
    ]
    injectCompressNudges(state, config, logger, turn1, {} as any)
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 250_000, "compress sets baseline to post-compression tokens")

    // Simulate restart: load from disk
    await new Promise((resolve) => setTimeout(resolve, 50))
    const loaded1 = await loadSessionState(PERSIST_SESSION, logger)
    assert.equal(loaded1!.nudges.lastPerMessageNudgeTokens, 250_000, "on-disk baseline must be 250K after compress")

    const state2 = createSessionState()
    state2.sessionId = PERSIST_SESSION
    state2.modelContextLimit = 1_000_000
    state2.nudges.lastPerMessageNudgeTokens = loaded1!.nudges.lastPerMessageNudgeTokens
    state2.nudges.compressBaselineSet = loaded1!.nudges.compressBaselineSet ?? false

    // Turn 2: post-compress turn, context dropped to 155K — baseline correction adjusts
    const turn2: WithParts[] = [
        userMsg("u2", "next"),
        assistantMsgWithTokens("a2", "response", { input: 150_000, output: 5_000 }),
    ]
    injectCompressNudges(state2, config, logger, turn2, {} as any)
    // 155K < 250K - 50K = 200K → baseline corrected to 155K
    assert.equal(state2.nudges.lastPerMessageNudgeTokens, 155_000, "baseline corrected down to actual post-compression level")

    // Simulate restart AGAIN: baseline must persist
    await new Promise((resolve) => setTimeout(resolve, 50))
    const loaded2 = await loadSessionState(PERSIST_SESSION, logger)
    assert.equal(
        loaded2!.nudges.lastPerMessageNudgeTokens,
        155_000,
        "corrected baseline MUST persist to disk",
    )

    // Turn 3: load persisted baseline, then grow past threshold → nudge MUST fire
    const state3 = createSessionState()
    state3.sessionId = PERSIST_SESSION
    state3.modelContextLimit = 1_000_000
    state3.nudges.lastPerMessageNudgeTokens = loaded2!.nudges.lastPerMessageNudgeTokens

    const turn3: WithParts[] = [
        userMsg("u3", "more work"),
        assistantMsgWithTokens("a3", "result", { input: 200_000, output: 10_000 }),
    ]
    injectCompressNudges(state3, config, logger, turn3, {} as any)
    assert.equal(
        state3.nudges.shouldInjectThisTurn,
        true,
        "55K growth past corrected baseline (155K→210K, >50K threshold) — nudge MUST fire",
    )

    await cleanupPersistSession()
})

test("E2E: nudge recommendation content includes composition breakdown and compress guidance (issue #23)", () => {
    const state = createSessionState()
    state.modelContextLimit = 1_000_000
    state.nudges.lastPerMessageNudgeTokens = 200_000
    const config = buildConfig()
    config.compress.maxContextLimit = 800_000
    config.compress.minContextLimit = 200_000

    const messages: WithParts[] = [
        userMsg("u1", "hello"),
        assistantMsgWithTokens("a1", "done", { input: 200_000, output: 55_000 }, [
            toolPart("c1", "x".repeat(40_000)),
        ]),
    ]
    injectCompressNudges(state, config, logger, messages, {} as any)

    assert.equal(state.nudges.shouldInjectThisTurn, true, "should nudge (55K growth >= 50K threshold)")

    const injected = suffixText(messages)
    assert.ok(injected.includes("Breakdown:"), "nudge must include composition breakdown")
    assert.ok(injected.includes("tool"), "breakdown must show tool category")
    assert.ok(
        injected.includes("acp_status") || injected.includes("compress") || injected.includes("review"),
        "nudge must include compress guidance",
    )
})

test("growth floor: nudge suppressed when growth below floor (issue #27 anti-thrashing)", () => {
    // 1M model: growthFloor = max(5000, 0.45×50000) = 22500
    // Growth of 5K < 22500 → no nudge output at all
    const state = createSessionState()
    state.modelContextLimit = 1_000_000
    state.nudges.lastPerMessageNudgeTokens = 205_000
    state.messageIds.byRawId.set("u1", "m00001")
    state.messageIds.byRawId.set("a1", "m00002")
    state.messageIds.byRawId.set("u2", "m00003")

    const config = buildConfig()
    config.compress.maxContextLimit = 500_000
    config.compress.minContextLimit = 200_000

    const messages: WithParts[] = [
        userMsg("u1", "hello"),
        assistantMsgWithTokens("a1", "done", { input: 200_000, output: 10_000 }, [
            toolPart("c1", "x".repeat(40_000)),
        ]),
        userMsg("u2", "next"),
    ]
    injectCompressNudges(state, config, logger, messages, {} as any)

    assert.equal(state.nudges.shouldInjectThisTurn, false, "5K growth < 22500 floor → nudge suppressed")
    assert.ok(state.nudges.turnNudgeAnchors.size > 0, "anchors still accumulate")

    const injected = suffixText(messages)
    assert.ok(!injected.includes("Breakdown:"), "no breakdown when growth below floor")
    assert.ok(!injected.includes("Compressible ranges"), "no ranges when growth below floor")
    assert.ok(!injected.includes("Context limit reached"), "no strong alert when growth below floor")
    assert.equal(state.nudges.lastNudgeShownTokens, undefined, "lastNudgeShownTokens not updated")
})

test("growth floor: nudge fires when growth meets nudgeGrowthTokens (not just growthFloor)", () => {
    // 1M model: nudgeGrowthTokens = 50000, growthFloor = max(5000, 0.45×50000) = 22500
    // Growth of 25K >= growthFloor (22500) but < nudgeGrowthTokens (50000) → suppressed
    // Growth of 55K >= nudgeGrowthTokens (50000) AND >= growthFloor (22500) → fires
    const state = createSessionState()
    state.modelContextLimit = 1_000_000
    state.nudges.lastPerMessageNudgeTokens = 200_000
    state.messageIds.byRawId.set("u1", "m00001")
    state.messageIds.byRawId.set("a1", "m00002")

    const config = buildConfig()
    config.compress.maxContextLimit = 500_000
    config.compress.minContextLimit = 200_000

    // 25K growth: below nudgeGrowthTokens → suppressed
    const messages: WithParts[] = [
        userMsg("u1", "hello"),
        assistantMsgWithTokens("a1", "done", { input: 200_000, output: 25_000 }, [
            toolPart("c1", "x".repeat(40_000)),
        ]),
    ]
    injectCompressNudges(state, config, logger, messages, {} as any)

    assert.equal(state.nudges.shouldInjectThisTurn, false, "25K growth < 50K nudgeGrowthTokens → nudge suppressed")

    // 55K growth: above nudgeGrowthTokens AND above growthFloor → fires
    const state2 = createSessionState()
    state2.modelContextLimit = 1_000_000
    state2.nudges.lastPerMessageNudgeTokens = 200_000
    state2.messageIds.byRawId.set("u1", "m00001")
    state2.messageIds.byRawId.set("a1", "m00002")
    state2.messageIds.byRawId.set("a2", "m00003")

    const messages2: WithParts[] = [
        userMsg("u1", "hello"),
        assistantMsgWithTokens("a1", "work", { input: 200_000, output: 30_000 }, [
            toolPart("c1", "x".repeat(320_000)),
        ]),
        assistantMsgWithTokens("a2", "done", { input: 200_000, output: 50_000 }, [
            toolPart("c2", "x".repeat(320_000)),
        ]),
    ]
    injectCompressNudges(state2, config, logger, messages2, {} as any)

    assert.equal(state2.nudges.shouldInjectThisTurn, true, "55K growth >= 50K nudgeGrowthTokens → nudge fires")

    const injected = suffixText(messages2)
    assert.ok(injected.includes("Breakdown:"), "breakdown shown when growth meets threshold")
    assert.ok(injected.includes("Compressible ranges"), "ranges shown when growth meets threshold")
})

test("growth floor: 98% emergency override fires regardless of growth", () => {
    // Context at 98%+ but growth is 0 → emergency override fires
    const state = createSessionState()
    state.modelContextLimit = 1_000_000
    state.nudges.lastPerMessageNudgeTokens = 980_000
    state.nudges.lastNudgeShownTokens = 980_000
    state.messageIds.byRawId.set("u1", "m00001")
    state.messageIds.byRawId.set("a1", "m00002")

    const config = buildConfig()
    config.compress.maxContextLimit = 500_000
    config.compress.minContextLimit = 200_000

    const messages: WithParts[] = [
        userMsg("u1", "hello"),
        assistantMsgWithTokens("a1", "done", { input: 970_000, output: 10_000 }, [
            toolPart("c1", "x".repeat(40_000)),
        ]),
    ]
    injectCompressNudges(state, config, logger, messages, {} as any)

    assert.equal(state.nudges.shouldInjectThisTurn, true, "98% context → emergency override fires")

    const injected = suffixText(messages)
    assert.ok(injected.includes("Breakdown:"), "breakdown shown at emergency")
    assert.ok(
        injected.includes("Context limit reached — compress now"),
        "strong maxLimit alert at emergency",
    )
})

test("nudge suppressed when filter has no recommendations (all ranges below last-segment floor)", () => {
    // 1M model: growthThreshold=50K, lastSegmentFloor=100K
    // Growth of 55K > 50K threshold → nudgeAllowed = true
    // But tool output is 80K chars (~20K tokens) < 100K floor → filtered out
    // shouldInjectThisTurn = false (no ranges to recommend, not emergency)
    const state = createSessionState()
    state.modelContextLimit = 1_000_000
    state.nudges.lastPerMessageNudgeTokens = 200_000
    state.messageIds.byRawId.set("u1", "m00001")
    state.messageIds.byRawId.set("a1", "m00002")

    const config = buildConfig()
    config.compress.maxContextLimit = 500_000
    config.compress.minContextLimit = 200_000

    const messages: WithParts[] = [
        userMsg("u1", "hello"),
        assistantMsgWithTokens("a1", "done", { input: 200_000, output: 55_000 }, [
            toolPart("c1", "x".repeat(80_000)),
        ]),
    ]
    injectCompressNudges(state, config, logger, messages, {} as any)

    assert.equal(
        state.nudges.shouldInjectThisTurn,
        false,
        "55K growth triggers nudgeAllowed but 20K tool output < 100K floor → no recommendations → nudge suppressed",
    )

    const injected = suffixText(messages)
    assert.ok(!injected.includes("Breakdown:"), "no breakdown when no recommendations")
    assert.ok(!injected.includes("efficiency nudge"), "no efficiency nudge text")
    assert.ok(!injected.includes("Context limit reached"), "no emergency alert")
})

test("nudge suppressed when all content is protected (nothing to compress)", () => {
    const state = createSessionState()
    state.modelContextLimit = 1_000_000
    state.nudges.lastPerMessageNudgeTokens = 200_000
    state.messageIds.byRawId.set("a1", "m00001")

    const config = buildConfig()
    config.compress.protectedTools = ["skill"]
    config.compress.maxContextLimit = 500_000
    config.compress.minContextLimit = 200_000

    const messages: WithParts[] = [
        assistantMsgWithTokens("a1", "done", { input: 200_000, output: 55_000 }, [
            {
                id: "skill-part", messageID: "a1", sessionID: SID,
                type: "tool" as const, tool: "skill", callID: "skill-call",
                state: { status: "completed" as const, input: {}, output: "x".repeat(80_000) },
            },
        ]),
    ]
    injectCompressNudges(state, config, logger, messages, {} as any)

    assert.equal(
        state.nudges.shouldInjectThisTurn,
        false,
        "55K growth triggers nudgeAllowed but ALL tool output is protected (skill) → nothing to compress → nudge suppressed",
    )
})

test("emergency override fires even when all content is protected", () => {
    const state = createSessionState()
    state.modelContextLimit = 1_000_000
    state.nudges.lastPerMessageNudgeTokens = 980_000
    state.nudges.lastNudgeShownTokens = 980_000
    state.messageIds.byRawId.set("a1", "m00001")

    const config = buildConfig()
    config.compress.protectedTools = ["skill"]
    config.compress.maxContextLimit = 500_000
    config.compress.minContextLimit = 200_000

    const messages: WithParts[] = [
        assistantMsgWithTokens("a1", "done", { input: 970_000, output: 10_000 }, [
            {
                id: "skill-part", messageID: "a1", sessionID: SID,
                type: "tool" as const, tool: "skill", callID: "skill-call",
                state: { status: "completed" as const, input: {}, output: "x".repeat(40_000) },
            },
        ]),
    ]
    injectCompressNudges(state, config, logger, messages, {} as any)

    assert.equal(
        state.nudges.shouldInjectThisTurn,
        true,
        "98% emergency override fires even when all content is protected",
    )
})

test("baseline advances when nudge suppressed — discrete 5% intervals (all protected)", () => {
    const state = createSessionState()
    state.modelContextLimit = 1_000_000
    state.messageIds.byRawId.set("a1", "m00001")

    const config = buildConfig()
    config.compress.protectedTools = ["skill"]
    config.compress.maxContextLimit = 500_000
    config.compress.minContextLimit = 200_000

    const turn1: WithParts[] = [
        assistantMsgWithTokens("a1", "done", { input: 200_000, output: 55_000 }, [
            {
                id: "skill-part", messageID: "a1", sessionID: SID,
                type: "tool" as const, tool: "skill", callID: "skill-call",
                state: { status: "completed" as const, input: {}, output: "x".repeat(80_000) },
            },
        ]),
    ]
    state.nudges.lastPerMessageNudgeTokens = 200_000
    injectCompressNudges(state, config, logger, turn1, {} as any)
    assert.equal(state.nudges.shouldInjectThisTurn, false, "55K growth but all protected → suppressed")
    assert.equal(
        state.nudges.lastPerMessageNudgeTokens,
        255_000,
        "baseline advanced to currentTokens (200K input + 55K output)",
    )

    state.messageIds.byRawId.set("a2", "m00002")
    const turn2: WithParts[] = [
        assistantMsgWithTokens("a2", "response", { input: 253_000, output: 7_000 }, [
            {
                id: "skill-part2", messageID: "a2", sessionID: SID,
                type: "tool" as const, tool: "skill", callID: "skill-call2",
                state: { status: "completed" as const, input: {}, output: "x".repeat(10_000) },
            },
        ]),
    ]
    injectCompressNudges(state, config, logger, turn2, {} as any)
    assert.equal(
        state.nudges.shouldInjectThisTurn,
        false,
        "5K growth from advanced baseline (260K - 255K) < 50K threshold → no nudge",
    )
    assert.equal(
        state.nudges.lastPerMessageNudgeTokens,
        255_000,
        "baseline NOT advanced when nudgeAllowed is false (growth below threshold)",
    )
})

test("baseline advances when filter suppressed — compressible too small", () => {
    const state = createSessionState()
    state.modelContextLimit = 1_000_000
    state.messageIds.byRawId.set("u1", "m00001")
    state.messageIds.byRawId.set("a1", "m00002")

    const config = buildConfig()
    config.compress.maxContextLimit = 500_000
    config.compress.minContextLimit = 200_000

    state.nudges.lastPerMessageNudgeTokens = 200_000
    const turn1: WithParts[] = [
        userMsg("u1", "hello"),
        assistantMsgWithTokens("a1", "done", { input: 200_000, output: 55_000 }, [
            toolPart("c1", "x".repeat(80_000)),
        ]),
    ]
    injectCompressNudges(state, config, logger, turn1, {} as any)
    assert.equal(state.nudges.shouldInjectThisTurn, false, "55K growth but 20K compressible < 100K floor → suppressed")
    assert.equal(
        state.nudges.lastPerMessageNudgeTokens,
        255_000,
        "baseline advanced when filter suppressed (too small to recommend)",
    )
})

test("pending nudge cleared when suppressed — threshold resets to full", () => {
    const state = createSessionState()
    state.modelContextLimit = 1_000_000
    state.messageIds.byRawId.set("a1", "m00001")

    const config = buildConfig()
    config.compress.protectedTools = ["skill"]
    config.compress.maxContextLimit = 500_000
    config.compress.minContextLimit = 200_000

    state.nudges.lastPerMessageNudgeTokens = 200_000
    state.nudges.lastNudgeShownTokens = 200_000
    const turn1: WithParts[] = [
        assistantMsgWithTokens("a1", "done", { input: 225_000, output: 30_000 }, [
            {
                id: "skill-part", messageID: "a1", sessionID: SID,
                type: "tool" as const, tool: "skill", callID: "skill-call",
                state: { status: "completed" as const, input: {}, output: "x".repeat(80_000) },
            },
        ]),
    ]
    injectCompressNudges(state, config, logger, turn1, {} as any)
    assert.equal(state.nudges.shouldInjectThisTurn, false, "nudge suppressed — all protected")
    assert.equal(
        state.nudges.lastNudgeShownTokens,
        undefined,
        "pending nudge cleared — threshold resets to full (not halved) for next check",
    )
    assert.equal(
        state.nudges.lastPerMessageNudgeTokens,
        255_000,
        "baseline advanced to currentTokens",
    )
})

test("voluntary compress after suppression does not trigger proportional baseline adjustment", () => {
    const state = createSessionState()
    state.modelContextLimit = 1_000_000
    state.messageIds.byRawId.set("a1", "m00001")

    const config = buildConfig()
    config.compress.protectedTools = ["skill"]
    config.compress.maxContextLimit = 500_000
    config.compress.minContextLimit = 200_000

    state.nudges.lastPerMessageNudgeTokens = 200_000
    const turn1: WithParts[] = [
        assistantMsgWithTokens("a1", "done", { input: 200_000, output: 55_000 }, [
            {
                id: "skill-part", messageID: "a1", sessionID: SID,
                type: "tool" as const, tool: "skill", callID: "skill-call",
                state: { status: "completed" as const, input: {}, output: "x".repeat(80_000) },
            },
        ]),
    ]
    injectCompressNudges(state, config, logger, turn1, {} as any)
    assert.equal(state.nudges.shouldInjectThisTurn, false, "turn 1: all protected → suppressed")
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 255_000, "turn 1: baseline advanced")
    assert.equal(state.nudges.lastNudgeShownTokens, undefined, "turn 1: pending nudge cleared")

    state.messageIds.byRawId.set("a2", "m00002")
    const turn2: WithParts[] = [
        assistantMsgWithTokens("a2", "compressed", { input: 253_000, output: 2_000 }, [
            compressToolPart("c1", "compressed"),
        ]),
    ]
    injectCompressNudges(state, config, logger, turn2, {} as any)
    assert.equal(
        state.nudges.lastPerMessageNudgeTokens,
        255_000,
        "turn 2: voluntary compress (wasNudgeTriggered=false) keeps suppression baseline — no proportional adjustment",
    )
    assert.equal(state.nudges.compressBaselineSet, false, "lock not set for voluntary compress")
})

test("emergency override fires even when filter has no recommendations", () => {
    // Context at 98%+ with small tool output (< floor) → emergency bypasses filter
    const state = createSessionState()
    state.modelContextLimit = 1_000_000
    state.nudges.lastPerMessageNudgeTokens = 980_000
    state.nudges.lastNudgeShownTokens = 980_000
    state.messageIds.byRawId.set("u1", "m00001")
    state.messageIds.byRawId.set("a1", "m00002")

    const config = buildConfig()
    config.compress.maxContextLimit = 500_000
    config.compress.minContextLimit = 200_000

    const messages: WithParts[] = [
        userMsg("u1", "hello"),
        assistantMsgWithTokens("a1", "done", { input: 970_000, output: 10_000 }, [
            toolPart("c1", "x".repeat(40_000)),
        ]),
    ]
    injectCompressNudges(state, config, logger, messages, {} as any)

    assert.equal(
        state.nudges.shouldInjectThisTurn,
        true,
        "98% emergency override fires even when filter has no recommendations",
    )

    const injected = suffixText(messages)
    assert.ok(injected.includes("Breakdown:"), "breakdown shown at emergency even without recommendations")
    assert.ok(
        injected.includes("Context limit reached — compress now"),
        "strong maxLimit alert at emergency",
    )
})

test("growth floor: 5000 floor on small-context models", () => {
    // 100K model: nudgeGrowthTokens = max(6000, 100K×5%) = 6000
    // growthFloor = max(5000, 0.45×6000) = max(5000, 2700) = 5000
    // Growth of 4K < 5000 → suppressed. Growth of 6K >= 5000 → fires.
    const state = createSessionState()
    state.modelContextLimit = 100_000
    state.nudges.lastPerMessageNudgeTokens = 20_000
    state.messageIds.byRawId.set("u1", "m00001")
    state.messageIds.byRawId.set("a1", "m00002")

    const config = buildConfig()
    config.compress.maxContextLimit = 60_000
    config.compress.minContextLimit = 20_000

    const messages: WithParts[] = [
        userMsg("u1", "hello"),
        assistantMsgWithTokens("a1", "done", { input: 20_000, output: 4_000 }, [
            toolPart("c1", "x".repeat(8_000)),
        ]),
    ]
    injectCompressNudges(state, config, logger, messages, {} as any)

    assert.equal(state.nudges.shouldInjectThisTurn, false, "4K growth < 5000 floor on 100K model")

    // Now with 6K growth → should fire
    const state2 = createSessionState()
    state2.modelContextLimit = 100_000
    state2.nudges.lastPerMessageNudgeTokens = 20_000
    state2.messageIds.byRawId.set("u1", "m00001")
    state2.messageIds.byRawId.set("a1", "m00002")

    const messages2: WithParts[] = [
        userMsg("u1", "hello"),
        assistantMsgWithTokens("a1", "done", { input: 20_000, output: 6_000 }, [
            toolPart("c1", "x".repeat(60_000)),
        ]),
    ]
    injectCompressNudges(state2, config, logger, messages2, {} as any)

    assert.equal(state2.nudges.shouldInjectThisTurn, true, "6K growth >= 5000 floor on 100K model")
})

test("growth floor: applyAnchoredNudges output suppressed when growth below floor (Oracle MEDIUM #2)", () => {
    // Verify that applyAnchoredNudges is gated by nudgeAllowed — not just the
    // breakdown block. If someone un-gates applyAnchoredNudges, anchored nudge
    // prompt text would leak into the suffix every turn.
    const TURN_NUDGE_MARKER = "TURN_NUDGE_TEST_MARKER"

    const makePrompts = () =>
        ({
            system: "",
            compressRange: "",
            compressMessage: "",
            contextLimitNudge: "CTX_LIMIT_MARKER",
            turnNudge: TURN_NUDGE_MARKER,
            iterationNudge: "ITER_NUDGE_MARKER",
            manualExtension: "",
            subagentExtension: "",
            decompressExtension: "",
        }) as any

    // --- Suppressed: growth below floor ---
    const state1 = createSessionState()
    state1.modelContextLimit = 1_000_000
    state1.nudges.lastPerMessageNudgeTokens = 205_000
    state1.messageIds.byRawId.set("u1", "m00001")
    state1.messageIds.byRawId.set("a1", "m00002")
    state1.messageIds.byRawId.set("u2", "m00003")

    const config = buildConfig()
    config.compress.maxContextLimit = 500_000
    config.compress.minContextLimit = 200_000

    const messages1: WithParts[] = [
        userMsg("u1", "hello"),
        assistantMsgWithTokens("a1", "done", { input: 200_000, output: 10_000 }, [
            toolPart("c1", "x".repeat(40_000)),
        ]),
        userMsg("u2", "next"),
    ]
    injectCompressNudges(state1, config, logger, messages1, makePrompts())

    assert.equal(state1.nudges.shouldInjectThisTurn, false)
    const text1 = suffixText(messages1)
    assert.ok(
        !text1.includes(TURN_NUDGE_MARKER),
        "anchored turn nudge text must NOT appear when nudgeAllowed is false",
    )

    // --- Fires: growth meets nudgeGrowthTokens → anchored nudge text SHOULD appear ---
    const state2 = createSessionState()
    state2.modelContextLimit = 1_000_000
    state2.nudges.lastPerMessageNudgeTokens = 200_000
    state2.messageIds.byRawId.set("u1", "m00001")
    state2.messageIds.byRawId.set("a1", "m00002")
    state2.messageIds.byRawId.set("u2", "m00003")

    const messages2: WithParts[] = [
        userMsg("u1", "hello"),
        assistantMsgWithTokens("a1", "done", { input: 200_000, output: 55_000 }, [
            toolPart("c1", "x".repeat(620_000)),
        ]),
        userMsg("u2", "next"),
    ]
    injectCompressNudges(state2, config, logger, messages2, makePrompts())

    assert.equal(state2.nudges.shouldInjectThisTurn, true)
    const text2 = suffixText(messages2)
    assert.ok(
        text2.includes(TURN_NUDGE_MARKER),
        "anchored turn nudge text MUST appear when nudgeAllowed is true",
    )
})

test("stale contextLimitAnchors cleared when context drops below maxLimit without compress (issue #27)", () => {
    const state = createSessionState()
    state.modelContextLimit = 1_000_000
    state.nudges.lastPerMessageNudgeTokens = 50_000
    state.nudges.contextLimitAnchors.add("stale-anchor-1")

    const config = buildConfig()
    config.compress.maxContextLimit = 200_000
    config.compress.minContextLimit = 50_000

    const messages: WithParts[] = [
        userMsg("u1", "hello"),
        assistantMsgWithTokens("a1", "done", { input: 90_000, output: 10_000 }),
    ]
    injectCompressNudges(state, config, logger, messages, {} as any)

    assert.equal(
        state.nudges.contextLimitAnchors.size,
        0,
        "stale contextLimitAnchors must be cleared when context drops below maxLimit",
    )
})

test("stale contextLimitAnchors cleared even when context below minLimit (Oracle L1)", () => {
    const state = createSessionState()
    state.modelContextLimit = 1_000_000
    state.nudges.lastPerMessageNudgeTokens = 10_000
    state.nudges.contextLimitAnchors.add("stale-anchor-1")

    const config = buildConfig()
    config.compress.maxContextLimit = 200_000
    config.compress.minContextLimit = 50_000

    const messages: WithParts[] = [
        userMsg("u1", "hello"),
        assistantMsgWithTokens("a1", "done", { input: 20_000, output: 10_000 }),
    ]
    injectCompressNudges(state, config, logger, messages, {} as any)

    assert.equal(
        state.nudges.contextLimitAnchors.size,
        0,
        "stale contextLimitAnchors must be cleared even when context is below minLimit",
    )
})

test("stale contextLimitAnchors: contextLimitNudge NOT injected when context below limit (issue #27)", () => {
    const CTX_LIMIT_MARKER = "CTX_LIMIT_MARKER"
    const TURN_NUDGE_MARKER = "TURN_NUDGE_MARKER"

    const makePrompts = () =>
        ({
            system: "",
            compressRange: "",
            compressMessage: "",
            contextLimitNudge: CTX_LIMIT_MARKER,
            turnNudge: TURN_NUDGE_MARKER,
            iterationNudge: "ITER_NUDGE_MARKER",
            manualExtension: "",
            subagentExtension: "",
            decompressExtension: "",
        }) as any

    const state = createSessionState()
    state.modelContextLimit = 1_000_000
    state.nudges.lastPerMessageNudgeTokens = 50_000
    state.nudges.contextLimitAnchors.add("stale-anchor-1")
    state.messageIds.byRawId.set("u1", "m00001")
    state.messageIds.byRawId.set("a1", "m00002")
    state.messageIds.byRawId.set("u2", "m00003")

    const config = buildConfig()
    config.compress.maxContextLimit = 200_000
    config.compress.minContextLimit = 50_000

    const messages: WithParts[] = [
        userMsg("u1", "hello"),
        assistantMsgWithTokens("a1", "done", { input: 90_000, output: 10_000 }, [
            toolPart("c1", "x".repeat(620_000)),
        ]),
        userMsg("u2", "next"),
    ]
    injectCompressNudges(state, config, logger, messages, makePrompts())

    assert.equal(state.nudges.shouldInjectThisTurn, true, "nudge fires (50K growth >= 22500 floor)")
    assert.equal(state.nudges.contextLimitAnchors.size, 0, "stale contextLimitAnchors cleared")

    const injected = suffixText(messages)
    assert.ok(
        !injected.includes(CTX_LIMIT_MARKER),
        "context limit nudge must NOT appear when context below maxLimit",
    )
    assert.ok(
        injected.includes(TURN_NUDGE_MARKER),
        "turn nudge SHOULD appear (overMinLimit + nudgeAllowed)",
    )
})
// Reminder threshold scales with context (via nudgeGrowthTokens); on a 1M model
// it is 50K, not the old hardcoded 5000. Tool chars ≈ JSON.stringify(part).length/4.

function suffixText(messages: WithParts[]): string {
    return messages
        .map((m) => m.parts.map((p: any) => (typeof p.text === "string" ? p.text : "")).join(""))
        .join("")
}

// --- modelContextLimit persistence (issue #18) ---
// modelContextLimit must survive restart so adaptive thresholds (nudgeGrowthTokens,
// toolOutputThreshold) don't fall to the 6000 floor on the first turn after reload.

const PERSIST_MODEL_LIMIT = "test-modelcontextlimit-persist"

async function cleanupModelLimitSession(): Promise<void> {
    const filePath = join(STORAGE_DIR, `${PERSIST_MODEL_LIMIT}.json`)
    if (existsSync(filePath)) {
        await fs.unlink(filePath)
    }
}

test("modelContextLimit persists across save/load round-trip (#18)", async () => {
    const state = createSessionState()
    state.sessionId = PERSIST_MODEL_LIMIT
    state.modelContextLimit = 1_000_000
    await cleanupModelLimitSession()

    await saveSessionState(state, logger)

    const loaded = await loadSessionState(PERSIST_MODEL_LIMIT, logger)
    assert.ok(loaded, "state file must exist after save")
    assert.equal(loaded!.modelContextLimit, 1_000_000, "modelContextLimit must survive round-trip")
    await cleanupModelLimitSession()
})

test("ensureSessionInitialized restores persisted modelContextLimit after restart (#18)", async () => {
    const seed = createSessionState()
    seed.sessionId = PERSIST_MODEL_LIMIT
    seed.modelContextLimit = 1_000_000
    await cleanupModelLimitSession()
    await saveSessionState(seed, logger)

    const fresh = createSessionState()
    assert.equal(fresh.modelContextLimit, undefined, "fresh state starts without modelContextLimit")
    await ensureSessionInitialized(null, fresh, PERSIST_MODEL_LIMIT, logger, [], false)

    assert.equal(
        fresh.modelContextLimit,
        1_000_000,
        "persisted modelContextLimit must be restored so adaptive thresholds use the real limit, not the 6K floor",
    )
    await cleanupModelLimitSession()
})

