/**
 * Regression tests for issue #312: switching models caused wrong context-level
 * math — a 50% emergency threshold fired at ~26% because every percentage was
 * still computed against the PREVIOUS model's context window.
 *
 * Root cause: within one LLM request the host fires
 * experimental.chat.messages.transform BEFORE experimental.chat.system.transform
 * (sst/opencode: session/prompt.ts → llm/request.ts), and
 * state.modelContextLimit is written only by the system hook. So the first
 * request after a model switch runs all threshold math against the old limit.
 *
 * Fix: SessionStateRegistry keeps a `${providerID}/${modelID}` → context limit
 * catalog (recorded live by the system hook, seeded at init from
 * GET /config/providers), and the messages hook reconciles
 * state.modelContextLimit from the model named on the request's user message.
 */

import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { PluginConfig } from "../lib/config"
import { createChatMessageTransformHandler, createSystemPromptHandler } from "../lib/hooks"
import { Logger } from "../lib/logger"
import { SessionStateRegistry, createSessionState, type SessionState, type WithParts } from "../lib/state"
import { createTestRegistry } from "./registry-stub"

const SID = "session-model-switch"
const OLD_MODEL = "model-200k"
const NEW_MODEL = "model-1m"
const PROVIDER = "test-provider"

const OLD_LIMIT = 200_000
const NEW_LIMIT = 1_000_000
const EMERGENCY_PERCENT: `${number}%` = "50%"

