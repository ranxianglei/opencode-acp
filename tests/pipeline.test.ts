import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"
import { prepareSession, finalizeSession, type NotificationEntry } from "../lib/compress/pipeline"
import { createSessionState, type WithParts } from "../lib/state"
import type { ToolContext } from "../lib/compress/types"

function buildConfig(): PluginConfig {
    return {
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
            batchCleanup: { lowThreshold: "60%", highThreshold: "75%", forceThreshold: "90%" },
        },
    }
}

const logger = new Logger(false)

function buildToolContext(state = createSessionState()): ToolContext {
    return {
        state,
        config: buildConfig(),
        logger,
        prompts: {} as any,
        client: {
            session: {
                messages: async () => [] as WithParts[],
            },
        } as any,
    }
}

function buildRunContext(): any {
    return {
        ask: async () => {},
        metadata: () => {},
        sessionID: "test-session",
    }
}

test("prepareSession throws when manualMode blocks compression", async () => {
    const state = createSessionState()
    state.manualMode = "active"
    const ctx = buildToolContext(state)
    await assert.rejects(
        () => prepareSession(ctx, buildRunContext(), "test title"),
        /Manual mode.*compress blocked/,
    )
})

test("prepareSession does not throw when manualMode is compress-pending", async () => {
    const state = createSessionState()
    state.manualMode = "compress-pending"
    const ctx = buildToolContext(state)
    const result = await prepareSession(ctx, buildRunContext(), "test title")
    assert.ok(result.rawMessages, "should return messages")
    assert.ok(result.searchContext, "should return search context")
})

test("prepareSession does not throw when manualMode is false", async () => {
    const state = createSessionState()
    state.manualMode = false
    const ctx = buildToolContext(state)
    const result = await prepareSession(ctx, buildRunContext(), "test title")
    assert.ok(result.rawMessages, "should return messages")
})

test("finalizeSession resets manualMode to active when truthy", async () => {
    const state = createSessionState()
    state.manualMode = "compress-pending"
    state.sessionId = null
    const ctx = buildToolContext(state)
    const messages: WithParts[] = []
    const entries: NotificationEntry[] = []
    await finalizeSession(ctx, buildRunContext(), messages, entries, undefined)
    assert.equal(state.manualMode, "active")
})

test("finalizeSession resets manualMode to false when falsy", async () => {
    const state = createSessionState()
    state.manualMode = false
    state.sessionId = null
    const ctx = buildToolContext(state)
    const messages: WithParts[] = []
    const entries: NotificationEntry[] = []
    await finalizeSession(ctx, buildRunContext(), messages, entries, undefined)
    assert.equal(state.manualMode, false)
})
