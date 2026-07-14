import assert from "node:assert/strict"
import test from "node:test"
import type { WithParts } from "../lib/state"
import type { SessionState } from "../lib/state"
import { buildVisibleSegments, formatVisibleGuidance } from "../lib/messages/inject/inject"

function mkText(id: string, text: string): WithParts {
    return {
        info: { id } as any,
        parts: [{ type: "text", text, id: `${id}-p`, sessionID: "s", messageID: id }] as any,
    }
}

function mkTool(id: string, raw: string): WithParts {
    return { info: { id } as any, parts: [{ type: "tool", tool: raw } as any] }
}

function mkState(pairs: [rawId: string, ref: string][]): SessionState {
    return {
        messageIds: { byRawId: new Map(pairs), byRef: new Map(), nextRef: 1 },
    } as any as SessionState
}

// ---------------- buildVisibleSegments ----------------

test("buildVisibleSegments: empty messages returns []", () => {
    assert.deepEqual(buildVisibleSegments(mkState([]), []), [])
})

test("buildVisibleSegments: single message -> one segment", () => {
    const state = mkState([["raw-1", "m00001"]])
    const segs = buildVisibleSegments(state, [mkText("raw-1", "hello")])
    assert.equal(segs.length, 1)
    assert.equal(segs[0].startRef, "m00001")
    assert.equal(segs[0].endRef, "m00001")
    assert.equal(segs[0].count, 1)
    assert.equal(segs[0].hasTool, false)
})

test("buildVisibleSegments: contiguous refs merge into one segment", () => {
    const state = mkState([
        ["raw-1", "m00001"],
        ["raw-2", "m00002"],
        ["raw-3", "m00003"],
    ])
    const segs = buildVisibleSegments(state, [
        mkText("raw-1", "a"),
        mkText("raw-2", "b"),
        mkText("raw-3", "c"),
    ])
    assert.equal(segs.length, 1)
    assert.equal(segs[0].startRef, "m00001")
    assert.equal(segs[0].endRef, "m00003")
    assert.equal(segs[0].count, 3)
})

test("buildVisibleSegments: hole between refs splits into two segments", () => {
    const state = mkState([
        ["raw-1", "m00001"],
        ["raw-3", "m00003"],
    ])
    const segs = buildVisibleSegments(state, [mkText("raw-1", "a"), mkText("raw-3", "c")])
    assert.equal(segs.length, 2)
    assert.equal(segs[0].startRef, "m00001")
    assert.equal(segs[0].endRef, "m00001")
    assert.equal(segs[1].startRef, "m00003")
    assert.equal(segs[1].endRef, "m00003")
})

test("buildVisibleSegments: hole with multi-msg segments on both sides", () => {
    const state = mkState([
        ["raw-1", "m00001"],
        ["raw-2", "m00002"],
        ["raw-5", "m00005"],
        ["raw-6", "m00006"],
        ["raw-7", "m00007"],
    ])
    const segs = buildVisibleSegments(state, [
        mkText("raw-1", "a"),
        mkText("raw-2", "b"),
        mkText("raw-5", "e"),
        mkText("raw-6", "f"),
        mkText("raw-7", "g"),
    ])
    assert.equal(segs.length, 2)
    assert.equal(segs[0].startRef, "m00001")
    assert.equal(segs[0].endRef, "m00002")
    assert.equal(segs[0].count, 2)
    assert.equal(segs[1].startRef, "m00005")
    assert.equal(segs[1].endRef, "m00007")
    assert.equal(segs[1].count, 3)
})

test("buildVisibleSegments: tool part marks segment hasTool=true", () => {
    const state = mkState([["raw-1", "m00001"]])
    const segs = buildVisibleSegments(state, [mkTool("raw-1", '{"output":"big result"}')])
    assert.equal(segs.length, 1)
    assert.equal(segs[0].hasTool, true)
})

test("buildVisibleSegments: tokens accumulate across messages in a segment", () => {
    const state = mkState([
        ["raw-1", "m00001"],
        ["raw-2", "m00002"],
    ])
    const segs = buildVisibleSegments(state, [
        mkText("raw-1", "x".repeat(400)),
        mkText("raw-2", "y".repeat(800)),
    ])
    assert.equal(segs.length, 1)
    assert.equal(segs[0].tokens, 100 + 200)
})

test("buildVisibleSegments: message without a ref is skipped", () => {
    const state = mkState([["raw-1", "m00001"]])
    const segs = buildVisibleSegments(state, [mkText("raw-1", "a"), mkText("raw-unmapped", "b")])
    assert.equal(segs.length, 1)
    assert.equal(segs[0].startRef, "m00001")
})

test("buildVisibleSegments: segments emitted in ascending ref order", () => {
    const state = mkState([
        ["raw-9", "m00009"],
        ["raw-1", "m00001"],
        ["raw-5", "m00005"],
    ])
    const segs = buildVisibleSegments(state, [
        mkText("raw-9", "z"),
        mkText("raw-1", "a"),
        mkText("raw-5", "e"),
    ])
    assert.deepEqual(
        segs.map((s) => s.startRef),
        ["m00001", "m00005", "m00009"],
    )
})

// ---------------- formatVisibleGuidance ----------------

test("formatVisibleGuidance: empty segments returns empty string", () => {
    assert.equal(formatVisibleGuidance([], 50), "")
})

