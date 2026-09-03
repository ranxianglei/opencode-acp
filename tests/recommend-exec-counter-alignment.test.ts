import assert from "node:assert/strict"
import test from "node:test"
import { createSessionState } from "../lib/state"
import type { WithParts } from "../lib/state"
import { assignMessageRefs } from "../lib/message-ids"
import { COMPACTED_TOOL_OUTPUT_PLACEHOLDER, countMessageCharacters } from "../lib/token-utils"
import {
    buildCompressibleRanges,
    filterRecommendedRanges,
    resolveEffectiveFloor,
    type CompressibleRange,
} from "../lib/messages/inject/utils"

/**
 * Issue #359 regression: the nudge/acp_status recommendation side and the
 * compress pipeline execution side must size ranges with the SAME counter.
 *
 * Pre-fix, buildCompressibleRanges sized non-text parts with
 * JSON.stringify(whole part).length / 4 — which includes the part wrapper
 * fields (type/tool/callID/state.status/...) plus JSON escaping of the
 * content (every \n and " in tool output/error costs an extra char). That
 * systematically overstated tool-heavy ranges (~10–40%), so sub-floor
 * ranges passed the recommendation floor (minCompressRange ÷ 4) and were
 * then rejected by the pipeline's min-size check ("Range too small"),
 * inviting guaranteed-failed retry loops (#37 ses_7fb5cbc8, #355 incident
 * v1.14.26: 2760 exec chars rejected against min 3000 while the nudge had
 * recommended the range).
 *
 * These tests pin the shared-counter contract with the four fixture shapes
 * named in the issue: pure text / completed tool / error-state with stack /
 * deeply nested JSON output — plus the incident-shape gate-equivalence case.
 * Single-message fixtures assert exact equality; multi-message ranges allow
 * the per-message rounding band (±0.5 tokens/message), which is the only
 * residual divergence from the pipeline's whole-range char sum.
 */

const SID = "ses-recommend-exec-align-359"

function makeMsg(
    id: string,
    role: "user" | "assistant",
    text: string,
    toolParts: any[] = [],
): WithParts {
    const parts: any[] = []
    if (text) parts.push({ type: "text", text })
    for (const tp of toolParts) parts.push(tp)
    return {
        info: { id, role, sessionID: SID, agent: "a", time: { created: 1 } } as any,
        parts,
    } as WithParts
}

function completedToolPart(callID: string, tool: string, input?: any, output?: any): any {
    return { type: "tool", callID, tool, state: { status: "completed", input, output } }
}

function erroredToolPart(callID: string, tool: string, input: any, error: string): any {
    return { type: "tool", callID, tool, state: { status: "error", input, error } }
}

/** Replicates the PRE-FIX estimator (JSON.stringify of the whole part) so
 *  tests can prove a fixture would have been mis-sized before the fix. */
function legacyPartTokens(part: any): number {
    if (part.type === "text" && typeof part.text === "string") {
        return Math.round(part.text.length / 4)
    }
    if (part.type !== "text" && part.type !== "reasoning") {
        return Math.round(JSON.stringify(part).length / 4)
    }
    return 0
}

function legacyMessageTokens(msg: WithParts): number {
    return (msg.parts || []).reduce((sum, p) => sum + legacyPartTokens(p), 0)
}

function buildSession(messages: WithParts[]) {
    const state = createSessionState()
    assignMessageRefs(state, messages)
    return state
}

// ---------------------------------------------------------------------------
// Fixture shape 1: pure text
// ---------------------------------------------------------------------------

test("#359 pure-text message: rec-side tokens equal exec-side countMessageCharacters ÷ 4", () => {
    const text = "The compression pipeline resolves boundary refs to message indices. ".repeat(60)
    const userMsg = makeMsg("m1", "user", "please summarize the exploration above")
    const textMsg = makeMsg("m2", "assistant", text)
    const state = buildSession([userMsg, textMsg])

    const { compressible } = buildCompressibleRanges([userMsg, textMsg], state)
    assert.equal(compressible.length, 1, "single compressible range")
    const range = compressible[0]

    const execChars = countMessageCharacters(textMsg)
    assert.equal(execChars, text.length, "exec counter counts full text length")
    assert.equal(range.effectiveTokens, Math.round(text.length / 4), "rec-side uses same counter")
})

