import assert from "node:assert/strict"
import test from "node:test"
import { stripProtectedReasoning, stripStaleMetadata } from "../lib/messages/reasoning-strip"
import { mergeCompress, type CompressConfig } from "../lib/config"
import type { WithParts } from "../lib/state"

const SID = "ses-reasoning-strip"

function userMsg(id: string, modelID: string, providerID: string): WithParts {
    return {
        info: {
            id,
            role: "user",
            sessionID: SID,
            agent: "assistant",
            model: { modelID, providerID },
            time: { created: 1 },
        } as WithParts["info"],
        parts: [{ id: `${id}-p`, messageID: id, sessionID: SID, type: "text", text: "user text" }],
    }
}

function assistantMsg(
    id: string,
    modelID?: string,
    providerID?: string,
    parts?: any[],
): WithParts {
    const info: any = {
        id,
        role: "assistant",
        sessionID: SID,
        agent: "assistant",
        time: { created: 2 },
    }
    if (modelID !== undefined) info.modelID = modelID
    if (providerID !== undefined) info.providerID = providerID
    return {
        info,
        parts: parts ?? [
            { id: `${id}-p`, messageID: id, sessionID: SID, type: "text", text: "assistant text", metadata: { foo: "bar" } },
        ],
    }
}

function protectedToolMsg(id: string, reasoningText: string, tool = "compress"): WithParts {
    return {
        info: {
            id,
            role: "assistant",
            sessionID: SID,
            agent: "assistant",
            time: { created: 2 },
        } as WithParts["info"],
        parts: [
            { id: `${id}-reason`, messageID: id, sessionID: SID, type: "reasoning", text: reasoningText },
            { id: `${id}-tool`, messageID: id, sessionID: SID, type: "tool", tool, callID: `${id}-call`, state: { status: "completed", output: "ok" } },
        ],
    }
}

test("stripStaleMetadata is a no-op when no user message exists", () => {
    const messages: WithParts[] = [assistantMsg("a1", "model-a", "prov-a")]
    stripStaleMetadata(messages)
    assert.ok("metadata" in messages[0]!.parts[0]!, "metadata should remain when no user message")
})

test("stripStaleMetadata removes metadata from assistant parts with different model", () => {
    const messages: WithParts[] = [
        userMsg("u1", "claude-4", "anthropic"),
        assistantMsg("a1", "gpt-4", "openai"),
    ]
    stripStaleMetadata(messages)
    assert.ok(!("metadata" in messages[1]!.parts[0]!), "metadata should be stripped from different-model assistant")
})

test("stripStaleMetadata preserves metadata for same-model assistant parts", () => {
    const messages: WithParts[] = [
        userMsg("u1", "claude-4", "anthropic"),
        assistantMsg("a1", "claude-4", "anthropic"),
    ]
    stripStaleMetadata(messages)
    assert.ok("metadata" in messages[1]!.parts[0]!, "metadata should remain for same-model assistant")
})

test("stripStaleMetadata only strips from text/tool/reasoning parts", () => {
    const messages: WithParts[] = [
        userMsg("u1", "claude-4", "anthropic"),
        assistantMsg("a1", "gpt-4", "openai", [
            { id: "p1", messageID: "a1", sessionID: SID, type: "text", text: "text", metadata: { a: 1 } },
            { id: "p2", messageID: "a1", sessionID: SID, type: "tool", tool: "bash", callID: "c1", state: { status: "completed", output: "out" }, metadata: { b: 2 } },
            { id: "p3", messageID: "a1", sessionID: SID, type: "reasoning", text: "thinking", metadata: { c: 3 } },
            { id: "p4", messageID: "a1", sessionID: SID, type: "image", metadata: { d: 4 } },
        ]),
    ]
    stripStaleMetadata(messages)
    assert.ok(!("metadata" in messages[1]!.parts[0]!), "text metadata stripped")
    assert.ok(!("metadata" in messages[1]!.parts[1]!), "tool metadata stripped")
    assert.ok(!("metadata" in messages[1]!.parts[2]!), "reasoning metadata stripped")
    assert.ok("metadata" in messages[1]!.parts[3]!, "image metadata preserved (not text/tool/reasoning)")
})

