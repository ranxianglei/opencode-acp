import "./test-env"
import assert from "node:assert/strict"
import test from "node:test"
import * as fs from "fs/promises"
import { existsSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"
import { injectMessageIds, injectCompressNudges } from "../lib/messages/inject/inject"
import { cacheSystemPromptTokens } from "../lib/ui/utils"
import { estimateContextComposition, resolveMinNudgeContextPercent, resolveMinNudgeFloorTokens } from "../lib/messages/inject/utils"
import { countTokens } from "../lib/token-utils"
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
            preserveRecentMessages: 0, preserveRecentTokens: 0, preserveLastUserMessage: false,
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
    // Growth floor is minNudgeContextPercent (15%, pinned by the buildConfig factory = 150K on a 1M model),
    // below the turn-2 context (305K), so the floor is open and this test
    // isolates the growth mechanism. minContextLimit no longer gates growth nudges.
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
    // Growth floor is minNudgeContextPercent (15%, pinned by the buildConfig factory = 150K on a 1M model),
    // at/below the turn contexts (150K/165K/175K), so the floor is open and this
    // test isolates the threshold-halving mechanism.
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

test("baseline initialized to currentTokens on first transform", () => {
    // Baseline = currentTokens. The system prompt is always present and is
    // NOT "growth" — measuring from currentTokens means the first nudge fires
    // at ~currentTokens + nudgeGrowthTokens, not at nudgeGrowthTokens absolute.
    const state = createSessionState()
    state.modelContextLimit = 1_000_000
    assert.equal(
        state.nudges.lastPerMessageNudgeTokens,
        undefined,
        "fresh state has undefined baseline — no growth tracking yet",
    )

    const config = buildConfig()
    config.compress.maxContextLimit = 500_000
    config.compress.minContextLimit = 200_000

    // Turn 1: first message transform. currentTokens = 55K (input 50K + output 5K).
    // Baseline is undefined → gets initialized to currentTokens. No nudge fires.
    const messages1: WithParts[] = [
        userMsg("u1", "hello"),
        assistantMsgWithTokens("a1", "work", { input: 50_000, output: 5_000 }),
    ]
    injectCompressNudges(state, config, logger, messages1, {} as any)

    assert.equal(
        state.nudges.lastPerMessageNudgeTokens,
        55_000,
        "baseline initialized to currentTokens — growth measured from starting context, not from 0",
    )
    assert.equal(
        state.nudges.shouldInjectThisTurn,
        false,
        "first turn never nudges — baseline establishment only",
    )

    // Turn 2: context grew slightly to 58K. Growth = 58K - 55K = 3K < 50K threshold.
    // Nudge MUST NOT fire — only 3K of real growth, not 50K.
    const messages2: WithParts[] = [
        userMsg("u2", "more"),
        assistantMsgWithTokens("a2", "work", { input: 53_000, output: 5_000 }),
    ]
    injectCompressNudges(state, config, logger, messages2, {} as any)

    assert.equal(
        state.nudges.shouldInjectThisTurn,
        false,
        "3K growth < 50K threshold → nudge correctly suppressed",
    )
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

test("nudge fires when small ranges exist — Issue #251: no floor suppression at large context", () => {
    // 1M model: growthThreshold=50K
    // Growth of 55K > 50K threshold → nudgeAllowed = true
    // Tool output is 80K chars (~20K tokens) — before #251 this was < 100K floor → suppressed
    // After #251: filterRecommendedRanges never suppresses → range shown → nudge fires
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
        true,
        "55K growth + 20K tool output → range recommended → nudge fires (Issue #251 fix)",
    )

    const injected = suffixText(messages)
    assert.ok(injected.includes("Breakdown:"), "breakdown shown when range recommended")
    assert.ok(!injected.includes("Context limit reached"), "no emergency alert — not at max limit")
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
    assert.equal(
        state.nudges.lastPerMessageNudgeTokens,
        200_000,
        "baseline PRESERVED — not advanced to currentTokens on nothingToCompress",
    )
})

test("emergency + all content protected emits /compact notice, not compress instructions (issue #216 residual)", () => {
    const state = createSessionState()
    state.modelContextLimit = 1_000_000
    state.nudges.lastPerMessageNudgeTokens = 980_000
    // No lastNudgeShownTokens → notice cadence met on first turn
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
        "98% emergency with all-protected content → notice injected (cadence-gated)",
    )
    assert.equal(
        state.nudges.lastNudgeShownTokens,
        980_000,
        "notice sets the nudge baseline so the cadence gate applies next turn",
    )

    const injected = suffixText(messages)
    assert.ok(injected.includes("/acp export"), "notice recommends archiving via /acp export first")
    assert.ok(injected.includes("/compact"), "notice recommends /compact")
    assert.ok(
        injected.includes("reply/message tool"),
        "notice frames the advice as model-actionable (inform user), not user-command execution",
    )
    assert.ok(
        !injected.includes("Context limit reached — compress now"),
        "no compress-now demand when nothing is compressible (phantom-retry loop driver)",
    )
    assert.ok(
        !injected.includes("Compressible ranges"),
        "no compressible-ranges list — there is nothing valid to compress",
    )
})

test("emergency notice is cadence-gated across turns — no per-turn nagging (issue #216 residual)", () => {
    const state = createSessionState()
    state.modelContextLimit = 1_000_000
    state.nudges.lastPerMessageNudgeTokens = 980_000
    state.messageIds.byRawId.set("a1", "m00001")
    state.messageIds.byRawId.set("a2", "m00002")
    state.messageIds.byRawId.set("a3", "m00003")

    const config = buildConfig()
    config.compress.protectedTools = ["skill"]
    config.compress.maxContextLimit = 500_000
    config.compress.minContextLimit = 200_000

    const protectedTurn = (id: string, input: number, output = 2_000) =>
        assistantMsgWithTokens(id, "done", { input, output }, [
            {
                id: `skill-${id}`, messageID: id, sessionID: SID,
                type: "tool" as const, tool: "skill", callID: `call-${id}`,
                state: { status: "completed" as const, input: {}, output: "x".repeat(4_000) },
            },
        ])

    // Turn 1: emergency (980K = 98% of 1M) + all protected, fresh baseline → notice fires
    injectCompressNudges(state, config, logger, [protectedTurn("a1", 978_000)], {} as any)
    assert.equal(state.nudges.shouldInjectThisTurn, true, "turn 1: notice fires")
    assert.equal(state.nudges.lastNudgeShownTokens, 980_000, "turn 1: baseline set to current")

    // Turn 2: growth 3K < growthFloor 22.5K → notice silent
    injectCompressNudges(state, config, logger, [protectedTurn("a2", 981_000)], {} as any)
    assert.equal(state.nudges.shouldInjectThisTurn, false, "turn 2: below growth floor → silent")
    assert.equal(state.nudges.lastNudgeShownTokens, 980_000, "turn 2: baseline preserved")

    // Turn 3: growth 25K ≥ growthFloor 22.5K → notice re-fires
    injectCompressNudges(state, config, logger, [protectedTurn("a3", 999_000, 6_000)], {} as any)
    assert.equal(
        state.nudges.shouldInjectThisTurn,
        true,
        "turn 3: growth 25K ≥ 22.5K floor → notice re-fires",
    )
    assert.equal(state.nudges.lastNudgeShownTokens, 1_005_000, "turn 3: baseline advanced")
})

test("emergency + everything inside preserve-recent zone emits notice, not compress demand (production config)", () => {
    // §5.7.1 (production config): ordinary content inside the preserve-recent window → allInProtectedZone → notice.
    const state = createSessionState()
    state.modelContextLimit = 1_000_000
    state.nudges.lastPerMessageNudgeTokens = 980_000
    state.messageIds.byRawId.set("u1", "m00001")
    state.messageIds.byRawId.set("a1", "m00002")

    const config = buildConfig()
    config.compress.preserveRecentMessages = 20
    config.compress.preserveRecentTokens = 5_000
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
        "emergency + preserve-recent zone → notice injected",
    )
    const injected = suffixText(messages)
    assert.ok(injected.includes("critically full"), "notice text present")
    assert.ok(
        !injected.includes("Context limit reached — compress now"),
        "no compress-now demand when everything is in the preserve-recent zone",
    )
})

