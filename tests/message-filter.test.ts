import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import {
    registerMessageFilter,
    getMessageFilter,
    listMessageFilters,
    clearMessageFilters,
} from "../lib/messages/filter/registry"
import type { MessageFilter, MessageFilterContext } from "../lib/messages/filter/types"
import type { WithParts } from "../lib/state"
import { applyMessageFilters } from "../lib/messages/filter/apply"
import { OMO_SYSTEM_REMINDER_FILTER } from "../lib/messages/filter/builtin/omo-system-reminder"
import { OMO_TODO_FILTER } from "../lib/messages/filter/builtin/omo-todo-continuation"
import { OMO_CONTEXT_FILTER } from "../lib/messages/filter/builtin/omo-context"
import { OMO_MODE_FILTER } from "../lib/messages/filter/builtin/omo-mode-injection"
import { OMO_TASK_FILTER } from "../lib/messages/filter/builtin/omo-task-directive"
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
        assert.equal(listMessageFilters().length, 5)
    })
})

describe("filter chaining", () => {
    beforeEach(() => clearMessageFilters())

    it("filter B sees modified text from filter A", () => {
        const uppercase: MessageFilter = {
            name: "uppercase",
            version: "1.0.0",
            description: "test",
            filter(ctx) {
                return { action: "modify", text: ctx.text.toUpperCase() }
            },
        }
        const detectUpper: MessageFilter = {
            name: "detect-upper",
            version: "1.0.0",
            description: "test",
            filter(ctx) {
                if (ctx.text === ctx.text.toUpperCase() && ctx.text.length > 0) {
                    return { action: "drop", reason: "all uppercase detected" }
                }
                return { action: "keep" }
            },
        }
        registerMessageFilter(uppercase)
        registerMessageFilter(detectUpper)

        const messages: WithParts[] = [
            {
                info: { id: "msg-1", role: "user", time: Date.now() } as any,
                parts: [{ type: "text", text: "hello world" }],
            },
        ]
        const config = { enabled: true, filters: { uppercase: { enabled: true }, "detect-upper": { enabled: true } } }
        const stats = applyMessageFilters(messages, config, makeLogger(), {
            sessionId: "ses-test",
            isSubAgent: false,
        })
        assert.equal(stats.partsDropped, 1)
        assert.equal(stats.partsFiltered, 2)
        assert.equal(stats.partsModified, 1)
    })
})