test("stripStaleMetadata preserves parts without metadata property", () => {
    const messages: WithParts[] = [
        userMsg("u1", "claude-4", "anthropic"),
        assistantMsg("a1", "gpt-4", "openai", [
            { id: "p1", messageID: "a1", sessionID: SID, type: "text", text: "no metadata here" },
        ]),
    ]
    stripStaleMetadata(messages)
    assert.equal(messages[1]!.parts[0]!.type, "text", "part should still exist")
    assert.ok(!("metadata" in messages[1]!.parts[0]!), "part should not have metadata")
})

test("stripStaleMetadata handles undefined modelID/providerID (Bug 8 fix)", () => {
    const messages: WithParts[] = [
        userMsg("u1", "claude-4", "anthropic"),
        assistantMsg("a1"),
    ]
    stripStaleMetadata(messages)
    assert.ok(!("metadata" in messages[1]!.parts[0]!), "metadata stripped when assistant has no model info")
})

test("stripStaleMetadata only considers the last user message's model", () => {
    const messages: WithParts[] = [
        userMsg("u1", "gpt-4", "openai"),
        assistantMsg("a1", "gpt-4", "openai"),
        userMsg("u2", "claude-4", "anthropic"),
    ]
    stripStaleMetadata(messages)
    assert.ok(!("metadata" in messages[1]!.parts[0]!), "a1 metadata stripped (u2 has different model)")
})

const PROTECTED = ["compress", "skill"]

test("stripProtectedReasoning strips reasoning from a historical compress message above threshold", () => {
    const big = "x".repeat(3000)
    const messages: WithParts[] = [
        userMsg("u0", "claude-4", "anthropic"),
        protectedToolMsg("a1", big),
        userMsg("u1", "claude-4", "anthropic"),
    ]
    const removed = stripProtectedReasoning(messages, PROTECTED, 2048)
    assert.equal(removed, 1)
    assert.ok(!messages[1]!.parts.some((p) => p.type === "reasoning"), "reasoning removed")
    assert.ok(messages[1]!.parts.some((p) => p.type === "tool"), "tool call preserved")
})

test("stripProtectedReasoning never touches the current round (after the last user message)", () => {
    const big = "x".repeat(3000)
    const messages: WithParts[] = [
        userMsg("u0", "claude-4", "anthropic"),
        protectedToolMsg("a1", big),
        userMsg("u1", "claude-4", "anthropic"),
        protectedToolMsg("a2", big),
    ]
    const removed = stripProtectedReasoning(messages, PROTECTED, 2048)
    assert.equal(removed, 1, "only the historical message stripped")
    assert.ok(!messages[1]!.parts.some((p) => p.type === "reasoning"), "historical a1 stripped")
    assert.ok(messages[3]!.parts.some((p) => p.type === "reasoning"), "current-round a2 preserved")
})

test("stripProtectedReasoning no-op when the last user message is first (no history before it)", () => {
    const big = "x".repeat(3000)
    const messages: WithParts[] = [
        userMsg("u0", "claude-4", "anthropic"),
        protectedToolMsg("a1", big),
    ]
    const removed = stripProtectedReasoning(messages, PROTECTED, 2048)
    assert.equal(removed, 0, "no historical messages before the only user message")
    assert.ok(messages[1]!.parts.some((p) => p.type === "reasoning"), "a1 (current round) preserved")
})

test("stripProtectedReasoning anchors on the last GENUINE user message (skips synthetic)", () => {
    const big = "x".repeat(3000)
    const synthetic: WithParts = {
        info: {
            id: "msg_acp_recap_1",
            role: "user",
            sessionID: SID,
            agent: "assistant",
            model: { modelID: "claude-4", providerID: "anthropic" },
            time: { created: 3 },
        } as WithParts["info"],
        parts: [{ id: "syn-p", messageID: "msg_acp_recap_1", sessionID: SID, type: "text", text: "recap" }],
    }
    const messages: WithParts[] = [
        userMsg("u0", "claude-4", "anthropic"),
        protectedToolMsg("a1", big),
        userMsg("u1", "claude-4", "anthropic"),
        protectedToolMsg("a2", big),
        synthetic,
        protectedToolMsg("a3", big),
    ]
    const removed = stripProtectedReasoning(messages, PROTECTED, 2048)
    assert.equal(removed, 1, "only a1 (before the last genuine user message u1) stripped")
    assert.ok(!messages[1]!.parts.some((p) => p.type === "reasoning"), "a1 stripped")
    assert.ok(messages[3]!.parts.some((p) => p.type === "reasoning"), "a2 (after u1, before synthetic) preserved")
    assert.ok(messages[5]!.parts.some((p) => p.type === "reasoning"), "a3 (current round) preserved")
})

