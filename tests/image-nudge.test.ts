import "./test-env"
import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"
import { injectCompressNudges } from "../lib/messages/inject/inject"
import { createSessionState, type WithParts } from "../lib/state"
import { sha8 } from "../lib/compress/image-archive"
import { renderSystemPrompt } from "../lib/prompts"
import { IMAGE_GUARD_SYSTEM_EXTENSION } from "../lib/prompts/extensions/system"

const SID = "ses-image-nudge"

// AGENTS.md §5.7: at least one scenario uses production-like
// preserveRecentMessages > 0 — this whole file does (20).
function buildConfig(overrides?: { largeBytes?: number; nudge?: boolean }): PluginConfig {
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
            permission: "allow",
            showCompression: false,
            summaryBuffer: true,
            maxContextLimit: 800_000,
            minContextLimit: 200_000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: [],
            protectTags: false,
            protectUserMessages: false,
            minNudgeContextPercent: 15,
            maxSummaryLengthHard: 10000,
            minCompressRange: 5000,
            minNudgeGrowthRatio: 0.45,
            minNudgeGrowthFloor: 5000,
            emergencyThresholdPercent: "98%",
            maxVisibleSegments: 50,
            keepEmbedMaxChars: 2000,
            preserveRecentMessages: 20,
            preserveRecentTokens: 20_000,
            images: {
                enabled: true,
                minBytes: 16384,
                ttlDays: 7,
                // Small threshold so a few-hundred-byte fixture image qualifies.
                largeBytes: overrides?.largeBytes ?? 100,
                nudge: overrides?.nudge ?? true,
            },
        },
        gc: {
            algorithm: "truncate",
            promotionThreshold: 5,
            maxBlockAge: 15,
            maxOldGenSummaryLength: 3000,
            majorGcThresholdPercent: "100%",
            batchCleanup: { lowThreshold: "55%", highThreshold: "75%", forceThreshold: "90%" },
        },
    }
}

const logger = new Logger(false)

function textPart(msgId: string, text: string) {
    return { id: `${msgId}-p`, messageID: msgId, sessionID: SID, type: "text" as const, text }
}

function imagePart(msgId: string, id: string, fillByte: number): unknown {
    return {
        id,
        messageID: msgId,
        sessionID: SID,
        type: "file",
        url: `data:image/png;base64,${Buffer.alloc(200, fillByte).toString("base64")}`,
    }
}

function userMsg(id: string, parts: unknown[]): WithParts {
    return {
        info: { id, role: "user", sessionID: SID, agent: "a", time: { created: 1 } } as WithParts["info"],
        parts: parts as WithParts["parts"],
    }
}

function assistantMsg(id: string, text: string, tokens: { input: number; output: number }): WithParts {
    return {
        info: {
            id, role: "assistant", sessionID: SID, agent: "a", time: { created: 2 }, tokens,
        } as WithParts["info"],
        parts: [textPart(id, text)],
    }
}

function assistantCompressMsg(id: string, tokens: { input: number; output: number }): WithParts {
    return {
        info: {
            id, role: "assistant", sessionID: SID, agent: "a", time: { created: 2 }, tokens,
        } as WithParts["info"],
        parts: [
            {
                id: `${id}-part`, messageID: id, sessionID: SID,
                type: "tool" as const, tool: "compress", callID: `${id}-c`,
                state: { status: "completed" as const, input: {}, output: "compressed" },
            },
            textPart(id, "done"),
        ],
    }
}

const NOTICE_MARKER = "Large image(s) just entered context:"

function registerRefs(state: ReturnType<typeof createSessionState>, messages: WithParts[]): void {
    messages.forEach((m, i) => {
        if (!state.messageIds.byRawId.has(m.info.id)) {
            state.messageIds.byRawId.set(m.info.id, `m${String(i + 1).padStart(5, "0")}`)
        }
    })
}

function hasNotice(messages: WithParts[]): boolean {
    return messages.some((m) =>
        (m.parts || []).some(
            (p) => p.type === "text" && typeof (p as any).text === "string" && (p as any).text.includes(NOTICE_MARKER),
        ),
    )
}

