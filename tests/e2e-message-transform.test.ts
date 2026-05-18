/**
 * E2E tests for the full chat message transform pipeline.
 *
 * These tests exercise `createChatMessageTransformHandler` end-to-end,
 * calling it with realistic mock data and verifying that output messages
 * are transformed correctly through the sequential pipeline stages:
 *
 *   filterMessagesInPlace → checkSession → syncCompressPermission →
 *   stripHallucinations → cacheSystemPromptTokens → assignMessageRefs →
 *   syncCompressionBlocks → syncToolCache → buildToolIdList → runMajorGC →
 *   prune → assignMessageRefs (reassign) → injectExtendedSubAgentResults →
 *   buildPriorityMap → injectCompressNudges → injectMessageIds →
 *   applyPendingManualTrigger → stripStaleMetadata → logger.saveContext
 */

import assert from "node:assert/strict"
import test, { beforeEach } from "node:test"
import type { PluginConfig } from "../lib/config"
import { createChatMessageTransformHandler } from "../lib/hooks"
import { Logger } from "../lib/logger"
import { createSessionState, saveSessionState, type WithParts, type SessionState } from "../lib/state"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

// ─── Helpers ────────────────────────────────────────────────────────────────

const SID = "session-e2e-1"

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

let msgCounter = 0
function nextMsgId(): string {
    return `msg-e2e-${++msgCounter}`
}