function buildConfig(): PluginConfig {
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
            maxContextLimit: 5_000_000,
            minContextLimit: 5_000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: ["task"],
            protectTags: false,
            protectUserMessages: false,
            emergencyThresholdPercent: EMERGENCY_PERCENT,
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

function makeUserMessage(id: string, text: string, modelId: string): WithParts {
    return {
        info: {
            id,
            sessionID: SID,
            role: "user",
            agent: "assistant",
            time: { created: Date.now() },
            model: { providerID: PROVIDER, modelID: modelId },
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
            modelID: OLD_MODEL,
            providerID: PROVIDER,
            mode: "normal",
            path: { cwd: "/", root: "/" },
            summary: false,
            cost: 0,
            tokens: { input: inputTokens, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
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
                compressMessage: "compress message",
                contextLimitNudge: "nudge",
                turnNudge: "turn nudge",
                iterationNudge: "iteration nudge",
                manualExtension: "",
                subagentExtension: "",
                decompressExtension: "",
            }
        },
    }
}

function collectText(messages: WithParts[]): string {
    return messages
        .flatMap((m) => (m.parts ?? []))
        .filter((p) => p.type === "text")
        .map((p) => (p as { text?: string }).text ?? "")
        .join("\n")
}

/**
 * Runs one messages.transform with `currentTokens` of context while the user
 * message names `modelId`. The session state starts with `initialLimit`
 * (simulating the previous model's window written by the last request's
 * system.transform). `catalog` optionally seeds the registry catalog the way
 * the system hook / init bootstrap would have.
 */
async function runTransform(opts: {
    currentTokens: number
    modelId: string
    initialLimit: number | undefined
    initialModel?: { providerID: string; modelID: string }
    catalog?: Array<[providerId: string, modelId: string, limit: number]>
    client?: unknown
    logger?: Logger
    config?: PluginConfig
}): Promise<{ text: string; state: SessionState }> {
    const tempDir = mkdtempSync(join(tmpdir(), "acp-model-switch-"))
    process.env.XDG_DATA_HOME = tempDir
    process.env.XDG_CONFIG_HOME = tempDir

    try {
        const state = createSessionState()
        state.sessionId = SID
        state.modelContextLimit = opts.initialLimit
        // Simulates the identity pair the system hook would have recorded
        // alongside the limit; omitting it simulates a legacy persisted state
        // (saved before the pair existed).
        if (opts.initialModel) {
            state.modelProviderID = opts.initialModel.providerID
            state.modelID = opts.initialModel.modelID
        }

        const registry = createTestRegistry(state)
        for (const [providerId, modelId, limit] of opts.catalog ?? []) {
            registry.recordModelLimit(providerId, modelId, limit)
        }

        const handler = createChatMessageTransformHandler(
            opts.client ?? createMockClient(),
            registry,
            opts.logger ?? new Logger(false),
            opts.config ?? buildConfig(),
            createMockPrompts(),
            { global: undefined, agents: {} },
        )

        const messages: WithParts[] = [
            makeUserMessage("msg-u1", "earlier question", opts.modelId),
            makeAssistantMessage("msg-a1", "earlier answer", 1_000),
            makeUserMessage("msg-u2", "current question", opts.modelId),
        ]
        // Token usage is read from the LAST assistant message with token data.
        messages.splice(2, 0, makeAssistantMessage("msg-a2", "big answer", opts.currentTokens))

        await handler({}, { messages })

        return { text: collectText(messages), state }
    } finally {
        rmSync(tempDir, { recursive: true, force: true })
    }
}

// ─── Issue #312 scenario: 200K → 1M switch, 50% emergency threshold ─────────

test("model switch to larger window: 26% usage must NOT fire a 50% emergency nudge", async () => {
    // 260K tokens on a 1M window = 26%. Against the stale 200K window the
    // 50% threshold is 100K and the emergency nudge (wrongly) fires.
    const currentTokens = 260_000
    const { text, state } = await runTransform({
        currentTokens,
        modelId: NEW_MODEL,
        initialLimit: OLD_LIMIT,
        catalog: [[PROVIDER, NEW_MODEL, NEW_LIMIT]],
    })

    assert.equal(state.modelContextLimit, NEW_LIMIT, "limit must reconcile to the new model")
    assert.ok(!text.includes("Context limit reached"), "emergency nudge must not fire at 26%")
    assert.equal(state.nudges.lastNudgeShownTokens, undefined, "no nudge baseline recorded")
})

test("catalog miss + model switch invalidates the stale limit (legacy state)", async () => {
    // No catalog entry for the new model AND the state carries no identity
    // pair (legacy persisted state): the messages hook cannot CORRECT the
    // limit, so it invalidates it instead of computing a 100K threshold from
    // the stale 200K window. The #312 false positive is eliminated even when
    // the catalog misses; system.transform refreshes the pair later in this
    // same request.
    const { text, state } = await runTransform({
        currentTokens: 260_000,
        modelId: NEW_MODEL,
        initialLimit: OLD_LIMIT,
    })

    assert.equal(state.modelContextLimit, undefined, "stale limit must be invalidated")
    assert.equal(state.modelProviderID, PROVIDER)
    assert.equal(state.modelID, NEW_MODEL)
    assert.ok(!text.includes("Context limit reached"), "no emergency math against unknown window")
})

test("catalog miss + identity mismatch invalidates the stale limit", async () => {
    // Same as above, but the state KNOWS its limit belongs to OLD_MODEL — the
    // recorded-identity check (not the legacy heuristic) drives the fix.
    const { text, state } = await runTransform({
        currentTokens: 260_000,
        modelId: NEW_MODEL,
        initialLimit: OLD_LIMIT,
        initialModel: { providerID: PROVIDER, modelID: OLD_MODEL },
    })

    assert.equal(state.modelContextLimit, undefined)
    assert.equal(state.modelID, NEW_MODEL)
    assert.ok(!text.includes("Context limit reached"))
})

test("catalog miss + same identity keeps the limit (no needless blindness)", async () => {
    // Catalog misses but the request names the SAME model the limit was
    // recorded for (e.g. fresh instance after failed hydration): the limit is
    // still trusted — percentage math stays enabled instead of blinding
    // every such turn. 260K on 200K = 130% ≥ 50% → emergency still fires.
    const { text, state } = await runTransform({
        currentTokens: 260_000,
        modelId: OLD_MODEL,
        initialLimit: OLD_LIMIT,
        initialModel: { providerID: PROVIDER, modelID: OLD_MODEL },
    })

    assert.equal(state.modelContextLimit, OLD_LIMIT, "same-identity limit must be kept")
    assert.ok(text.includes("critically full"), "130% of 200K still fires the emergency notice")
})

test("model switch to smaller window: emergency fires when actually over threshold", async () => {
    // 150K tokens on a 200K window = 75% ≥ 50% → must fire. With the stale 1M
    // window the threshold would be 500K and the emergency would be missed.
    const { text, state } = await runTransform({
        currentTokens: 150_000,
        modelId: OLD_MODEL,
        initialLimit: NEW_LIMIT,
        catalog: [[PROVIDER, OLD_MODEL, OLD_LIMIT]],
    })

    assert.equal(state.modelContextLimit, OLD_LIMIT)
    assert.ok(text.includes("critically full"), "emergency notice must fire at 75% of 200K")
})

// ─── Catalog population ──────────────────────────────────────────────────────

test("system.transform records model limit even when session state is absent", async () => {
    const registry = new SessionStateRegistry(new Logger(false))
    const handler = createSystemPromptHandler(
        registry,
        new Logger(false),
        buildConfig(),
        createMockPrompts(),
    )

    await handler(
        {
            sessionID: "never-seen",
            model: {
                id: NEW_MODEL,
                providerID: PROVIDER,
                limit: { context: NEW_LIMIT },
            },
        },
        { system: ["base system prompt"] },
    )

    assert.equal(registry.resolveModelLimit(PROVIDER, NEW_MODEL), NEW_LIMIT)
    assert.equal(registry.resolveModelLimit(PROVIDER, "other"), undefined)
})

test("system.transform records the model identity alongside the limit", async () => {
    const state = createSessionState()
    state.sessionId = SID
    const registry = createTestRegistry(state)
    const handler = createSystemPromptHandler(
        registry,
        new Logger(false),
        buildConfig(),
        createMockPrompts(),
    )

    await handler(
        {
            sessionID: SID,
            model: { id: NEW_MODEL, providerID: PROVIDER, limit: { context: NEW_LIMIT } },
        },
        { system: ["base system prompt"] },
    )

    assert.equal(state.modelContextLimit, NEW_LIMIT)
    assert.equal(state.modelProviderID, PROVIDER)
    assert.equal(state.modelID, NEW_MODEL)
})

test("registry catalog ignores invalid entries and unknown lookups", () => {
    const registry = new SessionStateRegistry(new Logger(false))
    registry.recordModelLimit(PROVIDER, NEW_MODEL, NEW_LIMIT)
    registry.recordModelLimit(undefined, NEW_MODEL, 123)
    registry.recordModelLimit(PROVIDER, undefined, 123)
    registry.recordModelLimit(PROVIDER, "zero", 0)
    registry.recordModelLimit(PROVIDER, "negative", -5)

    assert.equal(registry.resolveModelLimit(PROVIDER, NEW_MODEL), NEW_LIMIT)
    assert.equal(registry.resolveModelLimit(PROVIDER, "zero"), undefined)
    assert.equal(registry.resolveModelLimit(undefined, NEW_MODEL), undefined)
    assert.equal(registry.resolveModelLimit(PROVIDER, undefined), undefined)
})

test("hydrateModelLimitsFromClient seeds the catalog from /config/providers", async () => {
    const registry = new SessionStateRegistry(new Logger(false))
    const client = {
        config: {
            providers: async () => ({
                data: {
                    providers: [
                        {
                            id: PROVIDER,
                            models: {
                                [NEW_MODEL]: { limit: { context: NEW_LIMIT } },
                                [OLD_MODEL]: { limit: { context: OLD_LIMIT } },
                                broken: { limit: {} },
                            },
                        },
                        { id: "no-models-provider" },
                    ],
                },
            }),
        },
    }

    const recorded = await registry.hydrateModelLimitsFromClient(client)
    assert.equal(recorded, 2)
    assert.equal(registry.resolveModelLimit(PROVIDER, NEW_MODEL), NEW_LIMIT)
    assert.equal(registry.resolveModelLimit(PROVIDER, OLD_MODEL), OLD_LIMIT)
    assert.equal(registry.resolveModelLimit(PROVIDER, "broken"), undefined)
})

test("hydrateModelLimitsFromClient tolerates missing and throwing clients", async () => {
    const registry = new SessionStateRegistry(new Logger(false))

    assert.equal(await registry.hydrateModelLimitsFromClient({}), 0)
    assert.equal(
        await registry.hydrateModelLimitsFromClient({
            config: { providers: async () => { throw new Error("offline") } },
        }),
        0,
    )
})

// ─── Issue #346: spawn+resume loses the limit (no persistence, empty catalog) ─

test("catalog miss + provider config available: lazy hydration resolves the limit (#346)", async () => {
    // Production path: headless spawn+resume, init-time seed raced server
    // readiness and left the catalog empty. During the request the server is
    // up, so a one-time lazy hydration must recover the limit.
    const { state } = await runTransform({
        currentTokens: 100_000,
        modelId: NEW_MODEL,
        initialLimit: undefined,
        client: {
            session: { get: async () => ({ data: { parentID: null } }) },
            config: {
                providers: async () => ({
                    data: {
                        providers: [
                            {
                                id: PROVIDER,
                                models: { [NEW_MODEL]: { limit: { context: NEW_LIMIT } } },
                            },
                        ],
                    },
                }),
            },
        },
    })

    assert.equal(state.modelContextLimit, NEW_LIMIT, "limit must resolve via lazy hydration")
})

test("system.transform persists the limit so spawned processes resume with it (#346)", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "acp-persist-"))
    process.env.XDG_DATA_HOME = tempDir
    process.env.XDG_CONFIG_HOME = tempDir

    try {
        const state = createSessionState()
        state.sessionId = SID
        const registry = createTestRegistry(state)
        const handler = createSystemPromptHandler(
            registry,
            new Logger(false),
            buildConfig(),
            createMockPrompts(),
        )

        await handler(
            {
                sessionID: SID,
                model: { id: NEW_MODEL, providerID: PROVIDER, limit: { context: NEW_LIMIT } },
            },
            { system: ["base system prompt"] },
        )
        // saveSessionState is fire-and-forget — give the write a tick to land.
        await new Promise((resolve) => setTimeout(resolve, 100))

        const file = join(tempDir, "opencode", "storage", "plugin", "acp", `${SID}.json`)
        const persisted = JSON.parse(readFileSync(file, "utf8"))
        assert.equal(persisted.modelContextLimit, NEW_LIMIT)
        assert.equal(persisted.modelProviderID, PROVIDER)
        assert.equal(persisted.modelID, NEW_MODEL)
    } finally {
        rmSync(tempDir, { recursive: true, force: true })
    }
})

