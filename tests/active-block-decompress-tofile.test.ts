import assert from "node:assert/strict"
import test from "node:test"
import os from "node:os"
import path from "node:path"
import { readFileSync, unlinkSync } from "node:fs"
import { createDecompressTool } from "../lib/compress/decompress"
import type { ToolFactoryContext } from "../lib/compress/types"
import { singletonRegistry } from "./registry-stub"
import type {
    CompressionBlock,
    PrunedMessageEntry,
    SessionState,
    WithParts,
} from "../lib/state/types"
import { getToolDescriptions } from "../lib/prompts/packs"

// Factories read their tool description from the prompt store at creation time; pin the
// mock to the default pack so description assertions test the shipped default surface.
function makeDefaultPromptsMock() {
    const descriptions = getToolDescriptions("default")
    return {
        reload() {},
        getRuntimePrompts() {
            return {
                decompressDescription: descriptions.decompress,
                searchContextDescription: descriptions.searchContext,
                acpStatusDescription: descriptions.acpStatus,
                acpContextRecapDescription: descriptions.acpContextRecap,
            }
        },
    }
}

const SID = "session-active-decompress-tofile"

// Appears ONLY in original content, never in the summary — so its presence in
// the exported file proves RAW export happened (a summary fallback would lack it).
const SENTINEL = "ORIGINAL DETAIL 42"

const SUMMARY_TEXT = "Compact summary of the exchange about topic X."

function makeBlock(overrides: Partial<CompressionBlock> = {}): CompressionBlock {
    return {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 1000,
        summaryTokens: 200,
        durationMs: 0,
        mode: "range",
        topic: "test",
        batchTopic: "test",
        startId: "m00001",
        endId: "m00002",
        anchorMessageId: "anchor-1",
        compressMessageId: "comp-1",
        compressCallId: undefined,
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: ["msg-a", "msg-b"],
        directToolIds: [],
        effectiveMessageIds: ["msg-a", "msg-b"],
        effectiveToolIds: [],
        createdAt: 1000,
        deactivatedAt: undefined,
        deactivatedByBlockId: undefined,
        summary: SUMMARY_TEXT,
        survivedCount: 0,
        generation: "young",
        ...overrides,
    }
}

function makeState(blocks: CompressionBlock[], activeIds: number[]): SessionState {
    const blocksById = new Map<number, CompressionBlock>()
    for (const b of blocks) {
        blocksById.set(b.blockId, b)
    }
    return {
        sessionId: SID,
        isSubAgent: false,
        compressPermission: "allow",
        qualityGateRetryPending: false,
        prune: {
            tools: new Map(),
            messages: {
                byMessageId: new Map<string, PrunedMessageEntry>(),
                blocksById,
                activeBlockIds: new Set<number>(activeIds),
                activeByAnchorMessageId: new Map(),
                nextBlockId: blocks.length + 1,
                nextRunId: blocks.length + 1,
                markedForCleanup: new Set<number>(),
            },
        },
        nudges: {
            contextLimitAnchors: new Set(),
            turnNudgeAnchors: new Set(),
            iterationNudgeAnchors: new Set(),
            lastPerMessageNudgeTurn: 0,
            lastPerMessageNudgeTokens: undefined,
        },
        stats: { pruneTokenCounter: 0, totalPruneTokens: 0 },
        compressionTiming: {} as any,
        toolParameters: new Map(),
        subAgentResultCache: new Map(),
        toolIdList: [],
        messageIds: { byRawId: new Map(), byRef: new Map(), nextRef: 1 },
        lastCompaction: 0,
        currentTurn: 0,
        modelContextLimit: 100000,
        systemPromptTokens: undefined,
    }
}

/** Build a real SDK-shaped WithParts record ({ info, parts }). */
function makeMessage(id: string, role: string, parts: Record<string, unknown>[]): WithParts {
    return {
        info: { id, role, sessionID: SID, time: { created: 1 } } as WithParts["info"],
        parts: parts as WithParts["parts"],
    }
}

// Real SDK-shaped history for an ACTIVE block whose originals are retrievable.
// msg-a: a user text part carrying the sentinel.
// msg-b: an assistant message mixing a text part and a tool part (also carrying
// the sentinel in its completed output) — exercises mixed text/tool serialization.
function buildHistory(): WithParts[] {
    return [
        makeMessage("msg-a", "user", [
            {
                id: "part-a1",
                messageID: "msg-a",
                sessionID: SID,
                type: "text",
                text: `Please investigate ${SENTINEL} for me.`,
            },
        ]),
        makeMessage("msg-b", "assistant", [
            {
                id: "part-b1",
                messageID: "msg-b",
                sessionID: SID,
                type: "text",
                text: "Running the probe now.",
            },
            {
                id: "part-b2",
                messageID: "msg-b",
                sessionID: SID,
                type: "tool",
                tool: "bash",
                state: {
                    status: "completed",
                    input: { command: "ls" },
                    output: `probe output: ${SENTINEL} found`,
                },
            },
        ]),
    ]
}