test("emergency with sub-floor ranges emits notice — phantom-retry loop regression (incident ses_7fb5cbc8)", () => {
    // Incident shape: ranges LOOK compressible by raw size but effective tokens
    // fall below the minCompressRange floor → pipeline rejects every attempt.
    const state = createSessionState()
    state.modelContextLimit = 1_000_000
    state.nudges.lastPerMessageNudgeTokens = 980_000
    state.messageIds.byRawId.set("u1", "m00001")
    state.messageIds.byRawId.set("a1", "m00002")

    const config = buildConfig()
    config.compress.maxContextLimit = 500_000
    config.compress.minContextLimit = 200_000

    const messages: WithParts[] = [
        userMsg("u1", "hello"),
        assistantMsgWithTokens("a1", "done", { input: 970_000, output: 10_000 }, [
            toolPart("c1", "x".repeat(2_000)),
        ]),
    ]
    injectCompressNudges(state, config, logger, messages, {} as any)

    assert.equal(state.nudges.shouldInjectThisTurn, true, "emergency fires")
    const injected = suffixText(messages)
    assert.ok(
        injected.includes("/compact"),
        "allBelowMin at emergency → /compact notice, not compress demand",
    )
    assert.ok(
        !injected.includes("Context limit reached — compress now"),
        "no compress-now demand for sub-floor ranges",
    )
})

test("baseline preserved when nudge suppressed — growth accumulates (all protected)", () => {
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
        200_000,
        "baseline preserved — not advanced on nothingToCompress",
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
        "still all protected → suppressed (growth 60K from preserved baseline)",
    )
    assert.equal(
        state.nudges.lastPerMessageNudgeTokens,
        200_000,
        "baseline still preserved — growth accumulates until compressible content exists",
    )
})

test("baseline preserved when nudge fires for small compressible — Issue #251", () => {
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
    assert.equal(state.nudges.shouldInjectThisTurn, true, "55K growth + 20K compressible → nudge fires (Issue #251)")
    assert.equal(
        state.nudges.lastPerMessageNudgeTokens,
        200_000,
        "baseline preserved on nudge fire — only advances after actual compression (inject.ts:537)",
    )
})

test("pending nudge preserved when all-protected — no loop", () => {
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
        200_000,
        "pending nudge baseline preserved — prevents loop (stale fallback → huge growth → re-fire)",
    )
    assert.equal(
        state.nudges.lastPerMessageNudgeTokens,
        200_000,
        "baseline preserved — growth accumulates for next turn",
    )
})

