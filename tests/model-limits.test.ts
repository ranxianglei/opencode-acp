import assert from "node:assert/strict"
import test from "node:test"
import { inferModelContextLimit, _SORTED_KEYS } from "../lib/model-limits"

test("undefined modelId returns undefined", () => {
    assert.equal(inferModelContextLimit(undefined), undefined)
})

test("empty string returns undefined", () => {
    assert.equal(inferModelContextLimit(""), undefined)
})

test("exact match returns correct limit", () => {
    assert.equal(inferModelContextLimit("gpt-4o"), 128000)
    assert.equal(inferModelContextLimit("gpt-4"), 8192)
    assert.equal(inferModelContextLimit("gpt-4-32k"), 32768)
})

test("claude-3.5-sonnet (dot) returns 200000", () => {
    assert.equal(inferModelContextLimit("claude-3.5-sonnet"), 200000)
})

test("claude-3-5-sonnet (hyphen) returns 200000", () => {
    assert.equal(inferModelContextLimit("claude-3-5-sonnet"), 200000)
})

test("claude-3.5-haiku (dot) returns 200000", () => {
    assert.equal(inferModelContextLimit("claude-3.5-haiku"), 200000)
})

test("claude-3-5-haiku (hyphen) returns 200000", () => {
    assert.equal(inferModelContextLimit("claude-3-5-haiku"), 200000)
})

test("gpt-4-32k wins over gpt-4 (substring specificity)", () => {
    assert.equal(inferModelContextLimit("gpt-4-32k-0613"), 32768)
})

test("gpt-4-32k wins over gpt-4-turbo", () => {
    assert.equal(inferModelContextLimit("gpt-4-32k"), 32768)
    assert.equal(inferModelContextLimit("gpt-4-turbo"), 128000)
})

test("gpt-4o wins over gpt-4 (longer key checked first)", () => {
    assert.equal(inferModelContextLimit("gpt-4o-2024-08-06"), 128000)
})

test("gpt-4o-mini wins over gpt-4o", () => {
    assert.equal(inferModelContextLimit("gpt-4o-mini"), 128000)
    assert.equal(inferModelContextLimit("gpt-4o-mini-2024-07-18"), 128000)
})

test("o1-mini wins over o1 (substring specificity)", () => {
    assert.equal(inferModelContextLimit("o1-mini-2024-09-12"), 128000)
})

test("o1-pro returns 200000", () => {
    assert.equal(inferModelContextLimit("o1-pro-2024-12-17"), 200000)
})

test("o1 alone returns 200000", () => {
    assert.equal(inferModelContextLimit("o1-2024-12-17"), 200000)
})

test("o3-mini returns 200000", () => {
    assert.equal(inferModelContextLimit("o3-mini"), 200000)
})

test("case insensitive matching", () => {
    assert.equal(inferModelContextLimit("GPT-4O"), 128000)
    assert.equal(inferModelContextLimit("Claude-3.5-Sonnet"), 200000)
    assert.equal(inferModelContextLimit("O1-MINI"), 128000)
})

test("unknown model returns undefined", () => {
    assert.equal(inferModelContextLimit("some-random-model-xyz"), undefined)
    assert.equal(inferModelContextLimit("phi-3"), undefined)
})

test("gemini-2.5-pro returns 1M", () => {
    assert.equal(inferModelContextLimit("gemini-2.5-pro"), 1000000)
})

test("gemini-1.5-pro returns 2M", () => {
    assert.equal(inferModelContextLimit("gemini-1.5-pro-002"), 2000000)
})

test("glm-5 returns 128000", () => {
    assert.equal(inferModelContextLimit("glm-5"), 128000)
})

test("glm-4-plus wins over glm-4", () => {
    assert.equal(inferModelContextLimit("glm-4-plus"), 128000)
})

test("deepseek-chat returns 64000", () => {
    assert.equal(inferModelContextLimit("deepseek-chat"), 64000)
})

test("sorted keys are descending by length", () => {
    for (let i = 1; i < _SORTED_KEYS.length; i++) {
        const prevLen = _SORTED_KEYS[i - 1][0].length
        const currLen = _SORTED_KEYS[i][0].length
        assert.ok(
            prevLen >= currLen,
            `Key "${_SORTED_KEYS[i - 1][0]}" (len ${prevLen}) should be >= "${_SORTED_KEYS[i][0]}" (len ${currLen})`,
        )
    }
})

test("no duplicate keys in table", () => {
    const keys = Object.keys(Object.fromEntries(_SORTED_KEYS))
    const seen = new Set<string>()
    for (const k of keys) {
        assert.ok(!seen.has(k), `Duplicate key: ${k}`)
        seen.add(k)
    }
})

test("real-world model IDs resolve correctly", () => {
    const cases: Array<[string, number]> = [
        ["anthropic/claude-3.5-sonnet", 200000],
        ["claude-3-5-sonnet-20241022", 200000],
        ["openai/gpt-4o", 128000],
        ["gpt-4o-2024-08-06", 128000],
        ["gpt-4-0125-preview", 8192],
        ["gpt-4-1106-preview", 8192],
        ["google/gemini-2.0-flash-001", 1000000],
        ["o1-mini-2024-09-12", 128000],
        ["o3-mini-2025-01-31", 200000],
    ]
    for (const [id, expected] of cases) {
        assert.equal(inferModelContextLimit(id), expected, `Failed for: ${id}`)
    }
})