test("stripProtectedReasoning leaves small reasoning untouched (<= threshold)", () => {
    const small = "x".repeat(100)
    const messages: WithParts[] = [
        userMsg("u0", "claude-4", "anthropic"),
        protectedToolMsg("a1", small),
        userMsg("u1", "claude-4", "anthropic"),
    ]
    const removed = stripProtectedReasoning(messages, PROTECTED, 2048)
    assert.equal(removed, 0)
    assert.ok(messages[1]!.parts.some((p) => p.type === "reasoning"), "small reasoning preserved")
})

test("stripProtectedReasoning boundary: reasoning == threshold is NOT stripped (strict >)", () => {
    const exact = "x".repeat(2048)
    const messages: WithParts[] = [
        userMsg("u0", "claude-4", "anthropic"),
        protectedToolMsg("a1", exact),
        userMsg("u1", "claude-4", "anthropic"),
    ]
    assert.equal(stripProtectedReasoning(messages, PROTECTED, 2048), 0)
})

test("stripProtectedReasoning ignores non-protected tools (bash)", () => {
    const big = "x".repeat(3000)
    const messages: WithParts[] = [
        userMsg("u0", "claude-4", "anthropic"),
        protectedToolMsg("a1", big, "bash"),
        userMsg("u1", "claude-4", "anthropic"),
    ]
    const removed = stripProtectedReasoning(messages, PROTECTED, 2048)
    assert.equal(removed, 0)
    assert.ok(messages[1]!.parts.some((p) => p.type === "reasoning"), "bash reasoning preserved")
})

test("stripProtectedReasoning no-op when no user message exists", () => {
    const big = "x".repeat(3000)
    const messages: WithParts[] = [protectedToolMsg("a1", big)]
    assert.equal(stripProtectedReasoning(messages, PROTECTED, 2048), 0)
    assert.ok(messages[0]!.parts.some((p) => p.type === "reasoning"))
})

test("stripProtectedReasoning no-op when protectedTools is empty", () => {
    const big = "x".repeat(3000)
    const messages: WithParts[] = [
        userMsg("u0", "claude-4", "anthropic"),
        protectedToolMsg("a1", big),
        userMsg("u1", "claude-4", "anthropic"),
    ]
    assert.equal(stripProtectedReasoning(messages, [], 2048), 0)
})

test("stripProtectedReasoning preserves the tool call and non-reasoning parts", () => {
    const big = "x".repeat(3000)
    const messages: WithParts[] = [
        userMsg("u0", "claude-4", "anthropic"),
        {
            info: { id: "a1", role: "assistant", sessionID: SID, agent: "assistant", time: { created: 2 } } as WithParts["info"],
            parts: [
                { id: "a1-text", messageID: "a1", sessionID: SID, type: "text", text: "here is the summary" },
                { id: "a1-reason", messageID: "a1", sessionID: SID, type: "reasoning", text: big },
                { id: "a1-tool", messageID: "a1", sessionID: SID, type: "tool", tool: "compress", callID: "c1", state: { status: "completed", output: "ok" } },
            ],
        },
        userMsg("u1", "claude-4", "anthropic"),
    ]
    const removed = stripProtectedReasoning(messages, PROTECTED, 2048)
    assert.equal(removed, 1)
    assert.deepEqual(messages[1]!.parts.map((p) => p.type), ["text", "tool"], "text + tool preserved, reasoning removed")
})

test("stripProtectedReasoning is idempotent (second pass removes nothing)", () => {
    const big = "x".repeat(3000)
    const messages: WithParts[] = [
        userMsg("u0", "claude-4", "anthropic"),
        protectedToolMsg("a1", big),
        userMsg("u1", "claude-4", "anthropic"),
    ]
    const first = stripProtectedReasoning(messages, PROTECTED, 2048)
    const second = stripProtectedReasoning(messages, PROTECTED, 2048)
    assert.equal(first, 1)
    assert.equal(second, 0, "idempotent — nothing left to remove")
})