test("multi-turn: all-protected does not loop (lastNudgeShownTokens stable)", () => {
    const state = createSessionState()
    state.modelContextLimit = 1_000_000
    state.messageIds.byRawId.set("a1", "m00001")
    state.messageIds.byRawId.set("a2", "m00002")
    state.messageIds.byRawId.set("a3", "m00003")

    const config = buildConfig()
    config.compress.protectedTools = ["skill"]
    config.compress.maxContextLimit = 500_000
    config.compress.minContextLimit = 200_000

    state.nudges.lastPerMessageNudgeTokens = 200_000

    const protectedTurn = (id: string, inputTokens: number) =>
        assistantMsgWithTokens(id, "work", { input: inputTokens, output: 30_000 }, [
            {
                id: `${id}-part`, messageID: id, sessionID: SID,
                type: "tool" as const, tool: "skill", callID: `${id}-call`,
                state: { status: "completed" as const, input: {}, output: "x".repeat(80_000) },
            },
        ])

    // Turn 1: nudge suppressed (all protected)
    injectCompressNudges(state, config, logger, [protectedTurn("a1", 225_000)], {} as any)
    assert.equal(state.nudges.shouldInjectThisTurn, false, "turn 1: all protected, nudge suppressed")
    assert.equal(state.nudges.lastNudgeShownTokens, undefined, "turn 1: no nudge shown yet")

    state.nudges.lastNudgeShownTokens = 225_000

    // Turn 2: growth continues, still all-protected
    injectCompressNudges(state, config, logger, [protectedTurn("a2", 230_000)], {} as any)
    assert.equal(state.nudges.shouldInjectThisTurn, false, "turn 2: still all protected")
    assert.equal(
        state.nudges.lastNudgeShownTokens,
        225_000,
        "turn 2: baseline preserved — NOT reset (prevents loop)",
    )

    // Turn 3: more growth, still all-protected
    injectCompressNudges(state, config, logger, [protectedTurn("a3", 240_000)], {} as any)
    assert.equal(state.nudges.shouldInjectThisTurn, false, "turn 3: still all protected")
    assert.equal(
        state.nudges.lastNudgeShownTokens,
        225_000,
        "turn 3: baseline still preserved — no loop",
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
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 200_000, "turn 1: baseline preserved")
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
        200_000,
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

test("growth floor: 5000 floor when nudgeGrowthTokens configured low", () => {
    // Explicit nudgeGrowthTokens=6000 (config override; fixed default is 50K)
    // growthFloor = max(5000, 0.45×6000) = max(5000, 2700) = 5000
    // Growth of 4K < 5000 → suppressed. Growth of 6K >= 5000 → fires.
    const state = createSessionState()
    state.modelContextLimit = 100_000
    state.nudges.lastPerMessageNudgeTokens = 20_000
    state.messageIds.byRawId.set("u1", "m00001")
    state.messageIds.byRawId.set("a1", "m00002")

    const config = buildConfig()
    config.compress.nudgeGrowthTokens = 6_000
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
        assistantMsgWithTokens("a1", "done", { input: 140_000, output: 10_000 }, [
            toolPart("c1", "x".repeat(620_000)),
        ]),
        userMsg("u2", "next"),
    ]
    injectCompressNudges(state, config, logger, messages, makePrompts())

    assert.equal(state.nudges.shouldInjectThisTurn, true, "nudge fires (100K growth >= 22500 growthFloor, 150K >= 15% floor)")
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

test("E2E growth: baseline preserved through nothingToCompress, nudge fires when content exits protected zone", () => {
    const state = createSessionState()
    state.modelContextLimit = 1_000_000

    const config = buildConfig()
    config.compress.maxContextLimit = 500_000
    config.compress.minContextLimit = 200_000
    config.compress.protectedTools = ["skill"]
    config.compress.preserveRecentMessages = 20
    config.compress.preserveRecentTokens = 0
    config.compress.preserveLastUserMessage = false

    function buildMessages(n: number, toolOutputSize: number = 200_000): WithParts[] {
        const msgs: WithParts[] = []
        for (let i = 1; i <= n; i++) {
            const uid = `u${i}`
            const aid = `a${i}`
            if (!state.messageIds.byRawId.has(uid)) state.messageIds.byRawId.set(uid, `m${String(i * 2 - 1).padStart(5, "0")}`)
            if (!state.messageIds.byRawId.has(aid)) state.messageIds.byRawId.set(aid, `m${String(i * 2).padStart(5, "0")}`)
            msgs.push(userMsg(uid, `task ${i}`))
            msgs.push(assistantMsgWithTokens(aid, `result ${i}`, { input: 200_000, output: 80_000 }, [
                toolPart(`tp${i}`, "x".repeat(toolOutputSize)),
            ]))
        }
        return msgs
    }

    state.nudges.lastPerMessageNudgeTokens = 200_000

    const turn1 = buildMessages(5)
    injectCompressNudges(state, config, logger, turn1, {} as any)
    assert.equal(state.nudges.shouldInjectThisTurn, false, "turn 1: 5 msgs, all within 20-msg protection → suppressed")
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 200_000, "turn 1: baseline PRESERVED")

    const turn2 = buildMessages(10)
    injectCompressNudges(state, config, logger, turn2, {} as any)
    assert.equal(state.nudges.shouldInjectThisTurn, false, "turn 2: 10 msgs, still within 20-msg protection → suppressed")
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 200_000, "turn 2: baseline STILL PRESERVED — growth accumulating")

    const turn3 = buildMessages(25)
    injectCompressNudges(state, config, logger, turn3, {} as any)
    assert.equal(
        state.nudges.shouldInjectThisTurn,
        true,
        "turn 3: 50 msgs, first 30 outside 20-msg protection, large outputs → nudge FIRES",
    )
    assert.equal(
        state.nudges.lastPerMessageNudgeTokens,
        200_000,
        "turn 3: baseline still at original — growth accumulated correctly, not eaten by old bug",
    )
})

test("E2E autonomous: nudge re-fires after compress in same turn (Issue #176)", () => {
    const state = createSessionState()
    state.sessionId = "test-issue-176"
    state.modelContextLimit = 1_000_000

    const config = buildConfig()
    config.compress.maxContextLimit = 500_000
    config.compress.minContextLimit = 200_000
    config.compress.protectedTools = ["skill"]
    config.compress.preserveRecentMessages = 5
    config.compress.preserveRecentTokens = 0
    config.compress.preserveLastUserMessage = false

    // Autonomous session: single user message (like an agentic task)
    state.messageIds.byRawId.set("u1", "m00001")

    state.nudges.lastPerMessageNudgeTokens = 200_000

    const phase1: WithParts[] = [userMsg("u1", "do the task")]
    for (let i = 0; i < 20; i++) {
        const id = `a_p1_${i}`
        const ref = `m${String(i + 2).padStart(5, "0")}`
        state.messageIds.byRawId.set(id, ref)
        phase1.push(assistantMsgWithTokens(id, "work", { input: 300_000, output: 100_000 }, [
            toolPart(`tp_p1_${i}`, "x".repeat(50_000)),
        ]))
    }
    injectCompressNudges(state, config, logger, phase1, {} as any)
    assert.equal(
        state.nudges.shouldInjectThisTurn,
        true,
        "phase 1: first nudge should fire — enough growth and compressible content",
    )
    assert.notEqual(
        state.nudges.lastNudgeShownTokens,
        undefined,
        "phase 1: lastNudgeShownTokens should be set",
    )

    const compressId1 = "a_compress_1"
    state.messageIds.byRawId.set(compressId1, "m09001")
    const phase2 = [...phase1, assistantMsg(compressId1, "compressed", [
        compressToolPart("compress-1", "compression result"),
    ])]
    injectCompressNudges(state, config, logger, phase2, {} as any, undefined, undefined, 400_000)
    assert.equal(
        state.nudges.lastNudgeShownTokens,
        undefined,
        "phase 2: anchors cleared after compress detected",
    )
    assert.equal(
        state.nudges.compressBaselineSet,
        true,
        "phase 2: baseline should be adjusted after successful compress",
    )

    // Phase 3: More work accumulates past the same growth threshold
    // In the buggy code, currentTurnHasCompress is STILL true (same compress msg in
    // turn), so the function ALWAYS returns early — nudge NEVER re-fires.
    // After fix: the already-processed compress is detected, function falls through
    // to normal evaluation, and the new nudge fires.
    const phase3 = [...phase2]
    for (let i = 0; i < 20; i++) {
        const id = `a_p3_${i}`
        const ref = `m${String(i + 22).padStart(5, "0")}`
        state.messageIds.byRawId.set(id, ref)
        phase3.push(assistantMsgWithTokens(id, "more work", { input: 350_000, output: 120_000 }, [
            toolPart(`tp_p3_${i}`, "x".repeat(50_000)),
        ]))
    }
    injectCompressNudges(state, config, logger, phase3, {} as any)

    // THE BUG: shouldInjectThisTurn should be true but is false/stale
    assert.equal(
        state.nudges.shouldInjectThisTurn,
        true,
        "phase 3: nudge SHOULD re-fire after sufficient growth post-compress (Issue #176)",
    )
    assert.notEqual(
        state.nudges.lastNudgeShownTokens,
        undefined,
        "phase 3: lastNudgeShownTokens should be set again — nudge actually injected",
    )
})

test("E2E autonomous: second compress also gets processed (Issue #176 multi-compress)", () => {
    const state = createSessionState()
    state.sessionId = "test-issue-176-multi"
    state.modelContextLimit = 1_000_000

    const config = buildConfig()
    config.compress.maxContextLimit = 500_000
    config.compress.minContextLimit = 200_000
    config.compress.protectedTools = ["skill"]
    config.compress.preserveRecentMessages = 5
    config.compress.preserveRecentTokens = 0
    config.compress.preserveLastUserMessage = false

    state.messageIds.byRawId.set("u1", "m00001")

    function mkAssistants(prefix: string, count: number, startRef: number, input: number = 300_000): WithParts[] {
        const msgs: WithParts[] = []
        for (let i = 0; i < count; i++) {
            const id = `a_${prefix}_${i}`
            const ref = `m${String(startRef + i).padStart(5, "0")}`
            state.messageIds.byRawId.set(id, ref)
            msgs.push(assistantMsgWithTokens(id, "work", { input, output: 100_000 }, [
                toolPart(`tp_${prefix}_${i}`, "x".repeat(50_000)),
            ]))
        }
        return msgs
    }

    function mkCompress(id: string, ref: string, callId: string): WithParts {
        state.messageIds.byRawId.set(id, ref)
        return assistantMsg(id, "compressed", [
            compressToolPart(callId, "compression result"),
        ])
    }

    state.nudges.lastPerMessageNudgeTokens = 200_000

    const phase1: WithParts[] = [userMsg("u1", "do the task"), ...mkAssistants("p1", 20, 2)]
    injectCompressNudges(state, config, logger, phase1, {} as any)
    assert.equal(state.nudges.shouldInjectThisTurn, true, "phase 1: first nudge fires")

    const phase2 = [...phase1, mkCompress("a_compress_1", "m09001", "compress-1")]
    injectCompressNudges(state, config, logger, phase2, {} as any, undefined, undefined, 400_000)
    assert.equal(state.nudges.lastNudgeShownTokens, undefined, "phase 2: first compress processed")

    const phase3 = [...phase2, ...mkAssistants("p3", 20, 100, 350_000)]
    injectCompressNudges(state, config, logger, phase3, {} as any)
    assert.equal(state.nudges.shouldInjectThisTurn, true, "phase 3: second nudge fires")
    assert.notEqual(state.nudges.lastNudgeShownTokens, undefined, "phase 3: nudge injected")

    const phase4 = [...phase3, mkCompress("a_compress_2", "m09002", "compress-2")]
    injectCompressNudges(state, config, logger, phase4, {} as any, undefined, undefined, 450_000)
    assert.equal(state.nudges.lastNudgeShownTokens, undefined, "phase 4: second compress processed")
    assert.equal(state.nudges.compressBaselineSet, true, "phase 4: second baseline adjustment")

    const phase5 = [...phase4, ...mkAssistants("p5", 20, 200, 400_000)]
    injectCompressNudges(state, config, logger, phase5, {} as any)
    assert.equal(
        state.nudges.shouldInjectThisTurn,
        true,
        "phase 5: third nudge fires after second compress — no permanent stuck state",
    )
})

test("T2 cadence: does NOT immediately re-fire after compress attempt (T2 loop bug)", () => {
    const state = createSessionState()
    state.sessionId = "test-t2-cadence"
    state.modelContextLimit = 1_000_000

    const config = buildConfig()
    config.compress.maxContextLimit = 500_000
    config.compress.minContextLimit = 200_000
    config.compress.nudgeGrowthTokens = 10_000
    config.compress.minNudgeGrowthFloor = 5_000
    config.compress.minNudgeGrowthRatio = 0.01
    config.compress.preserveRecentMessages = 0
    config.compress.preserveRecentTokens = 0
    config.compress.preserveLastUserMessage = false

    // Seed T1 blocks so tier1Tokens >= nudgeGrowthTokens
    for (let i = 0; i < 5; i++) {
        const blockId = i + 1
        state.prune.messages.blocksById.set(blockId, {
            blockId,
            runId: i + 1,
            active: true,
            tier: 1,
            generation: "young",
            survivedCount: 1,
            directMessageIds: [],
            effectiveMessageIds: [],
            consumedBlockIds: [],
            parentBlockIds: [],
            summary: "T1 summary ".repeat(200),
            summaryTokens: 5_000,
            topic: `T1 block ${i}`,
            createdAt: Date.now(),
        })
        state.prune.messages.activeBlockIds.add(blockId)
    }

    state.messageIds.byRawId.set("u1", "m00001")

    function mkAssistant(id: string, ref: string, inputTokens: number): WithParts {
        state.messageIds.byRawId.set(id, ref)
        return assistantMsgWithTokens(id, "work", { input: inputTokens, output: 50_000 }, [
            toolPart(`${id}-tool`, "x".repeat(10_000)),
        ])
    }

    // Phase 1: T1 won't fire (baseline very high → negative growth),
    // but T2 should fire because tier1Tokens = 25K >= nudgeGrowthTokens
    state.nudges.lastPerMessageNudgeTokens = 500_000

    const phase1: WithParts[] = [
        userMsg("u1", "do the task"),
        mkAssistant("a1", "m00002", 300_000),
    ]
    injectCompressNudges(state, config, logger, phase1, {} as any)

    assert.equal(
        state.nudges.shouldInjectThisTurn,
        true,
        "phase 1: T2 should fire (tier1 blocks accumulated, T1 suppressed by high baseline)",
    )
    assert.notEqual(
        state.nudges.lastTier2NudgeTokens,
        undefined,
        "phase 1: lastTier2NudgeTokens should be set after T2 fires",
    )

    // Phase 2: Compress attempt appears in the turn.
    // The compress-processing block runs, resetting tier cadence baselines.
    // BEFORE FIX: lastTier2NudgeTokens = undefined → T2 re-fires next turn
    // AFTER FIX:  lastTier2NudgeTokens = currentTokens → growthFloor gate applies
    const phase2 = [...phase1]
    const compressId = "a_compress_1"
    const compressRef = "m09001"
    state.messageIds.byRawId.set(compressId, compressRef)
    phase2.push(assistantMsg(compressId, "compressed", [
        compressToolPart("compress-1", "compression result"),
    ]))

    injectCompressNudges(state, config, logger, phase2, {} as any, undefined, undefined, 310_000)

    assert.notEqual(
        state.nudges.lastTier2NudgeTokens,
        undefined,
        "phase 2: lastTier2NudgeTokens must NOT be undefined after compress (was the bug)",
    )

    // Phase 3: Next turn — no new compress, small growth (< growthFloor).
    // T2 should NOT fire because growth < growthFloor.
    // BEFORE FIX: lastTier2NudgeTokens was reset to undefined → cadence always met → T2 fires.
    // AFTER FIX:  lastTier2NudgeTokens = currentTokens → growthFloor gate blocks re-fire.
    const phase3 = [...phase2, mkAssistant("a3", "m00003", 301_000)]
    injectCompressNudges(state, config, logger, phase3, {} as any)

    assert.notEqual(
        state.nudges.lastTier2NudgeTokens,
        undefined,
        "phase 3: lastTier2NudgeTokens should still be defined (not reset to undefined)",
    )
    assert.equal(
        state.nudges.shouldInjectThisTurn,
        false,
        "phase 3: T2 should NOT re-fire with growth < growthFloor (the T2 loop bug)",
    )
})

function buildMultiTurn(n: number, input: number, toolOutputChars: number): WithParts[] {
    const msgs: WithParts[] = []
    for (let i = 1; i <= n; i++) {
        msgs.push(userMsg(`u${i}`, `task ${i}`))
        msgs.push(
            assistantMsgWithTokens(`a${i}`, `result ${i}`, { input, output: 20_000 }, [
                toolPart(`t${i}`, "x".repeat(toolOutputChars)),
            ]),
        )
    }
    return msgs
}

test("Issue #255: stable system prompt cache survives compression in multi-turn nudge cycle (§5.7)", () => {
    const state = createSessionState()
    state.modelContextLimit = 1_000_000
    const config = buildConfig()
    config.compress.maxContextLimit = 800_000
    config.compress.minContextLimit = 200_000
    config.compress.preserveRecentMessages = 20

    // Turn 1: full history — first assistant input ≈ system + first user
    const turn1: WithParts[] = [
        userMsg("u1", "hello"),
        assistantMsgWithTokens("a1", "done", { input: 10_000, output: 5_000 }),
    ]
    cacheSystemPromptTokens(state, turn1)
    const stableSystem = state.systemPromptTokens
    assert.ok(stableSystem !== undefined && stableSystem > 0, "first measurement caches a stable system estimate")
    assert.equal(stableSystem, 10_000 - countTokens("hello"))

    injectCompressNudges(state, config, logger, turn1, {} as any)
    assert.equal(state.nudges.shouldInjectThisTurn, false, "turn 1: baseline only")
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 15_000, "turn 1: baseline = first assistant input+output")

    // Turn 2: 25 rounds of growth → nudge fires. 50 messages exceed the 20-msg
    // protection window so compressible ranges exist. First assistant in this
    // array is a later turn (input 300K) — composition must still use the cache.
    const turn2 = buildMultiTurn(25, 300_000, 40_000)
    cacheSystemPromptTokens(state, turn2)
    assert.equal(state.systemPromptTokens, stableSystem, "turn 2: degraded array must not overwrite the cache")
    injectCompressNudges(state, config, logger, turn2, {} as any)
    assert.equal(state.nudges.shouldInjectThisTurn, true, "turn 2: 335K growth ≥ 50K threshold → nudge")
    assert.equal(state.nudges.lastNudgeShownTokens, 320_000, "turn 2: nudge shown tokens recorded")

    const comp2 = estimateContextComposition(turn2, state)
    assert.equal(comp2.systemTokens, stableSystem, "turn 2: composition uses cached system, not inflated 300K-4 estimate")

    // Turn 3: compress → new baseline
    const turn3: WithParts[] = [
        userMsg("u3", "compress now"),
        assistantMsgWithTokens("a3", "done", { input: 350_000, output: 10_000 }, [
            compressToolPart("c1", "compressed"),
        ]),
    ]
    injectCompressNudges(state, config, logger, turn3, {} as any)
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 360_000, "turn 3: compress sets new baseline to post-compression tokens")
    assert.equal(state.nudges.compressBaselineSet, true, "turn 3: baseline locked after compress")

    // Turn 4: post-compression growth → nudge again. Visible history no longer
    // contains the true first assistant; first visible assistant input ≈ 460K.
    const turn4 = buildMultiTurn(25, 460_000, 40_000)
    cacheSystemPromptTokens(state, turn4)
    assert.equal(state.systemPromptTokens, stableSystem, "turn 4: cache must NOT be overwritten by degraded array")
    injectCompressNudges(state, config, logger, turn4, {} as any)
    assert.equal(state.nudges.shouldInjectThisTurn, true, "turn 4: 110K growth from post-compress baseline → nudge again")
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 360_000, "turn 4: baseline preserved (only compress resets)")

    const comp4 = estimateContextComposition(turn4, state)
    assert.equal(comp4.systemTokens, stableSystem, "turn 4: composition still uses stable cached system, not inflated 460K estimate")
    assert.ok(comp4.systemTokens < 200_000, "turn 4: system estimate must not inflate to later assistant input")
})

