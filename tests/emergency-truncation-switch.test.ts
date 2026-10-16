/**
 * [Issue #485] Tests for the `compress.emergencyTruncation` switch.
 *
 * The emergency truncation guards (`truncateLargeToolOutputs` +
 * `enforceContextBudget`) mutate tool outputs per-request from pristine
 * session-store content. A session hovering at the guard threshold
 * oscillates between truncated and full outputs — every flip invalidates
 * the provider prefix cache. The switch defaults to OFF; these tests pin:
 *
 *   1. Config layer: key is known, accepts booleans, rejects non-booleans.
 *   2. Pipeline (default off): an oversized old tool output that WOULD be
 *      truncated is left byte-identical by the transform.
 *   3. Pipeline (opt-in on): the same scenario truncates (marker present).
 *
 * Scenario tuning (window 40_000), verified empirically against the real
 * countTokens/getCurrentTokenUsage/estimateSystemPromptTokens:
 *   - budget guard budget = 40_000 - 32_768 = 7_232; turn-1 estimate
 *     7_953 (base 7,950 + 3 additions) > budget → fires, phase 1 only
 *     (saves 1,279 → final 6,674 ≤ budget, phase 2 skipped).
 *   - BIG_TOOL_OUTPUT ≈ 2,250 tokens (9,450 chars).
 *   - GC threshold = min(100%×40k, 40k − 16,384 − ~99 systemPromptTokens)
 *     = 23,517 ≫ 7,950 → truncateLargeToolOutputs stays idle; only the
 *     budget guard runs.
 *   - Turn 2 of the sticky test: a3 tokens {input: 3_000} → estimate 3,053
 *     ≤ budget and ≪ GC threshold — BOTH guards idle, so byte-identical
 *     replay can only come from state.stickyTruncations.
 */

import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { PluginConfig, PluginInput } from "../lib/config"
import { getConfig } from "../lib/config"
import { createChatMessageTransformHandler } from "../lib/hooks"
import { Logger } from "../lib/logger"
import { createSessionState, type SessionState, type WithParts } from "../lib/state"
import { getInvalidConfigKeys, validateConfigTypes } from "../lib/config-validation"
import { createTestRegistry } from "./registry-stub"
import {
    applyStickyTruncations,
    recordStickyTruncations,
    snapshotToolOutputs,
} from "../lib/messages/sticky-truncation"

const SID = "session-trunc-switch"
const TRUNCATION_MARKER = "[truncated for context space"

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
            mode: "message",
            permission: "allow",
            showCompression: false,
            summaryBuffer: true,
            emergencyTruncation: undefined,
            maxContextLimit: 150000,
            minContextLimit: 50000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: ["task"],
            protectTags: false,
            protectUserMessages: false,
            reasoning: { drop: true, threshold: 2048 },
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

function makeAssistantMessage(
    id: string,
    text: string,
    extraParts: any[] = [],
    tokens?: { input: number; output: number },
): WithParts {
    return {
        info: {
            id,
            sessionID: SID,
            role: "assistant",
            agent: "assistant",
            parentID: "parent-placeholder",
            modelID: "test-model",
            providerID: "test-provider",
            mode: "normal",
            path: { cwd: "/", root: "/" },
            summary: false,
            cost: 0,
            tokens: tokens ?? { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: Date.now() },
        } as WithParts["info"],
        parts: [
            { type: "step-start", id: `${id}-ss`, sessionID: SID, messageID: id },
            { type: "text", text, id: `${id}-p1`, sessionID: SID, messageID: id },
            ...extraParts,
        ],
    }
}

function makeToolPart(callID: string, tool: string, output: string): any {
    return {
        type: "tool",
        tool,
        callID,
        id: `part-${callID}`,
        sessionID: SID,
        messageID: "msg-tool-host",
        state: { status: "completed", output, input: {}, error: undefined },
    }
}

function createMockClient() {
    return { session: { get: async () => ({ data: { parentID: null } }) } }
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
            }
        },
    }
}

