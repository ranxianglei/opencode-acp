import assert from "node:assert/strict"
import test from "node:test"
import { runTruncateGC } from "../lib/gc/truncate"
import type { CompressionBlock } from "../lib/state/types"
import type { GCParams } from "../lib/gc/truncate"

function makeBlock(overrides: Partial<CompressionBlock> = {}): CompressionBlock {
    return {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 1000,
        summaryTokens: 100,
        durationMs: 500,
        mode: "range",
        topic: "test",
        batchTopic: "test",
        startId: "m0",
        endId: "m5",
        anchorMessageId: "anchor-1",
        compressMessageId: "comp-1",
        compressCallId: undefined,
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: [],
        effectiveToolIds: [],
        createdAt: 1000,
        deactivatedAt: undefined,
        deactivatedByBlockId: undefined,
        summary: "A short summary.",
        survivedCount: 5,
        generation: "old",
        ...overrides,
    }
}

function makeParams(overrides: Partial<GCParams> = {}): GCParams {
    return {
        maxOldGenSummaryLength: 100,
        modelContextLimit: 200000,
        currentTokens: 100000,
        ...overrides,
    }
}

test("runTruncateGC returns zeros for empty block array", () => {
    const result = runTruncateGC([], makeParams())
    assert.equal(result.compactedBlocks, 0)
    assert.equal(result.savedTokens, 0)
})

test("runTruncateGC returns zeros for all inactive blocks", () => {
    const blocks = [
        makeBlock({ active: false, summary: "x".repeat(500) }),
        makeBlock({ blockId: 2, runId: 2, active: false, summary: "y".repeat(500) }),
    ]
    const result = runTruncateGC(blocks, makeParams())
    assert.equal(result.compactedBlocks, 0)
    assert.equal(result.savedTokens, 0)
})

test("runTruncateGC does not truncate short summaries", () => {
    const summary = "Short summary under limit."
    const block = makeBlock({ summary, summaryTokens: 10 })
    const result = runTruncateGC([block], makeParams({ maxOldGenSummaryLength: 100 }))
    assert.equal(result.compactedBlocks, 0)
    assert.equal(result.savedTokens, 0)
    assert.equal(block.summary, summary)
})

test("runTruncateGC truncates long summary preserving header", () => {
    const header = "# Block 1 Summary"
    const body = "x".repeat(200)
    const longSummary = header + "\n" + body
    const block = makeBlock({ summary: longSummary, summaryTokens: 100 })
    const result = runTruncateGC([block], makeParams({ maxOldGenSummaryLength: 100 }))

    assert.equal(result.compactedBlocks, 1)
    assert.ok(result.savedTokens > 0)
    assert.ok(block.summary.startsWith(header))
    assert.ok(block.summary.includes("[GC truncated]"))
    assert.ok(block.summary.length <= 120)
})

test("runTruncateGC updates summaryTokens after truncation", () => {
    const header = "# Summary"
    const body = "x".repeat(500)
    const block = makeBlock({
        summary: header + "\n" + body,
        summaryTokens: 200,
    })
    runTruncateGC([block], makeParams({ maxOldGenSummaryLength: 80 }))
    assert.ok(block.summaryTokens < 200)
    assert.equal(block.summaryTokens, Math.round(block.summary.length / 4))
})

test("runTruncateGC handles summary with no newlines", () => {
    const noNewlineSummary = "x".repeat(200)
    const block = makeBlock({ summary: noNewlineSummary, summaryTokens: 50 })
    const result = runTruncateGC([block], makeParams({ maxOldGenSummaryLength: 100 }))

    assert.equal(result.compactedBlocks, 1)
    assert.ok(block.summary.length <= 120)
    assert.ok(block.summary.includes("[GC truncated]"))
})

test("runTruncateGC handles summary with header and footer", () => {
    const header = "# Header"
    const body = "b".repeat(300)
    const footer = "\n\n## Footer info"
    const summary = header + "\n" + body + footer
    const block = makeBlock({ summary, summaryTokens: 200 })
    const result = runTruncateGC([block], makeParams({ maxOldGenSummaryLength: 150 }))

    assert.equal(result.compactedBlocks, 1)
    assert.ok(block.summary.startsWith(header + "\n"))
    assert.ok(block.summary.includes("[GC truncated]"))
    assert.ok(block.summary.includes("## Footer info"))
})

test("runTruncateGC processes multiple blocks independently", () => {
    const block1 = makeBlock({
        blockId: 1,
        summary: "Short",
        summaryTokens: 5,
    })
    const block2 = makeBlock({
        blockId: 2,
        runId: 2,
        summary: "y".repeat(200),
        summaryTokens: 50,
    })
    const result = runTruncateGC([block1, block2], makeParams({ maxOldGenSummaryLength: 100 }))

    assert.equal(result.compactedBlocks, 1)
    assert.equal(block1.summary, "Short")
    assert.ok(block2.summary.includes("[GC truncated]"))
})

test("runTruncateGC returns zeros when summary exactly at maxLength", () => {
    const exactSummary = "x".repeat(100)
    const block = makeBlock({ summary: exactSummary, summaryTokens: 25 })
    const result = runTruncateGC([block], makeParams({ maxOldGenSummaryLength: 100 }))
    assert.equal(result.compactedBlocks, 0)
    assert.equal(block.summary, exactSummary)
})

test("runTruncateGC mutates block summary in place", () => {
    const block = makeBlock({
        summary: "Header\n" + "z".repeat(300),
        summaryTokens: 100,
    })
    const originalSummary = block.summary
    runTruncateGC([block], makeParams({ maxOldGenSummaryLength: 100 }))
    assert.notEqual(block.summary, originalSummary)
    assert.ok(block.summary.length < originalSummary.length)
})

test("runTruncateGC with very small maxLength still preserves header", () => {
    const header = "# H"
    const body = "x".repeat(500)
    const block = makeBlock({
        summary: header + "\n" + body,
        summaryTokens: 200,
    })
    const result = runTruncateGC([block], makeParams({ maxOldGenSummaryLength: 20 }))

    assert.equal(result.compactedBlocks, 1)
    assert.ok(block.summary.startsWith(header))
    assert.ok(block.summary.includes("[GC truncated]"))
})
