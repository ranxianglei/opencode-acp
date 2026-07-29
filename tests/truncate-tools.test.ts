import assert from "node:assert/strict"
import test from "node:test"

import type { SessionState, WithParts } from "../lib/state/types"
import type { PluginConfig } from "../lib/config"
import type { Logger } from "../lib/logger"
import { truncateLargeToolOutputs } from "../lib/messages/truncate-tools"

const noopLogger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => noopLogger,
} as unknown as Logger

function makeConfig(gc?: Partial<PluginConfig["gc"]>): PluginConfig {
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
            batchCleanup: {
                lowThreshold: "60%",
                highThreshold: "75%",
                forceThreshold: "90%",
            },
            ...gc,
        },
    } as unknown as PluginConfig
}

function makeState(modelContextLimit: number = 200000): SessionState {
    return {
        sessionId: "session-1",
        isSubAgent: false,
        modelContextLimit,
        prune: {
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
        },
        nudges: {
            contextLimitAnchors: new Set(),
            turnNudgeAnchors: new Set(),
            iterationNudgeAnchors: new Set(),
            lastPerMessageNudgeTurn: 0,
            lastPerMessageNudgeTokens: undefined,
            lastNudgeShownTokens: undefined,
            lastToolOutputNudgeTokens: undefined,
            lastTier2NudgeTokens: undefined,
            lastTier3NudgeTokens: undefined,
            shouldInjectThisTurn: undefined,
            baselineLocked: false,
        },
        stats: { pruneTokenCounter: 0, totalPruneTokens: 0 },
        messageIds: { byRawId: new Map(), byRef: new Map(), nextRef: 1 },
        compressionTiming: { pending: new Map(), completed: [] },
        toolParameters: new Map(),
    } as unknown as SessionState
}

function makeToolMessage(
    id: string,
    output: string,
    status: "completed" | "error" = "completed",
): WithParts {
    return {
        info: {
            id,
            role: "tool",
            sessionID: "session-1",
            createdAt: new Date().toISOString(),
        } as any,
        parts: [
            {
                type: "tool",
                toolName: "bash",
                state: {
                    status,
                    output,
                    input: {},
                    time: {},
                },
            },
        ] as any,
    }
}

function makeTextMessage(id: string, text: string, role: "user" | "assistant" = "user"): WithParts {
    return {
        info: {
            id,
            role,
            sessionID: "session-1",
            createdAt: new Date().toISOString(),
        } as any,
        parts: [{ type: "text", text }] as any,
    }
}

function makeAssistantWithTokens(id: string, inputTokens: number, text = "ok"): WithParts {
    return {
        info: {
            id,
            role: "assistant",
            sessionID: "session-1",
            createdAt: new Date().toISOString(),
            tokens: { input: inputTokens, output: 100 },
        } as any,
        parts: [{ type: "text", text }] as any,
    }
}

const LARGE_OUTPUT = "x".repeat(50000)

test("Truncation: does nothing when context is below threshold", () => {
    const state = makeState(200000)
    const config = makeConfig({ majorGcThresholdPercent: "100%" })
    const messages = [
        makeToolMessage("msg-1", LARGE_OUTPUT),
        makeTextMessage("msg-2", "hello"),
        makeTextMessage("msg-3", "world", "assistant"),
    ]

    const original = (messages[0]!.parts[0] as any).state.output
    truncateLargeToolOutputs(state, config, noopLogger, messages)
    const after = (messages[0]!.parts[0] as any).state.output

    assert.equal(after, original, "Tool output should not be modified below threshold")
})

test("Truncation: truncates largest tool output at threshold", () => {
    const state = makeState(1000)
    const config = makeConfig({ majorGcThresholdPercent: "100%" })

    const messages: WithParts[] = []
    for (let i = 0; i < 10; i++) {
        messages.push(makeToolMessage(`msg-${i}`, LARGE_OUTPUT))
    }
    messages.push(makeTextMessage("msg-user", "hello"))
    messages.push(makeAssistantWithTokens("msg-asst", 1000))

    truncateLargeToolOutputs(state, config, noopLogger, messages)

    let truncatedCount = 0
    for (let i = 0; i < 10; i++) {
        const output = (messages[i]!.parts[0] as any).state.output
        if (output.includes("[truncated for context space")) {
            truncatedCount++
            assert.ok(
                output.length < LARGE_OUTPUT.length,
                `msg-${i} should be shorter after truncation`,
            )
        }
    }
    assert.ok(truncatedCount > 0, "At least one tool output should be truncated")
})

test("Truncation: NEVER touches text messages or summaries", () => {
    const state = makeState(1000)
    const config = makeConfig()

    const messages: WithParts[] = [
        makeToolMessage("msg-1", LARGE_OUTPUT),
        makeTextMessage("msg-2", "important summary text that must survive"),
        makeAssistantWithTokens("msg-3", 1000, "another text message"),
        makeTextMessage("msg-4", "user message"),
        makeAssistantWithTokens("msg-5", 1000, "final"),
    ]

    const originalTexts = messages.slice(1).map((m) => (m.parts[0] as any).text)

    truncateLargeToolOutputs(state, config, noopLogger, messages)

    for (let i = 1; i < messages.length; i++) {
        const text = (messages[i]!.parts[0] as any).text
        assert.equal(text, originalTexts[i - 1], `Text message ${i} must not be modified`)
    }
})

