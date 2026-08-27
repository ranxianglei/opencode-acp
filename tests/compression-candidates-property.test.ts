import "./test-env"
import assert from "node:assert/strict"
import test from "node:test"
import fc from "fast-check"
import type { PluginConfig } from "../lib/config"
import { assignMessageRefs } from "../lib/message-ids"
import { planCompressionCandidates } from "../lib/messages/inject/candidates"
import { createSessionState, type WithParts } from "../lib/state"

const SID = "ses-compression-candidates-property-test"

function buildConfig(): PluginConfig {
    return {
        enabled: true,
        autoUpdate: false,
        debug: false,
        logLevel: "silent",
        allowSubAgents: true,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: { enabled: true, protectedTools: [] },
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
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: [],
            protectTags: false,
            protectUserMessages: false,
            lastSegmentSoftBlock: false,
            preserveRecentMessages: 0,
            preserveRecentTokens: 0,
            preserveLastUserMessage: false,
            minNudgeContextPercent: 15,
            maxSummaryLengthHard: 10000,
            minCompressRange: 100,
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
            batchCleanup: { lowThreshold: "60%", highThreshold: "75%", forceThreshold: "90%" },
        },
        qualityGate: { enabled: false, algorithm: "rouge-recall-v1", algorithms: {} },
        messageFilters: { enabled: false, filters: {} },
    }
}

function buildMessages(lengths: number[]): WithParts[] {
    return lengths.map((length, index) => ({
        info: {
            id: `msg-${index}`,
            role: index === 0 ? "user" : "assistant",
            sessionID: SID,
            agent: "test",
            time: { created: index + 1 },
            ...(index === 0 ? { model: { providerID: "test", modelID: "test" } } : {}),
        } as any,
        parts: [{ type: "text", text: "x".repeat(length) } as any],
    }))
}

test("candidate planner preserves disjointness and eligibility for mixed message lengths", () => {
    fc.assert(
        fc.property(
            fc.array(fc.integer({ min: 80, max: 220 }), { minLength: 2, maxLength: 20 }),
            (lengths) => {
                const messages = buildMessages(lengths)
                const state = createSessionState()
                assignMessageRefs(state, messages)
                const result = planCompressionCandidates(messages, state, buildConfig())

                assert.ok(result.candidates.length > 0)
                assert.ok(result.candidates.length <= 12)
                const serialized = JSON.stringify(result.candidates)
                assert.equal(
                    serialized,
                    JSON.stringify(
                        planCompressionCandidates(messages, state, buildConfig()).candidates,
                    ),
                )
                const covered = new Set<string>()
                for (const candidate of result.candidates) {
                    for (const messageId of candidate.sourceMessageIds) {
                        assert.equal(covered.has(messageId), false)
                        covered.add(messageId)
                    }
                    assert.ok(candidate.retainedChars >= 100)
                    const start = Number.parseInt(candidate.startRef.slice(1), 10) - 1
                    const end = Number.parseInt(candidate.endRef.slice(1), 10)
                    assert.deepEqual(
                        candidate.sourceMessageIds,
                        messages.slice(start, end).map((message) => message.info.id),
                    )
                    if (candidate.kind === "micro") {
                        assert.ok(candidate.messageCount === 1)
                    } else {
                        assert.ok(candidate.messageCount >= 2)
                    }
                }
            },
        ),
        { numRuns: 100 },
    )
})
