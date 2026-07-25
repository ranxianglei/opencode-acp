import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdirSync } from "node:fs"
import {
    evaluatePreCommitQuality,
    buildQualityRejectionError,
    buildPreemptiveAcknowledgeError,
} from "../lib/compress/quality-gate"
import { createCompressRangeTool } from "../lib/compress/range"
import { createSessionState, resetSessionState, type WithParts } from "../lib/state"
import type { PluginConfig } from "../lib/config"
import type { QualityGateResult } from "../lib/compress/quality-gate/types"
import { Logger } from "../lib/logger"
import { singletonRegistry } from "./registry-stub"

const testDataHome = join(tmpdir(), `opencode-acp-qg-tests-${process.pid}`)
const testConfigHome = join(tmpdir(), `opencode-acp-qg-config-tests-${process.pid}`)

process.env.XDG_DATA_HOME = testDataHome
process.env.XDG_CONFIG_HOME = testConfigHome

mkdirSync(testDataHome, { recursive: true })
mkdirSync(testConfigHome, { recursive: true })

function buildConfig(qualityGateEnabled: boolean): PluginConfig {
    return {
        enabled: true,
        autoUpdate: true,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: { enabled: true, protectedTools: [] },
        manualMode: { enabled: false, automaticStrategies: true },
        turnProtection: { enabled: false, turns: 4 },
        experimental: { allowSubAgents: true, customPrompts: false },
        protectedFilePatterns: [],
        compress: {
            mode: "range",
            permission: "allow",
            showCompression: false,
            summaryBuffer: true,
            maxContextLimit: 150000,
            minContextLimit: 50000,
            nudgeFrequency: 5,
            minNudgeContextPercent: 15,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: [],
            protectTags: false,
            protectUserMessages: false,
            maxSummaryLengthHard: 20000,
            minCompressRange: 0,
            minNudgeGrowthRatio: 0.45,
            minNudgeGrowthFloor: 5000,
            emergencyThresholdPercent: "98%",
            maxVisibleSegments: 50,
            keepEmbedMaxChars: 2000,
            lastSegmentSoftBlock: false,
        },
        strategies: {
            deduplication: { enabled: true, protectedTools: [] },
            purgeErrors: { enabled: true, turns: 4, protectedTools: [] },
        },
        gc: {
            algorithm: "truncate",
            promotionThreshold: 5,
            maxBlockAge: 15,
            maxOldGenSummaryLength: 3000,
            majorGcThresholdPercent: "100%",
            batchCleanup: { lowThreshold: "60%", highThreshold: "75%", forceThreshold: "90%" },
        },
        qualityGate: qualityGateEnabled
            ? {
                  enabled: true,
                  algorithm: "rouge-recall-v1",
                  algorithms: {
                      "rouge-recall-v1": {
                          layer1MinChars: 200,
                          layer1MinRetentionPct: 5.0,
                          layer2MaxRougeF1: 0.05,
                          layer2MaxTop20Recall: 0.20,
                      },
                  },
              }
            : { enabled: false, algorithm: "rouge-recall-v1" },
    }
}

function textPart(messageID: string, sessionID: string, id: string, text: string) {
    return { id, messageID, sessionID, type: "text" as const, text }
}

function buildLargeMessages(sessionID: string): WithParts[] {
    const messages: WithParts[] = []
    for (let i = 0; i < 5; i++) {
        const msgId = `msg-large-${i}`
        messages.push({
            info: {
                id: msgId,
                role: i % 2 === 0 ? "user" : "assistant",
                sessionID,
                time: { created: i + 1 },
            } as WithParts["info"],
            parts: [
                textPart(
                    msgId,
                    sessionID,
                    `part-${i}`,
                    `This is a detailed message about authentication system design. ` +
                        `The file path is lib/auth.ts at line ${i * 10}. ` +
                        `We found a critical bug where the token refresh logic was broken. ` +
                        `The fix involved adding a retry mechanism with exponential backoff. ` +
                        `Key decision: use JWT over session cookies for stateless architecture.`,
                ),
            ],
        })
    }
    return messages
}

