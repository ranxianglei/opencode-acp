import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdirSync } from "node:fs"
import { createCompressRangeTool } from "../lib/compress/range"
import { createCompressMessageTool } from "../lib/compress/message"
import { createSessionState, type WithParts } from "../lib/state"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"
import {
    messageContainsProtectedTool,
    filterProtectedToolMessages,
} from "../lib/compress/protected-content"
import type { SearchContext, SelectionResolution } from "../lib/compress/types"

const testDataHome = join(tmpdir(), `opencode-dcp-tests-${process.pid}`)
const testConfigHome = join(tmpdir(), `opencode-dcp-config-tests-${process.pid}`)

process.env.XDG_DATA_HOME = testDataHome
process.env.XDG_CONFIG_HOME = testConfigHome

mkdirSync(testDataHome, { recursive: true })
mkdirSync(testConfigHome, { recursive: true })

function buildConfig(overrides: Partial<PluginConfig> = {}): PluginConfig {
    return {
        enabled: true,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: {
            enabled: true,
            protectedTools: [],
        },
        manualMode: {
            enabled: false,
            automaticStrategies: true,
        },
        turnProtection: {
            enabled: false,
            turns: 4,
        },
        experimental: {
            allowSubAgents: true,
            customPrompts: false,
        },
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
            protectedTools: ["task", "skill", "todowrite", "todoread"],
            protectTags: false,
            protectUserMessages: false,
            protectImportantUserMessages: false,
        },
        strategies: {
            deduplication: {
                enabled: true,
                protectedTools: [],
            },
            purgeErrors: {
                enabled: true,
                turns: 4,
                protectedTools: [],
            },
        },
        gc: {
            algorithm: "truncate",
            promotionThreshold: 5,
            maxBlockAge: 15,
            maxOldGenSummaryLength: 3000,
            majorGcThresholdPercent: "100%",
            batchCleanup: { lowThreshold: "60%", highThreshold: "75%", forceThreshold: "90%" },
        },
        ...overrides,
    }
}

function textPart(messageID: string, sessionID: string, id: string, text: string) {
    return {
        id,
        messageID,
        sessionID,
        type: "text" as const,
        text,
    }
}

function toolPart(
    messageID: string,
    sessionID: string,
    callID: string,
    tool: string,
    output: string,
) {
    return {
        id: `${callID}-part`,
        messageID,
        sessionID,
        type: "tool" as const,
        tool,
        callID,
        state: {
            status: "completed" as const,
            input: { description: "demo" },
            output,
        },
    }
}

function buildMessagesWithSkill(sessionID: string): WithParts[] {
    return [
        {
            info: {
                id: "msg-user-1",
                role: "user",
                sessionID,
                agent: "codebase-analyzer",
                model: {
                    providerID: "anthropic",
                    modelID: "claude-test",
                },
                time: { created: 1 },
            } as WithParts["info"],
            parts: [textPart("msg-user-1", sessionID, "part-1", "Load the playwright skill")],
        },
        {
            info: {
                id: "msg-assistant-1",
                role: "assistant",
                sessionID,
                agent: "codebase-analyzer",
                time: { created: 2 },
            } as WithParts["info"],
            parts: [textPart("msg-assistant-1", sessionID, "part-2", "Loading skill now")],
        },
        {
            info: {
                id: "msg-skill-output",
                role: "assistant",
                sessionID,
                agent: "codebase-analyzer",
                time: { created: 3 },
            } as WithParts["info"],
            parts: [
                textPart("msg-skill-output", sessionID, "part-3a", "Calling skill tool"),
                toolPart(
                    "msg-skill-output",
                    sessionID,
                    "call-skill-1",
                    "skill",
                    "Playwright skill loaded. Use this for browser automation.",
                ),
            ],
        },
        {
            info: {
                id: "msg-assistant-2",
                role: "assistant",
                sessionID,
                agent: "codebase-analyzer",
                time: { created: 4 },
            } as WithParts["info"],
            parts: [
                textPart("msg-assistant-2", sessionID, "part-4", "Skill is now active. Let's proceed."),
            ],
        },
        {
            info: {
                id: "msg-user-2",
                role: "user",
                sessionID,
                agent: "codebase-analyzer",
                model: {
                    providerID: "anthropic",
                    modelID: "claude-test",
                },
                time: { created: 5 },
            } as WithParts["info"],
            parts: [textPart("msg-user-2", sessionID, "part-5", "Navigate to example.com")],
        },
    ]
}

