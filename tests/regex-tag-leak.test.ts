import { describe, test } from "node:test"
import assert from "node:assert/strict"
import {
    replaceBlockIdsWithBlocked,
    stripStaleMessageRefs,
    stripHallucinationsFromString,
} from "../lib/messages/utils"

describe("replaceBlockIdsWithBlocked", () => {
    test("replaces block ID inside dcp-message-id tag with attributes", () => {
        const input = '<dcp-message-id tokens="2.1K" type="tool:bash">b3</dcp-message-id>'
        const result = replaceBlockIdsWithBlocked(input)
        assert.equal(
            result,
            '<dcp-message-id tokens="2.1K" type="tool:bash">BLOCKED</dcp-message-id>',
        )
    })

    test("replaces block ID inside acp-message-id tag with attributes", () => {
        const input = '<acp-message-id tokens="0.5K" type="text">b12</acp-message-id>'
        const result = replaceBlockIdsWithBlocked(input)
        assert.equal(
            result,
            '<acp-message-id tokens="0.5K" type="text">BLOCKED</acp-message-id>',
        )
    })

    test("replaces bare block ID (no attributes)", () => {
        const input = "<dcp-message-id>b0</dcp-message-id>"
        const result = replaceBlockIdsWithBlocked(input)
        assert.equal(result, "<dcp-message-id>BLOCKED</dcp-message-id>")
    })

    test("replaces multiple block IDs in one string", () => {
        const input =
            "<dcp-message-id>b0</dcp-message-id> and <dcp-message-id>b5</dcp-message-id>"
        const result = replaceBlockIdsWithBlocked(input)
        assert.equal(
            result,
            "<dcp-message-id>BLOCKED</dcp-message-id> and <dcp-message-id>BLOCKED</dcp-message-id>",
        )
    })

    test("does not touch message refs (mNNNN)", () => {
        const input = '<dcp-message-id tokens="2.1K">m00097</dcp-message-id>'
        const result = replaceBlockIdsWithBlocked(input)
        assert.equal(result, input)
    })

    test("preserves surrounding text", () => {
        const input = "Before <dcp-message-id>b3</dcp-message-id> After"
        const result = replaceBlockIdsWithBlocked(input)
        assert.equal(result, "Before <dcp-message-id>BLOCKED</dcp-message-id> After")
    })

    test("handles large block IDs", () => {
        const input = "<dcp-message-id>b999</dcp-message-id>"
        const result = replaceBlockIdsWithBlocked(input)
        assert.equal(result, "<dcp-message-id>BLOCKED</dcp-message-id>")
    })
})

describe("stripStaleMessageRefs", () => {
    test("strips dcp-message-id tag with attributes containing message ref", () => {
        const input = '<dcp-message-id tokens="2.1K" type="tool:bash">m00097</dcp-message-id>'
        const result = stripStaleMessageRefs(input)
        assert.equal(result, "")
    })

    test("strips acp-message-id tag with attributes containing message ref", () => {
        const input = '<acp-message-id tokens="0.5K">m00150</acp-message-id>'
        const result = stripStaleMessageRefs(input)
        assert.equal(result, "")
    })

    test("strips bare message-id tag (no attributes)", () => {
        const input = "<dcp-message-id>m00001</dcp-message-id>"
        const result = stripStaleMessageRefs(input)
        assert.equal(result, "")
    })

    test("strips multiple message-id tags in one string", () => {
        const input =
            "Text <dcp-message-id>m00001</dcp-message-id> more <dcp-message-id>m00002</dcp-message-id>"
        const result = stripStaleMessageRefs(input)
        assert.equal(result, "Text  more ")
    })

    // Before fix, the regex matched only 'm\d+</closing>' leaving the opening
    // tag behind as a fragment: '<dcp-message-id tokens="2.1K" type="tool:bash">'
    test("does NOT leave opening tag fragment (the main bug)", () => {
        const input = '<dcp-message-id tokens="2.1K" type="tool:bash">m00097</dcp-message-id>'
        const result = stripStaleMessageRefs(input)
        assert.ok(
            !result.includes("<dcp-message-id"),
            "Should not leave opening tag fragment",
        )
        assert.ok(
            !result.includes("<acp-message-id"),
            "Should not leave opening tag fragment",
        )
    })

    test("preserves surrounding text", () => {
        const input = "Before <dcp-message-id>m00001</dcp-message-id> After"
        const result = stripStaleMessageRefs(input)
        assert.equal(result, "Before  After")
    })

    test("does not touch block IDs (bNNN)", () => {
        const input = "<dcp-message-id>b3</dcp-message-id>"
        const result = stripStaleMessageRefs(input)
        assert.equal(result, input)
    })
})

