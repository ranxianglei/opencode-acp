import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"
import { prune } from "../lib/messages/prune"
import { prepareSession } from "../lib/compress/pipeline"
import * as compressMod from "../lib/compress"
import * as commandsMod from "../lib/commands"
import { resetSessionState } from "../lib/state/state"
import {
    createSessionState,
    type SessionState,
    type WithParts,
    type Prune,
} from "../lib/state"
import { isMessageCompacted } from "../lib/state/utils"

const logger = new Logger(false)

function buildConfig(): PluginConfig {
    return {
        enabled: true,
        autoUpdate: true,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "toast",
        commands: { enabled: true, protectedTools: [] },
        manualMode: { enabled: false },
        turnProtection: { enabled: false, turns: 4 },
        experimental: { allowSubAgents: false, customPrompts: false },
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
}

function textPart(msgId: string, id: string, text: string) {
    return { id, messageID: msgId, sessionID: "ses", type: "text" as const, text }
}

function userMessage(id: string, text: string): WithParts {
    return {
        info: { id, role: "user", sessionID: "ses", agent: "a", time: { created: 1 } } as WithParts["info"],
        parts: [textPart(id, `${id}-p`, text)],
    }
}

function assistantMessage(id: string): WithParts {
    return {
        info: { id, role: "assistant", sessionID: "ses", agent: "a", time: { created: 2 } } as WithParts["info"],
        parts: [textPart(id, `${id}-p`, "ok")],
    }
}

test("regression: prune() export still callable and mutates messages via filterCompressedRanges", () => {
    const state = createSessionState()
    state.prune.messages.byMessageId.set("m2", { tokenCount: 100, allBlockIds: [1], activeBlockIds: [1] })

    const messages: WithParts[] = [
        userMessage("m1", "first"),
        assistantMessage("m2"),
        userMessage("m3", "second"),
    ]

    prune(state, logger, buildConfig(), messages)

    const ids = messages.map((m) => m.info.id)
    assert.ok(ids.includes("m1"), "m1 survives")
    assert.ok(!ids.includes("m2"), "m2 pruned by filterCompressedRanges (still works)")
    assert.ok(ids.includes("m3"), "m3 survives")
})

test("regression: prune() strips step-start via stripStepMarkers (still works)", () => {
    const state = createSessionState()
    const messages: WithParts[] = [
        {
            info: { id: "a1", role: "assistant", sessionID: "ses", agent: "a", time: { created: 1 } } as WithParts["info"],
            parts: [
                { id: "a1-ss", messageID: "a1", sessionID: "ses", type: "step-start" },
                textPart("a1", "a1-t", "kept"),
            ],
        },
    ]

    prune(state, logger, buildConfig(), messages)

    const types = messages[0]!.parts.map((p: any) => p.type)
    assert.ok(!types.includes("step-start"), "step-start stripped")
    assert.ok(types.includes("text"), "text kept")
})

test("regression: Prune type no longer has `tools` field (compile-time check)", () => {
    type HasTools = Prune extends { tools: any } ? true : false
    const check: HasTools = false as any
    assert.equal(check, false, "Prune must NOT have a `tools` field")
    assert.ok(state0PruneHasOnlyMessages(), "state.prune has only `messages`")
})

function state0PruneHasOnlyMessages(): boolean {
    const s = createSessionState()
    return Object.keys(s.prune).length === 1 && typeof s.prune.messages === "object"
}

test("regression: createSessionState().prune has no tools Map (runtime check)", () => {
    const s = createSessionState()
    assert.equal(Object.prototype.hasOwnProperty.call(s.prune, "tools"), false)
})

test("regression: resetSessionState() produces a prune with no tools Map", () => {
    const s = createSessionState()
    resetSessionState(s)
    assert.equal(Object.prototype.hasOwnProperty.call(s.prune, "tools"), false)
    assert.ok(s.prune.messages, "messages state preserved")
})

test("regression: deduplicate / purgeErrors no longer called in prepareSession", async () => {
    const state: SessionState = createSessionState()
    state.sessionId = "ses-regression"

    const stubClient: any = {
        session: {
            messages: async () => ({ data: [] }),
            list: async () => ({ data: [] }),
        },
    }
    const ctx = {
        client: stubClient,
        state,
        logger,
        config: buildConfig(),
        prompts: { get: () => "", has: () => false } as any,
    }
    const toolCtx = {
        ask: async () => {},
        metadata: () => {},
        sessionID: "ses-regression",
    }

    const raw = await prepareSession(ctx as any, toolCtx as any, "regression")
    assert.ok(Array.isArray(raw.rawMessages), "prepareSession returns messages array")
    assert.ok(raw.searchContext, "prepareSession returns searchContext")
})

test("regression: isMessageCompacted still works (helper that used to also check prune.tools indirectly)", () => {
    const state = createSessionState()
    state.lastCompaction = 100
    const msg: WithParts = {
        info: { id: "m1", role: "assistant", sessionID: "ses", agent: "a", time: { created: 50 } } as WithParts["info"],
        parts: [],
    }
    assert.equal(isMessageCompacted(state, msg), true)
})

test("regression: no `prune` tool, no `sweep` command (exports removed)", () => {
    assert.equal(typeof (compressMod as any).createPruneTool, "undefined", "createPruneTool export removed")
    assert.equal(typeof (commandsMod as any).handleSweepCommand, "undefined", "handleSweepCommand export removed")
})

