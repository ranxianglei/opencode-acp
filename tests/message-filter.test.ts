import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import {
    registerMessageFilter,
    getMessageFilter,
    listMessageFilters,
    clearMessageFilters,
} from "../lib/messages/filter/registry"
import type { MessageFilter, MessageFilterContext } from "../lib/messages/filter/types"
import { applyMessageFilters } from "../lib/messages/filter/apply"
import { OMO_SYSTEM_REMINDER_FILTER } from "../lib/messages/filter/builtin/omo-system-reminder"
import { ensureBuiltinFiltersRegistered } from "../lib/messages/filter/builtin"

type MockLogger = { debug: (...a: any[]) => void; info: (...a: any[]) => void; warn: (...a: any[]) => void }

function makeLogger(): MockLogger {
    return { debug: () => {}, info: () => {}, warn: () => {} }
}

function makeCtx(overrides: Partial<MessageFilterContext>): MessageFilterContext {
    return {
        text: "",
        role: "user",
        sessionId: "ses_test",
        isSubAgent: false,
        messageIndex: 0,
        totalMessages: 1,
        ...overrides,
    }
}

describe("Message Filter Registry", () => {
    beforeEach(() => clearMessageFilters())

    it("registers and retrieves a filter", () => {
        const filter: MessageFilter = {
            name: "test-filter",
            version: "1.0.0",
            description: "test",
            filter: () => ({ action: "keep" }),
        }
        registerMessageFilter(filter)
        assert.equal(getMessageFilter("test-filter"), filter)
        assert.equal(listMessageFilters().length, 1)
    })

    it("allows re-registering same name + same version", () => {
        const filter: MessageFilter = {
            name: "test-filter",
            version: "1.0.0",
            description: "test",
            filter: () => ({ action: "keep" }),
        }
        registerMessageFilter(filter)
        registerMessageFilter(filter)
        assert.equal(listMessageFilters().length, 1)
    })

    it("throws on re-registering same name + different version", () => {
        registerMessageFilter({
            name: "test-filter",
            version: "1.0.0",
            description: "v1",
            filter: () => ({ action: "keep" }),
        })
        assert.throws(
            () =>
                registerMessageFilter({
                    name: "test-filter",
                    version: "2.0.0",
                    description: "v2",
                    filter: () => ({ action: "keep" }),
                }),
            /version/i,
        )
    })
})

