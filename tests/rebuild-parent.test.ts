import "./test-env"
import assert from "node:assert/strict"
import test from "node:test"
import { recoverFromParentState } from "../lib/state/fork-transfer"
import { rebuildCompressionState } from "../lib/state/rebuild"
import { createSessionState } from "../lib/state/state"
import { saveSessionState, loadSessionState } from "../lib/state/persistence"
import { Logger } from "../lib/logger"
import type { PluginConfig } from "../lib/config"
import type { SessionState, WithParts } from "../lib/state/types"

const logger = new Logger(false)

const PARENT_ID = "parent-session-375"
const FORK_ID = "fork-session-375"

function buildConfig(): PluginConfig {
    const base: PluginConfig = {
        enabled: true,
        autoUpdate: true,
        debug: false,
        logLevel: "info",
        allowSubAgents: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: { enabled: true, protectedTools: [] },
        experimental: { customPrompts: false },
        protectedFilePatterns: [],
        compress: {
            permission: "allow",
            showCompression: false,
            summaryBuffer: true,
            maxContextLimit: 150000,
            minContextLimit: 50000,
            nudgeFrequency: 5,
            minNudgeContextPercent: 20,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: ["task"],
            protectTags: false,
            protectUserMessages: false,
            maxSummaryLengthHard: 10000,
            minCompressRange: 0,
            maxVisibleSegments: 3,
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
    return base
}

function makeUserMessage(id: string, text: string, created: number, sessionID: string): WithParts {
    return {
        info: {
            id,
            sessionID,
            role: "user",
            agent: "assistant",
            time: { created },
            model: { providerID: "test-provider", modelID: "test-model" },
        } as WithParts["info"],
        parts: [{ type: "text", text, id: `${id}-p1`, sessionID, messageID: id }],
    }
}

function makeAssistantMessage(
    id: string,
    parts: any[],
    created: number,
    sessionID: string,
): WithParts {
    return {
        info: {
            id,
            sessionID,
            role: "assistant",
            agent: "test",
            time: { created },
            parentID: "parent-1",
            modelID: "test-model",
            providerID: "test-provider",
            mode: "normal",
            path: { cwd: "/", root: "/" },
            summary: false,
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        } as WithParts["info"],
        parts,
    }
}

function makeTextPart(text: string): any {
    return { type: "text", text }
}

// A completed non-protected tool part. Its callID is what lands in a block's
// directToolIds/effectiveToolIds (see lib/compress/search.ts), so it lets the
// tests verify tool-id transfer (call ids are preserved verbatim across a fork).
function makeToolPart(callId: string): any {
    return { type: "tool", tool: "bash", callID: callId, state: { status: "completed" } }
}

function makeCompressPart(callId: string, input: any): any {
    return {
        type: "tool",
        tool: "compress",
        callID: callId,
        state: {
            status: "completed",
            input,
            output: "Compressed messages into [Compressed conversation section].",
        },
    }
}

// A completed compress part whose `state.input` has been stripped (the fork-copy
// scenario from issue #375). Replay cannot reconstruct a block from this.
function makeStrippedCompressPart(callId: string): any {
    return {
        type: "tool",
        tool: "compress",
        callID: callId,
        state: {
            status: "completed",
            output: "Compressed messages into [Compressed conversation section].",
        },
    }
}

const COMPRESS_INPUT = {
    topic: "Intro chat",
    content: [
        {
            startId: "m00001",
            endId: "m00004",
            summary: "User greeted and started a task.",
        },
    ],
}

// A second parent compression over a later range (m00006..m00008) used to verify
// that a block anchored OUTSIDE the fork's copied prefix is skipped.
const COMPRESS_INPUT_2 = {
    topic: "Later chat",
    content: [
        {
            startId: "m00006",
            endId: "m00008",
            summary: "Later conversation.",
        },
    ],
}

// Parent messages: 4 visible messages + 1 assistant message holding a completed
// compress part (with input) covering m00001..m00004.
function makeParentMessages(): WithParts[] {
    return [
        makeUserMessage("p1", "hello", 1000, PARENT_ID),
        makeAssistantMessage("p2", [makeTextPart("hi"), makeToolPart("tool-1")], 1001, PARENT_ID),
        makeUserMessage("p3", "do a task", 1002, PARENT_ID),
        makeAssistantMessage("p4", [makeTextPart("doing it")], 1003, PARENT_ID),
        makeAssistantMessage("p5", [makeCompressPart("call-1", COMPRESS_INPUT)], 1004, PARENT_ID),
    ]
}

// Fork messages: identical content / time.created / role, but NEW raw IDs (f*)
// and the compress input is STRIPPED.
function makeForkMessages(): WithParts[] {
    return [
        makeUserMessage("f1", "hello", 1000, FORK_ID),
        makeAssistantMessage("f2", [makeTextPart("hi"), makeToolPart("tool-1")], 1001, FORK_ID),
        makeUserMessage("f3", "do a task", 1002, FORK_ID),
        makeAssistantMessage("f4", [makeTextPart("doing it")], 1003, FORK_ID),
        makeAssistantMessage("f5", [makeStrippedCompressPart("call-1")], 1004, FORK_ID),
    ]
}

function makeClient(parentMessages: WithParts[]): any {
    return {
        session: {
            messages: async (_opts: any) => ({ data: parentMessages }),
        },
    }
}

// Build + persist a parent session whose state contains one active range block.
async function setupPersistedParent(
    overrides: { nudgeTokens?: number } = {},
): Promise<{ parentMessages: WithParts[]; blockCount: number }> {
    const parentState = createSessionState()
    parentState.sessionId = PARENT_ID
    parentState.isSubAgent = false
    if (overrides.nudgeTokens !== undefined) {
        parentState.nudges.lastPerMessageNudgeTokens = overrides.nudgeTokens
    }
    const parentMessages = makeParentMessages()
    const rebuilt = rebuildCompressionState(parentState, parentMessages, buildConfig(), logger)
    assert.equal(rebuilt, 1, "parent should rebuild exactly 1 block")
    await saveSessionState(parentState, logger)
    return { parentMessages, blockCount: parentState.prune.messages.blocksById.size }
}

function freshForkState(isSubAgent: boolean): SessionState {
    const state = createSessionState()
    state.sessionId = FORK_ID
    state.isSubAgent = isSubAgent
    return state
}

test("recovers blocks from parent state when fork compress inputs are stripped", async () => {
    const { parentMessages } = await setupPersistedParent()
    const client = makeClient(parentMessages)
    const forkState = freshForkState(false)

    const recovered = await recoverFromParentState(
        client,
        forkState,
        makeForkMessages(),
        PARENT_ID,
        logger,
    )

    assert.equal(recovered, 1, "should recover 1 active block")
    assert.equal(forkState.prune.messages.blocksById.size, 1)

    const block = forkState.prune.messages.blocksById.get(1)!
    assert.equal(block.active, true)
    assert.equal(block.anchorMessageId, "f1", "anchor should map to the fork raw ID")
    assert.equal(block.compressMessageId, "f5", "compress message should map to the fork raw ID")
    assert.deepEqual(block.effectiveMessageIds, ["f1", "f2", "f3", "f4"])
    // No ref shift here (isSubAgent=false): f1→m00001, f4→m00004, so the boundary
    // refs remap to the same values in the fork's ref space.
    assert.equal(block.startId, "m00001")
    assert.equal(block.endId, "m00004")
    // Summary text and tool-call ids (preserved verbatim, not message ids) survive.
    assert.ok(block.summary.includes("User greeted and started a task."))
    assert.ok(block.effectiveToolIds.includes("tool-1"), "tool call id should be preserved")

    for (const id of ["f1", "f2", "f3", "f4"]) {
        const entry = forkState.prune.messages.byMessageId.get(id)
        assert.ok(entry, `message ${id} should be in byMessageId`)
        assert.ok(entry!.activeBlockIds.includes(1), `message ${id} should have block 1 active`)
    }
    assert.ok(
        !forkState.prune.messages.byMessageId.has("f5"),
        "compress message should not be pruned",
    )
    assert.equal(forkState.prune.messages.activeByAnchorMessageId.get("f1"), 1)
})

test("recovers blocks correctly even when the fork is misclassified as a sub-agent (ref shift)", async () => {
    // A real fork has parentID set → isSubAgent=true → assignMessageRefs skips
    // the fork's first user message, shifting its refs by one relative to the
    // parent. The time.created-based mapping must still point blocks at the
    // correct fork raw IDs.
    const { parentMessages } = await setupPersistedParent()
    const client = makeClient(parentMessages)
    const forkState = freshForkState(true)

    const recovered = await recoverFromParentState(
        client,
        forkState,
        makeForkMessages(),
        PARENT_ID,
        logger,
    )

    assert.equal(recovered, 1, "should recover 1 active block despite the ref shift")
    const block = forkState.prune.messages.blocksById.get(1)!
    assert.equal(
        block.anchorMessageId,
        "f1",
        "anchor must still map to f1 (raw IDs are shift-robust)",
    )
    assert.equal(block.compressMessageId, "f5")
    assert.deepEqual(block.effectiveMessageIds, ["f1", "f2", "f3", "f4"])
    // endId remaps correctly: parent m00004 → p4 → f4, and f4 has fork ref m00003.
    assert.equal(block.endId, "m00003")
    // startId is best-effort: the start boundary is f1, the fork's first user
    // message, which `assignMessageRefs` skips (no ref). remapBoundaryRef keeps
    // the parent ref "m00001" — metadata only; pruning is byMessageId-based.
    assert.equal(block.startId, "m00001")
    for (const id of ["f1", "f2", "f3", "f4"]) {
        const entry = forkState.prune.messages.byMessageId.get(id)
        assert.ok(entry, `message ${id} should be in byMessageId`)
        assert.ok(entry!.activeBlockIds.includes(1))
    }
})

test("returns 0 and leaves state untouched when no parent state exists", async () => {
    // No parent state persisted → loadSessionState returns null → fallback.
    const client = makeClient(makeParentMessages())
    const forkState = freshForkState(false)

    const recovered = await recoverFromParentState(
        client,
        forkState,
        makeForkMessages(),
        "no-such-parent",
        logger,
    )

    assert.equal(recovered, 0)
    assert.equal(forkState.prune.messages.blocksById.size, 0)
    assert.equal(forkState.prune.messages.byMessageId.size, 0)
})

test("returns 0 when there is no shared prefix (sub-agent, not a fork copy)", async () => {
    await setupPersistedParent()
    // Sub-agent messages: same shape but different time.created → no positional
    // match with the parent's messages.
    const subAgentMessages: WithParts[] = [
        makeUserMessage("s1", "unrelated prompt", 9000, FORK_ID),
        makeAssistantMessage("s2", [makeTextPart("unrelated reply")], 9001, FORK_ID),
    ]
    const client = makeClient(makeParentMessages())
    const forkState = freshForkState(true)

    const recovered = await recoverFromParentState(
        client,
        forkState,
        subAgentMessages,
        PARENT_ID,
        logger,
    )

    assert.equal(recovered, 0, "no shared prefix → no transfer")
    assert.equal(forkState.prune.messages.blocksById.size, 0)
})

test("returns 0 when the parent state has no blocks", async () => {
    // Persist a parent state with an empty prune state (no compress happened).
    const parentState = createSessionState()
    parentState.sessionId = PARENT_ID
    parentState.isSubAgent = false
    await saveSessionState(parentState, logger)

    const client = makeClient(makeParentMessages())
    const forkState = freshForkState(false)

    const recovered = await recoverFromParentState(
        client,
        forkState,
        makeForkMessages(),
        PARENT_ID,
        logger,
    )

    assert.equal(recovered, 0)
    assert.equal(forkState.prune.messages.blocksById.size, 0)
})

test("does not inherit parent nudge state and does not mutate the parent", async () => {
    await setupPersistedParent({ nudgeTokens: 424242 })
    const client = makeClient(makeParentMessages())
    const forkState = freshForkState(false)

    await recoverFromParentState(client, forkState, makeForkMessages(), PARENT_ID, logger)

    // Fork nudge cadence must stay fresh (not copied from the parent).
    assert.equal(forkState.nudges.lastPerMessageNudgeTokens, undefined)
    assert.equal(forkState.nudges.lastNudgeShownTokens, undefined)

    // Parent state on disk is unchanged (still 1 block, nudge token preserved).
    const reloaded = await loadSessionState(PARENT_ID, logger)
    assert.ok(reloaded, "parent state should still be loadable")
    assert.equal(Object.keys(reloaded!.prune.messages!.blocksById).length, 1)
    assert.equal(reloaded!.nudges.lastPerMessageNudgeTokens, 424242)
})

test("transfers only blocks whose coverage lies within the shared prefix", async () => {
    // The parent compressed twice: block 1 over m00001..m00004 (anchor p1) and
    // block 2 over m00006..m00008 (anchor p6). The fork was created when the
    // parent had 5 messages, so it copies p1..p5 (f1..f5) plus one new message
    // (f6). The shared prefix is p1..p5, so block 1 is translatable but block 2
    // (anchored at p6, outside the prefix) must be skipped.
    const parentState = createSessionState()
    parentState.sessionId = PARENT_ID
    parentState.isSubAgent = false
    const parentMessages: WithParts[] = [
        makeUserMessage("p1", "hello", 1000, PARENT_ID),
        makeAssistantMessage("p2", [makeTextPart("hi")], 1001, PARENT_ID),
        makeUserMessage("p3", "do a task", 1002, PARENT_ID),
        makeAssistantMessage("p4", [makeTextPart("doing it")], 1003, PARENT_ID),
        makeAssistantMessage("p5", [makeCompressPart("call-1", COMPRESS_INPUT)], 1004, PARENT_ID),
        makeUserMessage("p6", "more", 1005, PARENT_ID),
        makeAssistantMessage("p7", [makeTextPart("ok")], 1006, PARENT_ID),
        makeUserMessage("p8", "done", 1007, PARENT_ID),
        makeAssistantMessage("p9", [makeCompressPart("call-2", COMPRESS_INPUT_2)], 1008, PARENT_ID),
    ]
    const rebuilt = rebuildCompressionState(parentState, parentMessages, buildConfig(), logger)
    assert.equal(rebuilt, 2, "parent should rebuild both blocks")
    await saveSessionState(parentState, logger)

    const forkMessages: WithParts[] = [
        makeUserMessage("f1", "hello", 1000, FORK_ID),
        makeAssistantMessage("f2", [makeTextPart("hi")], 1001, FORK_ID),
        makeUserMessage("f3", "do a task", 1002, FORK_ID),
        makeAssistantMessage("f4", [makeTextPart("doing it")], 1003, FORK_ID),
        makeAssistantMessage("f5", [makeStrippedCompressPart("call-1")], 1004, FORK_ID),
        makeUserMessage("f6", "new fork turn", 2000, FORK_ID),
    ]
    const client = makeClient(parentMessages)
    const forkState = freshForkState(false)

    const recovered = await recoverFromParentState(
        client,
        forkState,
        forkMessages,
        PARENT_ID,
        logger,
    )

    // Only block 1 is within the shared prefix; block 2 (anchor p6) is skipped.
    assert.equal(recovered, 1)
    assert.equal(forkState.prune.messages.blocksById.size, 1)
    const block = forkState.prune.messages.blocksById.get(1)!
    assert.deepEqual(block.effectiveMessageIds, ["f1", "f2", "f3", "f4"])
    assert.ok(forkState.prune.messages.byMessageId.has("f1"))
    assert.ok(
        !forkState.prune.messages.byMessageId.has("f6"),
        "post-fork message must not be pruned",
    )
})
