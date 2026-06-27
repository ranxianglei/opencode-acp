import assert from "node:assert/strict"
import test from "node:test"
import { classifyMessagePriority } from "../lib-v2/messages/priority"

test("classifyMessagePriority: tokens >= 5000 → high", () => {
    assert.equal(classifyMessagePriority(10000), "high")
})

test("classifyMessagePriority: tokens >= 500 → medium", () => {
    assert.equal(classifyMessagePriority(1000), "medium")
})

test("classifyMessagePriority: tokens < 500 → low", () => {
    assert.equal(classifyMessagePriority(100), "low")
})

test("classifyMessagePriority: boundary tokens = 5000 → high", () => {
    assert.equal(classifyMessagePriority(5000), "high")
})

test("classifyMessagePriority: boundary tokens = 4999 → medium", () => {
    assert.equal(classifyMessagePriority(4999), "medium")
})

test("classifyMessagePriority: boundary tokens = 500 → medium", () => {
    assert.equal(classifyMessagePriority(500), "medium")
})

test("classifyMessagePriority: boundary tokens = 499 → low", () => {
    assert.equal(classifyMessagePriority(499), "low")
})

test("classifyMessagePriority: tokens = 0 → low", () => {
    assert.equal(classifyMessagePriority(0), "low")
})

test("classifyMessagePriority: tokens = 1 → low", () => {
    assert.equal(classifyMessagePriority(1), "low")
})

test("classifyMessagePriority: very large tokens → high", () => {
    assert.equal(classifyMessagePriority(1000000), "high")
})