function setupPipeline(config: PluginConfig) {
    const tempDir = mkdtempSync(join(tmpdir(), "acp-trunc-switch-"))
    process.env.XDG_DATA_HOME = tempDir
    process.env.XDG_CONFIG_HOME = tempDir

    const state = createSessionState()
    state.sessionId = SID
    state.modelContextLimit = 40_000

    const logger = new Logger(false)
    const registry = createTestRegistry(state)
    // The transform handler reconciles state.modelContextLimit from the model
    // named on the user message (#312): an unresolved model would INVALIDATE
    // the seeded 40_000 window and disable the budget guard. Record it so the
    // catalog resolves test-provider/test-model like a real provider catalog.
    registry.recordModelLimit("test-provider", "test-model", 40_000)
    const handler = createChatMessageTransformHandler(
        createMockClient(),
        registry,
        logger,
        config,
        createMockPrompts(),
        { global: undefined, agents: {} },
    )
    return { state, handler, tempDir }
}

// 5 messages: the tool output sits at index 1, outside the last-3 protection
// window, and the last token-bearing assistant (a3) drives the usage estimate.
const BIG_TOOL_OUTPUT = "line of file content\n".repeat(450) // 9_450 chars ≈ 2_400+ tokens

function buildScenarioMessages(): WithParts[] {
    return [
        makeUserMessage("u1", "Hello"),
        makeAssistantMessage("a1", "Reading files", [
            makeToolPart("call-big-read", "read", BIG_TOOL_OUTPUT),
        ]),
        makeAssistantMessage("a2", "Done reading"),
        makeAssistantMessage("a3", "Summary so far", [], { input: 7900, output: 50 }),
        makeUserMessage("u2", "Continue the analysis"),
    ]
}

// ─── Config layer ───────────────────────────────────────────────────────────

test("config validation: compress.emergencyTruncation is a known key", () => {
    assert.deepEqual(
        getInvalidConfigKeys({ compress: { emergencyTruncation: true } }),
        [],
    )
})

test("config validation: compress.emergencyTruncation accepts booleans", () => {
    assert.deepEqual(validateConfigTypes({ compress: { emergencyTruncation: true } }), [])
    assert.deepEqual(validateConfigTypes({ compress: { emergencyTruncation: false } }), [])
})

test("config validation: compress.emergencyTruncation rejects non-booleans", () => {
    const errors = validateConfigTypes({ compress: { emergencyTruncation: "yes" } })
    assert.equal(errors.length, 1)
    assert.equal(errors[0].key, "compress.emergencyTruncation")
    assert.equal(errors[0].expected, "boolean")
})

test("config validation: provider-level emergencyTruncation override rejects non-booleans", () => {
    const errors = validateConfigTypes({
        compress: { providers: { "my-provider": { emergencyTruncation: "yes" } } },
    })
    assert.equal(errors.length, 1)
    assert.equal(errors[0].key, "compress.providers.my-provider.emergencyTruncation")
    assert.equal(errors[0].expected, "boolean")
})

