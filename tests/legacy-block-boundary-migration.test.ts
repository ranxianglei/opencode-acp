import "./test-env"
import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { migrateMessageRef } from "../lib/message-ids"
import { hideConsumedCompressCalls } from "../lib/compress/hide-consumed"
import { loadPruneMessagesState, serializePruneMessagesState } from "../lib/state/utils"
import { rebuildCompressionState, restoreForkCompressionState } from "../lib/state/rebuild"
import { createSessionState, ensureSessionInitialized } from "../lib/state/state"
import {
    getDefaultStorageDir,
    loadSessionState,
    saveSessionState,
    type PersistedSessionState,
} from "../lib/state/persistence"
import { Logger } from "../lib/logger"
import type { PluginConfig } from "../lib/config"
import type { SessionState, WithParts } from "../lib/state/types"

/**
 * Issue #415 (item R4): legacy (pre-1.1.0) persisted states carry 4-digit
 * message refs (m0001). At load time the messageIds ref maps are migrated to
 * canonical 5-digit form, but CompressionBlock.startId/endId boundaries were
 * never migrated — neither on own-session load (loadPruneMessagesState) nor on
 * fork transfer (restoreForkCompressionState, which reads the parent's raw
 * persisted record). These tests pin both ingestion points to canonical form.
 */

const logger = new Logger(false)

const SID = "session-legacy-block-ref-test"

function buildConfig(overrides: Partial<PluginConfig> = {}): PluginConfig {
    const base: PluginConfig = {
        enabled: true,
        autoUpdate: true,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: { enabled: true, protectedTools: [] },
        experimental: { allowSubAgents: false, customPrompts: false },
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
    }
    return { ...base, ...overrides }
}

function makeUserMessage(id: string, text: string): WithParts {
    return {
        info: {
            id,
            sessionID: SID,
            role: "user",
            agent: "assistant",
            time: { created: Date.now() },
            model: { providerID: "test-provider", modelID: "test-model" },
        } as WithParts["info"],
        parts: [{ type: "text", text, id: `${id}-p1`, sessionID: SID, messageID: id }],
    }
}

