/**
 * Regression tests for issue #312: switching models (200K → 1M) corrupts the
 * context-level math — a 50% emergency compression fires at 26% of the new
 * window.
 *
 * Root cause: `state.modelContextLimit` is written only by the system.transform
 * handler, which fires AFTER messages.transform within each turn (prompt.ts
 * triggers messages.transform, then handle.process → llm.ts triggers
 * system.transform). On the first turn after a model switch the cached limit
 * still describes the PREVIOUS model's window, so every percentage-based
 * threshold (emergencyThresholdPercent, min/maxContextLimit, adaptive nudge
 * growth) is computed against the stale window: 50% × 200K = 100K threshold
 * vs 260K real tokens (26% of the new 1M window) → false emergency.
 *
 * Fix: track the model identity the limit was captured for; the messages
 * transform invalidates the limit when the turn's model no longer matches
 * (standard "limit unknown" path), and system.transform repopulates the
 * correct value later in the same turn.
 */
import "./test-env"
import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { createChatMessageTransformHandler, createSystemPromptHandler } from "../lib/hooks"
import { Logger } from "../lib/logger"
import {
    createSessionState,
    loadSessionState,
    saveSessionState,
    type SessionState,
    type WithParts,
} from "../lib/state"
import { syncModelIdentity } from "../lib/state/utils"
import { isSyntheticMessage } from "../lib/messages/query"
import { createTestRegistry } from "./registry-stub"
import type { Part } from "@opencode-ai/sdk/v2"

// ─── Helpers ────────────────────────────────────────────────────────────────

const SID = "ses-model-switch"
const OLD_MODEL = { providerID: "prov", modelID: "small-200k" }
const NEW_MODEL = { providerID: "prov", modelID: "large-1m" }

