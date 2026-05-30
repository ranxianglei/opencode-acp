/**
 * E2E tests for nudge injection, block lifecycle, and multi-session scenarios.
 *
 * Tests exercise `createChatMessageTransformHandler` with focus on:
 * - Compression nudge injection based on context usage
 * - Compression block deactivation and aging
 * - Tool error pruning
 * - Session switching
 * - Message ID injection into tool parts
 */

import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { createChatMessageTransformHandler } from "../lib/hooks"
import { Logger } from "../lib/logger"
import { createSessionState, type WithParts, type SessionState } from "../lib/state"
import { isSyntheticMessage } from "../lib/messages/query"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

// ─── Helpers ────────────────────────────────────────────────────────────────

const SID_A = "session-nudge-a"
const SID_B = "session-nudge-b"

function buildConfig(overrides: Partial<PluginConfig> = {}): PluginConfig {
    const base: PluginConfig = {
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
            mode: "message",
            permission: "allow",
            showCompression: false,
            summaryBuffer: true,
            maxContextLimit: 150000,
            minContextLimit: 50000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: ["task"],
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
        },
    }
    return { ...base, ...overrides }
}

function makeUserMessage(id: string, text: string, sessionId: string = SID_A): WithParts {
    return {
        info: {
            id,
            sessionID: sessionId,
            role: "user",
            agent: "assistant",
            time: { created: Date.now() },
            model: { providerID: "test-provider", modelID: "test-model" },
        } as WithParts["info"],
        parts: [{ type: "text", text, id: `${id}-p1`, sessionID: sessionId, messageID: id }],
    }
}

function makeAssistantMessage(
    id: string,
    text: string,
    extraParts: any[] = [],
    sessionId: string = SID_A,
    tokenOverrides: { input?: number; output?: number } = {},
): WithParts {
    return {
        info: {
            id,
            sessionID: sessionId,
            role: "assistant",
            agent: "assistant",
            parentID: "parent-placeholder",
            modelID: "test-model",
            providerID: "test-provider",
            mode: "normal",
            path: { cwd: "/", root: "/" },
            summary: false,
            cost: 0,
            tokens: {
                input: tokenOverrides.input ?? 100,
                output: tokenOverrides.output ?? 50,
                reasoning: 0,
                cache: { read: 0, write: 0 },
            },
            time: { created: Date.now() },
        } as WithParts["info"],
        parts: [
            { type: "step-start", id: `${id}-ss`, sessionID: sessionId, messageID: id },
            { type: "text", text, id: `${id}-p1`, sessionID: sessionId, messageID: id },
            ...extraParts,
        ],
    }
}

function makeToolPart(
    callID: string,
    tool: string,
    status: "completed" | "error" | "running" = "completed",
    output: string = "tool output",
    input: any = {},
    sessionId: string = SID_A,
    messageId: string = "",
): any {
    return {
        type: "tool",
        tool,
        callID,
        id: `part-${callID}`,
        sessionID: sessionId,
        messageID: messageId,
        state: { status, output, input, error: status === "error" ? "error msg" : undefined },
    }
}

function createMockClient() {
    return {
        session: {
            get: async () => ({ data: { parentID: null } }),
        },
    }
}

function createMockPrompts() {
    return {
        reload() {},
        getRuntimePrompts() {
            return {
                system: "ACP system",
                compressRange: "compress range",
                compressMessage: "compress message",
                contextLimitNudge: "nudge",
                turnNudge: "turn nudge",
                iterationNudge: "iteration nudge",
                manualExtension: "",
                subagentExtension: "",
            }
        },
    }
}

function setupPipeline(
    sessionId: string = SID_A,
    configOverrides: Partial<PluginConfig> = {},
    stateOverrides: Partial<SessionState> = {},
) {
    const tempDir = mkdtempSync(join(tmpdir(), "acp-e2e2-"))
    process.env.XDG_DATA_HOME = tempDir
    process.env.XDG_CONFIG_HOME = tempDir

    const state = createSessionState()
    state.sessionId = sessionId
    Object.assign(state, stateOverrides)

    const config = buildConfig(configOverrides)
    const logger = new Logger(false)
    const handler = createChatMessageTransformHandler(
        createMockClient(),
        state,
        logger,
        config,
        createMockPrompts(),
        { global: undefined, agents: {} },
    )

    return { state, logger, config, handler, tempDir }
}