function makeToolContext(state: SessionState, history: WithParts[]): ToolFactoryContext {
    const noop = () => {}
    return {
        client: {
            session: {
                messages: async () => ({ data: history }),
            },
        } as any,
        registry: singletonRegistry(state),
        logger: {
            enabled: false,
            info: noop,
            warn: noop,
            error: noop,
            debug: noop,
        } as any,
        config: {} as any,
        prompts: makeDefaultPromptsMock() as any,
    }
}

function makeRunContext(): { ask: any; metadata: any; sessionID: string } {
    return {
        ask: async () => {},
        metadata: () => {},
        sessionID: SID,
    }
}

async function runDecompress(
    state: SessionState,
    history: WithParts[],
    args: Record<string, unknown>,
): Promise<string> {
    const ctx = makeToolContext(state, history)
    const tool = createDecompressTool(ctx)
    return tool.execute(args as any, makeRunContext() as any)
}

// --- E2E: toFile on an ACTIVE block with retrievable originals writes RAW content ---

test("E2E: toFile on active block exports original text (not summary) with mixed text/tool parts", async () => {
    const target = path.join(os.tmpdir(), `acp-tofile-active-${Date.now()}.txt`)
    try {
        const activeBlock = makeBlock({ blockId: 7 })
        const state = makeState([activeBlock], [7])
        const history = buildHistory()

        const result = await runDecompress(state, history, {
            blockId: "b7",
            toFile: target,
        })

        // No error; raw-export path taken (not the summary fallback).
        assert.ok(!result.includes("Error"), `should not error: ${result}`)
        assert.match(result, /written to/)
        assert.match(result, /original message/)
        assert.ok(
            !result.includes("no original messages found"),
            `should export originals, not fall back: ${result}`,
        )

        const fileContent = readFileSync(target, "utf-8")

        // The original-only sentinel must be present (proves RAW export happened,
        // since the summary does not contain it).
        assert.ok(fileContent.includes(SENTINEL), `file should include sentinel:\n${fileContent}`)

        // Roles + mixed text/tool parts serialized from info.role and parts[].
        assert.ok(
            fileContent.includes("[user]"),
            `file should include [user] role:\n${fileContent}`,
        )
        assert.ok(
            fileContent.includes("[assistant]"),
            `file should include [assistant] role:\n${fileContent}`,
        )

        // Mixed text/tool coverage: the tool part is labeled and its output preserved.
        assert.ok(
            fileContent.includes("[bash]"),
            `file should include labeled tool part:\n${fileContent}`,
        )
        assert.ok(
            fileContent.includes("probe output: ORIGINAL DETAIL 42 found"),
            `file should include tool output:\n${fileContent}`,
        )

        // It must NOT be the summary fallback.
        assert.ok(
            !fileContent.includes(SUMMARY_TEXT),
            `file should NOT contain the summary (that would be the fallback):\n${fileContent}`,
        )

        // Block stays compressed — state unchanged.
        assert.equal(state.prune.messages.blocksById.get(7)?.active, true)
    } finally {
        try {
            unlinkSync(target)
        } catch {
            /* ignore cleanup errors */
        }
    }
})

// --- E2E: toFile distinguishes a TRUE missing-original fallback ---

test("E2E: toFile falls back to summary only when originals are genuinely absent", async () => {
    const target = path.join(os.tmpdir(), `acp-tofile-missing-${Date.now()}.txt`)
    try {
        // Active block referencing a message id that is NOT present in the fetched
        // history (e.g. its originals were deleted externally). History contains a
        // different, unrelated message so we know fetch succeeded but didn't match.
        const activeBlock = makeBlock({
            blockId: 9,
            effectiveMessageIds: ["ghost-msg-not-in-history"],
            directMessageIds: ["ghost-msg-not-in-history"],
        })
        const state = makeState([activeBlock], [9])

        const unrelatedHistory = [
            makeMessage("unrelated-msg", "user", [
                {
                    id: "part-u1",
                    messageID: "unrelated-msg",
                    sessionID: SID,
                    type: "text",
                    text: "Some unrelated visible message.",
                },
            ]),
        ]

        const result = await runDecompress(state, unrelatedHistory, {
            blockId: "b9",
            toFile: target,
        })

        assert.ok(!result.includes("Error"), `should not error: ${result}`)
        assert.match(result, /written to/)
        assert.match(result, /no original messages found/)
        assert.match(result, /wrote block summary/)

        const fileContent = readFileSync(target, "utf-8")
        // True fallback: exactly the stored summary, no raw content leaked in.
        assert.equal(fileContent, SUMMARY_TEXT)
        assert.ok(!fileContent.includes("Some unrelated visible message"))
    } finally {
        try {
            unlinkSync(target)
        } catch {
            /* ignore cleanup errors */
        }
    }
})