test("#359 pure-text: new counter identical to pre-fix estimator (no behavior change for text)", () => {
    const text = "plain words, no tool parts involved here at all. ".repeat(50)
    const textMsg = makeMsg("m1", "assistant", text)
    const state = buildSession([makeMsg("u1", "user", "hi"), textMsg])

    const { compressible } = buildCompressibleRanges([makeMsg("u1", "user", "hi"), textMsg], state)
    assert.equal(
        compressible[0].effectiveTokens,
        legacyMessageTokens(textMsg),
        "text-only sizing unchanged",
    )
})

// ---------------------------------------------------------------------------
// Fixture shape 2: completed tool with string output
// ---------------------------------------------------------------------------

test("#359 completed tool (object input + multiline string output): rec == exec counter", () => {
    const output = Array.from({ length: 300 }, (_, i) => `line ${i}: npm test output data`).join(
        "\n",
    )
    const toolMsg = makeMsg("m2", "assistant", "", [
        completedToolPart("t1", "bash", { command: "npm test" }, output),
    ])
    const userMsg = makeMsg("m1", "user", "run the tests")
    const state = buildSession([userMsg, toolMsg])

    const { compressible } = buildCompressibleRanges([userMsg, toolMsg], state)
    const execChars = countMessageCharacters(toolMsg)
    const expected = JSON.stringify({ command: "npm test" }).length + output.length
    assert.equal(execChars, expected, "exec counter = stringified input + raw output length")
    assert.equal(
        compressible[0].effectiveTokens,
        Math.round(execChars / 4),
        "rec-side uses same counter",
    )

    // Sanity: the pre-fix estimator OVERSTATED this part (escaping + wrapper).
    assert.ok(
        legacyMessageTokens(toolMsg) > compressible[0].effectiveTokens,
        "fixture exhibits the #359 overstatement",
    )
})

// ---------------------------------------------------------------------------
// Fixture shape 3: error-state tool with multi-line stack trace
// ---------------------------------------------------------------------------

test("#359 error-state tool (stack trace): rec == exec counter", () => {
    const stack =
        "Error: fetch failed\n" +
        Array.from(
            { length: 40 },
            (_, i) => `    at async Step.${i} (file:///app/src/probe.js:${100 + i}:${3})`,
        ).join("\n") +
        "\nCaused by: ConnectTimeoutError: connect ETIMEDOUT 10.0.0.1:443"
    const toolMsg = makeMsg("m2", "assistant", "", [
        erroredToolPart(
            "t1",
            "webfetch",
            { url: "https://api.github.com/repos/x/y/issues" },
            stack,
        ),
    ])
    const userMsg = makeMsg("m1", "user", "fetch the issue")
    const state = buildSession([userMsg, toolMsg])

    const { compressible } = buildCompressibleRanges([userMsg, toolMsg], state)
    const execChars = countMessageCharacters(toolMsg)
    const expected =
        JSON.stringify({ url: "https://api.github.com/repos/x/y/issues" }).length + stack.length
    assert.equal(execChars, expected, "exec counter = stringified input + raw error body")
    assert.equal(
        compressible[0].effectiveTokens,
        Math.round(execChars / 4),
        "rec-side uses same counter",
    )
    assert.ok(
        legacyMessageTokens(toolMsg) > compressible[0].effectiveTokens,
        "fixture exhibits the #359 overstatement",
    )
})

// ---------------------------------------------------------------------------
// Fixture shape 4: deeply nested JSON object output
// ---------------------------------------------------------------------------

