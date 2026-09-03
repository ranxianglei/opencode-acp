import "./test-env"
import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { assignMessageRefs } from "../lib/message-ids"
import { prepareExecutableRangePlans } from "../lib/compress/range-utils"
import { buildSearchContext } from "../lib/compress/search"
import { buildStatusReport } from "../lib/compress/status"
import {
    formatCompressionCandidates,
    planCompressionCandidates,
} from "../lib/messages/inject/candidates"
import { createSessionState, type SessionState, type WithParts } from "../lib/state"
import { injectCompressNudges } from "../lib/messages/inject/inject"
import { Logger } from "../lib/logger"

const SID = "ses-compression-candidates-test"

function config(overrides: Partial<PluginConfig["compress"]> = {}): PluginConfig {
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
            // Candidate tests exercise low-token nudge behavior; upstream floor
            // policy is covered independently in inject tests.
            minNudgeContextPercent: 0,
            maxSummaryLengthHard: 10000,
            minCompressRange: 100,
            minNudgeGrowthRatio: 0.45,
            minNudgeGrowthFloor: 5000,
            emergencyThresholdPercent: "98%",
            maxVisibleSegments: 50,
            keepEmbedMaxChars: 2000,
            ...overrides,
        },
        gc: {
            algorithm: "truncate",
            promotionThreshold: 5,
            maxBlockAge: 15,
            maxOldGenSummaryLength: 3000,
            majorGcThresholdPercent: "100%",
            batchCleanup: { lowThreshold: "60%", highThreshold: "75%", forceThreshold: "90%" },
        },
        qualityGate: {
            enabled: false,
            algorithm: "rouge-recall-v1",
            algorithms: {},
        },
        messageFilters: { enabled: false, filters: {} },
    }
}

function textMessage(id: string, role: "user" | "assistant", text: string): WithParts {
    return {
        info: {
            id,
            role,
            sessionID: SID,
            agent: "test",
            time: { created: 1 },
            ...(role === "user" ? { model: { providerID: "test", modelID: "test" } } : {}),
        } as WithParts["info"],
        parts: [{ id: `${id}-part`, messageID: id, sessionID: SID, type: "text", text } as any],
    }
}

function toolMessage(
    id: string,
    role: "user" | "assistant",
    callID: string,
    tool: string,
    output: string,
    input: Record<string, unknown> = {},
): WithParts {
    return {
        info: {
            id,
            role,
            sessionID: SID,
            agent: "test",
            time: { created: 1 },
            ...(role === "user" ? { model: { providerID: "test", modelID: "test" } } : {}),
        } as WithParts["info"],
        parts: [
            {
                id: `${id}-part`,
                messageID: id,
                sessionID: SID,
                type: "tool",
                tool,
                callID,
                state: { status: "completed", input, output },
            } as any,
        ],
    }
}

function setup(messages: WithParts[]): SessionState {
    const state = createSessionState()
    state.sessionId = SID
    assignMessageRefs(state, messages)
    return state
}

function setTokens(message: WithParts, input: number, output = 100): void {
    ;(message.info as any).tokens = {
        input,
        output,
        reasoning: 0,
        cache: { read: 0, write: 0 },
    }
}

test("large plain message becomes a micro candidate and small residuals become an episode", () => {
    const messages = [
        textMessage("u1", "user", "a".repeat(40)),
        textMessage("a1", "assistant", "b".repeat(40)),
        textMessage("a2", "assistant", "c".repeat(140)),
        textMessage("a3", "assistant", "d".repeat(40)),
        textMessage("a4", "assistant", "e".repeat(40)),
        textMessage("a5", "assistant", "f".repeat(40)),
    ]
    const state = setup(messages)
    const result = planCompressionCandidates(messages, state, config())

    assert.equal(result.candidates.length, 2)
    const micro = result.candidates.find((candidate) => candidate.kind === "micro")
    const episode = result.candidates.find((candidate) => candidate.kind === "episode")
    assert.ok(micro)
    assert.ok(episode)
    assert.equal(micro.startRef, "m00003")
    assert.equal(micro.endRef, "m00003")
    assert.equal(episode.startRef, "m00004")
    assert.equal(episode.endRef, "m00006")
})