describe("stripHallucinationsFromString (paired tag regex)", () => {
    test("removes paired dcp tags with content", () => {
        const input = 'alpha<dcp-system-reminder>secret</dcp-system-reminder>omega'
        const result = stripHallucinationsFromString(input)
        assert.equal(result, "alphaomega")
    })

    test("removes paired acp tags with content", () => {
        const input = 'alpha<acp-system-reminder>secret</acp-system-reminder>omega'
        const result = stripHallucinationsFromString(input)
        assert.equal(result, "alphaomega")
    })

    // Before fix, DCP_PAIRED_TAG_REGEX started with ']*>' which matched any '>'
    // character instead of '<dcp...>' opening tags. This caused partial deletion:
    // closing tag + content removed, but opening tag fragments leaked into chat.
    test("removes paired dcp-message-id tags (issue #123 core case)", () => {
        const input =
            'normal text <dcp-message-id tokens="2.1K" type="tool:bash">m00097</dcp-message-id> tail'
        const result = stripHallucinationsFromString(input)
        assert.equal(result, "normal text  tail")
        assert.ok(
            !result.includes("dcp-message-id"),
            "Should not leave any tag fragments",
        )
        assert.ok(!result.includes("m00097"), "Should not leave message ref")
    })

    test("removes paired tags with attributes on opening tag", () => {
        const input =
            'before<dcp-foo attr="value">content</dcp-foo>after'
        const result = stripHallucinationsFromString(input)
        assert.equal(result, "beforeafter")
    })

    test("removes nested paired tags (non-greedy: inner pair matched first)", () => {
        const input =
            'before<dcp-system-reminder>nested<dcp-foo>inner</dcp-foo>content</dcp-system-reminder>after'
        const result = stripHallucinationsFromString(input)
        assert.equal(result, "beforecontentafter")
    })

    test("removes multiple paired tags", () => {
        const input =
            'a<dcp-x>1</dcp-x>b<dcp-y>2</dcp-y>c'
        const result = stripHallucinationsFromString(input)
        assert.equal(result, "abc")
    })

    test("removes orphan/unpaired dcp tags via second regex", () => {
        const result = stripHallucinationsFromString(
            "narration<dcp-system-reminder> more",
        )
        assert.equal(result, "narration more")
    })

    test("does not affect non-dcp/acp tags", () => {
        const result = stripHallucinationsFromString(
            "<div>hello</div> <system-reminder>keep</system-reminder>",
        )
        assert.equal(result, "<div>hello</div> <system-reminder>keep</system-reminder>")
    })

    test("issue #123 regression: no tag fragment leakage after multi-round compression", () => {
        const input =
            'Some summary text <dcp-message-id tokens="0.5K" type="text">m00097</dcp-message-id> and more ' +
            '<dcp-message-id tokens="1.2K" type="tool:bash">m00099</dcp-message-id> end.'
        const result = stripHallucinationsFromString(input)
        assert.equal(result, "Some summary text  and more  end.")
        assert.ok(!result.includes("dcp"), "No dcp fragments")
        assert.ok(!result.includes("acp"), "No acp fragments")
        assert.ok(!result.includes("m0009"), "No stale message refs")
    })
})