function buildConfig(overrides: Partial<PluginConfig> = {}): PluginConfig {
    return {
        enabled: true,
        autoUpdate: true,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: { enabled: true, protectedTools: [] },
        experimental: { allowSubAgents: false, customPrompts: false },
        protectedFilePatterns: [],
        compress: {
            mode: "message",
            permission: "allow",
            showCompression: false,
            summaryBuffer: true,
            // Percentage-based limits: resolve against the live modelContextLimit,
            // so they go "unknown" together with it on a model switch.
            maxContextLimit: "90%",
            minContextLimit: "70%",
            emergencyThresholdPercent: "50%",
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: [],
            protectTags: false,
            protectUserMessages: false,
            preserveRecentMessages: 0,
            preserveRecentTokens: 0,
            preserveLastUserMessage: false,
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

function makeUserMessage(
    id: string,
    text: string,
    model: { providerID: string; modelID: string },
): WithParts {
    return {
        info: {
            id,
            sessionID: SID,
            role: "user",
            agent: "assistant",
            time: { created: Date.now() },
            model,
        } as WithParts["info"],
        parts: [{ type: "text", text, id: `${id}-p1`, sessionID: SID, messageID: id }],
    }
}

function makeAssistantMessage(id: string, text: string, inputTokens: number): WithParts {
    return {
        info: {
            id,
            sessionID: SID,
            role: "assistant",
            agent: "assistant",
            parentID: "parent-placeholder",
            modelID: NEW_MODEL.modelID,
            providerID: NEW_MODEL.providerID,
            mode: "normal",
            path: { cwd: "/", root: "/" },
            summary: false,
            cost: 0,
            tokens: { input: inputTokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: Date.now() },
        } as WithParts["info"],
        parts: [
            { type: "step-start", id: `${id}-ss`, sessionID: SID, messageID: id },
            { type: "text", text, id: `${id}-p1`, sessionID: SID, messageID: id },
        ],
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
                contextLimitNudge: "nudge",
                turnNudge: "turn nudge",
                iterationNudge: "iteration nudge",
                subagentExtension: "",
                decompressExtension: "",
            }
        },
    }
}

function setupPipeline(
    configOverrides: Partial<PluginConfig> = {},
    stateOverrides: Partial<SessionState> = {},
) {
    const state = createSessionState()
    state.sessionId = SID
    Object.assign(state, stateOverrides)

    const config = buildConfig(configOverrides)
    const logger = new Logger(false)
    const registry = createTestRegistry(state)
    const prompts = createMockPrompts()
    const messageHandler = createChatMessageTransformHandler(
        createMockClient(),
        registry,
        logger,
        config,
        prompts,
        { global: undefined, agents: {} },
    )
    const systemHandler = createSystemPromptHandler(registry, logger, config, prompts)

    return { state, logger, config, messageHandler, systemHandler }
}

function partText(part: Part): string {
    if (part.type === "text" && typeof part.text === "string") {
        return part.text
    }
    return ""
}

function suffixText(messages: WithParts[]): string {
    const suffix = messages.find((m) => isSyntheticMessage(m))
    if (!suffix) return ""
    return suffix.parts.map(partText).join("")
}

const EMERGENCY_MARK = "Context limit reached"

// ─── Unit: syncModelIdentity ────────────────────────────────────────────────

test("syncModelIdentity: same model keeps the cached limit", () => {
    const state = createSessionState()
    state.modelContextLimit = 200000
    state.modelProviderID = OLD_MODEL.providerID
    state.modelID = OLD_MODEL.modelID

    assert.equal(syncModelIdentity(state, OLD_MODEL.providerID, OLD_MODEL.modelID), false)
    assert.equal(state.modelContextLimit, 200000)
})

test("syncModelIdentity: model switch invalidates the stale limit", () => {
    const state = createSessionState()
    state.modelContextLimit = 200000
    state.modelProviderID = OLD_MODEL.providerID
    state.modelID = OLD_MODEL.modelID

    assert.equal(syncModelIdentity(state, NEW_MODEL.providerID, NEW_MODEL.modelID), true)
    assert.equal(state.modelContextLimit, undefined, "stale limit must be treated as unknown")
    assert.equal(state.modelProviderID, NEW_MODEL.providerID)
    assert.equal(state.modelID, NEW_MODEL.modelID)
})

test("syncModelIdentity: provider change invalidates even with same model id", () => {
    const state = createSessionState()
    state.modelContextLimit = 200000
    state.modelProviderID = "other"
    state.modelID = NEW_MODEL.modelID

    assert.equal(syncModelIdentity(state, NEW_MODEL.providerID, NEW_MODEL.modelID), true)
    assert.equal(state.modelContextLimit, undefined)
})

test("syncModelIdentity: legacy state without provenance invalidates on first sync", () => {
    // State files written before the identity fields existed carry a limit
    // whose model cannot be verified — must not be trusted silently.
    const state = createSessionState()
    state.modelContextLimit = 200000

    assert.equal(syncModelIdentity(state, NEW_MODEL.providerID, NEW_MODEL.modelID), true)
    assert.equal(state.modelContextLimit, undefined)
})

test("syncModelIdentity: missing model info is a no-op", () => {
    const state = createSessionState()
    state.modelContextLimit = 200000
    state.modelProviderID = OLD_MODEL.providerID
    state.modelID = OLD_MODEL.modelID

    assert.equal(syncModelIdentity(state, undefined, NEW_MODEL.modelID), false)
    assert.equal(syncModelIdentity(state, NEW_MODEL.providerID, undefined), false)
    assert.equal(state.modelContextLimit, 200000, "no model info → nothing to compare against")
})

// ─── Persistence ────────────────────────────────────────────────────────────

test("persistence: model identity survives save/load round-trip", async () => {
    const state = createSessionState()
    state.sessionId = "test-model-switch-persist"
    state.modelContextLimit = 1000000
    state.modelProviderID = NEW_MODEL.providerID
    state.modelID = NEW_MODEL.modelID
    const logger = new Logger(false)

    await saveSessionState(state, logger)
    const loaded = await loadSessionState("test-model-switch-persist", logger)

    assert.ok(loaded)
    assert.equal(loaded.modelContextLimit, 1000000)
    assert.equal(loaded.modelProviderID, NEW_MODEL.providerID)
    assert.equal(loaded.modelID, NEW_MODEL.modelID)
})

// ─── E2E: issue #312 scenario ───────────────────────────────────────────────

test("issue #312: no false emergency on first turn after switching 200K → 1M", async () => {
    // Session ran on the 200K model: the cached limit + identity match it.
    // Context is at 260K tokens — 26% of the NEW 1M window, but 2.6× the stale
    // emergency threshold (50% × 200K = 100K). The user just switched to the
    // 1M model; this is the first messages.transform of the new turn.
    const { state, messageHandler, systemHandler } = setupPipeline(
        {},
        {
            modelContextLimit: 200000,
            modelProviderID: OLD_MODEL.providerID,
            modelID: OLD_MODEL.modelID,
            nudges: createSessionState().nudges,
        },
    )
    state.nudges.lastPerMessageNudgeTokens = 260000

    const output = {
        messages: [
            makeUserMessage("u1", "Hello", OLD_MODEL),
            makeAssistantMessage("a1", "Working on it", 260000),
            makeUserMessage("u2", "Continue", NEW_MODEL),
        ],
    }

    // 1. messages.transform for the new model — before system.transform fires.
    await messageHandler({}, output)

    assert.equal(state.modelContextLimit, undefined, "stale 200K limit must be invalidated")
    assert.equal(state.modelID, NEW_MODEL.modelID, "identity must track the current turn's model")
    assert.ok(
        !suffixText(output.messages).includes(EMERGENCY_MARK),
        "260K tokens is 26% of the 1M window — emergency (50%) must NOT fire on the stale threshold",
    )
    assert.equal(state.nudges.shouldInjectThisTurn, false)

    // 2. system.transform for the new model fires later in the same turn.
    await systemHandler(
        {
            sessionID: SID,
            model: {
                id: NEW_MODEL.modelID,
                providerID: NEW_MODEL.providerID,
                limit: { context: 1000000 },
            },
        },
        { system: ["host system prompt"] },
    )
    assert.equal(state.modelContextLimit, 1000000)
    assert.equal(state.modelID, NEW_MODEL.modelID)

    // 3. Next transform: corrected 1M limit — 260K is still well below the
    //    real 500K emergency threshold.
    const output2 = {
        messages: [
            makeUserMessage("u1", "Hello", OLD_MODEL),
            makeAssistantMessage("a1", "Working on it", 260000),
            makeUserMessage("u3", "Keep going", NEW_MODEL),
        ],
    }
    await messageHandler({}, output2)

    assert.ok(
        !suffixText(output2.messages).includes(EMERGENCY_MARK),
        "with the correct 1M limit, 260K (26%) must not trip the 50% emergency",
    )
    assert.equal(state.nudges.shouldInjectThisTurn, false)
})

test("control: emergency still fires when limit and model agree", async () => {
    // No switch — cached limit matches the turn's model. 800K tokens on a 1M
    // model with a 50% emergency threshold (500K) MUST still trigger the
    // strong alert, proving the threshold machinery was not neutered.
    const { state, messageHandler } = setupPipeline(
        {},
        {
            modelContextLimit: 1000000,
            modelProviderID: NEW_MODEL.providerID,
            modelID: NEW_MODEL.modelID,
            nudges: createSessionState().nudges,
        },
    )
    state.nudges.lastPerMessageNudgeTokens = 800000

    const output = {
        messages: [
            makeUserMessage("u1", "Hello", NEW_MODEL),
            makeAssistantMessage("a1", "Verbose work", 800000),
            makeUserMessage("u2", "Continue", NEW_MODEL),
        ],
    }

    await messageHandler({}, output)

    assert.equal(state.modelContextLimit, 1000000, "matching model must not invalidate the limit")
    assert.ok(
        suffixText(output.messages).includes(EMERGENCY_MARK),
        "800K >= 50% × 1M → emergency alert must fire",
    )
})

test("control: no switch, same-model repeated transforms keep the limit", async () => {
    const { state, messageHandler } = setupPipeline(
        {},
        {
            modelContextLimit: 200000,
            modelProviderID: OLD_MODEL.providerID,
            modelID: OLD_MODEL.modelID,
            nudges: createSessionState().nudges,
        },
    )
    state.nudges.lastPerMessageNudgeTokens = 100000

    const output = {
        messages: [
            makeUserMessage("u1", "Hello", OLD_MODEL),
            makeAssistantMessage("a1", "Working", 100000),
            makeUserMessage("u2", "More", OLD_MODEL),
        ],
    }

    await messageHandler({}, output)
    await messageHandler({}, output)

    assert.equal(state.modelContextLimit, 200000, "steady-state model must retain its limit")
})