describe("applyMessageFilters", () => {
    beforeEach(() => clearMessageFilters())

    it("returns zero stats when config disabled", () => {
        const logger = makeLogger()
        const result = applyMessageFilters([], { enabled: false, filters: {} }, logger, {
            sessionId: "s",
            isSubAgent: false,
        })
        assert.deepEqual(result, { partsFiltered: 0, partsDropped: 0, partsModified: 0 })
    })

    it("returns zero stats when no filters registered", () => {
        const logger = makeLogger()
        const messages = [
            { info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
        ] as any
        const result = applyMessageFilters(
            messages,
            { enabled: true, filters: {} },
            logger,
            { sessionId: "s", isSubAgent: false },
        )
        assert.deepEqual(result, { partsFiltered: 0, partsDropped: 0, partsModified: 0 })
    })

    it("drops text parts when filter returns drop", () => {
        registerMessageFilter({
            name: "dropper",
            version: "1.0.0",
            description: "drops all",
            filter: () => ({ action: "drop" }),
        })
        const logger = makeLogger()
        const messages = [
            { info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
        ] as any
        const result = applyMessageFilters(
            messages,
            { enabled: true, filters: { dropper: { enabled: true } } },
            logger,
            { sessionId: "s", isSubAgent: false },
        )
        assert.equal(result.partsDropped, 1)
        assert.equal(messages[0].parts[0].text, "")
    })

    it("modifies text parts when filter returns modify", () => {
        registerMessageFilter({
            name: "modifier",
            version: "1.0.0",
            description: "modifies",
            filter: (ctx) => ({ action: "modify", text: "MODIFIED:" + ctx.text.slice(0, 5) }),
        })
        const logger = makeLogger()
        const messages = [
            { info: { role: "user" }, parts: [{ type: "text", text: "hello world" }] },
        ] as any
        const result = applyMessageFilters(
            messages,
            { enabled: true, filters: { modifier: { enabled: true } } },
            logger,
            { sessionId: "s", isSubAgent: false },
        )
        assert.equal(result.partsModified, 1)
        assert.equal(messages[0].parts[0].text, "MODIFIED:hello")
    })

    it("skips disabled filters", () => {
        registerMessageFilter({
            name: "dropper",
            version: "1.0.0",
            description: "drops all",
            filter: () => ({ action: "drop" }),
        })
        const logger = makeLogger()
        const messages = [
            { info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
        ] as any
        const result = applyMessageFilters(
            messages,
            { enabled: true, filters: { dropper: { enabled: false } } },
            logger,
            { sessionId: "s", isSubAgent: false },
        )
        assert.equal(result.partsFiltered, 0)
        assert.equal(messages[0].parts[0].text, "hello")
    })

    it("catches filter errors without crashing", () => {
        registerMessageFilter({
            name: "crasher",
            version: "1.0.0",
            description: "always throws",
            filter: () => {
                throw new Error("boom")
            },
        })
        const logger = makeLogger()
        const messages = [
            { info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
        ] as any
        const result = applyMessageFilters(
            messages,
            { enabled: true, filters: { crasher: { enabled: true } } },
            logger,
            { sessionId: "s", isSubAgent: false },
        )
        assert.equal(result.partsFiltered, 0)
        assert.equal(messages[0].parts[0].text, "hello")
    })

    it("skips non-text and empty parts", () => {
        registerMessageFilter({
            name: "dropper",
            version: "1.0.0",
            description: "drops all",
            filter: () => ({ action: "drop" }),
        })
        const logger = makeLogger()
        const messages = [
            {
                info: { role: "user" },
                parts: [
                    { type: "tool", tool: "bash" },
                    { type: "text", text: "" },
                    { type: "text", text: "keep me" },
                ],
            },
        ] as any
        const result = applyMessageFilters(
            messages,
            { enabled: true, filters: { dropper: { enabled: true } } },
            logger,
            { sessionId: "s", isSubAgent: false },
        )
        assert.equal(result.partsDropped, 1)
    })
})

describe("OMO system-reminder filter", () => {
    const filter = OMO_SYSTEM_REMINDER_FILTER

    it("keeps normal user messages", () => {
        const result = filter.filter(makeCtx({ text: "hello world" }))
        assert.equal(result.action, "keep")
    })

    it("keeps assistant messages with system-reminder tags", () => {
        const text = "<system-reminder>foo</system-reminder><!-- OMO_INTERNAL_INITIATOR -->"
        const result = filter.filter(makeCtx({ text, role: "assistant" }))
        assert.equal(result.action, "keep")
    })

    it("drops user message that is ONLY a system-reminder block", () => {
        const text = `<system-reminder>\n[BG COMPLETE]\n</system-reminder>\n<!-- OMO_INTERNAL_INITIATOR -->`
        const result = filter.filter(makeCtx({ text, role: "user" }))
        assert.equal(result.action, "drop")
    })

    it("modifies user message with system-reminder + real content", () => {
        const text = `Please help me.\n\n<system-reminder>\n[BG COMPLETE]\n</system-reminder>\n<!-- OMO_INTERNAL_INITIATOR -->`
        const result = filter.filter(makeCtx({ text, role: "user" }))
        assert.equal(result.action, "modify")
        assert.ok(result.text!.includes("Please help me"))
        assert.ok(!result.text!.includes("<system-reminder>"))
        assert.ok(!result.text!.includes("OMO_INTERNAL_INITIATOR"))
    })

    it("strips lone system-reminder without OMO marker", () => {
        const text = `Real content.\n\n<system-reminder>\nfoo\n</system-reminder>`
        const result = filter.filter(makeCtx({ text, role: "user" }))
        assert.equal(result.action, "modify")
        assert.ok(!result.text!.includes("<system-reminder>"))
        assert.ok(result.text!.includes("Real content"))
    })

    it("strips lone OMO marker without system-reminder", () => {
        const text = `Real content.\n<!-- OMO_INTERNAL_INITIATOR -->`
        const result = filter.filter(makeCtx({ text, role: "user" }))
        assert.equal(result.action, "modify")
        assert.ok(!result.text!.includes("OMO_INTERNAL_INITIATOR"))
    })

    it("handles multiple system-reminder blocks in one message", () => {
        const text = `Real content.\n<system-reminder>A</system-reminder>\n<!-- OMO_INTERNAL_INITIATOR -->\n<system-reminder>B</system-reminder>\n<!-- OMO_INTERNAL_INITIATOR -->`
        const result = filter.filter(makeCtx({ text, role: "user" }))
        assert.equal(result.action, "modify")
        assert.ok(result.text!.includes("Real content"))
        assert.ok(!result.text!.includes("system-reminder"))
        assert.ok(!result.text!.includes("OMO_INTERNAL_INITIATOR"))
    })

    it("drops message that becomes empty after stripping", () => {
        const text = `   \n\n<system-reminder>\nfoo\n</system-reminder>\n<!-- OMO_INTERNAL_INITIATOR -->\n\n   `
        const result = filter.filter(makeCtx({ text, role: "user" }))
        assert.equal(result.action, "drop")
    })
})

describe("ensureBuiltinFiltersRegistered", () => {
    beforeEach(() => clearMessageFilters())

    it("registers the OMO filter", () => {
        ensureBuiltinFiltersRegistered()
        assert.ok(getMessageFilter("omo-system-reminder"))
        assert.equal(getMessageFilter("omo-system-reminder")!.version, "1.0.0")
    })

    it("is idempotent", () => {
        ensureBuiltinFiltersRegistered()
        ensureBuiltinFiltersRegistered()
        assert.equal(listMessageFilters().length, 1)
    })
})