test("#359 deeply nested JSON object output: rec == exec counter", () => {
    let deep: any = "leaf"
    for (let level = 0; level < 8; level++) {
        deep = {
            level,
            items: Array.from({ length: 5 }, (_, j) => ({
                id: j,
                note: `note-${level}-${j}`,
                tags: ["a", "b"],
            })),
            next: deep,
        }
    }
    const toolMsg = makeMsg("m2", "assistant", "", [
        completedToolPart(
            "t1",
            "gh",
            { command: "gh issue view 355 --json title,body,labels" },
            deep,
        ),
    ])
    const userMsg = makeMsg("m1", "user", "view the issue")
    const state = buildSession([userMsg, toolMsg])

    const { compressible } = buildCompressibleRanges([userMsg, toolMsg], state)
    const execChars = countMessageCharacters(toolMsg)
    const expected =
        JSON.stringify({ command: "gh issue view 355 --json title,body,labels" }).length +
        JSON.stringify(deep).length
    assert.equal(
        execChars,
        expected,
        "exec counter = stringified input + stringified object output",
    )
    assert.equal(
        compressible[0].effectiveTokens,
        Math.round(execChars / 4),
        "rec-side uses same counter",
    )
    assert.ok(
        legacyMessageTokens(toolMsg) > compressible[0].effectiveTokens,
        "fixture exhibits the #359 overstatement",
    )
})

// ---------------------------------------------------------------------------
// Fixture shape 5: compacted tool output (placeholder path)
// ---------------------------------------------------------------------------

test("#359 compacted tool output: exec counts placeholder, rec matches", () => {
    const bigOutput = "x".repeat(5000)
    const toolMsg = makeMsg("m2", "assistant", "", [
        {
            type: "tool",
            callID: "t1",
            tool: "read",
            state: {
                status: "completed",
                input: { filePath: "/tmp/big.log" },
                output: bigOutput,
                time: { compacted: true },
            },
        },
    ])
    const userMsg = makeMsg("m1", "user", "read the log")
    const state = buildSession([userMsg, toolMsg])

    const { compressible } = buildCompressibleRanges([userMsg, toolMsg], state)
    const execChars = countMessageCharacters(toolMsg)
    const expected =
        JSON.stringify({ filePath: "/tmp/big.log" }).length +
        COMPACTED_TOOL_OUTPUT_PLACEHOLDER.length
    assert.equal(
        execChars,
        expected,
        "exec counter = stringified input + compacted placeholder (not full output)",
    )
    assert.equal(
        compressible[0].effectiveTokens,
        Math.round(execChars / 4),
        "rec-side uses same counter",
    )
    assert.ok(
        legacyMessageTokens(toolMsg) > compressible[0].effectiveTokens,
        "pre-fix estimator counted the full pre-compaction output",
    )
})

// ---------------------------------------------------------------------------
// Incident shape: tool-heavy range below the exec min-size threshold but
// above the floor under the pre-fix inflated estimator.
// Mirrors the #355 report (v1.14.26, min 3000): webfetch failure + gh JSON
// output + short summary, exec total 2760 chars → "Range too small".
// ---------------------------------------------------------------------------

const INCIDENT_MIN_COMPRESS_RANGE = 3000

// Triple constraint on this fixture (asserted dynamically inside the test):
// execChars < 3000 AND legacyEffective >= floor(750) AND post-fix
// effectiveTokens < 750. Current margins: exec 2866 (-134), legacy 780 (+30),
// post-fix 716 (-34). Legacy inflation is ~constant (~256 chars) for this
// shape, so keep future text edits within exec ∈ [~2744, 3000); the dynamic
// asserts fail loudly if an edit breaks any side.
function buildIncidentMessages(): WithParts[] {
    const stack =
        "Error: fetch failed\n" +
        Array.from(
            { length: 16 },
            (_, i) => `    at async Retry.${i} (file:///app/src/net.js:${50 + i}:${11})`,
        ).join("\n")
    const issueJson = JSON.stringify(
        {
            number: 355,
            title: "long-session gaps leave orphaned context between compression boundaries",
            body: Array.from(
                { length: 20 },
                (_, i) =>
                    `paragraph ${i}: observed residue near boundary m${String(i).padStart(5, "0")} in the exported transcript.`,
            ).join("\n"),
            labels: [{ name: "bug" }, { name: "context-pruning" }],
        },
        null,
        2,
    )
    return [
        makeMsg("m1", "user", "fetch the issue and summarize what you find"),
        makeMsg("m2", "assistant", "", [
            erroredToolPart("c1", "webfetch", { url: "https://example.invalid/issue/355" }, stack),
        ]),
        makeMsg("m3", "assistant", "", [
            completedToolPart("c2", "gh", { command: "gh issue view 355 --json" }, issueJson),
        ]),
        makeMsg(
            "m4",
            "assistant",
            "Summary: the issue reports residual context stranded between compression boundaries during long sessions.",
        ),
    ]
}

