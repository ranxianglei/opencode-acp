import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "fs"
import { homedir, tmpdir } from "os"
import path from "path"
import { createDecompressTool } from "../lib/compress/decompress"
import type { ToolFactoryContext } from "../lib/compress/types"
import { singletonRegistry } from "./registry-stub"
import type {
    CompressionBlock,
    PrunedMessageEntry,
    SessionState,
    WithParts,
} from "../lib/state/types"

// Integration coverage for the decompress toFile WRITE path (decompress.ts),
// which the unit suite (decompress-tofile-symlink.test.ts) cannot reach:
// early-return-on-rejection before open, O_NOFOLLOW open flags, 0o600 mode,
// and the resolved-path confirmation message. These tests exercise the REAL
// default allowed roots (os.tmpdir(), ~/.cache/opencode) end to end.

const SID = "session-tofile-e2e"

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
        endId: "m00003",
        anchorMessageId: "anchor-1",
        compressMessageId: "comp-1",
        compressCallId: undefined,
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: ["msg-a"],
        directToolIds: [],
        effectiveMessageIds: ["msg-a"],
        effectiveToolIds: [],
        createdAt: 1000,
        deactivatedAt: undefined,
        deactivatedByBlockId: undefined,
        summary: "E2E toFile restore payload.",
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

function makeToolContext(state: SessionState): ToolFactoryContext {
    const noop = () => {}
    return {
        client: {
            session: {
                messages: async () => ({ data: [] as WithParts[] }),
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
        prompts: { reload: () => {} } as any,
    }
}

async function runDecompress(args: Record<string, unknown>): Promise<string> {
    const state = makeState([makeBlock()], [1])
    const tool = createDecompressTool(makeToolContext(state))
    return tool.execute(
        args as any,
        { ask: async () => {}, metadata: () => {}, sessionID: SID } as any,
    )
}

test(
    "E2E: toFile rejects a symlink escape under the real default roots and writes nothing outside",
    async () => {
        // Both dirs live under os.tmpdir() (an allowed root); the link points at
        // the home directory, which is NOT an allowed root. If the guard regressed
        // to lexical-only validation, the write would land in $HOME.
        const base = mkdtempSync(path.join(tmpdir(), "acp-tofile-e2e-"))
        try {
            const outside = homedir()
            const escapeLink = path.join(base, "link-home")
            symlinkSync(outside, escapeLink, "dir")
            const evilTarget = path.join(escapeLink, "acp-tofile-e2e-evil.txt")

            const result = await runDecompress({ blockId: "b1", toFile: evilTarget })

            assert.equal(result.startsWith("Error"), true, `expected rejection, got: ${result}`)
            assert.match(result, /symlink/)
            assert.equal(existsSync(evilTarget), false, "guard must not create the escaped file")
        } finally {
            rmSync(base, { recursive: true, force: true })
            rmSync(path.join(homedir(), "acp-tofile-e2e-evil.txt"), { force: true })
        }
    },
    { timeout: 30000 },
)

test(
    "E2E: toFile writes to the resolved absolute path and reports it in the confirmation",
    async () => {
        const base = mkdtempSync(path.join(tmpdir(), "acp-tofile-e2e-"))
        const rawInput = path.join(base, ".", "restore.txt") // non-canonical input
        const expected = path.resolve(base, "restore.txt")
        try {
            const result = await runDecompress({ blockId: "b1", toFile: rawInput })

            assert.ok(!result.startsWith("Error"), `should not error: ${result}`)
            assert.match(result, /written to/)
            assert.ok(
                result.includes(expected),
                `confirmation must report the resolved path ${expected}, got: ${result}`,
            )
            const { readFileSync } = await import("fs")
            assert.equal(readFileSync(expected, "utf-8"), "E2E toFile restore payload.")
        } finally {
            rmSync(base, { recursive: true, force: true })
        }
    },
    { timeout: 30000 },
)