// ─── Test: Nudge injection when context is near limits ──────────────────────

test("nudge injection: context usage tag injected when modelContextLimit is set", async () => {
    const { state, handler } = setupPipeline(SID_A, {}, {
        modelContextLimit: 200000,
    })

    const output = {
        messages: [
            makeUserMessage("u1", "Hello"),
            makeAssistantMessage("a1", "Hi", [], SID_A, { input: 100000, output: 50000 }),
            makeUserMessage("u2", "Tell me more"),
        ],
    }

    await handler({}, output)

    const suffixMessage = output.messages.find((m: WithParts) => isSyntheticMessage(m))
    assert.ok(suffixMessage, "suffix message should be created")
    const textParts = suffixMessage!.parts.filter((p: any) => p.type === "text")
    const combinedText = textParts.map((p: any) => p.text).join("")
    assert.ok(combinedText.includes("Context usage:"), "should inject context usage tag")
})

// ─── Test: No nudge when permission is denied ───────────────────────────────

test("nudge injection: no context usage tag when permission is denied", async () => {
    const { state, handler } = setupPipeline(SID_A, {
        compress: {
            ...buildConfig().compress,
            permission: "deny",
        },
    }, {
        modelContextLimit: 200000,
    })

    const output = {
        messages: [
            makeUserMessage("u1", "Hello"),
            makeAssistantMessage("a1", "Hi", [], SID_A, { input: 100000, output: 50000 }),
            makeUserMessage("u2", "Tell me more"),
        ],
    }

    await handler({}, output)

    const lastUser = output.messages.find((m: WithParts) => m.info.id === "u2")
    assert.ok(lastUser)
    const textParts = lastUser!.parts.filter((p: any) => p.type === "text" && !p.synthetic)
    const originalText = textParts.map((p: any) => p.text).join("")
    assert.ok(!originalText.includes("Context usage:"), "should NOT inject context usage with deny")
})

// ─── Test: Block deactivation by age (major GC) ─────────────────────────────

test("block aging: old blocks are deactivated by major GC", async () => {
    const { state, handler } = setupPipeline(SID_A, {
        gc: { ...buildConfig().gc, maxBlockAge: 2 },
    })

    const blockId = 1
    state.prune.messages.blocksById.set(blockId, {
        blockId,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 500,
        summaryTokens: 50,
        durationMs: 0,
        mode: "message",
        topic: "test",
        batchTopic: "test",
        startId: "m00001",
        endId: "m00002",
        anchorMessageId: "u2",
        compressMessageId: "msg-comp",
        compressCallId: "call-comp",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: ["u1"],
        directToolIds: [],
        effectiveMessageIds: ["u1"],
        effectiveToolIds: [],
        createdAt: Date.now() - 1000,
        summary: "Compressed summary text",
        survivedCount: 10,
        generation: "old",
    })
    state.prune.messages.activeBlockIds.add(blockId)
    state.prune.messages.activeByAnchorMessageId.set("u2", blockId)
    state.prune.messages.byMessageId.set("u1", {
        tokenCount: 200, allBlockIds: [blockId], activeBlockIds: [blockId],
    })

    const output = {
        messages: [
            makeUserMessage("u1", "Hello"),
            makeAssistantMessage("a1", "Hi"),
            makeUserMessage("u2", "Next"),
            makeAssistantMessage("a2", "Response"),
        ],
    }

    await handler({}, output)

    assert.equal(
        state.prune.messages.blocksById.get(blockId)?.active,
        false,
        "block should be deactivated because survivedCount (10) > maxBlockAge (2)",
    )
})

// ─── Test: Tool error input pruning ─────────────────────────────────────────

test("tool error pruning: error tool inputs are replaced with placeholder", async () => {
    const { state, handler } = setupPipeline()

    const callID = "call-bash-err"
    state.prune.tools.set(callID, Date.now())

    const errorTool = makeToolPart(
        callID, "bash", "error", "error output",
        { command: "rm -rf /", cwd: "/home/user" },
        SID_A, "a1",
    )
    const output = {
        messages: [
            makeUserMessage("u1", "Run bad command"),
            makeAssistantMessage("a1", "Trying...", [errorTool]),
        ],
    }

    await handler({}, output)

    const assistantMsg = output.messages.find((m: WithParts) => m.info.id === "a1")
    assert.ok(assistantMsg, "assistant message should survive")
    const tool = assistantMsg!.parts.find((p: any) => p.type === "tool")
    assert.ok(tool, "tool part should be present")

    const toolState = (tool as any).state
    assert.equal(toolState.status, "error")
    assert.equal(toolState.input.command, "[input removed due to failed tool call]")
    assert.equal(toolState.input.cwd, "[input removed due to failed tool call]")
})

