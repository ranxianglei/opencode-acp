import assert from "node:assert/strict"
import test from "node:test"
import { TURN_NUDGE } from "../lib/prompts/turn-nudge"
import { CONTEXT_LIMIT_NUDGE } from "../lib/prompts/context-limit-nudge"
import { buildCompressedBlockGuidance } from "../lib/prompts/extensions/nudge"
import { createSessionState } from "../lib/state"

test("TURN_NUDGE uses conditional compression language with decompress safety net", () => {
    assert.match(TURN_NUDGE, /finished reading/i)
    assert.match(TURN_NUDGE, /decompress later/i)
    assert.doesNotMatch(TURN_NUDGE, /\bnow\b/i)
})

test("CONTEXT_LIMIT_NUDGE frames compression as a step with decompress safety net", () => {
    assert.match(CONTEXT_LIMIT_NUDGE, /time to compress/i)
    assert.match(CONTEXT_LIMIT_NUDGE, /decompress/i)
    assert.doesNotMatch(CONTEXT_LIMIT_NUDGE, /\b(MUST|CRITICAL)\b/)
})

test("buildCompressedBlockGuidance shows compact summary with block count", () => {
    const state = createSessionState()
    for (const id of [1, 2, 3]) {
        state.prune.messages.activeBlockIds.add(id)
        state.prune.messages.blocksById.set(id, {
            summaryTokens: id * 100,
            createdAt: Date.now(),
            active: true,
        } as never)
    }

    const guidance = buildCompressedBlockGuidance(state)

    assert.match(guidance, /Compressed blocks: 3/)
    assert.match(guidance, /600 summary/)
    assert.match(guidance, /acp_status/)
})

test("buildCompressedBlockGuidance shows last compression age", () => {
    const state = createSessionState()
    state.prune.messages.activeBlockIds.add(1)
    state.prune.messages.blocksById.set(1, {
        summaryTokens: 500,
        createdAt: Date.now() - 5 * 60_000,
        active: true,
    } as never)

    const guidance = buildCompressedBlockGuidance(state)

    assert.match(guidance, /5m ago/)
})

test("buildCompressedBlockGuidance aggregates summary tokens across blocks", () => {
    const state = createSessionState()
    for (const id of [1, 2, 3]) {
        state.prune.messages.activeBlockIds.add(id)
        state.prune.messages.blocksById.set(id, {
            summaryTokens: id * 1000,
            createdAt: Date.now(),
            active: true,
        } as never)
    }

    const guidance = buildCompressedBlockGuidance(state)

    assert.match(guidance, /6\.0K summary/)
    assert.match(guidance, /acp_status for details/)
})