function buildTokenMap(messageIds: string[], tokensPerMessage: number): Map<string, number> {
    const map = new Map<string, number>()
    for (const id of messageIds) map.set(id, tokensPerMessage)
    return map
}

const logger = new Logger(false)

test("evaluatePreCommitQuality returns null when quality gate disabled", () => {
    const config = buildConfig(false)
    const result = evaluatePreCommitQuality(
        [],
        ["msg-1"],
        buildTokenMap(["msg-1"], 100),
        "short",
        config,
        logger,
    )
    assert.equal(result, null)
})

test("evaluatePreCommitQuality rejects summary with extremely low retention (L1)", () => {
    const sessionID = "ses-test-l1"
    const rawMessages = buildLargeMessages(sessionID)
    const messageIds = rawMessages.map((m) => m.info.id)
    const messageTokenById = buildTokenMap(messageIds, 300)

    const result = evaluatePreCommitQuality(
        rawMessages,
        messageIds,
        messageTokenById,
        "Too short.",
        buildConfig(true),
        logger,
    )

    assert.ok(result, "should return a result")
    assert.equal(result!.passed, false)
    assert.equal(result!.layer, "L1-length")
})

test("evaluatePreCommitQuality passes summary with adequate retention and keyword overlap", () => {
    const sessionID = "ses-test-pass"
    const rawMessages = buildLargeMessages(sessionID)
    const messageIds = rawMessages.map((m) => m.info.id)
    const messageTokenById = buildTokenMap(messageIds, 50)

    const goodSummary =
        `Authentication system design analysis. ` +
        `File: lib/auth.ts. Found critical bug in token refresh logic. ` +
        `Fix: retry mechanism with exponential backoff. ` +
        `Decision: JWT over session cookies for stateless architecture. ` +
        `Key details preserved for downstream work.`

    const result = evaluatePreCommitQuality(
        rawMessages,
        messageIds,
        messageTokenById,
        goodSummary,
        buildConfig(true),
        logger,
    )

    assert.ok(result, "should return a result")
    assert.equal(result!.passed, true)
})

test("evaluatePreCommitQuality returns null for empty messageIds", () => {
    const result = evaluatePreCommitQuality(
        buildLargeMessages("ses"),
        [],
        new Map(),
        "summary",
        buildConfig(true),
        logger,
    )
    assert.equal(result, null)
})

test("evaluatePreCommitQuality returns null when no chunks can be extracted", () => {
    const result = evaluatePreCommitQuality(
        [],
        ["msg-nonexistent"],
        buildTokenMap(["msg-nonexistent"], 100),
        "summary",
        buildConfig(true),
        logger,
    )
    assert.equal(result, null)
})

// === buildQualityRejectionError ===

test("buildQualityRejectionError includes range, stats, and acknowledgeRisk instructions", () => {
    const messageIds = ["msg-1", "msg-2"]
    const plan = {
        startId: "m00001",
        endId: "m00005",
        summary: "Too short summary.",
        messageIds,
        messageTokenById: buildTokenMap(messageIds, 500),
    }
    const result: QualityGateResult = {
        passed: false,
        layer: "L1-length",
        reason: "Summary too short",
        metrics: [
            { name: "summaryLen", value: 18 },
            { name: "retentionPct", value: 0.9, format: "percent" },
            { name: "originalTokens", value: 1000 },
            { name: "rougeF1", value: 0.01, format: "ratio" },
            { name: "top20Recall", value: 0.05, format: "ratio" },
        ],
    }

    const error = buildQualityRejectionError(plan, result)
    const msg = error.message

    assert.ok(msg.includes("COMPRESSION REJECTED"), "should have rejection header")
    assert.ok(msg.includes("m00001–m00005"), "should include range")
    assert.ok(msg.includes("1000 tokens"), "should include original token count")
    assert.ok(msg.includes("acknowledgeRisk"), "should mention acknowledgeRisk")
    assert.ok(msg.includes("HOW TO COMPRESS") || msg.includes("KEEP VERBATIM"), "should include compress rules")
})

