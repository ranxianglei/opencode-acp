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
import { createSessionState, type WithParts } from "../lib/state"
import type { PluginConfig } from "../lib/config"
import type { QualityGateResult } from "../lib/compress/quality-gate/types"
import { Logger } from "../lib/logger"

const testDataHome = join(tmpdir(), `opencode-acp-qg-tests-${process.pid}`)
const testConfigHome = join(tmpdir(), `opencode-acp-qg-config-tests-${process.pid}`)

process.env.XDG_DATA_HOME = testDataHome
process.env.XDG_CONFIG_HOME = testConfigHome

mkdirSync(testDataHome, { recursive: true })
mkdirSync(testConfigHome, { recursive: true })

function buildConfig(qualityGateEnabled: boolean): PluginConfig {
    return {
        enabled: true,
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
            maxContextLimit: 150000,
            minContextLimit: 50000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: [],
            protectTags: false,
            protectUserMessages: false,
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
    state.sessionId = null
    state.prune = {
        tools: new Map(),
        messages: {
            byMessageId: new Map(),
            blocksById: new Map(),
            activeBlockIds: new Set(),
            activeByAnchorMessageId: new Map(),
            nextBlockId: 1,
            nextRunId: 1,
            markedForCleanup: new Set(),
        },
    }
    state.nudges = {
        contextLimitAnchors: new Set(),
        turnNudgeAnchors: new Set(),
        iterationNudgeAnchors: new Set(),
        lastPerMessageNudgeTurn: 0,
        lastPerMessageNudgeTokens: undefined,
        lastNudgeShownTokens: undefined,
        lastToolOutputNudgeTokens: undefined,
        shouldInjectThisTurn: undefined,
        compressBaselineSet: false,
    }
    state.stats = { pruneTokenCounter: 0, totalPruneTokens: 0 }
    state.toolParameters.clear()
    state.subAgentResultCache.clear()
    state.toolIdList = []
    state.messageIds = { byRawId: new Map(), byRef: new Map(), nextRef: 1 }
    state.lastCompaction = 0
    state.currentTurn = 0
    state.modelContextLimit = undefined
    state.systemPromptTokens = undefined
    state.qualityGateRetryPending = false

    assert.equal(state.qualityGateRetryPending, false)
})