test("#359 incident shape: sub-floor tool-heavy range is NOT recommended (was recommended pre-fix)", () => {
    const messages = buildIncidentMessages()
    const state = buildSession(messages)
    const { compressible } = buildCompressibleRanges(messages, state)
    assert.equal(compressible.length, 1, "single range covering the whole span")
    const range = compressible[0]

    // Min-size-check counter over last-user-filtered survivors (the other soft
    // filters — protected tools / recent zone — are out of scope for this
    // shared-counter pin).
    const execChars = messages.slice(1).reduce((sum, m) => sum + countMessageCharacters(m), 0)
    assert.ok(
        execChars < INCIDENT_MIN_COMPRESS_RANGE,
        `fixture must sit below the exec threshold (got ${execChars} chars, min ${INCIDENT_MIN_COMPRESS_RANGE})`,
    )

    // Pre-fix estimator on the same messages WOULD have crossed the floor —
    // proving this fixture reproduces the incident's divergence.
    const legacyEffective = messages.slice(1).reduce((sum, m) => sum + legacyMessageTokens(m), 0)
    const floor = resolveEffectiveFloor({
        compress: { minCompressRange: INCIDENT_MIN_COMPRESS_RANGE },
    })
    assert.equal(floor, INCIDENT_MIN_COMPRESS_RANGE / 4, "floor derives from minCompressRange ÷ 4")
    assert.ok(
        legacyEffective >= floor,
        `pre-fix estimator (${legacyEffective} eff tokens) must have passed the floor (${floor})`,
    )

    // Post-fix: rec-side sizing equals exec sizing, so the gate agrees with
    // the pipeline and the range is dropped instead of recommended. Per-message
    // rounding keeps the deviation within ±0.5 tokens/message (≤ 2 chars/msg) —
    // orders of magnitude below the pre-fix systematic 10–40% overstatement.
    const survivingCount = messages.length - 1
    assert.ok(
        Math.abs(range.effectiveTokens - execChars / 4) <= survivingCount / 2,
        `rec-side ${range.effectiveTokens} eff tokens within per-message rounding band of exec ${execChars} chars`,
    )
    assert.ok(range.effectiveTokens < floor, "post-fix effective tokens below floor")
    const recommended = filterRecommendedRanges(compressible, [], {
        minEffectiveTokens: resolveEffectiveFloor({
            compress: { minCompressRange: INCIDENT_MIN_COMPRESS_RANGE },
        }),
    })
    assert.equal(
        recommended.length,
        0,
        "sub-floor tool-heavy range dropped — no guaranteed-failed compress call",
    )

    // Counterfactual: had the pre-fix inflated estimate reached the filter,
    // the same range would have been recommended.
    const legacyRange: CompressibleRange = { ...range, effectiveTokens: legacyEffective }
    const legacyRecommended = filterRecommendedRanges([legacyRange], [], {
        minEffectiveTokens: floor,
    })
    assert.equal(
        legacyRecommended.length,
        1,
        "pre-fix estimate would have been recommended (regression pinned)",
    )
})

// ---------------------------------------------------------------------------
// Protected branch: protected-tool message sizing uses the same counter
// ---------------------------------------------------------------------------

test("#359 protected branch: protected-range tokens equal exec-side countMessageCharacters ÷ 4", () => {
    const skillOutput = "skill guidance: always verify before finishing. ".repeat(60)
    const skillMsg = makeMsg("m3", "assistant", "", [
        completedToolPart("c1", "skill", { name: "verify" }, skillOutput),
    ])
    const messages = [
        makeMsg("m1", "user", "load the skill"),
        makeMsg("m2", "assistant", "on it"),
        skillMsg,
    ]
    const state = buildSession(messages)

    const { protected: protectedRanges } = buildCompressibleRanges(messages, state, ["skill"])
    assert.equal(protectedRanges.length, 1, "protected range tracked")
    const execChars = countMessageCharacters(skillMsg)
    assert.equal(
        protectedRanges[0].tokens,
        Math.round(execChars / 4),
        "protected branch uses the same shared counter",
    )
})