test("buildQualityRejectionError computes ratio and retention from plan data", () => {
    const messageIds = ["msg-1"]
    const plan = {
        startId: "m00001",
        endId: "m00002",
        summary: "x".repeat(100),
        messageIds,
        messageTokenById: buildTokenMap(messageIds, 1000),
    }
    const result: QualityGateResult = {
        passed: false,
        layer: "L1-length",
        reason: "test",
        metrics: [],
    }

    const error = buildQualityRejectionError(plan, result)
    assert.ok(error.message.includes("1000 tokens"), "should show original tokens")
    assert.ok(error.message.includes("100 chars"), "should show summary chars")
})

test("buildPreemptiveAcknowledgeError explains the parameter is invalid without pending rejection", () => {
    const error = buildPreemptiveAcknowledgeError()
    assert.ok(error.message.includes("acknowledgeRisk"), "should mention the parameter name")
    assert.ok(
        error.message.includes("no quality gate rejection is pending"),
        "should explain why it's invalid",
    )
    assert.ok(error.message.includes("Remove it"), "should tell model to remove it")
})

test("qualityGateRetryPending defaults to false", () => {
    const state = createSessionState()
    assert.equal(state.qualityGateRetryPending, false)
})

test("qualityGateRetryPending resets to false on resetSessionState", () => {
    const state = createSessionState()
    state.qualityGateRetryPending = true
    resetSessionState(state)
    assert.equal(state.qualityGateRetryPending, false)
})

function buildIntegrationMessages(sessionID: string): WithParts[] {
    const messages: WithParts[] = []
    const longText =
        "This is a detailed technical analysis of the authentication system. " +
        "File: lib/auth.ts:142 contains the token refresh logic. " +
        "Decision: JWT over session cookies for stateless architecture. " +
        "Critical bug found: retry mechanism missing exponential backoff. " +
        "Fix applied: added backoff with base=1000ms, max=30000ms. " +
        "Test coverage: lib/auth.test.ts now covers refresh edge cases. " +
        "Performance: 3ms overhead per refresh attempt, acceptable. "
    for (let i = 0; i < 6; i++) {
        const msgId = `msg-int-${i}`
        messages.push({
            info: {
                id: msgId,
                role: i % 2 === 0 ? "user" : "assistant",
                sessionID,
                model: { providerID: "anthropic", modelID: "claude-test" },
                time: { created: i + 1 },
            } as WithParts["info"],
            parts: [textPart(msgId, sessionID, `int-part-${i}`, longText + `Iteration ${i}. `)],
        })
    }
    return messages
}

function buildToolContext(state: ReturnType<typeof createSessionState>, config: PluginConfig, rawMessages: WithParts[]) {
    return createCompressRangeTool({
        client: {
            session: {
                messages: async () => ({ data: rawMessages }),
                get: async () => ({ data: { parentID: null } }),
            },
        },
        registry: singletonRegistry(state),
        logger: new Logger(false),
        config,
        prompts: {
            reload() {},
            getRuntimePrompts() {
                return { compressRange: "", compressMessage: "" }
            },
        },
    } as any)
}

const toolCtx = {
    ask: async () => {},
    metadata: () => {},
    sessionID: "",
    messageID: "msg-compress",
}