test("shipped default: emergencyTruncation is false with no user config", () => {
    // Pin the SHIPPED constant (lib/config.ts defaultConfig): every other test
    // hand-builds configs, so flipping the shipped default would otherwise
    // break nothing in this file (#485 review finding).
    const configHome = mkdtempSync(join(tmpdir(), "acp-default-pin-cfg-"))
    const projectDir = mkdtempSync(join(tmpdir(), "acp-default-pin-proj-"))
    const savedConfigHome = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = configHome
    try {
        delete process.env.OPENCODE_CONFIG_DIR
        const fakeCtx = {
            directory: projectDir,
            client: { tui: { showToast: () => {} } },
        } as unknown as PluginInput
        const config = getConfig(fakeCtx)
        assert.equal(config.compress.emergencyTruncation, false)
    } finally {
        if (savedConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
        else process.env.XDG_CONFIG_HOME = savedConfigHome
        rmSync(configHome, { recursive: true, force: true })
        rmSync(projectDir, { recursive: true, force: true })
    }
})

test("persistence: stickyTruncations survives a save→load→restore roundtrip, dropping malformed entries", async () => {
    const { saveSessionState, loadSessionState } = await import("../lib/state/persistence")
    const { ensureSessionInitialized } = await import("../lib/state/state")
    const dataHome = mkdtempSync(join(tmpdir(), "acp-sticky-persist-"))
    const savedDataHome = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = dataHome
    const logger = new Logger(false)
    try {
        // Save: one valid entry + one malformed (simulating a hand-edited or
        // corrupted state file).
        const original = createSessionState()
        original.sessionId = SID
        original.stickyTruncations = {
            "call-a": "frozen output a",
            "call-b": "frozen output b",
        }
        ;(original.stickyTruncations as Record<string, unknown>)["call-bad"] = 42
        await saveSessionState(original, logger)

        // Load: the raw persisted object carries the field through.
        const persisted = await loadSessionState(SID, logger)
        assert.ok(persisted, "state file should be loadable")
        assert.equal(persisted!.stickyTruncations?.["call-a"], "frozen output a")
        assert.equal(persisted!.stickyTruncations?.["call-b"], "frozen output b")

        // Restore onto a fresh SessionState: strings survive, non-strings drop.
        const restored = createSessionState()
        await ensureSessionInitialized(createMockClient(), restored, SID, logger, [])
        assert.equal(restored.stickyTruncations["call-a"], "frozen output a")
        assert.equal(restored.stickyTruncations["call-b"], "frozen output b")
        assert.equal(restored.stickyTruncations["call-bad"], undefined)
    } finally {
        if (savedDataHome === undefined) delete process.env.XDG_DATA_HOME
        else process.env.XDG_DATA_HOME = savedDataHome
        rmSync(dataHome, { recursive: true, force: true })
    }
})

// ─── Pipeline behavior ──────────────────────────────────────────────────────

test("default off: oversized old tool output survives the transform intact (content unmodified)", async () => {
    const { handler, tempDir } = setupPipeline(buildConfig())
    try {
        const output = { messages: buildScenarioMessages() }
        await handler({}, output)

        const toolPart = (output.messages[1] as WithParts).parts.find(
            (p: any) => p.type === "tool",
        ) as any
        assert.ok(toolPart, "tool part must survive the pipeline")
        // Full content intact; the only allowed addition is the <dcp-message-id>
        // tag that injectMessageIds appends after the truncation stage.
        assert.ok(
            toolPart.state.output.startsWith(BIG_TOOL_OUTPUT),
            "tool output must survive byte-identical (default off)",
        )
        assert.ok(!toolPart.state.output.includes(TRUNCATION_MARKER))
    } finally {
        rmSync(tempDir, { recursive: true, force: true })
    }
})

test("opt-in on: the same scenario truncates the oversized tool output", async () => {
    const config = buildConfig()
    config.compress.emergencyTruncation = true
    const { handler, tempDir } = setupPipeline(config)
    try {
        const output = { messages: buildScenarioMessages() }
        await handler({}, output)

        const toolPart = (output.messages[1] as WithParts).parts.find(
            (p: any) => p.type === "tool",
        ) as any
        assert.ok(toolPart, "tool part must survive the pipeline")
        assert.ok(
            toolPart.state.output.includes(TRUNCATION_MARKER),
            `expected truncation marker in output, got: ${toolPart.state.output.slice(0, 120)}…`,
        )
        assert.ok(toolPart.state.output.length < BIG_TOOL_OUTPUT.length)
    } finally {
        rmSync(tempDir, { recursive: true, force: true })
    }
})

// ─── Sticky truncation (#485): no oscillation across requests ─────────

test("sticky: truncation is frozen and replayed byte-identically on later requests", async () => {
    const config = buildConfig()
    config.compress.emergencyTruncation = true
    const { state, handler, tempDir } = setupPipeline(config)
    try {
        // ── Turn 1: over budget → guards truncate A→B, freeze B in state.
        const turn1 = { messages: buildScenarioMessages() }
        await handler({}, turn1)
        const turn1Output = (
            (turn1.messages[1] as WithParts).parts.find((p: any) => p.type === "tool") as any
        ).state.output as string
        assert.ok(turn1Output.includes(TRUNCATION_MARKER), "turn 1 must truncate")
        const frozen = state.stickyTruncations["call-big-read"]
        assert.ok(typeof frozen === "string", "truncation must be frozen in state.stickyTruncations")
        assert.ok(
            !frozen.includes("dcp-message-id"),
            "frozen value must be tag-free (recorded before injectMessageIds)",
        )

        // ── Turn 2: usage now reflects the TRUNCATED request (smaller), so the
        // guards alone would NOT truncate — the pristine A from the session
        // store would be restored (the #485 oscillation). Stickiness must
        // replay B byte-identically instead.
        const turn2 = {
            messages: [
                makeUserMessage("u1", "Hello"),
                makeAssistantMessage("a1", "Reading files", [
                    makeToolPart("call-big-read", "read", BIG_TOOL_OUTPUT),
                ]),
                makeAssistantMessage("a2", "Done reading"),
                makeAssistantMessage("a3", "Summary so far", [], { input: 3_000, output: 50 }),
                makeUserMessage("u2", "Continue the analysis"),
            ],
        }
        await handler({}, turn2)
        const turn2Output = (
            (turn2.messages[1] as WithParts).parts.find((p: any) => p.type === "tool") as any
        ).state.output as string
        assert.ok(
            turn2Output.includes(TRUNCATION_MARKER),
            "turn 2 must stay truncated (sticky replay), not restore the full output",
        )
        // Byte-identical wire view across consecutive requests → prefix cache
        // stays valid from this message onward.
        assert.equal(turn2Output, turn1Output)
        assert.equal(state.stickyTruncations["call-big-read"], frozen)
    } finally {
        rmSync(tempDir, { recursive: true, force: true })
    }
})

test("sticky: frozen map stays empty when the switch is off", async () => {
    const { state, handler, tempDir } = setupPipeline(buildConfig())
    try {
        const output = { messages: buildScenarioMessages() }
        await handler({}, output)
        assert.equal(Object.keys(state.stickyTruncations).length, 0)
    } finally {
        rmSync(tempDir, { recursive: true, force: true })
    }
})

test("sticky: unit — replay overwrites non-string outputs, prunes vanished calls", () => {
    const state = createSessionState()
    state.stickyTruncations = {
        "call-keep": "frozen output",
        "call-obj": "frozen stringified form",
        "call-vanished": "gone",
    }
    const messages = [
        {
            info: { id: "m1", role: "user" },
            parts: [
                {
                    type: "tool",
                    callID: "call-keep",
                    state: { output: "full pristine output" },
                },
                // [#485 review] A frozen entry (guard stringified + truncated)
                // must overwrite a pristine NON-string output too, or the
                // A→B→A flip survives for object-shaped outputs.
                {
                    type: "tool",
                    callID: "call-obj",
                    state: { output: { lines: ["a", "b"] } },
                },
                { type: "tool", callID: "call-bad", state: { output: 12345 } },
            ],
        },
    ] as unknown as WithParts[]

    applyStickyTruncations(state, messages, new Logger(false))

    const toolParts = (messages[0] as { parts: any[] }).parts
    assert.equal(toolParts[0].state.output, "frozen output")
    assert.equal(
        toolParts[1].state.output,
        "frozen stringified form",
        "frozen entry must overwrite a non-string pristine output",
    )
    assert.equal(toolParts[2].state.output, 12345, "calls without a frozen entry are left alone")
    assert.equal(state.stickyTruncations["call-vanished"], undefined, "vanished call pruned")
    assert.ok("call-keep" in state.stickyTruncations)
})

test("sticky: unit — record freezes only outputs the guards changed", () => {
    const state = createSessionState()
    const before = new Map([
        ["call-a", "original a"],
        ["call-b", "original b"],
    ])
    const messages = [
        {
            info: { id: "m1", role: "user" },
            parts: [
                { type: "tool", callID: "call-a", state: { status: "completed", output: "truncated a" } },
                { type: "tool", callID: "call-b", state: { status: "completed", output: "original b" } },
                { type: "tool", callID: "call-new", state: { status: "completed", output: "new output" } },
                // Object-shaped output: snapshot must store its stringified
                // form so a guard truncating it later is detected as a change.
                {
                    type: "tool",
                    callID: "call-obj",
                    state: { status: "completed", output: { lines: ["a", "b"] } },
                },
            ],
        },
    ] as unknown as WithParts[]

    recordStickyTruncations(state, messages, before, new Logger(false))

    assert.equal(state.stickyTruncations["call-a"], "truncated a")
    assert.equal(state.stickyTruncations["call-b"], undefined, "unchanged output is not frozen")
    assert.equal(
        state.stickyTruncations["call-new"],
        undefined,
        "outputs absent from the snapshot (guards cannot have touched them) are not frozen",
    )

    // snapshotToolOutputs covers exactly the snapshot-eligible parts,
    // stringifying non-string outputs the way the guards do.
    const snapshot = snapshotToolOutputs(messages)
    assert.deepEqual(
        [...snapshot.entries()],
        [
            ["call-a", "truncated a"],
            ["call-b", "original b"],
            ["call-new", "new output"],
            ["call-obj", '{"lines":["a","b"]}'],
        ],
    )
})

test("sticky: freezing a truncation persists state in the same request (quiet session)", async () => {
    // [#485 review Major 1] Every other save trigger in the transform hook
    // fires EARLIER than recordStickyTruncations. The init-time "always save"
    // (state.ts Bug 1) only coincidentally carries turn-1 freezes (the save
    // snapshot aliases the live sticky map until the queue drains). The real
    // failure needs a LATER request that freezes with no other trigger:
    // without the explicit save, the new entry never reaches disk and a
    // restart replays pristine A once — the exact #485 flip.
    const { loadSessionState } = await import("../lib/state/persistence")
    const switchOn = buildConfig()
    switchOn.compress.emergencyTruncation = true
    const { state, handler, tempDir } = setupPipeline(switchOn)
    try {
        // Turn 1: nothing oversized — initializes the session state (and its
        // baseline disk save), freezes nothing.
        await handler(
            {},
            {
                messages: [
                    makeUserMessage("u1", "Hello"),
                    makeAssistantMessage("a1", "small"),
                    makeUserMessage("u2", "Continue"),
                ],
            },
        )
        assert.equal(Object.keys(state.stickyTruncations).length, 0)
        // Let the init save drain fully so it cannot alias later freezes.
        await new Promise((resolve) => setTimeout(resolve, 100))

        // Turn 2: pristine oversized output — must freeze AND persist in THIS
        // request; no other save trigger exists in this turn.
        const output = { messages: buildScenarioMessages() }
        await handler({}, output)
        assert.equal(Object.keys(state.stickyTruncations).length, 1, "one entry frozen")

        let persisted = null
        for (let i = 0; i < 100 && persisted === null; i++) {
            await new Promise((resolve) => setTimeout(resolve, 20))
            persisted = await loadSessionState(SID, new Logger(false))
        }
        assert.ok(persisted, "state file must exist on disk after the truncating request")
        assert.ok(persisted!.stickyTruncations?.["call-big-read"], "frozen entry persisted")
    } finally {
        rmSync(tempDir, { recursive: true, force: true })
    }
})

test("switch honors the provider/model override cascade", async () => {
    // [#485 review Major 2] compress.providers.<provider>.emergencyTruncation
    // must actually gate the guards, not just validate.
    const withOverride = buildConfig()
    withOverride.compress.emergencyTruncation = false // global OFF
    ;(withOverride.compress as any).providers = {
        "test-provider": { emergencyTruncation: true },
    }

    const { state, handler, tempDir } = setupPipeline(withOverride)
    try {
        const output = { messages: buildScenarioMessages() }
        await handler({}, output)
        const toolPart = (output.messages[1] as WithParts).parts.find(
            (p: any) => p.type === "tool",
        ) as any
        assert.ok(
            toolPart.state.output.includes(TRUNCATION_MARKER),
            "provider-level override must enable the guards",
        )
        assert.ok(state.stickyTruncations["call-big-read"], "truncation frozen")
    } finally {
        rmSync(tempDir, { recursive: true, force: true })
    }

    // Negative control: an override for a DIFFERENT provider stays off.
    const otherProvider = buildConfig()
    otherProvider.compress.emergencyTruncation = false
    ;(otherProvider.compress as any).providers = {
        "other-provider": { emergencyTruncation: true },
    }
    const { state: state2, handler: handler2, tempDir: tempDir2 } = setupPipeline(otherProvider)
    try {
        const output = { messages: buildScenarioMessages() }
        await handler2({}, output)
        const toolPart = (output.messages[1] as WithParts).parts.find(
            (p: any) => p.type === "tool",
        ) as any
        assert.ok(
            !toolPart.state.output.includes(TRUNCATION_MARKER),
            "override for another provider must not enable the guards",
        )
        assert.equal(Object.keys(state2.stickyTruncations).length, 0)
    } finally {
        rmSync(tempDir2, { recursive: true, force: true })
    }
})

test("sticky: fork sessions inherit the parent's frozen truncations", async () => {
    // [#485 review Minor 4] The fork branch of ensureSessionInitialized
    // returns before the regular sticky restore, so parent entries must be
    // copied explicitly.
    const { saveSessionState } = await import("../lib/state/persistence")
    const { ensureSessionInitialized } = await import("../lib/state/state")
    const dataHome = mkdtempSync(join(tmpdir(), "acp-sticky-fork-"))
    const savedDataHome = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = dataHome
    const logger = new Logger(false)
    try {
        const parent = createSessionState()
        parent.sessionId = "parent-sid"
        parent.stickyTruncations = { "call-parent": "frozen parent output" }
        await saveSessionState(parent, logger)

        const child = createSessionState()
        const forkClient = {
            session: {
                get: async () => ({ data: { parentID: "parent-sid" } }),
                messages: async () => ({ data: [] }),
            },
        }
        await ensureSessionInitialized(forkClient, child, "fork-sid", logger, [], buildConfig())
        assert.equal(
            child.stickyTruncations["call-parent"],
            "frozen parent output",
            "fork inherits parent sticky map",
        )
    } finally {
        if (savedDataHome === undefined) delete process.env.XDG_DATA_HOME
        else process.env.XDG_DATA_HOME = savedDataHome
        rmSync(dataHome, { recursive: true, force: true })
    }
})

test("GC path never truncates compress tool outputs", async () => {
    // [#485 review observation 8] truncateLargeToolOutputs must exclude
    // part.tool === "compress" like enforceContextBudget does — with sticky
    // truncation on, a truncated compress summary would be frozen forever.
    const { truncateLargeToolOutputs } = await import("../lib/messages/truncate-tools")
    const state = createSessionState()
    state.modelContextLimit = 40_000
    const config = buildConfig()
    const logger = new Logger(false)

    // Varied text, not 'x'.repeat(): countTokens uses the REAL tokenizer and
    // BPE collapses uniform runs into a handful of tokens (below the 1,000
    // token candidate floor). ~15.4k chars ≈ 3.9k real tokens per output.
    const big = "line of file content\n".repeat(700)
    // The GC guard gates on provider-REPORTED usage when present (the
    // fallback estimator undercounts tool outputs). Seed the last assistant
    // with 30k reported tokens so currentTokens (30,050) crosses the
    // threshold: min(100%×40k, 40k − 16,384) = 23,616.
    const messages: WithParts[] = [makeUserMessage("u1", "Hello")]
    for (let i = 1; i <= 6; i++) {
        messages.push(
            makeAssistantMessage(`m${i}`, "working", [
                makeToolPart(`call-${i}`, i === 3 ? "compress" : "read", big),
            ]),
        )
    }
    messages.push(
        makeAssistantMessage("f1", "tail", [], { input: 0, output: 0 }),
        makeAssistantMessage("f2", "tail", [], { input: 0, output: 0 }),
        makeAssistantMessage("f3", "tail", [], { input: 30_000, output: 50 }),
    )

    truncateLargeToolOutputs(state, config, logger, messages)

    let truncatedCount = 0
    for (let i = 1; i <= 6; i++) {
        const part = (messages[i] as WithParts).parts.find((p: any) => p.type === "tool") as any
        if (i === 3) {
            assert.equal(
                part.state.output,
                big,
                "compress tool output must never be truncated",
            )
        } else if (part.state.output.includes(TRUNCATION_MARKER)) {
            truncatedCount++
        }
    }
    assert.ok(truncatedCount >= 1, "non-compress oversized outputs are still truncated")
})
