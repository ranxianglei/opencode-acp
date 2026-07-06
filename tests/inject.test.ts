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
import { createSessionState, type WithParts } from "../lib/state"
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

test("injectCompressNudges: after compress, lastPerMessageNudgeTokens = currentTokens (not 0)", () => {
    const state = createSessionState()
    state.modelContextLimit = 1_000_000
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
        "lastPerMessageNudgeTokens must equal currentTokens (250K) after compress — NOT 0",
    )
})

test("injectCompressNudges: post-compress small growth does NOT re-nudge", () => {
    const state = createSessionState()
    state.modelContextLimit = 1_000_000
    const config = buildConfig()
    config.compress.maxContextLimit = 800_000
    config.compress.minContextLimit = 550_000

    const turn1: WithParts[] = [
        userMsg("u1", "hello"),
        assistantMsgWithTokens("a1", "done", { input: 200_000, output: 50_000 }, [
            compressToolPart("c1", "compressed"),
        ]),
    ]
    injectCompressNudges(state, config, logger, turn1, {} as any)
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 250_000)

    const turn2: WithParts[] = [
        userMsg("u2", "next"),
        assistantMsgWithTokens("a2", "response", { input: 247_000, output: 6_000 }),
    ]
    injectCompressNudges(state, config, logger, turn2, {} as any)

    assert.equal(
        state.nudges.shouldInjectThisTurn,
        false,
        "only 3K growth after compress (< 50K adaptive threshold) — should NOT nudge",
    )
})

test("injectCompressNudges: post-compress large growth DOES nudge", () => {
    const state = createSessionState()
    state.modelContextLimit = 1_000_000
    const config = buildConfig()
    config.compress.maxContextLimit = 800_000
    config.compress.minContextLimit = 550_000

    const turn1: WithParts[] = [
        userMsg("u1", "hello"),
        assistantMsgWithTokens("a1", "done", { input: 200_000, output: 50_000 }, [
            compressToolPart("c1", "compressed"),
        ]),
    ]
    injectCompressNudges(state, config, logger, turn1, {} as any)

    const turn2: WithParts[] = [
        userMsg("u2", "next"),
        assistantMsgWithTokens("a2", "response", { input: 250_000, output: 55_000 }),
    ]
    injectCompressNudges(state, config, logger, turn2, {} as any)

    assert.equal(
        state.nudges.shouldInjectThisTurn,
        true,
        "55K growth after compress (> 50K adaptive threshold) — should nudge",
    )
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 305_000)
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
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 255_000, "in-memory baseline updated to currentTokens")

    // saveSessionState is fire-and-forget inside injectCompressNudges (.catch(()=>{})); flush before reload.
    await new Promise((resolve) => setTimeout(resolve, 50))

    const reloaded = await loadSessionState(PERSIST_SESSION, logger)
    assert.ok(reloaded, "state must be persisted when a nudge fires")
    assert.equal(
        reloaded!.nudges.lastPerMessageNudgeTokens,
        255_000,
        "[#60] new baseline must reach disk — otherwise restart reloads the stale 200K and the nudge refires every turn",
    )
    await cleanupPersistSession()
})