test("stripProtectedReasoning strips all qualifying historical messages (compress + skill)", () => {
    const big = "x".repeat(3000)
    const messages: WithParts[] = [
        userMsg("u0", "claude-4", "anthropic"),
        protectedToolMsg("a1", big, "compress"),
        protectedToolMsg("a2", big, "skill"),
        userMsg("u1", "claude-4", "anthropic"),
    ]
    const removed = stripProtectedReasoning(messages, PROTECTED, 2048)
    assert.equal(removed, 2)
    assert.ok(!messages[1]!.parts.some((p) => p.type === "reasoning"), "a1 stripped")
    assert.ok(!messages[2]!.parts.some((p) => p.type === "reasoning"), "a2 stripped")
})

test("stripProtectedReasoning multi-turn growth cycle: closed turns stripped, current round kept", () => {
    const big = "x".repeat(3000)
    const messages: WithParts[] = [
        userMsg("u0", "claude-4", "anthropic"),
        protectedToolMsg("a1", big),
        userMsg("u1", "claude-4", "anthropic"),
        protectedToolMsg("a2", big),
        userMsg("u2", "claude-4", "anthropic"),
        protectedToolMsg("a3", big),
    ]
    const removed = stripProtectedReasoning(messages, PROTECTED, 2048)
    assert.equal(removed, 2, "a1 and a2 (closed turns) stripped")
    assert.ok(!messages[1]!.parts.some((p) => p.type === "reasoning"), "a1 stripped")
    assert.ok(!messages[3]!.parts.some((p) => p.type === "reasoning"), "a2 stripped")
    assert.ok(messages[5]!.parts.some((p) => p.type === "reasoning"), "a3 (current round) preserved")
})

test("stripProtectedReasoning respects a custom threshold", () => {
    const mid = "x".repeat(5000)
    const mk = (): WithParts[] => [
        userMsg("u0", "claude-4", "anthropic"),
        protectedToolMsg("a1", mid),
        userMsg("u1", "claude-4", "anthropic"),
    ]
    assert.equal(stripProtectedReasoning(mk(), PROTECTED, 2048), 1, "stripped at 2048")
    assert.equal(stripProtectedReasoning(mk(), PROTECTED, 10000), 0, "not stripped at 10000")
})

test("stripProtectedReasoning sums reasoning length across multiple reasoning parts", () => {
    const messages: WithParts[] = [
        userMsg("u0", "claude-4", "anthropic"),
        {
            info: { id: "a1", role: "assistant", sessionID: SID, agent: "assistant", time: { created: 2 } } as WithParts["info"],
            parts: [
                { id: "a1-r1", messageID: "a1", sessionID: SID, type: "reasoning", text: "x".repeat(1500) },
                { id: "a1-r2", messageID: "a1", sessionID: SID, type: "reasoning", text: "x".repeat(1500) },
                { id: "a1-tool", messageID: "a1", sessionID: SID, type: "tool", tool: "compress", callID: "c1", state: { status: "completed", output: "ok" } },
            ],
        },
        userMsg("u1", "claude-4", "anthropic"),
    ]
    const removed = stripProtectedReasoning(messages, PROTECTED, 2048)
    assert.equal(removed, 2, "both reasoning parts removed (sum 3000 > 2048)")
    assert.ok(!messages[1]!.parts.some((p) => p.type === "reasoning"))
})

const cfgBase: CompressConfig = {
    permission: "allow",
    showCompression: true,
    summaryBuffer: true,
    maxContextLimit: "55%",
    minContextLimit: "45%",
    nudgeFrequency: 5,
    minNudgeContextPercent: 15,
    iterationNudgeThreshold: 15,
    nudgeForce: "soft",
    protectedTools: ["skill", "compress"],
    protectTags: false,
    protectUserMessages: false,
    maxSummaryLengthHard: 20000,
    minCompressRange: 5000,
    minNudgeGrowthRatio: 0.45,
    minNudgeGrowthFloor: 5000,
    emergencyThresholdPercent: "98%",
    maxVisibleSegments: 50,
    keepEmbedMaxChars: 2000,
    stripProtectedReasoning: true,
    stripProtectedReasoningThreshold: 0,
    stripProtectedReasoningProviders: ["anthropic", "gemini"],
    stripProtectedReasoningMinMessages: 100,
}