test("episode candidates preserve eligible history before a protected recent tail", () => {
    const messages = Array.from({ length: 30 }, (_, index) =>
        textMessage(
            `message-${index + 1}`,
            index % 2 === 0 ? "user" : "assistant",
            "x".repeat(200),
        ),
    )
    const state = setup(messages)
    const result = planCompressionCandidates(
        messages,
        state,
        config({
            minCompressRange: 1000,
            lastSegmentSoftBlock: true,
            preserveRecentMessages: 20,
            preserveRecentTokens: 0,
            preserveLastUserMessage: false,
        }),
    )

    const episode = result.candidates.find((candidate) => candidate.kind === "episode")
    assert.ok(episode)
    assert.equal(episode.startRef, "m00001")
    assert.equal(episode.endRef, "m00010")
})

test("tool invocation and result form one pair-safe micro candidate", () => {
    const messages = [
        textMessage("u1", "user", "context"),
        toolMessage("a1", "assistant", "call-1", "bash", "x".repeat(70), { command: "npm test" }),
        toolMessage("u2", "user", "call-1", "bash", "y".repeat(70)),
        textMessage("a2", "assistant", "after"),
    ]
    const state = setup(messages)
    const result = planCompressionCandidates(messages, state, config())

    assert.ok(
        result.candidates.some(
            (candidate) =>
                candidate.kind === "micro" &&
                candidate.startRef === "m00002" &&
                candidate.endRef === "m00003" &&
                candidate.messageCount === 2,
        ),
    )
})

test("transitive multi-call spans remain one candidate across intervening messages", () => {
    const messages = [
        textMessage("u1", "user", "context"),
        {
            ...toolMessage("a1", "assistant", "call-1", "bash", "x".repeat(40)),
            parts: [
                {
                    type: "tool",
                    tool: "bash",
                    callID: "call-1",
                    state: { status: "pending", input: {} },
                } as any,
                {
                    type: "tool",
                    tool: "read",
                    callID: "call-2",
                    state: { status: "pending", input: {} },
                } as any,
            ],
        },
        textMessage("a2", "assistant", "intervening reasoning"),
        toolMessage("u2", "user", "call-1", "bash", "y".repeat(40)),
        toolMessage("u3", "user", "call-2", "read", "z".repeat(80)),
    ]
    const state = setup(messages)
    const result = planCompressionCandidates(messages, state, config())
    const candidate = result.candidates.find((item) => item.startRef === "m00002")

    assert.ok(candidate)
    assert.equal(candidate.endRef, "m00005")
    assert.deepEqual(candidate.sourceMessageIds, ["a1", "a2", "u2", "u3"])
})

test("protected, recent, and active messages never enter candidates", () => {
    const messages = [
        toolMessage("skill", "assistant", "skill-1", "skill", "s".repeat(150)),
        textMessage("old", "assistant", "o".repeat(150)),
        textMessage("recent", "assistant", "r".repeat(150)),
    ]
    const state = setup(messages)
    state.prune.messages.byMessageId.set("old", {
        tokenCount: 1,
        allBlockIds: [1],
        activeBlockIds: [1],
    })
    const result = planCompressionCandidates(
        messages,
        state,
        config({
            protectedTools: ["skill"],
            lastSegmentSoftBlock: true,
            preserveRecentMessages: 1,
            preserveRecentTokens: 0,
        }),
    )

    assert.equal(result.candidates.length, 0)
    assert.ok(result.omitted.some((item) => item.reason === "active-compression"))
    assert.ok(result.omitted.some((item) => item.reason === "protected-tool-or-file"))
    assert.ok(
        result.omitted.some(
            (item) => item.reason === "recent-protection" || item.reason === "executor-rejected",
        ),
    )
})