function buildRangeToolCtx(config: PluginConfig, rawMessages: WithParts[], state: ReturnType<typeof createSessionState>, sessionID: string) {
    const logger = new Logger(false)
    return createCompressRangeTool({
        client: {
            session: {
                messages: async () => ({ data: rawMessages }),
                get: async () => ({ data: { parentID: null } }),
            },
        },
        state,
        logger,
        config,
        prompts: {
            reload() {},
            getRuntimePrompts() {
                return { compressRange: "", compressMessage: "" }
            },
        },
    } as any)
}

function buildMessageToolCtx(config: PluginConfig, rawMessages: WithParts[], state: ReturnType<typeof createSessionState>, sessionID: string) {
    const logger = new Logger(false)
    return createCompressMessageTool({
        client: {
            session: {
                messages: async () => ({ data: rawMessages }),
                get: async () => ({ data: { parentID: null } }),
            },
        },
        state,
        logger,
        config,
        prompts: {
            reload() {},
            getRuntimePrompts() {
                return { compressRange: "", compressMessage: "" }
            },
        },
    } as any)
}

function mockToolCtx(sessionID: string) {
    return {
        ask: async () => {},
        metadata: () => {},
        sessionID,
        messageID: "msg-compress",
    }
}

test("messageContainsProtectedTool detects skill tool output", () => {
    const msg: WithParts = {
        info: {
            id: "msg-1",
            role: "assistant",
            sessionID: "ses-1",
            time: { created: 1 },
        } as WithParts["info"],
        parts: [
            textPart("msg-1", "ses-1", "p-1", "text before"),
            toolPart("msg-1", "ses-1", "call-1", "skill", "skill output"),
        ],
    }

    assert.equal(
        messageContainsProtectedTool(msg, ["task", "skill", "todowrite"]),
        true,
        "skill tool should be detected as protected",
    )
})

test("messageContainsProtectedTool returns false for non-protected tools", () => {
    const msg: WithParts = {
        info: {
            id: "msg-1",
            role: "assistant",
            sessionID: "ses-1",
            time: { created: 1 },
        } as WithParts["info"],
        parts: [
            toolPart("msg-1", "ses-1", "call-1", "bash", "command output"),
        ],
    }

    assert.equal(
        messageContainsProtectedTool(msg, ["task", "skill", "todowrite"]),
        false,
        "bash tool should not be detected as protected",
    )
})

test("messageContainsProtectedTool returns false for plain text messages", () => {
    const msg: WithParts = {
        info: {
            id: "msg-1",
            role: "user",
            sessionID: "ses-1",
            time: { created: 1 },
        } as WithParts["info"],
        parts: [textPart("msg-1", "ses-1", "p-1", "just a text message")],
    }

    assert.equal(
        messageContainsProtectedTool(msg, ["task", "skill"]),
        false,
        "text-only message should not be detected as protected",
    )
})

test("messageContainsProtectedTool detects protected file patterns", () => {
    const msg: WithParts = {
        info: {
            id: "msg-1",
            role: "assistant",
            sessionID: "ses-1",
            time: { created: 1 },
        } as WithParts["info"],
        parts: [
            {
                id: "call-write-1-part",
                messageID: "msg-1",
                sessionID: "ses-1",
                type: "tool" as const,
                tool: "write",
                callID: "call-write-1",
                state: {
                    status: "completed" as const,
                    input: { filePath: "/home/user/secrets/.env" },
                    output: "wrote file",
                },
            },
        ],
    }

    assert.equal(
        messageContainsProtectedTool(msg, [], ["/home/user/secrets/**"]),
        true,
        "write tool matching protected file pattern should be detected",
    )
})

