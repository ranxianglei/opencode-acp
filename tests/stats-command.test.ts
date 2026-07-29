import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { buildStatusReport } from "../lib/compress/status"
import type { SessionState, WithParts } from "../lib/state/types"
import type { PluginConfig } from "../lib/config"

function buildConfig(): PluginConfig {
    return {
        enabled: true,
        autoUpdate: false,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: { enabled: true, protectedTools: [] },
        turnProtection: { enabled: false, turns: 4 },
        experimental: { allowSubAgents: false, customPrompts: false },
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
            maxSummaryLengthHard: 10000,
            minCompressRange: 5000,
            minNudgeGrowthRatio: 0.45,
            minNudgeGrowthFloor: 5000,
            emergencyThresholdPercent: "98%",
            maxVisibleSegments: 50,
            keepEmbedMaxChars: 2000,
            lastSegmentSoftBlock: true,
            preserveRecentMessages: 5,
            preserveRecentTokens: 5000,
            preserveLastUserMessage: true,
        },
        gc: {
            algorithm: "truncate",
            promotionThreshold: 5,
            maxBlockAge: Number.MAX_SAFE_INTEGER,
            maxOldGenSummaryLength: 3000,
            majorGcThresholdPercent: "100%",
            batchCleanup: {
                lowThreshold: "55%",
                highThreshold: "75%",
                forceThreshold: "90%",
            },
        },
        qualityGate: {
            enabled: false,
            algorithm: "rouge-recall-v1",
            algorithms: {
                "rouge-recall-v1": {
                    layer1MinChars: 200,
                    layer1MinRetentionPct: 5.0,
                    layer2MaxRougeF1: 0.05,
                    layer2MaxTop20Recall: 0.20,
                },
            },
        },
    }
}

function buildState(): SessionState {
    return {
        sessionId: "test-stats",
        modelContextLimit: 200000,
        currentTurn: 1,
        prune: {
            messages: {
                byMessageId: new Map(),
                activeBlockIds: new Set(),
                blocksById: new Map(),
                nextBlockId: 1,
                nextRunId: 1,
            },
        },
        nudges: {
            byAnchor: new Map(),
            compressBaselineSet: false,
            lastNudgeShownTokens: undefined,
            lastPerMessageNudgeTokens: undefined,
            baselineLocked: false,
            shouldInjectThisTurn: false,
            lastProcessedCompressMessageId: undefined,
        },
        stats: {
            totalTokens: 0,
            totalTools: 0,
            totalMessages: 0,
            sessionCount: 0,
        },
        messageIds: {
            byRawId: new Map(),
            byRef: new Map(),
            nextRefId: 1,
        },
        compressionTiming: {},
        toolParameters: new Map(),
        compressPermission: undefined,
    } as any
}

function userMsg(id: string, text: string): WithParts {
    return {
        info: { id, role: "user" } as any,
        parts: [{ type: "text", text } as any],
    }
}

function assistantMsg(id: string, text: string): WithParts {
    return {
        info: { id, role: "assistant" } as any,
        parts: [{ type: "text", text } as any],
    }
}

describe("buildStatusReport (acp_stats wrapper)", () => {
    test("overview with no blocks shows empty state", () => {
        const config = buildConfig()
        const state = buildState()
        const messages: WithParts[] = [
            userMsg("m1", "hello"),
            assistantMsg("m2", "hi there"),
        ]

        const report = buildStatusReport({ state, config }, messages)

        assert.ok(report.includes("CONTEXT BREAKDOWN"))
        assert.ok(report.includes("No compressed blocks"))
    })

    test("overview with messages shows token breakdown", () => {
        const config = buildConfig()
        const state = buildState()
        const messages: WithParts[] = [
            userMsg("m1", "hello world this is a test message"),
            assistantMsg("m2", "hi there this is a response that has some content"),
        ]

        const report = buildStatusReport({ state, config }, messages)

        assert.ok(report.includes("CONTEXT BREAKDOWN"))
        assert.ok(report.includes("tool"))
        assert.ok(report.includes("text"))
    })

    test("scope compressed with no blocks shows empty", () => {
        const config = buildConfig()
        const state = buildState()

        const report = buildStatusReport(
            { state, config },
            [],
            { scope: "compressed" },
        )

        assert.ok(report.includes("COMPRESSED"))
        assert.ok(report.includes("0 blocks"))
    })
})
