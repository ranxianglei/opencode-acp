import assert from "node:assert/strict"
import test from "node:test"
import type { CompressionBlock } from "../lib-v2/state"
import {
    appendMissingBlockSummaries,
    injectBlockPlaceholders,
    parseBlockPlaceholders,
    validateSummaryPlaceholders,
} from "../lib-v2/compress/range-utils"
import { wrapCompressedSummary } from "../lib-v2/compress/state"
import type { BoundaryReference } from "../lib-v2/compress/types"

function createBlock(blockId: number, body: string): CompressionBlock {
    return {
        blockId,
        runId: blockId,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        summaryTokens: 0,
        topic: `Block ${blockId}`,
        startId: "m00001",
        endId: "m00002",
        anchorMessageId: `msg-${blockId}`,
        compressMessageId: `compress-${blockId}`,
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: [`msg-${blockId}`],
        effectiveToolIds: [],
        createdAt: blockId,
        summary: wrapCompressedSummary(blockId, body),
    }
}

function createMessageBoundary(messageId: string, rawIndex: number): BoundaryReference {
    return {
        kind: "message",
        messageId,
        rawIndex,
    }
}

test("parseBlockPlaceholders extracts block references from summary text", () => {
    const summary = "Intro (b1) middle (b9) duplicate (b1) out-of-range (b2) outro"
    const parsed = parseBlockPlaceholders(summary)

    assert.deepEqual(
        parsed.map((p) => p.blockId),
        [1, 9, 1, 2],
    )
})

test("validateSummaryPlaceholders filters to valid required blocks and returns missing", () => {
    const summaryByBlockId = new Map([
        [1, createBlock(1, "First compressed summary")],
        [2, createBlock(2, "Second compressed summary")],
    ])
    const summary = "Intro (b1) unknown (b9) duplicate (b1) out-of-range (b2) outro"
    const parsed = parseBlockPlaceholders(summary)

    const missingBlockIds = validateSummaryPlaceholders(
        parsed,
        [1],
        createMessageBoundary("msg-a", 0),
        createMessageBoundary("msg-b", 1),
        summaryByBlockId,
    )

    assert.deepEqual(
        parsed.map((p) => p.blockId),
        [1],
    )
    assert.deepEqual(missingBlockIds, [])
})

test("validateSummaryPlaceholders returns required blocks not referenced in summary", () => {
    const summaryByBlockId = new Map([[1, createBlock(1, "Recovered compressed summary")]])
    const summary = "The model forgot to include the prior block."
    const parsed = parseBlockPlaceholders(summary)

    const missingBlockIds = validateSummaryPlaceholders(
        parsed,
        [1],
        createMessageBoundary("msg-a", 0),
        createMessageBoundary("msg-b", 1),
        summaryByBlockId,
    )

    assert.deepEqual(missingBlockIds, [1])
})

test("injectBlockPlaceholders returns summary unchanged (independent blocks)", () => {
    const summaryByBlockId = new Map([
        [1, createBlock(1, "First compressed summary")],
        [2, createBlock(2, "Second compressed summary")],
    ])
    const summary = "Intro (b1) middle (b2) outro"
    const parsed = parseBlockPlaceholders(summary)
    validateSummaryPlaceholders(
        parsed,
        [1, 2],
        createMessageBoundary("msg-a", 0),
        createMessageBoundary("msg-b", 1),
        summaryByBlockId,
    )

    const injected = injectBlockPlaceholders(
        summary,
        parsed,
        summaryByBlockId,
        createMessageBoundary("msg-a", 0),
        createMessageBoundary("msg-b", 1),
    )

    assert.equal(injected.expandedSummary, summary)
    assert.deepEqual(injected.consumedBlockIds, [])
})

test("appendMissingBlockSummaries returns summary unchanged (independent blocks)", () => {
    const summaryByBlockId = new Map([[1, createBlock(1, "Old summary")]])
    const summary = "New compression summary"

    const result = appendMissingBlockSummaries(summary, [1], summaryByBlockId, [])

    assert.equal(result.expandedSummary, summary)
    assert.deepEqual(result.consumedBlockIds, [])
})

test("appendMissingBlockSummaries forwards consumedBlockIds", () => {
    const summary = "Summary text"
    const result = appendMissingBlockSummaries(summary, [], new Map(), [5, 7])

    assert.equal(result.expandedSummary, summary)
    assert.deepEqual(result.consumedBlockIds, [5, 7])
})
