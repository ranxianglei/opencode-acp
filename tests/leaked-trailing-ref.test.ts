import "./test-env"
/**
 * Regression tests for issue #431: bare ACP message refs leaking into final
 * assistant output, bypassing the tag-only sanitizer.
 *
 * The model occasionally degenerates at the end of a completion and echoes its
 * own not-yet-assigned ref as a bare token plus garbage ("m00057 <tail>").
 * stripLeakedTrailingRefs exploits ref monotonicity: any line-leading bare ref
 * at or beyond the next-to-allocate value (messageIds.nextRef /
 * prune.messages.nextBlockId) cannot be a legitimate citation, so it is cut
 * from the tail of the output.
 */
import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { createTextCompleteHandler } from "../lib/hooks"
import { stripLeakedTrailingRefs } from "../lib/messages/utils"
import { Logger } from "../lib/logger"
import { createSessionState } from "../lib/state"
import { createTestRegistry } from "./registry-stub"

// ─── Unit: stripLeakedTrailingRefs ────────────────────────────────────────────

describe("stripLeakedTrailingRefs — #431 bare self-ref leak", () => {
    test("strips trailing paragraph with future m-ref + garbage (issue repro shape)", () => {
        const text = "Normal progress message.\n\nm00057 <unrelated random multilingual tail>"
        const result = stripLeakedTrailingRefs(text, { nextMessageRef: 57 })
        assert.equal(result, "Normal progress message.")
    })

    test("strips m-ref exactly equal to next-to-allocate (it does not exist yet)", () => {
        const text = "Done.\nm00057 tail"
        const result = stripLeakedTrailingRefs(text, { nextMessageRef: 57 })
        assert.equal(result, "Done.")
    })

    test("strips m-ref above next-to-allocate", () => {
        const text = "Done.\nm00999 tail"
        const result = stripLeakedTrailingRefs(text, { nextMessageRef: 57 })
        assert.equal(result, "Done.")
    })

    test("keeps existing m-ref at line start (below next-to-allocate)", () => {
        const text = "Summary:\n\nm00056"
        const result = stripLeakedTrailingRefs(text, { nextMessageRef: 57 })
        assert.equal(result, text)
    })

    test("keeps inline mentions even when the value is beyond the bound", () => {
        // "m00999" is mid-line (not line-leading) → protected prose.
        const text = "Range m00056 through m00999 covered."
        const result = stripLeakedTrailingRefs(text, { nextMessageRef: 57 })
        assert.equal(result, text)
    })

    test("keeps legitimate older refs in normal prose (issue acceptance criterion)", () => {
        const text = "I compressed the range m00010–m00056 earlier; see m00042 for the decision."
        const result = stripLeakedTrailingRefs(text, { nextMessageRef: 57 })
        assert.equal(result, text)
    })

    test("strips future bN block ref at line start", () => {
        const text = "Done.\n\nb7 junk"
        const result = stripLeakedTrailingRefs(text, { nextBlockRef: 7 })
        assert.equal(result, "Done.")
    })

    test("keeps existing bN block ref (below nextBlockId)", () => {
        const text = "Blocks in play:\n\nb6"
        const result = stripLeakedTrailingRefs(text, { nextBlockRef: 7 })
        assert.equal(result, text)
    })

    test("returns input unchanged when both bounds are unknown", () => {
        const text = "Done.\n\nm00057 x"
        assert.equal(stripLeakedTrailingRefs(text, {}), text)
        assert.equal(
            stripLeakedTrailingRefs(text, { nextMessageRef: null, nextBlockRef: null }),
            text,
        )
    })

    test("non-integer bounds are treated as unknown (no strip)", () => {
        const text = "Done.\n\nm00057 x"
        assert.equal(stripLeakedTrailingRefs(text, { nextMessageRef: 57.5 }), text)
    })

    test("still strips when only one bound is known", () => {
        const textM = "Done.\n\nm00057 x"
        assert.equal(
            stripLeakedTrailingRefs(textM, { nextMessageRef: 57, nextBlockRef: null }),
            "Done.",
        )
        const textB = "Done.\n\nb7 x"
        assert.equal(
            stripLeakedTrailingRefs(textB, { nextMessageRef: null, nextBlockRef: 7 }),
            "Done.",
        )
    })

    test("cuts at the FIRST line-leading future ref (everything after is dropped)", () => {
        const text = "A\n\nm00060 one\nmore m00061 two"
        const result = stripLeakedTrailingRefs(text, { nextMessageRef: 57 })
        assert.equal(result, "A")
    })

    test("skips below-bound line-leading refs and cuts at the first future one", () => {
        const text = "a\n\nm00050 ok\n\nm00060 bad"
        const result = stripLeakedTrailingRefs(text, { nextMessageRef: 57 })
        assert.equal(result, "a\n\nm00050 ok")
    })

    test("whole output being a leak yields empty string", () => {
        const result = stripLeakedTrailingRefs("m00057 garbage only", { nextMessageRef: 57 })
        assert.equal(result, "")
    })

    test("uppercase M/B forms are untouched (only exact injected lowercase format)", () => {
        const text = "Part M00057 ordered.\n\nB5 stock check"
        const result = stripLeakedTrailingRefs(text, { nextMessageRef: 57, nextBlockRef: 1 })
        assert.equal(result, text)
    })

    test("trims trailing whitespace after the cut (no dangling newlines)", () => {
        const text = "Done.\n\n  m00057 x  \n"
        const result = stripLeakedTrailingRefs(text, { nextMessageRef: 57 })
        assert.equal(result, "Done.")
    })

    test("handles CRLF line endings around the leaked ref", () => {
        const text = "Done.\r\n\r\nm00057 x"
        const result = stripLeakedTrailingRefs(text, { nextMessageRef: 57 })
        assert.equal(result, "Done.")
    })

    test("six-digit 'm' tokens are not treated as message refs (format guard)", () => {
        const text = "Note:\n\nm0012345 end"
        const result = stripLeakedTrailingRefs(text, { nextMessageRef: 1 })
        assert.equal(result, text)
    })

    test("'b0' is never matched — block ids allocate from 1, so b0 exists in no ID space", () => {
        // Even at the minimum bound (nextBlockRef = 1), "b0" must survive: the
        // allocator (allocateBlockId) starts at 1, so b0 can never be a real or
        // future block ref — matching it could only create false positives.
        const text = "Done.\n\nb0 junk"
        const result = stripLeakedTrailingRefs(text, { nextBlockRef: 1 })
        assert.equal(result, text)
    })

    test("4-digit 'm' tokens are still checked against the bound (lenient legacy width)", () => {
        // Above bound → stripped even though 4-digit is not the exact injected width.
        assert.equal(
            stripLeakedTrailingRefs("Done.\nm0057 x", { nextMessageRef: 57 }),
            "Done.",
        )
        assert.equal(
            stripLeakedTrailingRefs("Done.\nm0042 x", { nextMessageRef: 57 }),
            "Done.\nm0042 x",
        )
    })

    test("empty string passes through unchanged", () => {
        assert.equal(stripLeakedTrailingRefs("", { nextMessageRef: 1 }), "")
    })
})