// ─── Test: Session switch resets state ──────────────────────────────────────

test("session switch: state is reinitialized when session changes", async () => {
    const { state, handler } = setupPipeline(SID_A)

    // First call with session A
    const output1 = {
        messages: [
            makeUserMessage("u1a", "Hello A", SID_A),
            makeAssistantMessage("a1a", "Hi A", [], SID_A),
        ],
    }
    await handler({}, output1)

    assert.equal(state.sessionId, SID_A)
    assert.equal(state.messageIds.byRawId.get("u1a"), "m00001")
    assert.equal(state.messageIds.byRawId.get("a1a"), "m00002")

    // Second call with a DIFFERENT session (session B)
    // checkSession detects the change and reinitializes
    const output2 = {
        messages: [
            makeUserMessage("u1b", "Hello B", SID_B),
            makeAssistantMessage("a1b", "Hi B", [], SID_B),
        ],
    }
    await handler({}, output2)

    // Session should have switched
    assert.equal(state.sessionId, SID_B)

    // Old message IDs should be cleared (state reset on session switch)
    assert.equal(state.messageIds.byRawId.has("u1a"), false, "old session IDs should be cleared")

    // New session gets fresh IDs
    assert.equal(state.messageIds.byRawId.get("u1b"), "m00001")
    assert.equal(state.messageIds.byRawId.get("a1b"), "m00002")
})

// ─── Test: Message IDs injected into tool parts ─────────────────────────────

test("message ID injection: IDs are appended to tool parts", async () => {
    const { state, handler } = setupPipeline()

    const toolPart = makeToolPart(
        "call-1", "read", "completed", "file contents",
        { path: "/test.txt" }, SID_A, "a1",
    )
    const output = {
        messages: [
            makeUserMessage("u1", "Read file"),
            makeAssistantMessage("a1", "Here is the file", [toolPart]),
        ],
    }

    await handler({}, output)

    const assistantMsg = output.messages.find((m: WithParts) => m.info.id === "a1")
    assert.ok(assistantMsg)

    const tool = assistantMsg!.parts.find((p: any) => p.type === "tool")
    assert.ok(tool)

    const toolOutput = (tool as any).state.output as string
    assert.ok(
        toolOutput.includes("dcp-message-id"),
        "tool output should contain message ID tag",
    )
    assert.ok(
        toolOutput.includes("m00002"),
        "tool output should contain the m00002 ref",
    )
})

// ─── Test: Visible ID range injection ───────────────────────────────────────

test("visible ID range: range tag injected into suffix message", async () => {
    const { state, handler } = setupPipeline(SID_A, {}, {
        modelContextLimit: 200000,
    })

    const output = {
        messages: [
            makeUserMessage("u1", "First"),
            makeAssistantMessage("a1", "Response 1"),
            makeUserMessage("u2", "Second"),
            makeAssistantMessage("a2", "Response 2"),
            makeUserMessage("u3", "Third"),
        ],
    }

    await handler({}, output)

    const suffixMessage = output.messages.find((m: WithParts) => isSyntheticMessage(m))
    assert.ok(suffixMessage, "suffix message should be created")
    const textParts = suffixMessage!.parts.filter((p: any) => p.type === "text")
    const combinedText = textParts.map((p: any) => p.text).join("")
    assert.ok(
        combinedText.includes("[Visible message IDs:"),
        "should inject visible ID range tag",
    )
    assert.ok(
        combinedText.includes("messages"),
        "range tag should mention message count",
    )
})

// ─── Test: Block consumed by newer block ────────────────────────────────────