function makeAssistantMessage(id: string, parts: any[]): WithParts {
    return {
        info: {
            id,
            sessionID: SID,
            role: "assistant",
            agent: "test",
            time: { created: Date.now() },
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

function freshState(): SessionState {
    return createSessionState()
}

function persistedState(state: SessionState): PersistedSessionState {
    return {
        prune: { messages: serializePruneMessagesState(state.prune.messages) },
        nudges: {
            contextLimitAnchors: [],
            turnNudgeAnchors: [],
            iterationNudgeAnchors: [],
            lastPerMessageNudgeTurn: 0,
        },
        stats: { pruneTokenCounter: 0, totalPruneTokens: 0 },
        messageIds: {
            byRawId: Object.fromEntries(state.messageIds.byRawId),
            byRef: Object.fromEntries(state.messageIds.byRef),
            nextRef: state.messageIds.nextRef,
        },
        lastCompaction: 0,
    }
}

/** Re-encode a canonical 5-digit ref in pre-1.1.0 4-digit form (test simulation). */
function toLegacyFourDigit(ref: string): string {
    const match = ref.match(/^m(\d+)$/)
    if (!match) return ref
    return `m${Number.parseInt(match[1], 10).toString().padStart(4, "0")}`
}

/** Build a session state holding exactly one compression block (m00001–m00002). */
function buildParentWithBlock(): {
    state: SessionState
    messages: WithParts[]
    config: PluginConfig
} {
    const state = freshState()
    const messages: WithParts[] = [
        makeUserMessage("parent-u1", "original request"),
        makeAssistantMessage("parent-a1", [makeTextPart("original response")]),
        makeAssistantMessage("parent-compress", [
            makeCompressPart("parent-call", {
                topic: "Parent work",
                content: [{ startId: "m00001", endId: "m00002", summary: "Parent summary." }],
            }),
        ]),
    ]
    const config = buildConfig()
    assert.equal(rebuildCompressionState(state, messages, config, logger), 1)
    return { state, messages, config }
}

test("migrateMessageRef normalizes 4-digit refs and passes non-refs through", () => {
    assert.equal(migrateMessageRef("m0001"), "m00001")
    assert.equal(migrateMessageRef("m00999"), "m00999")
    assert.equal(migrateMessageRef("m00001"), "m00001")
    assert.equal(migrateMessageRef("m99999"), "m99999")
    // Out-of-range indices, block refs, and free text are not message refs.
    assert.equal(migrateMessageRef("m00000"), "m00000")
    assert.equal(migrateMessageRef("m123456"), "m123456")
    assert.equal(migrateMessageRef("b3"), "b3")
    assert.equal(migrateMessageRef(""), "")
    assert.equal(migrateMessageRef("not-a-ref"), "not-a-ref")
    assert.equal(migrateMessageRef(" M0007 "), "m00007")
})

test("loadPruneMessagesState migrates 4-digit block boundary refs to 5-digit", () => {
    const { state } = buildParentWithBlock()
    const persisted = serializePruneMessagesState(state.prune.messages)
    // Simulate a pre-1.1.0 file: 4-digit block boundaries.
    for (const block of Object.values(persisted.blocksById)) {
        block.startId = toLegacyFourDigit(block.startId)
        block.endId = toLegacyFourDigit(block.endId)
    }
    assert.equal(persisted.blocksById["1"].startId, "m0001")
    assert.equal(persisted.blocksById["1"].endId, "m0002")

    const loaded = loadPruneMessagesState(persisted)
    const block = loaded.blocksById.get(1)!
    assert.equal(block.startId, "m00001")
    assert.equal(block.endId, "m00002")
    assert.equal(block.anchorMessageId, "parent-u1")
    assert.equal(block.compressCallId, "parent-call")
    assert.ok(block.directMessageIds.includes("parent-u1"))
})

test("loadPruneMessagesState leaves non-message boundary values unchanged", () => {
    const { state } = buildParentWithBlock()
    const persisted = serializePruneMessagesState(state.prune.messages)
    const block = persisted.blocksById["1"]!
    // bN refs / empty / free text are not message refs → pass through verbatim.
    block.startId = "b3"
    block.endId = ""
    const loaded = loadPruneMessagesState(persisted)
    assert.equal(loaded.blocksById.get(1)!.startId, "b3")
    assert.equal(loaded.blocksById.get(1)!.endId, "")

    const persisted2 = serializePruneMessagesState(state.prune.messages)
    persisted2.blocksById["1"].startId = "not-a-ref"
    persisted2.blocksById["1"].endId = "m00007"
    const loaded2 = loadPruneMessagesState(persisted2)
    assert.equal(loaded2.blocksById.get(1)!.startId, "not-a-ref")
    assert.equal(loaded2.blocksById.get(1)!.endId, "m00007")
})

test("restoreForkCompressionState normalizes 4-digit parent block boundaries", () => {
    const { state: parentState, messages: parentMessages, config } = buildParentWithBlock()
    void config
    const parent = persistedState(parentState)
    // Legacy mixed state: ref maps already 5-digit (new-code save cycle), boundaries still 4-digit.
    for (const b of Object.values(parent.prune.messages.blocksById)) {
        b.startId = toLegacyFourDigit(b.startId)
        b.endId = toLegacyFourDigit(b.endId)
    }
    assert.equal(parent.prune.messages.blocksById["1"].startId, "m0001")

    const forkMessages: WithParts[] = [
        makeUserMessage("fork-u1", "original request"),
        makeAssistantMessage("fork-a1", [makeTextPart("original response")]),
        makeAssistantMessage("fork-compress", [
            {
                type: "tool",
                tool: "compress",
                callID: "fork-call",
                state: { status: "completed", output: "compression copied without input" },
            } as any,
        ]),
    ]

    const forkState = freshState()
    const restored = restoreForkCompressionState(
        forkState,
        forkMessages,
        parent,
        parentMessages,
        logger,
    )

    assert.equal(restored, 1)
    const forkBlock = forkState.prune.messages.blocksById.get(1)!
    assert.equal(forkBlock.startId, "m00001")
    assert.equal(forkBlock.endId, "m00002")
    assert.equal(forkBlock.anchorMessageId, "fork-u1")
    assert.equal(forkBlock.compressCallId, "fork-call")
})

test("hideConsumedCompressCalls matches migrated block keys against legacy 4-digit tool inputs", () => {
    // Post-migration block boundaries are canonical 5-digit, but the immutable
    // historical compress tool input of a pre-1.1.0 session still carries the
    // 4-digit refs the model originally typed. Batch filtering must survive the
    // width difference or consumed batch-mate summaries leak back into context.
    const { state } = buildParentWithBlock()
    const b1 = state.prune.messages.blocksById.get(1)!
    b1.startId = "m00001"
    b1.endId = "m00002"
    b1.compressCallId = "batch-call"
    const b2 = { ...b1, blockId: 2, startId: "m00003", endId: "m00004", active: false }
    state.prune.messages.blocksById.set(2, b2)

    const messages: WithParts[] = [
        makeAssistantMessage("batch-msg", [
            {
                type: "tool",
                tool: "compress",
                callID: "batch-call",
                state: {
                    status: "completed",
                    input: {
                        topic: "Batch",
                        content: [
                            { startId: "m0001", endId: "m0002", summary: "Summary A." },
                            { startId: "m0003", endId: "m0004", summary: "Summary B." },
                        ],
                    },
                    output: "Compressed messages into [Compressed conversation section].",
                },
            } as any,
        ]),
    ]

    const hidden = hideConsumedCompressCalls(state, messages)
    assert.equal(hidden, 0)
    const part = messages[0].parts[0] as any
    assert.equal(part.state.input.content.length, 1)
    assert.equal(part.state.input.content[0].startId, "m0001")
})

test("session initialization migrates legacy block boundaries and re-saves normalized state", async () => {
    const sid = `legacy-ref-${Date.now()}-${process.pid}`
    const { state, messages, config } = buildParentWithBlock()
    state.sessionId = sid
    await saveSessionState(state, logger)

    // Rewrite the persisted file with 4-digit block boundaries (pre-1.1.0 shape).
    const filePath = join(getDefaultStorageDir(), `${sid}.json`)
    const raw = JSON.parse(readFileSync(filePath, "utf8"))
    for (const block of Object.values(raw.prune.messages.blocksById)) {
        block.startId = toLegacyFourDigit(block.startId)
        block.endId = toLegacyFourDigit(block.endId)
    }
    writeFileSync(filePath, JSON.stringify(raw))

    const client = {
        session: {
            get: async () => ({ data: {} }),
            messages: async () => ({ data: messages }),
        },
    }
    const loaded = freshState()
    await ensureSessionInitialized(client, loaded, sid, logger, messages, config)

    const block = loaded.prune.messages.blocksById.get(1)!
    assert.equal(block.startId, "m00001")
    assert.equal(block.endId, "m00002")

    // Self-healing: the unconditional post-init save persists canonical refs.
    const resaved = JSON.parse(readFileSync(filePath, "utf8"))
    assert.equal(resaved.prune.messages.blocksById["1"].startId, "m00001")
    assert.equal(resaved.prune.messages.blocksById["1"].endId, "m00002")
})