test("Truncation: protects last 3 messages", () => {
    const state = makeState(1000)
    const config = makeConfig()

    const messages: WithParts[] = []
    for (let i = 0; i < 10; i++) {
        messages.push(makeToolMessage(`msg-${i}`, LARGE_OUTPUT))
    }
    messages.push(makeAssistantWithTokens("msg-asst", 1000))

    truncateLargeToolOutputs(state, config, noopLogger, messages)

    const protectedStart = messages.length - 3
    for (let i = protectedStart; i < messages.length; i++) {
        const part = messages[i]!.parts[0] as any
        if (part?.type !== "tool") continue
        const output = part.state?.output
        assert.equal(
            output,
            LARGE_OUTPUT,
            `msg-${i} (last ${messages.length - i}) should be protected`,
        )
    }
})

test("Truncation: skips already-truncated outputs", () => {
    const state = makeState(1000)
    const config = makeConfig()

    const alreadyTruncated =
        "prefix data\n\n...[truncated for context space — original ~5000 tokens]...\n\nsuffix data"
    const messages: WithParts[] = [
        makeToolMessage("msg-1", alreadyTruncated),
        makeToolMessage("msg-2", LARGE_OUTPUT),
        makeToolMessage("msg-3", LARGE_OUTPUT),
        makeToolMessage("msg-4", "small"),
        makeToolMessage("msg-5", "small"),
    ]

    truncateLargeToolOutputs(state, config, noopLogger, messages)

    const output0 = (messages[0]!.parts[0] as any).state.output
    assert.equal(output0, alreadyTruncated, "Already-truncated output should not be re-truncated")
})

test("Truncation: skips small tool outputs", () => {
    const state = makeState(1000)
    const config = makeConfig()

    const smallOutput = "small result"
    const messages: WithParts[] = [
        makeToolMessage("msg-1", smallOutput),
        makeToolMessage("msg-2", smallOutput),
        makeToolMessage("msg-3", smallOutput),
        makeToolMessage("msg-4", smallOutput),
        makeToolMessage("msg-5", smallOutput),
    ]

    truncateLargeToolOutputs(state, config, noopLogger, messages)

    for (let i = 0; i < messages.length; i++) {
        const output = (messages[i]!.parts[0] as any).state.output
        assert.equal(output, smallOutput, `Small output ${i} should not be truncated`)
    }
})

test("Truncation: no crash on empty messages", () => {
    const state = makeState(1000)
    const config = makeConfig()

    truncateLargeToolOutputs(state, config, noopLogger, [])
})

test("Truncation: no crash when no tool outputs exist", () => {
    const state = makeState(1000)
    const config = makeConfig()

    const messages: WithParts[] = [
        makeTextMessage("msg-1", "text"),
        makeTextMessage("msg-2", "text", "assistant"),
    ]

    truncateLargeToolOutputs(state, config, noopLogger, messages)
})

test("Truncation: preserves prefix and suffix of truncated output", () => {
    const state = makeState(1000)
    const config = makeConfig()

    const prefix = "START_MARKER_" + "p".repeat(2000)
    const middle = "m".repeat(45000)
    const suffix = "s".repeat(2000) + "_END_MARKER"
    const fullOutput = prefix + middle + suffix

    const messages: WithParts[] = []
    for (let i = 0; i < 5; i++) {
        messages.push(makeToolMessage(`msg-${i}`, fullOutput))
    }
    messages.push(makeTextMessage("msg-6", "text"))
    messages.push(makeAssistantWithTokens("msg-7", 1000))

    truncateLargeToolOutputs(state, config, noopLogger, messages)

    let foundTruncated = false
    for (let i = 0; i < 5; i++) {
        const output = (messages[i]!.parts[0] as any).state.output
        if (output.includes("[truncated for context space")) {
            foundTruncated = true
            assert.ok(output.startsWith("START_MARKER_"), "Prefix should be preserved")
            assert.ok(output.endsWith("_END_MARKER"), "Suffix should be preserved")
            assert.ok(output.includes("[truncated"), "Truncation marker should be present")
        }
    }
    assert.ok(foundTruncated, "At least one output should have been truncated")
})

test("Truncation equivalence: output never longer than input", () => {
    const state = makeState(1000)
    const config = makeConfig()

    const messages: WithParts[] = []
    for (let i = 0; i < 10; i++) {
        messages.push(makeToolMessage(`msg-${i}`, "x".repeat(50000)))
    }
    messages.push(makeTextMessage("msg-11", "text"))
    messages.push(makeAssistantWithTokens("msg-12", 1000))

    const originalLengths = messages.map((m) => {
        const part = m.parts[0] as any
        return part?.state?.output?.length ?? part?.text?.length ?? 0
    })

    truncateLargeToolOutputs(state, config, noopLogger, messages)

    for (let i = 0; i < messages.length; i++) {
        const part = messages[i]!.parts[0] as any
        const newLength = part?.state?.output?.length ?? part?.text?.length ?? 0
        assert.ok(
            newLength <= originalLengths[i],
            `Message ${i}: new length ${newLength} must not exceed original ${originalLengths[i]}`,
        )
    }
})