test("synthetic, ignored, and protected-file messages are omitted", () => {
    const messages = [
        textMessage("msg_acp_recap_1", "assistant", "s".repeat(200)),
        {
            ...textMessage("ignored", "user", "i".repeat(200)),
            parts: [{ type: "text", text: "i".repeat(200), ignored: true } as any],
        },
        toolMessage("secret", "assistant", "read-1", "read", "r".repeat(200), {
            filePath: "src/secret.ts",
        }),
    ]
    const state = setup(messages)
    const protectedConfig = config()
    protectedConfig.protectedFilePatterns = ["src/**/*.ts"]
    const result = planCompressionCandidates(messages, state, protectedConfig)

    assert.equal(result.candidates.length, 0)
    assert.ok(result.omitted.some((item) => item.reason === "synthetic-or-ignored"))
    assert.ok(result.omitted.some((item) => item.reason === "protected-tool-or-file"))
})

test("candidate output is deterministic, non-overlapping, and capped at twelve", () => {
    const messages = Array.from({ length: 20 }, (_, index) =>
        textMessage(`m-${index}`, index === 0 ? "user" : "assistant", "x".repeat(120 + index)),
    )
    const state = setup(messages)
    const first = planCompressionCandidates(messages, state, config())
    const second = planCompressionCandidates(messages, state, config())

    assert.equal(first.candidates.length, 12)
    assert.equal(first.truncatedCount, 8)
    assert.deepEqual(first.candidates, second.candidates)
    const ordered = [...first.candidates].sort(
        (left, right) =>
            Number.parseInt(left.startRef.slice(1), 10) -
            Number.parseInt(right.startRef.slice(1), 10),
    )
    for (let index = 1; index < ordered.length; index++) {
        assert.ok(
            Number.parseInt(ordered[index - 1]!.endRef.slice(1), 10) <
                Number.parseInt(ordered[index]!.startRef.slice(1), 10),
            "candidate ranges must not overlap",
        )
    }
    assert.match(formatCompressionCandidates(first), /COMPRESSION CANDIDATES/)
    assert.match(formatCompressionCandidates(first), /additional candidates omitted/)
})

test("planner uses executor character admission at the exact minimum", () => {
    const messages = [textMessage("a1", "assistant", "x".repeat(100))]
    const state = setup(messages)
    const cfg = config({ minCompressRange: 100 })
    const result = planCompressionCandidates(messages, state, cfg)
    assert.equal(result.candidates.length, 1)

    const context = buildSearchContext(state, messages)
    const executable = prepareExecutableRangePlans(
        {
            content: [{ startId: "m00001", endId: "m00001", topic: "test", summary: "summary" }],
        },
        context,
        state,
        cfg,
    )
    assert.equal(executable.totalChars, 100)

    const below = [textMessage("a2", "assistant", "x".repeat(99))]
    const belowState = setup(below)
    const belowConfig = config({ minCompressRange: 100 })
    assert.equal(planCompressionCandidates(below, belowState, belowConfig).candidates.length, 0)
    assert.throws(
        () =>
            prepareExecutableRangePlans(
                {
                    content: [
                        { startId: "m00001", endId: "m00001", topic: "test", summary: "summary" },
                    ],
                },
                buildSearchContext(belowState, below),
                belowState,
                belowConfig,
            ),
        /Range too small/,
    )
})