// ─── Handler: createTextCompleteHandler ───────────────────────────────────────

describe("createTextCompleteHandler — #431 integration", () => {
    function makeState(sessionId: string | null, nextRef: number, nextBlockId: number) {
        const state = createSessionState()
        if (sessionId) {
            state.sessionId = sessionId
        }
        state.messageIds.nextRef = nextRef
        state.prune.messages.nextBlockId = nextBlockId
        return state
    }

    test("strips both hallucinated tags and the trailing bare self-ref", async () => {
        const state = makeState("session-1", 57, 7)
        const handler = createTextCompleteHandler(createTestRegistry(state), new Logger(false))
        const output = {
            text: 'Progress.<dcp-message-id tokens="1" type="text">m00056</dcp-message-id>\n\nm00057 <garbage>',
        }

        await handler({ sessionID: "session-1", messageID: "message-1", partID: "part-1" }, output)

        assert.equal(output.text, "Progress.")
    })

    test("keeps legitimate citation of an already-assigned ref", async () => {
        const state = makeState("session-1", 57, 7)
        const handler = createTextCompleteHandler(createTestRegistry(state), new Logger(false))
        const output = { text: "Compressed the range m00010 through m00056." }

        await handler({ sessionID: "session-1", messageID: "message-1", partID: "part-1" }, output)

        assert.equal(output.text, "Compressed the range m00010 through m00056.")
    })

    test("falls back to tag-only sanitization when session state is unknown", async () => {
        // Registry seeded for a different session → get("session-1") misses.
        const state = makeState("other-session", 57, 7)
        const handler = createTextCompleteHandler(createTestRegistry(state), new Logger(false))
        const output = { text: "x\n\nm00057 y" }

        await handler({ sessionID: "session-1", messageID: "message-1", partID: "part-1" }, output)

        assert.equal(output.text, "x\n\nm00057 y")
    })

    test("empty text is left untouched without throwing", async () => {
        const state = makeState("session-1", 57, 7)
        const handler = createTextCompleteHandler(createTestRegistry(state), new Logger(false))
        const output = { text: "" }

        await handler({ sessionID: "session-1", messageID: "message-1", partID: "part-1" }, output)

        assert.equal(output.text, "")
    })
})