test("filterProtectedToolMessages removes protected tool messages from selection", () => {
    const msgSkill: WithParts = {
        info: {
            id: "msg-skill",
            role: "assistant",
            sessionID: "ses-1",
            time: { created: 1 },
        } as WithParts["info"],
        parts: [toolPart("msg-skill", "ses-1", "call-skill", "skill", "skill output")],
    }
    const msgPlain: WithParts = {
        info: {
            id: "msg-plain",
            role: "user",
            sessionID: "ses-1",
            time: { created: 2 },
        } as WithParts["info"],
        parts: [textPart("msg-plain", "ses-1", "p-plain", "hello")],
    }

    const selection: SelectionResolution = {
        startReference: { kind: "message-ref", value: "m00001" },
        endReference: { kind: "message-ref", value: "m00002" },
        messageIds: ["msg-skill", "msg-plain"],
        messageTokenById: new Map([
            ["msg-skill", 100],
            ["msg-plain", 50],
        ]),
        toolIds: ["call-skill"],
        requiredBlockIds: [],
    }

    const searchContext: SearchContext = {
        rawMessages: [msgSkill, msgPlain],
        rawMessagesById: new Map([
            ["msg-skill", msgSkill],
            ["msg-plain", msgPlain],
        ]),
        rawIndexById: new Map(),
        summaryByBlockId: new Map(),
    }

    const filtered = filterProtectedToolMessages(
        selection,
        searchContext,
        ["skill"],
        [],
    )

    assert.deepEqual(filtered.messageIds, ["msg-plain"])
    assert.equal(filtered.messageTokenById.has("msg-skill"), false)
    assert.equal(filtered.messageTokenById.has("msg-plain"), true)
    assert.deepEqual(filtered.toolIds, [])
})

test("filterProtectedToolMessages returns original selection when nothing to filter", () => {
    const msgPlain: WithParts = {
        info: {
            id: "msg-plain",
            role: "user",
            sessionID: "ses-1",
            time: { created: 2 },
        } as WithParts["info"],
        parts: [textPart("msg-plain", "ses-1", "p-plain", "hello")],
    }

    const selection: SelectionResolution = {
        startReference: { kind: "message-ref", value: "m00001" },
        endReference: { kind: "message-ref", value: "m00001" },
        messageIds: ["msg-plain"],
        messageTokenById: new Map([["msg-plain", 50]]),
        toolIds: [],
        requiredBlockIds: [],
    }

    const searchContext: SearchContext = {
        rawMessages: [msgPlain],
        rawMessagesById: new Map([["msg-plain", msgPlain]]),
        rawIndexById: new Map(),
        summaryByBlockId: new Map(),
    }

    const filtered = filterProtectedToolMessages(selection, searchContext, ["skill"], [])

    assert.equal(filtered, selection, "should return the same object reference when nothing filtered")
})

test("range mode excludes skill message from compression range but compresses the rest", async () => {
    const sessionID = `ses_skill_range_${Date.now()}`
    const rawMessages = buildMessagesWithSkill(sessionID)
    const state = createSessionState()
    const tool = buildRangeToolCtx(buildConfig(), rawMessages, state, sessionID)

    const result = await tool.execute(
        {
            topic: "Skill exclusion test",
            content: [
                {
                    startId: "m00001",
                    endId: "m00005",
                    summary: "Compress everything except the skill output.",
                },
            ],
        },
        mockToolCtx(sessionID),
    )

    assert.match(result, /Compressed/)

    const blocks = [...state.prune.messages.blocksById.values()]
    assert.equal(blocks.length, 1, "should create exactly one block")

    const block = blocks[0]
    assert.ok(
        !block.directMessageIds.includes("msg-skill-output"),
        "skill output message must NOT be in the compressed block",
    )
    assert.ok(
        !block.effectiveMessageIds.includes("msg-skill-output"),
        "skill output message must NOT be in effective message ids",
    )
    assert.ok(
        block.directMessageIds.includes("msg-user-1"),
        "non-protected messages should still be compressed",
    )
    assert.ok(
        block.directMessageIds.includes("msg-user-2"),
        "non-protected messages at the end should still be compressed",
    )
    assert.ok(
        block.directMessageIds.includes("msg-assistant-1"),
        "assistant messages should be compressed",
    )
})

test("range mode throws when ALL messages in range contain protected tools", async () => {
    const sessionID = `ses_skill_all_protected_${Date.now()}`
    const rawMessages: WithParts[] = [
        {
            info: {
                id: "msg-skill-only",
                role: "assistant",
                sessionID,
                agent: "codebase-analyzer",
                time: { created: 1 },
            } as WithParts["info"],
            parts: [
                textPart("msg-skill-only", sessionID, "p-1", "Loading skill"),
                toolPart("msg-skill-only", sessionID, "call-skill-1", "skill", "skill content"),
            ],
        },
    ]
    const state = createSessionState()
    const tool = buildRangeToolCtx(buildConfig(), rawMessages, state, sessionID)

    await assert.rejects(
        tool.execute(
            {
                topic: "All protected",
                content: [
                    {
                        startId: "m00001",
                        endId: "m00001",
                        summary: "This should fail because the only message is protected.",
                    },
                ],
            },
            mockToolCtx(sessionID),
        ),
        /All selected messages contain protected tool outputs/,
    )

    assert.equal(
        state.prune.messages.blocksById.size,
        0,
        "no blocks should be created when all messages are protected",
    )
})