// ── Issue #342: T1 growth nudges must respect the minNudgeContextPercent floor ──
// computeShouldNudge() only uses overMinLimit/overMaxLimit to pick the tips
// variant, so the growth floor is enforced in inject.ts (nudgeAllowed):
// minNudgeContextPercent × model context. These tests lock that floor: growth
// nudges are suppressed below it and fire once context crosses it, while
// over-max / emergency paths and T2/T3 tier promotion remain independent.

test("issue #342: growth nudge suppressed below the minNudgeContextPercent floor, fires once context crosses it", () => {
    const state = createSessionState()
    state.modelContextLimit = 1_000_000
    state.nudges.lastPerMessageNudgeTokens = 100_000
    state.messageIds.byRawId.set("u1", "m00001")
    state.messageIds.byRawId.set("a1", "m00002")
    state.messageIds.byRawId.set("u2", "m00003")
    state.messageIds.byRawId.set("a2", "m00004")

    const config = buildConfig()
    config.compress.maxContextLimit = 800_000
    config.compress.minNudgeContextPercent = 30 // floor at 30% of 1M = 300K

    // Turn 1: currentTokens = 200K (180K+20K). Growth = 200K-100K = 100K >= 50K threshold
    // AND >= 22.5K growthFloor, but 200K < 300K floor → the floor SUPPRESSES the growth nudge.
    const turn1: WithParts[] = [
        userMsg("u1", "hello"),
        assistantMsgWithTokens("a1", "done", { input: 180_000, output: 20_000 }, [
            toolPart("c1", "x".repeat(80_000)),
        ]),
    ]
    injectCompressNudges(state, config, logger, turn1, {} as any)
    assert.equal(state.nudges.shouldInjectThisTurn, false, "200K < 300K floor → growth nudge suppressed despite 100K growth")
    assert.equal(state.nudges.lastNudgeShownTokens, undefined, "no nudge shown below floor")
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 100_000, "baseline preserved below floor (not advanced)")

    // Turn 2: currentTokens = 320K (300K+20K). Growth = 320K-100K = 220K >= 50K.
    // 320K >= 300K floor → floor OPEN → nudge FIRES.
    const turn2: WithParts[] = [
        userMsg("u1", "hello"),
        assistantMsgWithTokens("a1", "done", { input: 180_000, output: 20_000 }, [
            toolPart("c1", "x".repeat(80_000)),
        ]),
        userMsg("u2", "next"),
        assistantMsgWithTokens("a2", "more", { input: 300_000, output: 20_000 }, [
            toolPart("c2", "x".repeat(80_000)),
        ]),
    ]
    injectCompressNudges(state, config, logger, turn2, {} as any)
    assert.equal(state.nudges.shouldInjectThisTurn, true, "320K >= 300K floor + 220K growth → nudge fires")
    assert.equal(state.nudges.lastNudgeShownTokens, 320_000, "lastNudgeShownTokens set to currentTokens")
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 100_000, "baseline NOT updated after nudge — only compress resets")
})