test("multi-turn: one-shot large-image notice with dedup, compress-turn suppression and re-fire", () => {
    const state = createSessionState()
    state.modelContextLimit = 1_000_000
    const config = buildConfig()

    const u1 = userMsg("u1", [textPart("u1", "hello")])
    const u2img = userMsg("u2img", [imagePart("u2img", "u2img-p", 0x11)])
    const aReply = assistantMsg("ar1", "looking at it", { input: 50_000, output: 500 })
    const u3img = userMsg("u3img", [imagePart("u3img", "u3img-p", 0x22)])
    const u4img = userMsg("u4img", [imagePart("u4img", "u4img-p", 0x33)])
    const aCompress = assistantCompressMsg("ac1", { input: 60_000, output: 800 })

    // Turn 1 — no images yet: no notice, no dedup entries.
    let turn: WithParts[] = [u1]
    registerRefs(state, turn)
    injectCompressNudges(state, config, logger, turn, {} as any)
    assert.equal(hasNotice(turn), false, "t1: no notice without images")
    assert.equal(Object.keys(state.imageSurgeNudged).length, 0, "t1: dedup map empty")
    assert.equal(state.nudges.shouldInjectThisTurn, false, "t1: nothing injected")

    // Turn 2 — first large image appears: notice emitted, dedup key recorded.
    turn = [u1, u2img]
    registerRefs(state, turn)
    injectCompressNudges(state, config, logger, turn, {} as any)
    assert.ok(hasNotice(turn), "t2: notice present")
    assert.equal(Object.keys(state.imageSurgeNudged).length, 1, "t2: one dedup key")
    assert.equal(state.nudges.shouldInjectThisTurn, true, "t2: directive flagged")
    const t2Keys = Object.keys(state.imageSurgeNudged)
    assert.ok(t2Keys[0]!.startsWith(`${sha8("u2img")}:p0:`), "t2: key format sha8(rawId):p{idx}:sha8(payload)")

    // Turn 3 — same image, no compress: NO repeat, dedup map unchanged.
    turn = [u1, u2img, aReply]
    registerRefs(state, turn)
    injectCompressNudges(state, config, logger, turn, {} as any)
    assert.equal(hasNotice(turn), false, "t3: no repeat for the same image")
    assert.deepEqual(Object.keys(state.imageSurgeNudged), t2Keys, "t3: dedup map unchanged")
    assert.equal(state.nudges.shouldInjectThisTurn, false, "t3: nothing injected")

    // Turn 4 — a different new image: fires again under its own key.
    turn = [u1, u2img, aReply, u3img]
    registerRefs(state, turn)
    injectCompressNudges(state, config, logger, turn, {} as any)
    assert.ok(hasNotice(turn), "t4: second distinct image noticed")
    assert.equal(Object.keys(state.imageSurgeNudged).length, 2, "t4: two dedup keys")
    assert.ok(Object.keys(state.imageSurgeNudged).some((k) => k.startsWith(`${sha8("u3img")}:p0:`)))
    assert.equal(state.nudges.shouldInjectThisTurn, true, "t4: directive flagged")

    // Turn 5 — the model finally compresses (compress turn): detection is
    // skipped entirely, so the still-unnoticed u4 image records NO key here.
    turn = [u1, u2img, aReply, u3img, u4img, aCompress]
    registerRefs(state, turn)
    injectCompressNudges(state, config, logger, turn, {} as any)
    assert.equal(hasNotice(turn), false, "t5: suppress on compress turn")
    assert.equal(Object.keys(state.imageSurgeNudged).length, 2, "t5: u4 slot not recorded")

    // Turn 6 — next plain turn, u4 image still visible: re-fires.
    turn = [u1, u2img, aReply, u3img, u4img, aCompress, assistantMsg("ar2", "ok", { input: 70_000, output: 300 })]
    registerRefs(state, turn)
    injectCompressNudges(state, config, logger, turn, {} as any)
    assert.ok(hasNotice(turn), "t6: ignored notice re-fires on next plain turn")
    assert.equal(Object.keys(state.imageSurgeNudged).length, 3, "t6: three dedup keys")
    assert.ok(Object.keys(state.imageSurgeNudged).some((k) => k.startsWith(`${sha8("u4img")}:p0:`)))
    assert.equal(state.nudges.shouldInjectThisTurn, true, "t6: directive flagged")
})

test("multi-turn: same slot with changed content gets a fresh key", () => {
    const state = createSessionState()
    state.modelContextLimit = 1_000_000
    const config = buildConfig()

    const v1 = userMsg("uX", [imagePart("uX", "uX-p", 0xaa)])
    let turn: WithParts[] = [v1]
    registerRefs(state, turn)
    injectCompressNudges(state, config, logger, turn, {} as any)
    assert.ok(hasNotice(turn), "first version noticed")
    assert.equal(Object.keys(state.imageSurgeNudged).length, 1)

    // Same message + part index, different payload (e.g. re-read of an updated
    // screenshot): the slot pre-filter would normally skip it — but content
    // changed, so detection must NOT rely on the slot alone... The slot prefilter
    // intentionally treats a re-read of the SAME slot as already-noticed to keep
    // steady-state turns cheap; pin that documented trade-off.
    const v2 = userMsg("uX", [imagePart("uX", "uX-p", 0xbb)])
    turn = [v2]
    registerRefs(state, turn)
    injectCompressNudges(state, config, logger, turn, {} as any)
    assert.equal(hasNotice(turn), false, "same slot re-read is not re-noticed (documented prefilter)")
    assert.equal(Object.keys(state.imageSurgeNudged).length, 1, "dedup map unchanged")
})

test("config gates: nudge:false and largeBytes:0 disable the notice", () => {
    for (const overrides of [{ nudge: false }, { largeBytes: 0 }] as const) {
        const state = createSessionState()
        state.modelContextLimit = 1_000_000
        const config = buildConfig({ ...overrides })
        const turn: WithParts[] = [userMsg("u1", [imagePart("u1", "u1-p", 0x44)])]
        registerRefs(state, turn)
        injectCompressNudges(state, config, logger, turn, {} as any)
        assert.equal(hasNotice(turn), false, `no notice when ${JSON.stringify(overrides)}`)
        assert.equal(Object.keys(state.imageSurgeNudged).length, 0, `no dedup keys when ${JSON.stringify(overrides)}`)
        assert.equal(state.nudges.shouldInjectThisTurn, false, `nothing injected when ${JSON.stringify(overrides)}`)
    }
})

test("standing rule: system prompt extension present only when requested", () => {
    const prompts = { system: "BASE PROMPT", decompressExtension: "DECOMPRESS RULES" } as any
    const plain = renderSystemPrompt(prompts)
    assert.ok(!plain.includes("IMAGE HANDLING"), "absent by default arg omission")
    const guarded = renderSystemPrompt(prompts, undefined, false, IMAGE_GUARD_SYSTEM_EXTENSION)
    assert.ok(guarded.includes("IMAGE HANDLING"), "present when extension passed")
    assert.ok(guarded.startsWith("BASE PROMPT"))
})