test("nudge and default status render the same candidate list", () => {
    const messages = [
        textMessage("u1", "user", "a".repeat(40)),
        textMessage("a1", "assistant", "b".repeat(140)),
        textMessage("a2", "assistant", "c".repeat(40)),
        textMessage("a3", "assistant", "d".repeat(40)),
        textMessage("a4", "assistant", "e".repeat(40)),
    ]
    ;(messages[1]!.info as any).tokens = {
        input: 1200,
        output: 100,
        reasoning: 0,
        cache: { read: 0, write: 0 },
    }
    const state = setup(messages)
    state.modelContextLimit = 100_000
    state.nudges.lastPerMessageNudgeTokens = 0
    const cfg = config({
        minCompressRange: 100,
        minContextLimit: 100,
        maxContextLimit: 90_000,
        nudgeGrowthTokens: 100,
        minNudgeGrowthFloor: 100,
        minNudgeGrowthRatio: 0.1,
    })
    const planned = planCompressionCandidates(messages, state, cfg)
    assert.ok(planned.candidates.length > 0)

    injectCompressNudges(
        state,
        cfg,
        new Logger(false),
        messages,
        {} as any,
        undefined,
        undefined,
        undefined,
        messages,
    )

    const suffix = messages[messages.length - 1]
    const suffixText = suffix?.parts
        .filter((part) => part.type === "text")
        .map((part) => (part as any).text)
        .join("\n")
    const expected = formatCompressionCandidates(planned)
    assert.equal(state.nudges.shouldInjectThisTurn, true)
    assert.ok(suffixText?.includes(expected))
    assert.match(suffixText ?? "", /You may batch selected independent candidates/)
    assert.match(suffixText ?? "", /If one listed candidate is clearly complete/)
    assert.doesNotMatch(suffixText ?? "", /Compress all ranges in one call/)

    const status = buildStatusReport({ state, config: cfg }, messages.slice(0, -1))
    assert.ok(status.includes(expected))
    const extractCandidates = (text: string) =>
        text.split("\n").filter((line) => /^\s+(MICRO|EPISODE)\s/.test(line))
    assert.deepEqual(extractCandidates(suffixText ?? ""), extractCandidates(status))
})

test("no-nudge turns skip candidate planning", () => {
    const messages = [
        textMessage("u1", "user", "start"),
        textMessage("a1", "assistant", "x".repeat(300)),
    ]
    setTokens(messages[1]!, 1000, 0)
    const state = setup(messages)
    state.modelContextLimit = 100_000
    state.nudges.lastPerMessageNudgeTokens = 1000
    const cfg = config({
        minContextLimit: 100,
        maxContextLimit: 90_000,
        nudgeGrowthTokens: 1000,
        minNudgeGrowthFloor: 100,
        minNudgeGrowthRatio: 0.1,
    })
    let candidateMessagesAccesses = 0
    const candidateMessages = new Proxy([] as WithParts[], {
        get(target, property, receiver) {
            candidateMessagesAccesses++
            return Reflect.get(target, property, receiver)
        },
    })

    injectCompressNudges(
        state,
        cfg,
        new Logger(false),
        messages,
        {} as any,
        undefined,
        undefined,
        undefined,
        candidateMessages,
    )

    assert.equal(state.nudges.shouldInjectThisTurn, false)
    assert.equal(candidateMessagesAccesses, 0)
})