test("internal-agent system prompts must not overwrite the session limit (#346)", async () => {
    // Title/summary/compaction agents run on their own small model; their
    // system.transform must not corrupt the session's real limit.
    const state = createSessionState()
    state.sessionId = SID
    state.modelContextLimit = OLD_LIMIT
    state.modelProviderID = PROVIDER
    state.modelID = OLD_MODEL
    const registry = createTestRegistry(state)
    const handler = createSystemPromptHandler(
        registry,
        new Logger(false),
        buildConfig(),
        createMockPrompts(),
    )

    await handler(
        {
            sessionID: SID,
            model: { id: "title-model", providerID: PROVIDER, limit: { context: 8_000 } },
        },
        { system: ["You are a title generator for conversations."] },
    )

    assert.equal(state.modelContextLimit, OLD_LIMIT, "title-agent limit must not overwrite")
    assert.equal(state.modelID, OLD_MODEL)
})

test("hydrateAndResolve: cached hit never touches the client", async () => {
    const registry = new SessionStateRegistry(new Logger(false))
    registry.recordModelLimit(PROVIDER, NEW_MODEL, NEW_LIMIT)
    let calls = 0
    const client = {
        config: {
            providers: async () => {
                calls++
                return { data: { providers: [] } }
            },
        },
    }

    assert.equal(await registry.hydrateAndResolve(client, PROVIDER, NEW_MODEL), NEW_LIMIT)
    assert.equal(calls, 0)
})

