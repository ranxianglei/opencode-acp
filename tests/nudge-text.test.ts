import assert from "node:assert/strict"
import test from "node:test"
import { TURN_NUDGE, TURN_CANDIDATE_GUIDANCE } from "../lib/prompts/turn-nudge"
import { CONTEXT_LIMIT_NUDGE, CANDIDATE_GUIDANCE } from "../lib/prompts/context-limit-nudge"
import { ITERATION_NUDGE, ITERATION_CANDIDATE_GUIDANCE } from "../lib/prompts/iteration-nudge"
import { buildCompressedBlockGuidance } from "../lib/prompts/extensions/nudge"
import { createSessionState } from "../lib/state"

test("TURN_NUDGE uses conditional compression language with decompress safety net", () => {
    assert.match(TURN_NUDGE, /finished reading/i)
    assert.match(TURN_NUDGE, /decompress later/i)
    assert.doesNotMatch(TURN_NUDGE, /\bnow\b/i)
    // Default (compress.candidates off) must not mention candidates
    assert.doesNotMatch(TURN_NUDGE, /MICRO candidates/i)
    assert.doesNotMatch(TURN_NUDGE, /EPISODE candidates/i)
})

test("TURN_CANDIDATE_GUIDANCE explains candidate categories (opt-in mode)", () => {
    assert.match(TURN_CANDIDATE_GUIDANCE, /MICRO candidates/i)
    assert.match(TURN_CANDIDATE_GUIDANCE, /EPISODE candidates/i)
    assert.match(TURN_CANDIDATE_GUIDANCE, /independent suggestions/i)
    assert.match(TURN_CANDIDATE_GUIDANCE, /Do not compress active work or every candidate/i)
})

test("CONTEXT_LIMIT_NUDGE frames compression as a step with decompress safety net", () => {
    assert.match(CONTEXT_LIMIT_NUDGE, /time to compress/i)
    assert.match(CONTEXT_LIMIT_NUDGE, /decompress/i)
    assert.doesNotMatch(CONTEXT_LIMIT_NUDGE, /\b(MUST|CRITICAL)\b/)
    // Default mode keeps the legacy range strategy, not candidate guidance
    assert.match(CONTEXT_LIMIT_NUDGE, /RANGE STRATEGY/i)
    assert.doesNotMatch(CONTEXT_LIMIT_NUDGE, /COMPRESSION CANDIDATES/i)
})

test("CANDIDATE_GUIDANCE explains candidate semantics without mandating targets (opt-in mode)", () => {
    assert.match(CANDIDATE_GUIDANCE, /COMPRESSION CANDIDATES/i)
    assert.match(CANDIDATE_GUIDANCE, /non-overlapping/i)
    assert.match(CANDIDATE_GUIDANCE, /call the .*compress.*tool in your next reply/i)
    assert.match(CANDIDATE_GUIDANCE, /Do not merely recommend compression/i)
    assert.match(CANDIDATE_GUIDANCE, /suggestions, not mandatory targets/i)
})

test("ITERATION_NUDGE keeps legacy wording by default", () => {
    assert.match(ITERATION_NUDGE, /unlikely to be referenced/i)
    assert.doesNotMatch(ITERATION_NUDGE, /MICRO candidates/i)
    assert.doesNotMatch(ITERATION_NUDGE, /EPISODE candidates/i)
})

test("ITERATION_CANDIDATE_GUIDANCE explains candidate categories without making them mandatory", () => {
    assert.match(ITERATION_CANDIDATE_GUIDANCE, /MICRO candidates/i)
    assert.match(ITERATION_CANDIDATE_GUIDANCE, /EPISODE candidates/i)
    assert.match(ITERATION_CANDIDATE_GUIDANCE, /independent suggestions/i)
    assert.match(ITERATION_CANDIDATE_GUIDANCE, /preserve anything still needed/i)
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