test("issue #342: full growth cycle baseline → nudge → compress → new baseline → nudge (min-gate open)", () => {
    const state = createSessionState()
    state.modelContextLimit = 1_000_000
    state.messageIds.byRawId.set("u1", "m00001")
    state.messageIds.byRawId.set("a1", "m00002")
    state.messageIds.byRawId.set("u2", "m00003")
    state.messageIds.byRawId.set("a2", "m00004")
    state.messageIds.byRawId.set("u3", "m00005")
    state.messageIds.byRawId.set("a3", "m00006")

    const config = buildConfig()
    config.compress.maxContextLimit = 800_000
    config.compress.minNudgeContextPercent = 30 // floor at 30% of 1M = 300K

    // Turn 1: first transform → baseline established at 150K. No nudge.
    const turn1: WithParts[] = [
        userMsg("u1", "hello"),
        assistantMsgWithTokens("a1", "work", { input: 130_000, output: 20_000 }, [
            toolPart("c1", "x".repeat(80_000)),
        ]),
    ]
    injectCompressNudges(state, config, logger, turn1, {} as any)
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 150_000, "turn 1: baseline established at 150K")
    assert.equal(state.nudges.shouldInjectThisTurn, false, "turn 1: baseline establishment only")

    // Turn 2: currentTokens = 350K (>= 300K floor), growth = 350K-150K = 200K >= 50K → nudge fires.
    const turn2: WithParts[] = [
        userMsg("u1", "hello"),
        assistantMsgWithTokens("a1", "work", { input: 130_000, output: 20_000 }, [
            toolPart("c1", "x".repeat(80_000)),
        ]),
        userMsg("u2", "next"),
        assistantMsgWithTokens("a2", "more", { input: 330_000, output: 20_000 }, [
            toolPart("c2", "x".repeat(80_000)),
        ]),
    ]
    injectCompressNudges(state, config, logger, turn2, {} as any)
    assert.equal(state.nudges.shouldInjectThisTurn, true, "turn 2: 350K >= 300K floor + 200K growth → nudge fires")
    assert.equal(state.nudges.lastNudgeShownTokens, 350_000, "turn 2: nudge baseline set to currentTokens")

    // Turn 3: model compresses → baseline reset to post-compress 200K.
    const turn3: WithParts[] = [
        userMsg("u1", "hello"),
        assistantMsgWithTokens("a1", "work", { input: 130_000, output: 20_000 }, [
            toolPart("c1", "x".repeat(80_000)),
        ]),
        userMsg("u2", "next"),
        assistantMsgWithTokens("a2", "compressing", { input: 180_000, output: 20_000 }, [
            compressToolPart("c2", "compressed"),
        ]),
    ]
    injectCompressNudges(state, config, logger, turn3, {} as any)
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 200_000, "turn 3: compress resets baseline to post-compress 200K")
    assert.equal(state.nudges.shouldInjectThisTurn, false, "turn 3: compress turn, no nudge")

    // Turn 4: currentTokens = 400K (>= 300K floor), growth = 400K-200K = 200K >= 50K → nudge fires again.
    const turn4: WithParts[] = [
        userMsg("u3", "more"),
        assistantMsgWithTokens("a3", "result", { input: 380_000, output: 20_000 }, [
            toolPart("c3", "x".repeat(80_000)),
        ]),
    ]
    injectCompressNudges(state, config, logger, turn4, {} as any)
    assert.equal(state.nudges.shouldInjectThisTurn, true, "turn 4: 400K >= 300K floor + 200K growth from new baseline → nudge fires again")
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 200_000, "turn 4: baseline NOT updated after nudge")
})

test("issue #342: growth floor holds in production config (preserveRecentMessages > 0)", () => {
    const state = createSessionState()
    state.modelContextLimit = 1_000_000
    state.nudges.lastPerMessageNudgeTokens = 100_000
    state.messageIds.byRawId.set("u1", "m00001")
    state.messageIds.byRawId.set("a1", "m00002")
    state.messageIds.byRawId.set("u2", "m00003")
    state.messageIds.byRawId.set("a2", "m00004")

    const config = buildConfig()
    config.compress.preserveRecentMessages = 2 // production-like: last 2 messages protected
    config.compress.maxContextLimit = 800_000
    config.compress.minNudgeContextPercent = 30 // floor at 30% of 1M = 300K

    // 4 messages; last 2 (u2, a2) in preserve-recent zone, a1's tool output compressible.
    // currentTokens = 200K (a2: 180K+20K) < 300K floor → the floor suppresses (compressible
    // content exists, so this is the floor, not nothingToCompress).
    const messages: WithParts[] = [
        userMsg("u1", "hello"),
        assistantMsgWithTokens("a1", "done", { input: 180_000, output: 20_000 }, [
            toolPart("c1", "x".repeat(80_000)),
        ]),
        userMsg("u2", "next"),
        assistantMsgWithTokens("a2", "more", { input: 180_000, output: 20_000 }),
    ]
    injectCompressNudges(state, config, logger, messages, {} as any)
    assert.equal(state.nudges.shouldInjectThisTurn, false, "200K < 300K floor → floor suppresses in production config")
    assert.equal(state.nudges.lastNudgeShownTokens, undefined, "no nudge shown below floor")
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 100_000, "baseline preserved")
})

test("issue #342: over-max nudge bypasses the growth floor", () => {
    // Defensive: even when the growth floor (minNudgeContextPercent) is set above
    // the current context, an over-max context must still nudge — overMaxLimit
    // bypasses the floor.
    const state = createSessionState()
    state.modelContextLimit = 1_000_000
    state.nudges.lastPerMessageNudgeTokens = 100_000
    state.messageIds.byRawId.set("u1", "m00001")
    state.messageIds.byRawId.set("a1", "m00002")

    const config = buildConfig()
    config.compress.maxContextLimit = 500_000
    config.compress.minNudgeContextPercent = 80 // floor at 80% of 1M = 800K (above context)

    // currentTokens = 550K (500K+50K). overMaxLimit (550K > 500K) but below the
    // 800K floor. Growth = 450K >= 50K. The floor would suppress, but overMaxLimit
    // bypasses it.
    const messages: WithParts[] = [
        userMsg("u1", "hello"),
        assistantMsgWithTokens("a1", "done", { input: 500_000, output: 50_000 }, [
            toolPart("c1", "x".repeat(80_000)),
        ]),
    ]
    injectCompressNudges(state, config, logger, messages, {} as any)
    assert.equal(state.nudges.shouldInjectThisTurn, true, "550K > 500K max → nudge fires despite 550K < 800K floor (overMaxLimit bypass)")
    assert.equal(state.nudges.lastNudgeShownTokens, 550_000, "nudge baseline set")
})