test("config: stripProtectedReasoning keys survive a no-op merge (defaults preserved)", () => {
    const merged = mergeCompress(cfgBase, {})
    assert.equal(merged.stripProtectedReasoning, true)
    assert.equal(merged.stripProtectedReasoningThreshold, 0)
    assert.deepEqual(merged.stripProtectedReasoningProviders, ["anthropic", "gemini"])
    assert.equal(merged.stripProtectedReasoningMinMessages, 100)
})

test("config: kill-switch override stripProtectedReasoning=false wins", () => {
    const merged = mergeCompress(cfgBase, { stripProtectedReasoning: false })
    assert.equal(merged.stripProtectedReasoning, false)
    assert.equal(merged.stripProtectedReasoningThreshold, 0, "threshold preserved")
})

test("config: custom threshold override wins, flag preserved", () => {
    const merged = mergeCompress(cfgBase, { stripProtectedReasoningThreshold: 5000 })
    assert.equal(merged.stripProtectedReasoningThreshold, 5000)
    assert.equal(merged.stripProtectedReasoning, true, "flag preserved")
})

test("config: explicit providers array replaces the default list (even empty)", () => {
    const replaced = mergeCompress(cfgBase, { stripProtectedReasoningProviders: ["zhipu"] })
    assert.deepEqual(replaced.stripProtectedReasoningProviders, ["zhipu"])
    const emptied = mergeCompress(cfgBase, { stripProtectedReasoningProviders: [] })
    assert.deepEqual(emptied.stripProtectedReasoningProviders, [], "explicit [] = strip for no provider")
})

test("config: minMessages override wins", () => {
    const merged = mergeCompress(cfgBase, { stripProtectedReasoningMinMessages: 0 })
    assert.equal(merged.stripProtectedReasoningMinMessages, 0)
})

// ─── Gate 4: provider allowlist (fail-closed) ───────────────────────────────

const OPT_ANTHROPIC = { allowedProviders: ["anthropic", "gemini"] }

function stripFixture(): WithParts[] {
    const big = "x".repeat(3000)
    return [
        userMsg("u0", "claude-4", "anthropic"),
        protectedToolMsg("a1", big),
        userMsg("u1", "claude-4", "anthropic"),
    ]
}

test("provider gate: strips when providerID matches an allowlist entry", () => {
    const messages = stripFixture()
    const removed = stripProtectedReasoning(messages, PROTECTED, 0, {
        ...OPT_ANTHROPIC,
        providerID: "anthropic",
    })
    assert.equal(removed, 1)
    assert.ok(!messages[1]!.parts.some((p) => p.type === "reasoning"), "stripped for allowlisted provider")
})

test("provider gate: fail-closed when providerID does not match", () => {
    const messages = stripFixture()
    const removed = stripProtectedReasoning(messages, PROTECTED, 0, {
        ...OPT_ANTHROPIC,
        providerID: "openai",
    })
    assert.equal(removed, 0)
    assert.ok(messages[1]!.parts.some((p) => p.type === "reasoning"), "preserved for non-allowlisted provider")
})

test("provider gate: fail-closed when providerID is undefined", () => {
    const messages = stripFixture()
    const removed = stripProtectedReasoning(messages, PROTECTED, 0, OPT_ANTHROPIC)
    assert.equal(removed, 0, "unknown provider must never be stripped (fail-closed)")
    assert.ok(messages[1]!.parts.some((p) => p.type === "reasoning"))
})

test("provider gate: empty allowlist strips nothing", () => {
    const messages = stripFixture()
    const removed = stripProtectedReasoning(messages, PROTECTED, 0, {
        allowedProviders: [],
        providerID: "anthropic",
    })
    assert.equal(removed, 0)
    assert.ok(messages[1]!.parts.some((p) => p.type === "reasoning"), "part itself is still present")
})

test("provider gate: '*' strips for any provider, including undefined", () => {
    for (const providerID of ["zhipu", "openai", undefined]) {
        const messages = stripFixture()
        const removed = stripProtectedReasoning(messages, PROTECTED, 0, {
            allowedProviders: ["*"],
            providerID,
        })
        assert.equal(removed, 1, `stripped for providerID=${String(providerID)}`)
    }
})