test("hydrateAndResolve: hydrates at most once per process, then stops retrying (#346)", async () => {
    const registry = new SessionStateRegistry(new Logger(false))
    let calls = 0
    const client = {
        config: {
            providers: async () => {
                calls++
                return {
                    data: {
                        providers: [
                            {
                                id: PROVIDER,
                                models: { [NEW_MODEL]: { limit: { context: NEW_LIMIT } } },
                            },
                        ],
                    },
                }
            },
        },
    }

    assert.equal(await registry.hydrateAndResolve(client, PROVIDER, "missing-1"), undefined)
    assert.equal(await registry.hydrateAndResolve(client, PROVIDER, "missing-2"), undefined)
    assert.equal(calls, 1, "second miss must not re-hydrate")
    assert.equal(await registry.hydrateAndResolve(client, PROVIDER, NEW_MODEL), NEW_LIMIT)
    assert.equal(calls, 1, "cached hit after hydration must not re-hydrate")
})

test("hydrateAndResolve: tolerates throwing clients", async () => {
    const registry = new SessionStateRegistry(new Logger(false))
    const client = {
        config: { providers: async () => { throw new Error("offline") } },
    }

    assert.equal(await registry.hydrateAndResolve(client, PROVIDER, NEW_MODEL), undefined)
})

test("hard guard: ERROR log when post-transform context exceeds the model budget (#346)", async () => {
    const errors: string[] = []
    const logger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: (msg: string) => {
            errors.push(msg)
        },
        saveContext: () => {},
        child: () => logger,
    } as unknown as Logger

    // 190k post-transform on a 200k window: budget = 200_000 − ~1k system
    // prompt − 16_384 output reserve ≈ 182.6k < 190.05k → the request would
    // exceed max_model_len; the guard must log a loud error.
    await runTransform({
        currentTokens: 190_000,
        modelId: OLD_MODEL,
        initialLimit: OLD_LIMIT,
        initialModel: { providerID: PROVIDER, modelID: OLD_MODEL },
        catalog: [[PROVIDER, OLD_MODEL, OLD_LIMIT]],
        logger,
    })

    assert.ok(
        errors.some((e) => e.includes("ACP hard guard")),
        `expected an ACP hard guard error, got: ${JSON.stringify(errors)}`,
    )
})

test("hard guard: silent when post-transform context fits the budget", async () => {
    const errors: string[] = []
    const logger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: (msg: string) => {
            errors.push(msg)
        },
        saveContext: () => {},
        child: () => logger,
    } as unknown as Logger

    await runTransform({
        currentTokens: 100_000,
        modelId: OLD_MODEL,
        initialLimit: OLD_LIMIT,
        initialModel: { providerID: PROVIDER, modelID: OLD_MODEL },
        catalog: [[PROVIDER, OLD_MODEL, OLD_LIMIT]],
        logger,
    })

    assert.ok(
        !errors.some((e) => e.includes("ACP hard guard")),
        `unexpected ACP hard guard error: ${JSON.stringify(errors)}`,
    )
})