test("integration: quality gate rejects bad summary through createCompressRangeTool", async () => {
    const sessionID = `ses-int-reject-${Date.now()}`
    const rawMessages = buildIntegrationMessages(sessionID)
    const state = createSessionState()
    const config = buildConfig(true)
    const tool = buildToolContext(state, config, rawMessages)

    await assert.rejects(
        tool.execute(
            {
                topic: "Auth analysis",
                content: [
                    {
                        startId: "m00001",
                        endId: "m00004",
                        summary: "Stuff happened.",
                    },
                ],
            },
            { ...toolCtx, sessionID },
        ),
        (err: Error) => {
            assert.ok(err.message.includes("COMPRESSION REJECTED"), `should be quality rejection, got: ${err.message}`)
            return true
        },
    )
    assert.equal(state.qualityGateRetryPending, true, "flag should be set after rejection")
    assert.equal(state.prune.messages.blocksById.size, 0, "no blocks should be committed")
})

test("integration: acknowledgeRisk bypasses quality after rejection", async () => {
    const sessionID = `ses-int-ack-${Date.now()}`
    const rawMessages = buildIntegrationMessages(sessionID)
    const state = createSessionState()
    const config = buildConfig(true)
    const tool = buildToolContext(state, config, rawMessages)

    await assert.rejects(
        tool.execute(
            {
                topic: "Auth analysis",
                content: [{ startId: "m00001", endId: "m00004", summary: "Bad." }],
            },
            { ...toolCtx, sessionID },
        ),
    )
    assert.equal(state.qualityGateRetryPending, true)

    const result = await tool.execute(
        {
            topic: "Auth analysis",
            content: [{ startId: "m00001", endId: "m00004", summary: "Bad summary bypassed." }],
            acknowledgeRisk: true,
        } as any,
        { ...toolCtx, sessionID },
    )
    assert.ok(result.includes("Compressed"), "retry with acknowledgeRisk should succeed")
    assert.equal(state.qualityGateRetryPending, false, "flag should be consumed after successful retry")
    assert.equal(state.prune.messages.blocksById.size, 1, "one block should be committed")
})

test("integration: preemptive acknowledgeRisk without prior rejection is rejected", async () => {
    const sessionID = `ses-int-preempt-${Date.now()}`
    const rawMessages = buildIntegrationMessages(sessionID)
    const state = createSessionState()
    const config = buildConfig(true)
    const tool = buildToolContext(state, config, rawMessages)

    await assert.rejects(
        tool.execute(
            {
                topic: "Auth analysis",
                content: [{ startId: "m00001", endId: "m00004", summary: "Good enough summary with keywords." }],
                acknowledgeRisk: true,
            } as any,
            { ...toolCtx, sessionID },
        ),
        (err: Error) => {
            assert.ok(err.message.includes("no quality gate rejection is pending"), `should be preemptive error, got: ${err.message}`)
            return true
        },
    )
    assert.equal(state.qualityGateRetryPending, false, "flag should stay false")
    assert.equal(state.prune.messages.blocksById.size, 0, "no blocks committed")
})

test("integration: flag cleared on successful non-acknowledgeRisk compression", async () => {
    const sessionID = `ses-int-clear-${Date.now()}`
    const rawMessages = buildIntegrationMessages(sessionID)
    const state = createSessionState()
    const config = buildConfig(true)
    const tool = buildToolContext(state, config, rawMessages)

    state.qualityGateRetryPending = true

    const goodSummary =
        "Authentication system analysis. File: lib/auth.ts:142 token refresh logic. " +
        "Decision: JWT over session cookies for stateless architecture. " +
        "Critical bug: retry mechanism missing exponential backoff. Fix: base=1000ms, max=30000ms. " +
        "Test: lib/auth.test.ts covers refresh edge cases. Performance: 3ms overhead per refresh."

    const result = await tool.execute(
        {
            topic: "Auth analysis",
            content: [{ startId: "m00001", endId: "m00004", summary: goodSummary }],
        },
        { ...toolCtx, sessionID },
    )
    assert.ok(result.includes("Compressed"), "good summary should pass quality and compress")
    assert.equal(state.qualityGateRetryPending, false, "flag should be cleared on successful quality pass")
})
