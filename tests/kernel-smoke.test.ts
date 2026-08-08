import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import type { WithParts } from "../lib/state"
import { withPartsToCoreMessages, reconstructMessages, resolveKernelConfig } from "../lib/kernel"
import { createCore, createInitialState } from "acp-kernel"
import { countTokens } from "../lib/token-utils"

function buildConfig(overrides: { preserveRecentMessages?: number; preserveRecentTokens?: number; maxContextLimit?: number | `${number}%`; minContextLimit?: number | `${number}%` } = {}): PluginConfig {
    return {
        enabled: true,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: { enabled: true, protectedTools: [] },
        experimental: { allowSubAgents: false, customPrompts: false },
        protectedFilePatterns: [],
        compress: {
            mode: "range",
            permission: "allow",
            showCompression: false,
            summaryBuffer: true,
            maxContextLimit: overrides.maxContextLimit ?? "55%",
            minContextLimit: overrides.minContextLimit ?? "45%",
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: ["task"],
            protectTags: false,
            protectUserMessages: false,
            preserveRecentMessages: overrides.preserveRecentMessages ?? 2,
            preserveRecentTokens: overrides.preserveRecentTokens ?? 0,
        },
        gc: {
            algorithm: "truncate",
            promotionThreshold: 5,
            maxBlockAge: 15,
            maxOldGenSummaryLength: 3000,
            majorGcThresholdPercent: "100%",
        },
    } as PluginConfig
}

function userMsg(id: string, text: string): WithParts {
    return {
        info: { id, role: "user", sessionID: "ses_smoke", time: { created: 1 } } as WithParts["info"],
        parts: [{ type: "text", text, id: `${id}-p`, messageID: id, sessionID: "ses_smoke" }] as WithParts["parts"],
    }
}

function assistantToolMsg(id: string, callID: string, output: string): WithParts {
    return {
        info: { id, role: "assistant", sessionID: "ses_smoke", time: { created: 2 } } as WithParts["info"],
        parts: [
            { type: "tool", tool: "bash", callID, state: { status: "completed", input: "ls", output, time: { start: 1, end: 2 } } },
        ] as WithParts["parts"],
    }
}

const REF_TAG = /<acp[^>]*>(m\d{1,5})<\/acp>/
function extractRefs(cores: { text?: string }[]): string[] {
    const refs: string[] = []
    for (const c of cores) {
        const m = typeof c.text === "string" ? c.text.match(REF_TAG) : null
        if (m) refs.push(m[1]!)
    }
    return refs
}

test("withPartsToCoreMessages: user text becomes a single text core", () => {
    const cores = withPartsToCoreMessages([userMsg("u1", "hello world")])
    assert.equal(cores.length, 1)
    assert.equal(cores[0]!.role, "user")
    assert.equal(cores[0]!.contentType, "text")
    assert.match(cores[0]!.text ?? "", /hello world/)
})

test("withPartsToCoreMessages: completed tool expands to tool-call + tool-result cores sharing toolCallId", () => {
    const cores = withPartsToCoreMessages([assistantToolMsg("a1", "call_1", "file.txt")])
    assert.equal(cores.length, 2)
    assert.equal(cores[0]!.contentType, "tool-call")
    assert.equal(cores[1]!.contentType, "tool-result")
    assert.equal(cores[0]!.toolCallId, "call_1")
    assert.equal(cores[1]!.toolCallId, "call_1")
})

test("resolveKernelConfig: maps modelContextLimit and force-protects compress", () => {
    const cfg = resolveKernelConfig(buildConfig(), 200000)
    assert.equal(cfg.modelContextLimit, 200000)
    assert.ok(cfg.protectedTools.includes("compress"), "compress must always be protected")
})

test("resolveKernelConfig: falls back when model limit is missing", () => {
    const cfg = resolveKernelConfig(buildConfig(), undefined)
    assert.ok(cfg.modelContextLimit > 0)
})

test("processTurn: assigns refs and burns them into core text", () => {
    const core = createCore({ countTokens })
    const messages = [userMsg("u1", "first message"), userMsg("u2", "second message")]
    const coreMessages = withPartsToCoreMessages(messages)
    const state = createInitialState()
    const config = resolveKernelConfig(buildConfig({ preserveRecentMessages: 0 }), 200000)
    const result = core.processTurn({ messages: coreMessages, state, config, tokenCount: 100 })
    const refs = extractRefs(result.messages)
    assert.equal(refs.length, 2, "every surviving message should carry a burned ref")
    assert.notEqual(refs[0], refs[1])
})

test("applyCompression: end-to-end creates a block covering the requested range", () => {
    const core = createCore({ countTokens })
    const messages: WithParts[] = []
    for (let i = 1; i <= 8; i++) messages.push(userMsg(`u${i}`, `message number ${i} with some words`))
    const coreMessages = withPartsToCoreMessages(messages)
    const state = createInitialState()
    const config = resolveKernelConfig(buildConfig({ preserveRecentMessages: 2 }), 200000)

    const turn = core.processTurn({ messages: coreMessages, state, config, tokenCount: 200 })
    const refs = extractRefs(turn.messages)
    assert.ok(refs.length >= 5, "expected at least 5 ref-tagged messages")

    const startRef = refs[0]!
    const endRef = refs[2]!
    const summary = "Compressed the first three user messages which introduced the smoke-test scenario and initial greeting text."
    const compressed = core.applyCompression({
        ranges: [{ startRef, endRef, summary, topic: "intro" }],
        messages: turn.messages,
        state: turn.state,
        config,
    })

    assert.equal(compressed.result.errors.length, 0, `unexpected errors: ${compressed.result.errors.join("; ")}`)
    assert.equal(compressed.result.blocksCreated, 1)
    assert.equal(compressed.state.blocks.length, 1)
    const block = compressed.state.blocks[0]!
    assert.ok(block.effectiveMessageIds.length >= 3, "block should cover the compressed range")
})

test("reconstructMessages: round-trips surviving messages back to WithParts with burned tags", () => {
    const core = createCore({ countTokens })
    const messages = [userMsg("u1", "alpha"), userMsg("u2", "beta")]
    const originalById = new Map(messages.map((m) => [m.info.id, m]))
    const coreMessages = withPartsToCoreMessages(messages)
    const state = createInitialState()
    const config = resolveKernelConfig(buildConfig({ preserveRecentMessages: 0 }), 200000)
    const result = core.processTurn({ messages: coreMessages, state, config, tokenCount: 50 })
    const { messages: reconstructed, survivingIds } = reconstructMessages(result.messages, originalById)
    assert.equal(reconstructed.length, 2)
    assert.equal(survivingIds.length, 2)
    const firstText = (reconstructed[0]!.parts as Array<{ type: string; text?: string }>).find((p) => p.type === "text")?.text ?? ""
    assert.match(firstText, /<acp[^>]*>m\d{1,5}<\/acp>/, "reconstructed message should carry the burned ref tag")
})