test("issue #342: growth nudge still fires when the model context limit is unknown (floor unresolvable)", () => {
    // Regression lock: when the model does not report a context limit, the
    // minNudgeContextPercent floor cannot be computed. The floor must NOT be
    // treated as "below floor" — growth nudges keep their pre-#342 growth-only
    // behavior instead of being suppressed for the whole session.
    const state = createSessionState()
    // state.modelContextLimit intentionally left undefined
    state.nudges.lastPerMessageNudgeTokens = 100_000
    state.messageIds.byRawId.set("u1", "m00001")
    state.messageIds.byRawId.set("a1", "m00002")

    const config = buildConfig()
    config.compress.maxContextLimit = "80%" // percent → unresolvable without a model limit

    // currentTokens = 200K (180K+20K). Growth = 200K-100K = 100K >= 50K threshold
    // AND >= 22.5K growthFloor. Model limit unknown → floor unresolvable → nudge FIRES.
    const messages: WithParts[] = [
        userMsg("u1", "hello"),
        assistantMsgWithTokens("a1", "done", { input: 180_000, output: 20_000 }, [
            toolPart("c1", "x".repeat(80_000)),
        ]),
    ]
    injectCompressNudges(state, config, logger, messages, {} as any)
    assert.equal(state.nudges.shouldInjectThisTurn, true, "unknown model limit → floor unresolvable → growth-only behavior preserved (nudge fires)")
    assert.equal(state.nudges.lastNudgeShownTokens, 200_000, "nudge baseline set")
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 100_000, "baseline NOT updated after nudge")
})

test("issue #342: T2 tier-promotion fires below the growth floor (independent of the floor)", () => {
    // T2/T3 tier-promotion nudges have an independent cadence and never consult
    // the growth floor — they must fire even while T1 is floor-suppressed.
    const state = createSessionState()
    state.sessionId = "test-t2-floor"
    state.modelContextLimit = 1_000_000
    state.nudges.lastPerMessageNudgeTokens = 100_000

    const config = buildConfig()
    config.compress.maxContextLimit = 990_000
    config.compress.minNudgeContextPercent = 80 // floor at 80% of 1M = 800K (above the 200K context)
    config.compress.nudgeGrowthTokens = 10_000
    config.compress.minNudgeGrowthFloor = 5_000
    config.compress.minNudgeGrowthRatio = 0.01

    // Seed T1 blocks so tier1Tokens (25K) >= nudgeGrowthTokens (10K)
    for (let i = 0; i < 5; i++) {
        const blockId = i + 1
        state.prune.messages.blocksById.set(blockId, {
            blockId,
            runId: i + 1,
            active: true,
            tier: 1,
            generation: "young",
            survivedCount: 1,
            directMessageIds: [],
            effectiveMessageIds: [],
            consumedBlockIds: [],
            parentBlockIds: [],
            summary: "T1 summary ".repeat(200),
            summaryTokens: 5_000,
            topic: `T1 block ${i}`,
            createdAt: Date.now(),
        })
        state.prune.messages.activeBlockIds.add(blockId)
    }

    state.messageIds.byRawId.set("u1", "m00001")
    state.messageIds.byRawId.set("a1", "m00002")

    // currentTokens = 200K (180K+20K). T1: growth = 100K >= 10K threshold, but
    // 200K < 800K floor → the floor suppresses T1. T2: tier1Tokens 25K >= 10K,
    // cadence met, 5 candidates >= 2 → T2 fires below the growth floor.
    const messages: WithParts[] = [
        userMsg("u1", "hello"),
        assistantMsgWithTokens("a1", "done", { input: 180_000, output: 20_000 }, [
            toolPart("c1", "x".repeat(80_000)),
        ]),
    ]
    injectCompressNudges(state, config, logger, messages, {} as any)
    assert.equal(state.nudges.shouldInjectThisTurn, true, "T2 fires below the growth floor (independent cadence)")
    assert.equal(state.nudges.lastTier2NudgeTokens, 200_000, "T2 fired (lastTier2NudgeTokens set) while T1 stayed floor-suppressed")
})

test("issue #342 follow-up: unset minNudgeContextPercent falls back to the low 5% default floor", () => {
    const state = createSessionState()
    state.modelContextLimit = 1_000_000
    state.nudges.lastPerMessageNudgeTokens = 50_000
    state.messageIds.byRawId.set("u1", "m00001")
    state.messageIds.byRawId.set("a1", "m00002")

    const config = buildConfig()
    config.compress.maxContextLimit = 800_000
    // Simulate a config that never set the field: the code must fall back to
    // the (deliberately low) 5% default, NOT the pre-fix 15%.
    delete (config.compress as { minNudgeContextPercent?: number }).minNudgeContextPercent

    // currentTokens = 100K (80K+20K). Growth = 100K-50K = 50K >= 50K threshold
    // AND >= 22.5K growthFloor. Fallback floor = 5% of 1M = 50K → 100K >= 50K
    // → the nudge FIRES. (A 15% fallback would put the floor at 150K and
    // SUPPRESS this — the default must stay low so typical working cycles on
    // large-window models are not shifted; 15% binds on ≥400K windows.)
    const messages: WithParts[] = [
        userMsg("u1", "hello"),
        assistantMsgWithTokens("a1", "done", { input: 80_000, output: 20_000 }, [
            toolPart("c1", "x".repeat(80_000)),
        ]),
    ]
    injectCompressNudges(state, config, logger, messages, {} as any)
    assert.equal(state.nudges.shouldInjectThisTurn, true, "100K >= 50K (5% default floor) with 50K growth → nudge fires")
    assert.equal(state.nudges.lastNudgeShownTokens, 100_000, "nudge shown at current tokens")
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 50_000, "baseline only advances on compress, not on nudge")
})


// ── Issue #344: per-provider / per-model growth-nudge floor (nested providers.models) ──
// compress.providers.{provider}.{field} and .models.{model}.{field} cascade
// field-by-field: model > provider > global (billion-context-pi style).
// These tests lock the resolution order, the 0-disables escape hatch, the
// fallback for unknown provider/model ids, and the multi-turn gate behavior.

function userMsgWithModel(id: string, text: string, providerId: string, modelId: string): WithParts {
    return {
        info: {
            id,
            role: "user",
            sessionID: SID,
            agent: "a",
            time: { created: 1 },
            model: { providerID: providerId, modelID: modelId },
        } as WithParts["info"],
        parts: [textPart(id, text)],
    }
}

test("issue #344 resolver: minNudgeContextPercent cascades model > provider > global", () => {
    const config = buildConfig()
    config.compress.minNudgeContextPercent = 5
    config.compress.providers = {
        anthropic: {
            minNudgeContextPercent: 8,
            models: {
                "claude-sonnet-4-6": { minNudgeContextPercent: 10 },
            },
        },
        openai: {
            models: { "gpt-5": { minNudgeContextPercent: 20 } },
        },
    }
    // Model level wins over provider and global.
    assert.equal(resolveMinNudgeContextPercent(config, "anthropic", "claude-sonnet-4-6"), 10)
    // Provider level applies to its other models (no model entry).
    assert.equal(resolveMinNudgeContextPercent(config, "anthropic", "claude-haiku-4-5"), 8)
    // Model entry without provider-level field still resolves (model > global).
    assert.equal(resolveMinNudgeContextPercent(config, "openai", "gpt-5"), 20)
    // Unknown model in a provider without provider-level field falls back to global.
    assert.equal(resolveMinNudgeContextPercent(config, "openai", "gpt-4o"), 5)
    // Unknown provider falls back to global.
    assert.equal(resolveMinNudgeContextPercent(config, "zhipu", "glm-5"), 5)
    // No model info at all falls back to global.
    assert.equal(resolveMinNudgeContextPercent(config), 5)
})