describe("keep-last-only dedup", () => {
    beforeEach(() => clearMessageFilters())

    it("keeps last TODO CONTINUATION, drops earlier ones", () => {
        registerMessageFilter(OMO_TODO_FILTER)
        const messages: WithParts[] = [
            { info: { id: "m1", role: "user", time: 1 } as any, parts: [{ type: "text", text: "[SYSTEM DIRECTIVE: TODO CONTINUATION]\nWork on task A" }] },
            { info: { id: "m2", role: "user", time: 2 } as any, parts: [{ type: "text", text: "real user message" }] },
            { info: { id: "m3", role: "user", time: 3 } as any, parts: [{ type: "text", text: "[SYSTEM DIRECTIVE: TODO CONTINUATION]\nWork on task B" }] },
        ]
        const config = { enabled: true, filters: { "omo-todo-continuation": { enabled: true } } }
        applyMessageFilters(messages, config, makeLogger(), { sessionId: "s", isSubAgent: false })
        assert.equal((messages[0].parts[0] as any).text, "")
        assert.equal((messages[1].parts[0] as any).text, "real user message")
        assert.equal((messages[2].parts[0] as any).text, "[SYSTEM DIRECTIVE: TODO CONTINUATION]\nWork on task B")
    })

    it("keeps last [CONTEXT], drops earlier ones", () => {
        registerMessageFilter(OMO_CONTEXT_FILTER)
        const messages: WithParts[] = [
            { info: { id: "m1", role: "user", time: 1 } as any, parts: [{ type: "text", text: "[CONTEXT] Old context\n<!-- OMO_INTERNAL_INITIATOR -->" }] },
            { info: { id: "m2", role: "user", time: 2 } as any, parts: [{ type: "text", text: "[CONTEXT] New context\n<!-- OMO_INTERNAL_INITIATOR -->" }] },
        ]
        const config = { enabled: true, filters: { "omo-context": { enabled: true } } }
        applyMessageFilters(messages, config, makeLogger(), { sessionId: "s", isSubAgent: false })
        assert.equal((messages[0].parts[0] as any).text, "")
        assert.equal((messages[1].parts[0] as any).text, "[CONTEXT] New context\n<!-- OMO_INTERNAL_INITIATOR -->")
    })

    it("handles single occurrence (no dedup needed)", () => {
        registerMessageFilter(OMO_TODO_FILTER)
        const messages: WithParts[] = [
            { info: { id: "m1", role: "user", time: 1 } as any, parts: [{ type: "text", text: "[SYSTEM DIRECTIVE: TODO CONTINUATION]\nOnly one" }] },
        ]
        const config = { enabled: true, filters: { "omo-todo-continuation": { enabled: true } } }
        const stats = applyMessageFilters(messages, config, makeLogger(), { sessionId: "s", isSubAgent: false })
        assert.equal((messages[0].parts[0] as any).text, "[SYSTEM DIRECTIVE: TODO CONTINUATION]\nOnly one")
        assert.equal(stats.partsDropped, 0)
    })

    it("last matching message is not the last message in array", () => {
        registerMessageFilter(OMO_TODO_FILTER)
        const messages: WithParts[] = [
            { info: { id: "m1", role: "user", time: 1 } as any, parts: [{ type: "text", text: "[SYSTEM DIRECTIVE: TODO CONTINUATION]\nEarlier" }] },
            { info: { id: "m2", role: "user", time: 2 } as any, parts: [{ type: "text", text: "[SYSTEM DIRECTIVE: TODO CONTINUATION]\nLatest" }] },
            { info: { id: "m3", role: "user", time: 3 } as any, parts: [{ type: "text", text: "real user message after" }] },
        ]
        const config = { enabled: true, filters: { "omo-todo-continuation": { enabled: true } } }
        applyMessageFilters(messages, config, makeLogger(), { sessionId: "s", isSubAgent: false })
        assert.equal((messages[0].parts[0] as any).text, "")
        assert.equal((messages[1].parts[0] as any).text, "[SYSTEM DIRECTIVE: TODO CONTINUATION]\nLatest")
        assert.equal((messages[2].parts[0] as any).text, "real user message after")
    })

    it("multiple keepLastOnly filters run independently", () => {
        registerMessageFilter(OMO_TODO_FILTER)
        registerMessageFilter(OMO_CONTEXT_FILTER)
        const messages: WithParts[] = [
            { info: { id: "m1", role: "user", time: 1 } as any, parts: [{ type: "text", text: "[SYSTEM DIRECTIVE: TODO CONTINUATION]\nOld todo" }] },
            { info: { id: "m2", role: "user", time: 2 } as any, parts: [{ type: "text", text: "[CONTEXT] Old\n<!-- OMO_INTERNAL_INITIATOR -->" }] },
            { info: { id: "m3", role: "user", time: 3 } as any, parts: [{ type: "text", text: "[SYSTEM DIRECTIVE: TODO CONTINUATION]\nNew todo" }] },
            { info: { id: "m4", role: "user", time: 4 } as any, parts: [{ type: "text", text: "[CONTEXT] New\n<!-- OMO_INTERNAL_INITIATOR -->" }] },
        ]
        const config = { enabled: true, filters: { "omo-todo-continuation": { enabled: true }, "omo-context": { enabled: true } } }
        applyMessageFilters(messages, config, makeLogger(), { sessionId: "s", isSubAgent: false })
        assert.equal((messages[0].parts[0] as any).text, "")
        assert.equal((messages[1].parts[0] as any).text, "")
        assert.equal((messages[2].parts[0] as any).text, "[SYSTEM DIRECTIVE: TODO CONTINUATION]\nNew todo")
        assert.equal((messages[3].parts[0] as any).text, "[CONTEXT] New\n<!-- OMO_INTERNAL_INITIATOR -->")
    })

    it("TASK directive keepLastOnly with OMO marker", () => {
        registerMessageFilter(OMO_TASK_FILTER)
        const messages: WithParts[] = [
            { info: { id: "m1", role: "user", time: 1 } as any, parts: [{ type: "text", text: "TASK: Write config.py\n<!-- OMO_INTERNAL_INITIATOR -->" }] },
            { info: { id: "m2", role: "user", time: 2 } as any, parts: [{ type: "text", text: "TASK: Write tests\n<!-- OMO_INTERNAL_INITIATOR -->" }] },
        ]
        const config = { enabled: true, filters: { "omo-task-directive": { enabled: true } } }
        applyMessageFilters(messages, config, makeLogger(), { sessionId: "s", isSubAgent: false })
        assert.equal((messages[0].parts[0] as any).text, "")
        assert.equal((messages[1].parts[0] as any).text, "TASK: Write tests\n<!-- OMO_INTERNAL_INITIATOR -->")
    })

    it("does not match TASK without OMO marker (avoids false positive)", () => {
        registerMessageFilter(OMO_TASK_FILTER)
        const messages: WithParts[] = [
            { info: { id: "m1", role: "user", time: 1 } as any, parts: [{ type: "text", text: "TASK: Do something" }] },
        ]
        const config = { enabled: true, filters: { "omo-task-directive": { enabled: true } } }
        const stats = applyMessageFilters(messages, config, makeLogger(), { sessionId: "s", isSubAgent: false })
        assert.equal((messages[0].parts[0] as any).text, "TASK: Do something")
        assert.equal(stats.partsFiltered, 0)
    })

    it("mode injection strips all occurrences", () => {
        registerMessageFilter(OMO_MODE_FILTER)
        const messages: WithParts[] = [
            { info: { id: "m1", role: "user", time: 1 } as any, parts: [{ type: "text", text: "[search-mode]\nSearch for X" }] },
            { info: { id: "m2", role: "user", time: 2 } as any, parts: [{ type: "text", text: "[analyze-mode]\nAnalyze Y" }] },
        ]
        const config = { enabled: true, filters: { "omo-mode-injection": { enabled: true } } }
        applyMessageFilters(messages, config, makeLogger(), { sessionId: "s", isSubAgent: false })
        assert.equal((messages[0].parts[0] as any).text, "")
        assert.equal((messages[1].parts[0] as any).text, "")
    })
})