test("block consumption: newer block deactivates consumed blocks", async () => {
    const { state, handler } = setupPipeline()

    // Old block
    const oldBlockId = 1
    state.prune.messages.blocksById.set(oldBlockId, {
        blockId: oldBlockId,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 500,
        summaryTokens: 50,
        durationMs: 0,
        mode: "message",
        topic: "old",
        batchTopic: "old",
        startId: "m00001",
        endId: "m00002",
        anchorMessageId: "u1",
        compressMessageId: "msg-comp1",
        compressCallId: "call-comp1",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: ["u1"],
        directToolIds: [],
        effectiveMessageIds: ["u1"],
        effectiveToolIds: [],
        createdAt: Date.now() - 2000,
        summary: "Old summary",
        survivedCount: 0,
        generation: "old",
    })
    state.prune.messages.activeBlockIds.add(oldBlockId)
    state.prune.messages.activeByAnchorMessageId.set("u1", oldBlockId)
    state.prune.messages.byMessageId.set("u1", {
        tokenCount: 200, allBlockIds: [oldBlockId], activeBlockIds: [oldBlockId],
    })

    // New block that consumes the old one
    const newBlockId = 2
    state.prune.messages.blocksById.set(newBlockId, {
        blockId: newBlockId,
        runId: 2,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 1000,
        summaryTokens: 100,
        durationMs: 0,
        mode: "message",
        topic: "new",
        batchTopic: "new",
        startId: "m00003",
        endId: "m00004",
        anchorMessageId: "u3",
        compressMessageId: "msg-comp2",
        compressCallId: "call-comp2",
        includedBlockIds: [],
        consumedBlockIds: [oldBlockId],
        parentBlockIds: [],
        directMessageIds: ["u2"],
        directToolIds: [],
        effectiveMessageIds: ["u2"],
        effectiveToolIds: [],
        createdAt: Date.now() - 1000,
        summary: "New summary covering old content",
        survivedCount: 0,
        generation: "young",
    })
    state.prune.messages.activeBlockIds.add(newBlockId)
    state.prune.messages.activeByAnchorMessageId.set("u3", newBlockId)
    state.prune.messages.byMessageId.set("u2", {
        tokenCount: 300, allBlockIds: [newBlockId], activeBlockIds: [newBlockId],
    })

    const output = {
        messages: [
            makeUserMessage("u1", "Hello"),
            makeAssistantMessage("a1", "Hi"),
            makeUserMessage("u2", "Next"),
            makeAssistantMessage("a2", "Response"),
            makeUserMessage("u3", "More"),
            makeAssistantMessage("a3", "Done"),
        ],
    }

    await handler({}, output)

    assert.equal(
        state.prune.messages.blocksById.get(oldBlockId)?.active,
        false,
        "old block should be deactivated because it's consumed by the new block",
    )
    assert.equal(
        state.prune.messages.blocksById.get(newBlockId)?.active,
        true,
        "new block should remain active",
    )
})

// ─── Test: Multiple pipeline runs accumulate IDs correctly ──────────────────

test("ID accumulation: sequential runs never produce duplicate refs", async () => {
    const { state, handler } = setupPipeline()

    for (let round = 0; round < 5; round++) {
        const prefix = `r${round}_`
        const output = {
            messages: [
                makeUserMessage(`${prefix}u1`, `Round ${round} question`),
                makeAssistantMessage(`${prefix}a1`, `Round ${round} answer`),
            ],
        }
        await handler({}, output)
    }

    const allRefs = Array.from(state.messageIds.byRawId.values())
    assert.equal(allRefs.length, 10, "should have 10 message refs (5 rounds × 2)")
    assert.equal(new Set(allRefs).size, 10, "all refs should be unique")

    assert.equal(state.messageIds.nextRef, 11)
    assert.equal(state.messageIds.byRawId.get("r4_u1"), "m00009")
    assert.equal(state.messageIds.byRawId.get("r4_a1"), "m00010")
})

// ─── Test: Mixed valid and invalid messages ─────────────────────────────────

test("mixed messages: only valid messages survive, IDs assigned to survivors", async () => {
    const { state, handler } = setupPipeline()

    const output = {
        messages: [
            makeUserMessage("u1", "Valid"),
            { role: "user", parts: [] } as any,
            makeAssistantMessage("a1", "Valid response"),
            { garbage: true } as any,
            makeUserMessage("u2", "Also valid"),
        ],
    }

    await handler({}, output)

    assert.equal(output.messages.length, 4, "3 valid messages + 1 suffix message")
    const ids = output.messages.filter((m: WithParts) => !isSyntheticMessage(m)).map((m: WithParts) => m.info.id)
    assert.deepEqual(ids, ["u1", "a1", "u2"])

    assert.equal(state.messageIds.byRawId.get("u1"), "m00001")
    assert.equal(state.messageIds.byRawId.get("a1"), "m00002")
    assert.equal(state.messageIds.byRawId.get("u2"), "m00003")
})