test("provider gate: matching is case-insensitive substring", () => {
    const messages = stripFixture()
    const removed = stripProtectedReasoning(messages, PROTECTED, 0, {
        allowedProviders: ["Anthropic"],
        providerID: "ANTHROPIC-claude",
    })
    assert.equal(removed, 1, "substring + case-insensitive entry matches")
})

test("provider gate: padded allowlist entries (and padded '*') are trimmed at match time", () => {
    const messages = stripFixture()
    const removed = stripProtectedReasoning(messages, PROTECTED, 0, {
        allowedProviders: ["  anthropic \t"],
        providerID: "anthropic-claude",
    })
    assert.equal(removed, 1, "padded entry still matches")

    const wildcard = stripFixture()
    assert.equal(
        stripProtectedReasoning(wildcard, PROTECTED, 0, {
            allowedProviders: [" * "],
            providerID: undefined,
        }),
        1,
        "padded '*' still short-circuits the gate",
    )
})

test("provider gate: omitted options keeps legacy ungated behavior (pure-function callers)", () => {
    const messages = stripFixture()
    const removed = stripProtectedReasoning(messages, PROTECTED, 0)
    assert.equal(removed, 1, "no options → no provider/activation gate")
})

// ─── Gate 5: session-size activation ───────────────────────────────────────

test("activation gate: below minMessages strips nothing", () => {
    const messages = stripFixture()
    const removed = stripProtectedReasoning(messages, PROTECTED, 0, {
        allowedProviders: ["*"],
        minMessages: 100,
    })
    assert.equal(removed, 0, "3-message fixture < 100 → no-op")
    assert.ok(messages[1]!.parts.some((p) => p.type === "reasoning"), "small session prefix untouched")
})

test("activation gate: at or above minMessages strips", () => {
    const messages = stripFixture()
    assert.equal(
        stripProtectedReasoning(messages, PROTECTED, 0, { allowedProviders: ["*"], minMessages: 3 }),
        1,
        "messages.length == minMessages (>=) → strips",
    )
    assert.ok(!messages[1]!.parts.some((p) => p.type === "reasoning"), "reasoning part actually removed")
})

test("activation gate: tight boundary — one below minMessages strips nothing", () => {
    // 3-message fixture, minMessages 4: the only difference from the >= case
    // above is the boundary itself. Catches < vs <= mutants precisely.
    const messages = stripFixture()
    assert.equal(
        stripProtectedReasoning(messages, PROTECTED, 0, { allowedProviders: ["*"], minMessages: 4 }),
        0,
        "messages.length == minMessages - 1 → no-op",
    )
    assert.ok(messages[1]!.parts.some((p) => p.type === "reasoning"), "small-session prefix untouched")
})

test("activation gate: 0 disables the gate", () => {
    const messages = stripFixture()
    assert.equal(
        stripProtectedReasoning(messages, PROTECTED, 0, { allowedProviders: ["*"], minMessages: 0 }),
        1,
    )
})

test("combined gates: provider mismatch wins even on a large session", () => {
    const big = "x".repeat(3000)
    const messages: WithParts[] = [userMsg("u0", "gpt-5", "openai")]
    for (let i = 0; i < 150; i++) {
        messages.push(protectedToolMsg(`a${i}`, big))
    }
    messages.push(userMsg("u1", "gpt-5", "openai"))
    const removed = stripProtectedReasoning(messages, PROTECTED, 0, {
        allowedProviders: ["anthropic", "gemini"],
        providerID: "openai",
        minMessages: 100,
    })
    assert.equal(removed, 0, "fail-closed provider gate blocks the strip regardless of session size")
})

test("default threshold 0 strips small historical reasoning too (activation gate is the cache lever)", () => {
    const small = "x".repeat(100)
    const messages: WithParts[] = [
        userMsg("u0", "claude-4", "anthropic"),
        protectedToolMsg("a1", small),
        userMsg("u1", "claude-4", "anthropic"),
    ]
    assert.equal(
        stripProtectedReasoning(messages, PROTECTED, 0, { allowedProviders: ["*"], minMessages: 0 }),
        1,
        "threshold 0 = strip regardless of reasoning size",
    )
})