function makeUserMessage(
    id: string,
    text: string,
    sessionId: string = SID,
): WithParts {
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
    sessionId: string = SID,
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
            tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
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
): any {
    return {
        type: "tool",
        tool,
        callID,
        id: `part-${callID}`,
        sessionID: SID,
        messageID: "msg-tool-host",
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

function setupPipeline(stateOverrides: Partial<SessionState> = {}) {
    const tempDir = mkdtempSync(join(tmpdir(), "acp-e2e-"))
    process.env.XDG_DATA_HOME = tempDir
    process.env.XDG_CONFIG_HOME = tempDir

    const state = createSessionState()
    state.sessionId = SID
    Object.assign(state, stateOverrides)

    const logger = new Logger(false)
    const config = buildConfig()
    const client = createMockClient()
    const prompts = createMockPrompts()
    const hostPermissions = { global: undefined, agents: {} }

    const handler = createChatMessageTransformHandler(
        client,
        state,
        logger,
        config,
        prompts,
        hostPermissions,
    )

    return { state, logger, config, handler, tempDir }
}

beforeEach(() => {
    msgCounter = 0
})

// ─── Test: Basic pipeline run ───────────────────────────────────────────────

test("basic pipeline: assigns message IDs and preserves all messages", async () => {
    const { state, handler } = setupPipeline()

    const messages: WithParts[] = [
        makeUserMessage("u1", "Hello"),
        makeAssistantMessage("a1", "Hi there"),
        makeUserMessage("u2", "How are you?"),
        makeAssistantMessage("a2", "I'm fine"),
        makeUserMessage("u3", "Good"),
    ]

    const output = { messages }

    await handler({}, output)

    // All 5 messages should survive the pipeline
    assert.equal(output.messages.length, 5)

    // Message IDs should be assigned
    assert.equal(state.messageIds.byRawId.get("u1"), "m0001")
    assert.equal(state.messageIds.byRawId.get("a1"), "m0002")
    assert.equal(state.messageIds.byRawId.get("u2"), "m0003")
    assert.equal(state.messageIds.byRawId.get("a2"), "m0004")
    assert.equal(state.messageIds.byRawId.get("u3"), "m0005")

    // Reverse mapping should exist
    assert.equal(state.messageIds.byRef.get("m0001"), "u1")
    assert.equal(state.messageIds.byRef.get("m0005"), "u3")
})

// ─── Test: Message IDs are stable across multiple pipeline runs ──────────────

test("message IDs remain stable across sequential pipeline calls", async () => {
    const { state, handler } = setupPipeline()

    // First call with 2 messages
    const output1 = {
        messages: [
            makeUserMessage("u1", "Hello"),
            makeAssistantMessage("a1", "Hi"),
        ],
    }
    await handler({}, output1)

    assert.equal(state.messageIds.byRawId.get("u1"), "m0001")
    assert.equal(state.messageIds.byRawId.get("a1"), "m0002")
    assert.equal(state.messageIds.nextRef, 3)

    // Second call adds new messages; existing IDs should remain stable
    const output2 = {
        messages: [
            makeUserMessage("u1", "Hello"),
            makeAssistantMessage("a1", "Hi"),
            makeUserMessage("u2", "How are you?"),
            makeAssistantMessage("a2", "I'm fine"),
        ],
    }
    await handler({}, output2)

    // Old IDs stable
    assert.equal(state.messageIds.byRawId.get("u1"), "m0001")
    assert.equal(state.messageIds.byRawId.get("a1"), "m0002")
    // New IDs assigned
    assert.equal(state.messageIds.byRawId.get("u2"), "m0003")
    assert.equal(state.messageIds.byRawId.get("a2"), "m0004")
    assert.equal(state.messageIds.nextRef, 5)
})

// ─── Test: Invalid messages are filtered out ────────────────────────────────

test("filterMessagesInPlace: removes messages without valid info", async () => {
    const { state, handler } = setupPipeline()

    const output = {
        messages: [
            { role: "user", parts: [{ type: "text", text: "no info" }] },  // no .info → filtered
            makeUserMessage("u1", "Valid"),
            makeAssistantMessage("a1", "Response"),
        ] as WithParts[],
    }

    await handler({}, output)

    // Only 2 valid messages survive
    assert.equal(output.messages.length, 2)
    assert.equal(output.messages[0].info.id, "u1")
    assert.equal(output.messages[1].info.id, "a1")
})

// ─── Test: Hallucinated tags are stripped ────────────────────────────────────

test("stripHallucinations: removes hallucinated DCP tags from message text", async () => {
    const { state, handler } = setupPipeline()

    const output = {
        messages: [
            makeAssistantMessage("a1", "Here is info <dcp>secret</dcp> and <dcp>more</dcp>"),
        ],
    }

    await handler({}, output)

    const textPart = output.messages[0].parts.find((p: any) => p.type === "text")
    assert.ok(textPart)
    const text = (textPart as any).text as string
    assert.ok(!text.includes("<dcp>"), "hallucinated <dcp> tags should be stripped")
    assert.ok(text.includes("Here is info"), "non-hallucinated text preserved")
})

// ─── Test: Compression blocks are synced and pruned ──────────────────────────

test("compression blocks: compressed messages are replaced with summaries", async () => {
    const { state, handler } = setupPipeline()

    // Pre-populate a compression block that covers messages u1-a1
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
        topic: "test topic",
        batchTopic: "test topic",
        startId: "m0001",
        endId: "m0002",
        anchorMessageId: "u2",  // summary injected at this anchor
        compressMessageId: "msg-compress",
        compressCallId: "call-compress",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: ["u1", "a1"],
        directToolIds: [],
        effectiveMessageIds: ["u1", "a1"],
        effectiveToolIds: [],
        createdAt: Date.now() - 1000,
        summary: "Previous conversation about greetings",
        survivedCount: 0,
        generation: "old",
    })
    state.prune.messages.activeBlockIds.add(blockId)
    state.prune.messages.activeByAnchorMessageId.set("u2", blockId)

    // Mark u1 and a1 as compressed by this block
    state.prune.messages.byMessageId.set("u1", {
        tokenCount: 200,
        allBlockIds: [blockId],
        activeBlockIds: [blockId],
    })
    state.prune.messages.byMessageId.set("a1", {
        tokenCount: 300,
        allBlockIds: [blockId],
        activeBlockIds: [blockId],
    })

    const output = {
        messages: [
            makeUserMessage("u1", "Hello"),
            makeAssistantMessage("a1", "Hi there"),
            makeUserMessage("u2", "How are you?"),
            makeAssistantMessage("a2", "I'm fine"),
        ],
    }

    await handler({}, output)

    // u1 and a1 should be pruned (replaced by summary block)
    // u2 gets the summary injected before it, then u2 and a2 remain
    const remainingIds = output.messages.map((m: any) => m.info.id)

    // The original u1 and a1 are gone (compressed)
    assert.ok(!remainingIds.includes("u1"), "u1 should be pruned")
    assert.ok(!remainingIds.includes("a1"), "a1 should be pruned")

    // u2 and a2 survive
    assert.ok(remainingIds.includes("u2"), "u2 should survive")
    assert.ok(remainingIds.includes("a2"), "a2 should survive")

    // There should be a synthetic summary message injected at u2's anchor
    const summaryMsg = output.messages.find(
        (m: any) => m.info.id?.startsWith("msg_dcp_summary_"),
    )
    assert.ok(summaryMsg, "a synthetic summary message should be injected")

    // Summary text should contain the compressed content
    const summaryText = summaryMsg!.parts
        .filter((p: any) => p.type === "text")
        .map((p: any) => p.text)
        .join("")
    assert.ok(summaryText.includes("Previous conversation about greetings"))
})

