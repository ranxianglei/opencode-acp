import assert from "node:assert/strict"
import test from "node:test"
import { isMessageWithInfo, filterMessages, filterMessagesInPlace } from "../lib/messages/shape"

function validMessage(overrides: Record<string, any> = {}) {
    return {
        info: {
            id: "msg-1",
            sessionID: "sess-1",
            role: "user",
            time: { created: 1234567890 },
            ...overrides,
        },
        parts: [],
        ...overrides,
    }
}

test("isMessageWithInfo returns true for valid message with all required fields", () => {
    assert.equal(isMessageWithInfo(validMessage()), true)
})

test("isMessageWithInfo returns true for assistant role", () => {
    assert.equal(isMessageWithInfo(validMessage({ role: "assistant" })), true)
})

test("isMessageWithInfo returns false for null", () => {
    assert.equal(isMessageWithInfo(null), false)
})

test("isMessageWithInfo returns false for undefined", () => {
    assert.equal(isMessageWithInfo(undefined), false)
})

test("isMessageWithInfo returns false for missing info", () => {
    assert.equal(isMessageWithInfo({ parts: [] }), false)
})

test("isMessageWithInfo returns false for missing parts", () => {
    assert.equal(
        isMessageWithInfo({
            info: {
                id: "msg-1",
                sessionID: "sess-1",
                role: "user",
                time: { created: 1234567890 },
            },
        }),
        false,
    )
})

test("isMessageWithInfo returns false for wrong role type", () => {
    assert.equal(isMessageWithInfo(validMessage({ role: "system" })), false)
})

test("isMessageWithInfo returns false for empty id", () => {
    assert.equal(isMessageWithInfo(validMessage({ id: "" })), false)
})

test("isMessageWithInfo returns false for empty sessionID", () => {
    assert.equal(isMessageWithInfo(validMessage({ sessionID: "" })), false)
})

test("isMessageWithInfo returns false for non-number time.created", () => {
    assert.equal(isMessageWithInfo(validMessage({ time: { created: "not-a-number" } })), false)
})

test("isMessageWithInfo returns false for missing time object", () => {
    const msg = validMessage()
    delete (msg as any).info.time
    assert.equal(!!isMessageWithInfo(msg), false)
})

test("filterMessages filters array of mixed valid/invalid messages", () => {
    const messages = [
        validMessage({ id: "msg-1" }),
        { bad: "message" },
        validMessage({ id: "msg-2", role: "assistant" }),
        null,
    ]
    const result = filterMessages(messages)
    assert.equal(result.length, 2)
    assert.equal((result[0] as any).info.id, "msg-1")
    assert.equal((result[1] as any).info.id, "msg-2")
})

test("filterMessages returns empty array for non-array input", () => {
    assert.deepEqual(filterMessages("not-array"), [])
    assert.deepEqual(filterMessages(null), [])
    assert.deepEqual(filterMessages(undefined), [])
    assert.deepEqual(filterMessages(42), [])
})

test("filterMessages returns empty array for empty array", () => {
    assert.deepEqual(filterMessages([]), [])
})

test("filterMessages returns empty array when all invalid", () => {
    assert.deepEqual(filterMessages([null, undefined, { bad: true }]), [])
})

test("filterMessagesInPlace mutates array in place", () => {
    const arr = [validMessage({ id: "msg-1" }), { bad: true }, validMessage({ id: "msg-2" })]
    const result = filterMessagesInPlace(arr)
    assert.equal(result, arr)
    assert.equal(arr.length, 2)
    assert.equal((arr[0] as any).info.id, "msg-1")
    assert.equal((arr[1] as any).info.id, "msg-2")
})

test("filterMessagesInPlace result equals filterMessages result", () => {
    const arr1 = [validMessage({ id: "a" }), null, validMessage({ id: "b" })]
    const arr2 = [validMessage({ id: "a" }), null, validMessage({ id: "b" })]
    const filtered = filterMessages(arr1)
    filterMessagesInPlace(arr2)
    assert.equal(filtered.length, arr2.length)
    for (let i = 0; i < filtered.length; i++) {
        assert.equal((filtered[i] as any).info.id, (arr2[i] as any).info.id)
    }
})

test("filterMessagesInPlace returns empty array for non-array input", () => {
    assert.deepEqual(filterMessagesInPlace("string"), [])
    assert.deepEqual(filterMessagesInPlace(null), [])
})

test("filterMessagesInPlace removes all items when none valid", () => {
    const arr = [null, { bad: true }]
    const result = filterMessagesInPlace(arr)
    assert.equal(arr.length, 0)
    assert.deepEqual(result, [])
})