test("range mode handles skill message in the middle of a range", async () => {
    const sessionID = `ses_skill_middle_${Date.now()}`
    const rawMessages = buildMessagesWithSkill(sessionID)
    const state = createSessionState()
    const tool = buildRangeToolCtx(buildConfig(), rawMessages, state, sessionID)

    const result = await tool.execute(
        {
            topic: "Middle skill test",
            content: [
                {
                    startId: "m00002",
                    endId: "m00004",
                    summary: "Compress around the skill message.",
                },
            ],
        },
        mockToolCtx(sessionID),
    )

    assert.match(result, /Compressed/)

    const blocks = [...state.prune.messages.blocksById.values()]
    assert.equal(blocks.length, 1)

    const block = blocks[0]
    assert.ok(
        !block.directMessageIds.includes("msg-skill-output"),
        "skill output (m00003) must be excluded",
    )
    assert.ok(
        block.directMessageIds.includes("msg-assistant-1"),
        "msg-assistant-1 (m00002) should be compressed",
    )
    assert.ok(
        block.directMessageIds.includes("msg-assistant-2"),
        "msg-assistant-2 (m00004) should be compressed",
    )
})

test("message mode skips protected tool message and reports issue", async () => {
    const sessionID = `ses_skill_message_skip_${Date.now()}`
    const config = buildConfig()
    config.compress.mode = "message"
    const rawMessages = buildMessagesWithSkill(sessionID)
    const state = createSessionState()
    const tool = buildMessageToolCtx(config, rawMessages, state, sessionID)

    await assert.rejects(
        tool.execute(
            {
                topic: "Message mode skill skip",
                content: [
                    {
                        topic: "Message mode skill skip",
                        messageId: "m00003",
                        summary: "Trying to compress the skill message directly.",
                    },
                ],
            },
            mockToolCtx(sessionID),
        ),
        /Unable to compress[\s\S]*protected tool output/,
    )

    assert.equal(
        state.prune.messages.blocksById.size,
        0,
        "no blocks should be created for skipped protected message",
    )
})

test("message mode compresses non-protected messages while skipping protected ones", async () => {
    const sessionID = `ses_skill_mixed_${Date.now()}`
    const config = buildConfig()
    config.compress.mode = "message"
    const rawMessages = buildMessagesWithSkill(sessionID)
    const state = createSessionState()
    const tool = buildMessageToolCtx(config, rawMessages, state, sessionID)

    const result = await tool.execute(
        {
            topic: "Mixed compress",
            content: [
                {
                    topic: "Mixed compress",
                    messageId: "m00002",
                    summary: "Compressing the assistant text message.",
                },
                {
                    topic: "Mixed compress",
                    messageId: "m00003",
                    summary: "Trying to compress the skill message (should be skipped).",
                },
            ],
        },
        mockToolCtx(sessionID),
    )

    assert.match(result, /Compressed 1 message/)
    assert.match(result, /Skipped 1 issue/i)
    assert.match(result, /protected tool output/i)

    const blocks = [...state.prune.messages.blocksById.values()]
    assert.equal(blocks.length, 1, "only one block for the non-protected message")
    assert.ok(
        blocks[0].directMessageIds.includes("msg-assistant-1"),
        "the compressed block should contain msg-assistant-1",
    )
})

test("range mode respects custom protectedTools config (empty list = no exclusion)", async () => {
    const sessionID = `ses_skill_no_protection_${Date.now()}`
    const config = buildConfig()
    config.compress.protectedTools = []
    const rawMessages = buildMessagesWithSkill(sessionID)
    const state = createSessionState()
    const tool = buildRangeToolCtx(config, rawMessages, state, sessionID)

    const result = await tool.execute(
        {
            topic: "No protection test",
            content: [
                {
                    startId: "m00001",
                    endId: "m00005",
                    summary: "With empty protectedTools, skill should be compressed normally.",
                },
            ],
        },
        mockToolCtx(sessionID),
    )

    assert.match(result, /Compressed/)

    const blocks = [...state.prune.messages.blocksById.values()]
    assert.equal(blocks.length, 1)
    assert.ok(
        blocks[0].directMessageIds.includes("msg-skill-output"),
        "with empty protectedTools, skill message IS compressed",
    )
})