test("issue #344 resolver: 0 at a deeper level is an explicit disable, not unset", () => {
    const config = buildConfig()
    config.compress.minNudgeContextPercent = 15
    config.compress.providers = {
        anthropic: { models: { "claude-sonnet-4-6": { minNudgeContextPercent: 0 } } },
    }
    assert.equal(resolveMinNudgeContextPercent(config, "anthropic", "claude-sonnet-4-6"), 0)
    // Floor tokens clamp to 0 → every currentTokens >= 0 → gate always open.
    assert.equal(resolveMinNudgeFloorTokens(config, 1_000_000, "anthropic", "claude-sonnet-4-6"), 0)
    // Sibling model without the override keeps the global 15%.
    assert.equal(resolveMinNudgeContextPercent(config, "anthropic", "claude-haiku-4-5"), 15)
})

test("issue #344 resolver: unset everywhere returns undefined; floor fn applies the 5% default", () => {
    const config = buildConfig()
    delete (config.compress as { minNudgeContextPercent?: number }).minNudgeContextPercent
    config.compress.providers = { anthropic: { models: { "claude-sonnet-4-6": {} } } }
    assert.equal(resolveMinNudgeContextPercent(config, "anthropic", "claude-sonnet-4-6"), undefined)
    // resolveMinNudgeFloorTokens applies the deliberately-low default (5%).
    assert.equal(resolveMinNudgeFloorTokens(config, 1_000_000, "anthropic", "claude-sonnet-4-6"), 50_000)
})

test("issue #344 resolver: percent clamps to 0-100 and rounds against the window", () => {
    const config = buildConfig()
    config.compress.providers = {
        anthropic: { models: { "claude-sonnet-4-6": { minNudgeContextPercent: 150 } } },
    }
    assert.equal(resolveMinNudgeFloorTokens(config, 1_000_000, "anthropic", "claude-sonnet-4-6"), 1_000_000)
    // Unknown window → floor unresolvable → undefined (gate stays open).
    assert.equal(resolveMinNudgeFloorTokens(config, undefined, "anthropic", "claude-sonnet-4-6"), undefined)
})

test("issue #344: model-level floor suppresses the growth nudge, then fires once crossed (multi-turn)", () => {
    const state = createSessionState()
    state.modelContextLimit = 1_000_000
    state.nudges.lastPerMessageNudgeTokens = 100_000
    state.messageIds.byRawId.set("u1", "m00001")
    state.messageIds.byRawId.set("a1", "m00002")
    state.messageIds.byRawId.set("u2", "m00003")
    state.messageIds.byRawId.set("a2", "m00004")

    const config = buildConfig()
    config.compress.maxContextLimit = 800_000
    config.compress.minNudgeContextPercent = 5 // global floor would be 50K
    config.compress.providers = {
        anthropic: {
            models: {
                // Model-level override raises the floor for THIS model only:
                // 30% of 1M = 300K.
                "claude-sonnet-4-6": { minNudgeContextPercent: 30 },
            },
        },
    }

    // Turn 1: currentTokens = 200K (180K+20K). Growth = 100K >= 50K threshold
    // and >= 22.5K growthFloor, but 200K < 300K model-level floor → suppressed.
    const turn1: WithParts[] = [
        userMsgWithModel("u1", "hello", "anthropic", "claude-sonnet-4-6"),
        assistantMsgWithTokens("a1", "done", { input: 180_000, output: 20_000 }, [
            toolPart("c1", "x".repeat(80_000)),
        ]),
    ]
    injectCompressNudges(state, config, logger, turn1, {} as any)
    assert.equal(state.nudges.shouldInjectThisTurn, false, "200K < 300K model-level floor → suppressed despite 100K growth")
    assert.equal(state.nudges.lastNudgeShownTokens, undefined, "no nudge shown below the model-level floor")
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 100_000, "baseline preserved below floor")

    // Turn 2: currentTokens = 320K. Growth = 220K >= 50K. 320K >= 300K → fires.
    const turn2: WithParts[] = [
        userMsgWithModel("u1", "hello", "anthropic", "claude-sonnet-4-6"),
        assistantMsgWithTokens("a1", "done", { input: 180_000, output: 20_000 }, [
            toolPart("c1", "x".repeat(80_000)),
        ]),
        userMsgWithModel("u2", "next", "anthropic", "claude-sonnet-4-6"),
        assistantMsgWithTokens("a2", "more", { input: 300_000, output: 20_000 }, [
            toolPart("c2", "x".repeat(80_000)),
        ]),
    ]
    injectCompressNudges(state, config, logger, turn2, {} as any)
    assert.equal(state.nudges.shouldInjectThisTurn, true, "320K >= 300K model-level floor + 220K growth → fires")
    assert.equal(state.nudges.lastNudgeShownTokens, 320_000, "lastNudgeShownTokens set to currentTokens")
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 100_000, "baseline NOT advanced by the nudge")
})

test("issue #344: provider-level floor applies to every model of that provider", () => {
    const state = createSessionState()
    state.modelContextLimit = 1_000_000
    state.nudges.lastPerMessageNudgeTokens = 100_000
    state.messageIds.byRawId.set("u1", "m00001")
    state.messageIds.byRawId.set("a1", "m00002")

    const config = buildConfig()
    config.compress.maxContextLimit = 800_000
    config.compress.minNudgeContextPercent = 5
    config.compress.providers = {
        anthropic: { minNudgeContextPercent: 25 }, // no models entry
    }

    // Active model has no model-level entry → provider floor 25% of 1M = 250K.
    // currentTokens = 200K with 100K growth → below 250K → suppressed.
    const messages: WithParts[] = [
        userMsgWithModel("u1", "hello", "anthropic", "claude-haiku-4-5"),
        assistantMsgWithTokens("a1", "done", { input: 180_000, output: 20_000 }, [
            toolPart("c1", "x".repeat(80_000)),
        ]),
    ]
    injectCompressNudges(state, config, logger, messages, {} as any)
    assert.equal(state.nudges.shouldInjectThisTurn, false, "200K < 250K provider-level floor → suppressed")
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 100_000, "baseline preserved")
})

test("issue #344: unknown provider falls back to the global floor", () => {
    const state = createSessionState()
    state.modelContextLimit = 1_000_000
    state.nudges.lastPerMessageNudgeTokens = 100_000
    state.messageIds.byRawId.set("u1", "m00001")
    state.messageIds.byRawId.set("a1", "m00002")

    const config = buildConfig()
    config.compress.maxContextLimit = 800_000
    config.compress.minNudgeContextPercent = 5 // global floor 50K
    config.compress.providers = {
        anthropic: { minNudgeContextPercent: 25 }, // not the active provider
    }

    // Active provider zhipu is unknown → global 5% floor (50K). 200K >= 50K
    // with 100K growth → the nudge FIRES (no per-provider suppression).
    const messages: WithParts[] = [
        userMsgWithModel("u1", "hello", "zhipu", "glm-5"),
        assistantMsgWithTokens("a1", "done", { input: 180_000, output: 20_000 }, [
            toolPart("c1", "x".repeat(80_000)),
        ]),
    ]
    injectCompressNudges(state, config, logger, messages, {} as any)
    assert.equal(state.nudges.shouldInjectThisTurn, true, "unknown provider → global 5% floor → fires")
    assert.equal(state.nudges.lastNudgeShownTokens, 200_000, "nudge shown at current tokens")
})

test("issue #344: model-level 0 disables the floor for that model while siblings keep the global", () => {
    const state = createSessionState()
    state.modelContextLimit = 1_000_000
    state.nudges.lastPerMessageNudgeTokens = 100_000
    state.messageIds.byRawId.set("u1", "m00001")
    state.messageIds.byRawId.set("a1", "m00002")

    const config = buildConfig()
    config.compress.maxContextLimit = 800_000
    config.compress.minNudgeContextPercent = 15 // global floor = 150K
    config.compress.providers = {
        anthropic: { models: { "claude-sonnet-4-6": { minNudgeContextPercent: 0 } } },
    }

    // currentTokens = 115K (95K+20K), growth = 115K-60K = 55K >= 50K threshold,
    // but 115K < 150K global floor — the model-level 0 kills the floor for
    // THIS model → the nudge fires where the global config would suppress it.
    state.nudges.lastPerMessageNudgeTokens = 60_000
    const messages: WithParts[] = [
        userMsgWithModel("u1", "hello", "anthropic", "claude-sonnet-4-6"),
        assistantMsgWithTokens("a1", "done", { input: 95_000, output: 20_000 }, [
            toolPart("c1", "x".repeat(80_000)),
        ]),
    ]
    injectCompressNudges(state, config, logger, messages, {} as any)
    assert.equal(state.nudges.shouldInjectThisTurn, true, "model-level 0 disables the floor → 55K growth fires at 115K")
    assert.equal(state.nudges.lastNudgeShownTokens, 115_000, "nudge shown at current tokens")
})