test("candidate nudges preserve baseline and re-fire after compression across turns", () => {
    const state = createSessionState()
    state.sessionId = SID
    state.modelContextLimit = 100_000
    const cfg = config({
        minContextLimit: 100,
        maxContextLimit: 90_000,
        minCompressRange: 100,
        nudgeGrowthTokens: 1000,
        minNudgeGrowthFloor: 100,
        minNudgeGrowthRatio: 0.1,
    })

    const baseline = [
        textMessage("u1", "user", "start"),
        textMessage("a1", "assistant", "x".repeat(300)),
    ]
    setTokens(baseline[1]!, 1000, 0)
    assignMessageRefs(state, baseline)
    injectCompressNudges(
        state,
        cfg,
        new Logger(false),
        baseline,
        {} as any,
        undefined,
        undefined,
        undefined,
        baseline,
    )
    assert.equal(state.nudges.shouldInjectThisTurn, false)
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 1000)

    const growth = [
        textMessage("u2", "user", "more"),
        textMessage("a2", "assistant", "y".repeat(300)),
    ]
    setTokens(growth[1]!, 2200, 0)
    assignMessageRefs(state, growth)
    injectCompressNudges(
        state,
        cfg,
        new Logger(false),
        growth,
        {} as any,
        undefined,
        undefined,
        undefined,
        growth,
    )
    assert.equal(state.nudges.shouldInjectThisTurn, true)
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 1000)
    assert.equal(state.nudges.lastNudgeShownTokens, 2200)

    setTokens(growth[1]!, 2800, 0)
    injectCompressNudges(
        state,
        cfg,
        new Logger(false),
        growth,
        {} as any,
        undefined,
        undefined,
        undefined,
        growth,
    )
    const repeatedSuffixText = growth[growth.length - 1]!.parts.filter(
        (part) => part.type === "text",
    )
        .map((part) => (part as any).text)
        .join("\n")
    assert.match(repeatedSuffixText, /already been shown without a compression/)
    assert.match(
        repeatedSuffixText,
        /If candidates are clearly stale, call the `compress` tool for one clearly stale candidate/,
    )
    assert.match(repeatedSuffixText, /things needed to proceed well/)
    assert.equal(state.nudges.lastNudgeShownTokens, 2800)

    const compressed = [
        textMessage("u3", "user", "compress"),
        {
            ...textMessage("a3", "assistant", "done"),
            parts: [
                {
                    type: "tool",
                    tool: "compress",
                    callID: "compress-1",
                    state: { status: "completed", input: {}, output: "ok" },
                } as any,
            ],
        },
    ]
    setTokens(compressed[1]!, 1800, 0)
    assignMessageRefs(state, compressed)
    injectCompressNudges(
        state,
        cfg,
        new Logger(false),
        compressed,
        {} as any,
        undefined,
        undefined,
        undefined,
        compressed,
    )
    assert.equal(state.nudges.shouldInjectThisTurn, false)
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 1800)

    const secondGrowth = [
        textMessage("u4", "user", "continue"),
        textMessage("a4", "assistant", "z".repeat(300)),
    ]
    setTokens(secondGrowth[1]!, 3100, 0)
    assignMessageRefs(state, secondGrowth)
    injectCompressNudges(
        state,
        cfg,
        new Logger(false),
        secondGrowth,
        {} as any,
        undefined,
        undefined,
        undefined,
        secondGrowth,
    )
    assert.equal(state.nudges.shouldInjectThisTurn, true)
    assert.equal(state.nudges.lastPerMessageNudgeTokens, 1800)
    assert.equal(state.nudges.lastNudgeShownTokens, 3100)
})

test("production nudge fails closed when legacy ranges have no executable candidates", () => {
    const messages = [textMessage("a1", "assistant", "x".repeat(5000))]
    ;(messages[0]!.info as any).tokens = {
        input: 2000,
        output: 100,
        reasoning: 0,
        cache: { read: 0, write: 0 },
    }
    const state = setup(messages)
    state.modelContextLimit = 100_000
    state.nudges.lastPerMessageNudgeTokens = 0
    state.prune.messages.byMessageId.set("a1", {
        tokenCount: 1,
        allBlockIds: [1],
        activeBlockIds: [1],
    })
    const cfg = config({
        minContextLimit: 100,
        maxContextLimit: 90_000,
        minCompressRange: 100,
        nudgeGrowthTokens: 100,
        minNudgeGrowthFloor: 100,
        minNudgeGrowthRatio: 0.1,
    })

    injectCompressNudges(
        state,
        cfg,
        new Logger(false),
        messages,
        {} as any,
        undefined,
        undefined,
        undefined,
        messages,
    )

    assert.equal(state.nudges.shouldInjectThisTurn, false)
})

test("production candidate nudge trusts executable planner candidates over legacy range filtering", () => {
    const messages = [textMessage("u1", "user", "x".repeat(6000))]
    setTokens(messages[0]!, 10_000, 0)
    const state = setup(messages)
    state.modelContextLimit = 100_000
    state.nudges.lastPerMessageNudgeTokens = 0
    const cfg = config({
        minContextLimit: 100,
        maxContextLimit: 90_000,
        minCompressRange: 5000,
        nudgeGrowthTokens: 100,
        minNudgeGrowthFloor: 100,
        minNudgeGrowthRatio: 0.1,
        lastSegmentSoftBlock: false,
        preserveRecentMessages: 0,
        preserveRecentTokens: 0,
        preserveLastUserMessage: false,
    })

    injectCompressNudges(
        state,
        cfg,
        new Logger(false),
        messages,
        {} as any,
        undefined,
        undefined,
        undefined,
        messages,
    )

    assert.equal(state.nudges.shouldInjectThisTurn, true)
})
