import "./test-env"
import assert from "node:assert/strict"
import test from "node:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { rebuildCompressionState, restoreForkCompressionState } from "../lib/state/rebuild"
import { createSessionState, ensureSessionInitialized } from "../lib/state/state"
import { Logger } from "../lib/logger"
import type { PluginConfig } from "../lib/config"
import type { WithParts } from "../lib/state/types"
import {
    getDefaultStorageDir,
    loadSessionState,
    saveSessionState,
    type PersistedSessionState,
} from "../lib/state/persistence"

const logger = new Logger(false)

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

const BASE_TIME = Date.now()
let tsCounter = 0
function nextTs(): number {
    return BASE_TIME + ++tsCounter * 1000
}

function makeUserMessage(id: string, text: string, created?: number): WithParts {
    return {
        info: {
            id,
            sessionID: "issue407",
            role: "user",
            agent: "assistant",
            time: { created: created ?? nextTs() },
            model: { providerID: "test-provider", modelID: "test-model" },
        } as WithParts["info"],
        parts: [{ type: "text", text, id: `${id}-p1`, sessionID: "issue407", messageID: id }],
    }
}

function makeAssistantMessage(
    id: string,
    parts: any[],
    created?: number,
    summary = false,
): WithParts {
    return {
        info: {
            id,
            sessionID: "issue407",
            role: "assistant",
            agent: "test",
            time: { created: created ?? nextTs() },
            parentID: "parent-1",
            modelID: "test-model",
            providerID: "test-provider",
            mode: "normal",
            path: { cwd: "/", root: "/" },
            summary,
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

// A copied compress part whose input was dropped (the scenario where history
// replay cannot reconstruct the block and only parent-state transfer can).
function makeInputlessCompressPart(callId: string): any {
    return {
        type: "tool",
        tool: "compress",
        callID: callId,
        state: { status: "completed", output: "compression copied without input" },
    }
}

/**
 * Build a parent session with one range compression (m00001-m00002), persist
 * it, and return the pieces needed to exercise fork/restart recovery.
 */
async function setupParentWithBlock(prefix: string, storageDir?: string) {
    const parentSessionId = `${prefix}-parent-${Date.now()}-${process.pid}`
    const parentState = createSessionState()
    parentState.sessionId = parentSessionId
    if (storageDir) {
        parentState.storageDir = storageDir
    }
    const parentMessages: WithParts[] = [
        makeUserMessage(`${prefix}-pu1`, "original request"),
        makeAssistantMessage(`${prefix}-pa1`, [makeTextPart("original response")]),
        makeAssistantMessage(`${prefix}-pcompress`, [
            makeCompressPart(`${prefix}-pcall`, {
                topic: "Parent work",
                content: [{ startId: "m00001", endId: "m00002", summary: "Parent summary." }],
            }),
        ]),
    ]
    assert.equal(rebuildCompressionState(parentState, parentMessages, buildConfig(), logger), 1)
    await saveSessionState(parentState, logger)
    return { parentSessionId, parentState, parentMessages }
}

function makeForkCopy(prefix: string): WithParts[] {
    return [
        makeUserMessage(`${prefix}-fu1`, "original request"),
        makeAssistantMessage(`${prefix}-fa1`, [makeTextPart("original response")]),
        makeAssistantMessage(`${prefix}-fcompress`, [makeInputlessCompressPart(`${prefix}-fcall`)]),
    ]
}

function makeClientMock(parentSessionId: string, parentMessages: WithParts[]) {
    return {
        session: {
            get: async () => ({ data: { parentID: parentSessionId } }),
            messages: async () => ({ data: parentMessages }),
        },
    }
}

/** Rewrite a persisted state's message refs to the legacy 4-digit form. */
function downgradeToLegacyRefs(persisted: PersistedSessionState): void {
    assert.ok(persisted.messageIds)
    const byRef: Record<string, string> = {}
    const byRawId: Record<string, string> = {}
    for (const [rawId, ref] of Object.entries(persisted.messageIds.byRawId)) {
        const legacyRef = `m${String(Number(ref.slice(1))).padStart(4, "0")}`
        byRawId[rawId] = legacyRef
        byRef[legacyRef] = rawId
    }
    persisted.messageIds = { byRef, byRawId, nextRef: persisted.messageIds.nextRef }
}

test("restart after native compaction resets stale transient state but preserves blocks and stats", async () => {
    const sid = `issue407-restart-${Date.now()}-${process.pid}`
    const phase1Messages: WithParts[] = [
        makeUserMessage("r-u1", "hello"),
        makeAssistantMessage("r-a1", [makeTextPart("hi")]),
        makeAssistantMessage("r-compress", [
            makeCompressPart("r-call-1", {
                topic: "T",
                content: [{ startId: "m00001", endId: "m00002", summary: "S." }],
            }),
        ]),
    ]
    const phase1 = createSessionState()
    phase1.sessionId = sid
    assert.equal(rebuildCompressionState(phase1, phase1Messages, buildConfig(), logger), 1)

    // Transient state that would go stale once native compaction replaces these
    // messages with a summary.
    phase1.nudges.contextLimitAnchors.add("stale-anchor")
    phase1.nudges.turnNudgeAnchors.add("r-u1")
    phase1.nudges.lastPerMessageNudgeTokens = 12345
    phase1.nudges.compressBaselineSet = true
    phase1.toolParameters.set("stale-call", {
        tool: "bash",
        parameters: {},
        status: "completed",
        turn: 1,
        tokenCount: 10,
    })
    phase1.stats.totalPruneTokens = 999
    await saveSessionState(phase1, logger)

    // Sanity: the persisted state really contains the stale values (and no
    // compaction boundary yet), so the assertions below are meaningful.
    const saved = await loadSessionState(sid, logger)
    assert.ok(saved)
    assert.equal(saved.nudges.lastPerMessageNudgeTokens, 12345)
    assert.ok(saved.nudges.contextLimitAnchors.includes("stale-anchor"))
    assert.ok(saved.messageIds?.byRef["m00001"])
    assert.equal((saved as any)._persistedLastCompaction ?? 0, 0)

    // Native compaction completes, then opencode restarts before the next
    // transform hook runs.
    const tNew = Date.now() + 60_000
    const postCompaction: WithParts[] = [
        makeAssistantMessage("r-summary", [], tNew, true),
        makeUserMessage("r-u2", "post-compaction question", tNew + 1000),
    ]
    const phase2 = createSessionState()
    await ensureSessionInitialized(null, phase2, sid, logger, postCompaction, buildConfig())

    // Stale transient fields are reset...
    assert.equal(phase2.lastCompaction, tNew)
    assert.equal(phase2.messageIds.byRawId.size, 0)
    assert.equal(phase2.messageIds.byRef.size, 0)
    assert.equal(phase2.messageIds.nextRef, 1)
    assert.equal(phase2.nudges.contextLimitAnchors.size, 0)
    assert.equal(phase2.nudges.turnNudgeAnchors.size, 0)
    assert.equal(phase2.nudges.lastPerMessageNudgeTokens, undefined)
    assert.equal(phase2.nudges.compressBaselineSet, false)
    assert.equal(phase2.toolParameters.size, 0)
    // ...while compression blocks and stats survive the reset.
    assert.equal(phase2.prune.messages.blocksById.size, 1)
    assert.equal(phase2.stats.totalPruneTokens, 999)
    // Corrected state is persisted so the next restart starts clean.
    const reloaded = await loadSessionState(sid, logger)
    assert.ok(reloaded)
    assert.equal((reloaded as any)._persistedLastCompaction, tNew)
    assert.deepEqual((reloaded as any)._persistedMessageIds?.byRawId ?? {}, {})
})

test("restart without a newer compaction still restores persisted transient state", async () => {
    const sid = `issue407-norestart-${Date.now()}-${process.pid}`
    const phase1Messages: WithParts[] = [
        makeUserMessage("nr-u1", "hello"),
        makeAssistantMessage("nr-a1", [makeTextPart("hi")]),
        makeAssistantMessage("nr-compress", [
            makeCompressPart("nr-call-1", {
                topic: "T",
                content: [{ startId: "m00001", endId: "m00002", summary: "S." }],
            }),
        ]),
    ]
    const phase1 = createSessionState()
    phase1.sessionId = sid
    assert.equal(rebuildCompressionState(phase1, phase1Messages, buildConfig(), logger), 1)
    phase1.nudges.contextLimitAnchors.add("anchor-keep")
    phase1.nudges.lastPerMessageNudgeTokens = 4321
    await saveSessionState(phase1, logger)

    // Restart with the identical (uncompacted) history: nothing should reset.
    const phase2 = createSessionState()
    await ensureSessionInitialized(null, phase2, sid, logger, phase1Messages, buildConfig())

    assert.equal(phase2.lastCompaction, 0)
    assert.equal(phase2.nudges.lastPerMessageNudgeTokens, 4321)
    assert.ok(phase2.nudges.contextLimitAnchors.has("anchor-keep"))
    assert.equal(phase2.messageIds.byRawId.get("nr-u1"), "m00001")
    assert.equal(phase2.prune.messages.blocksById.size, 1)
})

test("fork recovery loads parent state from the resolved storagePath directory", async () => {
    const customDir = mkdtempSync(join(tmpdir(), "acp-issue407-storage-"))
    try {
        const { parentSessionId, parentMessages } = await setupParentWithBlock("cs", customDir)
        assert.ok(existsSync(join(customDir, `${parentSessionId}.json`)))

        const forkSessionId = `issue407-fork-custom-${Date.now()}-${process.pid}`
        const forkMessages = makeForkCopy("cs")
        const client = makeClientMock(parentSessionId, parentMessages)
        const forkState = createSessionState()
        await ensureSessionInitialized(
            client,
            forkState,
            forkSessionId,
            logger,
            forkMessages,
            buildConfig({ storagePath: customDir }),
            "/some/project",
        )

        // Inherited block transferred even though the parent file lives only
        // under the custom storagePath.
        assert.equal(forkState.prune.messages.blocksById.size, 1)
        assert.ok(forkState.prune.messages.byMessageId.get("cs-fu1")?.activeBlockIds.includes(1))
        // Fork state persisted to the resolved directory, not the default one.
        assert.ok(existsSync(join(customDir, `${forkSessionId}.json`)))
        assert.ok(!existsSync(join(getDefaultStorageDir(), `${forkSessionId}.json`)))
    } finally {
        rmSync(customDir, { recursive: true, force: true })
    }
})

test("fork recovery normalizes legacy 4-digit parent refs before translation", async () => {
    const { parentSessionId, parentMessages } = await setupParentWithBlock("lg")
    const persisted = await loadSessionState(parentSessionId, logger)
    assert.ok(persisted)
    downgradeToLegacyRefs(persisted!)
    assert.ok(Object.keys(persisted!.messageIds!.byRef).every((ref) => /^m\d{4}$/.test(ref)))

    const forkMessages = makeForkCopy("lg")
    const forkState = createSessionState()
    const restored = await restoreForkCompressionState(
        forkState,
        forkMessages,
        persisted!,
        parentMessages,
        logger,
    )

    assert.equal(restored, 1)
    assert.ok(forkState.prune.messages.byMessageId.get("lg-fu1")?.activeBlockIds.includes(1))
})

test("session initialization restores fork state for a parent with legacy 4-digit refs", async () => {
    const { parentSessionId, parentMessages } = await setupParentWithBlock("lg2")
    const persisted = await loadSessionState(parentSessionId, logger)
    assert.ok(persisted)
    downgradeToLegacyRefs(persisted!)
    // Write the legacy-shaped file back so initialization loads it from disk.
    writeFileSync(
        join(getDefaultStorageDir(), `${parentSessionId}.json`),
        JSON.stringify(persisted),
    )

    const forkSessionId = `issue407-fork-legacy-${Date.now()}-${process.pid}`
    const forkMessages = makeForkCopy("lg2")
    const client = makeClientMock(parentSessionId, parentMessages)
    const forkState = createSessionState()
    await ensureSessionInitialized(
        client,
        forkState,
        forkSessionId,
        logger,
        forkMessages,
        buildConfig(),
    )

    assert.equal(forkState.prune.messages.blocksById.size, 1)
    assert.ok(forkState.prune.messages.byMessageId.get("lg2-fu1")?.activeBlockIds.includes(1))
})