test("issue #344: per-model floor holds in production config across the full growth cycle (preserveRecentMessages > 0)", () => {
    // §5.7.1: production config (preserveRecentMessages > 0) + full growth cycle
    // (baseline → growth → nudge → compress → new baseline → growth → nudge) +
    // the nothingToCompress baseline-reset regression lock (PR #207) under a
    // model-level floor. preserveRecentMessages: 2 keeps a compressible head in
    // the 4+ message turns while making the 2-message turn fully protected.
    const state = createSessionState()
    state.modelContextLimit = 1_000_000
    state.nudges.lastPerMessageNudgeTokens = 100_000
    state.messageIds.byRawId.set("u1", "m00001")
    state.messageIds.byRawId.set("a1", "m00002")
    state.messageIds.byRawId.set("u2", "m00003")
    state.messageIds.byRawId.set("a2", "m00004")
    state.messageIds.byRawId.set("u3", "m00005")
    state.messageIds.byRawId.set("a3", "m00006")
    state.messageIds.byRawId.set("u4", "m00007")
    state.messageIds.byRawId.set("a4", "m00008")

    const config = buildConfig()
    config.compress.preserveRecentMessages = 2 // production-like: last 2 messages protected
    config.compress.maxContextLimit = 800_000
    config.compress.minNudgeContextPercent = 5 // global floor would be 50K
    config.compress.providers = {
        anthropic: {
            models: {
                // Model-level override raises the floor for THIS model only:
                // 30% of 1M = 300K.
                "claude-sonnet-4-6": { minNudgeContextPercent: 30 },
            },
        },
    }

    // Turn 1: currentTokens = 200K (180K+20K). Growth = 100K >= 50K threshold,
    // but 200K < 300K model-level floor → suppressed. a1's tool output is
    // compressible (only u2/a2 are in the preserve-recent zone) → this is floor
    // suppression, not nothingToCompress.
    const turn1: WithParts[] = [
        userMsgWithModel("u1", "hello", "anthropic", "claude-sonnet-4-6"),
        assistantMsgWithTokens("a1", "done", { input: 180_000, output: 20_000 }, [
            toolPart("c1", "x".repeat(80_000)),
        ]),
        userMsgWithModel("u2", "next", "anthropic", "claude-sonnet-4-6"),
        assistantMsgWithTokens("a2", "more", { input: 180_000, output: 20_000 }),
    ]
    injectCompressNudges(state, config, logger, turn1, {} as any)
    assert.equal(state.nudges.shouldInjectThisTurn, false, "turn 1: 200K < 300K model-level floor → suppressed in production config")
    assert.equal(state.nudges.lastNudgeShownTokens, undefined, "turn 1: no nudge shown below floor")
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 100_000, "turn 1: baseline preserved below floor")

    // Turn 2: currentTokens = 320K (300K+20K). Growth = 220K >= 50K. 320K >= 300K
    // floor → open → nudge fires (a1's tool output still compressible).
    const turn2: WithParts[] = [
        userMsgWithModel("u1", "hello", "anthropic", "claude-sonnet-4-6"),
        assistantMsgWithTokens("a1", "done", { input: 180_000, output: 20_000 }, [
            toolPart("c1", "x".repeat(80_000)),
        ]),
        userMsgWithModel("u2", "next", "anthropic", "claude-sonnet-4-6"),
        assistantMsgWithTokens("a2", "more", { input: 180_000, output: 20_000 }),
        userMsgWithModel("u3", "again", "anthropic", "claude-sonnet-4-6"),
        assistantMsgWithTokens("a3", "result", { input: 300_000, output: 20_000 }, [
            toolPart("c3", "x".repeat(80_000)),
        ]),
    ]
    injectCompressNudges(state, config, logger, turn2, {} as any)
    assert.equal(state.nudges.shouldInjectThisTurn, true, "turn 2: 320K >= 300K model-level floor + 220K growth → fires")
    assert.equal(state.nudges.lastNudgeShownTokens, 320_000, "turn 2: nudge shown at current tokens")
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 100_000, "turn 2: baseline NOT advanced by the nudge")

    // Turn 3: model compresses → baseline reset to post-compress 200K, no nudge.
    const turn3: WithParts[] = [
        userMsgWithModel("u1", "hello", "anthropic", "claude-sonnet-4-6"),
        assistantMsgWithTokens("a1", "done", { input: 180_000, output: 20_000 }, [
            toolPart("c1", "x".repeat(80_000)),
        ]),
        userMsgWithModel("u2", "next", "anthropic", "claude-sonnet-4-6"),
        assistantMsgWithTokens("a2", "compressed", { input: 180_000, output: 20_000 }, [
            compressToolPart("c2", "compressed"),
        ]),
    ]
    injectCompressNudges(state, config, logger, turn3, {} as any)
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 200_000, "turn 3: compress resets baseline to post-compress 200K")
    assert.equal(state.nudges.shouldInjectThisTurn, false, "turn 3: compress turn, no nudge")

    // Turn 4: currentTokens = 400K (380K+20K). Growth = 400K-200K = 200K >= 50K.
    // 400K >= 300K floor → the nudge fires again from the NEW baseline.
    const turn4: WithParts[] = [
        userMsgWithModel("u1", "hello", "anthropic", "claude-sonnet-4-6"),
        assistantMsgWithTokens("a1", "done", { input: 180_000, output: 20_000 }, [
            toolPart("c1", "x".repeat(80_000)),
        ]),
        userMsgWithModel("u2", "next", "anthropic", "claude-sonnet-4-6"),
        assistantMsgWithTokens("a2", "compressed", { input: 180_000, output: 20_000 }, [
            compressToolPart("c2", "compressed"),
        ]),
        userMsgWithModel("u3", "again", "anthropic", "claude-sonnet-4-6"),
        assistantMsgWithTokens("a3", "result", { input: 380_000, output: 20_000 }, [
            toolPart("c3", "x".repeat(80_000)),
        ]),
    ]
    injectCompressNudges(state, config, logger, turn4, {} as any)
    assert.equal(state.nudges.shouldInjectThisTurn, true, "turn 4: 400K >= 300K floor + 200K growth from new baseline → fires again")
    assert.equal(state.nudges.lastNudgeShownTokens, 400_000, "turn 4: nudge shown at current tokens")
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 200_000, "turn 4: baseline NOT advanced by the nudge")

    // Turn 5 (PR #207 regression lock): only 2 messages → both in the
    // preserve-recent zone → nothingToCompress. currentTokens = 320K is ABOVE
    // the 300K floor with 120K growth, so the only reason this turn is silent
    // is nothingToCompress — and that path must NOT reset the baseline (the
    // #207 bug silently reset lastPerMessageNudgeTokens here, starving later
    // nudges in short/subagent sessions).
    const turn5: WithParts[] = [
        userMsgWithModel("u4", "short", "anthropic", "claude-sonnet-4-6"),
        assistantMsgWithTokens("a4", "done", { input: 300_000, output: 20_000 }, [
            toolPart("c4", "x".repeat(80_000)),
        ]),
    ]
    injectCompressNudges(state, config, logger, turn5, {} as any)
    assert.equal(state.nudges.shouldInjectThisTurn, false, "turn 5: nothingToCompress (all messages protected) → silent")
    assert.equal(state.nudges.lastNudgeShownTokens, 400_000, "turn 5: lastNudgeShownTokens KEPT (resetting it reintroduces the nudge loop)")
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 200_000, "turn 5: baseline NOT reset by nothingToCompress (#207 regression lock)")
})
