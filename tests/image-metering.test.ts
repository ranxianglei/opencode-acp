import "./test-env"
import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { createSessionState, type WithParts } from "../lib/state"
import {
    countAllMessageTokens,
    countMessageCharacters,
    countPendingImageTokens,
    estimateAllMessageTokensFast,
    getCurrentTokenUsage,
} from "../lib/token-utils"
import { computeProtectedRefs, estimateContextComposition } from "../lib/messages/inject/utils"
import { estimateImagePartTokens } from "../lib/compress/image-tokens"

const SID = "ses-image-metering"

// Unknown-dimension 1024-byte payload → base64/4 proxy = round(1368/4) = 342.
const SMALL_IMG_B64 = Buffer.alloc(1024, 0x42).toString("base64")
const SMALL_IMG_ESTIMATE = 342

const smallImagePart = {
    type: "file" as const,
    url: `data:image/png;base64,${SMALL_IMG_B64}`,
}

function buildConfig(): PluginConfig {
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

function textPart(msgId: string, text: string) {
    return { id: `${msgId}-p`, messageID: msgId, sessionID: SID, type: "text" as const, text }
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

// ─── Per-message counters ────────────────────────────────────────────────────

test("sanity: the shared estimator agrees with the pinned small-image value", () => {
    assert.equal(estimateImagePartTokens(smallImagePart), SMALL_IMG_ESTIMATE)
})

test("countAllMessageTokens adds the image estimate on top of BPE text tokens", () => {
    const textOnly = userMsg("u1", [textPart("u1", "hello world")])
    const withImage = userMsg("u2", [textPart("u2", "hello world"), smallImagePart])
    const diff = countAllMessageTokens(withImage) - countAllMessageTokens(textOnly)
    assert.equal(diff, SMALL_IMG_ESTIMATE)
})

test("countAllMessageTokens counts an image-only message without any text", () => {
    const imageOnly = userMsg("u3", [smallImagePart])
    assert.equal(countAllMessageTokens(imageOnly), SMALL_IMG_ESTIMATE)
})

test("countMessageCharacters counts image-equivalent chars (estimate x 4)", () => {
    // 4 text chars + 342 estimate * 4 = 1372 equivalent chars
    const msg = userMsg("u4", [textPart("u4", "abcd"), smallImagePart])
    assert.equal(countMessageCharacters(msg), 4 + SMALL_IMG_ESTIMATE * 4)
    assert.equal(estimateAllMessageTokensFast(msg), Math.round((4 + SMALL_IMG_ESTIMATE * 4) / 4))
})

// ─── getCurrentTokenUsage pending-image delta ────────────────────────────────

test("getCurrentTokenUsage adds pending image delta after the last assistant usage", () => {
    const state = createSessionState()
    const messages: WithParts[] = [
        assistantMsg("a1", "working", { input: 1000, output: 100 }),
        userMsg("u1", [smallImagePart]),
    ]
    // 1000 input + 100 output + 342 pending image
    assert.equal(getCurrentTokenUsage(state, messages), 1442)
})

test("getCurrentTokenUsage ignores images that arrived before the assistant usage", () => {
    const state = createSessionState()
    const messages: WithParts[] = [
        userMsg("u0", [smallImagePart]),
        assistantMsg("a1", "working", { input: 1000, output: 100 }),
    ]
    assert.equal(getCurrentTokenUsage(state, messages), 1100)
})

test("getCurrentTokenUsage compaction epoch still returns 0 despite pending images", () => {
    const state = createSessionState()
    state.lastCompaction = 10
    const messages: WithParts[] = [
        assistantMsg("a1", "stale", { input: 1000, output: 100 }),
        userMsg("u1", [smallImagePart]),
    ]
    assert.equal(getCurrentTokenUsage(state, messages), 0)
})

// ─── countPendingImageTokens ─────────────────────────────────────────────────

test("countPendingImageTokens sums image estimates from startIndex onward", () => {
    const a = { type: "file" as const, url: `data:image/png;base64,${Buffer.alloc(900, 7).toString("base64")}` }
    const b = { type: "file" as const, url: `data:image/png;base64,${Buffer.alloc(800, 9).toString("base64")}` }
    const estA = estimateImagePartTokens(a)
    const estB = estimateImagePartTokens(b)
    const messages: WithParts[] = [
        userMsg("u1", [a]),
        userMsg("u2", [textPart("u2", "between")]),
        userMsg("u3", [b]),
    ]
    assert.equal(countPendingImageTokens(messages, 0), estA + estB)
    assert.equal(countPendingImageTokens(messages, 1), estB)
    assert.equal(countPendingImageTokens(messages, 3), 0)
})

// ─── Context composition ─────────────────────────────────────────────────────

test("estimateContextComposition reports imageTokens and includes it in total", () => {
    const messages: WithParts[] = [
        userMsg("u1", [textPart("u1", "x".repeat(400))]),
        userMsg("u2", [smallImagePart]),
    ]
    const composition = estimateContextComposition(messages)
    assert.equal(composition.imageTokens, SMALL_IMG_ESTIMATE)
    const expectedTotal =
        composition.systemTokens +
        composition.toolTokens +
        composition.summaryTokens +
        composition.messageTokens +
        composition.reasoningTokens +
        composition.imageTokens
    assert.equal(composition.total, expectedTotal)
    assert.ok(composition.total >= SMALL_IMG_ESTIMATE)
})

// ─── Protected-recent budget ─────────────────────────────────────────────────

test("computeProtectedRefs no longer lets one image eat the whole preserveRecentTokens budget", () => {
    const config = buildConfig()
    const compress: PluginConfig["compress"] = {
        ...config.compress,
        preserveRecentMessages: 0,
        preserveRecentTokens: 10_000,
    }
    const state = createSessionState()
    // Under the legacy JSON.stringify counting the 300KB image alone was
    // ~100K+ "tokens" and stopped the walk immediately; with the vision
    // estimate (2672) the older message still fits the 10K budget.
    const bigImagePart = {
        type: "file" as const,
        url: `data:image/png;base64,${Buffer.alloc(300 * 1024, 0x42).toString("base64")}`,
    }
    const oldText = userMsg("old", [textPart("old", "y".repeat(1000))])
    const imageMsg = userMsg("img", [bigImagePart])
    const recentText = userMsg("new", [textPart("new", "z".repeat(1000))])
    const messages: WithParts[] = [oldText, imageMsg, recentText]
    for (let i = 0; i < messages.length; i++) {
        state.messageIds.byRawId.set(messages[i]!.info.id, `m${String(i + 1).padStart(5, "0")}`)
    }
    const protectedRefs = computeProtectedRefs(messages, state, compress)
    assert.equal(protectedRefs.size, 3)
    assert.ok(protectedRefs.has("m00001"))
    assert.ok(protectedRefs.has("m00002"))
    assert.ok(protectedRefs.has("m00003"))
})