// ─── Test: Tool output pruning ───────────────────────────────────────────────

test("prune: pruned tool outputs are replaced with placeholder", async () => {
    const { state, handler } = setupPipeline()

    const callID = "call-read-1"
    state.prune.tools.set(callID, Date.now())

    const toolPart = makeToolPart(callID, "read", "completed", "Full file contents here...")
    toolPart.messageID = "a1"
    const output = {
        messages: [
            makeUserMessage("u1", "Read the file"),
            makeAssistantMessage("a1", "Here it is", [toolPart]),
        ],
    }

    await handler({}, output)

    const assistantMsg = output.messages.find((m: WithParts) => m.info.id === "a1")
    assert.ok(assistantMsg, "assistant message should survive")
    const tool = assistantMsg!.parts.find((p: any) => p.type === "tool")
    assert.ok(tool, "tool part should be present")
    const toolOutput = (tool as any).state.output as string
    assert.ok(
        toolOutput.startsWith("[Output removed to save context - information superseded or no longer needed]"),
        `tool output should be replaced, got: ${toolOutput}`,
    )
})

// ─── Test: Message IDs after pruning + reassignment ─────────────────────────

test("message IDs remain consistent after compression and pruning", async () => {
    const { state, handler } = setupPipeline()

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
        topic: "early chat",
        batchTopic: "early chat",
        startId: "m0001",
        endId: "m0002",
        anchorMessageId: "u3",
        compressMessageId: "msg-comp",
        compressCallId: "call-comp",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: ["u1", "a1"],
        directToolIds: [],
        effectiveMessageIds: ["u1", "a1"],
        effectiveToolIds: [],
        createdAt: Date.now() - 1000,
        summary: "Summary of early messages",
        survivedCount: 0,
        generation: "old",
    })
    state.prune.messages.activeBlockIds.add(blockId)
    state.prune.messages.activeByAnchorMessageId.set("u3", blockId)
    state.prune.messages.byMessageId.set("u1", {
        tokenCount: 200, allBlockIds: [blockId], activeBlockIds: [blockId],
    })
    state.prune.messages.byMessageId.set("a1", {
        tokenCount: 300, allBlockIds: [blockId], activeBlockIds: [blockId],
    })

    const output = {
        messages: [
            makeUserMessage("u1", "Hello"),
            makeAssistantMessage("a1", "Hi"),
            makeUserMessage("u2", "How are you?"),
            makeAssistantMessage("a2", "Good"),
            makeUserMessage("u3", "What's up?"),
            makeAssistantMessage("a3", "Nothing much"),
        ],
    }

    await handler({}, output)

    assert.ok(state.messageIds.byRawId.has("u2"), "u2 should have an ID")
    assert.ok(state.messageIds.byRawId.has("a2"), "a2 should have an ID")
    assert.ok(state.messageIds.byRawId.has("u3"), "u3 should have an ID")
    assert.ok(state.messageIds.byRawId.has("a3"), "a3 should have an ID")

    const allRefs = Array.from(state.messageIds.byRawId.values())
    assert.equal(new Set(allRefs).size, allRefs.length, "no duplicate message refs")

    const outputIds = output.messages.map((m: any) => m.info.id)
    assert.ok(!outputIds.includes("u1"), "u1 should be pruned from output")
    assert.ok(!outputIds.includes("a1"), "a1 should be pruned from output")
    assert.ok(outputIds.includes("u2"), "u2 should survive")
    assert.ok(outputIds.includes("a2"), "a2 should survive")
})