test("formatVisibleGuidance: single segment singularizes msg/segment", () => {
    const out = formatVisibleGuidance(
        [{ startRef: "m00001", endRef: "m00001", count: 1, tokens: 10, hasTool: false }],
        50,
    )
    assert.equal(out, "[Visible: m00001 (1 msg, 1 segment)]")
})

test("formatVisibleGuidance: multiple segments pluralizes and joins ranges", () => {
    const out = formatVisibleGuidance(
        [
            { startRef: "m00001", endRef: "m00001", count: 1, tokens: 10, hasTool: false },
            { startRef: "m00003", endRef: "m00005", count: 3, tokens: 30, hasTool: false },
        ],
        50,
    )
    assert.equal(out, "[Visible: m00001, m00003–m00005 (4 msgs, 2 segments)]")
})

test("formatVisibleGuidance: exactly maxSegs shows all (no truncation)", () => {
    const segs = Array.from({ length: 50 }, (_, i) => ({
        startRef: `m${String(i + 1).padStart(5, "0")}`,
        endRef: `m${String(i + 1).padStart(5, "0")}`,
        count: 1,
        tokens: 10,
        hasTool: false,
    }))
    const out = formatVisibleGuidance(segs, 50)
    assert.ok(out.startsWith("[Visible:"))
    assert.ok(!out.includes("omitted"), "should not truncate at exactly maxSegs")
    assert.ok(out.includes("50 msgs, 50 segments"))
})

test("formatVisibleGuidance: over maxSegs truncates with omitted note", () => {
    const segs = Array.from({ length: 60 }, (_, i) => ({
        startRef: `m${String(i + 1).padStart(5, "0")}`,
        endRef: `m${String(i + 1).padStart(5, "0")}`,
        count: 1,
        tokens: 10,
        hasTool: false,
    }))
    const out = formatVisibleGuidance(segs, 50)
    assert.ok(out.startsWith("[Visible (top 50 of 60 segments, 60 msgs):"))
    assert.ok(out.includes("+10 smaller segments (~100 tokens, 10 msgs) omitted]"))
})

test("formatVisibleGuidance: truncation keeps tool-bearing segments, drops text-only small ones", () => {
    // 3 tool-bearing segments (high priority) + many tiny text-only segments.
    const toolSegs = [1, 5, 9].map((n) => ({
        startRef: `m${String(n).padStart(5, "0")}`,
        endRef: `m${String(n).padStart(5, "0")}`,
        count: 1,
        tokens: 5,
        hasTool: true,
    }))
    const textSegs = Array.from({ length: 55 }, (_, i) => ({
        startRef: `m${String(100 + i).padStart(5, "0")}`,
        endRef: `m${String(100 + i).padStart(5, "0")}`,
        count: 1,
        tokens: 2,
        hasTool: false,
    }))
    const out = formatVisibleGuidance([...toolSegs, ...textSegs], 50)
    // All 3 tool segments survive; only 47 of 55 text segments fit.
    assert.ok(out.includes("m00001"), "tool segment m00001 kept")
    assert.ok(out.includes("m00005"), "tool segment m00005 kept")
    assert.ok(out.includes("m00009"), "tool segment m00009 kept")
    assert.ok(out.includes("top 50 of 58 segments"))
    assert.ok(out.includes("+8 smaller segments"))
})

test("formatVisibleGuidance: truncation preserves ascending ref order in shown segments", () => {
    // Build segments where the kept set is non-contiguous so order matters.
    // Keep = large segments at refs 1,3,5; drop = tiny at ref 2,4.
    const segs = [
        { startRef: "m00001", endRef: "m00001", count: 1, tokens: 1000, hasTool: false },
        { startRef: "m00002", endRef: "m00002", count: 1, tokens: 1, hasTool: false },
        { startRef: "m00003", endRef: "m00003", count: 1, tokens: 1000, hasTool: false },
        { startRef: "m00004", endRef: "m00004", count: 1, tokens: 1, hasTool: false },
        { startRef: "m00005", endRef: "m00005", count: 1, tokens: 1000, hasTool: false },
    ]
    const out = formatVisibleGuidance(segs, 3)
    // Shown order must be ascending: m00001, m00003, m00005 (not sorted by tokens).
    assert.ok(out.startsWith("[Visible (top 3 of 5 segments"))
    const shownPart = out.split(":")[1].split("|")[0].trim()
    assert.equal(shownPart, "m00001, m00003, m00005")
})

test("formatVisibleGuidance: omitted tokens format with K suffix for large totals", () => {
    const segs = Array.from({ length: 55 }, (_, i) => ({
        startRef: `m${String(i + 1).padStart(5, "0")}`,
        endRef: `m${String(i + 1).padStart(5, "0")}`,
        count: 1,
        tokens: 1000,
        hasTool: false,
    }))
    const out = formatVisibleGuidance(segs, 50)
    // 5 omitted * 1000 = 5000 tokens -> "5.0K"
    assert.ok(out.includes("~5.0K tokens, 5 msgs) omitted]"))
})

test("formatVisibleGuidance: omitted note singularizes msg when exactly 1 message omitted", () => {
    // 2 segments: big tool-bearing (kept) + tiny single-msg text (omitted at maxSegs=1).
    const segs = [
        { startRef: "m00001", endRef: "m00001", count: 1, tokens: 1000, hasTool: true },
        { startRef: "m00003", endRef: "m00003", count: 1, tokens: 2, hasTool: false },
    ]
    const out = formatVisibleGuidance(segs, 1)
    assert.ok(
        out.includes("+1 smaller segment (~2 tokens, 1 msg) omitted]"),
        "1 omitted msg should be singular",
    )
})