// ─── Test: Manual trigger applied to last user message ───────────────────────

test("manual trigger: pending prompt replaces last user message text", async () => {
    const { state, handler } = setupPipeline()

    // Set up pending manual trigger
    state.pendingManualTrigger = {
        sessionId: SID,
        prompt: "COMPRESS NOW: Focus on code changes",
    }
    state.manualMode = "compress-pending"

    const output = {
        messages: [
            makeUserMessage("u1", "Original user message"),
            makeAssistantMessage("a1", "Response"),
            makeUserMessage("u2", "Please compress the context"),
        ],
    }

    await handler({}, output)

    // The last user message text should be replaced with the pending prompt
    const lastUserMsg = output.messages.find(
        (m: any) => m.info.id === "u2" && m.info.role === "user",
    )
    assert.ok(lastUserMsg)
    const textPart = lastUserMsg!.parts.find((p: any) => p.type === "text" && !p.synthetic)
    assert.ok(textPart)
    assert.equal((textPart as any).text, "COMPRESS NOW: Focus on code changes")

    // Trigger should be consumed
    assert.equal(state.pendingManualTrigger, null)
})

// ─── Test: Sub-agent messages are skipped ────────────────────────────────────

test("sub-agent messages: pipeline returns early for sub-agent sessions", async () => {
    const { state, handler } = setupPipeline()
    state.isSubAgent = true
    // Note: config has experimental.allowSubAgents = false

    const output = {
        messages: [
            makeUserMessage("u1", "Hello"),
            makeAssistantMessage("a1", "Should not be processed"),
        ],
    }

    await handler({}, output)

    // Sub-agent early return: message IDs should NOT be assigned
    // (the pipeline returns after syncCompressPermissionState check)
    assert.equal(state.messageIds.byRawId.has("u1"), false)
    assert.equal(state.messageIds.byRawId.has("a1"), false)
})

// ─── Test: Deny permission still processes filterMessages + stripHallucinations ─

test("deny permission: still filters messages and strips hallucinations", async () => {
    const config = buildConfig()
    config.compress.permission = "deny"

    const state = createSessionState()
    state.sessionId = SID
    const logger = new Logger(false)
    const handler = createChatMessageTransformHandler(
        createMockClient(),
        state,
        logger,
        config,
        createMockPrompts(),
        { global: undefined, agents: {} },
    )

    const output = {
        messages: [
            makeAssistantMessage("a1", "Hello <dcp>secret</dcp> world"),
            { role: "user", parts: [] }, // invalid - no .info
        ] as WithParts[],
    }

    await handler({}, output)

    // Invalid message filtered out
    assert.equal(output.messages.length, 1)
    assert.equal(output.messages[0].info.id, "a1")

    // Hallucination stripped even with deny
    const textPart = output.messages[0].parts.find((p: any) => p.type === "text")
    assert.equal((textPart as any).text, "Hello  world")
})

// ─── Test: State persistence survives round-trip ─────────────────────────────

test("state persistence: session state survives save/load round-trip", async () => {
    const { state, tempDir } = setupPipeline()

    state.messageIds.byRawId.set("u1", "m0001")
    state.messageIds.byRawId.set("a1", "m0002")
    state.messageIds.byRef.set("m0001", "u1")
    state.messageIds.byRef.set("m0002", "a1")
    state.messageIds.nextRef = 3
    state.stats.totalPruneTokens = 5000

    const logger = new Logger(false)
    await saveSessionState(state, logger)

    const { loadSessionState } = await import("../lib/state/persistence")
    const loaded = await loadSessionState(SID, logger)

    assert.ok(loaded, "state file should be loadable")
    assert.equal(loaded!.messageIds?.byRawId?.["u1"], "m0001")
    assert.equal(loaded!.messageIds?.byRawId?.["a1"], "m0002")
    assert.equal(loaded!.messageIds?.nextRef, 3)
    assert.equal(loaded!.stats.totalPruneTokens, 5000)

    rmSync(tempDir, { recursive: true, force: true })
})
